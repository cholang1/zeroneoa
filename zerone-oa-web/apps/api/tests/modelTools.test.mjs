import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aiTargetKey, initializeAi, requestAiChat} from '../src/services/ai.mjs';
import {readToolDefinitions} from '../src/services/agentReadTools.mjs';

const messages = [{role: 'user', content: '查一下我的日报'}];
const tools = [{
    type: 'function', function: {
        name: 'list_daily_reports', description: '查询本人日报', parameters: {
            type: 'object', additionalProperties: false, required: ['from'], properties: {
                from: {type: 'string', format: 'date'},
                limit: {type: 'integer', minimum: 1, maximum: 50},
                query: {type: 'string', minLength: 1, maxLength: 5},
                groupBy: {type: 'string', enum: ['day', 'week']}
            }
        }
    }
}];
const argumentJson = '{"from":"2026-11-22"}';
const call = (id, args = argumentJson, name = 'list_daily_reports') => ({
    id,
    type: 'function',
    function: {name, arguments: args}
});
const callsReply = (...tool_calls) => ({
    choices: [{
        finish_reason: 'tool_calls',
        message: {content: null, tool_calls}
    }]
});
const textReply = content => ({choices: [{finish_reason: 'stop', message: {content}}]});
const unavailable = {code: 'AI_TOOLS_UNAVAILABLE', message: /未查询成功/};
const options = overrides => ({
    tools, executeTool: async () => ({items: []}), verifyTools: async () => {
    }, ...overrides
});
const json = (response, payload) => response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(payload));
const sseFrame = (delta, finish_reason = null) => `data: ${JSON.stringify({
    choices: [{
        delta,
        finish_reason
    }]
})}\r\n\r\n`;

