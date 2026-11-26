import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {MongoClient, MongoNetworkError} from 'mongodb';
import {createApiServer} from '../src/app.mjs';
import {openStore} from '../src/repositories/mongoStore.mjs';
import {names} from '../src/repositories/schema.mjs';

async function database(t, init = true) {
    const uri = `mongodb://127.0.0.1:27018/oa_test_${randomUUID().replaceAll('-', '')}?retryWrites=false`;
    const inspect = new MongoClient(uri), db = inspect.db();
    const store = await openStore(uri);
    t.after(async () => {
        await store.close();
        try {
            await db.dropDatabase();
        } finally {
            await inspect.close();
        }
    });
    if (init) await store.initialize();
    return {store, db, uri};
}

import {fixtureAccounts, signedHeaders} from './sessionFixture.mjs';

async function api(t, store) {
    const server = createApiServer({...store, auth: fixtureAccounts()}, {origin: () => base});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = await signedHeaders(base);
    return async (method, path, data) => {
        const response = await fetch(`${base}/api/${path}`, {
            method,
            headers: {'Content-Type': 'application/json', ...headers},
            body: JSON.stringify(data)
        });
        return {status: response.status, ...await response.json()};
    };
}

const change = (key, before, after) => ({key, id: (after ?? before).id, before, after});
const report = (id, ownerId = 'u1', date = '2026-11-19') => ({
    id,
    ownerId,
    date,
    weekId: '2026-W47',
    taskId: 'T01',
    hours: 1,
    detail: id
});

test('全新库自动建集合与索引，旧库拒绝启动且原样保留', async t => {
    const {db} = await database(t);
    const actual = (await db.listCollections().toArray()).map(c => c.name);
    for (const name of Object.values(names)) assert.ok(actual.includes(name));
    assert.ok(!actual.includes('team_states'));
    const old = await database(t, false);
    await old.db.collection('team_states').insertOne({_id: 'default', version: 7});
    await assert.rejects(old.store.initialize(), {status: 503});
    assert.deepEqual(await old.db.listCollections({}, {nameOnly: true}).toArray(), [{
        name: 'team_states',
        type: 'collection'
    }]);
    assert.equal((await old.db.collection('team_states').findOne()).version, 7);
});

test('数据库不可达时报告失败，不回退写文件', async t => {
    await assert.rejects(openStore('mongodb://127.0.0.1:1/oa_test_unreachable'));
    const request = await api(t, {
        read() {
            throw new MongoNetworkError('测试断线');
        }
    });
    assert.equal((await request('GET', 'state')).status, 503);
});

test('登录、并发差量、冲突和重试，按文档更新与删除', async t => {
    const {db, store} = await database(t);
    const request = await api(t, store);
    const user = {id: 'member-a', name: '测试成员'};
    await store.patch(1, [change('users', null, user)]);
    assert.notEqual((await request('POST', 'login', {name: '旧姓名登录'})).status, 200);
    assert.equal(await db.collection('users').countDocuments(), 1);
    const patch = (baseVersion, changes) => request('PUT', 'state', {baseVersion, changes, actorId: user.id});
    const r1 = report('r1', user.id), r2 = report('r2', user.id);
    const pair = await Promise.all([r1, r2].map(r => patch(2, [change('dailyReports', null, r)])));
    assert.ok(pair.every(v => v.status === 200));
    assert.equal(await db.collection('daily_reports').countDocuments(), 2);
    const up = change('dailyReports', r1, {...r1, hours: 2});
    assert.equal((await patch(2, [up])).status, 200);
    const retry = await patch(2, [up]);
    assert.equal(retry.state.version, 5);
    const conflict = await patch(2, [change('memos', null, {id: 'should-not-land'}), change('dailyReports', r1, {
        ...r1,
        hours: 3
    })]);
    assert.equal(conflict.status, 409);
    assert.equal(await db.collection('memos').countDocuments(), 0);
    assert.equal((await db.collection('daily_reports').findOne({_id: 'r1'})).hours, 2);
    assert.equal((await patch(5, [change('dailyReports', r2, null)])).status, 200);
    assert.equal(await db.collection('daily_reports').countDocuments({_id: 'r2'}), 0);
    assert.equal((await request('PUT', 'state', {state: retry.state, actorId: 'x'})).status, 400);
    const reminders = await request('POST', 'ai-reminders', {weekId: '2026-W47'});
    assert.equal(reminders.status, 200);
    assert.ok(await db.collection('ai_reminders').countDocuments());
});

