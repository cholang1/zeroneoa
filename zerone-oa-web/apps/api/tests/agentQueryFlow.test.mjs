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

const root = '/api/zeroai/v2/sessions';
const create = async client => `${root}/${(await client(root, {method: 'POST'})).session.id}`;
const send = (client, path, turnId, content, options = {}) => client(`${path}/messages`, {
    method: 'POST',
    body: {turnId, content}, ...options
});
const date = '2026-11-21';

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

test('无获准 profile 不外发；角色和正文字段均独立显式开启', () => {
    const target = 'a'.repeat(64);
    const policy = settings => resolveReadConfig(settings, 'one', target).policy;
    const settings = {enabled: true, approvedProfile: 'one', approvedTarget: target};
    assert.equal(policy({}), null);
    assert.equal(policy({...settings, approvedProfile: 'two'}), null);
    assert.equal(policy({...settings, approvedTarget: 'other'}), null);
    assert.deepEqual(policy(settings), {target, team: false, detail: false});
});
