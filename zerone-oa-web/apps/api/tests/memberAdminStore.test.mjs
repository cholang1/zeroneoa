import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {openStore} from '../src/repositories/mongoStore.mjs';
import {names} from '../src/repositories/schema.mjs';

const password = '首任管理员的独立个人口令 42';
const newPassword = '独立的后续个人密码 2026';
const setupInput = (name = '首位成员') => ({
    name,
    loginName: `${name}Ａ`,
    password,
    setupKey: randomBytes(32).toString('base64url')
});
const change = (key, before, after) => ({key, id: (after ?? before).id, before, after});
const report = ownerId => ({
    id: 'r1',
    ownerId,
    taskId: 't1',
    date: '2026-11-19',
    weekId: '2026-W47',
    detail: '原日报',
    hours: 2
});
const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]));
const conflict = {status: 409};

async function database(t, initialize = true) {
    const uri = `mongodb://127.0.0.1:27018/oa_test_${randomUUID().replaceAll('-', '')}?retryWrites=false`;
    const inspect = new MongoClient(uri), db = inspect.db();
    let store = await openStore(uri);
    t.after(async () => {
        try {
            await store.close();
            await db.dropDatabase();
        } finally {
            await inspect.close();
        }
    });
    if (initialize) await store.initialize();
    return {
        get store() {
            return store;
        }, db, uri,
        async restart() {
            await store.close();
            store = await openStore(uri);
            await store.initialize();
            return store;
        }
    };
}

async function setup(store) {
    const input = setupInput();
    const {memberId} = await store.auth.setupFirstAdmin(input);
    const {token} = await store.auth.login(input.loginName, input.password);
    return {memberId, token, input};
}

async function personal(store, loginName, initial) {
    const first = await store.auth.login(loginName, initial);
    await store.auth.changePassword(first.token, initial, newPassword);
    return store.auth.login(loginName, newPassword);
}

test('全新库并发只完成一次初始化，不签发会话；重启、停用及清空仍不重开', async t => {
    const env = await database(t);
    let {store} = env;
    const {db} = env, left = setupInput('第一位'), right = setupInput('另一位');
    assert.equal(await store.auth.setupAvailable(), true);
    await assert.rejects(store.auth.setupFirstAdmin({...left, password: '太短'}), {status: 400});
    await assert.rejects(store.auth.setupFirstAdmin({...left, setupKey: 'a'.repeat(31)}), {status: 400});
    assert.equal((await db.collection('team_meta').findOne()).firstAdmin.state, 'open');
    const attempts = await Promise.allSettled([left, right].map(input => store.auth.setupFirstAdmin(input)));
    const winner = attempts.findIndex(result => result.status === 'fulfilled');
    assert.notEqual(winner, -1);
    assert.equal(attempts[1 - winner].reason.status, 409);
    const {memberId} = attempts[winner].value, input = [left, right][winner];
    assert.deepEqual(Object.keys(attempts[winner].value), ['memberId']);
    assert.equal(await db.collection('auth_sessions').countDocuments(), 0);
    assert.equal(await db.collection('users').countDocuments(), 1);
    assert.equal(await db.collection('auth_accounts').countDocuments(), 1);
    const business = await store.read();
    assert.equal(business.version, 2);
    assert.equal(business.users[0].id, memberId);
    assert.equal(business.auditLog[0].entityId, memberId);
    assert.equal(business.firstAdmin, undefined);
    const {firstAdmin} = await db.collection('team_meta').findOne();
    assert.equal(firstAdmin.state, 'bound');
    assert.equal(firstAdmin.memberId, memberId);
    assert.equal(firstAdmin.proof, undefined);
    assert.equal(await store.auth.setupAvailable(), false);
    await assert.rejects(store.auth.setupFirstAdmin(input), conflict);
    store = await env.restart();
    const login = await store.auth.login(input.loginName, input.password);
    assert.equal(login.isAccountAdmin, true);
    assert.equal(login.mustChangePassword, false);
    assert.equal((await store.auth.session(login.token)).isAccountAdmin, true);
    await store.auth.disable(memberId);
    await assert.rejects(store.auth.adminList(login.token), {status: 401});
    assert.equal(await store.auth.setupAvailable(), false);
    for (const name of [...Object.values(names), 'auth_accounts']) await db.collection(name).deleteMany({});
    store = await env.restart();
    assert.equal(await store.auth.setupAvailable(), false);
    await assert.rejects(store.auth.setupFirstAdmin(right), conflict);
    assert.deepEqual((await db.collection('team_meta').findOne()).firstAdmin, firstAdmin);
});

