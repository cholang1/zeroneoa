import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {MongoClient} from 'mongodb';
import {openStore} from '../src/repositories/mongoStore.mjs';

const runFile = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli/auth.mjs', import.meta.url));
const sessionKey = token => createHash('sha256').update(token).digest('hex');
const dbName = () => `oa_test_${randomUUID().replaceAll('-', '')}`;
const testUri = name => `mongodb://127.0.0.1:27018/${name}?retryWrites=false`;
const change = (key, before, after) => ({key, id: (after ?? before).id, before, after});
const member = {id: 'u-existing', name: '样例成员', color: '#1746a2'};
const password = '正确的新密码和更长的短语 1';
const nextPassword = '另一条个人密码，长度合格 2';
const loginName = '样例成员Ａ';
const wrongLogin = {status: 401, message: '登录名或密码错误'};

async function database(t, initialize = true, options) {
    const name = dbName(), uri = testUri(name);
    const inspect = new MongoClient(uri), db = inspect.db();
    const store = await openStore(uri, options);
    t.after(async () => {
        try {
            await store.close();
            await db.dropDatabase();
        } finally {
            await inspect.close();
        }
    });
    if (initialize) {
        await store.initialize();
        await store.patch(1, [change('users', null, member)]);
    }
    return {store, db, uri, name};
}

async function personalLogin(store) {
    const initial = await store.auth.provision(member.id, loginName);
    const first = await store.auth.login(loginName, initial);
    await store.auth.changePassword(first.token, initial, password);
    return store.auth.login(loginName, password);
}

test('开通中文登录名：保留成员和日报、私有存储并使用唯一索引', async t => {
    const {store, db} = await database(t);
    const other = {id: 'u-other', name: '其他成员'};
    const report = {
        id: 'r1',
        ownerId: member.id,
        taskId: 't1',
        date: '2026-11-19',
        weekId: '2026-W47',
        detail: '旧日报',
        hours: 2
    };
    const state = await store.patch(2, [change('dailyReports', null, report), change('users', null, other)]);
    const initial = await store.auth.provision(member.id, loginName);
    assert.match(initial, /^[A-Za-z0-9_-]{32}$/);
    await assert.rejects(store.auth.provision(other.id, ' 样例成员a '), {status: 409});
    await assert.rejects(store.auth.provision(member.id, '别名'), {status: 409});
    await assert.rejects(store.auth.provision('missing', '缺失'), {status: 404});
    await assert.rejects(store.auth.login('未开通', initial), wrongLogin);
    await assert.rejects(store.auth.login('样例成员a', '错误密码'), wrongLogin);
    const signedIn = await store.auth.login(' 样例成员a ', initial);
    assert.deepEqual(signedIn.user, member);
    assert.equal(signedIn.mustChangePassword, true);
    assert.ok(Date.parse(signedIn.expiresAt) > Date.now());
    await assert.rejects(store.patch(state.version, [change('memos', null, {id: 'restricted'})],
        () => store.auth.session(signedIn.token)), {status: 403, code: 'PASSWORD_CHANGE_REQUIRED'});
    const accounts = db.collection('auth_accounts'), sessions = db.collection('auth_sessions');
    const account = await accounts.findOne({memberId: member.id});
    assert.equal(account.loginName, '样例成员a');
    assert.match(account.credentials.salt, /^[A-Za-z0-9_-]{22}$/);
    assert.match(account.credentials.hash, /^[A-Za-z0-9_-]{43}$/);
    const session = await sessions.findOne({_id: sessionKey(signedIn.token)});
    assert.deepEqual(session.accountId, account._id);
    assert.equal(session.credentialVersion, account.credentialVersion);
    assert.equal(session.expiresAt.toISOString(), signedIn.expiresAt);
    assert.ok(!JSON.stringify(account).includes(initial) && !JSON.stringify(session).includes(signedIn.token));
    assert.deepEqual(await store.read(), state);
    await assert.rejects(store.patch(state.version, [change('users', member, null)]), {status: 409});
    const indexes = await accounts.indexes();
    for (const key of ['memberId', 'loginName']) assert.ok(indexes.some(i => i.key[key] === 1 && i.unique));
    assert.ok((await sessions.indexes()).some(i => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
});

test('初始口令到期、并发只可使用一次，失败后维护重置', async t => {
    const {store, db, uri} = await database(t);
    const stale = await store.auth.provision(member.id, loginName);
    const accounts = db.collection('auth_accounts');
    const original = await accounts.findOne({memberId: member.id});
    await accounts.updateOne({_id: original._id}, {$set: {initialExpiresAt: new Date(0)}});
    await assert.rejects(store.auth.login(loginName, stale), wrongLogin);
    const fresh = await store.auth.reset(member.id);
    const reset = await accounts.findOne({_id: original._id});
    assert.notEqual(reset.credentials.salt, original.credentials.salt);
    assert.equal(reset.credentialVersion, original.credentialVersion + 1);
    const attempts = await Promise.allSettled([store.auth.login(loginName, fresh), store.auth.login(loginName, fresh)]);
    const allowed = attempts.filter(result => result.status === 'fulfilled');
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].value.mustChangePassword, true);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 401);
    assert.equal(await db.collection('auth_sessions').countDocuments(), 1);
    await store.auth.logout(allowed[0].value.token);
    await store.close();
    const restarted = await openStore(uri);
    try {
        await restarted.initialize();
        await assert.rejects(restarted.auth.login(loginName, fresh), wrongLogin);
        const another = await restarted.auth.reset(member.id);
        await db.command({collMod: 'auth_sessions', validator: {testOnly: true}, validationAction: 'error'});
        await assert.rejects(restarted.auth.login(loginName, another), {code: 121});
        await db.command({collMod: 'auth_sessions', validator: {}});
        await assert.rejects(restarted.auth.login(loginName, another), wrongLogin);
        const reissued = await restarted.auth.reset(member.id);
        assert.equal((await restarted.auth.login(loginName, reissued)).mustChangePassword, true);
    } finally {
        await restarted.close();
    }
});

