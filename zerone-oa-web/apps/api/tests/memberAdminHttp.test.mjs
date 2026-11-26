import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {MongoClient} from 'mongodb';
import {createApiServer} from '../src/app.mjs';
import {openStore} from '../src/repositories/mongoStore.mjs';
import {fixtureAccounts, signedHeaders} from './sessionFixture.mjs';

async function start(t, store, options = {}) {
    const server = createApiServer(store, {origin: () => base, setupKey: '', ...options});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    const get = (path, headers) => fetch(base + '/api/' + path, {headers});
    const post = (path, headers, body) => fetch(base + '/api/' + path, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Origin: base, ...headers}, body: JSON.stringify(body)
    });

    async function preauth() {
        const response = await get('csrf');
        return {
            Cookie: response.headers.getSetCookie()[0].split(';')[0],
            'X-OA-CSRF': (await response.json()).csrfToken
        };
    }

    return {base, get, post, preauth};
}

test('首次注册显式启用；不接受额外角色字段、错误部署凭证或缺少 CSRF 的写入', async t => {
    const setupKey = randomUUID();
    let registrations = 0;
    const auth = {
        ...fixtureAccounts(), setupAvailable: async () => true, setupFirstAdmin: async () => {
            registrations++;
        }
    };
    const payload = {setupKey, name: '首任测试', loginName: 'tester', password: '仅供本机测试使用的密码'};
    const off = await start(t, {auth});
    assert.deepEqual(await (await off.get('setup/status')).json(), {available: false});
    assert.equal((await off.post('setup/register', await off.preauth(), payload)).status, 404);
    assert.throws(() => createApiServer({auth}, {setupKey: 'too-short'}), /OA_SETUP_KEY/);
    const {base, get, post, preauth} = await start(t, {auth}, {setupKey});
    const signed = await signedHeaders(base);
    const headers = await preauth();
    assert.equal((await post('setup/register', {
        ...headers,
        Cookie: `${signed.Cookie}; ${headers.Cookie}`
    }, payload)).status, 409);
    assert.deepEqual(await (await get('setup/status')).json(), {available: true});
    for (const [h, body, expected] of [
        [{Cookie: headers.Cookie}, payload, 403], [{...headers, Origin: 'https://other.invalid'}, payload, 403],
        [headers, {...payload, setupKey: '错误的初始化凭证'}, 403], [headers, {...payload, memberId: '伪造'}, 400]
    ]) assert.equal((await post('setup/register', h, body)).status, expected);
    assert.equal(registrations, 0);
    const result = await post('setup/register', headers, payload);
    assert.equal(result.status, 201);
    assert.deepEqual(await result.json(), {ok: true});
    assert.doesNotMatch(result.headers.get('set-cookie') ?? '', /__Host-oa_sid/);
    assert.equal(registrations, 1);
});

test('成员管理接口只对管理员开放，业务数据不接受权限字段作为授权，命令响应不泄露后台文档', async t => {
    const auth = fixtureAccounts();
    const session = auth.session.bind(auth);
    auth.session = async token => {
        const current = await session(token);
        return {...current, isAccountAdmin: current.user.id === 'member-a'};
    };
    let writes = 0;
    auth.adminList = async () => [{
        id: 'u',
        name: '成员',
        status: 'active',
        loginName: 'user',
        credentials: '后台测试标记'
    }];
    auth.adminCommand = async () => {
        writes++;
        return {memberId: 'u', initialPassword: '测试一次性口令', credentials: '后台测试标记'};
    };
    const {base, get, post} = await start(t, {auth});
    const admin = await signedHeaders(base), member = await signedHeaders(base, 'member-b');
    const path = 'admin/members';
    assert.equal((await get(path)).status, 401);
    assert.equal((await get(path, member)).status, 403);
    assert.equal((await post(path + '/provision', member, {
        memberId: 'u',
        loginName: 'user',
        isAccountAdmin: true
    })).status, 403);
    const list = await get(path, admin);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), {
        members: [{
            id: 'u',
            name: '成员',
            status: 'active',
            loginName: 'user',
            isAccountAdmin: false
        }]
    });
    assert.equal((await post(path + '/reset', {...admin, Origin: 'https://other.invalid'}, {})).status, 403);
    assert.equal((await post(path + '/reset', {Cookie: admin.Cookie}, {})).status, 403);
    assert.equal((await post(path + '/reset', admin, {
        memberId: 'u',
        currentPassword: '本人密码',
        actorId: '伪造'
    })).status, 400);
    assert.equal((await post(path + '/grant', admin, {})).status, 404);
    assert.equal(writes, 0);
    const result = await post(path + '/provision', admin, {memberId: 'u', loginName: 'user'});
    assert.equal(result.status, 201);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await result.json(), {memberId: 'u', initialPassword: '测试一次性口令'});
    assert.equal(writes, 1);
});

