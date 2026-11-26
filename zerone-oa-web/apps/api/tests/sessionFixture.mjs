import {randomBytes, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {MongoClient} from 'mongodb';
import {createApiServer} from '../src/app.mjs';
import {openStore} from '../src/repositories/mongoStore.mjs';
import {StateError} from '../src/repositories/schema.mjs';

// 只用于独立路由测试；应用没有跳过身份验证的开关。
export function fixtureAccounts(isAdmin = () => false) {
    const sessions = new Map();
    return {
        async login(loginName, password) {
            if (password !== '合成测试口令' || !['member-a', 'member-b'].includes(loginName)) throw new StateError(401, '登录名或密码错误。');
            const token = randomBytes(32).toString('hex');
            const data = {
                user: {id: loginName, name: loginName, color: '#000'},
                mustChangePassword: false,
                expiresAt: new Date(Date.now() + 3600000).toISOString()
            };
            sessions.set(token, data);
            return {token, ...data};
        },
        async session(token) {
            if (!sessions.has(token)) throw new StateError(401, '请重新登录。');
            const session = sessions.get(token);
            return {...session, isAccountAdmin: isAdmin(session.user.id)};
        },
        async logout(token) {
            sessions.delete(token);
        }
    };
}

export async function signedHeaders(base, loginName = 'member-a', password = '合成测试口令') {
    const bootstrap = await fetch(`${base}/api/csrf`);
    const {csrfToken} = await bootstrap.json();
    const response = await fetch(`${base}/api/login`, {
        method: 'POST', headers: {
            'Content-Type': 'application/json', Origin: base,
            'X-OA-CSRF': csrfToken, Cookie: bootstrap.headers.getSetCookie()[0].split(';')[0]
        },
        body: JSON.stringify({loginName, password})
    });
    const data = await response.json();
    if (response.status !== 200) throw new Error(`测试登录失败：${response.status} ${data.error}`);
    return {Origin: base, Cookie: response.headers.getSetCookie()[0].split(';')[0], 'X-OA-CSRF': data.csrfToken};
}

export function isolatedAgentApi(t) {
    // 写入、迁移和清理只使用本地测试端口上的随机库，不读取环境中的生产连接串。
    const uri = `mongodb://127.0.0.1:27018/oa_test_${randomUUID().replaceAll('-', '')}?retryWrites=false`;
    const inspect = new MongoClient(uri, {serverSelectionTimeoutMS: 4_000});
    const db = inspect.db();
    let store, server;

    async function close() {
        try {
            if (server?.listening) {
                await new Promise(resolve => {
                    server.close(resolve);
                    server.closeAllConnections();
                });
            }
        } finally {
            server = undefined;
            if (store) {
                const current = store;
                store = undefined;
                await current.close();
            }
        }
    }

    t.after(async () => {
        try {
            await close();
        } finally {
            try {
                await db.dropDatabase();
            } finally {
                await inspect.close();
            }
        }
    });
    return {
        uri, db, async boot(completeAi = async () => {
            throw new Error('此步骤不应调用模型');
        }, {readPolicy, isAdmin} = {}) {
            // 重启时只保留测试库，新服务重新发放合成登录会话。
            await close();
            store = await openStore(uri);
            await store.initialize();
            let base;
            server = createApiServer({...store, auth: fixtureAccounts(isAdmin)}, {
                readPolicy,
                origin: () => base,
                setupKey: '',
                completeAi
            });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            base = `http://127.0.0.1:${server.address().port}`;
            const makeRequest = (auth = {}) => async (path, {method = 'GET', body, raw, stream, signal} = {}) => {
                const response = await fetch(`${base}${path}`, {
                    method, body: JSON.stringify(body), signal: signal ? AbortSignal.any([t.signal, signal]) : t.signal,
                    headers: {
                        'Content-Type': 'application/json', Origin: base, ...auth,
                        ...(stream && {Accept: 'application/x-ndjson'})
                    }
                });
                return raw || stream ? response : {status: response.status, ...await response.json()};
            };
            return {anonymous: makeRequest(), browser: async actor => makeRequest(await signedHeaders(base, actor))};
        }
    };
}