test('改密撤销整个账号的会话且只成功更新一次；注销仅撤销对应会话', async t => {
    const {store, db} = await database(t);
    const a = await personalLogin(store), b = await store.auth.login(loginName, password);
    assert.notEqual(a.token, b.token);
    assert.deepEqual(await store.auth.session(a.token), {
        user: member,
        expiresAt: a.expiresAt,
        mustChangePassword: false
    });
    assert.ok(Math.abs(Date.parse(a.expiresAt) - Date.now() - 8 * 3600_000) < 30_000);
    await assert.rejects(store.auth.changePassword(a.token, '不正确的当前密码', nextPassword), {status: 400});
    await assert.rejects(store.auth.changePassword(a.token, password, '短'), {status: 400});
    const candidates = [nextPassword, `${nextPassword}3`];
    const changes = await Promise.allSettled([a, b].map(({token}, i) => store.auth.changePassword(token, password, candidates[i])));
    assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1);
    const winner = changes.findIndex(result => result.status === 'fulfilled');
    const changedPassword = candidates[winner];
    assert.equal(changes[1 - winner].reason.status, 401);
    for (const token of [a.token, b.token, '', '伪造', 'a'.repeat(43)]) await assert.rejects(store.auth.session(token), {status: 401});
    await assert.rejects(store.auth.login(loginName, password), wrongLogin);
    const c = await store.auth.login(loginName, changedPassword),
        d = await store.auth.login(loginName, changedPassword);
    await store.auth.logout(c.token);
    await store.auth.logout(c.token);
    await assert.rejects(store.auth.session(c.token), {status: 401});
    assert.deepEqual((await store.auth.session(d.token)).user, member);
    await db.collection('auth_sessions').updateOne({_id: sessionKey(d.token)}, {$set: {expiresAt: new Date(0)}});
    await assert.rejects(store.auth.session(d.token), {status: 401});
    const e = await store.auth.login(loginName, changedPassword);
    await store.auth.disable(member.id);
    await assert.rejects(store.auth.session(e.token), {status: 401});
    await assert.rejects(store.auth.login(loginName, changedPassword), wrongLogin);
    await assert.rejects(store.auth.reset(member.id), {status: 409});
    assert.equal((await db.collection('auth_accounts').findOne({memberId: member.id})).credentials, undefined);
});

test('同一队列复核会话：改密、重置、停用后旧会话不能修改业务数据', async t => {
    const {store, db} = await database(t);
    const {token} = await personalLogin(store);
    const committed = await store.patch(2, [change('memos', null, {id: 'valid'})], () => store.auth.session(token));
    assert.equal(committed.version, 3);
    await store.auth.changePassword(token, password, nextPassword);
    await assert.rejects(store.patch(999, [change('memos', null, {id: 'revoked'})],
        () => store.auth.session(token)), {status: 401});
    const renewed = await store.auth.login(loginName, nextPassword);
    const reset = store.auth.reset(member.id);
    const refresh = store.refreshWeek('2026-W47', () => assert.fail('已撤销会话不应构建提醒'), () => store.auth.session(renewed.token));
    await assert.rejects(refresh, {status: 401});
    const restricted = await store.auth.login(loginName, await reset);
    const stopping = store.auth.disable(member.id);
    await assert.rejects(store.patch(3, [change('memos', null, {id: 'disabled'})], () => store.auth.session(restricted.token)), {status: 401});
    await stopping;
    assert.deepEqual((await store.read()).memos, [{id: 'valid'}]);
    assert.equal(await db.collection('ai_reminders').countDocuments(), 0);
});

