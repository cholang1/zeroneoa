import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore} from '../src/repositories/mongoStore.mjs';
import {isolatedAgentApi} from './sessionFixture.mjs';

const capabilities = '/api/zeroai/v2/capabilities';
const sessions = '/api/zeroai/v2/sessions';
const options = {timeout: 20_000};

function expectStatus(result, status) {
    assert.equal(result.status, status, result.error);
    return result;
}

const createSession = async request => expectStatus(await request(sessions, {method: 'POST'}), 201).session;
const getSession = async (request, path) => expectStatus(await request(path), 200).session;
const listSessions = async request => expectStatus(await request(sessions), 200).sessions;
const post = (request, path, body, opts) => request(path, {method: 'POST', body, ...opts});
const send = (request, path, body, opts) => post(request, `${path}/messages`, body, opts);
const select = async (request, path, messageId) =>
    expectStatus(await post(request, `${path}/messages/select`, {messageId}), 200).session;
const contents = session => session.messages.map(({content}) => content);
const collectionNames = async db => (await db.listCollections({}, {nameOnly: true}).toArray()).map(c => c.name).sort();

function readEvents(response) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/x-ndjson\b/i);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    return async () => {
        while (!buffer.includes('\n')) {
            const {value, done} = await reader.read();
            if (done) {
                assert.equal(buffer, '', '流结束时不应留下半条 NDJSON');
                return null;
            }
            buffer += value;
        }
        const end = buffer.indexOf('\n');
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        return event;
    };
}

test('v2 按账号而不是浏览器隔离，重启后仍可读取，聊天写入不改变业务版本', options, async t => {
    const fixture = isolatedAgentApi(t), contexts = [];
    const model = async messages => {
        contexts.push(messages);
        return {content: `回答 ${messages.at(-1).content}`};
    };
    const api = await fixture.boot(model);
    const a = await api.browser('member-a');
    const businessBefore = expectStatus(await a('/api/state'), 200).state;
    assert.deepEqual(await a(capabilities), {status: 200, historyV2: true});
    assert.equal((await api.anonymous(sessions)).status, 401);
    assert.equal((await api.anonymous(sessions, {method: 'POST'})).status, 401);

    const aSession = await createSession(a), aPath = `${sessions}/${aSession.id}`;
    const aFirst = expectStatus(await send(a, aPath, {turnId: 'same-turn', content: '甲的问题'}), 200).session;
    assert.equal(aFirst.title, '甲的问题');
    const aOtherBrowser = await api.browser('member-a'), b = await api.browser('member-b');
    assert.deepEqual((await listSessions(aOtherBrowser)).map(({id}) => id), [aSession.id]);
    assert.deepEqual(await getSession(aOtherBrowser, aPath), aFirst);
    // 另一浏览器还停在空分支时发送新追问，不能接到刚完成的分支上。
    assert.equal(aSession.branchEpoch, 0);
    expectStatus(await send(aOtherBrowser, aPath, {
        turnId: 'stale-followup',
        content: '过期页的问题',
        expectedBranchEpoch: aSession.branchEpoch
    }), 409);
    const replay = await send(aOtherBrowser, aPath, {
        turnId: 'same-turn',
        content: '甲的问题',
        expectedBranchEpoch: aSession.branchEpoch
    });
    assert.deepEqual(expectStatus(replay, 200).session, aFirst);
    assert.deepEqual(await listSessions(b), []);
    for (const [suffix, method, body] of [
        ['', 'GET'], ['', 'PATCH', {title: '别人的标题'}], ['', 'DELETE'],
        ['/messages', 'POST', {turnId: 'intrude', content: '越权发送'}],
        ['/messages/stop', 'POST', {turnId: 'same-turn'}],
        ['/messages/select', 'POST', {messageId: aFirst.messages.at(-1).id}]
    ]) assert.equal((await b(aPath + suffix, {method, body})).status, 404, `${method} ${suffix}`);

    const bSession = await createSession(b), bPath = `${sessions}/${bSession.id}`;
    const bFirst = expectStatus(await send(b, bPath, {turnId: 'same-turn', content: '乙的问题'}), 200).session;
    assert.equal((await aOtherBrowser(bPath)).status, 404);
    const spare = await createSession(aOtherBrowser);
    const deleted = expectStatus(await a(`${sessions}/${spare.id}`, {method: 'DELETE'}), 200);
    assert.deepEqual(deleted.sessions.map(({id}) => id), [aSession.id]);
    assert.deepEqual(expectStatus(await a('/api/state'), 200).state, businessBefore);
    assert.deepEqual(contexts, [[{role: 'user', content: '甲的问题'}], [{role: 'user', content: '乙的问题'}]]);

    const restarted = await fixture.boot();
    const freshA = await restarted.browser('member-a'), freshB = await restarted.browser('member-b');
    assert.deepEqual(await getSession(freshA, aPath), aFirst);
    assert.deepEqual(await getSession(freshB, bPath), bFirst);
    assert.equal((await freshA(`${sessions}/${spare.id}`)).status, 404);
    assert.equal((await freshB(aPath)).status, 404);
    assert.deepEqual((await listSessions(freshB)).map(({id}) => id), [bSession.id]);
    assert.deepEqual(expectStatus(await freshA('/api/state'), 200).state, businessBefore);
});

