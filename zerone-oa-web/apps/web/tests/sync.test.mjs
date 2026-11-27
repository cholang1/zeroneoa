import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createServer} from 'vite';

let vite, buildStateChanges, mergeTeamState, sameJson, foldSaveSnapshot, overlayStateChanges;
let workActions, prepareImportedState, saveWithMerge, parseRecovery, pendingRecovery, recoveryChanges,
    memberRecoveryKey,
    clearLegacySession, createTeamApi;
const actor = {id: 'u1', name: '测试', color: '#000'};
const csrfToken = 'test-csrf';
const sessionApi = t => {
    const api = createTeamApi(csrfToken, () => assert.fail('模拟业务请求不应导致会话失效'));
    t.after(() => api.close());
    return api;
};
const assertWriteHeaders = ({headers, credentials}) => {
    assert.equal(headers.get('X-OA-CSRF'), csrfToken);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(credentials, 'same-origin');
};
const empty = {
    version: 1,
    users: [],
    tasks: [],
    memos: [],
    weeklyPlans: [],
    dailyReports: [],
    aiReminders: [],
    events: [],
    dayThreads: [],
    auditLog: []
};
before(async () => {
    vite = await createServer({
        configFile: false,
        appType: 'custom',
        optimizeDeps: {noDiscovery: true, include: []},
        server: {middlewareMode: true, hmr: false, watch: null}
    });
    ({
        buildStateChanges,
        mergeTeamState,
        sameJson,
        foldSaveSnapshot,
        overlayStateChanges
    } = await vite.ssrLoadModule('/src/sync/merge.ts'));
    ({workActions} = await vite.ssrLoadModule('/src/features/worklog/workActions.ts'));
    ({prepareImportedState} = await vite.ssrLoadModule('/src/features/data-tools/dataActions.ts'));
    ({saveWithMerge} = await vite.ssrLoadModule('/src/sync/useTeamSync.ts'));
    ({
        parseRecovery,
        pendingRecovery,
        recoveryChanges,
        memberRecoveryKey
    } = await vite.ssrLoadModule('/src/sync/recoveryModel.ts'));
    ({clearLegacySession} = await vite.ssrLoadModule('/src/features/session/storage.ts'));
    ({createTeamApi} = await vite.ssrLoadModule('/src/shared/api.ts'));
});
after(async () => {
    await vite?.close();
});

const ids = (rows) => rows.map(({id}) => id);

test('换号时丢弃已返回 200 但尚未读完的旧快照，新账号依然能读取自己的响应', {timeout: 5000}, async t => {
    const decoding = Promise.withResolvers(), oldBody = Promise.withResolvers();
    const lost = () => assert.fail('旧响应不能锁定新工作台');
    const a = createTeamApi('synthetic-a', lost, 'member-a');
    const b = createTeamApi('synthetic-b', lost, 'member-b');
    t.after(() => {
        a.close();
        b.close();
        oldBody.resolve({state: empty});
    });
    t.mock.method(globalThis, 'fetch', async (_path, options) => {
        if (options.headers.get('X-OA-CSRF') === 'synthetic-b') return Response.json({state: {...empty, version: 2}});
        // 模拟已收到响应头，正文延迟交付且传输层未及时响应取消。
        return {
            ok: true, json: () => {
                decoding.resolve();
                return oldBody.promise;
            }
        };
    });
    const pending = a.loadState();
    await decoding.promise;
    a.close();
    assert.equal((await b.loadState()).state.version, 2);
    oldBody.resolve({state: {...empty, version: 1}});
    await assert.rejects(pending, {name: 'AbortError'});
});

