import {readBody, sendJson} from './http.mjs';
import {StateError} from '../repositories/schema.mjs';
import {readToolDefinitions, executeReadTool} from '../services/agentReadTools.mjs';
import {
    canUse,
    combineStamp,
    publicSession,
    queryAccess,
    queryCard,
    queryEvidence,
    queryPrompt,
    reportIssuesTool,
    toolLabel
} from '../services/agentQueryPolicy.mjs';

const prefix = '/api/zeroai/v2';
const route = /^\/api\/zeroai\/v2\/sessions(?:\/([\da-f-]{36})(?:\/messages(?:\/(select|stop))?)?)?$/;
const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const invalid = () => new StateError(400, '会话操作参数无效。');
const maxReply = 128 * 1024;

function failure(error) {
    if (error instanceof StateError) return {status: error.status, error: error.message};
    if (error?.code === 'AI_TIMEOUT') return {status: 504, error: '回复超时，请重试。'};
    if (error?.code === 'AI_TOOLS_UNAVAILABLE') return {
        status: 502,
        error: '模型未完成本次 OA 查询，请缩小范围或稍后重试。'
    };
    if (error?.code === 'AI_TOOL_LIMIT') return {status: 422, error: '查询次数或数据量超出单轮限制，请缩小范围再问。'};
    if (error?.code === 'AI_DISABLED') return {status: 503, error: '模型未启用，私人历史已保留。'};
    return {status: 502, error: '模型未完成回复。'};
}

