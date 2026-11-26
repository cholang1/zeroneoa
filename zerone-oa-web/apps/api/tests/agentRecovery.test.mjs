import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {MongoClient} from 'mongodb';
import {openStore, StateError} from '../src/repositories/mongoStore.mjs';
import {createZeroAiV2Handler} from '../src/routes/zeroAiV2.mjs';

const verify = async () => {
};

async function fixture(t) {
    const name = `oa_test_agent_recovery_${randomUUID().replaceAll('-', '')}`;
    const uri = `mongodb://127.0.0.1:27018/${name}?retryWrites=false`;
    const client = new MongoClient(uri), db = client.db(name);
    let store;
    t.after(async () => {
        try {
            await store?.close();
            await db.dropDatabase();
        } finally {
            await client.close();
        }
    });

    async function restart() {
        if (store) await store.close();
        store = await openStore(uri);
        await store.initialize();
        return store;
    }

    return {db, restart, store: await restart()};
}

test('回复计划已发布但未提交：重启保留真实活动时间，不再次调用模型或复制节点', async t => {
    const {db, store, restart} = await fixture(t);
    const sessions = db.collection('agent_sessions');
    let a = store.agent;
    const {id} = await a.create('a', verify);
    const req = {turnId: 'first', content: '合成问题'};
    await a.begin('a', id, req, new AbortController(), verify);
    // 只在一次性随机库阻止更新活动边：两条节点插入成功后，最后一步尚未完成。
    await db.command({collMod: 'agent_messages', validator: {activeChildId: null}});
    await assert.rejects(a.end('a', id, 'first', '合成回答', {verify}), {status: 503});
    assert.equal(await db.collection('agent_messages').countDocuments({sessionId: id}), 2);
    const pending = (await sessions.findOne({_id: id})).pendingMutation;
    assert.ok(pending);
    // 提交前的旧时间已过期，计划中已发布的用户活动较新，应先重放再检查过期。
    await sessions.updateOne({_id: id}, {$set: {updatedAt: new Date(0)}});
    await db.command({collMod: 'agent_messages', validator: {}});
    a = (await restart()).agent;
    const recovered = await a.read('a', id);
    assert.deepEqual(recovered.messages.map(m => m.content), ['合成问题', '合成回答']);
    assert.deepEqual(await a.begin('a', id, req, new AbortController(), verify), {session: recovered});
    assert.equal(await db.collection('agent_messages').countDocuments({sessionId: id}), 2);
    const persisted = await sessions.findOne({_id: id});
    assert.equal(persisted.pendingMutation, undefined);
    assert.deepEqual(persisted.updatedAt, pending.fields.updatedAt);
});

test('进程丢失活跃轮：只补完未过期的检查点且不刷新活动时间', async t => {
    const {db, store, restart} = await fixture(t);
    const a = store.agent, first = await a.create('a', verify), second = await a.create('a', verify);
    const old = await a.create('a', verify), sessions = db.collection('agent_sessions');
    await a.begin('a', first.id, {turnId: 'partial', content: '合成问一'}, new AbortController(), verify);
    await a.checkpoint(first.id, 'partial', '已经展示', verify);
    await a.begin('a', second.id, {turnId: 'stopped', content: '合成问二'}, new AbortController(), verify);
    await a.stop('a', second.id, 'stopped', verify);
    await a.begin('a', old.id, {turnId: 'expired', content: '过期问题'}, new AbortController(), verify);
    await a.checkpoint(old.id, 'expired', '过期检查点', verify);
    const before = new Date(Date.now() - 3600_000);
    await sessions.updateMany({_id: {$in: [first.id, second.id]}}, {$set: {updatedAt: before}});
    await sessions.updateOne({_id: old.id}, {$set: {updatedAt: new Date(0)}});
    // 过期轮次无需补写消息；即使旧轮次无法再落盘，也不应卡住重启。
    await db.command({collMod: 'agent_messages', validator: {sessionId: {$ne: old.id}}});
    const next = (await restart()).agent;
    const partial = (await next.read('a', first.id)).messages.at(-1);
    assert.equal(partial.status, 'interrupted');
    assert.equal(partial.content, '已经展示');
    const stopped = (await next.read('a', second.id)).messages.at(-1);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.content, '');
    for (const id of [first.id, second.id]) assert.deepEqual((await sessions.findOne({_id: id})).updatedAt, before);
    await assert.rejects(next.read('a', old.id), {status: 404});
    assert.equal((await next.list('a')).sessions.some(s => s.id === old.id), false);
    assert.equal(await sessions.countDocuments({_id: old.id}), 0);
    for (const name of ['agent_turns', 'agent_messages']) assert.equal(await db.collection(name).countDocuments({sessionId: old.id}), 0);
});