test('既有成员必须明确按 ID 核对有效账号；绑定前的普通会话不会升级', async t => {
    const {store, db} = await database(t);
    const user = {id: 'u-checked', name: '测试成员甲'}, other = {id: 'u-other', name: '别人', isAccountAdmin: true};
    const original = await store.patch(1, [change('users', null, user), change('users', null, other),
        change('dailyReports', null, report(user.id))]);
    assert.equal(await store.auth.setupAvailable(), false);
    await assert.rejects(store.auth.bindFirstAdmin(user.id, '测试成员甲'), conflict);
    await assert.rejects(store.auth.bindFirstAdmin(user.id), {status: 400});
    await assert.rejects(store.auth.bindFirstAdmin(other.id, '测试成员甲'), conflict);
    const otherLogin = await personal(store, '普通成员', await store.auth.provision(other.id, '普通成员'));
    const initial = await store.auth.provision(user.id, '已核对账号');
    const accounts = db.collection('auth_accounts');
    const firstAccount = await accounts.findOne({memberId: user.id});
    await accounts.updateOne({_id: firstAccount._id}, {$set: {initialExpiresAt: new Date(0)}});
    await assert.rejects(store.auth.bindFirstAdmin(user.id, '测试成员甲'), conflict);
    const old = await personal(store, '已核对账号', await store.auth.reset(user.id));
    assert.notEqual(old.isAccountAdmin, true);
    await assert.rejects(store.auth.adminList(old.token), {status: 403});
    const attempts = await Promise.allSettled([1, 2].map(() => store.auth.bindFirstAdmin(user.id, user.name)));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
    assert.notEqual((await store.auth.session(old.token)).isAccountAdmin, true);
    await assert.rejects(store.auth.adminCommand(old.token, 'create', {
        name: '不应创建',
        loginName: '不应创建'
    }), {status: 403});
    await assert.rejects(store.auth.adminList(otherLogin.token), {status: 403});
    const admin = await store.auth.login('已核对账号', newPassword);
    assert.equal(admin.isAccountAdmin, true);
    assert.deepEqual(byId(await store.auth.adminList(admin.token)), {
        [user.id]: {id: user.id, name: user.name, loginName: '已核对账号', status: 'active', isAccountAdmin: true},
        [other.id]: {id: other.id, name: other.name, loginName: '普通成员', status: 'active', isAccountAdmin: false}
    });
    assert.deepEqual(await store.read(), original);
    assert.equal((await db.collection('team_meta').findOne()).firstAdmin.accountId.toString(), firstAccount._id.toString());
    const replacement = await accounts.findOne({memberId: other.id});
    await accounts.deleteOne({_id: firstAccount._id});
    await accounts.updateOne({_id: replacement._id}, {$set: {memberId: user.id}});
    assert.notEqual((await store.auth.login('普通成员', newPassword)).isAccountAdmin, true);
    await assert.rejects(store.auth.bindFirstAdmin(user.id, user.name), conflict);
});

test('旧空库、已有代次及恢复时替换集合均不能开放', async t => {
    const historical = await database(t, false);
    await historical.db.collection('team_meta').insertOne({_id: 'default', version: 1, schema: 'oa-business-v1'});
    await historical.store.initialize();
    assert.equal(await historical.store.auth.setupAvailable(), false);
    const used = await database(t);
    const member = {id: 'u1', name: '随后删除'};
    await used.store.patch(1, [change('users', null, member)]);
    await used.store.patch(2, [change('users', member, null)]);
    assert.equal(await (await used.restart()).auth.setupAvailable(), false);
    const restored = await database(t);
    const virgin = await restored.db.collection('team_meta').findOne();
    assert.equal(await restored.store.auth.setupAvailable(), true);
    await restored.store.close();
    await restored.db.dropDatabase();
    await restored.db.collection('team_meta').insertOne(virgin);
    const restarted = await restored.restart();
    assert.equal(await restarted.auth.setupAvailable(), false);
    await assert.rejects(restarted.auth.setupFirstAdmin(setupInput()), conflict);
    assert.equal((await restored.db.collection('team_meta').findOne()).firstAdmin.state, 'closed');
});

