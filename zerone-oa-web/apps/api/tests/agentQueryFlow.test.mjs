import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedAgentApi} from './sessionFixture.mjs';
import {initializeAi, requestAiChat, aiTargetKey, aiReadConfig} from '../src/services/ai.mjs';
import {resolveReadConfig} from '../src/services/aiReadConfig.mjs';

import {createZeroAiV2Handler} from '../src/routes/zeroAiV2.mjs';
import {StateError} from '../src/repositories/schema.mjs';

const capabilities = '/api/zeroai/v2/capabilities';
const root = '/api/zeroai/v2/sessions';
const create = async client => `${root}/${(await client(root, {method: 'POST'})).session.id}`;
const send = (client, path, turnId, content, options = {}) => client(`${path}/messages`, {
    method: 'POST',
    body: {turnId, content}, ...options
});
const date = '2026-11-21';
const readFrames = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));

// 真 HTTP 走完整原生协议，但模型是回环桩；测试永不向现场端点发送业务字段。
test('原生查询→引用定位→按旧结果追问；撤权隐藏原答和派生建议，切回旧分支也不能重发', {timeout: 30000}, async t => {
    let admin = true;
    const requests = [], text = '乙的合成联调记录', forbidden = '不应外发的评论';
    const relay = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body);
        requests.push(payload);
        const last = payload.messages.at(-1);
        const message = last.role === 'tool' ? {content: `查到了：${text}`} : last.content === '查乙的日报' ?
            {
                content: null,
                tool_calls: [{
                    id: 'call1',
                    type: 'function',
                    function: {
                        name: 'list_daily_reports',
                        arguments: JSON.stringify({from: date, to: date, ownerId: 'member-b'})
                    }
                }]
            } :
            {content: last.content === '请给建议' ? '基于乙记录的后续建议' : '没有可用的历史查询'};
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            choices: [{
                message: {role: 'assistant', ...message},
                finish_reason: message.tool_calls ? 'tool_calls' : 'stop'
            }]
        }));
    });
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    t.after(() => new Promise(resolve => relay.close(resolve)));
    const dir = await mkdtemp(join(tmpdir(), 'oa-p2-mock-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const configFile = join(dir, 'model.yaml');
    await writeFile(configFile, JSON.stringify({
        ai: {
            enabled: true,
            activeProfile: 'mock',
            timeoutMs: 5000,
            profiles: {
                mock: {
                    protocol: 'openai-chat',
                    baseUrl: `http://127.0.0.1:${relay.address().port}/v1`,
                    model: 'synthetic',
                    apiKeyEnv: 'MOCK_KEY'
                }
            }
        }
    }));
    const options = {configFile, env: {MOCK_KEY: 'synthetic-key'}};
    await initializeAi(options);
    await writeFile(join(dir, 'ai.local.yaml'), `ai:\n  readTools:\n    enabled: true\n    approvedProfile: mock\n    approvedTarget: "${aiTargetKey()}"\n    allowTeamRead: true\n    allowDetail: true\n`);
    await initializeAi(options);
    const readPolicy = aiReadConfig().policy;
    assert.ok(readPolicy);
    const fixture = isolatedAgentApi(t),
        api = await fixture.boot(requestAiChat, {readPolicy, isAdmin: id => id === 'member-a' && admin});
    const a = await api.browser(), b = await api.browser('member-b');
    const report = {
        id: 'report-b',
        date,
        weekId: '2026-W47',
        ownerId: 'member-b',
        taskId: 't1',
        hours: 8,
        detail: text,
        comments: [forbidden]
    };
    const {state} = await b('/api/state');
    const saved = await b('/api/state', {
        method: 'PUT',
        body: {baseVersion: state.version, changes: [{key: 'dailyReports', id: report.id, before: null, after: report}]}
    });
    assert.equal(saved.status, 200, saved.error);
    const path = await create(a), first = await send(a, path, 'q1', '查乙的日报', {stream: true});
    const frames = (await first.text()).trim().split('\n').map(s => JSON.parse(s));
    assert.ok(frames.some(f => f.type === 'tool'));
    const end = frames.at(-1);
    assert.equal(end.error, undefined, JSON.stringify(end));
    const message = end.session.messages.at(-1);
    assert.equal(message.content, `查到了：${text}`);
    assert.equal(message.queryCards[0].refs[0].id, report.id);
    const ref = `${path}/messages/${message.id}/refs/report/${report.id}`;
    assert.equal((await a(ref)).status, 200);
    assert.equal((await b(ref)).status, 404);
    assert.equal((await a(ref.replace('report-b', 'bogus'))).status, 404);
    assert.equal(message.scopeStamp, undefined);
    assert.equal(message.evidence, undefined);
    assert.equal(requests.length, 2);
    const toolPayload = requests[1].messages.at(-1);
    assert.equal(toolPayload.role, 'tool');
    assert.equal(toolPayload.tool_call_id, 'call1');
    assert.ok(toolPayload.content.includes(text));
    assert.ok(!toolPayload.content.includes(forbidden));
    const advice = await send(a, path, 'q2', '请给建议');
    assert.equal(advice.status, 200, advice.error);
    assert.equal(advice.session.messages.at(-1).queryBasis, 'previous');
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('当时的只读查询结果'));
    assert.deepEqual((await a('/api/state')).state, saved.state);
    const changed = await b('/api/state', {
        method: 'PUT',
        body: {
            baseVersion: saved.state.version,
            changes: [{key: 'dailyReports', id: report.id, before: report, after: null}]
        }
    });
    assert.equal(changed.status, 200, changed.error);
    assert.notEqual((await a(ref)).status, 200);
    admin = false;
    const history = await a(path);
    assert.equal(history.status, 200);
    for (const value of [text, '基于乙记录的后续建议', 'report-b']) assert.ok(!JSON.stringify(history).includes(value));
    assert.notEqual((await a(ref)).status, 200);
    const branch = await a(`${path}/messages/select`, {method: 'POST', body: {messageId: message.id}});
    assert.equal(branch.status, 200);
    assert.ok(!JSON.stringify(branch).includes(text));
    const next = await send(a, path, 'q3', '再说说');
    assert.equal(next.status, 200, next.error);
    assert.equal(next.session.messages.at(-1).queryBasis, 'none');
    assert.ok(!JSON.stringify(requests.at(-1).messages).includes(text));
});

