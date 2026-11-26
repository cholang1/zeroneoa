import {MongoClient} from 'mongodb';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {names, indexes, StateError, checkSize, checkChanges, publicRow} from './schema.mjs';
import {makeAuthStore} from './authStore.mjs';
import {makeAgentStore} from './agentStore.mjs';
import {teamGeneration} from './firstAdminStore.mjs';
import {nowIso} from '../services/time.mjs';

export {StateError} from './schema.mjs';

const newestFirst = new Set(['weeklyPlans', 'dailyReports', 'aiReminders', 'memos']);
const marker = 'oa-business-v1';
const memberColors = ['#1746a2', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#2563eb', '#15803d'];
const reportSort = {date: -1, _id: -1};
const agentQueryTimeout = 4000;
const literalRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function boundedField(field, max) {
    const path = `$${field}`;
    return {$cond: [{$eq: [{$type: path}, 'string']}, {$substrCP: [path, 0, max + 1]}, '$$REMOVE']};
}

function ownerFilter(ownerId) {
    // 保留可用索引的等值条件，同时拒绝旧脏数据中包含该 ID 的数组冒充本人记录。
    return ownerId === undefined ? {} : {ownerId, $expr: {$eq: ['$ownerId', {$literal: ownerId}]}};
}

function reportFilter({from, to, taskId}, ownerId) {
    return {...ownerFilter(ownerId), date: {$gte: from, $lte: to}, ...(taskId !== undefined && {taskId})};
}

async function validateWrite(validate) {
    if ((await validate?.())?.mustChangePassword) {
        const error = new StateError(403, '请先修改初始密码。');
        error.code = 'PASSWORD_CHANGE_REQUIRED';
        throw error;
    }
}

// 本地单机版只允许一个 API 或维护进程执行写入。进程退出后下一次启动重放未完成批次。
async function writerGuard(dbName) {
    const key = 'zerone-oa-' + createHash('sha256').update(dbName).digest('hex').slice(0, 24);
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\${key}` : process.platform === 'linux' ? `\0${key}` : join(tmpdir(), key + '.sock');
    const guard = createServer(socket => socket.end());
    return new Promise((resolve, reject) => {
        guard.once('error', () => reject(new StateError(503, '同名数据库已有本机写入进程或无法获取写入锁；请先停止 API 和其他维护进程。')));
        guard.listen(path, () => resolve(guard));
    });
}

export async function openStore(uri, {
    databaseName, tlsCAFile, requireExisting = false, initializeAgentHistory = true,
    workspaceKey, historyRetentionDays = 90
} = {}) {
    const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 4000, retryWrites: false, ignoreUndefined: true,
        ...(tlsCAFile && {tls: true, tlsCAFile})
    });
    try {
        await client.connect();
        const db = client.db(databaseName);
        await db.command({ping: 1});
        const meta = db.collection('team_meta'), journal = db.collection('pending_changes');
        const col = key => db.collection(names[key]);
        let guard, ready = false, queue = Promise.resolve();

        function serial(fn) {
            const work = queue.then(fn);
            queue = work.catch(() => {
            });
            return work;
        }

        // 写前日志先准备完整，随后一个元数据文档发布批次指针；每步重放都幂等。
        async function recover() {
            const header = await meta.findOne({_id: 'default'});
            if (header?.schema !== marker) throw new StateError(503, '业务库尚未初始化或格式不匹配。');
            if (!header.pending) return header.version;
            const {batch, count} = header.pending;
            const ops = await journal.find({batch}).sort({seq: 1}).toArray();
            if (ops.length !== count) throw new StateError(503, '待恢复批次不完整，已停止读写。');
            // 批量导入可能在一个批次内释放、交换同名身份。先释放旧唯一键；
            // 重放时已是目标姓名的文档不动。整个过程仍在提交指针保护下。
            for (const {key, id, doc} of ops) if (key === 'users') {
                if (doc === null) await col(key).deleteOne({_id: id});
                else await col(key).deleteOne({_id: id, name: {$ne: doc.name}});
            }
            for (const {key, id, doc} of ops) {
                if (doc === null) await col(key).deleteOne({_id: id});
                else await col(key).replaceOne({_id: id}, doc, {upsert: true});
            }
            const result = await meta.updateOne({_id: 'default', 'pending.batch': batch}, {
                $inc: {version: 1},
                $unset: {pending: ''}
            });
            if (!result.matchedCount) throw new StateError(503, '批次版本不一致。');
            await journal.deleteMany({batch});
            return header.version + 1;
        }

        async function snapshot(version) {
            const entries = await Promise.all(Object.keys(names).map(async key => [key,
                (await col(key).find().sort({
                    _batch: newestFirst.has(key) ? -1 : 1,
                    _seq: 1
                }).toArray()).map(publicRow)]));
            return {version, ...Object.fromEntries(entries)};
        }

        async function commit(version, changes, validate, setup = false) {
            if (!setup) await auth.assertNoPendingSetup();
            checkChanges(changes);
            const batch = randomUUID();
            const ops = [];
            const claimedNames = new Map();
            const releasedNames = new Map(changes.filter(c => c.key === 'users' && c.before && c.before.name !== c.after?.name)
                .map(c => [c.id, c.before.name]));
            for (const {key, id, before, after} of changes) {
                const existing = await col(key).findOne({_id: id});
                const current = publicRow(existing);
                if (isDeepStrictEqual(current, after)) continue;
                if (!isDeepStrictEqual(current, before)) throw new StateError(409, `记录 ${key}/${id} 已被他人更新。`);
                if (key === 'users' && (!current || !after || current.name !== after.name) && await auth.hasAccount(id)) {
                    throw new StateError(409, '不能删除或重新绑定已开通账号的成员。');
                }
                if (key === 'users' && after) {
                    const owner = await col(key).findOne({name: after.name}, {projection: {_id: 1}});
                    if ((owner && owner._id !== id && releasedNames.get(owner._id) !== after.name) || claimedNames.has(after.name)) throw new StateError(409, '姓名已被使用。');
                    claimedNames.set(after.name, id);
                }
                let doc = null;
                if (after) {
                    const {id: _, ...fields} = after;
                    doc = {
                        _id: id, ...fields,
                        _batch: existing?._batch ?? version + 1,
                        _seq: existing?._seq ?? ops.length
                    };
                }
                const op = {batch, seq: ops.length, key, id, doc};
                checkSize({...op, _id: `${batch}:${op.seq}`});
                ops.push({...op, _id: `${batch}:${op.seq}`});
            }
            if (!ops.length) return version;
            await journal.insertMany(ops);
            if (validate) {
                try {
                    // 准备中会话也可能到期；未通过复核的批次不能发布提交指针。
                    await validateWrite(validate);
                } catch (error) {
                    await journal.deleteMany({batch}).catch(() => {
                    });
                    throw error;
                }
            }
            const lock = await meta.updateOne({
                _id: 'default',
                version,
                pending: {$exists: false}
            }, {$set: {pending: {batch, count: ops.length}}});
            if (!lock.matchedCount) throw new StateError(409, '团队正在更新，请重试。');
            return recover();
        }

        function assertReady() {
            if (!ready) throw new StateError(503, '存储尚未就绪。');
        }

        const run = fn => serial(async () => {
            assertReady();
            return fn(await recover());
        });

        async function memberNames(ids) {
            const values = [...new Set(ids.filter(id => typeof id === 'string'))];
            if (!values.length) return new Map();
            const users = await col('users').find({_id: {$in: values}}, {projection: {name: boundedField('name', 256)}})
                .maxTimeMS(agentQueryTimeout).toArray();
            return new Map(users.map(user => [user._id, user.name]));
        }

        function agentReadPage(name, {filters, ownerId, includeOwner, allowDetail, before, limit}) {
            return run(async teamVersion => {
                if (before && before.teamVersion !== teamVersion) throw new StateError(409, '分页期间团队数据已更新。');
                const {query, weekId, taskId, completed, status} = filters;
                const owner = includeOwner ? {ownerId: 1} : {};
                const detail = allowDetail ? {detail: boundedField('detail', 1000)} : {};
                let key, filter, projection, sort = {_id: 1};
                switch (name) {
                    case 'search_members':
                        key = 'users';
                        filter = {name: {$regex: literalRegex(query), $options: 'i'}};
                        projection = {name: boundedField('name', 256)};
                        break;
                    case 'list_tasks':
                        key = 'tasks';
                        filter = {
                            ...ownerFilter(filters.ownerId), ...(taskId !== undefined && {_id: taskId}),
                            ...(status !== undefined && {status})
                        };
                        if (query !== undefined) {
                            const match = {$regex: literalRegex(query), $options: 'i'};
                            filter.$or = [{title: match}, {_id: match}];
                        }
                        projection = {title: boundedField('title', 256), parentId: 1, level: 1, status: 1, ownerId: 1};
                        break;
                    case 'list_weekly_plans':
                        key = 'weeklyPlans';
                        filter = {
                            ...ownerFilter(ownerId), weekId, ...(taskId !== undefined && {taskId}),
                            ...(completed !== undefined && {completed})
                        };
                        sort = {_id: -1};
                        projection = {weekId: 1, taskId: 1, completed: 1, ...owner, ...detail};
                        break;
                    case 'list_daily_reports':
                        key = 'dailyReports';
                        filter = reportFilter(filters, ownerId);
                        sort = reportSort;
                        projection = {date: 1, weekId: 1, taskId: 1, hours: 1, ...owner, ...detail};
                        break;
                    default:
                        throw new StateError(400, '不支持此查询工具。');
                }
                if (before?.id !== undefined) {
                    const boundary = key === 'dailyReports'
                        ? {$or: [{date: {$lt: before.date}}, {date: before.date, _id: {$lt: before.id}}]}
                        : {_id: {[sort._id === 1 ? '$gt' : '$lt']: before.id}};
                    filter = {$and: [filter, boundary]};
                }
                const cursor = col(key).find(filter, {projection}).sort(sort).maxTimeMS(agentQueryTimeout);
                if (before && before.id === undefined) cursor.skip(before.offset);
                const rows = (await cursor.limit(limit + 1).toArray()).map(publicRow);
                if (includeOwner) {
                    const namesById = await memberNames(rows.map(row => row.ownerId));
                    for (const row of rows) row.ownerName = namesById.get(row.ownerId);
                }
                return {rows, asOf: nowIso(), teamVersion};
            });
        }

        function agentSummarizeHours({filters, ownerId}) {
            return run(async teamVersion => {
                const {groupBy} = filters;
                const groupKey = {
                    day: '$date',
                    task: '$taskId',
                    member: '$ownerId',
                    total: {$literal: 'total'}
                }[groupBy];
                const validDay = {
                    $eq: ['$date', {
                        $dateToString: {
                            format: '%Y-%m-%d', date: {
                                $dateFromString: {
                                    dateString: '$date', format: '%Y-%m-%d', onError: null, onNull: null
                                }
                            }, onNull: null
                        }
                    }]
                };
                const [result] = await col('dailyReports').aggregate([
                    {$match: reportFilter(filters, ownerId)},
                    {
                        $group: {
                            _id: groupKey, hours: {$sum: '$hours'}, count: {$sum: 1},
                            negativeCount: {$sum: {$cond: [{$and: [{$isNumber: '$hours'}, {$lt: ['$hours', 0]}]}, 1, 0]}},
                            invalidCount: {$sum: {$cond: [{$isNumber: '$hours'}, 0, 1]}},
                            invalidDateCount: {$sum: {$cond: [validDay, 0, 1]}}
                        }
                    },
                    {
                        $facet: {
                            totals: [{
                                $group: {
                                    _id: null, totalHours: {$sum: '$hours'}, reportCount: {$sum: '$count'},
                                    negativeCount: {$sum: '$negativeCount'}, invalidCount: {$sum: '$invalidCount'},
                                    invalidDateCount: {$sum: '$invalidDateCount'}
                                }
                            }],
                            groups: [{$sort: {_id: 1}}, {$limit: 51}, {
                                $project: {
                                    _id: 0,
                                    key: '$_id',
                                    hours: 1,
                                    count: 1
                                }
                            }]
                        }
                    }
                ], {maxTimeMS: agentQueryTimeout, allowDiskUse: true}).toArray();
                const {_id, ...totals} = result.totals[0] ?? {totalHours: 0, reportCount: 0};
                const {groups} = result;
                if (groupBy === 'member') {
                    const namesById = await memberNames(groups.map(group => group.key));
                    for (const group of groups) group.memberName = namesById.get(group.key);
                }
                return {...totals, groups, asOf: nowIso(), teamVersion};
            });
        }

        const auth = makeAuthStore({
            db, users: col('users'), run, assertReady, async addMember(version, name, {
                memberId = `u-${randomUUID()}`, auditId = `audit-${randomUUID()}`, createdAt = nowIso(),
                validate, setup
            } = {}) {
                const count = await col('users').countDocuments();
                const user = {id: memberId, name, color: memberColors[count % memberColors.length], createdAt};
                const audit = {
                    id: auditId, entityType: 'user', entityId: user.id, actorId: user.id,
                    action: 'joined', createdAt: user.createdAt
                };
                await commit(version, [
                    {key: 'users', id: user.id, before: null, after: user},
                    {key: 'auditLog', id: audit.id, before: null, after: audit}
                ], validate, setup);
                return user.id;
            }
        });
        let retentionTimer;
        // 离线账号维护不应创建或清理聊天数据；在线 API 始终只装配持久仓储。
        const agent = initializeAgentHistory ? makeAgentStore({
            db, serial, assertReady, workspaceKey: workspaceKey ?? db.databaseName, retentionDays: historyRetentionDays
        }) : undefined;
        return {
            auth: auth.api, agent, agentReadPage, agentSummarizeHours,
            verifyAgentReport: (id, version, ownerId) => run(async teamVersion => {
                if (version !== teamVersion) throw new StateError(409, '团队数据已更新，请重新查询日报。');
                if (typeof id !== 'string' || !id || (ownerId != null && typeof ownerId !== 'string') ||
                    !await col('dailyReports').findOne({_id: id, ...ownerFilter(ownerId || undefined)}, {
                        projection: {_id: 1}, maxTimeMS: agentQueryTimeout
                    })) throw new StateError(404, '日报不存在。');
                return {id, teamVersion};
            }),
            initialize: () => serial(async () => {
                if (ready) return;
                guard ??= await writerGuard(db.databaseName);
                const existing = await db.listCollections({}, {nameOnly: true}).toArray();
                const initialized = await meta.findOne({_id: 'default', schema: marker});
                if (requireExisting && (!initialized || existing.some(c => c.name === 'team_states'))) {
                    throw new StateError(503, '目标库不是已初始化的 OA 业务库；未执行维护。');
                }
                if (existing.some(c => c.name === 'team_states') || (existing.length && !initialized)) {
                    throw new StateError(503, '请指定全新数据库（建议 oa_business_dev），不会修改旧库或迁移旧数据。');
                }
                if (!initialized) {
                    // 从未使用的库才有资格。集合建成但未写入标记就中断时，后续启动不补发资格。
                    await db.createCollection('team_meta');
                    const generation = await teamGeneration(db);
                    await meta.insertOne({
                        _id: 'default', schema: marker, version: 1,
                        ...(generation && {firstAdmin: {state: 'open', generation, database: db.databaseName}})
                    });
                }
                for (const [key, defs] of Object.entries(indexes)) {
                    const specs = defs.map(([fields, opts]) => ({key: fields, ...opts}));
                    if (key === 'weeklyPlans') specs.push({key: {weekId: 1, ownerId: 1, _id: -1}}, {
                        key: {
                            weekId: 1,
                            _id: -1
                        }
                    });
                    // 聚合旧页面需要的有序列表不应在内存里排序整张业务集合。
                    specs.push({key: {_batch: newestFirst.has(key) ? -1 : 1, _seq: 1}});
                    await col(key).createIndexes(specs);
                }
                await journal.createIndex({batch: 1, seq: 1}, {unique: true});
                await auth.initialize();
                await recover();
                // 没有提交指针的日志是上次在准备阶段中断或已完成的批次。
                await journal.deleteMany({});
                await auth.refreshSetupAvailability();
                if (agent) {
                    if (!Number.isSafeInteger(historyRetentionDays) || historyRetentionDays < 1 || historyRetentionDays > 3650) {
                        // 未确认有效留存期时禁止聊天读写和清理，不影响账号及手工业务。
                        console.error('私人历史未启用：OA_AGENT_HISTORY_DAYS 必须为 1 至 3650 的整数；请修正后重启 OA API。');
                    } else {
                        try {
                            await agent.initialize();
                            retentionTimer = setInterval(() => agent.prune().catch(() => console.warn('私人历史到期清理待重试。')), 3600000);
                            retentionTimer.unref();
                        } catch {
                            console.error('私人历史初始化未完成，已停止聊天读写。请核对索引、版本与恢复日志。');
                        }
                    }
                }
                ready = true;
            }),
            read: () => run(snapshot),
            patch: (baseVersion, changes, validate) => run(async version => {
                await validateWrite(validate);
                if (!Number.isSafeInteger(baseVersion) || baseVersion < 1) throw new StateError(400, '缺少有效基线版本。');
                if (baseVersion > version) throw new StateError(409, '客户端版本超前，请刷新。');
                return snapshot(await commit(version, changes, validate));
            }),
            refreshWeek: (weekId, build, validate) => run(async version => {
                await validateWrite(validate);
                const load = async (key, filter) => (await col(key).find(filter).toArray()).map(publicRow);
                const [users, dailyReports, weeklyPlans, previous] = await Promise.all([
                    load('users', {}), load('dailyReports', {weekId}),
                    load('weeklyPlans', {weekId: {$lte: weekId}, completed: {$ne: true}}),
                    col('aiReminders').find().sort({_batch: -1, _seq: 1}).toArray()
                ]);
                const fresh = build({users, dailyReports, weeklyPlans}, weekId).slice(0, 200);
                const keep = new Set(previous.filter(r => r.weekId !== weekId).slice(0, 200 - fresh.length).map(r => r._id));
                const changes = previous.filter(r => !keep.has(r._id)).map(r => ({
                    key: 'aiReminders',
                    id: r._id,
                    before: publicRow(r),
                    after: null
                }));
                for (const row of fresh) changes.push({key: 'aiReminders', id: row.id, before: null, after: row});
                return snapshot(await commit(version, changes, validate));
            }),
            reports: (filter, limit) => run(async () => (await col('dailyReports').find(filter).sort(reportSort).limit(limit).toArray()).map(publicRow)),
            async close() {
                clearInterval(retentionTimer);
                await queue;
                ready = false;
                try {
                    await client.close();
                } finally {
                    if (guard?.listening) await new Promise(resolve => guard.close(resolve));
                }
            }
        };
    } catch (error) {
        await client.close();
        throw error;
    }
}
