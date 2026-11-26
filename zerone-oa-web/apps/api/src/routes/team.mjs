import {MongoNetworkError, MongoServerSelectionError} from 'mongodb';
import {StateError} from '../repositories/mongoStore.mjs';
import {refreshReminders} from '../services/reminders.mjs';
import {sendJson, readBody} from './http.mjs';
import {queryReports} from '../services/reportQuery.mjs';

function validatePatch(body, user) {
    if (!Array.isArray(body?.changes) || body.state) throw new StateError(400, '请按业务记录提交。');
    if (body.actorId !== undefined && body.actorId !== user.id) throw new StateError(403, '操作者与登录账号不一致。');
    const members = body.changes.filter(c => c?.key === 'users');
    if (members.length) throw new StateError(403, `网页保存不能变更成员身份，请先核对成员：${members.slice(0, 5).map(c => String(c.id).slice(0, 80)).join('、')}`);
    for (const c of body.changes) {
        if (c?.key === 'auditLog' && (c.before !== null || !c.after || c.after.actorId !== user.id)) {
            throw new StateError(403, '不能覆盖历史操作或代其他成员署名。');
        }
    }
    return body.changes.map(c => c?.key === 'auditLog' ? {...c, after: {...c.after, actorId: user.id}} : c);
}

export async function handleRequest(store, request, response, zeroAi, authorize) {
    if (request.method === 'OPTIONS') return sendJson(response, 200, {});
    try {
        const url = new URL(request.url || '/', 'http://localhost');
        const principal = await authorize(request, response, url);
        if (!principal) return;
        if (url.pathname.startsWith('/api/zeroai/v2/')) return await zeroAi(request, response, url, principal);
        // 慢查询或排队保存完成时会话可能已撤销，不再把业务快照交给旧会话。
        const sendBusiness = async payload => {
            await principal.verify();
            return sendJson(response, 200, payload);
        };
        if (request.method === 'GET' && url.pathname === '/api/state') {
            return await sendBusiness({state: await store.read()});
        }
        if (request.method === 'GET' && url.pathname === '/api/daily-reports') {
            return await sendBusiness(await queryReports(store, url.searchParams));
        }
        if (request.method === 'PUT' && url.pathname === '/api/state') {
            const body = await readBody(request, 32 * 1024 * 1024);
            const changes = validatePatch(body, principal.user);
            return await sendBusiness({state: await store.patch(body.baseVersion, changes, principal.verify)});
        }
        if (request.method === 'POST' && url.pathname === '/api/ai-reminders') {
            const body = await readBody(request, 4096);
            return await sendBusiness({state: await refreshReminders(store, body?.weekId, principal.verify)});
        }
        if (request.method === 'POST' && url.pathname === '/api/client-log') {
            const body = await readBody(request, 32 * 1024);
            await principal.verify();
            // 诊断只记经验证的署名和条数，不打印任意客户端载荷或凭据。
            console.info('[client-log]', principal.user.id, '事件数：', Math.min(50, Array.isArray(body?.events) ? body.events.length : 0));
            return sendJson(response, 200, {ok: true});
        }
        sendJson(response, 404, {error: '未找到接口。'});
    } catch (error) {
        if (response.destroyed || response.headersSent) {
            response.end();
            return;
        }
        if (error instanceof StateError) {
            if (error.status === 429) response.setHeader('Retry-After', '300');
            sendJson(response, error.status, {error: error.message, ...(error.code ? {code: error.code} : {})});
        } else if (error instanceof RangeError) sendJson(response, 413, {error: '请求体过大。'});
        else if (error instanceof SyntaxError) sendJson(response, 400, {error: '无法读取 JSON。'});
        else if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError) {
            sendJson(response, 503, {error: '无法确认数据库读写结果，请检查 MongoDB 连接。'});
        } else {
            console.error('OA 请求处理失败：', error.name, error.code ?? '');
            sendJson(response, 500, {error: '服务端处理失败。'});
        }
    }
}
