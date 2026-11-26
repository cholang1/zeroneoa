import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createParser} from "eventsource-parser";
import {parse} from "yaml";
import {loadReadConfig} from './aiReadConfig.mjs';
import {requestModelTools, toolsUnavailable} from "./modelTools.mjs";

const defaultConfigFile = new URL("../../config/ai.yaml", import.meta.url);
let activeClient;

class AiError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function configError(message) {
    return new AiError("AI_CONFIG", message);
}

async function readConfig(file) {
    let source;
    try {
        source = await readFile(file, "utf8");
    } catch (error) {
        throw configError(`无法读取 ai.yaml（${error.code ?? "读取失败"}）。`);
    }
    try {
        return parse(source, {maxAliasCount: 0})?.ai;
    } catch {
        throw configError("ai.yaml 格式错误，请检查缩进和字段。");
    }
}

function completionUrl(baseUrl) {
    const url = typeof baseUrl === "string" ? URL.parse(baseUrl) : null;
    if (!url || !["https:", "http:"].includes(url.protocol) ||
        url.username || url.password || url.search || url.hash) {
        throw configError("当前模型的 baseUrl 必须是有效的 HTTP 或 HTTPS API 根地址。");
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
    return url;
}

export async function initializeAi({configFile = defaultConfigFile, env = process.env} = {}) {
    activeClient = undefined;
    const config = await readConfig(configFile);
    if (typeof config?.enabled !== "boolean") throw configError("ai.enabled 必须是布尔值。");
    if (!config.enabled) return null;

    const {activeProfile, profiles, timeoutMs} = config;
    if (typeof activeProfile !== "string" || !activeProfile.trim() ||
        !profiles || !Object.hasOwn(profiles, activeProfile)) {
        throw configError("ai.activeProfile 必须指向 profiles 中已有的模型配置。");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
        throw configError("ai.timeoutMs 必须是有效的正整数毫秒数。");
    }

    const {protocol, baseUrl, model, apiKeyEnv} = profiles[activeProfile] ?? {};
    if (protocol !== "openai-chat") throw configError("当前模型的 protocol 必须为 openai-chat。");
    if (typeof model !== "string" || !model.trim()) throw configError("当前模型的 model 不能为空。");
    if (typeof apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        throw configError("当前模型的 apiKeyEnv 必须填写环境变量名。");
    }

    const endpoint = completionUrl(baseUrl);
    const apiKey = env[apiKeyEnv]?.trim();
    if (!apiKey) throw configError(`请设置后端环境变量 ${apiKeyEnv}。`);

    const targetKey = createHash("sha256")
        .update(JSON.stringify([activeProfile, endpoint.href, model.trim()]))
        .digest("hex");
    const readAuthorization = await loadReadConfig(configFile, config.readTools, activeProfile, targetKey);
    activeClient = {endpoint, apiKey, model: model.trim(), timeoutMs, targetKey, readConfig: readAuthorization};
    return {profile: activeProfile, model: activeClient.model};
}

export function aiReadConfig() {
    return activeClient?.readConfig;
}

export function aiTargetKey() {
    return activeClient?.targetKey;
}

function postCompletion({endpoint, apiKey}, body, signal) {
    return fetch(endpoint, {
        method: "POST",
        headers: {"Content-Type": "application/json", Authorization: `Bearer ${apiKey}`},
        body,
        signal,
        redirect: "error"
    });
}

async function readCompletionStream(response, onDelta) {
    let content = "";
    let done = false;
    let finished = false;
    const parser = createParser({
        maxBufferSize: 1024 * 1024,
        onEvent({data}) {
            if (done) return;
            if (data === "[DONE]") {
                done = true;
                return;
            }
            const payload = JSON.parse(data);
            if (payload?.error) throw new AiError("AI_UPSTREAM", "模型接口中断了回复。");
            const choice = payload?.choices?.[0];
            if (choice?.finish_reason) finished = true;
            const delta = choice?.delta?.content;
            if (typeof delta === "string" && delta) {
                content += delta;
                onDelta(delta);
            }
        }
    });
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        parser.feed(chunk);
        if (done) break;
    }
    if (!done && !finished) throw new AiError("AI_RESPONSE", "模型接口的流式回复提前结束。");
    return content;
}

export async function requestAiChat(messages, options = {}) {
    if (!activeClient) throw new AiError("AI_DISABLED", "AI 对话当前不可用。");
    const {signal: cancellation, onDelta, tools} = options;
    const client = activeClient;
    const {model, timeoutMs} = client;
    if (tools !== undefined && (!Array.isArray(tools) || tools.length)) {
        return requestModelTools(messages, {
            model,
            timeoutMs,
            send(body, signal) {
                if (activeClient !== client) throw toolsUnavailable();
                return postCompletion(client, body, signal);
            }
        }, options);
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    let response;
    let content;
    try {
        response = await postCompletion(client, JSON.stringify({model, messages, stream: Boolean(onDelta)}), signal);
        if (!response.ok) {
            await response.body?.cancel();
            throw new AiError("AI_UPSTREAM", `模型接口请求失败（HTTP ${response.status}）。`);
        }
        if (onDelta && /^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) {
            content = await readCompletionStream(response, onDelta);
        } else {
            const payload = await response.json();
            content = payload?.choices?.[0]?.message?.content;
        }
    } catch (error) {
        if (cancellation?.aborted) throw cancellation.reason;
        if (deadline.aborted) throw new AiError("AI_TIMEOUT", "模型接口响应超时。");
        if (error instanceof AiError) throw error;
        throw new AiError(
            response ? "AI_RESPONSE" : "AI_UPSTREAM",
            response ? "模型接口返回了无法读取的内容。" : "无法连接模型接口。"
        );
    }

    if (typeof content !== "string" || !content.trim()) {
        throw new AiError("AI_RESPONSE", "模型接口没有返回可显示的回答。");
    }
    return {content, model};
}