test('空用户表不是初始化条件：逐一检查九业务集合及认证账号', async t => {
    for (const name of [...Object.values(names), 'auth_accounts']) await t.test(name, async t => {
        const env = await database(t);
        const col = env.db.collection(name);
        await col.insertOne({_id: 'imported', name: '导入数据', loginName: '已存在', memberId: 'u-imported'});
        const store = await env.restart();
        assert.equal(await store.auth.setupAvailable(), false);
        await assert.rejects(store.auth.setupFirstAdmin(setupInput()), conflict);
        await col.deleteMany({});
        assert.equal(await store.auth.setupAvailable(), false);
    });
});

test('从成员已写、账号未写、绑定未写分别原请求恢复，禁止接管及篡改预留记录', async t => {
    const env = await database(t), {db} = env, input = setupInput();
    let {store} = env;
    const {auth} = store;
    await db.command({collMod: 'auth_accounts', validator: {testOnly: true}});
    await assert.rejects(auth.setupFirstAdmin(input), {status: 503});
    const {firstAdmin} = await db.collection('team_meta').findOne();
    assert.equal(firstAdmin.state, 'pending');
    assert.match(firstAdmin.proof, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(firstAdmin).includes(input.setupKey) && !JSON.stringify(firstAdmin).includes(input.password));
    const business = await store.read();
    assert.equal(business.users[0].id, firstAdmin.memberId);
    assert.equal(business.auditLog[0].id, firstAdmin.auditId);
    assert.equal(await db.collection('auth_accounts').countDocuments(), 0);
    assert.equal(await auth.setupAvailable(), true);
    await assert.rejects(auth.provision(firstAdmin.memberId, input.loginName), conflict);
    await assert.rejects(auth.reset(firstAdmin.memberId), conflict);
    await assert.rejects(auth.disable(firstAdmin.memberId), conflict);
    await assert.rejects(auth.createMember('CLI 新成员', 'cli-login'), conflict);
    await assert.rejects(store.patch(2, [change('users', business.users[0], {
        ...business.users[0],
        name: '篡改'
    })]), conflict);
    await assert.rejects(store.patch(2, [change('memos', null, {id: 'later'})]), conflict);
    await db.command({collMod: 'auth_accounts', validator: {}});
    await db.command({collMod: 'team_meta', validator: {'firstAdmin.state': {$ne: 'bound'}}});
    store = await env.restart();
    for (const different of [{name: '不同成员'}, {loginName: '其他登录名'}, {password: newPassword},
        {setupKey: randomBytes(32).toString('base64url')}]) {
        await assert.rejects(store.auth.setupFirstAdmin({...input, ...different}), conflict);
    }
    await assert.rejects(store.auth.setupFirstAdmin(input), {status: 503});
    const account = await db.collection('auth_accounts').findOne();
    assert.equal(account._id.toString(), firstAdmin.accountId.toString());
    assert.equal(account.memberId, firstAdmin.memberId);
    await assert.rejects(store.auth.login(input.loginName, password), {status: 401});
    assert.equal(await db.collection('auth_sessions').countDocuments(), 0);
    await db.command({collMod: 'team_meta', validator: {}});
    store = await env.restart();
    const finished = await store.auth.setupFirstAdmin({
        ...input,
        name: ` ${input.name} `,
        loginName: input.loginName.normalize('NFKC')
    });
    assert.deepEqual(finished, {memberId: firstAdmin.memberId});
    assert.deepEqual(await store.read(), business);
    assert.deepEqual(await db.collection('auth_accounts').findOne(), account);
    assert.equal(await store.auth.setupAvailable(), false);
    assert.equal(await db.collection('auth_sessions').countDocuments(), 0);
    assert.equal((await store.auth.login(input.loginName, password)).isAccountAdmin, true);
});

