import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rmdir, unlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeAi, requestAiChat} from '../src/services/ai.mjs';

const messages = [{role: 'user', content: '你好'}];

async function configFixture(t) {
    const dir = await mkdtemp(join(tmpdir(), 'oa-ai-'));
    const configFile = join(dir, 'ai.yaml');
    t.after(async () => {
        await unlink(configFile);
        await rmdir(dir);
    });
    return {configFile, write: contents => writeFile(configFile, contents, 'utf8')};
}

async function modelServer(t, handleRequest) {
    const server = createServer(handleRequest);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

function config(activeProfile, firstUrl, secondUrl = firstUrl, timeoutMs = 1500) {
    return `
ai:
  enabled: true
  activeProfile: ${activeProfile}
  timeoutMs: ${timeoutMs}
  profiles:
    first:
      protocol: openai-chat
      baseUrl: ${firstUrl}
      model: model-one
      apiKeyEnv: FIRST_KEY
    second:
      protocol: openai-chat
      baseUrl: ${secondUrl}/v1/
      model: model-two
      apiKeyEnv: SECOND_KEY
`;
}

test('读取 YAML 后按选定模型发送请求，重新初始化后使用新地址和密钥', async t => {
    const requests = [];
    const echo = async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        requests.push({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            ...payload
        });
        response.end(JSON.stringify({choices: [{message: {content: `回复 ${payload.model}`}}]}));
    };
    const first = await modelServer(t, echo);
    const second = await modelServer(t, echo);
    const {configFile, write} = await configFixture(t);
    const env = {FIRST_KEY: 'first-test-key'};

    await write(config('first', first, second));
    assert.deepEqual(await initializeAi({configFile, env}), {profile: 'first', model: 'model-one'});
    await write(config('second', first, second));
    assert.deepEqual(await requestAiChat(messages), {content: '回复 model-one', model: 'model-one'});

    env.SECOND_KEY = 'second-test-key';
    assert.deepEqual(await initializeAi({configFile, env}), {profile: 'second', model: 'model-two'});
    assert.deepEqual(await requestAiChat(messages), {content: '回复 model-two', model: 'model-two'});
    assert.deepEqual(requests, [
        {
            method: 'POST', url: '/chat/completions', authorization: 'Bearer first-test-key',
            model: 'model-one', messages, stream: false
        },
        {
            method: 'POST', url: '/v1/chat/completions', authorization: 'Bearer second-test-key',
            model: 'model-two', messages, stream: false
        }
    ]);
});

test('缺选中模型密钥、配置有误及关闭时，模型调用不可用', async t => {
    const {configFile, write} = await configFixture(t);
    await write(config('first', 'http://127.0.0.1'));
    await assert.rejects(initializeAi({configFile, env: {}}), {code: 'AI_CONFIG', message: /FIRST_KEY/});

    await write('ai: [');
    await assert.rejects(initializeAi({configFile, env: {}}), {code: 'AI_CONFIG'});

    await write('ai:\n  enabled: false\n');
    assert.equal(await initializeAi({configFile, env: {}}), null);
    await assert.rejects(requestAiChat(messages), {code: 'AI_DISABLED'});
});

test('区分上游失败、空回答和超时，错误不包含上游响应内容', async t => {
    let mode = 'rejected';
    const url = await modelServer(t, (request, response) => {
        if (mode === 'rejected') {
            response.writeHead(401).end('上游响应原文');
        } else if (mode === 'empty') {
            response.end(JSON.stringify({choices: []}));
        }
    });
    const {configFile, write} = await configFixture(t);
    const env = {FIRST_KEY: 'first-test-key'};

    await write(config('first', url));
    await initializeAi({configFile, env});
    await assert.rejects(requestAiChat(messages), {
        code: 'AI_UPSTREAM', message: '模型接口请求失败（HTTP 401）。'
    });

    mode = 'empty';
    await assert.rejects(requestAiChat(messages), {code: 'AI_RESPONSE'});

    mode = 'timeout';
    await write(config('first', url, url, 60));
    await initializeAi({configFile, env});
    await assert.rejects(requestAiChat(messages), {code: 'AI_TIMEOUT'});
});

test('兼容接口逐块读取 SSE、处理跨分块的中文，并取消模型连接', {timeout: 5000}, async t => {
    let upstreamClosed;
    const closed = new Promise(resolve => {
        upstreamClosed = resolve;
    });
    let upstream;
    let streamFlag;
    const url = await modelServer(t, async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        streamFlag = JSON.parse(body).stream;
        upstream = response;
        response.once('close', upstreamClosed);
        response.writeHead(200, {'Content-Type': 'text/event-stream'});
        const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\n');
        const split = bytes.indexOf(Buffer.from('中')) + 1;
        response.write(': keepalive\r\n\r\n');
        response.write(bytes.subarray(0, split));
        setImmediate(() => response.write(bytes.subarray(split)));
    });
    const {configFile, write} = await configFixture(t);
    await write(config('first', url, url, 3000));
    await initializeAi({configFile, env: {FIRST_KEY: 'test-key'}});
    const controller = new AbortController();
    const chunks = [];
    let firstDelta;
    const first = new Promise(resolve => {
        firstDelta = resolve;
    });
    const answer = requestAiChat(messages, {
        signal: controller.signal,
        onDelta(chunk) {
            chunks.push(chunk);
            firstDelta(chunk);
        }
    });
    const cancelled = assert.rejects(answer, {name: 'AbortError'});
    assert.equal(await first, '中文');
    assert.equal(streamFlag, true);
    assert.equal(upstream.writableEnded, false);
    controller.abort();
    await cancelled;
    await closed;
    assert.deepEqual(chunks, ['中文']);
});

test('SSE 正常结束后返回完整回复，提前断流会报错', async t => {
    let complete = true;
    const url = await modelServer(t, (request, response) => {
        response.writeHead(200, {'Content-Type': 'text/event-stream'});
        response.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
        response.end(complete ? 'data: {"choices":[{"delta":{"content":"！"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' : '');
    });
    const {configFile, write} = await configFixture(t);
    await write(config('first', url));
    await initializeAi({configFile, env: {FIRST_KEY: 'test-key'}});
    const chunks = [];
    const options = {onDelta: chunk => chunks.push(chunk)};
    assert.deepEqual(await requestAiChat(messages, options), {content: '你好！', model: 'model-one'});
    assert.deepEqual(chunks, ['你好', '！']);
    complete = false;
    await assert.rejects(requestAiChat(messages, options), {code: 'AI_RESPONSE'});
});