async function fixture(t, respond, timeoutMs = 1500) {
    const requests = [];
    const server = createServer(async (request, response) => {
        try {
            let body = '';
            for await (const chunk of request) body += chunk;
            requests.push(JSON.parse(body));
            await respond(response, requests.length);
        } catch (error) {
            response.destroy(error);
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const dir = await mkdtemp(join(tmpdir(), 'oa-model-tools-'));
    const configFile = join(dir, 'ai.yaml');
    t.after(() => rm(dir, {recursive: true, force: true}));
    await writeFile(configFile, `
ai:
  enabled: true
  activeProfile: fake
  timeoutMs: ${timeoutMs}
  profiles:
    fake:
      protocol: openai-chat
      baseUrl: ${baseUrl}
      model: fake-model
      apiKeyEnv: FAKE_KEY
`);
    await initializeAi({configFile, env: {FAKE_KEY: 'test-key'}});
    return {requests, configFile, baseUrl};
}

function deferred() {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return {promise, resolve};
}

test('JSON 原生工具：空正文、多调用按序回传、逐次复核，不修改输入历史', async t => {
    const first = call('c1');
    const second = call('c2', '{"from":"2024-02-29","limit":2}');
    const third = call('c3');
    const replies = [callsReply(first, second), callsReply(third), textReply('查询完成。')];
    const {requests} = await fixture(t, (response, n) => json(response, replies[n - 1]));
    const sequence = [];
    let executions = 0;
    const answer = await requestAiChat(messages, options({
        verifyTools: async () => {
            sequence.push('复核');
        },
        async executeTool(name, args) {
            sequence.push([name, args]);
            const index = ++executions;
            await new Promise(resolve => setImmediate(resolve));
            return {items: [index]};
        }
    }));
    const result = (id, n) => ({role: 'tool', tool_call_id: id, content: `{"items":[${n}]}`});
    const assistant = (...tool_calls) => ({role: 'assistant', content: null, tool_calls});
    assert.deepEqual(sequence, ['复核', ['list_daily_reports', {from: '2026-11-22'}],
        ['list_daily_reports', {
            from: '2024-02-29',
            limit: 2
        }], '复核', ['list_daily_reports', {from: '2026-11-22'}], '复核']);
    assert.deepEqual(answer, {content: '查询完成。', model: 'fake-model'});
    assert.deepEqual(requests, [
        {model: 'fake-model', stream: false, messages, tools},
        {
            model: 'fake-model',
            stream: false,
            tools,
            messages: [...messages, assistant(first, second), result('c1', 1), result('c2', 2)]
        },
        {
            model: 'fake-model',
            stream: false,
            tools,
            messages: [...messages, assistant(first, second), result('c1', 1), result('c2', 2), assistant(third), result('c3', 3)]
        }
    ]);
    assert.equal(messages.length, 1);
});

test('问题工具的实际定义能通过模型协议校验，撤销该授权后不会向模型注册', async t => {
    const principal = {user: {id: 'member-a'}, allowIssues: true};
    const name = 'list_report_issues';
    const args = {dateBy: 'resolved', resolvedByMe: true, from: '2026-11-16', to: '2026-11-22'};
    const {requests} = await fixture(t, (res, n) => json(res, n === 1
        ? callsReply(call('issue-call', JSON.stringify(args), name)) : textReply('核对完成。')));
    const calls = [];
    const run = allowIssues => requestAiChat([{role: 'user', content: '我上周解决了什么？'}], options({
        tools: readToolDefinitions({...principal, allowIssues}),
        executeTool: async (name, args) => {
            calls.push([name, args]);
            return {ok: true, data: {items: []}};
        }
    }));
    await run(true);
    await run(false);
    assert.deepEqual(calls, [[name, args]]);
    assert.ok(requests[0].tools.some(tool => tool.function.name === name));
    assert.equal(requests[1].messages.at(-1).tool_call_id, 'issue-call');
    assert.ok(!requests[2].tools.some(tool => tool.function.name === name));
});

test('SSE 按索引拼接交错的 ID、函数名、参数和中文，工具轮草稿不外露', async t => {
    const firstDelta = deferred();
    const {requests} = await fixture(t, async (response, n) => {
        if (n === 2) return json(response, callsReply(call('finish', '{}', 'finish_query')));
        response.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8'});
        if (n === 3) {
            response.write(sseFrame({reasoning_content: '不下发的内部状态'}) + sseFrame({
                content: '最终',
                tool_calls: []
            }));
            // 首段没有实时发布就不给结束帧，回放缓存不能通过此用例。
            await firstDelta.promise;
            response.end(sseFrame({content: '答复'}, 'stop') + 'data: [DONE]\n\n');
            return;
        }
        const head = sseFrame({
            content: '不下发草稿', tool_calls: [
                {index: 1, id: 'c', type: 'function', function: {name: 'list_', arguments: '{"query":"中'}},
                {index: 0, id: 'c0', type: 'function', function: {name: 'list_daily_reports', arguments: argumentJson}}
            ]
        });
        const bytes = Buffer.from(head);
        const split = bytes.indexOf(Buffer.from('中')) + 1;
        response.write(': 保活\r\n\r\n');
        response.write(bytes.subarray(0, split));
        await new Promise(resolve => setImmediate(resolve));
        response.write(bytes.subarray(split));
        response.end(sseFrame({
            tool_calls: [{
                index: 1, id: '1', function: {
                    name: 'daily_reports', arguments: '文","from":"2026-11-22"}'
                }
            }]
        }) + sseFrame({}, 'tool_calls') + 'data: {"choices":[]}\n\ndata: [DONE]\n\n');
    });
    const deltas = [];
    const args = [];
    assert.deepEqual(await requestAiChat(messages, options({
        onAnswering: () => deltas.push('准备回答'),
        onDelta: chunk => {
            deltas.push(chunk);
            firstDelta.resolve();
        },
        async executeTool(name, input) {
            args.push([name, input]);
            return {};
        }
    })), {content: '最终答复', model: 'fake-model'});
    assert.deepEqual(args, [['list_daily_reports', {from: '2026-11-22'}], ['list_daily_reports', {
        query: '中文',
        from: '2026-11-22'
    }]]);
    assert.deepEqual(deltas, ['准备回答', '最终', '答复']);
    assert.ok(requests.every(request => request.stream));
    assert.ok(requests[0].tools.some(tool => tool.function.name === 'finish_query'));
    assert.equal(requests[2].tools, undefined);
    assert.deepEqual(requests[2].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['c0', 'c1']);
});

test('无需查询：兼容决策轮返回文本及最终轮返回 JSON，保留空白且不回放草稿', async t => {
    const content = '## 结果\n\n- **第一项**\n- 第二项\n';
    const {requests} = await fixture(t, (res, n) => json(res, textReply(n === 1 ? '决策草稿' : content)));
    const events = [];
    const answer = await requestAiChat(messages, options({
        onDelta: chunk => events.push(chunk), onAnswering: () => events.push('开始回答'),
        executeTool: () => assert.fail('普通问题不执行 OA 查询')
    }));
    assert.deepEqual(events, ['开始回答', content]);
    assert.equal(answer.content, content);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].tools, undefined);
    assert.ok(!JSON.stringify(requests[1]).includes('决策草稿'));
});

test('阶段切换只接受独立且参数有效的 finish_query；最终请求也要先复核', async t => {
    const finish = call('finish', '{}', 'finish_query');
    let reply;
    const {requests} = await fixture(t, res => json(res, reply));
    const events = [];
    const opts = options({
        onDelta: delta => events.push(delta), onAnswering: () => events.push('开始回答'),
        executeTool: () => {
            events.push('不应执行');
        }
    });
    for (reply of [callsReply(finish, call('unexpected')), callsReply(call('finish', '{"extra":1}', 'finish_query'))]) {
        await assert.rejects(requestAiChat(messages, opts), unavailable);
    }
    reply = callsReply(finish);
    let pass = 0;
    await assert.rejects(requestAiChat(messages, {...opts, verifyTools: () => ++pass === 1}), unavailable);
    assert.equal(pass, 2);
    assert.deepEqual(events, []);
    assert.equal(requests.length, 3);
});

test('JSON 响应批次内任何未知、非法、截断或重复调用都不执行，协议不匹配不重发', async t => {
    let send;
    const {requests} = await fixture(t, response => send(response));
    let executed = 0;
    const opts = options({
        executeTool: async () => {
            executed++;
        }
    });
    const invalid = [
        call('bad', '{}', 'toString'),
        call('bad', '{"from":"2026-11-22"'),
        call('bad', '[]'),
        call('bad', 'null'),
        call('bad', '{}'),
        call('bad', '{"from":"2026-02-29"}'),
        call('bad', '{"from":"2026-11-22","limit":"3"}'),
        call('bad', '{"from":"2026-11-22","limit":51}'),
        call('bad', '{"from":"2026-11-22","groupBy":"total"}'),
        call('bad', '{"from":"2026-11-22","query":"超出五个字符"}'),
        call('bad', '{"from":"2026-11-22","memberId":"other"}'),
        call('bad', '{"from":"2026-11-22","__proto__":{}}'),
        call('bad', `${argumentJson}${' '.repeat(8192)}`),
        call('first'),
        {...call('bad'), type: 'not-function'},
        {...call('bad'), id: ''}
    ];
    for (const bad of invalid) {
        send = response => json(response, callsReply(call('first'), bad));
        await assert.rejects(requestAiChat(messages, opts), unavailable);
    }
    send = response => json(response, {
        choices: [{
            finish_reason: 'length',
            message: callsReply(call('valid')).choices[0].message
        }]
    });
    await assert.rejects(requestAiChat(messages, opts), unavailable);
    send = response => json(response, {
        choices: [{
            finish_reason: 'function_call',
            message: {function_call: {name: 'list_daily_reports'}}
        }]
    });
    await assert.rejects(requestAiChat(messages, opts), unavailable);
    send = response => response.writeHead(400).end('上游原始错误及敏感信息');
    await assert.rejects(requestAiChat(messages, opts), error => {
        assert.equal(error.code, unavailable.code);
        assert.match(error.message, unavailable.message);
        assert.doesNotMatch(error.message, /敏感信息/);
        return true;
    });
    assert.equal(requests.length, invalid.length + 3);
    assert.equal(executed, 0);
});

test('SSE 仅看到貌似完整的参数、没有正确结束或缺索引，不能执行或展示工具轮文本', async t => {
    let frames;
    const {requests} = await fixture(t, response => response.writeHead(200, {'Content-Type': 'text/event-stream'}).end(frames));
    const fragment = sseFrame({content: '不应下发', tool_calls: [{index: 0, ...call('c1')}]});
    const gap = sseFrame({tool_calls: [{index: 1, ...call('c2')}]});
    const done = 'data: [DONE]\n\n';
    const finish = sseFrame({}, 'tool_calls');
    let executed = 0;
    const deltas = [];
    const opts = options({
        onDelta: delta => deltas.push(delta), executeTool: async () => {
            executed++;
        }
    });
    for (const bad of [fragment, fragment + done, fragment + sseFrame({}, 'length') + done,
        fragment + finish.trimEnd(), gap + finish + done, fragment + finish + fragment + done,
        sseFrame({tool_calls: [{index: 0, ...call('c1', '{"from":"2026-11-22"')}]}) + finish + done]) {
        frames = bad;
        await assert.rejects(requestAiChat(messages, opts), unavailable);
    }
    assert.equal(requests.length, 7);
    assert.equal(executed, 0);
    assert.deepEqual(deltas, []);
});

test('每次外发前复核：第一次拒绝不接触上游，执行后撤权不传结果', async t => {
    const {requests} = await fixture(t, response => json(response, callsReply(call('c1'))));
    await assert.rejects(requestAiChat(messages, options({verifyTools: async () => false})), unavailable);
    await assert.rejects(requestAiChat(messages, options({verifyTools: undefined})), unavailable);
    assert.equal(requests.length, 0);
    let passes = 0;
    let executed = 0;
    await assert.rejects(requestAiChat(messages, options({
        async verifyTools() {
            if (++passes === 2) throw new Error('不应返回的权限错误');
        },
        async executeTool() {
            executed++;
            return {data: '不可外发的业务结果'};
        }
    })), error => {
        assert.equal(error.code, unavailable.code);
        assert.doesNotMatch(error.message, /权限错误/);
        return true;
    });
    assert.equal(passes, 2);
    assert.equal(executed, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].messages.length, 1);
});