test('ZeroAI 只调用 v2：503 不降级，分页、写入、流式回复和重复轮次均使用账号凭证', async t => {
    const base = '/api/zeroai/v2';
    const sessions = `${base}/sessions`;
    const id = '会话/1';
    const sessionPath = `${sessions}/${encodeURIComponent(id)}`;
    const report = {type: 'report', id: '日报/1 ?#', label: '原日报'};
    const answer = {
        id: '回答/1', role: 'assistant', content: '模拟回复', queryCards: [{
            name: 'list_daily_reports', label: '日报', asOf: '2026-11-20T05:00:00Z', refs: [report], teamVersion: 2
        }]
    };
    const snapshot = {id, title: '测试会话', messages: [answer], branchEpoch: 2};
    const refPath = `${sessionPath}/messages/${encodeURIComponent(answer.id)}/refs/report/${encodeURIComponent(report.id)}`;
    const verifiedRef = {id: report.id, teamVersion: 2};
    const cursor = '列表游标', before = '消息游标';
    const turn = {turnId: 'turn-1', content: '测试问题', expectedBranchEpoch: 2};
    const update = (seq, frame) => ({turnId: turn.turnId, seq, ...frame});
    const start = update(2, {type: 'start'});
    const legacy = update(3, {type: 'tool', label: '正在查询日报'});
    const toolPending = update(6, {type: 'tool', callId: '日报调用', status: 'pending', label: '日报'});
    const toolDone = update(7, {type: 'tool', callId: '日报调用', status: 'done', label: '日报'});
    const toolError = update(8, {type: 'tool', callId: '任务调用', status: 'error', label: '任务'});
    const phase = update(9, {type: 'phase', phase: 'answering'});
    const delta = update(10, {type: 'delta', content: '\n\n模拟回复'});
    const result = update(11, {type: 'result', session: snapshot});
    const frames = [
        update(1, {type: 'new-event'}), start, legacy, legacy, update(4, {type: 'start'}),
        update(5, {type: 'tool', label: 123}),
        update(99, {type: 'result', turnId: 'wrong-turn', session: {id: '旧会话'}}),
        update(99, {type: 'tool', label: '日报', status: 'pending'}),
        update(99, {type: 'tool', label: '日报', callId: 'x'}),
        update(99, {type: 'tool', label: '日报', callId: 'x', status: 'unknown'}),
        update(99, {type: 'tool', label: ' ', callId: 'x', status: 'done'}),
        update(99, {type: 'phase', phase: 'unsupported'}),
        toolPending, toolDone, toolPending, toolError, phase, delta, result
    ];
    // 刻意拆开帧和 UTF-8 字符，最终帧没有换行。
    const bytes = Buffer.from(frames.map(frame => JSON.stringify(frame)).join('\n'));
    const stream = new ReadableStream({
        start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
            controller.close();
        }
    });
    const calls = [
        ['GET', `${base}/capabilities`, {}, undefined, Response.json({error: '私人历史暂不可用。'}, {status: 503})],
        ['GET', `${base}/capabilities`, {}, undefined, Response.json({historyV2: true})],
        ['GET', sessions, {cursor}, undefined, Response.json({sessions: [{id, title: snapshot.title}]})],
        ['GET', sessionPath, {before}, undefined, Response.json({session: snapshot})],
        ['GET', refPath, {}, undefined, Response.json(verifiedRef)],
        ['POST', sessions, {}, undefined, Response.json({session: snapshot}, {status: 201})],
        ['PATCH', sessionPath, {}, {title: '改名'}, Response.json({session: snapshot})],
        ['POST', `${sessionPath}/messages`, {}, turn, new Response(stream, {
            headers: {'Content-Type': 'application/x-ndjson'}
        })],
        ['POST', `${sessionPath}/messages`, {}, turn, new Response(`${JSON.stringify(start)}\n`, {
            headers: {'Content-Type': 'application/x-ndjson'}
        })],
        // 已完成轮次的幂等回执仍以 JSON 返回，不是旧历史接口。
        ['POST', `${sessionPath}/messages`, {}, turn, Response.json({session: snapshot})],
        ['POST', `${sessionPath}/messages/select`, {}, {messageId: 'answer-1'}, Response.json({session: snapshot})],
        ['POST', `${sessionPath}/messages/stop`, {}, {turnId: turn.turnId}, Response.json({ok: true})],
        ['DELETE', sessionPath, {}, undefined, Response.json({sessions: []})]
    ];
    let sent = 0;
    const userId = 'u/1';
    const {zeroAi} = sessionApi(t);
    const {signal} = new AbortController();
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const {pathname, searchParams} = new URL(url, 'http://example.test');
        const call = calls[sent++];
        assert.ok(call, `意外请求：${url}`);
        const [method, path, query, body, response] = call;
        assert.equal(init.method ?? 'GET', method);
        assert.equal(pathname, path);
        assert.deepEqual(Object.fromEntries(searchParams), path.endsWith('/capabilities') ? query : {actorId: userId, ...query});
        assert.equal(init.credentials, 'same-origin');
        assert.equal(init.headers.get('X-OA-CSRF'), csrfToken);
        if (method !== 'GET') assertWriteHeaders(init);
        assert.deepEqual(init.body === undefined ? undefined : JSON.parse(init.body), body);
        if (path.endsWith('/messages')) assert.equal(init.headers.get('Accept'), 'application/x-ndjson');
        return response;
    });

    await assert.rejects(zeroAi.capabilities(signal), {status: 503, message: '私人历史暂不可用。'});
    assert.equal(sent, 1, '失败后不自动回退或重试');
    assert.deepEqual(await zeroAi.capabilities(signal), {historyV2: true});
    assert.deepEqual(await zeroAi.list(userId, {cursor}), {sessions: [{id, title: snapshot.title}]});
    assert.deepEqual(await zeroAi.open(userId, id, {before}), {session: snapshot});
    assert.deepEqual(await zeroAi.verifyReportRef(userId, id, answer.id, report.id, signal), verifiedRef);
    await zeroAi.create(userId);
    await zeroAi.rename(userId, id, '改名');
    const events = [];
    assert.deepEqual(await zeroAi.send(userId, id, turn, signal, frame => events.push(frame)), result);
    assert.deepEqual(events, [start, legacy, toolPending, toolDone, toolError, phase, delta]);
    await assert.rejects(zeroAi.send(userId, id, turn, signal, () => {
    }), /回复连接已断开/);
    assert.deepEqual(await zeroAi.send(userId, id, turn, signal, () => assert.fail('幂等回执不重新生成')), {
        type: 'result', session: snapshot
    });
    await zeroAi.selectVersion(userId, id, 'answer-1');
    await zeroAi.stop(userId, id, turn.turnId, signal);
    await zeroAi.remove(userId, id);
    assert.equal(sent, calls.length);
});

