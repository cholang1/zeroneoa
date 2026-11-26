import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {Readable} from 'node:stream';
import {isolatedAgentApi} from './sessionFixture.mjs';

const sessionsPath = '/api/zeroai/v2/sessions';
const scoped = request => (path = '', options) => request(sessionsPath + path, options);

async function api(t, completeAi) {
    const instance = await isolatedAgentApi(t).boot(completeAi);
    return scoped(await instance.browser());
}

test('ZeroAI 会话按成员读取，幂等重发不重复调用模型，追问只使用本人上下文', async t => {
    const calls = [];
    const complete = async messages => {
        calls.push(messages);
        return {content: `答复 ${calls.length}`};
    };
    const fixture = isolatedAgentApi(t), instance = await fixture.boot(complete);
    const request = scoped(await instance.browser()), bRequest = scoped(await instance.browser('member-b'));
    assert.deepEqual(await request(), {status: 200, sessions: []});
    const {session, status} = await request('', {method: 'POST'});
    assert.equal(status, 201);

    const send = (turnId, content) => request(`/${session.id}/messages`, {
        method: 'POST', body: {turnId, content}
    });
    const first = await send('turn-one', '第一次提问');
    assert.equal(first.status, 200);
    assert.equal(first.session.title, '第一次提问');
    assert.equal((await send('turn-one', '第一次提问')).session.messages.length, 2);
    assert.equal((await send('turn-two', '追问')).session.messages.length, 4);
    assert.deepEqual(calls[1], [
        {role: 'user', content: '第一次提问'},
        {role: 'assistant', content: '答复 1'},
        {role: 'user', content: '追问'}
    ]);
    assert.equal(calls.length, 2);
    const saved = (await request(`/${session.id}`)).session;
    assert.equal(saved.messages.length, 4);
    const anotherBrowser = scoped(await instance.browser());
    assert.deepEqual((await anotherBrowser(`/${session.id}`)).session, saved);
    assert.equal((await bRequest(`/${session.id}`)).status, 404);
    assert.deepEqual(await bRequest(), {status: 200, sessions: []});

    const b = await bRequest('', {method: 'POST'});
    assert.equal(b.status, 201);
    const bReply = await bRequest(`/${b.session.id}/messages`, {
        method: 'POST', body: {turnId: 'turn-one', content: '乙的独立问题'}
    });
    assert.equal(bReply.status, 200);
    // 即便不同成员重用同一轮次标识，模型也只能拿到当前成员的上下文。
    assert.deepEqual(calls[2], [{role: 'user', content: '乙的独立问题'}]);
    assert.equal((await request(`/${b.session.id}`)).status, 404);

    const freshApi = scoped(await (await fixture.boot()).browser());
    assert.deepEqual(await freshApi(), {status: 200, sessions: [{id: session.id, title: first.session.title}]});
    assert.deepEqual((await freshApi(`/${session.id}`)).session, saved);
});

test('手动标题优先，删除只移除指定会话并受现有隔离保护', async t => {
    const instance = await isolatedAgentApi(t).boot(async () => ({content: '回答'}));
    const request = scoped(await instance.browser()), bRequest = scoped(await instance.browser('member-b'));
    const {session} = await request('', {method: 'POST'});
    const {session: other} = await request('', {method: 'POST'});
    const endpoint = `/${session.id}`;
    const rename = (title, send = request) => send(endpoint, {method: 'PATCH', body: {title}});
    assert.equal((await rename('其他成员', bRequest)).status, 404);
    assert.equal((await rename('   ')).status, 400);
    assert.equal((await rename('  手工标题  ')).session.title, '手工标题');
    const reply = await request(`${endpoint}/messages`, {
        method: 'POST', body: {turnId: 'first', content: '首次提问'}
    });
    assert.equal(reply.session.title, '手工标题');
    assert.equal((await bRequest(endpoint, {method: 'DELETE'})).status, 404);
    const deleted = await request(endpoint, {method: 'DELETE'});
    assert.deepEqual(deleted.sessions, [{id: other.id, title: other.title}]);
    assert.equal((await request(endpoint)).status, 404);
});

