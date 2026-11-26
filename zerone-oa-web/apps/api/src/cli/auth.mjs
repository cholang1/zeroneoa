import {parseArgs} from 'node:util';
import {loadApiEnv, loadDatabaseConfig} from '../services/databaseConfig.mjs';
import {openStore, StateError} from '../repositories/mongoStore.mjs';

const usage = `用法（先停止访问同一库的 OA API，在同一台主机上执行）：
  node apps/api/src/cli/auth.mjs --db <数据库> list
  node apps/api/src/cli/auth.mjs --db <数据库> bind-first-admin --member-id <已核对的成员ID> --name <该成员的完整姓名>
  node apps/api/src/cli/auth.mjs --db <数据库> provision --member-id <ID> --login-name <登录名>
  node apps/api/src/cli/auth.mjs --db <数据库> create --name <姓名> --login-name <登录名>
  node apps/api/src/cli/auth.mjs --db <数据库> reset --member-id <ID>
  node apps/api/src/cli/auth.mjs --db <数据库> disable --member-id <ID>
数据库必须已初始化。连接配置与 API 一致：MONGODB_URI（含后端 .env）优先，其次 database.local.yaml、database.yaml。--db 明确选择该服务器上的目标库。
开通、新建和重置仅在成功时输出一次初始口令，请私下交付，不要写入日志。停用账号不能重置。`;
const fields = {
    list: [],
    'bind-first-admin': ['member-id', 'name'],
    provision: ['member-id', 'login-name'],
    create: ['name', 'login-name'],
    reset: ['member-id'],
    disable: ['member-id']
};

async function main(args) {
    if (args.length === 1 && args[0] === '--help') {
        console.log(usage);
        return;
    }
    let input;
    try {
        input = parseArgs({
            args, allowPositionals: true, options: Object.fromEntries(
                ['db', 'member-id', 'login-name', 'name'].map(key => [key, {type: 'string', multiple: true}]))
        });
    } catch {
        throw new StateError(400, '命令或选项无效，请使用 --help。');
    }
    const {positionals: [command, ...rest], values} = input;
    const required = ['db', ...(Object.hasOwn(fields, command) ? fields[command] : [])];
    if (!Object.hasOwn(fields, command) || rest.length || Object.keys(values).length !== required.length ||
        !required.every(key => values[key]?.length === 1 && values[key][0].trim()) ||
        !/^[A-Za-z0-9_-]{1,63}$/.test(values.db[0]) || ['admin', 'local', 'config'].includes(values.db[0])) {
        throw new StateError(400, '请提供明确的业务库和完整命令选项，详见 --help。');
    }
    const databaseName = values.db[0];
    loadApiEnv();
    const {uri, tlsCAFile} = await loadDatabaseConfig();
    const store = await openStore(uri, {databaseName, tlsCAFile, requireExisting: true, initializeAgentHistory: false});
    let output;
    try {
        await store.initialize();
        const id = values['member-id']?.[0], loginName = values['login-name']?.[0];
        switch (command) {
            case 'list':
                output = JSON.stringify(await store.auth.listMembers());
                break;
            case 'bind-first-admin':
                await store.auth.bindFirstAdmin(id, values.name[0]);
                output = '已按核对的成员 ID 绑定首位账号管理员；请重新登录查看成员管理。';
                break;
            case 'provision':
                output = await store.auth.provision(id, loginName);
                break;
            case 'create':
                output = JSON.stringify(await store.auth.createMember(values.name[0], loginName));
                break;
            case 'reset':
                output = await store.auth.reset(id);
                break;
            case 'disable':
                await store.auth.disable(id);
                output = '账号已停用。';
                break;
        }
    } finally {
        await store.close();
    }
    console.log(output);
}

try {
    await main(process.argv.slice(2));
} catch (error) {
    // 不转发驱动错误或命令参数，避免泄露连接字符串、口令和凭据字段。
    console.error(error instanceof StateError ? error.message :
        '维护未完成，请核对连接和权限。若开通结果不明，请核对成员 ID；口令未交付时需重置。');
    process.exitCode = 1;
}