test('成员名称唯一：允许批内释放后重新绑定，拒绝批内重复且不写半批', async t => {
    const {store, db} = await database(t);
    const old = {id: 'u1', name: '一'}, replacement = {id: 'u2', name: '一'};
    await store.patch(1, [change('users', null, old)]);
    await store.patch(2, [change('users', null, replacement), change('users', old, null)]);
    assert.equal((await db.collection('users').findOne({name: '一'}))._id, 'u2');
    await assert.rejects(store.patch(3, [change('users', null, {id: 'a', name: '二'}), change('users', null, {
        id: 'b',
        name: '二'
    })]), {status: 409});
    assert.equal(await db.collection('users').countDocuments(), 1);
    assert.equal((await store.read()).version, 3);
});

test('索引按成员和日期分页，同日多条不漏不重', async t => {
    const {db, store} = await database(t), request = await api(t, store);
    const records = [report('r1'), report('r2'), report('r3', 'u2'), report('r4', 'u1', '2026-11-18')];
    await store.patch(1, records.map(r => change('dailyReports', null, r)));
    const path = 'daily-reports?ownerId=u1&from=2026-11-19&to=2026-11-19&limit=1';
    const first = await request('GET', path), second = await request('GET', path + '&cursor=' + first.nextCursor);
    assert.deepEqual([first.items[0].id, second.items[0].id], ['r2', 'r1']);
    assert.equal(second.nextCursor, null);
    assert.equal((await request('GET', 'daily-reports?limit=101')).status, 400);
    const {queryPlanner} = await db.collection('daily_reports').find({
        ownerId: 'u1',
        date: {$gte: '2026-11-19'}
    }).sort({date: -1, _id: -1}).explain('queryPlanner');
    assert.match(JSON.stringify(queryPlanner.winningPlan), /ownerId_1_date_-1__id_-1/);
});

test('整队超过 16 MiB 可以保存，单条超限拒绝且不落半批', async t => {
    const {store, db} = await database(t), text = 'x'.repeat(9 * 1024 * 1024);
    await store.patch(1, [1, 2].map(n => change('memos', null, {id: `m${n}`, text})));
    await assert.rejects(store.patch(2, [change('tasks', null, {id: 'T01'}), change('memos', null, {
        id: 'big',
        text: text + text
    })]), {status: 413});
    assert.equal(await db.collection('memos').countDocuments(), 2);
    assert.equal(await db.collection('tasks').countDocuments(), 0);
});

test('单写入进程；重启重放已发布的部分批次，不重复业务记录', async t => {
    const {store, uri, db} = await database(t), other = await openStore(uri);
    try {
        await assert.rejects(other.initialize(), {status: 503});
    } finally {
        await other.close();
    }
    await store.close();
    const docs = ['r1', 'r2'].map((id, seq) => ({_id: id, ownerId: 'u1', _batch: 2, _seq: seq}));
    await db.collection('pending_changes').insertMany(docs.map((doc, seq) => ({
        batch: 'b',
        seq,
        key: 'dailyReports',
        id: doc._id,
        doc
    })));
    await db.collection('team_meta').updateOne({_id: 'default'}, {$set: {pending: {batch: 'b', count: 2}}});
    await db.collection('daily_reports').insertOne(docs[0]);
    const next = await openStore(uri);
    try {
        await next.initialize();
        const state = await next.read();
        assert.equal(state.version, 2);
        assert.deepEqual(state.dailyReports.map(r => r.id), ['r1', 'r2']);
        assert.equal(await db.collection('pending_changes').countDocuments(), 0);
    } finally {
        await next.close();
    }
});