test('手动标题、编辑分支与重新生成版本重启后保留，选回旧版本可见原追问', options, async t => {
    const fixture = isolatedAgentApi(t), contexts = [];
    const model = async messages => {
        contexts.push(messages.map(({content}) => content));
        return {content: `回答 ${contexts.length}`};
    };
    const a = await (await fixture.boot(model)).browser();
    const path = `${sessions}/${(await createSession(a)).id}`;
    const renamed = expectStatus(await a(path, {method: 'PATCH', body: {title: '  手工标题  '}}), 200).session;
    assert.equal(renamed.title, '手工标题');
    const first = expectStatus(await send(a, path, {turnId: 'first', content: '原问题'}), 200).session;
    const [question, answer] = first.messages;
    const followup = expectStatus(await send(a, path, {turnId: 'followup', content: '原追问'}), 200).session;
    const regenerated = expectStatus(await send(a, path, {
        turnId: 'regen',
        regenerateMessageId: answer.id
    }), 200).session;
    const alternateAnswer = regenerated.messages[1];
    assert.deepEqual(contents(regenerated), ['原问题', '回答 3']);
    assert.deepEqual(alternateAnswer.versions, {current: 2, total: 2, previousId: answer.id});
    assert.deepEqual(contents(await select(a, path, answer.id)), contents(followup));

    const edited = expectStatus(await send(a, path, {
        turnId: 'edit',
        editMessageId: question.id,
        content: '改写问题'
    }), 200).session;
    assert.deepEqual(contents(edited), ['改写问题', '回答 4']);
    assert.deepEqual(edited.messages[0].versions, {current: 2, total: 2, previousId: question.id});
    assert.equal(edited.title, '手工标题');
    assert.deepEqual(contexts, [['原问题'], ['原问题', '回答 1', '原追问'], ['原问题'], ['改写问题']]);

    const fresh = await (await fixture.boot()).browser();
    assert.deepEqual(await getSession(fresh, path), edited);
    assert.equal((await post(fresh, `${path}/messages/select`, {messageId: answer.id})).status, 409);
    const restored = await select(fresh, path, question.id);
    assert.deepEqual(contents(restored), ['原问题', '回答 1', '原追问', '回答 2']);
    assert.equal(restored.title, '手工标题');
    assert.equal(restored.messages[0].versions.nextId, edited.messages[0].id);
    assert.equal(restored.messages[1].versions.nextId, alternateAnswer.id);
    assert.deepEqual(contents(await select(fresh, path, alternateAnswer.id)), ['原问题', '回答 3']);
    const back = await select(fresh, path, answer.id);
    assert.equal(back.branchEpoch, restored.branchEpoch + 2, '即使切回原分支，旧页面也须重新核对');
    assert.deepEqual(back, {...restored, branchEpoch: back.branchEpoch});
});

