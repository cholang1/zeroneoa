import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {MongoClient} from 'mongodb';
import {createApiServer} from '../src/app.mjs';
import {openStore} from '../src/repositories/mongoStore.mjs';
import {signedHeaders} from './sessionFixture.mjs';

test('留存配置无效只封闭聊天：仍能登录和保存业务，修正后读回原对话', async t => {
    const name = `oa_test_history_config_${randomUUID().replaceAll('-', '')}`;
    const uri = `mongodb://127.0.0.1:27018/${name}?retryWrites=false`;
    const client = new MongoClient(uri), db = client.db(name);
    const user = {id: 'p1-member', name: '留存测试成员', color: '#069'};
    const password = `test-${randomUUID()}`;
    const chats = '/api/zeroai/v2/sessions';
    let store, server, base, calls = 0;

    async function close() {
        if (server?.listening) await new Promise(resolve => {
            server.close(resolve);
            server.closeAllConnections();
        });
        if (store) {
            await store.close();
            store = null;
        }
    }

    t.after(async () => {
        try {
            await close();
            await db.dropDatabase();
        } finally {
            await client.close();
        }
    });

    async function boot(historyRetentionDays) {
        await close();
        store = await openStore(uri, {historyRetentionDays});
        await store.initialize();
        server = createApiServer(store, {
            origin: () => base, setupKey: '', completeAi: async () => {
                calls++;
                return {content: '原回答'};
            }
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        base = `http://127.0.0.1:${server.address().port}`;
    }

    async function login() {
        const headers = await signedHeaders(base, user.name, password);
        return async (url, method = 'GET', body) => {
            const res = await fetch(`${base}${url}`, {
                method,
                headers: {...headers, 'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });
            return {status: res.status, body: await res.json()};
        };
    }

    await boot(90);
    await store.patch(1, [{key: 'users', id: user.id, before: null, after: user}]);
    const initial = await store.auth.provision(user.id, user.name);
    const {token} = await store.auth.login(user.name, initial);
    await store.auth.changePassword(token, initial, password);
    let request = await login();
    const created = await request(chats, 'POST', {});
    assert.equal(created.status, 201);
    const id = created.body.session.id;
    const path = `${chats}/${id}`;
    const original = await request(`${path}/messages`, 'POST', {turnId: 'original', content: '原问题'});
    assert.equal(original.status, 200);
    // 空环境值会转成 0；非数值字符串会转成 NaN。两者都不许抛弃历史或阻断 OA。
    for (const [i, invalid] of [0, NaN].entries()) {
        await boot(invalid);
        request = await login();
        const get = await request('/api/state');
        assert.equal(get.status, 200);
        const report = {
            id: `report-${i}`,
            ownerId: user.id,
            taskId: 'fixture-task',
            date: '2026-11-22',
            weekId: '2026-W47',
            hours: 1,
            detail: '手工日报'
        };
        const saved = await request('/api/state', 'PUT', {
            baseVersion: get.body.state.version,
            changes: [{key: 'dailyReports', id: report.id, before: null, after: report}]
        });
        assert.equal(saved.status, 200);
        assert.ok(saved.body.state.dailyReports.some(row => row.id === report.id));
        for (const [endpoint, method, body] of [['/api/zeroai/v2/capabilities'], [path], [chats, 'POST', {}],
            [`${path}/messages`, 'POST', {turnId: 'refused', content: '不能发送'}]]) {
            assert.equal((await request(endpoint, method, body)).status, 503, endpoint);
        }
        assert.equal(calls, 1);
        assert.equal(await db.collection('agent_messages').countDocuments({sessionId: id}), 2);
    }
    await boot(90);
    request = await login();
    assert.deepEqual(await request(path), original);
    assert.equal((await request('/api/state')).body.state.dailyReports.length, 2);
});
