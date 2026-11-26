import {lstat, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';

const fields = new Set(['enabled', 'approvedProfile', 'approvedTarget', 'allowTeamRead', 'allowDetail', 'allowIssues']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const disabled = reason => ({policy: null, reason});

export function resolveReadConfig(settings, profile, targetKey) {
    if (settings === undefined) return disabled('未配置 ai.readTools。');
    if (!object(settings) || Object.keys(settings).some(key => !fields.has(key))) return disabled('ai.readTools 含未知字段或不是配置对象。');
    if (typeof settings.enabled !== 'boolean' || ['allowTeamRead', 'allowDetail', 'allowIssues'].some(key =>
        Object.hasOwn(settings, key) && typeof settings[key] !== 'boolean')) return disabled('查询开关必须是 YAML 布尔值 true 或 false。');
    if (['approvedProfile', 'approvedTarget'].some(key => Object.hasOwn(settings, key) && typeof settings[key] !== 'string')) return disabled('模型名称和指纹必须是字符串。');
    if (!settings.enabled) return disabled('enabled 为 false。');
    if (!profile || settings.approvedProfile !== profile) return disabled('已批准的 profile 与当前模型配置不匹配。');
    if (!/^[a-f0-9]{64}$/.test(targetKey ?? '') || settings.approvedTarget !== targetKey) return disabled('目标指纹未配置或与当前端点、模型不匹配。');
    return {
        policy: {
            target: targetKey, team: settings.allowTeamRead === true,
            detail: settings.allowDetail === true, issues: settings.allowIssues === true
        }
    };
}

// 本机授权整组替换；文件存在但无法使用时不能回退到可能更宽的共享授权。
export async function loadReadConfig(configFile, shared, profile, targetKey) {
    const localPath = join(dirname(configFile instanceof URL ? fileURLToPath(configFile) : configFile), 'ai.local.yaml');
    try {
        await lstat(localPath);
    } catch (error) {
        if (error.code === 'ENOENT') return {source: 'ai.yaml', ...resolveReadConfig(shared, profile, targetKey)};
        return {source: 'ai.local.yaml', ...disabled('无法读取本机授权文件。')};
    }
    try {
        const doc = parse(await readFile(localPath, 'utf8'), {maxAliasCount: 0});
        if (!object(doc) || Object.keys(doc).length !== 1 || !object(doc.ai) || Object.keys(doc.ai).length !== 1 || !Object.hasOwn(doc.ai, 'readTools')) {
            return {source: 'ai.local.yaml', ...disabled('本机授权文件只接受 ai.readTools。')};
        }
        return {source: 'ai.local.yaml', ...resolveReadConfig(doc.ai.readTools, profile, targetKey)};
    } catch {
        return {source: 'ai.local.yaml', ...disabled('本机授权 YAML 无效，请检查缩进和重复字段。')};
    }
}

export function warnLegacyReadEnv(env, warn = console.warn) {
    if (['PROFILE', 'TARGET', 'TEAM', 'DETAIL'].some(suffix => Object.hasOwn(env, `OA_AGENT_READ_${suffix}`))) {
        warn('已忽略旧 OA_AGENT_READ_* 环境变量；请迁移到 YAML 的 ai.readTools。');
    }
}
