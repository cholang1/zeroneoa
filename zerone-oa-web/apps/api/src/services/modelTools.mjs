import {addAbortListener} from "node:events";
import {createParser} from "eventsource-parser";
import {compileToolSchema, isObject} from "./modelToolsSchema.mjs";

const maxModelRequests = 4;
const maxToolCalls = 6;
const maxToolBytes = 8 * 1024;
const maxReplyChars = 128 * 1024;
const maxResponseChars = 1024 * 1024;
const namePattern = /^[a-zA-Z0-9_-]{1,64}$/;

export class ModelToolError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export function toolsUnavailable() {
    return new ModelToolError("AI_TOOLS_UNAVAILABLE", "模型工具不可用，本次未查询成功；这不代表 OA 没有记录。");
}

function toolLimit(message = "查询次数达到上限，请缩小查询范围后重试。") {
    return new ModelToolError("AI_TOOL_LIMIT", message);
}

function prepareTools(tools, executeTool, verifyTools) {
    try {
        if (!Array.isArray(tools) || typeof executeTool !== "function" || typeof verifyTools !== "function") {
            throw toolsUnavailable();
        }
        const definitions = structuredClone(tools);
        const validators = new Map();
        for (const tool of definitions) {
            const fn = tool?.function;
            if (tool?.type !== "function" || !isObject(fn) || typeof fn.name !== "string" ||
                !namePattern.test(fn.name) || validators.has(fn.name) || fn.parameters?.type !== "object") {
                throw toolsUnavailable();
            }
            validators.set(fn.name, compileToolSchema(fn.parameters));
        }
        return {definitions, validators};
    } catch {
        throw toolsUnavailable();
    }
}

function completeTurn(content, calls, finishReason, chunks = []) {
    if (content !== null && (typeof content !== "string" || content.length > maxReplyChars)) throw toolsUnavailable();
    if (calls != null && !Array.isArray(calls)) throw toolsUnavailable();
    if (calls?.length > maxToolCalls) throw toolLimit();
    if (calls?.length ? finishReason !== "tool_calls" : finishReason != null && finishReason !== "stop") {
        throw toolsUnavailable();
    }
    return {content, calls: calls ?? [], chunks};
}

function appendFragment(target, key, part, maxLength) {
    if (part === undefined) return;
    if (typeof part !== "string" || target[key].length + part.length > maxLength) throw toolsUnavailable();
    target[key] += part;
}

async function readToolStream(response) {
    const chunks = [];
    const calls = [];
    let size = 0;
    let eventSize = 0;
    let done = false;
    let finishReason;
    const parser = createParser({
        maxBufferSize: maxResponseChars,
        onError(error) {
            if (error.type === "max-buffer-size-exceeded") throw toolsUnavailable();
        },
        onEvent({data, event}) {
            if (done) return;
            if (event === "error") throw toolsUnavailable();
            if (data === "[DONE]") {
                done = true;
                return;
            }
            eventSize += data.length;
            if (eventSize > maxResponseChars) throw toolsUnavailable();
            const payload = JSON.parse(data);
            if (payload?.error || !Array.isArray(payload?.choices) || payload.choices.length > 1) throw toolsUnavailable();
            if (!payload.choices.length) return;
            const [choice] = payload.choices;
            if (!isObject(choice) || (choice.index !== undefined && choice.index !== 0) || finishReason !== undefined) {
                throw toolsUnavailable();
            }
            const {delta} = choice;
            if ((delta != null && !isObject(delta)) || delta?.function_call != null) throw toolsUnavailable();
            if (delta?.content != null) {
                if (typeof delta.content !== "string") throw toolsUnavailable();
                size += delta.content.length;
                if (size > maxReplyChars) throw toolsUnavailable();
                if (delta.content) chunks.push(delta.content);
            }
            if (delta?.tool_calls != null) {
                if (!Array.isArray(delta.tool_calls)) throw toolsUnavailable();
                for (const part of delta.tool_calls) {
                    if (!isObject(part) || !Number.isSafeInteger(part.index) || part.index < 0 ||
                        (part.type !== undefined && part.type !== "function") ||
                        (part.function !== undefined && !isObject(part.function))) throw toolsUnavailable();
                    if (part.index >= maxToolCalls) throw toolLimit();
                    const call = calls[part.index] ??= {id: "", type: undefined, function: {name: "", arguments: ""}};
                    if (part.type) call.type = part.type;
                    appendFragment(call, "id", part.id, 256);
                    appendFragment(call.function, "name", part.function?.name, 64);
                    appendFragment(call.function, "arguments", part.function?.arguments, maxToolBytes);
                }
            }
            if (choice.finish_reason != null) {
                if (typeof choice.finish_reason !== "string") throw toolsUnavailable();
                finishReason = choice.finish_reason;
            }
        }
    });
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream("utf-8", {fatal: true}))) {
        parser.feed(chunk);
        if (done) break;
    }
    if (!done && finishReason === undefined) throw toolsUnavailable();
    // 稀疏索引表示缺了调用，不能把后面的调用当作完整批次执行。
    if (Array.from(calls).includes(undefined)) throw toolsUnavailable();
    return completeTurn(chunks.join(""), calls, finishReason, chunks);
}