test('成员业务批次发布后中断：先正常重放，再恢复原初始化；不接管外来账号', async t => {
    const env = await database(t), {db} = env, input = setupInput();
    await db.command({collMod: 'users', validator: {testOnly: true}});
    await assert.rejects(env.store.auth.setupFirstAdmin(input), {status: 503});
    const doomed = await db.collection('team_meta').findOne();
    assert.ok(doomed.pending);
    assert.equal(doomed.firstAdmin.state, 'pending');
    await db.command({collMod: 'users', validator: {}});
    const store = await env.restart(), {memberId, accountId} = doomed.firstAdmin;
    assert.deepEqual((await store.read()).users.map(u => u.id), [memberId]);
    assert.equal(await db.collection('pending_changes').countDocuments(), 0);
    const accounts = db.collection('auth_accounts');
    await accounts.insertOne({
        _id: accountId, memberId, loginName: input.loginName.normalize('NFKC').toLowerCase(),
        active: true, mustChangePassword: false, credentialVersion: 1
    });
    await assert.rejects(store.auth.setupFirstAdmin(input), {status: 503});
    assert.equal((await db.collection('team_meta').findOne()).firstAdmin.state, 'pending');
    await accounts.deleteOne({_id: accountId});
    assert.deepEqual(await store.auth.setupFirstAdmin(input), {memberId});
    assert.equal(await db.collection('users').countDocuments(), 1);
    assert.equal(await db.collection('audit_log').countDocuments(), 1);
});

test('在线命令校验权限、密码与会话版本；审计私有且原业务不受影响', async t => {
    const {store, db} = await database(t), {token, memberId: actor} = await setup(store);
    const member = {id: 'target', name: '待开通'}, other = {id: 'other', name: '继续使用者'};
    await store.patch(2, [change('users', null, member), change('users', null, other),
        change('dailyReports', null, report(member.id))], () => store.auth.session(token));
    const {auth} = store;
    const list = async () => byId(await auth.adminList(token));
    assert.deepEqual((await list())[member.id], {
        id: member.id,
        name: member.name,
        status: 'unprovisioned',
        isAccountAdmin: false
    });
    const provisioned = await auth.adminCommand(token, 'provision', {memberId: member.id, loginName: ' 目标Ａ '});
    const otherLogin = await personal(store, '普通', await auth.provision(other.id, '普通'));
    assert.equal(provisioned.memberId, member.id);
    assert.match(provisioned.initialPassword, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await list())[member.id].status, 'initial');
    const restricted = await auth.login('目标a', provisioned.initialPassword);
    await assert.rejects(auth.adminList(restricted.token), {status: 403, code: 'PASSWORD_CHANGE_REQUIRED'});
    await assert.rejects(auth.adminCommand(restricted.token, 'disable', {
        memberId: other.id,
        currentPassword: password
    }), {status: 403});
    await auth.changePassword(restricted.token, provisioned.initialPassword, newPassword);
    const beforeReset = await auth.login('目标a', newPassword);
    assert.equal((await list())[member.id].status, 'active');
    await assert.rejects(auth.adminCommand(beforeReset.token, 'reset', {
        memberId: other.id,
        currentPassword: newPassword
    }), {status: 403});
    await assert.rejects(auth.adminCommand(token, '__proto__', {}), {status: 400});
    for (const op of ['reset', 'disable']) {
        await assert.rejects(auth.adminCommand(token, op, {memberId: member.id, currentPassword: '不正确的当前口令'}),
            {status: 400, message: '当前口令错误。'});
        await assert.rejects(auth.adminCommand(token, op, {memberId: actor, currentPassword: password}), {status: 400});
    }
    const business = await store.read();
    const reset = await auth.adminCommand(token, 'reset', {memberId: member.id, currentPassword: password});
    await assert.rejects(auth.session(beforeReset.token), {status: 401});
    const afterReset = await auth.login('目标a', reset.initialPassword);
    assert.equal(afterReset.mustChangePassword, true);
    assert.deepEqual(await auth.adminCommand(token, 'disable', {
        memberId: member.id,
        currentPassword: password
    }), {memberId: member.id});
    await assert.rejects(auth.session(afterReset.token), {status: 401});
    assert.equal((await list())[member.id].status, 'disabled');
    assert.equal((await auth.session(otherLogin.token)).user.id, other.id);
    assert.deepEqual(await store.read(), business);
    const commands = await Promise.allSettled(['新成员一', '新成员二'].map(name =>
        auth.adminCommand(token, 'create', {name, loginName: '共享登录名'})));
    const created = commands.find(result => result.status === 'fulfilled').value;
    assert.equal(commands.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal((await list())[created.memberId].status, 'initial');
    assert.deepEqual((await store.read()).dailyReports, business.dailyReports);
    const events = await db.collection('auth_admin_audit').find().toArray();
    assert.equal(events.filter(event => event.result === 'success').length, 4);
    assert.ok(events.every(event => event.actor === actor && event.target && event.time instanceof Date));
    assert.ok(events.some(event => event.action === 'reset' && event.target === member.id && event.result === 'failed'));
    for (const secret of [password, newPassword, provisioned.initialPassword, reset.initialPassword, created.initialPassword, token]) {
        assert.ok(!JSON.stringify(events).includes(secret));
    }
});

