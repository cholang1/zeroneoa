import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer as createHttpServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preview} from 'vite';
import {chromium} from 'playwright-core';
import {createApiServer} from '../../api/src/app.mjs';
import {openStore} from '../../api/src/repositories/mongoStore.mjs';
import {StateError} from '../../api/src/repositories/schema.mjs';

const {MongoClient} = createRequire(new URL('../../api/package.json', import.meta.url))('mongodb');
const stateRoute = /^http:\/\/localhost:\d+\/api\/state$/;
const recoveryKey = memberId => `oa-v2-pending-recovery-${encodeURIComponent(memberId)}`;
const reportDraftKey = memberId => `oa-v3-report-drafts-${JSON.stringify([memberId, memberId])}`;
const loginNameField = page => page.getByLabel('登录名', {exact: true});
const zeroAiPrefix = '/api/zeroai/';
const zeroAiV2Prefix = `${zeroAiPrefix}v2/`;
const zeroAiSessions = `${zeroAiV2Prefix}sessions`;
const zeroAiCapabilities = `${zeroAiV2Prefix}capabilities`;
const newPassword = () => `Oa!Test-${randomUUID()}`;
const initialDetail = '首条验收日报';
const editedDetail = '首条验收日报（已编辑）';
const markdownReply = '## 日报草稿\n\n- 已完成 **测试**\n- 检查 `ZeroAI`\n\n| 项目 | 进度 |\n| --- | --- |\n| OA | 进行中 |\n\n```text\n测试通过\n```';
const tab = (page, name) => page.locator('nav').getByRole('button', {name, exact: true}).click();
const button = (scope, name) => scope.getByRole('button', {name, exact: true});
const heading = (scope, name) => scope.getByRole('heading', {name, exact: true});
const label = (scope, name) => scope.getByLabel(name, {exact: true});
const picker = (scope, name) => scope.getByRole('button', {name: new RegExp(`^${name}：`)});
const pickerList = (scope, name) => scope.getByRole('listbox', {name, exact: true});
const option = (list, name) => list.getByRole('option', {name, exact: true});

async function choose(scope, name, value) {
    await picker(scope, name).click();
    const list = pickerList(scope, name);
    await option(list, value).click();
    await list.waitFor({state: 'hidden'});
}

async function assertPickerInViewport(list) {
    await list.waitFor();
    assert.ok(await list.evaluate(element => {
        const {left, right, top, bottom} = element.getBoundingClientRect();
        return left >= -1 && top >= -1 && right <= window.innerWidth + 1 && bottom <= window.innerHeight + 1;
    }), '窄屏下列表不应超出视口');
}

const hasFocus = locator => locator.evaluate(element => element === document.activeElement);
const isStatePut = request => request.url().endsWith('/api/state') && request.method() === 'PUT';
const saved = page => page.waitForResponse(r => isStatePut(r.request()) && r.status() === 200);
const idle = page => page.locator('.sync-pill:not(.saving)').waitFor();
const work = async page => {
    await tab(page, '工作内容');
    await page.getByPlaceholder('今天做了什么').waitFor();
};

const posted = (page, path) => page.waitForResponse(response =>
    new URL(response.url()).pathname === path && response.request().method() === 'POST');

async function signIn(page, {loginName, password}) {
    await loginNameField(page).fill(loginName);
    await page.getByLabel('密码', {exact: true}).fill(password);
    const [response] = await Promise.all([
        posted(page, '/api/login'), page.getByRole('button', {name: '登录', exact: true}).click()
    ]);
    return response;
}

async function enter(page, url, account) {
    if (url) await page.goto(url);
    assert.equal((await signIn(page, account)).status(), 200);
    await page.locator('nav').waitFor();
}

async function signOut(page) {
    await page.getByTitle('菜单').click();
    const [response] = await Promise.all([
        posted(page, '/api/logout'), page.getByRole('button', {name: '退出登录', exact: true}).click()
    ]);
    assert.equal(response.status(), 200);
    await loginNameField(page).waitFor();
}

// 使用本页真实 cookie 和浏览器生成的 Origin；直接写入也获取有效会话的 CSRF。
const browserApi = (page, path, data, method = 'PUT') => page.evaluate(async ({path, data, method}) => {
    let options;
    if (data !== undefined) {
        const session = await fetch('/api/session');
        if (!session.ok) throw new Error(`测试会话不可用：${session.status}`);
        const {csrfToken} = await session.json();
        options = {
            method,
            headers: {'Content-Type': 'application/json', 'X-OA-CSRF': csrfToken},
            body: JSON.stringify(data)
        };
    }
    const response = await fetch(path, options);
    return {status: response.status, body: await response.json()};
}, {path, data, method});

async function seedAccounts(store) {
    const accounts = [
        {user: {id: 'test-primary', name: '验收成员', color: '#3574ab'}, loginName: 'oa-browser-primary'},
        {user: {id: 'test-chat', name: 'ZeroAI 验收成员', color: '#7265a4'}, loginName: 'oa-browser-chat'},
        {user: {id: 'test-other', name: '并发成员', color: '#21826d'}, loginName: 'oa-browser-other'}
    ];
    await store.patch((await store.read()).version, accounts.map(({user}) => ({
        key: 'users', id: user.id, before: null, after: user
    })));
    for (const account of accounts) {
        const {user, loginName} = account;
        const initialPassword = await store.auth.provision(user.id, loginName);
        assert.ok(typeof initialPassword === 'string' && initialPassword.length > 0, '合成成员应获得初始口令');
        account.password = newPassword();
        if (account === accounts[0]) {
            account.initialPassword = initialPassword;
        } else {
            const {token, mustChangePassword} = await store.auth.login(loginName, initialPassword);
            assert.equal(mustChangePassword, true);
            await store.auth.changePassword(token, initialPassword, account.password);
        }
    }
    return accounts;
}

async function submit(page, text) {
    await page.getByPlaceholder('今天做了什么').fill(text);
    await page.getByRole('button', {name: '保存填写行'}).click();
}

async function holdNextStatePut(page) {
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    let held = false;
    const handler = async route => {
        if (!held && isStatePut(route.request())) {
            held = true;
            await gate;
        }
        await route.continue();
    };
    await page.route(stateRoute, handler);
    return {
        release,
        async close() {
            release();
            await page.unroute(stateRoute, handler);
        }
    };
}

const reportChanges = request => request.postDataJSON().changes.filter(change => change.key === 'dailyReports');
const mongoReport = ({id, ...fields}) => ({_id: id, ...fields});
const businessFields = {projection: {_batch: 0, _seq: 0}};
const byId = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));

