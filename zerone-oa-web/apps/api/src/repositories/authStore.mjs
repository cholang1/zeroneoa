import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {
    checkNewPassword,
    generateInitialPassword,
    hashPassword,
    validPasswordInput,
    verifyPassword
} from '../services/passwords.mjs';
import {makeFirstAdminStore} from './firstAdminStore.mjs';
import {StateError} from './schema.mjs';

const SESSION_MS = 8 * 60 * 60 * 1000;
const INITIAL_MS = 24 * 60 * 60 * 1000;
const badLogin = () => new StateError(401, '登录名或密码错误');
const badSession = () => new StateError(401, '登录已失效，请重新登录。');
const auditUnavailable = () => new StateError(503, '账号管理操作未执行，无法写入审计记录。');
const outcomeUnknown = () => new StateError(503, '账号管理结果未确认，请先刷新成员列表核对。未收到初始口令时，请核对后重置，不要直接重试。');
const digestToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? createHash('sha256').update(token).digest('hex') : null;
const publicUser = ({_id, name, color}) => ({id: _id, name, color});
const publicSession = (user, account, expiresAt, isAccountAdmin) => ({
    user: publicUser(user), mustChangePassword: account.mustChangePassword, expiresAt: expiresAt.toISOString(),
    ...(isAccountAdmin && {isAccountAdmin: true})
});
const activeVersion = account => ({_id: account._id, active: true, credentialVersion: account.credentialVersion});
const sameVersion = (a, b) => (a._id === b._id || a._id?.equals?.(b._id)) && a.credentialVersion === b.credentialVersion;
const initialFields = {$unset: {initialExpiresAt: '', initialUsedAt: ''}};
const memberProjection = {name: 1, color: 1};
const operations = new Set(['create', 'provision', 'reset', 'disable']);
const reauthOperations = new Set(['reset', 'disable']);
const initialUsable = account => account.mustChangePassword === false || account.mustChangePassword === true &&
    !account.initialUsedAt && account.initialExpiresAt instanceof Date && account.initialExpiresAt.getTime() > Date.now();

function normalizeLogin(value) {
    if (typeof value !== 'string' || value.length > 128 || !value.isWellFormed()) return null;
    const name = value.normalize('NFKC').trim().toLowerCase();
    return name && name.length <= 128 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? name : null;
}

function requireLogin(value) {
    const name = normalizeLogin(value);
    if (!name) throw new StateError(400, '登录名无效（最多 128 个 UTF-16 码元，不允许控制字符）。');
    return name;
}

function requireName(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 128 || !name.isWellFormed() ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) throw new StateError(400, '成员姓名无效。');
    return name.trim();
}

function checkMemberId(value) {
    if (typeof value !== 'string' || !value || value.length > 512) throw new StateError(400, '成员 ID 无效。');
}