test('在途团队查询失去权限时不发正文；停止后仍能正常询问自己的工时', {timeout: 20000}, async t => {
    let admin = true;
    const arrived = Promise.withResolvers(), resume = Promise.withResolvers();
    const readPolicy = {target: 'fixture', team: true, detail: true};
    const fixture = isolatedAgentApi(t);
    const api = await fixture.boot(async (messages, {executeTool, verifyTools}) => {
        if (messages.at(-1).content === '查团队') {
            const result = await executeTool('summarize_hours', {
                from: date,
                to: date,
                groupBy: 'total',
                scope: 'team'
            });
            assert.equal(result.ok, true);
            arrived.resolve();
            await resume.promise;
            await verifyTools();
            return {content: '不应交付的团队数据'};
        }
        const result = await executeTool('summarize_hours', {from: date, to: date, groupBy: 'total'});
        assert.equal(result.data.totalHours, 0);
        return {content: '本人合计 0 小时'};
    }, {readPolicy, isAdmin: () => admin});
    const a = await api.browser(), path = await create(a);
    const pending = send(a, path, 'team', '查团队', {stream: true});
    try {
        await arrived.promise;
    } finally {
        admin = false;
        resume.resolve();
    }
    const output = await (await pending).text();
    assert.ok(!output.includes('不应交付的团队数据'));
    assert.equal((await a(path)).session.messages.length, 0);
    const answer = await send(a, path, 'self', '查我自己');
    assert.equal(answer.status, 200, answer.error);
    assert.equal(answer.session.messages.at(-1).queryCards[0].refs[0].label, '0 小时 · 0 条日报');
    const stopTools = await fixture.boot();
    const returning = await stopTools.browser();
    const hidden = await returning(path);
    assert.equal(hidden.status, 200);
    assert.ok(!JSON.stringify(hidden).includes('本人合计 0 小时'));
    assert.ok(!JSON.stringify(hidden).includes('queryCards'));
});