test('列表用 cursor 翻页，历史用 before 向前翻页，不重复或遗漏消息', options, async t => {
    const api = await isolatedAgentApi(t).boot(async messages => ({content: `答 ${messages.at(-1).content}`}));
    const a = await api.browser(), b = await api.browser('member-b');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await createSession(a)).id);
    await createSession(b);
    const fullList = await listSessions(a);
    assert.deepEqual(fullList.map(({id}) => id).sort(), [...ids].sort());
    const paged = [];
    let cursor;
    for (let i = 0; i < ids.length; i++) {
        const query = new URLSearchParams({limit: '1', ...(cursor && {cursor})});
        const page = expectStatus(await a(`${sessions}?${query}`), 200);
        assert.equal(page.sessions.length, 1);
        paged.push(...page.sessions);
        cursor = page.nextCursor;
        if (i < ids.length - 1) assert.ok(typeof cursor === 'string' && cursor.length > 0);
    }
    assert.ok(cursor == null);
    assert.deepEqual(paged, fullList);

    const path = `${sessions}/${ids[0]}`;
    for (let i = 1; i <= 3; i++) expectStatus(await send(a, path, {turnId: `page-${i}`, content: `问题 ${i}`}), 200);
    const full = await getSession(a, path);
    assert.deepEqual(contents(full), ['问题 1', '答 问题 1', '问题 2', '答 问题 2', '问题 3', '答 问题 3']);
    const history = [];
    let before;
    for (let i = 0; i < 3; i++) {
        const query = new URLSearchParams({limit: '2', ...(before && {before})});
        const page = await getSession(a, `${path}?${query}`);
        assert.deepEqual(page.messages, full.messages.slice(4 - i * 2, 6 - i * 2));
        history.unshift(...page.messages);
        before = page.before;
        if (i < 2) assert.ok(typeof before === 'string' && before.length > 0);
    }
    assert.ok(before == null);
    assert.deepEqual(history, full.messages);
});

test('首块前停止会保存空的 stopped 回复，客户端断流会保存已见内容', options, async t => {
    const fixture = isolatedAgentApi(t);
    const waiting = Promise.withResolvers(), waitingAborted = Promise.withResolvers();
    const disconnected = Promise.withResolvers();
    const model = async (messages, {onDelta, signal}) => {
        const prompt = messages.at(-1).content;
        if (prompt === '后续追问') {
            assert.deepEqual(messages, [
                {role: 'user', content: '首块前停止'}, {role: 'user', content: '断开连接'},
                {role: 'assistant', content: '浏览器已收到'}, {role: 'user', content: prompt}
            ]);
            return {content: '可以继续'};
        }
        if (prompt === '首块前停止') waiting.resolve();
        else await onDelta('浏览器已收到');
        if (!signal.aborted) await once(signal, 'abort', {signal: t.signal});
        (prompt === '首块前停止' ? waitingAborted : disconnected).resolve();
        signal.throwIfAborted();
    };
    const a = await (await fixture.boot(model)).browser();
    const path = `${sessions}/${(await createSession(a)).id}`;
    const early = readEvents(await send(a, path, {turnId: 'stop-early', content: '首块前停止'}, {stream: true}));
    assert.equal((await early()).type, 'start');
    await waiting.promise;
    const stop = await post(a, `${path}/messages/stop`, {turnId: 'stop-early'});
    assert.equal(expectStatus(stop, 200).ok, true);
    const result = await early();
    assert.equal(result.type, 'result');
    assert.deepEqual(contents(result.session), ['首块前停止', '']);
    assert.equal(result.session.messages.at(-1).status, 'stopped');
    assert.equal(await early(), null);
    await waitingAborted.promise;

    const abort = new AbortController();
    try {
        const events = readEvents(await send(a, path, {turnId: 'disconnect', content: '断开连接'}, {
            stream: true,
            signal: abort.signal
        }));
        assert.equal((await events()).type, 'start');
        const delta = await events();
        assert.equal(delta.type, 'delta');
        assert.equal(delta.content, '浏览器已收到');
    } finally {
        abort.abort();
    }
    await disconnected.promise;
    // 模型先收到断开信号，随后才可能完成 Mongo 提交；用详情接口等待可见结果。
    let saved;
    for (let i = 0; i < 100; i++) {
        saved = await getSession(a, path);
        if (saved.messages.length === 4) break;
        await delay(20, undefined, {signal: t.signal});
    }
    assert.deepEqual(contents(saved), ['首块前停止', '', '断开连接', '浏览器已收到']);
    assert.equal(saved.messages.at(-1).status, 'interrupted');
    const fresh = await (await fixture.boot(model)).browser();
    assert.deepEqual(await getSession(fresh, path), saved);
    const followed = expectStatus(await send(fresh, path, {turnId: 'after-stream', content: '后续追问'}), 200).session;
    assert.deepEqual(contents(followed).slice(-2), ['后续追问', '可以继续']);
});