for (const revokedInQueue of [true, false]) {
    test(revokedInQueue ? '结束排队期间撤权，只保存已经落盘的检查点' : '发布前验证期间断开，不能把迟到回复写成成功', {timeout: 15_000}, async t => {
        const {db, store} = await fixture(t);
        const a = store.agent, {id} = await a.create('a', verify), blocker = await a.create('a', verify);
        const modelStarted = Promise.withResolvers(), finishModel = Promise.withResolvers();
        const queueHeld = Promise.withResolvers(), releaseQueue = Promise.withResolvers();
        const endQueued = Promise.withResolvers(), verifying = Promise.withResolvers(),
            releaseVerify = Promise.withResolvers();
        let revoked = false, finalizing = false;
        const route = createZeroAiV2Handler({
            ...a, end(...args) {
                finalizing = true;
                endQueued.resolve();
                return a.end(...args);
            }
        }, async () => {
            modelStarted.resolve();
            await finishModel.promise;
            return {content: '迟到的完整回复'};
        });
        const request = Readable.from([JSON.stringify({turnId: 'blocked', content: '合成问题'})]);
        Object.assign(request, {method: 'POST', headers: {}});
        const response = Object.assign(new EventEmitter(), {
            setHeader() {
            }, destroyed: false, headersSent: false,
            end() {
                assert.fail('已撤权或断开的请求不应收到响应');
            }
        });
        const outcome = route(request, response, new URL(`http://localhost/api/zeroai/v2/sessions/${id}/messages`), {
            user: {id: 'a'}, async verify() {
                if (revoked) throw new StateError(401, '测试会话已撤权');
                if (finalizing && !revokedInQueue) {
                    verifying.resolve();
                    await releaseVerify.promise;
                }
            }
        }).then(() => null, error => error);

        t.signal.addEventListener('abort', () => {
            finishModel.resolve();
            releaseQueue.resolve();
            releaseVerify.resolve();
        }, {once: true});
        const waitFor = (point, message) => Promise.race([point.promise, outcome.then(error => assert.fail(`${message}：${error}`))]);
        try {
            await waitFor(modelStarted, '未进入模型');
            await a.checkpoint(id, 'blocked', '已落盘内容', verify);
            const hold = a.rename('a', blocker.id, '占用串行队列', async () => {
                queueHeld.resolve();
                await releaseQueue.promise;
                if (revokedInQueue) revoked = true;
            });
            await queueHeld.promise;
            finishModel.resolve();
            await waitFor(endQueued, '最终回复未排队');
            releaseQueue.resolve();
            await hold;
            if (!revokedInQueue) {
                await waitFor(verifying, '最终回复未在队列内复核');
                response.destroyed = true;
                response.emit('close');
                releaseVerify.resolve();
            }
            const error = await outcome;
            if (revokedInQueue) assert.equal(error?.status, 401);
            else assert.equal(error, null);

            // 直接核对落库状态，避免 read() 的自行恢复掩盖没有释放的活跃轮。
            assert.equal((await db.collection('agent_sessions').findOne({_id: id})).activeTurnId, null);
            const messages = (await a.read('a', id)).messages;
            assert.deepEqual(messages.map(({content, status}) => [content, status]), [
                ['合成问题', undefined], ['已落盘内容', 'interrupted']
            ]);
            assert.equal(await db.collection('agent_messages').countDocuments({
                sessionId: id,
                content: '迟到的完整回复'
            }), 0);
            assert.ok((await a.begin('a', id, {
                turnId: 'next',
                content: '后续问题'
            }, new AbortController(), verify)).context);
        } finally {
            finishModel.resolve();
            releaseQueue.resolve();
            releaseVerify.resolve();
            await outcome;
        }
    });
}

