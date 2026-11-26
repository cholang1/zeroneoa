import {addAbortListener} from "node:events";
import {createParser} from "eventsource-parser";
import {compileToolSchema, isObject} from "./modelToolsSchema.mjs";

const maxModelRequests = 4;
const maxToolCalls = 6;
const maxToolBytes = 8 * 1024;
const maxReplyChars = 128 * 1024;
const maxResponseChars = 1024 * 1024;
const namePattern = /^[a-zA-Z0-9_-]{1,64}$/;
const finishName = 'finish_query';
const finishTool = {
    type: 'function', function: {
        name: finishName, description: '无需查询或已有足够信息时单独调用，切换到正式回答；不是 OA 查询。',
        parameters: {type: 'object', properties: {}, additionalProperties: false}
    }
};
const planInstruction = '当前是查询决策阶段，不写回答正文。需要数据时调用适当的 OA 工具；不需要查询或查询已足够时单独调用 finish_query。';
const answerInstruction = '现在直接回答用户，不再查询。涉及 OA 事实时仅依据已获准的数据，未查到或信息不足要说明。按内容需要使用 Markdown，保留段落、列表和表格应有的换行。';

function withInstruction(history, instruction) {
    const [first, ...rest] = history;
    return first?.role === 'system' ? [{...first, content: `${first.content}\n${instruction}`}, ...rest]
        : [{role: 'system', content: instruction}, ...history];
}

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

function completeTurn(content, calls, finishReason) {
    if (content !== null && (typeof content !== "string" || content.length > maxReplyChars)) throw toolsUnavailable();
    if (calls != null && !Array.isArray(calls)) throw toolsUnavailable();
    if (calls?.length > maxToolCalls) throw toolLimit();
    if (calls?.length ? finishReason !== "tool_calls" : finishReason != null && finishReason !== "stop") {
        throw toolsUnavailable();
    }
    return {content, calls: calls ?? []};
}

function appendFragment(target, key, part, maxLength) {
    if (part === undefined) return;
    if (typeof part !== "string" || target[key].length + part.length > maxLength) throw toolsUnavailable();
    target[key] += part;
}

async function readToolStream(response, answerDelta) {
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
            if (answerDelta && delta?.tool_calls != null &&
                (!Array.isArray(delta.tool_calls) || delta.tool_calls.length)) throw toolsUnavailable();
            if (delta?.content != null) {
                if (typeof delta.content !== "string") throw toolsUnavailable();
                size += delta.content.length;
                if (size > maxReplyChars) throw toolsUnavailable();
                if (delta.content) {
                    chunks.push(delta.content);
                    answerDelta?.(delta.content);
                }
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
    return completeTurn(chunks.join(""), calls, finishReason);
}

async function readToolCompletion(response, answerDelta) {
    if (/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) return readToolStream(response, answerDelta);
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
    const turn = completeTurn(message.content ?? null, message.tool_calls, choice.finish_reason);
    if (answerDelta && turn.calls.length) throw toolsUnavailable();
    if (turn.content) answerDelta?.(turn.content);
    return turn;
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
    onAnswering,
    signal: cancellation
}) {
    cancellation?.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(timeoutMs, 60_000));
    const signal = cancellation ? AbortSignal.any([cancellation, deadline.signal]) : deadline.signal;
    try {
        const decisionTools = onDelta && Array.isArray(tools) ? [...tools, finishTool] : tools;
        const {definitions, validators} = prepareTools(decisionTools, executeTool, verifyTools);
        const history = structuredClone(messages);
        if (!Array.isArray(history)) throw toolsUnavailable();
        const usedIds = new Set();
        let answering = false;
        for (let round = 1; round <= maxModelRequests; round++) {
            // 预留最后一次请求写回答，保持整轮模型请求次数及总时限不变。
            if (onDelta && round === maxModelRequests) answering = true;
            const body = JSON.stringify({
                model,
                messages: onDelta ? withInstruction(history, answering ? answerInstruction : planInstruction) : history,
                stream: Boolean(onDelta), ...(!answering && {tools: definitions})
            });
            // 请求已经组装好；复核通过之后才把消息（可能包含刚读到的 OA 数据）发给模型。
            const response = await untilAborted(async () => {
                if (await verifyTools() === false) throw toolsUnavailable();
                signal.throwIfAborted();
                if (answering) onAnswering?.();
                return send(body, signal);
            }, signal);
            if (!response.ok) {
                if (response.body) void response.body.cancel().catch(() => {
                });
                if ([400, 404, 405, 415, 422, 501].includes(response.status)) throw toolsUnavailable();
                throw new ModelToolError("AI_UPSTREAM", `模型接口请求失败（HTTP ${response.status}）。`);
            }
            const {content, calls} = await untilAborted(() => readToolCompletion(response, answering ? chunk => {
                signal.throwIfAborted();
                onDelta(chunk);
            } : undefined), signal);
            signal.throwIfAborted();
            if (!calls.length) {
                if (!content?.trim()) throw toolsUnavailable();
                if (!onDelta || answering) return {content, model};
                // 兼容不调用 finish_query 而直接写草稿的模型；不发布草稿，让正式回答独立生成。
                answering = true;
                continue;
            }
            if (onDelta && calls.some(call => call?.function?.name === finishName)) {
                if (calls.length !== 1) throw toolsUnavailable();
                parseCalls(calls, validators, usedIds);
                answering = true;
                continue;
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