test('差量忽略对象键顺序、未定义属性和记录重排，但保留嵌套数组的顺序语义', () => {
    const a = {id: 'a', nested: {z: [1, 2], a: [{x: 1, y: 2}]}, omitted: undefined};
    const b = {nested: {a: [{y: 2, x: 1, extra: undefined}], z: [1, 2]}, id: 'a'};
    assert.ok(sameJson(a, b));
    assert.ok(!sameJson(a, {...b, nested: {...b.nested, z: [2, 1]}}));
    assert.deepEqual(buildStateChanges(
        {...empty, tasks: [a, {id: 'b'}]},
        {...empty, version: 5, tasks: [{id: 'b'}, b]}
    ), []);
    assert.deepEqual(mergeTeamState({...empty, tasks: [a]}, {...empty, tasks: [b]}, {
        ...empty, tasks: [{...a, title: '本地编辑'}]
    }).conflicts, []);
});

test('日报和周计划新批次排在历史之前，审计追加且在差量末尾', () => {
    const logs = Array.from({length: 510}, (_, index) => ({id: `log-${index}`}));
    const base = {...empty, dailyReports: [{id: 'old'}], weeklyPlans: [{id: 'old-plan'}], auditLog: logs};
    const server = {
        ...base,
        version: 2,
        dailyReports: [{id: 'remote'}, ...base.dailyReports],
        auditLog: [...logs, {id: 'remote-log'}]
    };
    const local = {
        ...base,
        dailyReports: [{id: 'local-1'}, {id: 'local-2'}, ...base.dailyReports],
        weeklyPlans: [{id: 'new-plan'}, ...base.weeklyPlans],
        auditLog: [...logs, {id: 'local-log'}]
    };
    const result = mergeTeamState(base, server, local);
    assert.equal(result.state.version, 2);
    assert.deepEqual(ids(result.state.dailyReports), ['local-1', 'local-2', 'remote', 'old']);
    assert.deepEqual(ids(result.state.weeklyPlans), ['new-plan', 'old-plan']);
    assert.deepEqual(result.state.auditLog, [...logs, {id: 'remote-log'}, {id: 'local-log'}]);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(buildStateChanges(server, result.state), [
        {key: 'weeklyPlans', id: 'new-plan', before: null, after: {id: 'new-plan'}},
        {key: 'dailyReports', id: 'local-1', before: null, after: {id: 'local-1'}},
        {key: 'dailyReports', id: 'local-2', before: null, after: {id: 'local-2'}},
        {key: 'auditLog', id: 'local-log', before: null, after: {id: 'local-log'}}
    ]);
});