test('流式输出可在首块后停止，保存已有内容并保留后续追问能力', {timeout: 20_000}, async t => {
    let cancelled = false;
    const request = await api(t, async (messages, {onDelta, signal}) => {
        if (messages.at(-1).content === '后续追问') return {content: '新回答'};
        if (messages.at(-1).content === '耐心等待') onDelta('已经生成的内容');
        if (!signal.aborted) await once(signal, 'abort', {signal: t.signal});
        cancelled = true;
        signal.throwIfAborted();
    });
    const {session} = await request('', {method: 'POST'});
    const path = `/${session.id}/messages`;
    const response = await request(path, {
        method: 'POST',
        stream: true,
        body: {turnId: 'streaming', content: '耐心等待'}
    });
    assert.equal(response.status, 200);
    const lines = createInterface({input: Readable.fromWeb(response.body)})[Symbol.asyncIterator]();
    assert.deepEqual(JSON.parse((await lines.next()).value), {type: 'start', turnId: 'streaming', seq: 1});
    assert.deepEqual(JSON.parse((await lines.next()).value), {
        type: 'delta', turnId: 'streaming', seq: 2, content: '已经生成的内容'
    });
    assert.equal((await request(`/${session.id}`, {method: 'DELETE'})).status, 409);
    const stop = turnId => request(`${path}/stop`, {method: 'POST', body: {turnId}});
    assert.equal((await stop('other-turn')).ok, true);
    assert.equal(cancelled, false);
    assert.equal((await stop('streaming')).ok, true);
    const result = JSON.parse((await lines.next()).value);
    assert.equal(result.type, 'result');
    assert.equal(result.turnId, 'streaming');
    assert.equal(result.seq, 3);
    assert.equal(result.session.title, '耐心等待');
    assert.deepEqual(result.session.messages.map(({content, status}) => [content, status]), [
        ['耐心等待', undefined], ['已经生成的内容', 'stopped']
    ]);
    assert.equal((await lines.next()).done, true);
    assert.equal(cancelled, true);
    assert.deepEqual((await request(`/${session.id}`)).session, result.session);

    const waiting = await request(path, {
        method: 'POST',
        stream: true,
        body: {turnId: 'waiting', content: '尚未输出'}
    });
    const waitingLines = createInterface({input: Readable.fromWeb(waiting.body)})[Symbol.asyncIterator]();
    assert.deepEqual(JSON.parse((await waitingLines.next()).value), {type: 'start', turnId: 'waiting', seq: 1});
    assert.equal((await stop('waiting')).ok, true);
    const earlyStop = JSON.parse((await waitingLines.next()).value);
    assert.equal(earlyStop.session.messages.at(-1).content, '');
    assert.equal(earlyStop.session.messages.at(-1).status, 'stopped');
    assert.equal((await waitingLines.next()).done, true);

    const followup = await request(path, {method: 'POST', body: {turnId: 'next', content: '后续追问'}});
    assert.deepEqual(followup.session.messages.map(message => message.content), [
        '耐心等待', '已经生成的内容', '尚未输出', '', '后续追问', '新回答'
    ]);
});

test('模型失败可以保留同一请求重试，超大消息不会发给模型', async t => {
    let calls = 0;
    const request = await api(t, async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('超时'), {code: 'AI_TIMEOUT'});
        return {content: '重试成功'};
    });
    const {session} = await request('', {method: 'POST'});
    const post = content => request(`/${session.id}/messages`, {
        method: 'POST', body: {turnId: 'retry-turn', content}
    });
    assert.equal((await post('占'.repeat(12_000))).status, 413);
    assert.equal(calls, 0);
    assert.equal((await post('等待回复')).status, 504);
    assert.deepEqual((await request(`/${session.id}`)).session.messages, []);
    assert.equal((await post('等待回复')).session.messages.length, 2);
    assert.equal(calls, 2);
});

test('历史消息编辑和重新生成只使用目标之前的上下文，各版本保留原有后续消息', async t => {
    const contexts = [];
    const request = await api(t, async messages => {
        contexts.push(messages.map(message => message.content));
        if (messages.at(-1).content === '模型失败') throw new Error('模型失败');
        return {content: `回答 ${contexts.length}`};
    });
    const {session} = await request('', {method: 'POST'});
    const path = `/${session.id}/messages`;
    const send = body => request(path, {method: 'POST', body});
    const select = messageId => request(`${path}/select`, {method: 'POST', body: {messageId}});
    const {session: first} = await send({turnId: 'first', content: '原问题'});
    const originalReply = first.messages[1].id;
    await send({turnId: 'followup', content: '原追问'});

    const regenerate = {turnId: 'regen', regenerateMessageId: originalReply};
    const {session: regenerated} = await send(regenerate);
    assert.deepEqual(regenerated.messages.map(message => message.content), ['原问题', '回答 3']);
    assert.deepEqual(regenerated.messages[1].versions, {current: 2, total: 2, previousId: originalReply});
    assert.deepEqual((await send(regenerate)).session, regenerated);
    assert.equal((await send({...regenerate, turnId: 'stale'})).status, 409);

    const {session: original} = await select(originalReply);
    assert.deepEqual(original.messages.map(message => message.content), ['原问题', '回答 1', '原追问', '回答 2']);
    const {status} = await send({turnId: 'failed-edit', editMessageId: 'first', content: '模型失败'});
    assert.equal(status, 502);
    assert.deepEqual((await request(`/${session.id}`)).session, original);

    const {session: edited} = await send({turnId: 'edit', editMessageId: 'first', content: '新问题'});
    assert.deepEqual(edited.messages.map(message => message.content), ['新问题', '回答 5']);
    assert.deepEqual(edited.messages[0].versions, {current: 2, total: 2, previousId: 'first'});
    assert.equal((await select(originalReply)).status, 409);
    const {session: restored} = await select('first');
    assert.deepEqual(restored.messages.map(message => message.content), original.messages.map(message => message.content));
    assert.equal(restored.messages[0].versions.nextId, 'edit');
    assert.equal(restored.messages[1].versions.nextId, 'regen');
    assert.deepEqual(contexts, [
        ['原问题'], ['原问题', '回答 1', '原追问'], ['原问题'], ['模型失败'], ['新问题']
    ]);
});