test('流式结束前撤权时，未发布的最终回复不能成为检查点', async t => {
    const {store} = await fixture(t), a = store.agent, {id} = await a.create('a', verify);
    let revoked = false;
    const route = createZeroAiV2Handler({
        ...a, end(...args) {
            revoked = true;
            return a.end(...args);
        }
    }, async () => {
        await a.checkpoint(id, 'stream', '已落盘内容', verify);
        return {content: '已落盘内容加上未发布的尾块'};
    });
    const request = Object.assign(Readable.from([JSON.stringify({turnId: 'stream', content: '合成问题'})]), {
        method: 'POST', headers: {accept: 'application/x-ndjson'}
    });
    const frames = [];
    const response = Object.assign(new EventEmitter(), {
        setHeader() {
        }, destroyed: false, headersSent: false,
        writeHead() {
            this.headersSent = true;
        },
        write(line) {
            frames.push(JSON.parse(line));
        },
        end() {
            assert.fail('已撤权的请求不应收到最终事件');
        }
    });
    await assert.rejects(route(request, response, new URL(`http://localhost/api/zeroai/v2/sessions/${id}/messages`), {
        user: {id: 'a'}, async verify() {
            if (revoked) throw new StateError(401, '测试会话已撤权');
        }
    }), {status: 401});
    assert.deepEqual(frames.map(({type}) => type), ['start']);
    assert.deepEqual((await a.read('a', id)).messages.map(({content, status}) => [content, status]), [
        ['合成问题', undefined], ['已落盘内容', 'interrupted']
    ]);
});

test('定时清理先重试仍在留存期内的删除标记，再处理到期会话', async t => {
    const {db, store} = await fixture(t);
    const a = store.agent, {id} = await a.create('a', verify), old = await a.create('a', verify);
    await a.begin('a', id, {turnId: 'deleted', content: '要删除的问题'}, new AbortController(), verify);
    await a.end('a', id, 'deleted', '要删除的回答', {verify});
    const sessions = db.collection('agent_sessions');
    // 模拟手工删除在写下标记后中断，updatedAt 依然未过期。
    await sessions.updateOne({_id: id}, {$set: {deletedAt: new Date()}});
    await sessions.updateOne({_id: old.id}, {$set: {updatedAt: new Date(0)}});
    await assert.rejects(a.read('a', id), {status: 404});
    await db.command({collMod: 'agent_sessions', validator: {deletedAt: {$exists: false}}});
    // 模拟本次到期删除失败：先前的删除标记及其私人数据应已清掉。
    await assert.rejects(a.prune(), {status: 503});
    assert.equal(await sessions.countDocuments({_id: id}), 0);
    for (const name of ['agent_turns', 'agent_messages']) assert.equal(await db.collection(name).countDocuments({sessionId: id}), 0);
    await db.command({collMod: 'agent_sessions', validator: {}});
    await a.prune();
    assert.equal(await sessions.countDocuments({_id: old.id}), 0);
});

test('恢复点缺一个私有集合时不伪报空历史，补齐后能读回原会话', async t => {
    const {db, store, restart} = await fixture(t);
    const {id} = await store.agent.create('a', verify);
    await store.agent.begin('a', id, {turnId: 'kept', content: '合成问题'}, new AbortController(), verify);
    await store.agent.end('a', id, 'kept', '原回答', {verify});
    const snapshot = await store.agent.read('a', id);
    await db.collection('agent_messages').rename('fixture_messages');
    const incomplete = await restart();
    await assert.rejects(incomplete.agent.read('a', id), {status: 503});
    assert.equal(await db.listCollections({name: 'agent_messages'}).hasNext(), false);
    await db.collection('fixture_messages').rename('agent_messages');
    const repaired = await restart();
    assert.deepEqual(await repaired.agent.read('a', id), snapshot);
});

test('到期立即不可见，清理只删私人历史；未来格式拒绝 v2 但手工 OA 不停', async t => {
    const {db, store, restart} = await fixture(t);
    const a = store.agent, {id} = await a.create('a', verify), keep = await a.create('b', verify);
    await a.begin('a', id, {turnId: 'old', content: '合成数据'}, new AbortController(), verify);
    await a.end('a', id, 'old', '合成回答', {verify});
    const before = await store.read();
    await db.collection('agent_sessions').updateOne({_id: id}, {$set: {updatedAt: new Date(0)}});
    await assert.rejects(a.read('a', id), {status: 404});
    await a.prune();
    for (const name of ['agent_turns', 'agent_messages']) assert.equal(await db.collection(name).countDocuments({sessionId: id}), 0);
    assert.equal(await db.collection('agent_sessions').countDocuments({_id: id}), 0);
    assert.equal((await a.read('b', keep.id)).id, keep.id);
    assert.deepEqual(await store.read(), before);
    await db.collection('team_meta').updateOne({_id: 'default'}, {$set: {agentSchemaVersion: 99}});
    const next = await restart();
    assert.throws(() => next.agent.check(), {status: 503});
    await assert.rejects(next.agent.read('b', keep.id), {status: 503});
    assert.deepEqual(await next.read(), before);
    assert.equal((await db.collection('team_meta').findOne({_id: 'default'})).agentSchemaVersion, 99);
});