test('业务批次发布前发现会话已过期，不留下业务写入或提交指针', async t => {
    const {store, db} = await database(t);
    const {token} = await personalLogin(store);
    let validations = 0;
    const invalidated = store.refreshWeek('2026-W47', () => [{id: 'not-committed'}], async () => {
        if (++validations === 2) {
            await db.collection('auth_sessions').updateOne({_id: sessionKey(token)}, {$set: {expiresAt: new Date(0)}});
        }
        return store.auth.session(token);
    });
    await assert.rejects(invalidated, {status: 401});
    assert.equal(validations, 2);
    assert.equal(await db.collection('pending_changes').countDocuments(), 0);
    assert.equal((await db.collection('team_meta').findOne()).pending, undefined);
    const state = await store.read();
    assert.equal(state.version, 2);
    assert.deepEqual(state.aiReminders, []);
});

test('业务成员已建但开户失败时，重试不重复建人，可按原 ID 补开通', async t => {
    const {store, db} = await database(t);
    await db.command({collMod: 'auth_accounts', validator: {testOnly: true}, validationAction: 'error'});
    await assert.rejects(store.auth.createMember('待补开的同事', '待补开'), {code: 121});
    const created = await db.collection('users').findOne({name: '待补开的同事'});
    assert.ok(created);
    assert.equal(await db.collection('auth_accounts').countDocuments({memberId: created._id}), 0);
    await db.command({collMod: 'auth_accounts', validator: {}});
    await assert.rejects(store.auth.createMember('待补开的同事', '待补开'), {status: 409});
    assert.equal(await db.collection('users').countDocuments({name: '待补开的同事'}), 1);
    const initial = await store.auth.provision(created._id, '待补开');
    assert.equal((await store.auth.login('待补开', initial)).user.id, created._id);
});

test('维护 CLI 强制显式已初始化库、共用离线锁、不给命令行传口令', async t => {
    const {store, name, db} = await database(t, true, {initializeAgentHistory: false});
    const wrong = await database(t, false);
    const cliArgs = (...args) => runFile(process.execPath, [cli, ...args], {
        env: {...process.env, MONGODB_URI: wrong.uri}, timeout: 15_000, encoding: 'utf8'
    });
    const command = (...args) => cliArgs('--db', name, ...args);
    await assert.rejects(cliArgs('list'), error => error.code === 1 && error.stdout === '');
    await assert.rejects(cliArgs('--db', wrong.name, 'list'), error => error.code === 1 && /不是已初始化/.test(error.stderr));
    assert.deepEqual(await wrong.db.listCollections().toArray(), []);
    await assert.rejects(command('list'), error => error.code === 1 && /写入锁/.test(error.stderr));
    await store.close();
    const listed = await command('list');
    assert.deepEqual(JSON.parse(listed.stdout), [member]);
    const provision = await command('provision', '--member-id', member.id, '--login-name', loginName);
    assert.match(provision.stdout.trim(), /^[A-Za-z0-9_-]{32}$/);
    assert.equal(provision.stderr, '');
    const created = await command('create', '--name', '新同事', '--login-name', '新同事');
    const {memberId, initialPassword} = JSON.parse(created.stdout);
    assert.match(initialPassword, /^[A-Za-z0-9_-]{32}$/);
    await assert.rejects(command('create', '--name', '新同事', '--login-name', '新同事'), error =>
        error.code === 1 && error.stderr.includes(memberId) && error.stdout === '');
    assert.equal(await db.collection('users').countDocuments({name: '新同事'}), 1);
    assert.equal(await db.collection('audit_log').countDocuments({entityId: memberId, action: 'joined'}), 1);
    const reset = await command('reset', '--member-id', memberId);
    assert.match(reset.stdout.trim(), /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(reset.stdout.trim(), initialPassword);
    assert.equal((await command('disable', '--member-id', memberId)).stdout.trim(), '账号已停用。');
    const summary = await command('list');
    assert.ok(!summary.stdout.includes(initialPassword) && !summary.stdout.includes(reset.stdout.trim()));
    const secret = randomUUID();
    await assert.rejects(command('reset', '--member-id', member.id, '--password', secret), error =>
        error.code === 1 && error.stdout === '' && !error.stderr.includes(secret));
    // 离线账号维护不代替服务执行首次聊天历史迁移。
    assert.equal((await db.collection('team_meta').findOne({_id: 'default'})).agentSchemaVersion, undefined);
    assert.deepEqual(await db.listCollections({name: /^agent_/}, {nameOnly: true}).toArray(), []);
});