test('同条冲突可选择本地或服务器；明确删除的未冲突条目不会复活', () => {
    const base = {...empty, tasks: [{id: 'a', title: '原名'}, {id: 'b'}]};
    const remote = {...base, version: 2, tasks: [{id: 'a', title: '服务器'}, {id: 'b'}]};
    const local = {...base, tasks: [{id: 'a', title: '本地'}]};
    for (const preferLocal of [true, false]) {
        const result = mergeTeamState(base, remote, local, preferLocal);
        assert.deepEqual(result.conflicts, ['task:a']);
        assert.deepEqual(result.state.tasks, [{id: 'a', title: preferLocal ? '本地' : '服务器'}]);
    }
});

test('后端返回聚合快照时，排队改动保留原 before，且不捎带删除别人的新增数据', () => {
    const old = {id: 'b', title: '原名'};
    const head = {...empty, tasks: [{id: 'a'}, old]};
    const saved = {...head, version: 2, tasks: [{id: 'a'}, {id: 'b', title: '服务器'}, {id: 'c'}]};
    const live = {...head, tasks: [{id: 'a'}]};
    const folded = foldSaveSnapshot(head, saved, live);
    assert.deepEqual(ids(folded.state.tasks), ['a', 'c']);
    assert.equal(folded.base.version, 2);
    assert.deepEqual(buildStateChanges(folded.base, folded.state), [
        {key: 'tasks', id: 'b', before: old, after: null}
    ]);
});

test('日报新增和删除分别发送 null 前镜像、null 后镜像并使用响应中的聚合快照', async (t) => {
    const stateRef = {current: structuredClone(empty)};
    const {submitReports, deleteReport} = workActions({
        stateRef, user: actor, persist: state => {
            stateRef.current = state;
        }, withAudit: s => s
    }, '2026-W47');
    submitReports('u1', [{date: '2026-11-19', taskId: 'T01', detail: '模拟日报', hours: 2, notes: ''}]);
    const [row] = stateRef.current.dailyReports;
    assert.equal(row.ownerId, 'u1');
    assert.equal(row.weekId, '2026-W47');
    const existing = {id: 'other-report'};
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, '/api/state');
        assert.equal(init.method, 'PUT');
        assertWriteHeaders(init);
        requests.push(JSON.parse(init.body));
        return Response.json({
            state: {
                ...stateRef.current,
                version: requests.length + 1,
                dailyReports: [...stateRef.current.dailyReports.filter(r => r.id !== existing.id), existing]
            }
        });
    });
    const api = sessionApi(t);
    const saved = await saveWithMerge(empty, stateRef.current, actor, () => true, api);
    assert.deepEqual(saved.dailyReports, [row, existing]);
    stateRef.current = saved;
    deleteReport(row.id);
    assert.deepEqual(stateRef.current.dailyReports, [existing]);
    assert.deepEqual((await saveWithMerge(saved, stateRef.current, actor, () => true, api)).dailyReports, [existing]);
    assert.deepEqual(requests, [
        {actorId: 'u1', baseVersion: 1, changes: [{key: 'dailyReports', id: row.id, before: null, after: row}]},
        {actorId: 'u1', baseVersion: 2, changes: [{key: 'dailyReports', id: row.id, before: row, after: null}]}
    ]);
});