test('无输出失败不增加消息，同轮次换内容返回 409，原内容可跨重启重试且幂等', options, async t => {
    const fixture = isolatedAgentApi(t), body = {turnId: 'retry', content: '可以重试的问题'};
    let calls = 0;
    const a = await (await fixture.boot(async () => {
        calls++;
        throw Object.assign(new Error('测试超时，未产生输出'), {code: 'AI_TIMEOUT'});
    })).browser();
    const path = `${sessions}/${(await createSession(a)).id}`;
    expectStatus(await send(a, path, body), 504);
    assert.deepEqual((await getSession(a, path)).messages, []);
    expectStatus(await send(a, path, {...body, content: '不要覆盖原请求'}), 409);
    assert.equal(calls, 1);

    const fresh = await (await fixture.boot(async messages => {
        calls++;
        assert.deepEqual(messages, [{role: 'user', content: body.content}]);
        return {content: '重试成功'};
    })).browser();
    expectStatus(await send(fresh, path, {...body, content: '重启后也不能覆盖'}), 409);
    const success = expectStatus(await send(fresh, path, body), 200).session;
    assert.deepEqual(contents(success), [body.content, '重试成功']);
    const afterSuccess = await (await fixture.boot()).browser();
    assert.deepEqual(expectStatus(await send(afterSuccess, path, body), 200).session, success);
    expectStatus(await send(afterSuccess, path, {...body, content: '完成后不能覆盖'}), 409);
    assert.deepEqual(await getSession(afterSuccess, path), success);
    assert.equal(calls, 2);
});

test('服务首次启动为已初始化的业务库迁移 v2 私人历史，不改业务数据或版本', options, async t => {
    const fixture = isolatedAgentApi(t);
    const meta = fixture.db.collection('team_meta');
    const offline = await openStore(fixture.uri, {initializeAgentHistory: false});
    let business;
    try {
        await offline.initialize();
        const existing = await offline.read();
        const memo = {id: 'existing-memo', text: '已有业务数据'};
        business = await offline.patch(existing.version, [{key: 'memos', id: memo.id, before: null, after: memo}]);
        assert.equal(business.version, existing.version + 1);
        assert.deepEqual(business.memos, [memo]);
    } finally {
        await offline.close();
    }
    const markerBefore = await meta.findOne({_id: 'default'});
    assert.equal(markerBefore.agentSchemaVersion, undefined);
    const agentCollections = ['agent_messages', 'agent_sessions', 'agent_turns'];
    const collectionsBefore = await collectionNames(fixture.db);
    assert.ok(agentCollections.every(name => !collectionsBefore.includes(name)));

    const fresh = await (await fixture.boot()).browser();
    assert.deepEqual(await fresh(capabilities), {status: 200, historyV2: true});
    const markerAfter = await meta.findOne({_id: 'default'});
    assert.equal(markerAfter.agentSchemaVersion, 3);
    assert.equal(markerAfter.schema, markerBefore.schema);
    assert.equal(markerAfter.version, business.version);
    const collectionsAfter = await collectionNames(fixture.db);
    for (const name of agentCollections) assert.ok(collectionsAfter.includes(name), name);
    assert.deepEqual(expectStatus(await fresh('/api/state'), 200).state, business);
    assert.deepEqual(await listSessions(fresh), []);

    const newSession = await createSession(fresh);
    // 此测试库还没有查询记录，可用旧标记模拟升级。原 P1/P2 三个集合都不需重建。
    for (const oldVersion of [1, 2]) {
        await meta.updateOne({_id: 'default'}, {$set: {agentSchemaVersion: oldVersion}});
        const reopened = await (await fixture.boot()).browser();
        assert.equal((await meta.findOne({_id: 'default'})).agentSchemaVersion, 3);
        assert.deepEqual(await getSession(reopened, `${sessions}/${newSession.id}`), newSession);
        assert.deepEqual(expectStatus(await reopened('/api/state'), 200).state, business);
    }
});