async function readToolCompletion(response) {
    if (/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) return readToolStream(response);
    let body = "";
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream("utf-8", {fatal: true}))) {
        body += chunk;
        if (body.length > maxResponseChars) throw toolsUnavailable();
    }
    const payload = JSON.parse(body);
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    if (payload?.error || !Array.isArray(payload?.choices) || payload.choices.length !== 1 || !isObject(message) ||
        (choice.index !== undefined && choice.index !== 0) || (message.role !== undefined && message.role !== "assistant") ||
        message.function_call != null) throw toolsUnavailable();
    return completeTurn(message.content ?? null, message.tool_calls, choice.finish_reason);
}

function parseCalls(calls, validators, usedIds) {
    return calls.map(call => {
        const {id, type, function: fn} = call ?? {};
        const validate = validators.get(fn?.name);
        if (typeof id !== "string" || !/^[^\s\p{Cc}]{1,256}$/u.test(id) || usedIds.has(id) ||
            type !== "function" || !validate || typeof fn.arguments !== "string" ||
            Buffer.byteLength(fn.arguments) > maxToolBytes) throw toolsUnavailable();
        let args;
        try {
            args = JSON.parse(fn.arguments);
        } catch {
            throw toolsUnavailable();
        }
        if (!validate(args)) throw toolsUnavailable();
        usedIds.add(id);
        return {call: {id, type, function: {name: fn.name, arguments: fn.arguments}}, args};
    });
}

function encodeResult(result) {
    let content;
    try {
        content = JSON.stringify(result);
    } catch {
        throw toolsUnavailable();
    }
    if (typeof content !== "string") throw toolsUnavailable();
    if (Buffer.byteLength(content) > maxToolBytes) throw toolLimit("查询结果过大，请缩小查询范围后重试。");
    return content;
}

async function untilAborted(task, signal) {
    signal.throwIfAborted();
    let listener;
    try {
        const aborted = new Promise((resolve, reject) => {
            listener = addAbortListener(signal, () => reject(signal.reason));
        });
        return await Promise.race([aborted, Promise.resolve().then(() => {
            signal.throwIfAborted();
            return task();
        })]);
    } finally {
        listener?.[Symbol.dispose]();
    }
}

export async function requestModelTools(messages, {model, timeoutMs, send}, {
    tools,
    executeTool,
    verifyTools,
    onDelta,
    signal: cancellation
}) {
    cancellation?.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(timeoutMs, 60_000));
    const signal = cancellation ? AbortSignal.any([cancellation, deadline.signal]) : deadline.signal;
    try {
        const {definitions, validators} = prepareTools(tools, executeTool, verifyTools);
        const history = structuredClone(messages);
        if (!Array.isArray(history)) throw toolsUnavailable();
        const usedIds = new Set();
        for (let round = 1; round <= maxModelRequests; round++) {
            const body = JSON.stringify({model, messages: history, stream: Boolean(onDelta), tools: definitions});
            // 请求已经组装好；复核通过之后才把消息（可能包含刚读到的 OA 数据）发给模型。
            const response = await untilAborted(async () => {
                if (await verifyTools() === false) throw toolsUnavailable();
                signal.throwIfAborted();
                return send(body, signal);
            }, signal);
            if (!response.ok) {
                if (response.body) void response.body.cancel().catch(() => {
                });
                if ([400, 404, 405, 415, 422, 501].includes(response.status)) throw toolsUnavailable();
                throw new ModelToolError("AI_UPSTREAM", `模型接口请求失败（HTTP ${response.status}）。`);
            }
            const {content, calls, chunks} = await untilAborted(() => readToolCompletion(response), signal);
            signal.throwIfAborted();
            if (!calls.length) {
                if (!content?.trim()) throw toolsUnavailable();
                // 先辨明这一轮是最终回答，不能把可能伴随工具调用的草稿流给前端。
                if (onDelta) {
                    for (const chunk of chunks.length ? chunks : [content]) {
                        signal.throwIfAborted();
                        onDelta(chunk);
                    }
                    signal.throwIfAborted();
                }
                return {content, model};
            }
            if (round === maxModelRequests || usedIds.size + calls.length > maxToolCalls) throw toolLimit();
            // 整批参数先通过校验，避免执行到一半才发现同批另一个调用非法。
            const batch = parseCalls(calls, validators, usedIds);
            history.push({role: "assistant", content: content || null, tool_calls: batch.map(({call}) => call)});
            for (const {call, args} of batch) {
                const result = await untilAborted(() => executeTool(call.function.name, args), signal);
                signal.throwIfAborted();
                history.push({role: "tool", tool_call_id: call.id, content: encodeResult(result)});
            }
        }
    } catch (error) {
        if (cancellation?.aborted) throw cancellation.reason;
        if (deadline.signal.aborted) throw new ModelToolError("AI_TIMEOUT", "模型工具查询超时。");
        if (error instanceof ModelToolError) throw error;
        throw toolsUnavailable();
    } finally {
        clearTimeout(timer);
    }
}
