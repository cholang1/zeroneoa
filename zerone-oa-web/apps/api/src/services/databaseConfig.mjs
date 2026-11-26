import {readFile} from 'node:fs/promises';
import {loadEnvFile} from 'node:process';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {StateError} from '../repositories/schema.mjs';

const defaultDirectory = fileURLToPath(new URL('../../config/', import.meta.url));
const invalid = message => new StateError(503, message);

export function loadApiEnv() {
    try {
        loadEnvFile(new URL('../../.env', import.meta.url));
    } catch (error) {
        if (error.code !== 'ENOENT') throw invalid('无法读取后端 .env，请检查文件权限。');
    }
}

function validateUri(uri, source, requireDatabase) {
    // 不拆解主机列表，保留驱动对副本集和 SRV 地址的支持。不把 URI 带入错误消息。
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\/[^\s/?#]+(?:\/[^\s#]*)?$/u.test(uri) ||
        (requireDatabase && !/^mongodb(?:\+srv)?:\/\/[^/?#]+\/[^/?#]+(?:\?|$)/u.test(uri))) {
        throw invalid(`${source} 的 MongoDB 连接串无效${requireDatabase ? '，请在地址中明确填写数据库名' : ''}。`);
    }
    return uri;
}

export async function loadDatabaseConfig({directory = defaultDirectory, env = process.env} = {}) {
    if (env.MONGODB_URI !== undefined) {
        return {source: 'MONGODB_URI', uri: validateUri(env.MONGODB_URI, 'MONGODB_URI', false)};
    }
    for (const source of ['database.local.yaml', 'database.yaml']) {
        let text;
        try {
            text = await readFile(join(directory, source), 'utf8');
        } catch (error) {
            if (source === 'database.local.yaml' && error.code === 'ENOENT') continue;
            throw invalid(`无法读取 ${source}，请检查后端数据库配置。`);
        }
        let config;
        try {
            config = parse(text, {maxAliasCount: 0});
        } catch {
            throw invalid(`${source} 格式错误，请检查 YAML 缩进和字段。`);
        }
        const mongo = config?.mongodb;
        if (Object.keys(config ?? {}).length !== 1 || !mongo || typeof mongo !== 'object' || Array.isArray(mongo) ||
            Object.keys(mongo).some(k => k !== 'uri' && k !== 'tlsCAFile')) throw invalid(`${source} 仅支持 mongodb.uri 和可选的 mongodb.tlsCAFile。`);
        const uri = validateUri(mongo.uri, source, true);
        if (!Object.hasOwn(mongo, 'tlsCAFile')) return {source, uri};
        if (typeof mongo.tlsCAFile !== 'string' || !mongo.tlsCAFile.trim()) throw invalid(`${source} 的 tlsCAFile 必须是非空证书路径。`);
        return {source, uri, tlsCAFile: resolve(directory, mongo.tlsCAFile)};
    }
}
