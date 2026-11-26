import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {loadDatabaseConfig} from '../src/services/databaseConfig.mjs';
import {openStore} from '../src/repositories/mongoStore.mjs';

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'oa-yaml-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    return {
        directory,
        put: (file, text) => writeFile(join(directory, file), text),
        read: (env = {}) => loadDatabaseConfig({directory, env})
    };
}

test('环境覆盖本机 YAML，本机 YAML 完整替换共享配置，证书路径以文件目录为准', async t => {
    const f = await fixture(t);
    const base = 'mongodb://127.0.0.1:27018/team', local = 'mongodb://db1:27017,db2:27017/local?replicaSet=rs0';
    await f.put('database.yaml', `mongodb:\n  uri: '${base}'\n`);
    assert.deepEqual(await f.read(), {source: 'database.yaml', uri: base});
    await f.put('database.local.yaml', `mongodb:\n  uri: '${local}'\n  tlsCAFile: ./certs/ca.pem\n`);
    assert.deepEqual(await f.read(), {
        source: 'database.local.yaml',
        uri: local,
        tlsCAFile: join(f.directory, 'certs', 'ca.pem')
    });
    const uri = 'mongodb+srv://cluster.example.invalid/deploy';
    assert.deepEqual(await f.read({MONGODB_URI: uri}), {source: 'MONGODB_URI', uri});
});

test('配置缺失或选中的配置损坏时不改连其他库，也不回显原文凭据', async t => {
    const f = await fixture(t);
    await assert.rejects(f.read(), /无法读取 database.yaml/);
    await f.put('database.yaml', 'mongodb:\n  uri: mongodb://localhost/good\n');
    for (const text of ['mongodb: [synthetic-secret', 'mongodb: {uri: http://synthetic-secret/db}',
        'mongodb: {uri: mongodb://localhost/}', 'mongodb: {uri: mongodb://localhost/ok, tlsCAFile: 2}',
        'mongodb: {uri: mongodb://localhost/ok, unexpected: synthetic-secret}']) {
        await f.put('database.local.yaml', text);
        await assert.rejects(f.read(), e => e.status === 503 && e.message.includes('database.local.yaml') && !e.message.includes('synthetic-secret'));
    }
    await assert.rejects(f.read({MONGODB_URI: ''}), /MONGODB_URI/);
});

test('不设置环境变量，仅使用 YAML 连接并初始化指定随机测试库', async t => {
    const f = await fixture(t);
    const name = `oa_test_yaml_${randomUUID().replaceAll('-', '')}`;
    const uri = `mongodb://127.0.0.1:27018/${name}?retryWrites=false`;
    await f.put('database.yaml', `mongodb:\n  uri: '${uri}'\n`);
    const config = await f.read();
    const store = await openStore(config.uri, {tlsCAFile: config.tlsCAFile});
    const inspect = new MongoClient(uri);
    t.after(async () => {
        await store.close();
        try {
            await inspect.db(name).dropDatabase();
        } finally {
            await inspect.close();
        }
    });
    await store.initialize();
    assert.equal((await inspect.db(name).collection('team_meta').findOne({_id: 'default'})).schema, 'oa-business-v1');
});
