import {loadApiEnv, loadDatabaseConfig} from './services/databaseConfig.mjs';
import {openStore} from "./repositories/mongoStore.mjs";
import {createApiServer} from "./app.mjs";
import {configuredOrigin} from "./routes/auth.mjs";
import {initializeAi, aiTargetKey, aiReadConfig} from "./services/ai.mjs";
import {warnLegacyReadEnv} from './services/aiReadConfig.mjs';

loadApiEnv();
warnLegacyReadEnv(process.env);

let readPolicy;
try {
    const ai = await initializeAi();
    if (ai) {
        const {policy, source, reason} = aiReadConfig();
        readPolicy = policy;
        console.log(`OA AI 已加载模型配置：${ai.profile} / ${ai.model}；目标指纹 ${aiTargetKey()}；${source}：业务查询${policy ? '已启用' : `未启用（${reason}）`}`);
    }
} catch (error) {
    console.warn("OA AI 未启用：", error.code === "AI_CONFIG" ? error.message : "初始化失败。");
}

let store;
try {
    let origin;
    try {
        origin = configuredOrigin();
    } catch {
        throw Object.assign(new Error('请检查 OA_PUBLIC_ORIGIN：正式部署必须配置精确的 HTTPS 网页源，不含路径。'), {status: 503});
    }
    const {uri, tlsCAFile, source} = await loadDatabaseConfig();
    console.log(`OA 数据库配置来源：${source}`);
    store = await openStore(uri, {
        tlsCAFile,
        workspaceKey: process.env.OA_WORKSPACE_KEY || undefined,
        historyRetentionDays: Number(process.env.OA_AGENT_HISTORY_DAYS ?? 90)
    });
    await store.initialize();
    const server = createApiServer(store, {origin, readPolicy});
    server.once("error", async (error) => {
        console.error("OA API 监听失败：", error.code);
        await store.close();
        process.exitCode = 1;
    });
    server.listen(Number(process.env.TEAM_API_PORT || 4318), "127.0.0.1", () => {
        console.log(`OA API 已启动：http://localhost:${server.address().port}`);
    });
    const shutdown = () => server.close(() => store.close());
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
} catch (error) {
    await store?.close();
    console.error("OA API 未启动：", error.status ? error.message : `请检查 MongoDB 服务、所选数据库配置和读写权限（${error.name}）。`);
    process.exitCode = 1;
}