export function makeAuthStore({db, users, run, assertReady, addMember}) {
    const accounts = db.collection('auth_accounts'), sessions = db.collection('auth_sessions');
    const adminAudit = db.collection('auth_admin_audit');
    const firstAdmin = makeFirstAdminStore({db, accounts, addMember});
    const member = id => users.findOne({_id: id}, {projection: memberProjection});

    async function authenticated(token) {
        // 这里不能排队：业务写入已持有队列时也要调用 session() 复核身份。
        assertReady();
        const digest = digestToken(token);
        if (!digest) throw badSession();
        const session = await sessions.findOne({_id: digest, expiresAt: {$gt: new Date()}});
        if (!session) throw badSession();
        const account = await accounts.findOne({
            _id: session.accountId,
            active: true,
            credentialVersion: session.credentialVersion
        });
        if (!account) throw badSession();
        const [user, access] = await Promise.all([member(account.memberId), firstAdmin.access(account)]);
        if (!user || !access.allowed || session.expiresAt.getTime() <= Date.now()) throw badSession();
        // 维护绑定之前签发的普通会话不会因为数据库新增绑定而升级。
        return {session, account, user, isAccountAdmin: session.isAccountAdmin === true && access.isAdmin};
    }

    async function admin(token) {
        const principal = await authenticated(token);
        if (principal.account.mustChangePassword) {
            const error = new StateError(403, '请先修改初始密码。');
            error.code = 'PASSWORD_CHANGE_REQUIRED';
            throw error;
        }
        if (!principal.isAccountAdmin) throw new StateError(403, '仅账号管理员可操作。');
        return principal;
    }

    async function issueInitial() {
        const password = generateInitialPassword();
        const credentials = await hashPassword(password);
        return {password, credentials};
    }

    async function insertAccount(memberId, loginName, credentials) {
        try {
            await accounts.insertOne({
                memberId, loginName, credentials, active: true, credentialVersion: 1, mustChangePassword: true,
                initialExpiresAt: new Date(Date.now() + INITIAL_MS)
            });
        } catch (error) {
            if (error.code === 11000) throw new StateError(409, '登录名或成员已开通账号。');
            throw error;
        }
    }

    async function provision(memberId, loginName, beforeWrite) {
        checkMemberId(memberId);
        const name = requireLogin(loginName);
        await firstAdmin.checkNotReserved(memberId);
        if (!await member(memberId)) throw new StateError(404, '没有该成员。');
        const {password, credentials} = await issueInitial();
        await beforeWrite?.('account');
        await insertAccount(memberId, name, credentials);
        return password;
    }

    async function reset(memberId, beforeWrite) {
        checkMemberId(memberId);
        await firstAdmin.checkNotReserved(memberId);
        const account = await accounts.findOne({memberId});
        if (!account) throw new StateError(404, '该成员未开通账号。');
        if (!account.active) throw new StateError(409, '该账号已停用，不能重置。');
        const {password, credentials} = await issueInitial();
        await beforeWrite?.('account');
        const result = await accounts.updateOne(activeVersion(account), {
            $set: {credentials, mustChangePassword: true, initialExpiresAt: new Date(Date.now() + INITIAL_MS)},
            $unset: {initialUsedAt: ''}, $inc: {credentialVersion: 1}
        });
        if (!result.matchedCount) throw new StateError(409, '账号已被更新，请重试。');
        return password;
    }

    async function disable(memberId, beforeWrite) {
        checkMemberId(memberId);
        await firstAdmin.checkNotReserved(memberId);
        const account = await accounts.findOne({memberId});
        if (!account) throw new StateError(404, '该成员未开通账号。');
        if (!account.active) return;
        await beforeWrite?.('account');
        const result = await accounts.updateOne(activeVersion(account), {
            $set: {active: false}, $inc: {credentialVersion: 1},
            $unset: {...initialFields.$unset, credentials: '', mustChangePassword: ''}
        });
        if (!result.matchedCount) throw new StateError(409, '账号已被更新，请重试。');
    }

    async function createMember(version, name, loginName, {memberId, beforeWrite, recheck, memberCommitted} = {}) {
        const normalizedLogin = requireLogin(loginName);
        const normalizedName = requireName(name);
        const existing = await users.findOne({name: normalizedName}, {projection: {_id: 1}});
        if (existing) throw new StateError(409, `同名成员已存在（ID: ${JSON.stringify(existing._id)}），请核对身份后按 ID 开通。`);
        if (await accounts.findOne({loginName: normalizedLogin}, {projection: {_id: 1}})) {
            throw new StateError(409, '登录名已被使用。');
        }
        const {password, credentials} = await issueInitial();
        await beforeWrite?.('member');
        // 中途失败可能只留下业务成员；不倒过来先开户，也不自动绑定同名成员。
        const id = await addMember(version, normalizedName, {memberId, validate: recheck});
        memberCommitted?.();
        await beforeWrite?.('account');
        await insertAccount(id, normalizedLogin, credentials);
        return {memberId: id, initialPassword: password};
    }

    async function adminCommand(version, token, op, payload) {
        const {account: actor} = await admin(token);
        if (!operations.has(op)) throw new StateError(400, '不支持的账号管理操作。');
        const memberId = op === 'create' ? `u-${randomUUID()}` : payload?.memberId;
        checkMemberId(memberId);
        // 必须先写入尝试记录，进程中断时也不能留下无审计的账号变更。
        const time = new Date();
        const audit = await adminAudit.insertOne({
            action: op,
            target: memberId,
            actor: actor.memberId,
            time,
            result: 'pending'
        })
            .catch(() => {
                throw auditUnavailable();
            });
        const finish = async result => {
            const update = await adminAudit.updateOne({_id: audit.insertedId, result: 'pending'}, {
                $set: {result, finishedAt: new Date()}
            });
            if (!update.matchedCount) throw outcomeUnknown();
        };
        const recheck = async () => {
            const {account} = await admin(token);
            if (!sameVersion(actor, account)) throw badSession();
        };
        let phase, created = false;
        const beforeWrite = async step => {
            await recheck();
            phase = step;
        };
        let result;
        try {
            if (reauthOperations.has(op)) {
                if (actor.memberId === memberId) throw new StateError(400, '不能在成员管理中重置或停用自己的账号。');
                const currentPassword = payload?.currentPassword;
                if (!validPasswordInput(currentPassword) || !await verifyPassword(currentPassword, actor.credentials)) {
                    throw new StateError(400, '当前口令错误。');
                }
                await recheck();
            }
            switch (op) {
                case 'create':
                    result = await createMember(version, payload?.name, payload?.loginName, {
                        memberId, beforeWrite, recheck, memberCommitted() {
                            created = true;
                            phase = undefined;
                        }
                    });
                    break;
                case 'provision':
                    result = {memberId, initialPassword: await provision(memberId, payload?.loginName, beforeWrite)};
                    break;
                case 'reset':
                    result = {memberId, initialPassword: await reset(memberId, beforeWrite)};
                    break;
                case 'disable':
                    await disable(memberId, beforeWrite);
                    result = {memberId};
                    break;
            }
        } catch (error) {
            const knownFailure = error instanceof StateError && (phase !== 'member' || error.status !== 503) ||
                phase === 'account' && error.code === 121;
            const uncertain = Boolean(phase && !knownFailure);
            try {
                await finish(uncertain ? 'unknown' : created ? 'partial' : 'failed');
            } catch {
                throw uncertain || created ? outcomeUnknown() : auditUnavailable();
            }
            if (uncertain) throw outcomeUnknown();
            if (created) throw new StateError(503, '成员已新增但未完成开通，请刷新列表并按成员 ID 核对后开通。');
            if (error instanceof StateError) throw error;
            throw new StateError(503, '账号管理操作未完成，请联系管理员核对。');
        }
        try {
            await finish('success');
        } catch {
            throw outcomeUnknown();
        }
        return result;
    }

    return {
        async initialize() {
            await accounts.createIndex({loginName: 1}, {unique: true});
            await accounts.createIndex({memberId: 1}, {unique: true});
            // 令牌摘要使用 _id（唯一），TTL 仅负责回收，不作为有效性判断。
            await sessions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0});
            await adminAudit.createIndex({result: 1});
            await adminAudit.updateMany({result: 'pending'}, {$set: {result: 'unknown', finishedAt: new Date()}});
        },
        hasAccount: memberId => accounts.findOne({memberId}, {projection: {_id: 1}}),
        refreshSetupAvailability: firstAdmin.available,
        assertNoPendingSetup: firstAdmin.assertNoPendingSetup,
        api: {
            async login(loginName, password) {
                assertReady();
                const name = normalizeLogin(loginName);
                if (!name || !validPasswordInput(password)) throw badLogin();
                const account = await accounts.findOne({loginName: name, active: true});
                const eligible = account && initialUsable(account);
                // KDF 在队列外运行；签发前重新检查版本，以免和改密或维护写入竞态。
                if (!await verifyPassword(password, eligible ? account.credentials : undefined)) throw badLogin();
                return run(async () => {
                    const filter = activeVersion(account);
                    const [user, {
                        allowed,
                        isAdmin
                    }] = await Promise.all([member(account.memberId), firstAdmin.access(account)]);
                    if (!user || !allowed) throw badLogin();
                    const now = Date.now();
                    let expiry = now + SESSION_MS;
                    if (account.mustChangePassword) {
                        const taken = await accounts.updateOne({
                            ...filter, mustChangePassword: true,
                            initialUsedAt: {$exists: false}, initialExpiresAt: {$gt: new Date(now)}
                        }, {$set: {initialUsedAt: new Date(now)}});
                        if (!taken.matchedCount) throw badLogin();
                        expiry = Math.min(expiry, account.initialExpiresAt.getTime());
                    } else if (!await accounts.findOne(filter, {projection: {_id: 1}})) throw badLogin();
                    const expiresAt = new Date(expiry);
                    const token = randomBytes(32).toString('base64url');
                    await sessions.insertOne({
                        _id: digestToken(token), accountId: account._id,
                        credentialVersion: account.credentialVersion, expiresAt, ...(isAdmin && {isAccountAdmin: true})
                    });
                    if (expiresAt.getTime() <= Date.now()) throw badLogin();
                    return {token, ...publicSession(user, account, expiresAt, isAdmin)};
                });
            },
            async session(token) {
                const {session, account, user, isAccountAdmin} = await authenticated(token);
                return publicSession(user, account, session.expiresAt, isAccountAdmin);
            },
            logout: token => run(async () => {
                const digest = digestToken(token);
                if (digest) await sessions.deleteOne({_id: digest});
            }),
            async changePassword(token, currentPassword, newPassword) {
                const {account} = await authenticated(token);
                checkNewPassword(newPassword);
                if (!validPasswordInput(currentPassword) || !await verifyPassword(currentPassword, account.credentials)) {
                    throw new StateError(400, '当前口令错误。');
                }
                if (currentPassword === newPassword) throw new StateError(400, '新密码不能与当前口令相同。');
                const credentials = await hashPassword(newPassword);
                // 慢哈希在队列外；提交前在同一业务队列内确认会话仍绑定到已核对的那版凭据。
                return run(async () => {
                    const {account: current} = await authenticated(token);
                    if (!sameVersion(account, current)) throw badSession();
                    const result = await accounts.updateOne(activeVersion(account), {
                        $set: {credentials, mustChangePassword: false}, $inc: {credentialVersion: 1}, ...initialFields
                    });
                    if (!result.matchedCount) throw badSession();
                });
            },
            provision: (memberId, loginName) => run(() => provision(memberId, loginName)),
            reset: memberId => run(() => reset(memberId)),
            disable: memberId => run(() => disable(memberId)),
            listMembers: () => run(async () => (await users.find({}, {projection: memberProjection})
                .sort({name: 1, _id: 1}).toArray()).map(publicUser)),
            createMember: (name, loginName) => run(version => createMember(version, name, loginName)),
            setupAvailable: () => run(firstAdmin.available),
            setupFirstAdmin: input => run(() => firstAdmin.setup(() => {
                const {name, loginName, password, setupKey} = input ?? {};
                checkNewPassword(password);
                if (typeof setupKey !== 'string' || !setupKey.isWellFormed() || setupKey.length < 32 ||
                    setupKey.length > 256 || /[\s\p{Cc}\p{Cf}]/u.test(setupKey)) throw new StateError(400, '部署凭证格式无效。');
                return {name: requireName(name), loginName: requireLogin(loginName), password, setupKey};
            })),
            bindFirstAdmin: (memberId, expectedName) => run(async () => {
                checkMemberId(memberId);
                if (typeof expectedName !== 'string' || !expectedName.trim()) throw new StateError(400, '请显式核对成员姓名及 ID。');
                const user = await member(memberId);
                if (!user || user.name !== expectedName) throw new StateError(409, '现有成员身份无法核对。');
                const account = await accounts.findOne({memberId, active: true});
                if (!account || typeof account.loginName !== 'string' || normalizeLogin(account.loginName) !== account.loginName ||
                    !initialUsable(account) || !Number.isSafeInteger(account.credentialVersion) || account.credentialVersion < 1 ||
                    typeof account.credentials?.salt !== 'string' || !/^[\w-]{22}$/.test(account.credentials.salt) ||
                    typeof account.credentials.hash !== 'string' || !/^[\w-]{43}$/.test(account.credentials.hash)) {
                    throw new StateError(409, '现有账号不可用，未执行首任管理员绑定。');
                }
                return firstAdmin.bind(account);
            }),
            adminList: token => run(async () => {
                const {account: actor} = await admin(token);
                const [members, records] = await Promise.all([
                    users.find({}, {projection: {name: 1}}).sort({name: 1, _id: 1}).toArray(),
                    accounts.find({}, {
                        projection: {
                            memberId: 1,
                            loginName: 1,
                            active: 1,
                            mustChangePassword: 1
                        }
                    }).toArray()
                ]);
                const {account: current} = await admin(token);
                if (!sameVersion(actor, current)) throw badSession();
                const byMember = new Map(records.map(account => [account.memberId, account]));
                return members.map(({_id, name}) => {
                    const account = byMember.get(_id);
                    return {
                        id: _id, name, ...(account && {loginName: account.loginName}),
                        status: !account ? 'unprovisioned' : !account.active ? 'disabled' : account.mustChangePassword ? 'initial' : 'active',
                        isAccountAdmin: _id === current.memberId
                    };
                });
            }),
            adminCommand: (token, op, payload) => run(version => adminCommand(version, token, op, payload))
        }
    };
}
