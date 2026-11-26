import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {createApiServer} from '../src/app.mjs';
import {openStore} from '../src/repositories/mongoStore.mjs';
import {configuredOrigin} from '../src/routes/auth.mjs';
import {fixtureAccounts, signedHeaders} from './sessionFixture.mjs';

async function serve(t, store) {
    const server = createApiServer(store, {origin: () => base});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise(resolve => server.close(resolve)));
    const send = (path, method = 'GET', body, headers) => fetch(`${base}/api/${path}`, {
        method, headers: {'Content-Type': 'application/json', Origin: base, ...headers}, body: JSON.stringify(body)
    });
    return {base, send};
}

async function database(t) {
    const dbName = `oa_test_auth_http_${randomUUID().replaceAll('-', '')}`;
    const uri = `mongodb://127.0.0.1:27018/${dbName}?retryWrites=false`;
    const client = new MongoClient(uri);
    const db = client.db(dbName);
    const store = await openStore(uri);
    t.after(async () => {
        await store.close();
        try {
            await db.dropDatabase();
        } finally {
            await client.close();
        }
    });
    await store.initialize();
    return store;
}

test('匿名不可读写，所有业务写入口均检查来源和绑定到会话的 CSRF', async t => {
    const store = await database(t);
    const {base, send} = await serve(t, {...store, auth: fixtureAccounts()});
    const sessions = 'zeroai/v2/sessions';
    for (const path of ['state', 'daily-reports', 'session', `${sessions}?actorId=member-a`]) {
        assert.equal((await send(path)).status, 401, path);
    }
    // 即使格式正确，未由账号仓储签发的值也不是有效会话。
    const forged = {Cookie: `__Host-oa_sid=${'a'.repeat(64)}`};
    assert.equal((await send('state', 'GET', undefined, forged)).status, 401);
    const a = await signedHeaders(base), b = await signedHeaders(base, 'member-b');
    const created = await send(sessions, 'POST', {}, a);
    assert.equal(created.status, 201);
    const {session} = await created.json();
    const detail = `${sessions}/${session.id}`;
    for (const [path, method] of [['state', 'PUT'], ['ai-reminders', 'POST'], ['client-log', 'POST'],
        ['password/change', 'POST'], ['logout', 'POST'], [sessions, 'POST'], [detail, 'PATCH'], [detail, 'DELETE']]) {
        assert.equal((await send(path, method, {}, {Cookie: a.Cookie})).status, 403, path);
        assert.equal((await send(path, method, {}, {...a, 'X-OA-CSRF': b['X-OA-CSRF']})).status, 403, path);
        assert.equal((await send(path, method, {}, {...a, Origin: 'https://untrusted.invalid'})).status, 403, path);
    }
    assert.equal((await send('state', 'GET', undefined, {...b, 'X-OA-CSRF': a['X-OA-CSRF']})).status, 401);
    assert.equal((await send(sessions, 'GET', undefined, a)).status, 200);
    assert.equal((await send(`${sessions}?actorId=member-b`, 'GET', undefined, a)).status, 404);
    assert.equal((await send('state', 'PUT', {actorId: 'member-b', changes: []}, a)).status, 403);
    for (const change of [{key: 'users', id: 'member-a'}, {key: 'auditLog', before: {}, after: null}]) {
        assert.equal((await send('state', 'PUT', {changes: [change]}, a)).status, 403);
    }
    const boot = await send('csrf');
    assert.equal(boot.headers.get('access-control-allow-origin'), null);
    assert.match(boot.headers.get('set-cookie'), /HttpOnly; Secure;/);
    assert.match(boot.headers.get('cache-control'), /no-store/);
    const csrfToken = (await boot.json()).csrfToken;
    const preHeaders = {Cookie: boot.headers.getSetCookie()[0].split(';')[0], 'X-OA-CSRF': csrfToken};
    // 登录前的安全凭证不能代替账号会话。
    assert.equal((await send('state', 'GET', undefined, preHeaders)).status, 401);
    assert.equal((await send('login', 'POST', {name: '不自动开户'}, preHeaders)).status, 400);
    assert.equal((await send('login', 'POST', {}, {...preHeaders, Origin: 'null'})).status, 403);
    assert.equal((await send('login', 'POST', {
        loginName: 'member-a',
        password: '错误'
    }, {Cookie: preHeaders.Cookie})).status, 403);
    let last;
    for (let i = 0; i < 13; i++) last = await send('login', 'POST', {
        loginName: '失败限速夹具',
        password: '错误'
    }, preHeaders);
    assert.equal(last.status, 429);
    assert.ok(last.headers.has('retry-after'));
    assert.throws(() => configuredOrigin('http://example.invalid'));
});

test('A 的慢查询在退出后才完成：拒绝旧响应，B 的新会话仍可用', {timeout: 5000}, async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const {base, send} = await serve(t, {
        auth: fixtureAccounts(),
        async read() {
            started.resolve();
            await release.promise;
            return {version: 7};
        }
    });
    const a = await signedHeaders(base);
    const pending = send('state', 'GET', undefined, a);
    try {
        await started.promise;
        assert.equal((await send('logout', 'POST', {}, a)).status, 200);
        const b = await signedHeaders(base, 'member-b');
        assert.equal((await (await send('session', 'GET', undefined, b)).json()).user.id, 'member-b');
        release.resolve();
        const late = await pending;
        assert.equal(late.status, 401);
        assert.ok(!Object.hasOwn(await late.json(), 'state'));
        const fresh = await send('state', 'GET', undefined, b);
        assert.equal(fresh.status, 200);
        assert.equal((await fresh.json()).state.version, 7);
    } finally {
        release.resolve();
    }
});

test('现有成员激活、限制会话、密码轮换、退出和停用贯通真实 HTTP/Mongo', async t => {
    const store = await database(t);
    const user = {id: 'u-existing', name: '历史成员', color: '#069', createdAt: '2026-11-01'};
    await store.patch(1, [{key: 'users', id: user.id, before: null, after: user}]);
    const temp = await store.auth.provision(user.id, '已有成员');
    const {base, send} = await serve(t, store);
    const restricted = await signedHeaders(base, '已有成员', temp);
    const info = await (await send('session', 'GET', undefined, restricted)).json();
    assert.equal(info.mustChangePassword, true);
    assert.equal(info.user.id, user.id);
    assert.equal(info.state, undefined);
    const blocked = await send('state', 'GET', undefined, restricted);
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, 'PASSWORD_CHANGE_REQUIRED');
    const password = '仅测试使用的普通密码-1234';
    assert.equal((await send('password/change', 'POST', {
        currentPassword: temp,
        newPassword: password
    }, restricted)).status, 200);
    assert.equal((await send('session', 'GET', undefined, restricted)).status, 401);
    const first = await signedHeaders(base, '已有成员', password),
        second = await signedHeaders(base, '已有成员', password);
    const state = await (await send('state', 'GET', undefined, first)).json();
    assert.deepEqual(state.state.users, [user]);
    assert.equal(state.state.version, 2);
    assert.ok(!JSON.stringify(state).includes('password'));
    const out = await send('logout', 'POST', {}, first);
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await send('state', 'GET', undefined, first)).status, 401);
    assert.equal((await send('state', 'GET', undefined, second)).status, 200);
    await store.auth.disable(user.id);
    assert.equal((await send('state', 'GET', undefined, second)).status, 401);
});
