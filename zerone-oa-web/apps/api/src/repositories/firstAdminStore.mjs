import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {ObjectId} from 'mongodb';
import {hashPassword, verifyPassword} from '../services/passwords.mjs';
import {names, StateError} from './schema.mjs';

const unavailable = () => new StateError(409, '首任管理员初始化未开放或已被占用。');
const incomplete = () => new StateError(503, '初始化尚未完成。请使用原姓名、登录名、密码和部署凭证重试；若无法恢复，请联系部署方核对。');
const sameId = (a, b) => a != null && (a === b || (a instanceof ObjectId && b instanceof ObjectId && a.equals(b)));
const matches = (binding, account) => binding?.state === 'bound' && binding.memberId === account.memberId &&
    sameId(binding.accountId, account._id);
const hasSetupOrigin = account => Object.hasOwn(account, 'setupGeneration');

// UUID 属于集合实例，不是可通过普通数据导入复制的字段。更名或重建后的空库不继承开放资格。
export async function teamGeneration(db) {
    const [info] = await db.listCollections({name: 'team_meta'}).toArray();
    return info?.info?.uuid?.toString('hex');
}

function requestProof(state, {name, loginName, setupKey}) {
    return createHmac('sha256', setupKey).update(JSON.stringify([
        'oa-first-admin-v1', state.generation, state.database, state.memberId, name, loginName
    ])).digest();
}