test('已登录客户端请求旧聊天协议返回 404，不设置聊天 Cookie 或调用模型', options, async t => {
    let modelCalls = 0;
    const api = await isolatedAgentApi(t).boot(async () => {
        modelCalls++;
        return {content: '不应调用模型'};
    });
    const request = await api.browser();
    assert.equal(expectStatus(await request('/api/session'), 200).user.id, 'member-a');
    const session = await createSession(request), legacy = '/api/zeroai/sessions';
    const detail = `${legacy}/${session.id}`;
    for (const [path, method, body, stream] of [
        [legacy, 'GET'], [legacy, 'POST', {}], [detail, 'GET'],
        [detail, 'PATCH', {title: '旧版标题'}], [detail, 'DELETE'],
        [`${detail}/messages`, 'POST', {turnId: 'legacy', content: '旧版问题'}, true],
        [`${detail}/messages/stop`, 'POST', {turnId: 'legacy'}],
        [`${detail}/messages/select`, 'POST', {messageId: 'legacy'}]
    ]) {
        const response = await request(path, {method, body, raw: true, stream});
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.deepEqual(response.headers.getSetCookie(), [], `${method} ${path}`);
        await response.json();
    }
    assert.equal(modelCalls, 0);
    assert.deepEqual(await listSessions(request), [{id: session.id, title: session.title}]);
    assert.deepEqual(await getSession(request, `${sessions}/${session.id}`), session);
});

test('私人历史初始化故障时能力探测与 v2 列表都返回 503，业务状态仍可用', options, async t => {
    const fixture = isolatedAgentApi(t);
    const request = await (await fixture.boot()).browser();
    const business = expectStatus(await request('/api/state'), 200).state;
    // 模拟历史集合缺失的还原库：不能假装历史为空或回退到旧协议。
    await fixture.db.collection('agent_messages').drop();
    const restarted = await (await fixture.boot()).browser();
    expectStatus(await restarted(capabilities), 503);
    expectStatus(await restarted(sessions), 503);
    assert.deepEqual(expectStatus(await restarted('/api/state'), 200).state, business);
    assert.ok(!(await collectionNames(fixture.db)).includes('agent_messages'));
});

test('陌生库拒绝启用历史，不加集合或修改已有文档', options, async t => {
    const fixture = isolatedAgentApi(t), {db} = fixture;
    const foreignMeta = {_id: 'default', schema: 'unrelated-v1', version: 7};
    const sentinel = {_id: 'keep', text: '不要改动'};
    await db.collection('team_meta').insertOne(foreignMeta);
    await db.collection('unrelated').insertOne(sentinel);
    await assert.rejects(fixture.boot(), {status: 503});
    assert.deepEqual(await collectionNames(db), ['team_meta', 'unrelated']);
    assert.deepEqual(await db.collection('team_meta').find().toArray(), [foreignMeta]);
    assert.deepEqual(await db.collection('unrelated').find().toArray(), [sentinel]);
});