async function browserFixture(t, {
    setupKey = '', readPolicy, completeAi = async () => {
        throw new Error('浏览器测试未配置 AI 模拟回复');
    }
} = {}) {
    const name = `oa_test_browser_${randomUUID().replaceAll('-', '')}`;
    const uri = `mongodb://127.0.0.1:27018/${name}?retryWrites=false&directConnection=true`;
    const client = new MongoClient(uri, {serverSelectionTimeoutMS: 4000});
    const db = client.db(name);
    let store, api, web, browser, url;
    const unexpectedChatRequests = [];
    t.after(async () => {
        const errors = [];
        for (const cleanup of [
            () => browser?.close(),
            () => web?.close(),
            () => api?.listening && new Promise((resolve, reject) => api.close(error => error ? reject(error) : resolve())),
            () => store?.close(),
            () => store && db.dropDatabase(),
            () => client.close()
        ]) {
            try {
                await cleanup();
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length) throw new AggregateError(errors, '关闭浏览器测试资源或销毁独立数据库失败');
        assert.deepEqual(unexpectedChatRequests, [], '所有 ZeroAI 请求必须走 v2');
    });
    store = await openStore(uri);
    await store.initialize();
    await client.connect();
    api = createApiServer(store, {setupKey, origin: () => url, completeAi, readPolicy});
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    web = await preview({
        root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
        preview: {host: 'localhost', port: 0, proxy: {'/api': `http://127.0.0.1:${api.address().port}`}}
    });
    // Chromium 将 localhost 当安全上下文，使用真实 Secure Cookie，不添加安全豁免。
    url = `http://localhost:${web.httpServer.address().port}`;
    browser = await chromium.launch({channel: process.env.OA_BROWSER_CHANNEL || 'msedge', headless: true});
    const newPage = async (options = {}) => {
        const page = await browser.newPage({serviceWorkers: 'block', ...options});
        page.context().on('request', request => {
            const {pathname} = new URL(request.url());
            if (pathname.startsWith(zeroAiPrefix) && !pathname.startsWith(zeroAiV2Prefix)) {
                unexpectedChatRequests.push(`${request.method()} ${pathname}`);
            }
        });
        await page.context().route('**/*', route => new URL(route.request().url()).origin === url
            ? route.continue() : route.abort('blockedbyclient'));
        return page;
    };
    return {name, db, store, url, newPage};
}

test('真实浏览器、HTTP 与独立 MongoDB 团队', {timeout: 150000}, async t => {
    let dailyReplies = 0;
    const {name, db, store, url, newPage} = await browserFixture(t, {
        completeAi: async (messages, {onDelta, signal}) => {
            const question = messages.at(-1).content;
            if (question === '演示流式 Markdown') {
                onDelta(markdownReply);
                await once(signal, 'abort');
                signal.throwIfAborted();
            }
            if (question === '帮我写一份日报' && ++dailyReplies === 2) return {content: '重新生成的日报'};
            return {content: `模拟回复 ${messages.length}：${question}`};
        }
    });
    const [primary, chatMember, otherMember] = await seedAccounts(store);
    const reports = db.collection('daily_reports');
    const page = await newPage({viewport: {width: 1366, height: 900}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await t.test('真实 UI 首登必须改密，改密后重新登录，退出后刷新仍未登录', async () => {
        await page.goto(url);
        assert.equal(await page.evaluate(() => isSecureContext), true);
        const legacyKeys = ['oa-session-user', 'oa-v2-session-user'];
        await page.evaluate(({keys, user}) => {
            for (const key of keys) localStorage.setItem(key, JSON.stringify(user));
        }, {keys: legacyKeys, user: primary.user});
        await page.reload();
        await loginNameField(page).waitFor();
        await page.waitForFunction(keys => keys.every(key => !localStorage.getItem(key)), legacyKeys);
        assert.equal((await browserApi(page, '/api/session')).status, 401);
        assert.equal((await browserApi(page, '/api/state')).status, 401);

        const initial = await signIn(page, {...primary, password: primary.initialPassword});
        assert.equal(initial.status(), 200);
        const restricted = await browserApi(page, '/api/session');
        assert.equal(restricted.status, 200);
        assert.deepEqual(restricted.body.user, primary.user);
        assert.equal(restricted.body.mustChangePassword, true);
        const sid = (await page.context().cookies(url)).find(({name}) => name === '__Host-oa_sid');
        assert.ok(sid, '首登应使用会话 Cookie');
        assert.deepEqual([sid.secure, sid.httpOnly, sid.sameSite, sid.path], [true, true, 'Lax', '/']);
        assert.equal(await page.evaluate(() => document.cookie.includes('__Host-oa_sid')), false);
        const changeHeading = page.getByRole('heading', {name: '修改密码', exact: true});
        await changeHeading.waitFor();
        assert.equal(await page.locator('nav').count(), 0);
        for (const endpoint of ['/api/state', zeroAiSessions]) {
            const blocked = await browserApi(page, endpoint);
            assert.equal(blocked.status, 403);
            assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
        }
        await page.reload();
        await changeHeading.waitFor();
        await page.getByLabel('当前口令', {exact: true}).fill(primary.initialPassword);
        await page.getByLabel('新密码', {exact: true}).fill(primary.password);
        await page.getByLabel('确认新密码', {exact: true}).fill(primary.password);
        const [changed] = await Promise.all([
            posted(page, '/api/password/change'), page.getByRole('button', {name: '修改密码', exact: true}).click()
        ]);
        assert.equal(changed.status(), 200);
        await loginNameField(page).waitFor();
        await assert.rejects(store.auth.session(sid.value), {status: 401});
        assert.equal((await browserApi(page, '/api/session')).status, 401);
        assert.equal((await signIn(page, {...primary, password: primary.initialPassword})).status(), 401);
        await enter(page, null, primary);
        const active = await browserApi(page, '/api/session');
        assert.equal(active.status, 200);
        assert.deepEqual(active.body.user, primary.user);
        assert.equal(active.body.mustChangePassword, false);
        const activeSid = (await page.context().cookies(url)).find(({name}) => name === '__Host-oa_sid');
        assert.ok(activeSid, '重新登录应创建会话 Cookie');
        await signOut(page);
        await assert.rejects(store.auth.session(activeSid.value), {status: 401});
        assert.equal((await browserApi(page, '/api/session')).status, 401);
        assert.equal((await page.context().cookies(url)).some(({name}) => name === '__Host-oa_sid'), false);
        await page.reload();
        await loginNameField(page).waitFor();
        assert.equal(await page.locator('nav').count(), 0);
        await enter(page, null, primary);
    });

    await t.test('ZeroAI 会话菜单、消息工具栏、历史版本、流式停止和窄屏', async () => {
        const chat = await newPage({viewport: {width: 1366, height: 900}});
        try {
            await enter(chat, url, chatMember);
            await tab(chat, 'ZeroAI');
            const input = chat.getByRole('textbox', {name: '消息内容'});
            await chat.getByRole('button', {name: '新建会话'}).click();
            await input.fill('帮我写一份日报');
            await input.press('Enter');
            const log = chat.getByRole('log', {name: '消息'});
            const reply = log.getByText('模拟回复 1：帮我写一份日报', {exact: true});
            await reply.waitFor();
            const prompt = log.getByText('帮我写一份日报', {exact: true});
            const desktopReply = await reply.boundingBox();
            const desktopPrompt = await prompt.boundingBox();
            assert.ok(desktopReply.x < desktopPrompt.x);

            await input.fill('请简短一点');
            await chat.getByRole('button', {name: '发送', exact: true}).click();
            await log.getByText('模拟回复 3：请简短一点').waitFor();
            await chat.getByRole('button', {name: '新建会话'}).click();
            await input.fill('这是另一段会话');
            await input.press('Enter');
            await log.getByText('模拟回复 1：这是另一段会话').waitFor();

            await chat.reload();
            await tab(chat, 'ZeroAI');
            await log.getByText('模拟回复 1：这是另一段会话').waitFor();
            await chat.getByRole('button', {name: '帮我写一份日报', exact: true}).click();
            await log.getByText('模拟回复 3：请简短一点').waitFor();
            assert.equal(await log.getByText('这是另一段会话').count(), 0);

            const otherSession = chat.getByRole('button', {name: '这是另一段会话', exact: true});
            const otherMore = chat.getByRole('button', {name: '这是另一段会话的更多操作'});
            assert.equal(await otherMore.evaluate(button => getComputedStyle(button).opacity), '0');
            await otherSession.hover();
            assert.equal(await otherMore.evaluate(button => getComputedStyle(button).opacity), '1');
            const moreBounds = await otherMore.boundingBox();
            const otherBounds = await otherSession.boundingBox();
            assert.ok(otherBounds.x + otherBounds.width <= moreBounds.x);
            await otherMore.click();
            const sessionMenu = chat.getByRole('group', {name: '会话操作'});
            await sessionMenu.getByRole('button', {name: '重命名'}).waitFor();
            const menuBounds = await sessionMenu.boundingBox();
            assert.ok(Math.abs(menuBounds.x + menuBounds.width - moreBounds.x - moreBounds.width) < 2);
            assert.equal(await sessionMenu.locator('svg').count(), 2);
            await chat.keyboard.press('Escape');
            await sessionMenu.waitFor({state: 'hidden'});

            const firstAnswer = log.locator('.assistant').first();
            const regenerate = firstAnswer.getByRole('button', {name: '重新生成'});
            await regenerate.hover();
            assert.equal(await regenerate.evaluate(button => getComputedStyle(button, '::after').content), '"重新生成"');
            await regenerate.click();
            await log.getByText('重新生成的日报', {exact: true}).waitFor();
            assert.equal(await log.getByText('请简短一点', {exact: true}).count(), 0);
            await firstAnswer.getByRole('button', {name: '上一版本'}).click();
            await log.getByText('模拟回复 3：请简短一点').waitFor();

            const firstPrompt = log.locator('.user').first();
            await firstPrompt.getByRole('button', {name: '编辑'}).click();
            const editor = firstPrompt.getByRole('textbox', {name: '编辑消息'});
            assert.equal(await editor.inputValue(), '帮我写一份日报');
            await editor.fill('帮我写一份周报');
            await firstPrompt.getByRole('button', {name: '发送修改'}).click();
            await log.getByText('模拟回复 1：帮我写一份周报', {exact: true}).waitFor();
            await firstPrompt.getByRole('button', {name: '上一版本'}).click();
            await log.getByText('模拟回复 3：请简短一点').waitFor();
            await chat.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            await firstPrompt.getByRole('button', {name: '复制', exact: true}).click();
            await firstPrompt.getByRole('button', {name: '已复制'}).waitFor();
            assert.equal(await chat.evaluate(() => navigator.clipboard.readText()), '帮我写一份日报');

            await chat.setViewportSize({width: 390, height: 780});
            assert.ok(await chat.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
            const nav = chat.locator('.top-tabs');
            const navBounds = await nav.boundingBox();
            const tabBounds = await nav.getByRole('button', {name: 'ZeroAI', exact: true}).boundingBox();
            assert.ok(tabBounds.x + tabBounds.width <= navBounds.x + navBounds.width);
            const mobileReply = await reply.boundingBox();
            const mobilePrompt = await prompt.boundingBox();
            assert.ok(mobileReply.x < mobilePrompt.x);

            const openSidebar = () => chat.getByRole('button', {name: '打开会话列表'}).click();
            const sessionAction = async (title, action) => {
                await chat.getByRole('button', {name: `${title}的更多操作`, exact: true}).click();
                await sessionMenu.getByRole('button', {name: action, exact: true}).click();
            };
            await openSidebar();
            await sessionAction('帮我写一份日报', '重命名');
            await chat.getByRole('textbox', {name: '会话标题'}).fill('我的工作日报');
            await chat.getByRole('button', {name: '保存标题'}).click();
            await chat.getByRole('heading', {name: '我的工作日报', exact: true}).waitFor();
            await openSidebar();
            await chat.getByRole('button', {name: '我的工作日报', exact: true}).waitFor();

            await chat.getByRole('button', {name: '新建会话'}).click();
            await input.fill('演示流式 Markdown');
            await input.press('Enter');
            const stopButton = chat.getByRole('button', {name: '停止生成', exact: true});
            await log.getByRole('heading', {name: '日报草稿', exact: true}).waitFor();
            assert.ok(await stopButton.isEnabled());
            assert.equal(await log.locator('strong').textContent(), '测试');
            assert.equal(await log.getByRole('table').getByRole('cell', {name: '进行中'}).count(), 1);
            assert.equal(await log.locator('pre code').textContent(), '测试通过\n');
            assert.ok(await chat.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
            await stopButton.click();
            await log.getByText('已停止生成', {exact: true}).waitFor();
            await chat.getByRole('heading', {name: '演示流式 Markdown', exact: true}).waitFor();

            const copy = log.locator('.assistant').getByRole('button', {name: '复制', exact: true});
            await copy.click();
            await log.getByRole('button', {name: '已复制'}).waitFor();
            const clipboard = await chat.evaluate(() => navigator.clipboard.readText());
            assert.equal(clipboard.replaceAll('\r\n', '\n'), markdownReply);

            await chat.reload();
            await tab(chat, 'ZeroAI');
            await log.getByText('已停止生成', {exact: true}).waitFor();
            await log.getByRole('heading', {name: '日报草稿'}).waitFor();
            await openSidebar();
            chat.once('dialog', dialog => dialog.dismiss());
            await sessionAction('演示流式 Markdown', '删除');
            assert.equal(await log.locator('h2').textContent(), '日报草稿');
            chat.once('dialog', dialog => dialog.accept());
            await sessionAction('演示流式 Markdown', '删除');
            await log.getByText('模拟回复 3：请简短一点', {exact: true}).waitFor();
            await openSidebar();
            assert.equal(await chat.getByRole('button', {name: '演示流式 Markdown', exact: true}).count(), 0);
            await chat.getByRole('button', {name: '这是另一段会话', exact: true}).click();
            await log.getByText('模拟回复 1：这是另一段会话', {exact: true}).waitFor();
        } finally {
            await chat.close();
        }
    });

    await t.test('五页主流程、草稿刷新、日报解决状态与窄屏', async () => {
        const saveTask = async title => {
            await page.getByPlaceholder('任务标题（必填）').fill(title);
            const [result] = await Promise.all([saved(page), page.getByTitle('保存', {exact: true}).click()]);
            return (await result.json()).state.tasks.find(task => task.title === title);
        };
        await page.getByRole('button', {name: '＋ 一级'}).click();
        await saveTask('验收任务');
        const addChild = parent => page.locator('.tree-row').filter({has: page.getByText(parent, {exact: true})})
            .getByTitle('添加子任务', {exact: true}).click();
        await addChild('验收任务');
        await saveTask('验收流程');
        await addChild('验收流程');
        const firstTask = await saveTask('验收提交项');
        await addChild('验收流程');
        const pickedTask = await saveTask('验收复核项');

        await work(page);
        const taskPicker = picker(page.locator('.report-table-row.draft'), '选择任务');
        assert.equal(await taskPicker.getAttribute('aria-label'), `选择任务：${firstTask.id} ${firstTask.title}`);
        await taskPicker.click();
        const taskList = pickerList(page, '选择任务');
        await taskList.waitFor();
        assert.equal(await taskList.getByRole('option').count(), 2, '日报只能选三级任务');
        const taskSearch = page.getByRole('combobox', {name: '搜索三级任务编号或关键词'});
        assert.ok(await hasFocus(taskSearch));
        await taskSearch.fill(pickedTask.title);
        const taskLabel = `${pickedTask.id} ${pickedTask.title}`;
        await option(taskList, taskLabel).waitFor();
        assert.equal(await taskList.getByRole('option').count(), 1);
        await page.keyboard.press('Enter');
        await taskList.waitFor({state: 'hidden'});
        assert.ok(await hasFocus(taskPicker));
        await page.getByPlaceholder('今天做了什么').fill(initialDetail);
        await page.reload();
        await work(page);
        assert.equal(await page.getByPlaceholder('今天做了什么').inputValue(), initialDetail);
        assert.equal(await taskPicker.getAttribute('aria-label'), `选择任务：${taskLabel}`);
        await page.getByPlaceholder('h', {exact: true}).fill('2');
        await page.locator('.draft').getByPlaceholder('问题/注意').fill('验收问题');
        const [created] = await Promise.all([saved(page), page.getByRole('button', {name: '保存填写行'}).click()]);
        const {state} = await created.json();
        assert.equal(state.dailyReports.length, 1);
        const [report] = state.dailyReports;
        const ownerId = state.users.find(user => user.name === '验收成员').id;
        assert.deepEqual([report.ownerId, report.detail, report.hours, report.notes], [ownerId, initialDetail, 2, '验收问题']);
        assert.equal(report.taskId, pickedTask.id);
        assert.match(report.date, /^\d{4}-\d{2}-\d{2}$/);
        const payload = created.request().postDataJSON();
        assert.deepEqual(Object.keys(payload).sort(), ['actorId', 'baseVersion', 'changes']);
        assert.equal(payload.actorId, ownerId);
        assert.ok(Number.isSafeInteger(payload.baseVersion));
        assert.deepEqual(reportChanges(created.request()), [{
            key: 'dailyReports',
            id: report.id,
            before: null,
            after: report
        }]);
        assert.deepEqual(await reports.find({
            ownerId,
            date: report.date
        }, businessFields).toArray(), [mongoReport(report)]);
        assert.ok((await reports.indexes()).some(({key}) =>
            Object.keys(key).slice(0, 2).join(',') === 'ownerId,date' && key.ownerId === 1 && key.date === -1
        ), '日报应有以 ownerId、date 开头的复合索引');
        assert.deepEqual(await db.listCollections({name: 'team_states'}, {nameOnly: true}).toArray(), []);

        await tab(page, '问题');
        const [resolved] = await Promise.all([saved(page), page.getByRole('button', {name: '标记已解决'}).click()]);
        const resolvedReport = (await resolved.json()).state.dailyReports.find(row => row.id === report.id);
        assert.equal(resolvedReport.resolved, true);
        assert.deepEqual(await reports.findOne({_id: report.id}, businessFields), mongoReport(resolvedReport));
        await tab(page, '统计');
        assert.equal(await page.locator('.stat-tile').filter({hasText: '日报条数'}).locator('strong').textContent(), '1');
        await tab(page, '数据');
        await page.getByText('数据规则', {exact: true}).waitFor();
        await page.setViewportSize({width: 390, height: 844});
        await page.reload();
        await work(page);
        assert.equal(await page.getByPlaceholder('产出').first().inputValue(), initialDetail);
        assert.equal((await store.read()).dailyReports[0].resolved, true);
        const shot = join(tmpdir(), `${name}.png`);
        await page.screenshot({path: shot});
        t.diagnostic(`窄屏工作台截图：${shot}`);
    });
    await t.test('同一日报的过期修改返回 409，已保存内容不被覆盖', async () => {
        const beforeState = await store.read();
        const before = beforeState.dailyReports.find(row => row.detail === initialDetail);
        const detail = page.getByPlaceholder('产出', {exact: true});
        await detail.fill(editedDetail);
        const [updated] = await Promise.all([saved(page), detail.blur()]);
        const {state} = await updated.json();
        const updatedReport = state.dailyReports.find(row => row.id === before.id);
        assert.equal(updatedReport.detail, editedDetail);
        assert.deepEqual(reportChanges(updated.request()), [{
            key: 'dailyReports', id: before.id, before, after: updatedReport
        }]);
        assert.deepEqual(await reports.findOne({_id: before.id}, businessFields), mongoReport(updatedReport));
        assert.equal(await reports.countDocuments({ownerId: before.ownerId, date: before.date}), 1);

        assert.ok(beforeState.version < state.version);
        const conflict = await browserApi(page, '/api/state', {
            actorId: before.ownerId,
            baseVersion: beforeState.version,
            changes: [{key: 'dailyReports', id: before.id, before, after: {...before, detail: '冲突修改'}}]
        });
        assert.equal(conflict.status, 409);
        assert.deepEqual(await store.read(), state);
        assert.deepEqual(await reports.findOne({_id: before.id}, businessFields), mongoReport(updatedReport));
    });
    await t.test('两个独立浏览器会话：不同日报用旧版本提交时直接成功', async () => {
        const other = await newPage();
        try {
            await enter(other, url, otherMember);
            await work(other);
            // 暂停第二个会话的首个写请求，确保它发往服务端时基准版本已经落后。
            const hold = await holdNextStatePut(other);
            try {
                const [second] = await Promise.all([other.waitForRequest(isStatePut), submit(other, '并发乙')]);
                const [first] = await Promise.all([saved(page), submit(page, '并发甲')]);
                const {state: firstState} = await first.json();
                assert.ok(second.postDataJSON().baseVersion < firstState.version);
                const [firstChange] = reportChanges(first.request());
                const [secondChange] = reportChanges(second);
                assert.notEqual(firstChange.id, secondChange.id);
                assert.equal(firstChange.after.detail, '并发甲');
                assert.equal(secondChange.after.detail, '并发乙');

                hold.release();
                // 检查被暂停的原始请求，而不是客户端重试后的任意一次 200。
                const result = await second.response();
                assert.equal(result?.status(), 200);
                const {state} = await result.json();
                assert.deepEqual(state.dailyReports.map(row => row.detail).sort(), [editedDetail, '并发甲', '并发乙'].sort());
                assert.deepEqual((await store.read()).dailyReports, state.dailyReports);
                await idle(other);
            } finally {
                await hold.close();
            }
        } finally {
            await other.close();
        }
    });
    await t.test('断网保存失败后有本地恢复记录，恢复网络重新加载后只补存一次', async () => {
        const memberKey = recoveryKey(primary.user.id);
        await idle(page);
        await page.route(stateRoute, route => route.abort('internetdisconnected'));
        try {
            await submit(page, '断网后补存');
            await page.waitForFunction(key => !!localStorage.getItem(key), memberKey, {timeout: 45000});
            assert.equal(await reports.countDocuments({detail: '断网后补存'}), 0);
            await idle(page);
        } finally {
            await page.unroute(stateRoute);
        }
        const [recovered] = await Promise.all([saved(page), page.reload()]);
        const {state} = await recovered.json();
        await page.waitForFunction(key => !localStorage.getItem(key), memberKey);
        await idle(page);
        const [change] = reportChanges(recovered.request());
        assert.equal(change.before, null);
        assert.equal(change.after.detail, '断网后补存');
        assert.equal(await reports.countDocuments({detail: '断网后补存'}), 1);
        assert.deepEqual(await reports.findOne({_id: change.id}, businessFields), mongoReport(change.after));
        await page.reload();
        await work(page);
        await idle(page);
        const reloaded = await store.read();
        assert.equal(reloaded.version, state.version);
        assert.deepEqual(reloaded.dailyReports.filter(row => row.detail === '断网后补存'), [change.after]);
        assert.deepEqual(errors, []);
    });
    await t.test('一次写入尚未返回时连续提交两条日报，队列使用最新版本', async () => {
        await work(page);
        const hold = await holdNextStatePut(page);
        const requests = [];
        const recordPut = request => {
            if (isStatePut(request)) requests.push(request);
        };
        page.on('request', recordPut);
        try {
            const [first] = await Promise.all([page.waitForRequest(isStatePut), submit(page, '队列一')]);
            await submit(page, '队列二');
            assert.deepEqual(requests, [first]);
            const next = page.waitForRequest(request => isStatePut(request) && request !== first);
            hold.release();
            const second = await next;
            const [firstResponse, secondResponse] = await Promise.all([first.response(), second.response()]);
            assert.equal(firstResponse?.status(), 200);
            assert.equal(secondResponse?.status(), 200);
            const {state: firstState} = await firstResponse.json();
            assert.equal(second.postDataJSON().baseVersion, firstState.version);
            assert.deepEqual(reportChanges(first).map(change => change.after.detail), ['队列一']);
            assert.deepEqual(reportChanges(second).map(change => change.after.detail), ['队列二']);
            await idle(page);
            assert.deepEqual(requests, [first, second]);
        } finally {
            page.off('request', recordPut);
            await hold.close();
        }
        assert.deepEqual((await store.read()).dailyReports.map(row => row.detail).filter(detail => detail.startsWith('队列')).sort(), ['队列一', '队列二']);
    });
    await t.test('日报评论、每周日历事件和参与者提醒、完整 JSON 导出再导入', async () => {
        await page.setViewportSize({width: 1366, height: 900});
        await page.locator('.day-thread .memo-comment-toggle').click();
        const comment = page.getByPlaceholder(/^评论今天的日报/);
        await comment.fill('验收评论');
        await Promise.all([saved(page), comment.press('Enter')]);
        await tab(page, '总览');
        const memo = page.getByPlaceholder(/^添加本周备忘/);
        await memo.fill('验收备忘提醒');
        const memoRow = page.locator('.memo-row.add').filter({has: memo});
        const memoPicker = picker(memoRow, '备忘提醒');
        const memoList = pickerList(page, '备忘提醒');
        await memoPicker.click();
        await option(memoList, '@全体').click();
        assert.equal(await option(memoList, '@全体').getAttribute('aria-selected'), 'true');
        await option(memoList, chatMember.user.name).click();
        assert.equal(await option(memoList, '@全体').getAttribute('aria-selected'), 'false');
        assert.equal(await option(memoList, chatMember.user.name).getAttribute('aria-selected'), 'true');
        await memo.click();
        await memoList.waitFor({state: 'hidden'});
        await Promise.all([saved(page), button(memoRow, '添加').click()]);

        await page.setViewportSize({width: 390, height: 740});
        await page.getByRole('button', {name: /新建事件/}).click();
        const eventModal = page.locator('.modal').filter({has: heading(page, '新建事件')});
        await eventModal.getByPlaceholder('例如：周例会 / 方案评审').fill('验收例会');
        const repeat = picker(eventModal, '重复');
        const repeats = pickerList(eventModal, '重复');
        await repeat.press('Enter');
        await repeats.waitFor();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await repeats.waitFor({state: 'hidden'});
        assert.equal(await repeat.getAttribute('aria-label'), '重复：每周');
        assert.ok(await hasFocus(repeat));
        await label(eventModal, '重复结束于').waitFor();

        const participant = picker(eventModal, '参与者');
        const participants = pickerList(eventModal, '参与者');
        await participant.click();
        await assertPickerInViewport(participants);
        assert.equal(await participants.getAttribute('aria-multiselectable'), 'true');
        const search = eventModal.getByRole('combobox', {name: '搜索姓名'});
        assert.ok(await hasFocus(search));
        await search.fill(otherMember.user.name);
        const person = option(participants, otherMember.user.name);
        await person.waitFor();
        assert.equal(await participants.getByRole('option').count(), 1);
        await page.keyboard.press('Enter');
        assert.equal(await person.getAttribute('aria-selected'), 'true');
        await search.fill('');
        await option(participants, chatMember.user.name).click();
        assert.equal(await option(participants, chatMember.user.name).getAttribute('aria-selected'), 'true');
        assert.equal(await participants.getByRole('option', {selected: true}).count(), 3);
        await button(eventModal, '完成').click();
        await participants.waitFor({state: 'hidden'});
        assert.ok(await hasFocus(participant));
        await Promise.all([saved(page), button(eventModal, '保存').click()]);
        await eventModal.waitFor({state: 'hidden'});
        await page.setViewportSize({width: 1366, height: 900});
        const mentioned = await newPage();
        try {
            await enter(mentioned, url, otherMember);
            await mentioned.locator('.mention-toast').getByText('验收例会', {exact: false}).first().waitFor();
        } finally {
            await mentioned.close();
        }
        await idle(page);
        await page.getByTitle('菜单').click();
        await page.getByRole('button', {name: '导出数据…'}).click();
        await page.locator('.export-modal').getByRole('button', {name: '全部', exact: true}).click();
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {
            name: '导出',
            exact: true
        }).click()]);
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const exported = JSON.parse(buffer.toString());
        const event = exported.events.find(item => item.title === '验收例会');
        assert.equal(event.recurrence, 'weekly');
        assert.deepEqual([...event.participantIds].sort(), [primary.user.id, chatMember.user.id, otherMember.user.id].sort());
        const savedMemo = exported.memos.find(item => item.text === '验收备忘提醒');
        assert.equal(savedMemo.mentionAll, false);
        assert.deepEqual(savedMemo.mentionUserIds, [chatMember.user.id]);
        assert.ok(exported.dayThreads.some(d => d.comments.some(c => c.text === '验收评论')));
        // 原样导入已存在的数据可以不写入；先删除一条，验证导入确实恢复到快照内容。
        const report = exported.dailyReports.find(row => row.detail === editedDetail);
        assert.equal(report.resolved, true);
        await work(page);
        const row = page.locator('.report-table-row.saved').filter({has: page.locator('input.issue.done')});
        assert.equal(await row.getByPlaceholder('产出', {exact: true}).inputValue(), editedDetail);
        const [deleted] = await Promise.all([saved(page), row.getByRole('button', {name: '删', exact: true}).click()]);
        const {state: deletedState} = await deleted.json();
        assert.deepEqual(reportChanges(deleted.request()), [{
            key: 'dailyReports',
            id: report.id,
            before: report,
            after: null
        }]);
        assert.ok(!deletedState.dailyReports.some(item => item.id === report.id));
        assert.equal(await reports.findOne({_id: report.id}), null);
        assert.equal(await reports.countDocuments({detail: editedDetail}), 0);
        await row.waitFor({state: 'detached'});

        page.once('dialog', dialog => dialog.accept());
        const [restored] = await Promise.all([saved(page), page.locator('input[type=file]').setInputFiles({
            name: 'team.json',
            mimeType: 'application/json',
            buffer
        })]);
        const {state: restoredState} = await restored.json();
        const {version, ...imported} = await store.read();
        const {version: exportedVersion, ...exportedData} = exported;
        assert.equal(deletedState.version, exportedVersion + 1);
        assert.equal(version, deletedState.version + 1);
        assert.equal(restoredState.version, version);
        assert.deepEqual(reportChanges(restored.request()), [{
            key: 'dailyReports',
            id: report.id,
            before: null,
            after: report
        }]);
        assert.deepEqual(Object.keys(imported).sort(), Object.keys(exportedData).sort());
        for (const [key, rows] of Object.entries(exportedData)) {
            if (key !== 'auditLog') assert.deepEqual(byId(imported[key]), byId(rows), `导入应恢复 ${key} 的所有记录`);
        }
        assert.deepEqual(imported.auditLog, deletedState.auditLog, '导入不能覆盖当前可信审计');
        assert.deepEqual(await reports.findOne({_id: report.id}, businessFields), mongoReport(report));
        assert.deepEqual(await db.listCollections({name: 'team_states'}, {nameOnly: true}).toArray(), []);
        assert.deepEqual(errors, []);
    });

    await t.test('保存遇到真实会话过期后锁定：换号不串用草稿、待恢复日报和 ZeroAI 会话', async () => {
        const shared = await newPage({viewport: {width: 1366, height: 900}});
        const memberKey = recoveryKey(primary.user.id);
        const pendingDetail = '仅本人待恢复的日报';
        const primaryDraft = '仅首个成员能看到的草稿';
        const otherDraft = '仅另一成员能看到的草稿';
        const chatTitle = '首个成员的私有会话';
        const draft = shared.getByPlaceholder('今天做了什么');
        try {
            await enter(shared, url, primary);
            await tab(shared, 'ZeroAI');
            await shared.getByRole('button', {name: '新建会话'}).click();
            const input = shared.getByRole('textbox', {name: '消息内容'});
            await input.fill(chatTitle);
            await input.press('Enter');
            await shared.getByRole('log', {name: '消息'}).getByText(`模拟回复 1：${chatTitle}`, {exact: true}).waitFor();
            const owned = await browserApi(shared, zeroAiSessions);
            assert.equal(owned.status, 200);
            const ownedSession = owned.body.sessions.find(({title}) => title === chatTitle);
            assert.ok(ownedSession);
            await input.fill('仅首个成员能看到的 ZeroAI 草稿');

            await work(shared);
            const sid = (await shared.context().cookies(url)).find(({name}) => name === '__Host-oa_sid');
            assert.ok(sid, '已登录成员应有会话 Cookie');
            const hold = await holdNextStatePut(shared);
            try {
                const [request] = await Promise.all([shared.waitForRequest(isStatePut), submit(shared, pendingDetail)]);
                await draft.fill(primaryDraft);
                await shared.waitForFunction(({key, detail}) =>
                        JSON.parse(localStorage.getItem(key) || '[]').some(row => row.detail === detail),
                    {key: reportDraftKey(primary.user.id), detail: primaryDraft});
                // 仅将本测试库的当前会话设成已过期，放行原始请求，由真实 API 拒绝写入。
                const {modifiedCount} = await db.collection('auth_sessions').updateOne(
                    {_id: createHash('sha256').update(sid.value).digest('hex')},
                    {$set: {expiresAt: new Date(Date.now() - 60_000)}}
                );
                assert.equal(modifiedCount, 1);
                hold.release();
                assert.equal((await request.response())?.status(), 401);
                await loginNameField(shared).waitFor();
                await shared.getByText(/登录已失效，请重新登录/).waitFor();
                assert.equal(await shared.locator('nav').count(), 0);
            } finally {
                await hold.close();
            }
            const retained = await shared.evaluate(key => JSON.parse(localStorage.getItem(key)), memberKey);
            assert.ok(retained, '会话失效后应保留原成员的待恢复记录');
            assert.equal(retained.actorId, primary.user.id);
            assert.ok(retained.changes.some(change => change.key === 'dailyReports' && change.after?.detail === pendingDetail));
            assert.equal(await reports.countDocuments({detail: pendingDetail}), 0);

            const writes = [];
            shared.on('request', request => {
                if (isStatePut(request)) writes.push(request);
            });
            await enter(shared, null, otherMember);
            await work(shared);
            assert.equal(await draft.inputValue(), '');
            assert.ok(!(await shared.getByPlaceholder('产出', {exact: true})
                .evaluateAll(inputs => inputs.map(input => input.value))).includes(pendingDetail));
            assert.deepEqual(await shared.evaluate(key => JSON.parse(localStorage.getItem(key)), memberKey), retained);
            await draft.fill(otherDraft);
            await shared.waitForFunction(key => !!localStorage.getItem(key), reportDraftKey(otherMember.user.id));
            await tab(shared, 'ZeroAI');
            const other = await browserApi(shared, zeroAiSessions);
            assert.equal(other.status, 200);
            assert.deepEqual(other.body.sessions, []);
            assert.equal((await browserApi(shared, `${zeroAiSessions}/${ownedSession.id}`)).status, 404);
            await shared.getByText('开始一段对话', {exact: true}).waitFor();
            assert.equal(await input.inputValue(), '');
            assert.equal(await shared.getByRole('button', {name: chatTitle, exact: true}).count(), 0);
            await signOut(shared);
            assert.equal(writes.length, 0, '另一成员不应提交待恢复日报');
            assert.equal(await reports.countDocuments({detail: pendingDetail}), 0);

            const [recovered] = await Promise.all([saved(shared), enter(shared, null, primary)]);
            const [change] = reportChanges(recovered.request());
            assert.equal(change.after.ownerId, primary.user.id);
            assert.equal(change.after.detail, pendingDetail);
            await shared.waitForFunction(key => !localStorage.getItem(key), memberKey);
            await idle(shared);
            await work(shared);
            assert.equal(await draft.inputValue(), primaryDraft);
            await tab(shared, 'ZeroAI');
            await shared.getByRole('button', {name: chatTitle, exact: true}).waitFor();
            await shared.reload();
            await work(shared);
            await idle(shared);
            assert.equal(writes.length, 1, '原成员重登只应发送一次补存请求');
            assert.equal(writes[0], recovered.request());
            assert.equal(await reports.countDocuments({detail: pendingDetail}), 1);
        } finally {
            await shared.close();
        }
    });
});

const adminMembersPath = '/api/admin/members';
const setupStatusPath = '/api/setup/status';
const setupRegisterPath = '/api/setup/register';
const testSetupKey = () => `oa-browser-setup-${randomUUID()}`;
const memberRow = (page, id) => page.getByTestId('admin-member-row').and(page.locator(`[data-member-id="${id}"]`));
const rowStatus = (row, status) => row.getByText(status, {exact: true}).waitFor();

test('P2 本地浏览器：工具活动、历史来源、安全定位与窄屏快捷追问', {timeout: 45000}, async t => {
    const actor = {id: 'p2-member', name: '来源测试成员', color: '#3574ab'};
    const verifiedSession = {user: actor, csrfToken: 'p2-test', mustChangePassword: false};
    const sessionId = 'p2-session';
    const messageId = 'p2-answer';
    const reportId = '日报/2027 ?#';
    const sessionPath = `${zeroAiSessions}/${sessionId}`;
    const refPath = `${sessionPath}/messages/${messageId}/refs/report/`;
    const date = '2027-01-01';
    const report = {
        id: reportId, date, weekId: '2026-W53', ownerId: actor.id, taskId: 'T-1', detail: '原条目',
        hours: 2, notes: '', createdAt: `${date}T10:00:00+08:00`, updatedAt: `${date}T10:00:00+08:00`,
        createdById: actor.id, updatedById: actor.id
    };
    const state = {
        version: 7,
        users: [actor],
        tasks: [{
            id: report.taskId, parentId: null, title: '测试任务',
            description: '', level: 3, order: 0, status: 'active'
        }],
        memos: [],
        weeklyPlans: [],
        dailyReports: [{...report, id: 'same-day-and-task', detail: '不应定位到的相邻行'}, report],
        aiReminders: [],
        events: [],
        dayThreads: [],
        auditLog: []
    };
    const card = {
        name: 'list_daily_reports', label: '日报来源', asOf: '2027-01-01T02:00:00.000Z',
        scopeLabel: '本人，2027-01-01', truncated: true, teamVersion: 7
    };
    const reportRef = (id, label) => ({type: 'report', id, label});
    const originalLabel = `原日报 ${'LongLabel'.repeat(24)}`;
    const queryCards = [
        {
            ...card, refs: [reportRef(reportId, originalLabel), reportRef('removed', '已删除引用'),
                reportRef('revoked', '已撤权引用'), reportRef('stale', '过期引用'), reportRef('mismatch', '旧版本引用'),
                reportRef('wrong-id', '错误实体引用'), reportRef('local-mismatch', '本地版本滞后引用')]
        },
        {...card, name: 'list_tasks', label: '任务目录', refs: [{type: 'task', id: reportId, label: '任务编号复用'}]},
        {...card, label: '缺版本的日报', teamVersion: undefined, refs: [reportRef(reportId, '旧来源无版本')]},
        {...card, label: '无记录的查询', refs: []}
    ];
    const answer = {
        id: messageId, role: 'assistant', content: '## 核对结果\n\n已读到 **本人日报**。', queryCards, status: 'stopped',
        versions: {current: 2, total: 2, previousId: 'p2-alternate'}
    };
    const alternate = {
        id: 'p2-alternate', role: 'assistant', content: '没有来源的旧版本', queryBasis: 'none',
        versions: {current: 1, total: 2, nextId: messageId}
    };
    const session = {
        id: sessionId, title: '本地 P2 会话', branchEpoch: 1, messages: [
            {id: 'plain-question', role: 'user', content: '旧问题'},
            {id: 'plain-answer', role: 'assistant', content: '旧回复没有来源卡'}
        ]
    };
    let toolEnabled = true, finishGeneration, releaseStart, releaseSave, releaseRef;
    let holdOriginal = false;
    const generationRequests = [], refRequests = [], stopRequests = [];
    const readBody = async request => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        return JSON.parse(Buffer.concat(chunks).toString());
    };
    const backend = createHttpServer(async (request, response) => {
        const path = new URL(request.url, 'http://localhost').pathname;
        const json = (body, status = 200) => {
            response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
            response.end(JSON.stringify(body));
        };
        if (path === '/api/session') return json(verifiedSession);
        if (path === '/api/state') {
            if (request.method === 'PUT') {
                const {changes} = await readBody(request);
                releaseSave = () => {
                    state.dailyReports.push(...changes.filter(change => change.key === 'dailyReports').map(change => change.after));
                    state.version++;
                    json({state});
                };
                return;
            }
            return json({state});
        }
        if (path === zeroAiCapabilities) return json({historyV2: true, ...(toolEnabled && {readTools: true})});
        if (path === zeroAiSessions) return json({sessions: [{id: sessionId, title: session.title}]});
        if (path === sessionPath) return json({session});
        if (path === `${sessionPath}/messages`) {
            const body = await readBody(request);
            generationRequests.push(body);
            response.writeHead(200, {'Content-Type': 'application/x-ndjson'});
            const frame = (seq, event) => JSON.stringify({turnId: body.turnId, seq, ...event});
            // 合成乱序：工具事件不能替代 start 来触发预先点下的停止操作。
            response.write(`${frame(1, {type: 'tool', label: '正在读取日报来源'})}\n`);
            releaseStart = () => response.write(`${frame(2, {type: 'start'})}\n`);
            finishGeneration = () => {
                session.messages.push({id: body.turnId, role: 'user', content: body.content}, answer);
                session.branchEpoch++;
                response.end(frame(3, {type: 'result', session}));
            };
            return;
        }
        if (path === `${sessionPath}/messages/stop`) {
            stopRequests.push(await readBody(request));
            if (releaseStart) return json({error: '尚未发出 start'}, 409);
            finishGeneration();
            return json({ok: true});
        }
        if (path === `${sessionPath}/messages/select`) {
            const selection = await readBody(request);
            session.messages[session.messages.length - 1] = selection.messageId === messageId ? answer : alternate;
            session.branchEpoch++;
            return json({session});
        }
        if (path.startsWith(refPath)) {
            const id = decodeURIComponent(path.slice(refPath.length));
            refRequests.push(path);
            if (id === 'removed') return json({error: '记录已删除'}, 404);
            if (id === 'revoked') return json({error: '不再有权限'}, 403);
            if (id === 'stale') return json({error: '数据已变'}, 409);
            if (id === 'mismatch') return json({id, teamVersion: 8});
            if (id === 'wrong-id') return json({id: reportId, teamVersion: 7});
            if (id === reportId && holdOriginal) {
                releaseRef = () => json({id, teamVersion: 7});
                return;
            }
            return json({id, teamVersion: 7});
        }
        json({error: `未配置的模拟请求：${path}`}, 404);
    });
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    t.after(() => {
        backend.close();
        backend.closeAllConnections();
    });
    const web = await preview({
        root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
        preview: {host: 'localhost', port: 0, proxy: {'/api': `http://127.0.0.1:${backend.address().port}`}}
    });
    t.after(() => web.close());
    const url = `http://localhost:${web.httpServer.address().port}`;
    const browser = await chromium.launch({channel: process.env.OA_BROWSER_CHANNEL || 'msedge', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 360, height: 740}, isMobile: true, hasTouch: true});
    page.setDefaultTimeout(7000);
    await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    const input = page.getByRole('textbox', {name: '消息内容'});
    const sourceGroup = page.getByRole('region', {name: '查询来源'});
    const followUp = page.getByRole('group', {name: '快捷追问（仅填入输入框）'});
    const openOriginal = page.getByRole('button', {name: `打开日报：${originalLabel}`, exact: true});
    await page.goto(url);
    await tab(page, 'ZeroAI');
    await page.getByText('旧回复没有来源卡', {exact: true}).waitFor();
    assert.equal(await sourceGroup.count(), 0);
    assert.equal(await followUp.count(), 0);
    await input.fill('请查询我的日报');
    await page.getByRole('button', {name: '发送', exact: true}).click();
    await page.getByText('正在读取日报来源', {exact: true}).waitFor();
    await tab(page, '总览');
    await tab(page, 'ZeroAI');
    await page.getByText('正在读取日报来源', {exact: true}).waitFor();
    await page.getByRole('button', {name: '停止生成', exact: true}).click();
    await page.getByRole('button', {name: '正在停止…', exact: true}).waitFor();
    assert.equal(stopRequests.length, 0);
    const start = releaseStart;
    releaseStart = undefined;
    start();
    await page.getByRole('heading', {name: '核对结果', exact: true}).waitFor();
    assert.deepEqual(stopRequests, [{turnId: generationRequests[0].turnId}]);
    assert.equal(await page.getByText('正在读取日报来源', {exact: true}).count(), 0);
    await page.getByText('已停止生成', {exact: true}).waitFor();
    await sourceGroup.getByText('本人，2027-01-01', {exact: false}).first().waitFor();
    await sourceGroup.getByText('部分结果', {exact: true}).first().waitFor();
    assert.match(await sourceGroup.locator('time').first().innerText(), /10:00/);
    assert.equal(await sourceGroup.getByRole('button', {name: /任务编号复用|旧来源无版本/}).count(), 0);
    await sourceGroup.getByText('没有可定位的记录', {exact: true}).waitFor();
    assert.ok(await page.locator('.zero-ai-log').evaluate(log => log.scrollWidth <= log.clientWidth));

    for (const [label, prompt] of [
        ['总结一下', '请总结一下刚才的 OA 查询结果。'],
        ['有哪些值得关注', '刚才的 OA 查询结果里，有哪些值得关注？'],
        ['给我下一步建议', '请根据刚才的 OA 查询结果，给我下一步建议。']
    ]) {
        await input.fill('手动写的草稿');
        await followUp.getByRole('button', {name: label, exact: true}).click();
        assert.equal(await input.inputValue(), `手动写的草稿\n${prompt}`);
    }
    assert.equal(generationRequests.length, 1, '点击追问只填输入框，不发送');

    for (const [label, notice] of [
        ['已删除引用', '无法定位原日报。请重新查询后再试。'], ['已撤权引用', '无法定位原日报。请重新查询后再试。'],
        ['过期引用', '来源数据版本已变化，请重新查询后再打开。'], ['旧版本引用', '来源数据版本已变化，请重新查询后再打开。'],
        ['错误实体引用', '无法定位原日报。请重新查询后再试。']
    ]) {
        await page.getByRole('button', {name: `打开日报：${label}`, exact: true}).click();
        await page.getByRole('status').filter({hasText: notice}).waitFor();
        assert.equal(await page.getByRole('heading', {name: '工作内容', exact: true}).count(), 0);
    }
    holdOriginal = true;
    const referenceRequest = page.waitForRequest(request => new URL(request.url()).pathname === `${refPath}${encodeURIComponent(reportId)}`);
    await Promise.all([referenceRequest, openOriginal.click()]);
    await page.getByText('正在核对日报来源…', {exact: true}).waitFor();
    await tab(page, '总览');
    holdOriginal = false;
    if (releaseRef) releaseRef();
    await tab(page, 'ZeroAI');
    assert.equal(await page.getByText('正在核对日报来源…', {exact: true}).count(), 0);
    await openOriginal.click();
    const focusedRow = page.getByRole('group', {name: '引用的日报'});
    await focusedRow.waitFor();
    assert.equal(await focusedRow.getAttribute('data-report-id'), reportId);
    assert.equal(await focusedRow.getByPlaceholder('产出').inputValue(), '原条目');
    assert.ok(await focusedRow.evaluate(row => document.activeElement === row));
    assert.ok(refRequests.includes(`${refPath}${encodeURIComponent(reportId)}`));

    await page.getByPlaceholder('今天做了什么').fill('尚未同步的日报');
    await page.getByRole('button', {name: '保存填写行'}).click();
    await tab(page, 'ZeroAI');
    assert.match(await input.inputValue(), /^手动写的草稿/);
    await openOriginal.click();
    await page.getByText('工作台有待同步的更改，请同步后再打开原日报。', {exact: true}).waitFor();
    const stateSaved = saved(page);
    releaseSave();
    await stateSaved;
    await idle(page);
    await page.getByRole('button', {name: '打开日报：本地版本滞后引用', exact: true}).click();
    await page.getByText('工作台与来源版本不同步，请刷新数据或重新查询。', {exact: true}).waitFor();

    await page.reload();
    await tab(page, 'ZeroAI');
    await openOriginal.waitFor();
    await followUp.waitFor();
    await page.getByRole('button', {name: '上一版本', exact: true}).click();
    await page.getByText('没有来源的旧版本', {exact: true}).waitFor();
    await page.getByText('本轮未查询 OA', {exact: true}).waitFor();
    assert.equal(await sourceGroup.count(), 0);
    assert.equal(await followUp.count(), 0);
    await page.getByRole('button', {name: '下一版本', exact: true}).click();
    await sourceGroup.waitFor();
    toolEnabled = false;
    await page.reload();
    await tab(page, 'ZeroAI');
    await sourceGroup.waitFor();
    assert.equal(await followUp.count(), 0);
    assert.match(await input.getAttribute('placeholder'), /当前未开放 OA 查询/);
});