export function createZeroAiV2Handler(store, completeAi, businessStore, readPolicy) {
    return async (request, response, url, {user, verify}) => {
        const owner = user.id;
        const currentAccess = async () => queryAccess(readPolicy, await verify());
        const principalFor = grants => ({
            user: {id: owner},
            isAccountAdmin: grants.team,
            allowDetail: grants.detail,
            allowIssues: grants.issues
        });
        response.setHeader('Cache-Control', 'no-store');
        const send = async (status, data) => {
            const access = await currentAccess();
            if (!response.destroyed) sendJson(response, status, data.session ? {
                ...data,
                session: publicSession(data.session, access)
            } : data);
        };
        if (url.searchParams.has('actorId') && url.searchParams.get('actorId') !== owner) throw new StateError(404, '会话不存在。');
        if (!store) throw new StateError(503, '私人历史暂不可用。');
        if (request.method === 'GET' && url.pathname === `${prefix}/capabilities`) {
            store.check();
            const access = await currentAccess();
            const readIssues = access?.issues === true && readToolDefinitions(principalFor(access))
                .some(tool => tool.function.name === reportIssuesTool);
            if (!response.destroyed) sendJson(response, 200, {
                historyV2: true, ...(readPolicy && {readTools: true}), ...(readIssues && {readIssues: true})
            });
            return;
        }
        const refMatch = /^\/api\/zeroai\/v2\/sessions\/([\da-f-]{36})\/messages\/([\w-]{1,100})\/refs\/report\/([^/]{1,6144})$/.exec(url.pathname);
        if (request.method === 'GET' && refMatch) {
            const [, sid, mid, encoded] = refMatch;
            let reportId;
            try {
                reportId = decodeURIComponent(encoded);
            } catch {
                throw invalid();
            }
            if (reportId.length > 512) throw invalid();
            const ref = await store.reportRef(owner, sid, mid, reportId, await currentAccess());
            const verifyRef = async () => {
                if (!canUse(ref.scopeStamp, await currentAccess())) throw new StateError(404, '引用不可用。');
            };
            await verifyRef();
            let target;
            try {
                target = await businessStore.verifyAgentReport(reportId, ref.teamVersion, ref.scopeStamp.team ? null : owner);
            } finally {
                await verifyRef();
            }
            if (!response.destroyed) sendJson(response, 200, target);
            return;
        }
        const match = route.exec(url.pathname);
        if (!match) throw new StateError(404, '未找到对话接口。');
        const [, id, command] = match;
        const isMessage = url.pathname.includes('/messages');
        const limit = Number(url.searchParams.get('limit') ?? 30);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
        if (!id && request.method === 'GET') return send(200, await store.list(owner, url.searchParams.get('cursor'), limit));
        if (!id && request.method === 'POST') return send(201, {session: await store.create(owner, verify)});
        if (!id) throw new StateError(405, '请求方式无效。');
        if (!isMessage && request.method === 'GET') return send(200, {session: await store.read(owner, id, url.searchParams.get('before'), limit)});
        if (!isMessage && request.method === 'DELETE') return send(200, await store.remove(owner, id, verify));
        if (request.method !== (isMessage ? 'POST' : 'PATCH')) throw new StateError(405, '请求方式无效。');
        const body = await readBody(request, 32 * 1024);
        if (!isMessage) {
            const title = typeof body?.title === 'string' ? body.title.trim() : '';
            if (!title || title.length > 80 || /[\r\n]/.test(title)) throw invalid();
            return send(200, {session: await store.rename(owner, id, title, verify)});
        }
        if (command === 'select') {
            if (!validId(body?.messageId)) throw invalid();
            return send(200, {session: await store.select(owner, id, body.messageId, verify)});
        }
        const {turnId, editMessageId, regenerateMessageId} = body ?? {};
        if (!validId(turnId)) throw invalid();
        if (command === 'stop') {
            await store.stop(owner, id, turnId, verify);
            return send(200, {ok: true});
        }
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        const {expectedBranchEpoch} = body;
        if (expectedBranchEpoch !== undefined && (!Number.isSafeInteger(expectedBranchEpoch) || expectedBranchEpoch < 0)) throw invalid();
        if ((editMessageId !== undefined && !validId(editMessageId)) || (regenerateMessageId !== undefined &&
                (!validId(regenerateMessageId) || editMessageId !== undefined || body.content !== undefined)) ||
            (!regenerateMessageId && (!content || content.length > 4000))) throw invalid();
        const controller = new AbortController();
        const abort = () => controller.abort();
        const access = await currentAccess();
        let scopeStamp;
        const verifyTurn = async () => {
            const current = await currentAccess();
            if (response.destroyed) abort();
            if (!canUse(scopeStamp, current)) throw new StateError(403, '查询权限已变化，请重新提问。');
            return current;
        };
        response.once('close', abort);
        try {
            const start = await store.begin(owner, id, {
                turnId,
                content,
                editMessageId,
                regenerateMessageId,
                expectedBranchEpoch, access
            }, controller, verify);
            scopeStamp = start.inheritedStamp;
            if (start.session) return await send(200, {session: start.session});
            const streaming = request.headers.accept?.includes('application/x-ndjson');
            let seq = 0, text = '', durable = '', answerText, timer, flushing, issue, storageIssue;
            const event = frame => {
                if (!response.destroyed) response.write(`${JSON.stringify({...frame, turnId, seq: ++seq})}\n`);
            };

            // 只展示已经过检查点的文本。连续 token 合并存储；慢磁盘时最多一笔写在途。
            async function flush() {
                if (flushing) await flushing;
                const target = text;
                if (target === durable || controller.signal.aborted) return;
                const task = (async () => {
                    try {
                        if (!await store.checkpoint(id, turnId, target, verifyTurn)) return;
                        const delta = target.slice(durable.length);
                        if (scopeStamp) await verifyTurn();
                        durable = target;
                        if (!controller.signal.aborted) event({type: 'delta', content: delta});
                    } catch (err) {
                        storageIssue = err instanceof StateError ? failure(err) : {
                            status: 503,
                            error: '私人历史暂不可用。'
                        };
                        abort();
                    }
                })();
                flushing = task;
                try {
                    await task;
                } finally {
                    if (flushing === task) flushing = null;
                }
            }

            let ending = false;

            function scheduleFlush() {
                if (!timer && !flushing && !ending && !controller.signal.aborted) timer = setTimeout(async () => {
                    timer = null;
                    await flush();
                    if (text !== durable) scheduleFlush();
                }, 80);
            }

            function delta(chunk) {
                if (controller.signal.aborted || !chunk) return;
                if (text.length + chunk.length > maxReply) {
                    issue = {status: 413, error: '回复过长，已中止。'};
                    abort();
                    return;
                }
                text += chunk;
                scheduleFlush();
            }

            let session;
            try {
                if (response.destroyed) abort();
                controller.signal.throwIfAborted();
                await verify();
                controller.signal.throwIfAborted();
                if (streaming) {
                    response.writeHead(200, {
                        'Content-Type': 'application/x-ndjson; charset=utf-8',
                        'Cache-Control': 'no-store, no-transform',
                        'X-Accel-Buffering': 'no'
                    });
                    event({type: 'start'});
                }
                const verifyTools = async () => {
                    controller.signal.throwIfAborted();
                    const current = await verifyTurn();
                    if (!current || !canUse(access, current)) throw new StateError(403, '本轮查询授权已变化，请重新提问。');
                    controller.signal.throwIfAborted();
                    return current;
                };
                const executeTool = async (name, args) => {
                    const current = await verifyTools();
                    if (!current) throw new StateError(403, '当前未授权查询 OA。');
                    if (streaming) event({type: 'tool', label: `正在查询${toolLabel(name)}`});
                    const result = await executeReadTool({
                        store: businessStore,
                        principal: principalFor(current),
                        name,
                        args
                    });
                    if (!result.ok) return result;
                    const issues = name === reportIssuesTool;
                    const business = issues || ['list_weekly_plans', 'list_daily_reports', 'summarize_hours'].includes(name);
                    scopeStamp = combineStamp(scopeStamp, {
                        target: current.target,
                        team: business && (args.scope === 'team' || Boolean(args.ownerId && args.ownerId !== owner)),
                        detail: current.detail && ['list_weekly_plans', 'list_daily_reports'].includes(name),
                        issues
                    });
                    const card = queryCard(name, args, result);
                    await store.recordQuery(id, turnId, scopeStamp, card, queryEvidence(card, result.data), verifyTools);
                    await verifyTools();
                    // 卡片和实体定位只发给前端；模型只接收获准回答的字段与分页状态。
                    const {refs, ...payload} = result;
                    return payload;
                };
                await verifyTurn();
                const answer = await completeAi(access ? [queryPrompt(access), ...start.context] : start.context, {
                    signal: controller.signal,
                    onDelta: streaming ? delta : undefined,
                    ...(access && {tools: readToolDefinitions(principalFor(access)), executeTool, verifyTools})
                });
                if (!controller.signal.aborted) {
                    if (typeof answer?.content !== 'string' || !answer.content.trim()) throw new Error('模型无有效输出。');
                    if (answer.content.length > maxReply) throw new StateError(413, '回复过长，已中止。');
                    answerText = answer.content;
                }
            } catch (err) {
                if (!controller.signal.aborted) issue = failure(err);
            } finally {
                ending = true;
                clearTimeout(timer);
                if (flushing) await flushing;
                // 最终回复随提交计划发布，不提前把尚未展示的尾块写成检查点。
                if (streaming && answerText === undefined && !controller.signal.aborted) await flush();
                try {
                    session = await store.end(owner, id, turnId, answerText ?? text, {
                        interrupted: Boolean(issue || storageIssue),
                        verify: verifyTurn
                    });
                } catch (err) {
                    if (!response.headersSent) throw err;
                    storageIssue = {status: 503, error: '私人历史保存结果待核对，请重新打开会话。'};
                }
            }
            if (response.destroyed) return;
            const finalAccess = await currentAccess();
            const error = !canUse(scopeStamp, finalAccess) ? {
                status: 403,
                error: '查询权限已变化。'
            } : storageIssue ?? issue;
            if (response.headersSent) {
                if (!error && !controller.signal.aborted && answerText !== undefined && answerText.length > durable.length) {
                    event({type: 'delta', content: answerText.slice(durable.length)});
                }
                event({type: 'result', session: publicSession(session, finalAccess), ...error});
                response.end();
                return;
            }
            if (error) return send(error.status, {error: error.error});
            return send(200, {session});
        } finally {
            response.off('close', abort);
        }
    };
}