test('四次模型往返和六次工具调用是总上限，最后一轮只收答案', async t => {
    let replies;
    let start = 0;
    const {requests} = await fixture(t, (response, n) => json(response, replies[n - start - 1]));
    let calls = 0;
    const opts = options({executeTool: async () => ({n: ++calls})});
    const c = (...ids) => callsReply(...ids.map(id => call(`c${id}`)));
    replies = [c(1, 2), c(3, 4), c(5, 6), textReply('完整回答')];
    assert.equal((await requestAiChat(messages, opts)).content, '完整回答');
    assert.equal(calls, 6);
    assert.equal(requests.length, 4);

    start = requests.length;
    calls = 0;
    replies = [c(1), c(2), c(3), c(4)];
    await assert.rejects(requestAiChat(messages, opts), {code: 'AI_TOOL_LIMIT'});
    assert.equal(calls, 3);
    assert.equal(requests.length - start, 4);

    start = requests.length;
    calls = 0;
    replies = [c(1, 2, 3, 4, 5), c(6, 7)];
    await assert.rejects(requestAiChat(messages, opts), {code: 'AI_TOOL_LIMIT'});
    assert.equal(calls, 5);
    assert.equal(requests.length - start, 2);

    start = requests.length;
    replies = [c(1)];
    await assert.rejects(requestAiChat(messages, options({executeTool: async () => ({data: '中'.repeat(3000)})})),
        {code: 'AI_TOOL_LIMIT', message: /缩小查询范围/});
    assert.equal(requests.length - start, 1);
});