test('P2 本地端到端：真实本人日报查询、来源核对、返回聊天和追问', {timeout: 45000}, async t => {
    const date = '2027-01-01';
    const originalId = 'p2-e2e-original';
    const otherId = 'p2-e2e-other';
    const taskId = 'p2-e2e-task';
    const detail = '本人跨年联调日报';
    const question = '请查 2027-01-01 我的日报';
    const followUp = '请根据刚才的 OA 查询结果，给我下一步建议。';
    const suggestion = '建议把联调步骤补进验收清单。';
    const modelInputs = [], modelResults = [];
    const {store, url, newPage} = await browserFixture(t, {
        readPolicy: {target: 'p2-browser-local', team: false, detail: true},
        completeAi: async (messages, {executeTool}) => {
            modelInputs.push(messages);
            if (messages.at(-1).content === question) {
                const result = await executeTool('list_daily_reports', {from: date, to: date});
                modelResults.push(result);
                return {content: result.ok ? `已查询：${result.data.items.map(row => row.detail).join('、')}` : '查询失败'};
            }
            return {content: suggestion};
        }
    });
    const [, account, other] = await seedAccounts(store);
    const reportChange = (id, ownerId, text) => ({
        key: 'dailyReports', id, before: null, after: {
            id,
            ownerId,
            date,
            weekId: '2026-W53',
            taskId,
            detail: text,
            hours: 2,
            notes: '',
            createdById: ownerId,
            updatedById: ownerId,
            createdAt: `${date}T10:00:00+08:00`,
            updatedAt: `${date}T10:00:00+08:00`
        }
    });
    await store.patch((await store.read()).version, [
        {
            key: 'tasks', id: taskId, before: null, after: {
                id: taskId, parentId: null, title: '跨年联调',
                description: '', level: 1, order: 0, status: 'active'
            }
        },
        reportChange(originalId, account.user.id, detail),
        reportChange(otherId, other.user.id, '同日同任务的另一位成员日报')
    ]);
    const before = await store.read();
    const page = await newPage();
    await enter(page, url, account);
    await tab(page, 'ZeroAI');
    await page.getByText('可以查询 OA，也可以直接聊天。', {exact: true}).waitFor();
    const input = page.getByRole('textbox', {name: '消息内容'});
    const send = page.getByRole('button', {name: '发送', exact: true});
    await input.fill(question);
    await send.click();
    await page.getByText(`已查询：${detail}`, {exact: true}).waitFor();
    assert.deepEqual(modelResults[0].data.items.map(row => row.id), [originalId]);
    assert.equal(Object.hasOwn(modelResults[0], 'refs'), false);
    const verified = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/refs/report/${originalId}`));
    await page.getByRole('button', {name: `打开日报：${date} 日报`, exact: true}).click();
    const response = await verified;
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), {id: originalId, teamVersion: before.version});
    const row = page.getByRole('group', {name: '引用的日报'});
    await row.waitFor();
    assert.equal(await row.getAttribute('data-report-id'), originalId);
    assert.equal(await row.getByPlaceholder('产出').inputValue(), detail);
    await tab(page, 'ZeroAI');
    await page.getByRole('button', {name: '给我下一步建议', exact: true}).click();
    assert.equal(await input.inputValue(), followUp);
    assert.equal(modelInputs.length, 1);
    await send.click();
    await page.getByText(suggestion, {exact: true}).waitFor();
    await page.getByText('沿用此前查询，本轮未刷新', {exact: true}).waitFor();
    assert.equal(modelInputs[1].at(-1).content, followUp);
    assert.match(JSON.stringify(modelInputs[1]), /当时的只读查询结果/);
    assert.deepEqual(await store.read(), before, '查询、引用核对和追问不修改团队数据');
});

test('ZeroAI 查日报问题：快捷入口只填草稿，授权问题不外发普通正文，来源定位到原日报', {timeout: 45000}, async t => {
    let calls = 0;
    const {store, url, newPage} = await browserFixture(t, {
        readPolicy: {target: 'issues-browser-local', issues: true, detail: false, team: false},
        completeAi: async (_messages, {executeTool}) => {
            calls++;
            const result = await executeTool('list_report_issues', {status: 'open'});
            assert.equal(result.ok, true);
            assert.deepEqual(result.data.items.map(item => item.id), ['issue-own']);
            assert.doesNotMatch(JSON.stringify(result.data), /禁止外发的正文|同事的问题|私有评论/);
            return {content: `${result.data.items[0].notes}；${result.data.items[0].solution}`};
        }
    });
    const [, account, other] = await seedAccounts(store);
    const report = (id, ownerId, notes) => ({
        key: 'dailyReports', id, before: null, after: {
            id,
            ownerId,
            date: '2024-05-06',
            weekId: '2024-W19',
            taskId: 'T01',
            detail: '禁止外发的正文',
            hours: 1,
            notes,
            solution: '补充样例后复核',
            comments: [{id: 'c', authorId: ownerId, text: '私有评论', createdAt: '2024-05-06T09:00:00+08:00'}],
            createdById: ownerId,
            updatedById: ownerId,
            createdAt: '2024-05-06T09:00:00+08:00',
            updatedAt: '2024-05-06T09:00:00+08:00'
        }
    });
    await store.patch((await store.read()).version, [report('issue-own', account.user.id, '样例尚未确认'),
        report('issue-other', other.user.id, '同事的问题')]);
    const before = await store.read();
    const page = await newPage();
    await enter(page, url, account);
    await tab(page, 'ZeroAI');
    await page.getByRole('button', {name: '查我的未解决问题'}).click();
    assert.match(await page.getByRole('textbox', {name: '消息内容'}).inputValue(), /未解决的日报问题/);
    assert.equal(calls, 0);
    await page.getByRole('button', {name: '发送', exact: true}).click();
    await page.getByText('样例尚未确认；补充样例后复核', {exact: true}).waitFor();
    await page.getByRole('button', {name: /^打开日报：/}).click();
    const row = page.getByRole('group', {name: '引用的日报'});
    await row.waitFor();
    assert.equal(await row.getAttribute('data-report-id'), 'issue-own');
    assert.deepEqual(await store.read(), before);
});

test('管理员查看他人工作内容：日报来源定位、窄屏只读展示及周次、成员与统计筛选', {timeout: 45000}, async t => {
    const date = '2027-01-01', weekId = '2026-W53', taskId = 'T02.2.1', missing = 'T02.2.9';
    const title = '鉴权功能模块接口开发' + 'AuthModule'.repeat(14);
    const detail = '完成登录联调\n' + 'ABCDEFGH'.repeat(32), notes = '待确认：' + '验收反馈'.repeat(25);
    const {store, url, newPage} = await browserFixture(t, {
        readPolicy: {target: 'peer-browser-local', team: true, detail: true},
        completeAi: async (_, {executeTool}) => {
            const result = await executeTool('list_daily_reports', {
                from: date,
                to: date,
                taskId,
                ownerId: 'test-other'
            });
            assert.deepEqual(result.data.items.map(r => r.id), ['peer-report']);
            return {content: '已找到指定成员的日报。'};
        }
    });
    const [, admin, other] = await seedAccounts(store);
    await store.auth.bindFirstAdmin(admin.user.id, admin.user.name);
    const fields = {
        ownerId: other.user.id,
        weekId,
        taskId,
        detail,
        createdAt: date,
        updatedAt: date,
        updatedById: other.user.id
    };
    const change = (key, after) => ({key, id: after.id, before: null, after});
    await store.patch((await store.read()).version, [
        change('tasks', {id: taskId, title, parentId: null, level: 1, order: 0, status: 'active', description: ''}),
        change('dailyReports', {...fields, id: 'peer-report', date, hours: 9, notes}),
        change('dailyReports', {...fields, id: 'old-report', taskId: missing, date, hours: 1, notes: ''}),
        change('dailyReports', {...fields, id: 'previous-week-report', weekId: '2026-W52', date: '2026-12-21',
            detail: '上一周的日报', hours: 3, notes: ''}),
        change('weeklyPlans', {...fields, id: 'peer-plan', completed: false}),
        change('weeklyPlans', {...fields, id: 'old-plan', taskId: missing, weekId: '2026-W52', completed: false})
    ]);
    const page = await newPage();
    await enter(page, url, admin);
    await tab(page, 'ZeroAI');
    const before = await store.read();
    await page.getByRole('textbox', {name: '消息内容'}).fill('查指定成员日报');
    await page.getByRole('button', {name: '发送', exact: true}).click();
    await page.getByRole('button', {name: `打开日报：${date} 日报`, exact: true}).click();
    const row = page.getByRole('group', {name: '引用的日报'});
    await row.waitFor();
    assert.equal(await row.getAttribute('data-report-id'), 'peer-report');
    assert.equal(await row.locator('.report-task').innerText(), `${taskId} ${title}`);
    assert.equal(await row.locator('.cell.mono:not(.entry-no-cell)').innerText(), '9h');
    assert.deepEqual(await row.locator('.cell-text').allTextContents(), [detail, notes]);
    assert.equal(await row.locator('input,textarea,button').count(), 0);
    assert.equal(await page.locator('[data-report-id="old-report"] .report-task').innerText(), `${missing} （已删除任务）`);
    const board = page.locator('.person-board[data-peer-view]');
    assert.ok((await board.locator('.unfinished-item strong').innerText()).includes(`${missing} （已删除任务）`));
    const summary = board.locator('.summary-row').filter({hasText: title});
    await summary.click();
    for (const width of [1280, 360]) {
        await page.setViewportSize({width, height: 800});
        for (const el of [row.locator('.report-task'), row.locator('.cell-text').first(), row.locator('.cell-text').last(),
            board.locator('.plan-title'), board.locator('.plan-detail'), summary.locator('.summary-title'), board.locator('.report-line p')]) {
            assert.ok(await el.isVisible());
            const size = await el.evaluate(e => [e.scrollWidth, e.clientWidth, e.scrollHeight, e.clientHeight]);
            assert.ok(size[0] <= size[1] + 1 && size[2] <= size[3] + 1, `宽 ${width} 内容被裁切：${await el.getAttribute('class')} (${size})`);
            assert.ok(size[1] <= width, '内容不应超出视口宽度');
        }
    }
    const week = picker(page, '周次');
    const weeks = pickerList(page, '周次');
    await week.scrollIntoViewIfNeeded();
    await week.press('Enter');
    await assertPickerInViewport(weeks);
    assert.equal(await option(weeks, weekId).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await weeks.waitFor({state: 'hidden'});
    assert.equal(await week.getAttribute('aria-label'), '周次：2026-W52');
    assert.ok(await hasFocus(week));
    await row.waitFor({state: 'hidden'});
    await board.locator('[data-report-id="previous-week-report"]').getByText('上一周的日报', {exact: true}).waitFor();

    const view = picker(page, '视图');
    await choose(page, '视图', '所有人');
    assert.equal(await page.locator('.person-board').count(), 3);
    await view.press('Enter');
    const views = pickerList(page, '视图');
    await assertPickerInViewport(views);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await views.waitFor({state: 'hidden'});
    assert.equal(await view.getAttribute('aria-label'), '视图：所有人');
    assert.ok(await hasFocus(view));
    await choose(page, '视图', '只看我（默认）');
    await board.waitFor({state: 'hidden'});
    await page.getByPlaceholder('今天做了什么').waitFor();
    await choose(page, '视图', other.user.name);
    await board.getByText('上一周的日报', {exact: true}).waitFor();
    assert.equal(await page.locator('.person-board').count(), 1);
    assert.equal(await page.getByPlaceholder('今天做了什么').count(), 0);

    await tab(page, '统计');
    const reportCount = page.locator('.stat-tile').filter({hasText: '日报条数'}).locator('strong');
    assert.equal(await reportCount.textContent(), '1');
    await choose(page, '统计周次', /^2026-W53/);
    assert.equal(await reportCount.textContent(), '2');
    await button(page, '按月').click();
    await choose(page, '统计月份', '2026-12');
    assert.equal(await reportCount.textContent(), '1');
    await choose(page, '统计月份', '2027-01');
    assert.equal(await reportCount.textContent(), '2');
    assert.deepEqual(await store.read(), before, '查看、定位和筛选不应改动业务记录');
});

test('ZeroAI 私人历史：双分页、深处分支、停止与跨浏览器恢复', {timeout: 120000}, async t => {
    const rootPrompt = '新版长会话起点';
    const originalReply = '长会话的第一份回复';
    const alternateReply = '长会话的另一份回复';
    const extraPrompt = '另一个窗口追加的问题';
    const stopPrompt = '新版停止流式回复';
    let firstReplies = 0;
    const {store, url, newPage} = await browserFixture(t, {
        completeAi: async (messages, {onDelta, signal}) => {
            const question = messages.at(-1).content;
            if (question === stopPrompt) {
                onDelta(markdownReply);
                if (!signal.aborted) await once(signal, 'abort');
                signal.throwIfAborted();
            }
            if (question === rootPrompt) return {content: ++firstReplies === 1 ? originalReply : alternateReply};
            return {content: `模拟回复：${question}`};
        }
    });
    const [, member, otherMember] = await seedAccounts(store);
    const chat = await newPage({viewport: {width: 1366, height: 900}});
    const log = chat.getByRole('log', {name: '消息'});
    const message = content => log.getByText(content, {exact: true});
    const input = chat.getByRole('textbox', {name: '消息内容'});
    const postMessage = (page, id, content) => browserApi(page, `${zeroAiSessions}/${id}/messages`, {
        turnId: randomUUID(), content
    }, 'POST');
    const writePrompt = async prompt => {
        await input.fill(prompt);
        await input.press('Enter');
    };
    const reloadChat = async page => {
        await page.reload();
        await tab(page, 'ZeroAI');
    };
    await enter(chat, url, member);
    const requests = [];
    chat.on('request', request => {
        const requestUrl = new URL(request.url());
        if (requestUrl.pathname.startsWith(zeroAiSessions)) requests.push(requestUrl);
    });
    await tab(chat, 'ZeroAI');
    await message('开始一段对话').waitFor();

    // 通过真实认证 HTTP 填两种分页的数据，不直接写测试数据库的实现集合。
    const oldest = await browserApi(chat, zeroAiSessions, {}, 'POST');
    assert.equal(oldest.status, 201);
    const oldestTitle = '会话列表中的最早一条';
    const oldestPath = `${zeroAiSessions}/${oldest.body.session.id}`;
    assert.equal((await browserApi(chat, oldestPath, {title: oldestTitle}, 'PATCH')).status, 200);
    for (let i = 0; i < 30; i++) {
        assert.equal((await browserApi(chat, zeroAiSessions, {}, 'POST')).status, 201);
    }
    await reloadChat(chat);
    const oldestButton = button(chat, oldestTitle);
    const moreSessions = button(chat, '加载更多会话');
    await moreSessions.waitFor();
    assert.equal(await oldestButton.count(), 0);
    await moreSessions.click();
    await oldestButton.waitFor();
    assert.equal(await oldestButton.count(), 1);
    await moreSessions.waitFor({state: 'detached'});
    assert.ok(requests.some(url => url.pathname === zeroAiSessions && url.searchParams.has('cursor')));

    await button(chat, '新建会话').click();
    const [messageResponse] = await Promise.all([
        chat.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.startsWith(`${zeroAiSessions}/`) &&
            new URL(r.url()).pathname.endsWith('/messages')), writePrompt(rootPrompt)
    ]);
    assert.equal(messageResponse.status(), 200);
    const longPath = new URL(messageResponse.url()).pathname.replace(/\/messages$/, '');
    const longId = longPath.split('/').at(-1);
    await message(originalReply).waitFor();
    const step = i => `新版会话第 ${i} 个问题`;
    for (let i = 2; i <= 16; i++) assert.equal((await postMessage(chat, longId, step(i))).status, 200);
    await reloadChat(chat);
    await message(step(16)).waitFor();
    const earlier = button(log, '加载更早消息');
    await earlier.waitFor();
    assert.equal(await message(rootPrompt).count(), 0);

    // 服务端的新分支游标不能与当前页拼接；错误提示可在原会话中刷新。
    assert.equal((await postMessage(chat, longId, extraPrompt)).status, 200);
    await earlier.click();
    await button(chat, '重新打开会话').waitFor();
    assert.equal(await message(step(16)).count(), 1);
    await button(chat, '重新打开会话').click();
    await message(extraPrompt).waitFor();
    await earlier.click();
    await message(rootPrompt).waitFor();
    assert.equal(await message(extraPrompt).count(), 1);
    assert.ok(requests.some(url => url.pathname === longPath && url.searchParams.has('before')));

    const assistant = text => log.locator('article.assistant').filter({has: chat.getByText(text, {exact: true})});
    await button(assistant(originalReply), '重新生成').click();
    await message(alternateReply).waitFor();
    await message(extraPrompt).waitFor({state: 'detached'});
    await button(assistant(alternateReply), '上一版本').click();
    await message(originalReply).waitFor();
    await message(extraPrompt).waitFor();
    assert.equal(await message(alternateReply).count(), 0);
    await button(assistant(originalReply), '下一版本').waitFor();

    // 另一浏览器切版后，旧页面的追问不能落到它没有看过的分支。
    const branched = await newPage();
    await enter(branched, url, member);
    const {status: snapshotStatus, body: {session: snapshot}} = await browserApi(branched, `${longPath}?limit=50`);
    assert.equal(snapshotStatus, 200);
    assert.ok(Number.isInteger(snapshot.branchEpoch));
    const alternateId = snapshot.messages.find(({content}) => content === originalReply).versions.nextId;
    const switched = await browserApi(branched, `${longPath}/messages/select`, {messageId: alternateId}, 'POST');
    assert.equal(switched.status, 200);
    const stalePrompt = '分支已经变化的追问';
    const [rejected] = await Promise.all([posted(chat, `${longPath}/messages`), writePrompt(stalePrompt)]);
    assert.equal(rejected.status(), 409);
    assert.equal(rejected.request().postDataJSON().expectedBranchEpoch, snapshot.branchEpoch);
    await button(chat, '重新打开会话').click();
    await message(alternateReply).waitFor();
    assert.equal(await message(stalePrompt).count(), 0);
    assert.equal(await input.inputValue(), stalePrompt);
    await input.fill('');
    await button(assistant(alternateReply), '上一版本').click();
    await message(extraPrompt).waitFor();
    await branched.close();

    await button(chat, `${rootPrompt}的更多操作`).click();
    await button(chat.getByRole('group', {name: '会话操作'}), '重命名').click();
    const renamed = '重命名后的新版长会话';
    await label(chat, '会话标题').fill(renamed);
    await button(chat, '保存标题').click();
    await heading(chat, renamed).waitFor();
    assert.equal(await message(rootPrompt).count(), 1);

    await writePrompt(stopPrompt);
    await heading(log, '日报草稿').waitFor();
    await button(chat, '停止生成').click();
    await message('已停止生成').waitFor();
    assert.equal(await message(rootPrompt).count(), 1, '有旧页时发送也应使用新游标恢复旧消息');

    // 真实落库后模拟最终确认丢失，由真实 HTTP 流返回无快照的错误终帧。
    const checkPrompt = '需要核对是否保存的消息';
    const realEnd = store.agent.end;
    const failedAcknowledgement = t.mock.method(store.agent, 'end', async (...args) => {
        await realEnd(...args);
        throw new Error('模拟丢失保存确认');
    });
    const checkSession = button(chat, '重新打开会话核对');
    try {
        await writePrompt(checkPrompt);
        await checkSession.waitFor();
        assert.equal(await message(rootPrompt).count(), 1);
        assert.equal(await message(checkPrompt).count(), 0);
    } finally {
        failedAcknowledgement.mock.restore();
    }
    await checkSession.click();
    await message(checkPrompt).waitFor();
    await checkSession.waitFor({state: 'detached'});
    assert.equal(await input.inputValue(), '');

    await reloadChat(chat);
    await heading(chat, renamed).waitFor();
    await message('已停止生成').waitFor();

    const fresh = await newPage();
    await enter(fresh, url, member);
    await tab(fresh, 'ZeroAI');
    await heading(fresh, renamed).waitFor();
    const freshLog = fresh.getByRole('log', {name: '消息'});
    await freshLog.getByText('已停止生成', {exact: true}).waitFor();
    await button(freshLog, '加载更早消息').click();
    const restored = freshLog.locator('article.assistant').filter({hasText: originalReply});
    await button(restored, '下一版本').waitFor();
    assert.equal(await freshLog.getByText(alternateReply, {exact: true}).count(), 0);

    const other = await newPage();
    await enter(other, url, otherMember);
    await tab(other, 'ZeroAI');
    await other.getByText('开始一段对话', {exact: true}).waitFor();
    assert.equal((await browserApi(other, longPath)).status, 404);
    // 回到执行删除的窗口，避免浏览器抑制后台标签页的原生确认框。
    await other.close();
    await fresh.close();
    await chat.bringToFront();

    await moreSessions.click();
    await button(chat, `${oldestTitle}的更多操作`).click();
    let confirmedTitle = '';
    chat.once('dialog', async dialog => {
        confirmedTitle = dialog.message();
        await dialog.accept();
    });
    const deleting = chat.waitForResponse(r => r.request().method() === 'DELETE', {timeout: 12000});
    // 先确认点到可见菜单、确实出现对应会话的确认框，再等 HTTP 回执。
    const [, deleted] = await Promise.all([
        button(chat.getByRole('group', {name: '会话操作'}), '删除').click({timeout: 5000}), deleting
    ]);
    assert.ok(confirmedTitle.includes(oldestTitle));
    assert.equal(new URL(deleted.url()).pathname, oldestPath);
    assert.equal(deleted.status(), 200);
    await moreSessions.click();
    await moreSessions.waitFor({state: 'detached'});
    assert.equal(await oldestButton.count(), 0);
});

test('ZeroAI 能力和会话接口返回 503 时显示错误，重试只走 v2', {timeout: 60000}, async t => {
    const {store, url, newPage} = await browserFixture(t);
    const [, member] = await seedAccounts(store);
    const chat = await newPage();
    await enter(chat, url, member);
    const failed = () => {
        throw new StateError(503, '私人历史暂不可用。');
    };
    const check = t.mock.method(store.agent, 'check', failed);
    const list = t.mock.method(store.agent, 'list', failed);
    const sessionsRequested = [];
    chat.on('request', request => {
        if (new URL(request.url()).pathname.startsWith(zeroAiSessions)) sessionsRequested.push(request.method());
    });
    const responseAt = path => chat.waitForResponse(r => new URL(r.url()).pathname === path);
    const [capability] = await Promise.all([responseAt(zeroAiCapabilities), tab(chat, 'ZeroAI')]);
    assert.equal(capability.status(), 503);
    const alert = chat.getByRole('alert').filter({hasText: '私人历史暂不可用。'});
    await alert.waitFor();
    assert.deepEqual(sessionsRequested, []);
    assert.equal(await button(chat, '新建会话').count(), 0);

    check.mock.restore();
    const [healthyCapability, unavailableList] = await Promise.all([
        responseAt(zeroAiCapabilities), responseAt(zeroAiSessions), button(alert, '重试').click()
    ]);
    assert.equal(healthyCapability.status(), 200);
    assert.deepEqual(await healthyCapability.json(), {historyV2: true});
    assert.equal(unavailableList.status(), 503);
    await alert.waitFor();
    assert.ok(await button(chat, '新建会话').isDisabled());

    list.mock.restore();
    const [healthyList] = await Promise.all([responseAt(zeroAiSessions), button(alert, '重试').click()]);
    assert.equal(healthyList.status(), 200);
    await chat.getByText('开始一段对话', {exact: true}).waitFor();
    assert.ok(await button(chat, '新建会话').isEnabled());
    assert.deepEqual(sessionsRequested, ['GET', 'GET']);
});

test('ZeroAI 会话被另一窗口删除后，原草稿只供复制、不能发送到替代会话', {timeout: 60000}, async t => {
    const {store, url, newPage} = await browserFixture(t, {
        completeAi: async messages => ({content: `模拟回复：${messages.at(-1).content}`})
    });
    const [, member] = await seedAccounts(store);
    const chat = await newPage({viewport: {width: 1366, height: 900}});
    const otherWindow = await newPage();
    await enter(chat, url, member);
    await enter(otherWindow, url, member);
    const addSession = async title => {
        const created = await browserApi(chat, zeroAiSessions, {}, 'POST');
        assert.equal(created.status, 201);
        const path = `${zeroAiSessions}/${created.body.session.id}`;
        assert.equal((await browserApi(chat, path, {title}, 'PATCH')).status, 200);
        return path;
    };
    const survivorTitle = '仍存在的会话';
    const inactiveTitle = '另一条被删除的会话';
    const activeTitle = '原本正在写的会话';
    const survivorPath = await addSession(survivorTitle);
    const inactivePath = await addSession(inactiveTitle);
    const activePath = await addSession(activeTitle);
    await tab(chat, 'ZeroAI');
    await heading(chat, activeTitle).waitFor();
    const input = chat.getByRole('textbox', {name: '消息内容'});
    const orphanedText = '不能发到替代会话的原草稿';
    await input.fill(orphanedText);

    assert.equal((await browserApi(otherWindow, inactivePath, {}, 'DELETE')).status, 200);
    const [inactiveMissing] = await Promise.all([
        chat.waitForResponse(r => new URL(r.url()).pathname === inactivePath), button(chat, inactiveTitle).click()
    ]);
    assert.equal(inactiveMissing.status(), 404);
    await button(chat, inactiveTitle).waitFor({state: 'detached'});
    await heading(chat, activeTitle).waitFor();
    assert.equal(await input.inputValue(), orphanedText);

    assert.equal((await browserApi(otherWindow, activePath, {}, 'DELETE')).status, 200);
    const attempts = [];
    chat.on('request', request => {
        const {pathname} = new URL(request.url());
        if (request.method() === 'POST' && pathname.startsWith(zeroAiSessions) && pathname.endsWith('/messages')) {
            attempts.push([pathname, request.postDataJSON().content]);
        }
    });
    const [activeMissing] = await Promise.all([posted(chat, `${activePath}/messages`), input.press('Enter')]);
    assert.equal(activeMissing.status(), 404);
    await heading(chat, survivorTitle).waitFor();
    const recovered = label(chat, `已删除会话「${activeTitle}」的消息草稿`);
    assert.equal(await recovered.inputValue(), orphanedText);
    assert.equal(await recovered.getAttribute('readonly'), '');
    assert.equal(await input.inputValue(), '');
    assert.ok(await button(chat, '发送').isDisabled());
    await input.press('Enter');
    await chat.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await button(chat, '复制草稿').click();
    await button(chat, '已复制草稿').waitFor();
    assert.equal(await chat.evaluate(() => navigator.clipboard.readText()), orphanedText);

    const newText = '明确写给替代会话的新问题';
    await input.fill(newText);
    await input.press('Enter');
    await chat.getByRole('log', {name: '消息'}).getByText(`模拟回复：${newText}`, {exact: true}).waitFor();
    assert.deepEqual(attempts, [[`${activePath}/messages`, orphanedText], [`${survivorPath}/messages`, newText]]);
    assert.equal(await recovered.inputValue(), orphanedText);
});

async function checkSetupEntry(page, navigate, available) {
    const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === setupStatusPath), navigate()
    ]);
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).available, available);
    await loginNameField(page).waitFor();
    await button(page, '首次设置').waitFor({state: available ? 'visible' : 'hidden'});
}

async function openMemberAdmin(page) {
    await page.getByTitle('菜单').click();
    await button(page, '成员管理').click();
    await heading(page, '成员管理').waitFor();
}

async function checkMemberAdminDenied(page) {
    const menu = page.getByTitle('菜单');
    await menu.click();
    await button(page, '退出登录').waitFor();
    await button(page, '成员管理').waitFor({state: 'hidden'});
    await menu.click();
    assert.equal((await browserApi(page, adminMembersPath)).status, 403);
}

async function openAdminDialog(page, scope, action) {
    await button(scope, action).click();
    const dialog = page.getByRole('dialog', {name: action, exact: true});
    await dialog.waitFor();
    return dialog;
}

async function submitAdminDialog(page, dialog, operation, submit, fields) {
    for (const [name, value] of Object.entries(fields)) await label(dialog, name).fill(value);
    const [response] = await Promise.all([
        posted(page, `${adminMembersPath}/${operation}`), button(dialog, submit).click()
    ]);
    return response;
}

async function checkSecretNotStored(page, secret) {
    const stored = await page.evaluate(secret => [localStorage, sessionStorage].some(storage =>
        Object.entries(storage).some(([key, value]) => key.includes(secret) || value.includes(secret))
    ), secret);
    assert.equal(stored, false, '临时口令不得写入浏览器存储');
    assert.ok(!page.url().includes(encodeURIComponent(secret)), '临时口令不得进入页面地址');
}

async function readTemporaryPassword(page, response, status) {
    assert.equal(response.status(), status);
    const {memberId, initialPassword} = await response.json();
    assert.ok(typeof memberId === 'string' && memberId.length > 0, '应返回绑定的成员 ID');
    assert.ok(typeof initialPassword === 'string' && initialPassword.length > 0, '应返回临时口令');
    const result = page.getByRole('dialog', {name: '初始口令', exact: true});
    const rendered = result.getByTestId('admin-initial-password');
    await rendered.waitFor();
    assert.ok((await rendered.textContent()).trim() === initialPassword, '界面只能显示本次返回的临时口令');
    await checkSecretNotStored(page, initialPassword);
    return {memberId, initialPassword, result};
}

async function activateTemporaryPassword(page, url, {loginName, initialPassword, password}) {
    if (url) await page.goto(url);
    assert.equal((await signIn(page, {loginName, password: initialPassword})).status(), 200);
    await heading(page, '修改密码').waitFor();
    await label(page, '当前口令').fill(initialPassword);
    await label(page, '新密码').fill(password);
    await label(page, '确认新密码').fill(password);
    const [response] = await Promise.all([
        posted(page, '/api/password/change'), button(page, '修改密码').click()
    ]);
    assert.equal(response.status(), 200);
    await enter(page, null, {loginName, password});
}

test('已有库按成员 ID 授权：右上菜单、开通/新增、重置、停用与临时口令', {timeout: 90000}, async t => {
    const {store, url, newPage} = await browserFixture(t, {setupKey: testSetupKey()});
    const ordinary = {id: 'test-ordinary-member', name: '普通成员', color: '#21826d'};
    const admin = {id: 'test-verified-admin', name: '测试成员乙', color: '#3574ab'};
    const existing = {id: 'test-unprovisioned', name: '待开通成员', color: '#7265a4'};
    await store.patch((await store.read()).version, [ordinary, admin, existing].map(user => ({
        key: 'users', id: user.id, before: null, after: user
    })));
    const accounts = [{user: ordinary, loginName: 'oa-ordinary-member'}, {user: admin, loginName: 'oa-verified-admin'}];
    for (const account of accounts) {
        account.password = newPassword();
        const initial = await store.auth.provision(account.user.id, account.loginName);
        const {token} = await store.auth.login(account.loginName, initial);
        await store.auth.changePassword(token, initial, account.password);
    }
    const ordinaryPage = await newPage();
    await checkSetupEntry(ordinaryPage, () => ordinaryPage.goto(url), false);
    assert.equal((await browserApi(ordinaryPage, adminMembersPath)).status, 401);
    await enter(ordinaryPage, null, accounts[0]);
    await checkMemberAdminDenied(ordinaryPage);

    const adminPage = await newPage({viewport: {width: 1366, height: 900}});
    await enter(adminPage, url, accounts[1]);
    // 姓名本身不授予权限；维护绑定仍必须核对原成员 ID。
    await checkMemberAdminDenied(adminPage);
    await signOut(adminPage);
    await assert.rejects(store.auth.bindFirstAdmin(ordinary.id, '测试成员乙'), {status: 409});
    await store.auth.bindFirstAdmin(admin.id, '测试成员乙');
    assert.equal((await browserApi(ordinaryPage, `${adminMembersPath}/create`, {
        name: '越权成员', loginName: 'oa-denied-create'
    }, 'POST')).status, 403);

    await enter(adminPage, null, accounts[1]);
    await openMemberAdmin(adminPage);
    const self = memberRow(adminPage, admin.id);
    await rowStatus(self, '已启用');
    assert.equal(await button(self, '停用账号').isDisabled(), true, '管理员不能在界面停用自己的账号');
    const selfDisable = await browserApi(adminPage, `${adminMembersPath}/disable`, {
        memberId: admin.id, currentPassword: accounts[1].password
    }, 'POST');
    assert.equal(selfDisable.status, 400, '服务端必须拒绝自我停用');
    const adminSession = await browserApi(adminPage, '/api/session');
    assert.equal(adminSession.body.user.id, admin.id);
    assert.equal(adminSession.body.isAccountAdmin, true);

    await adminPage.setViewportSize({width: 390, height: 844});
    const legacy = memberRow(adminPage, existing.id);
    const search = label(adminPage, '搜索成员');
    await search.fill(existing.name);
    await rowStatus(legacy, '未开通');
    await self.waitFor({state: 'hidden'});
    assert.ok(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '窄屏成员页不应横向溢出');
    await search.fill('');
    await rowStatus(self, '已启用');
    const statusPicker = picker(adminPage, '账号状态');
    const statuses = pickerList(adminPage, '账号状态');
    await statusPicker.click();
    await assertPickerInViewport(statuses);
    await option(statuses, '未开通').click();
    await statuses.waitFor({state: 'hidden'});
    await rowStatus(legacy, '未开通');
    await self.waitFor({state: 'hidden'});
    await search.fill(admin.name);
    await legacy.waitFor({state: 'hidden'});
    assert.equal(await self.count(), 0, '搜索与账号状态应同时生效');
    await choose(adminPage, '账号状态', '全部状态');
    await rowStatus(self, '已启用');
    await search.fill('');

    const adding = await openAdminDialog(adminPage, adminPage, '新增成员');
    const added = await readTemporaryPassword(adminPage, await submitAdminDialog(adminPage, adding, 'create', '确认新增', {
        '姓名': '网页新增成员', '登录名': 'oa-web-created'
    }), 201);
    assert.ok(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '窄屏口令弹窗不应造成整页横向溢出');
    assert.equal(await heading(added.result, '初始口令').evaluate(element => document.activeElement === element), true);
    await adminPage.keyboard.press('Tab');
    const receipt = button(added.result, '已收好，关闭');
    assert.equal(await receipt.evaluate(element => document.activeElement === element), true);
    await adminPage.keyboard.press('Enter');
    await added.result.waitFor({state: 'hidden'});
    const addedRow = memberRow(adminPage, added.memberId);
    await addedRow.getByText('网页新增成员', {exact: true}).waitFor();
    await rowStatus(addedRow, '待修改初始口令');
    assert.ok((await store.read()).users.some(user => user.id === added.memberId && user.name === '网页新增成员'));

    await rowStatus(legacy, '未开通');
    const opening = await openAdminDialog(adminPage, legacy, '开通账号');
    const loginName = 'oa-web-provisioned';
    const provisioned = await readTemporaryPassword(adminPage, await submitAdminDialog(adminPage, opening, 'provision', '确认开通', {
        '登录名': loginName
    }), 201);
    assert.equal(provisioned.memberId, existing.id, '开通必须沿用原业务成员 ID');
    await button(provisioned.result, '已收好，关闭').click();
    await rowStatus(legacy, '待修改初始口令');
    assert.deepEqual((await store.read()).users.find(user => user.id === existing.id), existing);

    const targetPage = await newPage();
    const firstPassword = newPassword();
    await activateTemporaryPassword(targetPage, url, {
        loginName, initialPassword: provisioned.initialPassword, password: firstPassword
    });
    assert.equal((await browserApi(targetPage, '/api/session')).body.user.id, existing.id);

    const resetDialog = await openAdminDialog(adminPage, legacy, '重置密码');
    const wrong = await submitAdminDialog(adminPage, resetDialog, 'reset', '确认重置', {'管理员当前密码': newPassword()});
    assert.equal(wrong.status(), 400);
    await resetDialog.getByRole('alert').waitFor();
    assert.equal((await browserApi(targetPage, '/api/session')).status, 200, '校验失败不能让目标退出');
    const reset = await readTemporaryPassword(adminPage, await submitAdminDialog(adminPage, resetDialog, 'reset', '确认重置', {
        '管理员当前密码': accounts[1].password
    }), 200);
    assert.equal(reset.memberId, existing.id);
    assert.ok(reset.initialPassword !== provisioned.initialPassword, '重置必须换发口令');
    assert.equal((await browserApi(targetPage, '/api/session')).status, 401, '被重置账号旧会话必须失效');
    assert.equal((await browserApi(ordinaryPage, '/api/session')).status, 200, '其他成员无需退出');

    // 不关闭口令弹窗，验证刷新后不会从浏览器存储或列表响应恢复口令。
    await adminPage.reload();
    await openMemberAdmin(adminPage);
    await rowStatus(legacy, '待修改初始口令');
    await reset.result.waitFor({state: 'hidden'});
    const reloadedList = await browserApi(adminPage, adminMembersPath);
    assert.equal(reloadedList.status, 200);
    for (const {initialPassword} of [added, provisioned, reset]) {
        await checkSecretNotStored(adminPage, initialPassword);
        assert.ok(!(await adminPage.locator('body').innerText()).includes(initialPassword), '刷新后不能显示旧临时口令');
        assert.ok(!JSON.stringify(reloadedList.body).includes(initialPassword), '查询成员列表不得返回临时口令');
    }

    await targetPage.reload();
    await loginNameField(targetPage).waitFor();
    assert.equal((await signIn(targetPage, {loginName, password: firstPassword})).status(), 401);
    const nextPassword = newPassword();
    await activateTemporaryPassword(targetPage, null, {
        loginName,
        initialPassword: reset.initialPassword,
        password: nextPassword
    });
    const disabling = await openAdminDialog(adminPage, legacy, '停用账号');
    const disabled = await submitAdminDialog(adminPage, disabling, 'disable', '确认停用', {
        '管理员当前密码': accounts[1].password
    });
    assert.equal(disabled.status(), 200);
    assert.deepEqual(await disabled.json(), {memberId: existing.id});
    await rowStatus(legacy, '已停用');
    assert.equal((await browserApi(targetPage, '/api/state')).status, 401, '停用账号的旧会话不能再读取业务数据');
    await targetPage.reload();
    await loginNameField(targetPage).waitFor();
    assert.equal((await signIn(targetPage, {loginName, password: nextPassword})).status(), 401);
    assert.equal((await browserApi(ordinaryPage, '/api/session')).status, 200);
    assert.deepEqual((await store.read()).users.find(user => user.id === existing.id), existing);
});

test('全新库没有部署凭证时不显示首次设置', {timeout: 30000}, async t => {
    const {store, url, newPage} = await browserFixture(t);
    assert.deepEqual((await store.read()).users, []);
    const page = await newPage();
    await checkSetupEntry(page, () => page.goto(url), false);
});

test('全新库凭部署凭证首次注册：失败不占位、并发仅一位管理员', {timeout: 60000}, async t => {
    const setupKey = testSetupKey();
    const {store, url, newPage} = await browserFixture(t, {setupKey});
    const pages = await Promise.all([newPage(), newPage()]);
    const candidates = [
        {name: '首位注册候选甲', loginName: 'oa-first-candidate-a', password: newPassword()},
        {name: '首位注册候选乙', loginName: 'oa-first-candidate-b', password: newPassword()}
    ];

    async function fillSetup(page, account, credential) {
        await label(page, '初始化凭证').fill(credential);
        await label(page, '姓名').fill(account.name);
        await loginNameField(page).fill(account.loginName);
        await label(page, '密码').fill(account.password);
    }

    async function register(page) {
        const [response] = await Promise.all([
            posted(page, setupRegisterPath), button(page, '创建管理员账号').click()
        ]);
        return response;
    }

    await Promise.all(pages.map(async page => {
        await checkSetupEntry(page, () => page.goto(url), true);
        await button(page, '首次设置').click();
        await heading(page, '首次设置').waitFor();
    }));
    await fillSetup(pages[0], candidates[0], testSetupKey());
    assert.equal((await register(pages[0])).status(), 403);
    await pages[0].getByRole('alert').filter({hasText: '请核对初始化凭证'}).waitFor();
    assert.deepEqual((await store.read()).users, []);
    assert.deepEqual(await browserApi(pages[0], setupStatusPath), {status: 200, body: {available: true}});

    await Promise.all(pages.map((page, i) => fillSetup(page, candidates[i], setupKey)));
    const responses = await Promise.all(pages.map(register));
    assert.deepEqual(responses.map(response => response.status()).sort(), [201, 409]);
    const winner = responses.findIndex(response => response.status() === 201);
    assert.deepEqual(await responses[winner].json(), {ok: true});
    const page = pages[winner];
    await page.getByRole('status').filter({hasText: '管理员账号已创建，请使用新账号登录。'}).waitFor();
    await pages[1 - winner].getByRole('status').filter({hasText: '首次设置已关闭'}).waitFor();
    await checkSetupEntry(page, () => page.reload(), false);
    await enter(page, null, candidates[winner]);
    await openMemberAdmin(page);
    const session = await browserApi(page, '/api/session');
    assert.equal(session.body.isAccountAdmin, true);
    const members = (await store.read()).users;
    assert.deepEqual(members.map(({id, name}) => ({id, name})), [{
        id: session.body.user.id,
        name: candidates[winner].name
    }]);
    await rowStatus(memberRow(page, session.body.user.id), '已启用');
});