test('问题授权独立控制工具、来源、证据和派生历史，不影响无问题依赖的日报', {timeout: 20000}, async t => {
    const readPolicy = {target: 'fixture', team: true, detail: true, issues: false};
    let admin = false;
    const fixture = isolatedAgentApi(t);
    const issueTool = 'list_report_issues';
    const note = '合成问题内容', solution = '合成解决方案', detail = '合成日报工作正文';
    const advice = '合成问题建议', followUp = '请针对合成问题内容给建议';
    const issueArgs = {dateBy: 'resolved', from: date, to: date, resolvedByMe: true, taskId: 't1'};
    const calls = [];
    const api = await fixture.boot(async (messages, {tools, executeTool}) => {
        calls.push({messages, tools});
        const question = messages.at(-1).content;
        if (question === '查普通日报') {
            const denied = await executeTool(issueTool, {});
            assert.equal(denied.code, 'FORBIDDEN');
        }
        if (question === '查普通日报' || question === '同时参考日报') {
            const report = await executeTool('list_daily_reports', {from: date, to: date});
            assert.equal(report.ok, true, report.message);
            assert.equal(report.data.items[0].detail, detail);
            return {content: question === '查普通日报' ? detail : `综合：${detail} / ${note}`};
        }
        if (question === '查已解决问题') {
            const denied = await executeTool(issueTool, {...issueArgs, ownerId: 'member-b'});
            assert.equal(denied.code, 'FORBIDDEN');
            const result = await executeTool(issueTool, issueArgs);
            assert.equal(result.ok, true, result.message);
            const item = result.data.items[0];
            assert.equal(item.notes, note);
            assert.equal(item.solution, solution);
            assert.equal(item.detail, undefined);
            assert.equal(item.comments, undefined);
            return {content: `查到：${item.notes}`};
        }
        if (question === '查全队问题') {
            const result = await executeTool(issueTool, {scope: 'team', status: 'all'});
            assert.equal(result.ok, true, result.message);
            return {content: `全队问题：${result.data.items[0].notes}`};
        }
        return {content: question === followUp ? advice : '未使用旧查询结果'};
    }, {readPolicy, isAdmin: id => id === 'member-a' && admin});
    const a = await api.browser(), b = await api.browser('member-b');
    const report = {
        id: 'issue-source', ownerId: 'member-a', taskId: 't1', date, weekId: '2026-W47', hours: 1,
        detail, notes: note, solution, resolved: true, resolvedById: 'member-a', resolvedAt: `${date}T12:00:00+08:00`
    };
    const {state} = await a('/api/state');
    const saved = await a('/api/state', {
        method: 'PUT',
        body: {baseVersion: state.version, changes: [{key: 'dailyReports', id: report.id, before: null, after: report}]}
    });
    assert.equal(saved.status, 200, saved.error);
    const ordinary = await create(a), path = await create(a);
    assert.deepEqual(await a(capabilities), {status: 200, historyV2: true, readTools: true});
    const daily = await send(a, ordinary, 'daily', '查普通日报');
    assert.equal(daily.status, 200, daily.error);
    assert.ok(!calls.at(-1).tools.some(tool => tool.function.name === issueTool));
    assert.doesNotMatch(calls.at(-1).messages[0].content, /list_report_issues/);

    readPolicy.issues = true;
    assert.deepEqual(await a(capabilities), {status: 200, historyV2: true, readTools: true, readIssues: true});
    const first = await send(a, path, 'issue', '查已解决问题', {stream: true});
    assert.equal(first.status, 200);
    const frames = await readFrames(first);
    const result = frames.at(-1);
    assert.equal(result.type, 'result');
    assert.equal(result.error, undefined, JSON.stringify(result));
    const issueDefinition = calls.at(-1).tools.find(tool => tool.function.name === issueTool);
    assert.ok(issueDefinition);
    assert.equal(issueDefinition.function.parameters.properties.ownerId, undefined);
    assert.match(calls.at(-1).messages[0].content, /status=resolved.*dateBy=resolved/);
    const answer = result.session.messages.at(-1);
    assert.equal(answer.queryCards.length, 1, '权限失败的调用不应保存查询卡');
    const card = answer.queryCards[0];
    assert.equal(card.name, issueTool);
    assert.equal(card.label, '问题列表');
    assert.match(card.scopeLabel, /本人 · 解决日期：2026-11-21 至 2026-11-21 · 任务 t1 · 已解决 · 由本人解决/);
    assert.deepEqual(card.refs.map(({type, id}) => ({type, id})), [{type: 'report', id: report.id}]);
    const ref = `${path}/messages/${answer.id}/refs/report/${report.id}`;
    const stored = await fixture.db.collection('agent_messages').findOne({
        sessionId: result.session.id,
        messageId: answer.id
    });
    assert.deepEqual(stored.scopeStamp, {target: 'fixture', team: false, detail: false, issues: true});
    assert.ok(stored.evidence[0].includes(solution));
    assert.equal(answer.evidence, undefined);
    assert.equal(answer.scopeStamp, undefined);
    assert.equal((await a(ref)).status, 200);
    assert.equal((await b(ref)).status, 404);

    readPolicy.detail = false;
    assert.equal((await a(capabilities)).readIssues, true);
    assert.equal((await a(ref)).status, 200);
    const derived = await send(a, path, 'advice', followUp);
    assert.equal(derived.status, 200, derived.error);
    const derivedAnswer = derived.session.messages.at(-1);
    assert.equal(derivedAnswer.content, advice);
    assert.equal(derivedAnswer.queryBasis, 'previous');
    assert.ok(JSON.stringify(calls.at(-1).messages).includes(solution));

    readPolicy.detail = true;
    const mixed = await send(a, path, 'mixed', '同时参考日报');
    assert.equal(mixed.status, 200, mixed.error);
    const mixedAnswer = mixed.session.messages.at(-1);
    const mixedStored = await fixture.db.collection('agent_messages').findOne({
        sessionId: result.session.id,
        messageId: mixedAnswer.id
    });
    assert.deepEqual(mixedStored.scopeStamp, {target: 'fixture', team: false, detail: true, issues: true});
    readPolicy.detail = false;
    const withoutDetail = await a(path);
    assert.ok(JSON.stringify(withoutDetail.session).includes(advice));
    assert.ok(!JSON.stringify(withoutDetail.session).includes(detail));

    admin = true;
    const teamPath = await create(a);
    const team = await send(a, teamPath, 'team-issue', '查全队问题');
    assert.equal(team.status, 200, team.error);
    const teamAnswer = team.session.messages.at(-1);
    assert.match(teamAnswer.queryCards[0].scopeLabel, /全队.*全部状态/);
    const teamRef = `${teamPath}/messages/${teamAnswer.id}/refs/report/${report.id}`;
    assert.equal((await a(teamRef)).status, 200);
    admin = false;
    assert.equal((await a(teamRef)).status, 404);
    assert.ok(!JSON.stringify((await a(teamPath)).session).includes(note));
    assert.equal((await a(ref)).status, 200);

    readPolicy.detail = true;
    readPolicy.issues = false;
    assert.deepEqual(await a(capabilities), {status: 200, historyV2: true, readTools: true});
    assert.equal((await a(ref)).status, 404);
    assert.equal((await a(ordinary)).session.messages.at(-1).content, detail);
    const select = await a(`${path}/messages/select`, {method: 'POST', body: {messageId: answer.id}});
    for (const history of [await a(path), select]) {
        assert.equal(history.status, 200, history.error);
        for (const secret of [note, solution, advice, report.id, detail, 'queryCards', 'queryBasis']) {
            assert.ok(!JSON.stringify(history.session).includes(secret), secret);
        }
    }
    assert.equal((await a(`${path}/messages`, {
        method: 'POST', body: {turnId: 'retry', regenerateMessageId: derivedAnswer.id}
    })).status, 403);
    assert.equal((await a(`${path}/messages`, {
        method: 'POST', body: {turnId: 'edit', editMessageId: 'advice', content: '重新改写'}
    })).status, 403);
    const next = await send(a, path, 'next', '再说说');
    assert.equal(next.status, 200, next.error);
    assert.equal(next.session.messages.at(-1).queryBasis, 'none');
    const context = JSON.stringify(calls.at(-1).messages);
    for (const secret of [note, solution, advice, detail, '当时的只读查询结果']) assert.ok(!context.includes(secret), secret);

    // 问题来源与旧格式标记不该同时存在。即使重新授权，也不能按普通日报放行该异常记录。
    const damaged = await fixture.db.collection('agent_messages').updateOne({
            sessionId: result.session.id,
            messageId: answer.id
        },
        {$unset: {'scopeStamp.issues': ''}});
    assert.equal(damaged.modifiedCount, 1);
    readPolicy.issues = true;
    assert.equal((await a(ref)).status, 404);
    const damagedAnswer = (await a(path)).session.messages.find(message => message.id === answer.id);
    assert.ok(!damagedAnswer.content.includes(note));
    assert.equal(damagedAnswer.queryCards, undefined);
});