test('旧库首任绑定：离线命令按原成员 ID 核对测试成员丙，旧 Cookie 不自动获得管理权', async t => {
    const database = 'oa_test_admin_cli_' + randomUUID().replaceAll('-', '');
    const uri = `mongodb://127.0.0.1:27018/${database}?retryWrites=false`;
    const client = new MongoClient(uri), store = await openStore(uri);
    let reopened;
    t.after(async () => {
        await (reopened ?? store).close();
        try {
            await client.db(database).dropDatabase();
        } finally {
            await client.close();
        }
    });
    await store.initialize();
    const original = await store.auth.createMember('测试成员丙', 'existing-admin');
    const oldLogin = await store.auth.login('existing-admin', original.initialPassword);
    const personal = '离线交接测试使用的个人密码';
    await store.auth.changePassword(oldLogin.token, original.initialPassword, personal);
    const old = await store.auth.login('existing-admin', personal);
    const other = await store.auth.createMember('原有同事', 'other');
    const before = await store.read();
    await store.close();
    const bind = id => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli/auth.mjs', import.meta.url)),
        '--db', database, 'bind-first-admin', '--member-id', id, '--name', '测试成员丙'], {
        env: {
            ...process.env,
            MONGODB_URI: uri
        }
    });
    await assert.rejects(bind(other.memberId));
    await bind(original.memberId);
    reopened = await openStore(uri);
    await reopened.initialize();
    assert.deepEqual(await reopened.read(), before);
    await assert.rejects(reopened.auth.adminList(old.token));
    const {base, get} = await start(t, reopened);
    const headers = await signedHeaders(base, 'existing-admin', personal);
    assert.equal((await (await get('session', headers)).json()).isAccountAdmin, true);
    assert.equal((await get('admin/members', headers)).status, 200);
});

test('真实 HTTP/Mongo：在线重置终止目标正在生成的聊天，管理员会话和服务不需重启', {timeout: 45000}, async t => {
    const name = 'oa_test_admin_http_' + randomUUID().replaceAll('-', '');
    const uri = `mongodb://127.0.0.1:27018/${name}?retryWrites=false`;
    const client = new MongoClient(uri), store = await openStore(uri);
    t.after(async () => {
        await store.close();
        try {
            await client.db(name).dropDatabase();
        } finally {
            await client.close();
        }
    });
    await store.initialize();
    const setupKey = randomUUID(), password = '网页管理验收使用的合成密码A';
    const started = Promise.withResolvers(), cancelled = Promise.withResolvers();
    const {base, get, post, preauth} = await start(t, store, {
        setupKey, completeAi: async (_context, {onDelta, signal}) => {
            onDelta('开始');
            started.resolve();
            await once(signal, 'abort');
            cancelled.resolve();
            signal.throwIfAborted();
        }
    });
    assert.equal((await post('setup/register', await preauth(), {
        name: '初始管理员',
        loginName: 'first',
        password,
        setupKey
    })).status, 201);
    assert.deepEqual(await (await get('setup/status')).json(), {available: false});
    const admin = await signedHeaders(base, 'first', password);
    assert.equal((await (await get('session', admin)).json()).isAccountAdmin, true);
    const created = await post('admin/members/create', admin, {name: '测试同事', loginName: 'second'});
    assert.equal(created.status, 201);
    const {memberId, initialPassword} = await created.json();
    const restricted = await signedHeaders(base, 'second', initialPassword);
    assert.equal((await get('admin/members', restricted)).status, 403);
    const personal = '受管理成员使用的合成密码B';
    assert.equal((await post('password/change', restricted, {
        currentPassword: initialPassword,
        newPassword: personal
    })).status, 200);
    const member = await signedHeaders(base, 'second', personal);
    const sessions = 'zeroai/v2/sessions';
    const chat = await post(sessions, member, {});
    assert.equal(chat.status, 201);
    const {session} = await chat.json();
    const stream = await post(`${sessions}/${session.id}/messages`, {...member, Accept: 'application/x-ndjson'}, {
        turnId: 'turn1', content: '测试撤销'
    });
    assert.equal(stream.status, 200);
    await started.promise;
    const reset = await post('admin/members/reset', admin, {memberId, currentPassword: password});
    assert.equal(reset.status, 200);
    await cancelled.promise;
    assert.equal((await get('state', member)).status, 401);
    assert.equal((await get('state', admin)).status, 200);
    assert.equal((await (await get('admin/members', admin)).json()).members.find(m => m.id === memberId).status, 'initial');
});
