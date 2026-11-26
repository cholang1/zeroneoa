import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {StateError} from '../repositories/schema.mjs';
import {readBody, sendJson} from './http.mjs';
import {createFirstSetup, handleMemberAdmin} from './memberAdmin.mjs';

const sid = '__Host-oa_sid', pre = '__Host-oa_pre';
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;

function getCookie(request, name) {
    const pairs = (request.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
    const value = pairs.length === 1 && pairs[0].slice(name.length + 1);
    return value && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : '';
}

// 绑定不可预测的 HttpOnly Cookie；浏览器只取得用途隔离的摘要，不能用摘要换回会话。
const csrf = (kind, secret) => createHash('sha256').update(`${kind}\0${secret}`).digest('base64url');

function checkCsrf(request, kind, secret) {
    const supplied = request.headers['x-oa-csrf'];
    if (!secret || typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(csrf(kind, secret)), Buffer.from(supplied))) {
        const err = new StateError(403, '页面安全凭证无效，请刷新后重试。');
        err.code = 'CSRF_INVALID';
        throw err;
    }
}

export function configuredOrigin(value = process.env.OA_PUBLIC_ORIGIN) {
    const production = process.env.NODE_ENV === 'production';
    if (!value && production) throw new Error('正式环境必须配置 OA_PUBLIC_ORIGIN。');
    const url = new URL(value || 'http://127.0.0.1:5178');
    if (url.origin !== (value || url.origin) || (url.protocol !== 'https:' &&
        (production || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('OA_PUBLIC_ORIGIN 必须是精确 HTTPS 源；仅本地开发可使用回环 HTTP。');
    }
    return url.origin;
}

function limitLogins() {
    const buckets = new Map();
    let pruneAt = 0;
    return (key, max) => {
        const now = Date.now();
        if (now >= pruneAt) {
            for (const [k, b] of buckets) if (b.end <= now) buckets.delete(k);
            pruneAt = now + 60_000;
        }
        let b = buckets.get(key);
        if (!b || b.end <= now) {
            if (!b && buckets.size >= 8192) throw new StateError(429, '登录过于频繁，请稍后再试。');
            buckets.set(key, b = {count: 0, end: now + 5 * 60_000});
        }
        if (++b.count > max) throw new StateError(429, '登录过于频繁，请稍后再试。');
    };
}

export function createAccess(store, origin = configuredOrigin(), setupKey) {
    const setup = createFirstSetup(store.auth, setupKey);
    const limit = limitLogins();
    const active = new Set();
    const closeMatching = predicate => {
        for (const entry of active) if (predicate(entry)) entry.response.destroy();
    };
    return async function authorize(request, response, url) {
        const method = request.method, path = url.pathname;
        const send = (status, body) => {
            sendJson(response, status, body);
            return null;
        };
        const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        if (writing) {
            if (request.headers.origin !== (typeof origin === 'function' ? origin() : origin)) {
                return send(403, {code: 'ORIGIN_INVALID', error: '请求来源不受信任。'});
            }
            if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
                return send(415, {error: '请使用 JSON 提交。'});
            }
        }
        if (method === 'GET' && path === '/api/csrf') {
            const nonce = randomBytes(32).toString('base64url');
            response.setHeader('Set-Cookie', cookie(pre, nonce, 600));
            return send(200, {csrfToken: csrf('login', nonce)});
        }
        if (method === 'GET' && path === '/api/setup/status') {
            return send(200, {available: await setup.available()});
        }
        if (method === 'POST' && path === '/api/setup/register') {
            checkCsrf(request, 'login', getCookie(request, pre));
            limit(`setup:${request.socket.remoteAddress}`, 12);
            const existing = getCookie(request, sid);
            if (existing) {
                try {
                    await store.auth.session(existing);
                    return send(409, {error: '已登录的会话不能进行首次注册。'});
                } catch (error) {
                    // 过期的浏览器 Cookie 不阻止全新库部署；数据库不可用时不绕开检查。
                    if (!(error instanceof StateError && error.status === 401)) throw error;
                }
            }
            await setup.register(request);
            response.setHeader('Set-Cookie', cookie(pre, '', 0));
            return send(201, {ok: true});
        }
        if (method === 'POST' && path === '/api/login') {
            checkCsrf(request, 'login', getCookie(request, pre));
            limit(`source:${request.socket.remoteAddress}`, 100);
            const body = await readBody(request, 4096);
            if (typeof body?.loginName !== 'string' || !body.loginName.trim() || body.loginName.length > 128 ||
                typeof body.password !== 'string' || !body.password || body.password.length > 512) {
                return send(400, {error: '请输入登录名和密码。'});
            }
            limit(`name:${body.loginName.normalize('NFKC').trim().toLowerCase()}`, 12);
            const {
                token,
                user,
                mustChangePassword,
                expiresAt,
                isAccountAdmin
            } = await store.auth.login(body.loginName, body.password);
            response.setHeader('Set-Cookie', [cookie(sid, token, Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000))), cookie(pre, '', 0)]);
            return send(200, {
                user,
                mustChangePassword,
                expiresAt,
                isAccountAdmin: isAccountAdmin === true && !mustChangePassword,
                csrfToken: csrf('session', token)
            });
        }
        const token = getCookie(request, sid);
        if (!token) return send(401, {code: 'UNAUTHENTICATED', error: '请登录后继续。'});
        const principal = await store.auth.session(token);
        if (writing) checkCsrf(request, 'session', token);
        else if (request.headers['x-oa-csrf'] !== undefined && request.headers['x-oa-csrf'] !== csrf('session', token)) {
            // 另一个标签页已更换 Cookie；旧工作区不能接收新主体的数据。
            return send(401, {code: 'SESSION_CHANGED', error: '登录会话已更换，请重新进入工作台。'});
        }
        if (method === 'GET' && path === '/api/session') {
            const {user, mustChangePassword, expiresAt, isAccountAdmin} = principal;
            return send(200, {
                user,
                mustChangePassword,
                expiresAt,
                isAccountAdmin: isAccountAdmin === true && !mustChangePassword,
                csrfToken: csrf('session', token)
            });
        }
        if (method === 'POST' && path === '/api/logout') {
            await store.auth.logout(token);
            closeMatching(e => e.token === token);
            response.setHeader('Set-Cookie', cookie(sid, '', 0));
            return send(200, {ok: true});
        }
        if (method === 'POST' && path === '/api/password/change') {
            const body = await readBody(request, 4096);
            if (typeof body?.currentPassword !== 'string' || typeof body.newPassword !== 'string') return send(400, {error: '请输入当前口令及新密码。'});
            limit(`change:${principal.user.id}`, 12);
            await store.auth.changePassword(token, body.currentPassword, body.newPassword);
            closeMatching(e => e.memberId === principal.user.id);
            response.setHeader('Set-Cookie', cookie(sid, '', 0));
            return send(200, {ok: true});
        }
        if (principal.mustChangePassword) return send(403, {
            code: 'PASSWORD_CHANGE_REQUIRED',
            error: '请先修改初始密码。'
        });
        if (path === '/api/admin/members' || path.startsWith('/api/admin/members/')) {
            return await handleMemberAdmin({
                request, path, send, principal, auth: store.auth, token, limit,
                closeMemberStreams: memberId => closeMatching(e => e.memberId === memberId)
            });
        }
        const verify = async () => {
            const current = await store.auth.session(token);
            if (current.mustChangePassword || current.user.id !== principal.user.id) throw new StateError(401, '登录已失效。');
            return current;
        };
        // 聊天可能保持连接；不能只在打开流的那一刻检查有效期。
        if (path.startsWith('/api/zeroai/v2/')) {
            const entry = {memberId: principal.user.id, token, response};
            active.add(entry);
            const timer = setTimeout(() => response.destroy(), Math.max(1, Date.parse(principal.expiresAt) - Date.now()));
            timer.unref();
            response.once('close', () => {
                clearTimeout(timer);
                active.delete(entry);
            });
            // 复核期间若另一请求重置/停用账号，已登记的流也会被关闭。
            await verify();
            if (response.destroyed) return null;
        }
        return {user: principal.user, verify};
    };
}