test('问题查询在模型回复期间被撤权时不发送或提交迟到的正文', {timeout: 20000}, async t => {
    const readPolicy = {target: 'fixture', issues: true};
    const arrived = Promise.withResolvers(), resume = Promise.withResolvers();
    const text = '不应交付的合成问题回答';
    const api = await isolatedAgentApi(t).boot(async (_messages, {executeTool, onDelta}) => {
        const result = await executeTool('list_report_issues', {});
        assert.equal(result.ok, true, result.message);
        arrived.resolve();
        await resume.promise;
        onDelta(text);
        return {content: text};
    }, {readPolicy});
    const a = await api.browser(), path = await create(a);
    const pending = send(a, path, 'inflight', '查未解决问题', {stream: true}).then(readFrames);
    try {
        await Promise.race([arrived.promise, pending.then(frames => assert.fail(JSON.stringify(frames)))]);
    } finally {
        readPolicy.issues = false;
        resume.resolve();
    }
    const frames = await pending;
    assert.deepEqual(frames.map(({type}) => type), ['start', 'tool', 'result']);
    assert.equal(frames.at(-1).status, 403);
    assert.ok(!JSON.stringify(frames).includes(text));
    readPolicy.issues = true;
    assert.deepEqual((await a(path)).session.messages, []);
});

