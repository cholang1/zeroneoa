import {createHash, timingSafeEqual} from 'node:crypto';
import {StateError} from '../repositories/schema.mjs';
import {readBody} from './http.mjs';

const fields = new Map([
    ['create', ['name', 'loginName']],
    ['provision', ['memberId', 'loginName']],
    ['reset', ['memberId', 'currentPassword']],
    ['disable', ['memberId', 'currentPassword']]
]);

async function readFields(request, keys) {
    const body = await readBody(request, 8192);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key) ||
            typeof body[key] !== 'string' || !body[key] || body[key].length > 512)) {
        throw new StateError(400, '请核对所需字段，不要提交额外的账号数据。');
    }
    return body;
}

const digest = value => createHash('sha256').update(value).digest();

export function createFirstSetup(auth, setupKey) {
    if (setupKey && (typeof setupKey !== 'string' || setupKey.length < 32 || setupKey.length > 256 || !setupKey.isWellFormed() || /[\s\p{Cc}\p{Cf}]/u.test(setupKey))) {
        throw new StateError(503, 'OA_SETUP_KEY 需为 32 至 256 位不含空白的随机初始化凭证。');
    }
    const expected = setupKey ? digest(setupKey) : null;
    const available = async () => Boolean(expected) && await auth.setupAvailable();
    return {
        available,
        async register(request) {
            if (!expected) throw new StateError(404, '未开放首次注册。');
            const input = await readFields(request, ['setupKey', 'name', 'loginName', 'password']);
            if (!timingSafeEqual(digest(input.setupKey), expected)) throw new StateError(403, '初始化凭证不正确。');
            // 资格与唯一占用在仓储内同一写队列裁定，不能根据登录页之前看到的状态放行。
            await auth.setupFirstAdmin(input);
        }
    };
}

export async function handleMemberAdmin({request, path, send, principal, auth, token, closeMemberStreams, limit}) {
    if (principal.isAccountAdmin !== true) throw new StateError(403, '只有账号管理员可以管理成员。');
    if (path === '/api/admin/members' && request.method === 'GET') {
        const members = await auth.adminList(token);
        return send(200, {
            members: members.map(({id, name, loginName, status, isAccountAdmin}) =>
                ({id, name, loginName, status, isAccountAdmin: isAccountAdmin === true}))
        });
    }
    const op = path.slice('/api/admin/members/'.length);
    if (request.method !== 'POST' || !fields.has(op)) throw new StateError(404, '未找到此成员管理操作。');
    const input = await readFields(request, fields.get(op));
    if (op === 'reset' || op === 'disable') {
        // 与普通改密共用尝试上限，防止把管理操作当作密码校验接口。
        limit(`change:${principal.user.id}`, 12);
    }
    const revokes = op === 'reset' || op === 'disable';
    let result;
    try {
        result = await auth.adminCommand(token, op, input);
    } catch (error) {
        // 503 可能意味着撤销已写入而审计结果尚未确认。让目标的长连接重新验身，不继续推送。
        if (revokes && error.status === 503) closeMemberStreams(input.memberId);
        throw error;
    }
    if (revokes) closeMemberStreams(result.memberId);
    // 操作可能已经落库；会话若已撤销，不再向旧页面交付初始口令。
    const current = await auth.session(token);
    if (current.isAccountAdmin !== true || current.mustChangePassword) throw new StateError(403, '当前账号不能领取操作结果。');
    return send(op === 'create' || op === 'provision' ? 201 : 200, {
        memberId: result.memberId,
        ...(result.initialPassword && op !== 'disable' ? {initialPassword: result.initialPassword} : {})
    });
}