export function makeFirstAdminStore({db, accounts, addMember}) {
    const meta = db.collection('team_meta');
    const header = () => meta.findOne({_id: 'default'}, {projection: {firstAdmin: 1, version: 1, pending: 1}});
    const read = async () => (await header())?.firstAdmin;
    const owned = async state => typeof state.generation === 'string' && state.database === db.databaseName &&
        state.generation === await teamGeneration(db);
    const atState = state => ({
        _id: 'default', 'firstAdmin.state': state.state,
        'firstAdmin.generation': state.generation, 'firstAdmin.database': state.database
    });

    async function empty(collections) {
        return (await Promise.all(collections.map(name => db.collection(name).findOne({}, {projection: {_id: 1}}))))
            .every(doc => !doc);
    }

    async function available(doc) {
        const state = doc?.firstAdmin;
        if (state?.state !== 'open' && state?.state !== 'pending') return false;
        if (state.state === 'pending') return !doc.pending && [1, 2].includes(doc.version) && await owned(state);
        if (!doc.pending && doc.version === 1 && await owned(state) &&
            await empty([...Object.values(names), 'auth_accounts'])) return true;
        // 只会关闭已记录的开放资格，绝不根据空集合推断或重新创建资格。
        await meta.updateOne({...atState(state), version: doc.version}, {$set: {'firstAdmin.state': 'closed'}});
        return false;
    }

    return {
        async available() {
            return available(await header());
        },
        async access(account) {
            const state = await read();
            const isAdmin = matches(state, account);
            // 账号写入和绑定是两个步骤；重试完成绑定前，即使密码正确也不能登录。
            const allowed = !hasSetupOrigin(account) || (isAdmin && state.source === 'setup' &&
                state.generation === account.setupGeneration);
            return {allowed, isAdmin: allowed && isAdmin};
        },
        async bind(account) {
            if (hasSetupOrigin(account)) throw unavailable();
            const result = await meta.updateOne({
                _id: 'default', pending: {$exists: false}, $or: [
                    {firstAdmin: {$exists: false}}, {'firstAdmin.state': {$in: ['open', 'closed']}}
                ]
            }, {
                $set: {
                    firstAdmin: {
                        state: 'bound', source: 'maintenance', memberId: account.memberId, accountId: account._id,
                        boundAt: new Date()
                    }
                }
            });
            if (!result.matchedCount) throw unavailable();
            return {memberId: account.memberId};
        },
        async setup(validateInput) {
            const doc = await header();
            if (!await available(doc)) throw unavailable();
            const input = validateInput();
            let state = doc.firstAdmin;
            if (state.state === 'open') {
                state = {
                    ...state, state: 'pending', memberId: `u-${randomUUID()}`, auditId: `audit-${randomUUID()}`,
                    accountId: new ObjectId(), name: input.name, loginName: input.loginName, startedAt: new Date(),
                    // 部署凭证证明不含个人密码；只用现有加盐慢哈希核验并开通原账号。
                    credentials: await hashPassword(input.password)
                };
                state.proof = requestProof(state, input).toString('hex');
                const claim = await meta.updateOne({...atState(doc.firstAdmin), version: 1, pending: {$exists: false}},
                    {$set: {firstAdmin: state}}).catch(() => {
                    throw incomplete();
                });
                if (!claim.matchedCount) throw unavailable();
            } else if (!/^[0-9a-f]{64}$/.test(state.proof) ||
                !timingSafeEqual(requestProof(state, input), Buffer.from(state.proof, 'hex')) ||
                !await verifyPassword(input.password, state.credentials)) {
                throw unavailable();
            }

            try {
                const users = db.collection(names.users), audits = db.collection(names.auditLog);
                const createdAt = state.startedAt.toISOString();
                const account = await accounts.findOne({_id: state.accountId});
                const noOtherAccounts = !await accounts.findOne({_id: {$ne: state.accountId}}, {projection: {_id: 1}});
                if (!noOtherAccounts) throw incomplete();
                if (doc.version === 1) {
                    if (account || !await empty(Object.values(names))) throw incomplete();
                    await addMember(doc.version, state.name, {
                        memberId: state.memberId, auditId: state.auditId, createdAt, setup: true
                    });
                } else {
                    // 仅恢复这次请求按事先持久化的 ID 写入的成员及其 joined 记录，不接管同名或既有账号。
                    const user = await users.findOne({_id: state.memberId, name: state.name, createdAt, _batch: 2});
                    const joined = await audits.findOne({
                        _id: state.auditId, entityType: 'user', entityId: state.memberId,
                        actorId: state.memberId, action: 'joined', createdAt, _batch: 2
                    });
                    if (!user || !joined || await users.findOne({_id: {$ne: state.memberId}}) ||
                        await audits.findOne({_id: {$ne: state.auditId}}) || !await empty(Object.values(names)
                            .filter(name => name !== names.users && name !== names.auditLog))) throw incomplete();
                }

                if (!account) {
                    await accounts.insertOne({
                        _id: state.accountId, memberId: state.memberId, loginName: state.loginName,
                        credentials: state.credentials, active: true, credentialVersion: 1,
                        mustChangePassword: false, setupGeneration: state.generation
                    });
                } else if (account.memberId !== state.memberId || account.loginName !== state.loginName ||
                    account.active !== true || account.credentialVersion !== 1 || account.mustChangePassword !== false ||
                    account.setupGeneration !== state.generation || account.credentials?.salt !== state.credentials.salt ||
                    account.credentials?.hash !== state.credentials.hash) {
                    throw incomplete();
                }

                const result = await meta.updateOne({
                    ...atState(state), 'firstAdmin.accountId': state.accountId,
                    version: 2, pending: {$exists: false}
                }, {
                    $set: {
                        firstAdmin: {
                            state: 'bound', source: 'setup', generation: state.generation, memberId: state.memberId,
                            accountId: state.accountId, boundAt: new Date()
                        }
                    }
                });
                if (!result.matchedCount) throw incomplete();
                return {memberId: state.memberId};
            } catch {
                // 不向调用方传递包含数据库写入参数的驱动错误；原请求可以恢复，已完成时可直接登录。
                throw incomplete();
            }
        },
        async assertNoPendingSetup() {
            if ((await read())?.state === 'pending') throw unavailable();
        },
        async checkNotReserved(memberId) {
            const state = await read();
            if (state?.state === 'pending' && state.memberId === memberId) throw unavailable();
        }
    };
}