test('同条记录 409 后仅按确认结果重提差量，不重发快照中的独立记录', async (t) => {
    const before = {id: 'a', title: '原名'};
    const remote = {id: 'a', title: '服务器'};
    const after = {id: 'a', title: '本地'};
    const base = {...empty, tasks: [before]};
    const candidate = {...empty, tasks: [after]};
    const latest = {...base, version: 2, tasks: [remote, {id: 'b'}]};
    const saved = {...latest, version: 3, tasks: [after, {id: 'b'}]};
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, '/api/state');
        if (init.method !== 'PUT') return Response.json({state: latest});
        assertWriteHeaders(init);
        requests.push(JSON.parse(init.body));
        if (requests.length === 1) return Response.json({error: '冲突'}, {status: 409});
        return Response.json({state: saved});
    });
    const resolved = await saveWithMerge(base, candidate, actor, () => true, sessionApi(t), conflicts => {
        assert.deepEqual(conflicts, ['task:a']);
        return true;
    });
    assert.deepEqual(resolved, saved);
    assert.deepEqual(requests, [
        {actorId: 'u1', baseVersion: 1, changes: [{key: 'tasks', id: 'a', before, after}]},
        {actorId: 'u1', baseVersion: 2, changes: [{key: 'tasks', id: 'a', before: remote, after}]}
    ]);
});

test('网关丢失响应后从快照确认记录删除和审计均已落盘，不重复写入', async (t) => {
    const base = {...empty, tasks: [{id: 'a'}, {id: 'b'}]};
    const candidate = {...base, tasks: [{id: 'b'}], auditLog: [{id: 'log', actorId: 'u1', action: '删除'}]};
    const saved = {...candidate, version: 4, auditLog: [{action: '删除', actorId: 'u1', id: 'log'}]};
    let puts = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, '/api/state');
        if (init.method !== 'PUT') return Response.json({state: saved});
        assertWriteHeaders(init);
        puts += 1;
        return new Response('网关暂时不可用', {status: 502});
    });
    assert.deepEqual(await saveWithMerge(base, candidate, actor, () => true, sessionApi(t)), saved);
    assert.equal(puts, 1);
});

test('断线恢复保留删除，检测服务端删除后的编辑冲突，不复活未触碰的记录', () => {
    const base = {...empty, tasks: [{id: 'a'}, {id: 'b', title: '原名'}, {id: 'unchanged'}]};
    const local = {...base, tasks: [{id: 'b', title: '本地'}, {id: 'unchanged'}]};
    const remote = {...base, version: 3, tasks: [{id: 'a'}, {id: 'server'}]};
    const savedAt = '2026-11-19T00:00:00.000Z';
    const raw = JSON.stringify({actorId: actor.id, savedAt, changes: buildStateChanges(base, local)});
    const {changes} = parseRecovery(raw, Date.parse(savedAt));
    assert.equal(parseRecovery(raw, Date.parse(savedAt) + 49 * 3600 * 1000), null);
    assert.equal(parseRecovery(JSON.stringify({
        actorId: actor.id,
        savedAt,
        pending: {tasks: base.tasks}
    }), Date.parse(savedAt)), null);
    const restored = mergeTeamState(
        overlayStateChanges(remote, changes, 'before'),
        remote,
        overlayStateChanges(remote, changes, 'after')
    );
    assert.deepEqual(restored.conflicts, ['task:b']);
    assert.deepEqual(ids(restored.state.tasks), ['server']);
    assert.equal(memberRecoveryKey(actor.id), 'oa-v2-pending-recovery-u1');
    assert.notEqual(memberRecoveryKey('u/2'), memberRecoveryKey('u%2F2'));
});

