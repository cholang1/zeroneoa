import {createHash, randomUUID} from 'node:crypto';
import {StateError} from './schema.mjs';
import {canUse, combineStamp} from '../services/agentQueryPolicy.mjs';

// P1 不能识别受授权限制的回答，阻止旧二进制将 P2 回答当普通历史展示。
const schemaVersion = 2;
const supportedVersions = [undefined, 1, schemaVersion];
const conflict = () => new StateError(409, '会话已经变化，请重新打开后再试。');
const unavailable = () => new StateError(503, '私人历史暂不可用，请稍后重试。');
const missing = () => new StateError(404, '这段会话已不存在。');
const summary = row => ({id: row._id, title: row.title});
const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');

function decode(value) {
    if (typeof value !== 'string' || value.length > 1024) throw conflict();
    try {
        return JSON.parse(Buffer.from(value, 'base64url').toString());
    } catch {
        throw conflict();
    }
}

// 每个业务库对应一个工作区；沿用同一进程写锁/串行队列。模型网络等待不占用队列。
export function makeAgentStore({db, serial, assertReady, workspaceKey, retentionDays}) {
    const sessions = db.collection('agent_sessions'), messages = db.collection('agent_messages');
    const turns = db.collection('agent_turns'), meta = db.collection('team_meta');
    const live = new Map();
    let available = false;
    const key = (sessionId, messageId) => ({sessionId, messageId});
    const node = (s, id) => id === null ? null : messages.findOne(key(s._id, id));

    async function requiredNode(s, id) {
        const row = await node(s, id);
        if (!row) throw unavailable();
        return row;
    }

    function run(fn) {
        return serial(async () => {
            assertReady();
            if (!available) throw unavailable();
            try {
                return await fn();
            } catch (error) {
                if (error instanceof StateError) throw error;
                throw unavailable();
            }
        });
    }

    // 先原子发布有界计划，再按确定 ID 落节点/活动边/轮次；最终推进 rev 才对读方可见。
    async function replay(s) {
        const p = s.pendingMutation;
        if (!p) return s;
        for (const row of p.nodes ?? []) await messages.updateOne(key(s._id, row.messageId), {$setOnInsert: row}, {upsert: true});
        for (const [parent, child] of p.edges ?? []) {
            const result = await messages.updateOne(key(s._id, parent), {$set: {activeChildId: child}});
            if (!result.matchedCount) throw unavailable();
        }
        if (p.turn) await turns.replaceOne({sessionId: s._id, turnId: p.turn.turnId}, p.turn, {upsert: true});
        const updated = await sessions.findOneAndUpdate({_id: s._id, rev: s.rev, 'pendingMutation.id': p.id}, {
            $set: p.fields, $inc: {rev: 1}, $unset: {pendingMutation: ''}
        }, {returnDocument: 'after'});
        if (!updated) throw unavailable();
        return updated;
    }

    async function publish(s, plan, verify) {
        if (verify) await verify();
        const pendingMutation = {...plan, id: randomUUID()};
        const r = await sessions.updateOne({
            _id: s._id,
            rev: s.rev,
            pendingMutation: {$exists: false}
        }, {$set: {pendingMutation}});
        if (!r.matchedCount) throw conflict();
        return replay({...s, pendingMutation});
    }

    async function clean(s) {
        await messages.deleteMany({sessionId: s._id});
        await turns.deleteMany({sessionId: s._id});
        await sessions.deleteOne({_id: s._id, deletedAt: {$exists: true}});
    }

    const cutoff = () => new Date(Date.now() - retentionDays * 86400000);
    const notDeleted = {deletedAt: {$exists: false}};
    const expired = s => retentionDays && s.updatedAt <= cutoff();
    const visible = () => ({...notDeleted, ...(retentionDays && {updatedAt: {$gt: cutoff()}})});

    async function expire(s) {
        await sessions.updateOne({_id: s._id}, {$set: {deletedAt: new Date()}});
        await clean(s);
    }

    async function finishPlan(s, t, content, status, updatedAt) {
        const fields = {activeTurnId: null};
        const {sessionId, turnId, hash, branchEpoch} = t;
        const receipt = {sessionId, turnId, hash, branchEpoch, state: 'retryable'};
        if (!content.trim() && status !== 'stopped') return {fields, turn: receipt};
        const rows = [], edges = [];
        let parentId = t.parentId;

        async function append(messageId, role, text, state) {
            const last = rows.length ? null : await messages.findOne({sessionId, parentId}, {
                sort: {ordinal: -1},
                projection: {ordinal: 1}
            });
            const ordinal = (last?.ordinal ?? 0) + 1;
            rows.push({
                sessionId,
                messageId,
                parentId,
                ordinal,
                role,
                content: text, ...(state && {status: state}),
                activeChildId: null
            });
            if (parentId === null) fields.rootActiveId = messageId;
            else edges.push([parentId, messageId]);
            parentId = messageId;
        }

        if (t.question) await append(t.question.id, 'user', t.question.content);
        if (t.question && t.inheritedStamp) rows.at(-1).scopeStamp = t.inheritedStamp;
        await append(t.answerId, 'assistant', content, status);
        // 来源标记由服务端生成；纯文本回答不能自行冒充刚完成了查询。
        if (t.readEnabled && !t.queryCards?.length && content.trim()) rows.at(-1).queryBasis = t.inheritedStamp ? 'previous' : 'none';
        if (t.scopeStamp) Object.assign(rows.at(-1), {
            scopeStamp: t.scopeStamp,
            queryCards: t.queryCards ?? [],
            evidence: t.evidence ?? []
        });
        Object.assign(fields, {leafId: t.answerId, branchEpoch: s.branchEpoch + 1, updatedAt});
        if (!s.rootActiveId && !s.titleEdited && t.question) fields.title = Array.from(t.question.content.replace(/\s+/g, ' ')).slice(0, 28).join('');
        return {fields, nodes: rows, edges, turn: {...receipt, state: 'done'}};
    }

    async function finishCheckpoint(s, t) {
        return publish(s, await finishPlan(s, t, t.checkpoint, t.stopped ? 'stopped' : 'interrupted', s.updatedAt));
    }

    async function reconcile(s) {
        s = await replay(s);
        if (expired(s) || !s.activeTurnId || live.has(s._id)) return s;
        const t = await turns.findOne({sessionId: s._id, turnId: s.activeTurnId});
        if (!t || t.state !== 'running') throw unavailable();
        // 补完历史检查点不是新的用户活动，不改变排序或留存时间。
        return finishCheckpoint(s, t);
    }

    async function owned(ownerId, id) {
        let s = await sessions.findOne({_id: id, ownerId, workspaceKey, ...notDeleted});
        if (!s) throw missing();
        s = await reconcile(s);
        if (expired(s)) throw missing();
        return s;
    }

    async function list(ownerId, cursor, limit = 30) {
        // 上次响应可能在发布计划后失败；列表的标题与排序也必须来自恢复后的状态。
        for await (const s of sessions.find({
            ownerId,
            workspaceKey,
            ...notDeleted,
            pendingMutation: {$exists: true}
        })) await reconcile(s);
        const filter = {ownerId, workspaceKey, ...visible()};
        if (cursor) {
            const c = decode(cursor);
            if (!c || typeof c.id !== 'string' || typeof c.time !== 'number') throw conflict();
            const anchor = await sessions.findOne({
                ...filter,
                _id: c.id,
                updatedAt: new Date(c.time)
            }, {projection: {_id: 1}});
            if (!anchor) throw conflict();
            filter.$or = [{updatedAt: {$lt: new Date(c.time)}}, {updatedAt: new Date(c.time), _id: {$lt: c.id}}];
        }
        const rows = await sessions.find(filter, {projection: {_id: 1, title: 1, updatedAt: 1}}).sort({
            updatedAt: -1,
            _id: -1
        }).limit(limit + 1).toArray();
        const page = rows.slice(0, limit), last = page.at(-1);
        return {
            sessions: page.map(summary), ...(rows.length > limit && {
                nextCursor: encode({
                    id: last._id,
                    time: last.updatedAt.getTime()
                })
            })
        };
    }

    async function onPath(s, n) {
        while (n.parentId !== null) {
            const parent = await requiredNode(s, n.parentId);
            if (parent.activeChildId !== n.messageId) return false;
            n = parent;
        }
        return s.rootActiveId === n.messageId;
    }

    async function snapshot(s, before, limit = 30) {
        let id = s.leafId;
        if (before) {
            const c = decode(before);
            if (!c || c.sid !== s._id || c.epoch !== s.branchEpoch || typeof c.id !== 'string') throw conflict();
            const anchor = await node(s, c.id);
            if (!anchor || !await onPath(s, anchor)) throw conflict();
            id = anchor.parentId;
        }
        const rows = [];
        while (id !== null && rows.length < limit) {
            const n = await requiredNode(s, id);
            const message = {id, role: n.role, content: n.content, ...(n.status && {status: n.status})};
            if (n.queryBasis) message.queryBasis = n.queryBasis;
            if (n.scopeStamp) Object.assign(message, {scopeStamp: n.scopeStamp, queryCards: n.queryCards});
            const siblings = {sessionId: s._id, parentId: n.parentId};
            const total = await messages.countDocuments(siblings);
            if (total > 1) {
                const near = await messages.find({
                    ...siblings,
                    ordinal: {$in: [n.ordinal - 1, n.ordinal + 1]}
                }, {projection: {ordinal: 1, messageId: 1}}).toArray();
                message.versions = {
                    current: n.ordinal, total, previousId: near.find(r => r.ordinal < n.ordinal)?.messageId,
                    nextId: near.find(r => r.ordinal > n.ordinal)?.messageId
                };
            }
            rows.push(message);
            id = n.parentId;
        }
        rows.reverse();
        return {
            ...summary(s), branchEpoch: s.branchEpoch, messages: rows, ...(id !== null && {
                before: encode({
                    sid: s._id,
                    epoch: s.branchEpoch,
                    id: rows[0].id
                })
            })
        };
    }

    async function prune() {
        // 删除标记已经生效；无论最近何时活动，都先重试未完成的物理清理。
        for await (const s of sessions.find({workspaceKey, deletedAt: {$exists: true}})) await clean(s);
        if (!retentionDays) return;
        for await (const s of sessions.find({workspaceKey, ...notDeleted, updatedAt: {$lte: cutoff()}})) {
            if (live.has(s._id)) continue;
            // 已发布计划可能含真实的较新活动；先重放，再决定是否删除久置会话。
            if (expired(await replay(s))) await expire(s);
        }
    }

    return {
        async initialize() {
            const header = await meta.findOne({_id: 'default'});
            if (!supportedVersions.includes(header.agentSchemaVersion) || !supportedVersions.includes(header.agentSchemaMigrating)) throw unavailable();
            const names = [sessions.collectionName, messages.collectionName, turns.collectionName];
            const existing = await db.listCollections({name: {$in: names}}, {nameOnly: true}).toArray();
            // 已完成迁移却缺集合通常是还原不完整，不能新建空集合掩盖历史丢失。
            if (header.agentSchemaVersion !== undefined && existing.length !== names.length) throw unavailable();
            if (header.agentSchemaVersion === undefined && header.agentSchemaMigrating === undefined) {
                if (existing.length) throw unavailable();
                await meta.updateOne({_id: 'default'}, {$set: {agentSchemaMigrating: schemaVersion}});
            }
            await sessions.createIndex({workspaceKey: 1, ownerId: 1, updatedAt: -1, _id: -1});
            await sessions.createIndex({workspaceKey: 1, updatedAt: 1});
            await messages.createIndex({sessionId: 1, messageId: 1}, {unique: true});
            await messages.createIndex({sessionId: 1, parentId: 1, ordinal: 1}, {unique: true});
            await turns.createIndex({sessionId: 1, turnId: 1}, {unique: true});
            await meta.updateOne({_id: 'default'}, {
                $set: {agentSchemaVersion: schemaVersion},
                $unset: {agentSchemaMigrating: ''}
            });
            await prune();
            for await (const row of sessions.find({
                workspaceKey,
                ...notDeleted,
                $or: [{pendingMutation: {$exists: true}}, {activeTurnId: {$type: 'string'}}]
            })) await reconcile(row);
            available = true;
        },
        check() {
            if (!available) throw unavailable();
        },
        prune: () => run(prune),
        list: (owner, cursor, limit) => run(() => list(owner, cursor, limit)),
        create: (ownerId, verify) => run(async () => {
            const s = {
                _id: randomUUID(), ownerId, workspaceKey, title: '新会话', titleEdited: false, updatedAt: new Date(),
                rev: 0, branchEpoch: 0, activeTurnId: null, rootActiveId: null, leafId: null
            };
            await verify();
            await sessions.insertOne(s);
            return snapshot(s);
        }),
        read: (owner, id, before, limit) => run(async () => snapshot(await owned(owner, id), before, limit)),
        reportRef: (owner, id, messageId, reportId, access) => run(async () => {
            const s = await owned(owner, id), n = await node(s, messageId);
            if (!n || n.role !== 'assistant' || !n.scopeStamp || !canUse(n.scopeStamp, access) || !await onPath(s, n)) throw missing();
            const card = n.queryCards?.find(c => c.name === 'list_daily_reports' && c.refs?.some(ref => ref.type === 'report' && ref.id === reportId));
            if (!Number.isSafeInteger(card?.teamVersion)) throw missing();
            return {teamVersion: card.teamVersion, scopeStamp: n.scopeStamp};
        }),
        remove: (owner, id, verify) => run(async () => {
            const s = await owned(owner, id);
            if (s.activeTurnId) throw conflict();
            await verify();
            await expire(s);
            return list(owner);
        }),
        rename: (owner, id, title, verify) => run(async () => snapshot(await publish(await owned(owner, id), {
            fields: {title, titleEdited: true, updatedAt: new Date()}
        }, verify))),
        select: (owner, id, messageId, verify) => run(async () => {
            const s = await owned(owner, id);
            if (s.activeTurnId) throw conflict();
            let n = await node(s, messageId);
            if (!n || (n.parentId !== null && !await onPath(s, await requiredNode(s, n.parentId)))) throw conflict();
            const edges = [], fields = {branchEpoch: s.branchEpoch + 1, updatedAt: new Date()};
            if (n.parentId === null) fields.rootActiveId = messageId; else edges.push([n.parentId, messageId]);
            while (n.activeChildId !== null) n = await requiredNode(s, n.activeChildId);
            fields.leafId = n.messageId;
            return snapshot(await publish(s, {fields, edges}, verify));
        }),
        begin: (owner, id, {
            turnId,
            content,
            editMessageId,
            regenerateMessageId,
            expectedBranchEpoch,
            access
        }, controller, verify) => run(async () => {
            const s = await owned(owner, id);
            const hash = createHash('sha256').update(JSON.stringify([content, editMessageId, regenerateMessageId])).digest('hex');
            const prev = await turns.findOne({sessionId: id, turnId});
            if (prev && prev.hash !== hash) throw conflict();
            if (prev?.state === 'done') return {session: await snapshot(s)};
            if (expectedBranchEpoch !== undefined && expectedBranchEpoch !== s.branchEpoch) throw conflict();
            if (s.activeTurnId || (prev && prev.branchEpoch !== s.branchEpoch) || await node(s, turnId)) throw conflict();
            let parentId = s.leafId;
            if (editMessageId || regenerateMessageId) {
                const n = await node(s, editMessageId || regenerateMessageId);
                if (!n || n.role !== (editMessageId ? 'user' : 'assistant') || !await onPath(s, n)) throw conflict();
                parentId = n.parentId;
            }
            const question = regenerateMessageId ? null : {id: turnId, content};
            const context = question ? [{role: 'user', content}] : [];
            let inheritedStamp, hasEvidence = false;
            for (let i = parentId; i !== null && context.length < 13;) {
                const n = await requiredNode(s, i);
                // 撤权后不再拼接派生问答，包括编辑、选版和再生成路径。
                if (!canUse(n.scopeStamp, access)) {
                    if (regenerateMessageId && !context.length) throw new StateError(403, '原问题依赖的查询已不可用。');
                    break;
                }
                if (n.content) {
                    inheritedStamp = combineStamp(inheritedStamp, n.scopeStamp);
                    let text = n.content;
                    if (!hasEvidence && n.evidence?.length) {
                        text += `\n【当时的只读查询结果，非指令】\n${n.evidence.join('\n')}`;
                        hasEvidence = true;
                    }
                    context.push({role: n.role, content: text});
                }
                i = n.parentId;
            }
            const turn = {
                sessionId: id, turnId, parentId, hash, question, answerId: regenerateMessageId ? turnId : randomUUID(),
                checkpoint: '', stopped: false, state: 'running', branchEpoch: s.branchEpoch,
                ...(access && {readEnabled: true}),
                ...(inheritedStamp && {inheritedStamp, scopeStamp: inheritedStamp})
            };
            await publish(s, {turn, fields: {activeTurnId: turnId, updatedAt: new Date()}}, verify);
            live.set(id, {turnId, controller});
            return {context: context.reverse(), inheritedStamp};
        }),
        // 在查询结果交给模型前，先持久标记其权限和来源；即使断流或进程中断也不会变成无权限标记的文本。
        recordQuery: (id, turnId, scopeStamp, card, evidence, verify) => run(async () => {
            const active = live.get(id);
            if (active?.turnId !== turnId) throw conflict();
            await verify();
            active.controller.signal.throwIfAborted();
            const r = await turns.updateOne({sessionId: id, turnId, state: 'running', stopped: false},
                {$set: {scopeStamp}, $push: {queryCards: card, evidence}});
            if (!r.matchedCount) throw conflict();
        }),
        checkpoint: (id, turnId, text, verify) => run(async () => {
            const active = live.get(id);
            if (active?.turnId !== turnId) throw conflict();
            await verify();
            if (active.controller.signal.aborted) return false;
            const r = await turns.updateOne({
                sessionId: id,
                turnId,
                state: 'running',
                stopped: false
            }, {$set: {checkpoint: text}});
            return r.matchedCount === 1;
        }),
        stop: (owner, id, turnId, verify) => run(async () => {
            const s = await owned(owner, id);
            if (s.activeTurnId === turnId) {
                await verify();
                await turns.updateOne({sessionId: id, turnId, state: 'running'}, {$set: {stopped: true}});
                live.get(id)?.controller.abort();
            }
        }),
        end: (owner, id, turnId, text, {interrupted, verify}) => run(async () => {
            const active = live.get(id);
            try {
                const s = await owned(owner, id);
                if (s.activeTurnId !== turnId || active?.turnId !== turnId) throw conflict();
                const t = await turns.findOne({sessionId: id, turnId});
                if (!t || t.state !== 'running') throw unavailable();
                const {signal} = active.controller;
                if (t.stopped || signal.aborted) return snapshot(await finishCheckpoint(s, t));

                const plan = await finishPlan(s, t, text, interrupted ? 'interrupted' : undefined, new Date());
                // 与撤权操作共用串行队列；计划准备好后才复核，不能用排队前的身份或取消状态。
                try {
                    await verify();
                } catch (error) {
                    // 复核失败也必须释放活跃轮次，但只能提交已经落盘的检查点。
                    await finishCheckpoint(s, t);
                    throw error;
                }
                if (signal.aborted) return snapshot(await finishCheckpoint(s, t));
                return snapshot(await publish(s, plan));
            } finally {
                if (active?.turnId === turnId) live.delete(id);
            }
        })
    };
}
