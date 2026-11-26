import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aiReadConfig, aiTargetKey, initializeAi, requestAiChat} from '../src/services/ai.mjs';
import {warnLegacyReadEnv} from '../src/services/aiReadConfig.mjs';

async function fixture(t) {
    const dir = await mkdtemp(join(tmpdir(), 'oa-yaml-test-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const configFile = join(dir, 'ai.yaml'), local = join(dir, 'ai.local.yaml');
    const ai = {
        enabled: true,
        activeProfile: 'mock',
        timeoutMs: 1000,
        profiles: {
            mock: {
                protocol: 'openai-chat',
                model: '合成模型',
                baseUrl: 'http://127.0.0.1:1/v1',
                apiKeyEnv: 'MOCK_KEY'
            }
        }
    };
    const env = {MOCK_KEY: '测试密钥'};
    const boot = async () => {
        await writeFile(configFile, JSON.stringify({ai}));
        await initializeAi({configFile, env});
        return aiReadConfig();
    };
    assert.equal((await boot()).policy, null);
    const target = aiTargetKey();
    const full = {
        enabled: true,
        approvedProfile: 'mock',
        approvedTarget: target,
        allowTeamRead: true,
        allowDetail: true
    };
    return {ai, env, local, boot, target, full};
}

test('共享 YAML 可授权，本机整组替换，关闭、换模型或换端点不沿用旧授权', async t => {
    const {ai, local, boot, target, full} = await fixture(t);
    ai.readTools = full;
    assert.deepEqual(await boot(), {source: 'ai.yaml', policy: {target, team: true, detail: true}});
    await writeFile(local, `ai:\n  readTools:\n    enabled: true\n    approvedProfile: mock\n    approvedTarget: "${target}"\n`);
    assert.deepEqual(await boot(), {source: 'ai.local.yaml', policy: {target, team: false, detail: false}});
    await writeFile(local, 'ai:\n  readTools:\n    enabled: false\n');
    assert.equal((await boot()).policy, null);
    await rm(local);
    ai.profiles.mock.model += '二';
    assert.equal((await boot()).policy, null);
    ai.profiles.mock.model = '合成模型';
    ai.profiles.mock.baseUrl += '/changed';
    assert.equal((await boot()).policy, null);
});

test('本机或共享权限配错都不授予权限，本机出错不继承共享授权，普通聊天仍可用', async t => {
    const {ai, local, boot, full} = await fixture(t);
    ai.readTools = {...full, allowDetail: 'false'};
    assert.equal((await boot()).policy, null);
    ai.readTools = full;
    for (const source of ['[', '', 'ai: {readTool: {enabled: true}}', 'ai: {readTools: null}',
        ...[{...full, allowTeamRead: 'false'}, {...full, allowTeam: true}, {
            ...full,
            approvedTarget: ''
        }, {enabled: true}]
            .map(readTools => JSON.stringify({ai: {readTools}}))]) {
        await writeFile(local, source);
        const result = await boot();
        assert.equal(result.source, 'ai.local.yaml');
        assert.equal(result.policy, null);
        assert.ok(result.reason);
    }
    await rm(local);
    await mkdir(local);
    assert.equal((await boot()).policy, null);
    t.mock.method(globalThis, 'fetch', async (_url, opts) => {
        assert.equal(JSON.parse(opts.body).tools, undefined);
        return Response.json({choices: [{message: {content: '聊天可用'}}]});
    });
    assert.equal((await requestAiChat([{role: 'user', content: '你好'}])).content, '聊天可用');
});

test('旧环境变量仅提示迁移，不输出值也不能开启查询', async t => {
    const {env, boot, target} = await fixture(t);
    Object.assign(env, {
        OA_AGENT_READ_PROFILE: 'mock',
        OA_AGENT_READ_TARGET: target,
        OA_AGENT_READ_TEAM: '1',
        OA_AGENT_READ_DETAIL: '1'
    });
    assert.equal((await boot()).policy, null);
    const logs = [];
    warnLegacyReadEnv({}, s => logs.push(s));
    warnLegacyReadEnv(env, s => logs.push(s));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /已忽略/);
    assert.ok(!logs[0].includes(target));
});