test('有无落盘两种情况下，丢失在途新增的响应后仍能恢复排队删除', () => {
    const report = {id: 'report'};
    const attempted = {...empty, dailyReports: [report]};
    const live = {...empty, auditLog: [{id: 'deleted-log'}]};
    const pending = pendingRecovery(empty, live, attempted);
    assert.deepEqual(pending.followUp, [{key: 'dailyReports', id: report.id, before: report, after: null}]);
    assert.deepEqual(recoveryChanges(empty, pending), pending.changes);
    const saved = {...attempted, version: 2};
    const restored = overlayStateChanges(saved, recoveryChanges(saved, pending), 'after');
    assert.deepEqual(restored.dailyReports, []);
    assert.deepEqual(restored.auditLog, live.auditLog);
    assert.deepEqual(buildStateChanges(saved, restored), [...pending.followUp, ...pending.changes]);
});

test('清理旧身份缓存但保留成员的待恢复记录', () => {
    const legacy = JSON.stringify(actor);
    const recovery = [memberRecoveryKey(actor.id), '待恢复的差量'];
    const storage = new Map([['oa-session-user', legacy], ['oa-v2-session-user', legacy], recovery]);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true, value: {removeItem: key => storage.delete(key)}
    });
    try {
        clearLegacySession();
        assert.deepEqual([...storage], [recovery]);
    } finally {
        if (original) Object.defineProperty(globalThis, 'localStorage', original);
        else delete globalThis.localStorage;
    }
});

test('导入不使用文件版本，完整列表可显式删除，旧文件缺失可选列表不删除已有记录', () => {
    const base = {...empty, version: 12, tasks: [{id: 'old'}], events: [{id: 'meeting'}]};
    const {events, dayThreads, ...legacy} = empty;
    const input = {...legacy, version: 999, tasks: [{id: 'new'}]};
    const next = prepareImportedState(input, base);
    assert.equal(next.version, 12);
    assert.deepEqual(next.events, base.events);
    assert.deepEqual(buildStateChanges(base, next), [
        {key: 'tasks', id: 'new', before: null, after: {id: 'new'}},
        {key: 'tasks', id: 'old', before: {id: 'old'}, after: null}
    ]);
    assert.deepEqual(prepareImportedState({...input, events: []}, base).events, []);
    assert.throws(() => prepareImportedState({users: [], tasks: []}, base), /memos/);
    assert.throws(() => prepareImportedState({...input, tasks: [{id: 'x'}, {id: 'x'}]}, base), /tasks/);
});

test('导入新增、删除或改写成员时整批拒绝', () => {
    const current = {...empty, users: [actor], tasks: [{id: 'current-task'}]};
    const before = structuredClone(current);
    for (const users of [[], [actor, {...actor, id: 'u2'}], [{...actor, name: '改写姓名'}]]) {
        assert.throws(() => prepareImportedState({
            ...current,
            users,
            tasks: [{id: 'imported-task'}]
        }, current), /不能变更成员/);
        assert.deepEqual(current, before);
    }
});

test('导入可以还原业务记录但不能覆盖可信审计', () => {
    const auditLog = [{id: 'trusted', actorId: actor.id, action: '删除日报'}];
    const current = {...empty, users: [actor], auditLog};
    const imported = prepareImportedState({
        ...current, tasks: [{id: 'new-task'}], auditLog: [{id: 'untrusted', action: '导入日志'}]
    }, current);
    assert.deepEqual(imported.auditLog, auditLog);
    assert.deepEqual(buildStateChanges(current, imported), [
        {key: 'tasks', id: 'new-task', before: null, after: {id: 'new-task'}}
    ]);
});