test('连续补查三轮仍能流式写正文，不增加四次往返预算', async t => {
    const {requests} = await fixture(t, (res, n) => json(res, n < 4 ? callsReply(call(`c${n}`)) : textReply('根据三轮结果作答')));
    const events = [];
    await requestAiChat(messages, options({
        executeTool: async () => {
            events.push('查询');
            return {ok: true};
        },
        onAnswering: () => events.push('准备回答'), onDelta: chunk => events.push(chunk)
    }));
    assert.deepEqual(events, ['查询', '查询', '查询', '准备回答', '根据三轮结果作答']);
    assert.equal(requests.length, 4);
    assert.equal(requests[3].tools, undefined);
    assert.equal(requests[3].messages.filter(message => message.role === 'tool').length, 3);
});

test('超时覆盖复核及工具执行；迟到回调不会触发 HTTP 或后续工具', {timeout: 5000}, async t => {
    const {requests} = await fixture(t, response => json(response, callsReply(call('c1'), call('c2'))), 250);
    const verification = deferred();
    await assert.rejects(requestAiChat(messages, options({verifyTools: () => verification.promise})), {code: 'AI_TIMEOUT'});
    verification.resolve(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 0);
    const result = deferred();
    let calls = 0;
    await assert.rejects(requestAiChat(messages, options({
        executeTool: () => {
            calls++;
            return result.promise;
        }
    })), {code: 'AI_TIMEOUT'});
    result.resolve({data: '迟到结果'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(calls, 1);
});

test('取消保留原始理由，关闭正在等待的 SSE，不执行未完成调用', {timeout: 5000}, async t => {
    const opened = deferred();
    const closed = deferred();
    const {requests} = await fixture(t, response => {
        response.once('close', closed.resolve);
        response.writeHead(200, {'Content-Type': 'text/event-stream'});
        response.write(sseFrame({tool_calls: [{index: 0, ...call('pending')}]}));
        opened.resolve();
    });
    let executed = 0;
    const controller = new AbortController();
    const reason = new Error('用户点击取消');
    const answer = requestAiChat(messages, options({
        signal: controller.signal, onDelta: () => {
        }, executeTool: async () => {
            executed++;
        }
    }));
    const cancelled = assert.rejects(answer, error => error === reason);
    await opened.promise;
    controller.abort(reason);
    await cancelled;
    await closed.promise;
    await assert.rejects(requestAiChat(messages, options({signal: controller.signal})), error => error === reason);
    assert.equal(requests.length, 1);
    assert.equal(executed, 0);
});

test('未知 schema 约束在外发前拒绝，空工具清单仍走原聊天路径', async t => {
    const {requests} = await fixture(t, response => json(response, textReply('普通聊天')));
    const unknown = structuredClone(tools);
    unknown[0].function.parameters.properties.query.not = {const: '秘密'};
    await assert.rejects(requestAiChat(messages, options({tools: unknown})), unavailable);
    assert.equal(requests.length, 0);
    const answer = await requestAiChat(messages, options({
        tools: [],
        verifyTools: async () => assert.fail('普通聊天不复核工具')
    }));
    assert.deepEqual(answer, {content: '普通聊天', model: 'fake-model'});
    assert.deepEqual(requests, [{model: 'fake-model', messages, stream: false}]);
});

test('目标标识绑定模型地址、profile 和模型名，不改变原有初始化返回值', async t => {
    const {configFile, baseUrl} = await fixture(t, () => {
    });
    const key = createHash('sha256').update(JSON.stringify(['fake', `${baseUrl}/chat/completions`, 'fake-model'])).digest('hex');
    assert.deepEqual(await initializeAi({configFile, env: {FAKE_KEY: 'rotated-test-key'}}), {
        profile: 'fake',
        model: 'fake-model'
    });
    assert.equal(aiTargetKey(), key);
    await writeFile(configFile, 'ai:\n  enabled: false\n');
    assert.equal(await initializeAi({configFile, env: {}}), null);
    assert.equal(aiTargetKey(), undefined);
});