test('持有队列后复核到期与撤销，并拒绝受限管理员会话', async t => {
    const {store, db} = await database(t), {token, memberId, input} = await setup(store);
    const {auth} = store, entered = Promise.withResolvers(), release = Promise.withResolvers();
    const barrier = store.patch(2, [], async () => {
        entered.resolve();
        await release.promise;
    });
    try {
        await entered.promise;
        const command = auth.adminCommand(token, 'create', {name: '已到期', loginName: 'expired'});
        await db.collection('auth_sessions').updateOne({_id: createHash('sha256').update(token).digest('hex')}, {$set: {expiresAt: new Date(0)}});
        release.resolve();
        await assert.rejects(command, {status: 401});
    } finally {
        release.resolve();
        await barrier;
    }
    assert.equal(await db.collection('auth_admin_audit').countDocuments(), 0);
    const signedIn = await auth.login(input.loginName, password);
    const reset = auth.reset(memberId);
    await assert.rejects(auth.adminCommand(signedIn.token, 'create', {
        name: '已撤销',
        loginName: 'revoked'
    }), {status: 401});
    const restricted = await auth.login(input.loginName, await reset);
    assert.equal(restricted.isAccountAdmin, true);
    await assert.rejects(auth.adminList(restricted.token), {status: 403, code: 'PASSWORD_CHANGE_REQUIRED'});
    assert.deepEqual((await store.read()).users.map(user => user.id), [memberId]);
});

test('审计失败和开户部分失败不伪报成功，不重复创建成员', async t => {
    const env = await database(t), {store, db} = env, {token} = await setup(store);
    const audit = db.collection('auth_admin_audit');
    const target = {id: 'target', name: '审计目标'};
    await store.patch(2, [change('users', null, target)]);
    const payload = {memberId: target.id, loginName: 'audit-test'};
    await db.command({collMod: 'auth_admin_audit', validator: {result: 'blocked'}});
    await assert.rejects(store.auth.adminCommand(token, 'provision', payload), {status: 503, message: /未执行/});
    assert.equal(await db.collection('auth_accounts').countDocuments({memberId: target.id}), 0);
    await db.command({collMod: 'auth_admin_audit', validator: {result: 'pending'}});
    await assert.rejects(store.auth.adminCommand(token, 'provision', payload), {status: 503, message: /结果未确认/});
    assert.equal(await db.collection('auth_accounts').countDocuments({memberId: target.id}), 1);
    assert.equal((await audit.findOne()).result, 'pending');
    await db.command({collMod: 'auth_admin_audit', validator: {}});
    const {auth} = await env.restart();
    assert.equal((await audit.findOne()).result, 'unknown');
    await db.command({collMod: 'auth_accounts', validator: {testOnly: true}});
    const input = {name: '未完成开通的成员', loginName: 'pending-account'};
    await assert.rejects(auth.adminCommand(token, 'create', input), {status: 503, message: /成员已新增/});
    const partial = await audit.findOne({action: 'create', result: 'partial'});
    const row = byId(await auth.adminList(token))[partial.target];
    assert.equal(row.status, 'unprovisioned');
    await db.command({collMod: 'auth_accounts', validator: {}});
    await assert.rejects(auth.adminCommand(token, 'create', input), conflict);
    assert.equal(await db.collection('users').countDocuments({name: input.name}), 1);
    const done = await auth.adminCommand(token, 'provision', {memberId: row.id, loginName: input.loginName});
    assert.match(done.initialPassword, /^[A-Za-z0-9_-]{32}$/);
});