test('已找到问题来源但在日报定位期间撤权时，不返回业务结果或版本提示', async () => {
    for (const stale of [false, true]) {
        const readPolicy = {target: 'fixture', issues: true};
        const handler = createZeroAiV2Handler({
            async reportRef(_owner, _sid, _mid, _id, access) {
                assert.equal(access.issues, true);
                return {teamVersion: 1, scopeStamp: {target: 'fixture', team: false, detail: false, issues: true}};
            }
        }, undefined, {
            async verifyAgentReport(id, version, owner) {
                assert.deepEqual([id, version, owner], ['problem-report', 1, 'member-a']);
                readPolicy.issues = false;
                if (stale) throw new StateError(409, '团队数据已更新。');
                return {id, teamVersion: version};
            }
        }, readPolicy);
        const url = new URL(`http://localhost${root}/44444444-4444-4444-4444-444444444444/messages/m1/refs/report/problem-report`);
        await assert.rejects(handler({method: 'GET'}, {
            setHeader() {
            }, end: () => assert.fail('撤权后发送了来源')
        }, url, {
            user: {id: 'member-a'}, verify: async () => ({user: {id: 'member-a'}})
        }), {status: 404});
    }
});

test('无获准 profile 不外发；角色、正文和问题均独立显式开启', () => {
    const target = 'a'.repeat(64);
    const policy = settings => resolveReadConfig(settings, 'one', target).policy;
    const settings = {enabled: true, approvedProfile: 'one', approvedTarget: target};
    assert.equal(policy({}), null);
    assert.equal(policy({...settings, approvedProfile: 'two'}), null);
    assert.equal(policy({...settings, approvedTarget: 'other'}), null);
    assert.deepEqual(policy(settings), {target, team: false, detail: false, issues: false});
    assert.deepEqual(policy({...settings, allowIssues: true}), {target, team: false, detail: false, issues: true});
});
