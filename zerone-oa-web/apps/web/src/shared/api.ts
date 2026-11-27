import type {
    AdminMemberAction, AdminMemberActionResponse, AdminMemberRequests, AdminMembersResponse, AuthActionResponse,
    ChangePasswordRequest, CsrfResponse, LoginRequest, LoginResponse, SaveRequest, SessionResponse,
    SetupRegisterRequest, SetupStatusResponse, StateResponse, ZeroAiCapabilities, ZeroAiReportRefResponse,
    ZeroAiSendRequest, ZeroAiSessionResponse, ZeroAiSessionsResponse, ZeroAiStreamEvent
} from "@oa/contracts";

export class ApiError extends Error {
    constructor(message: string, public readonly status: number, public readonly code?: string) {
        super(message);
        this.name = "ApiError";
    }
}

export function isUnauthenticated(error: unknown): error is ApiError {
    return error instanceof ApiError && error.status === 401;
}

export function requiresPasswordChange(error: unknown): error is ApiError {
    return error instanceof ApiError && error.status === 403 && error.code === "PASSWORD_CHANGE_REQUIRED";
}

export function isUncertainWrite(error: unknown) {
    return !(error instanceof ApiError) || error.status === 408 || error.status >= 500;
}

function isWrite(options?: RequestInit) {
    return (options?.method ?? "GET").toUpperCase() !== "GET";
}

async function fetchApi(path: string, options: RequestInit = {}, csrfToken?: string) {
    const headers = new Headers(options.headers);
    if (isWrite(options)) {
        if (!csrfToken) throw new Error("缺少页面安全凭证，请重新登录。");
        headers.set("Content-Type", "application/json");
    }
    if (csrfToken) headers.set("X-OA-CSRF", csrfToken);
    options.signal?.throwIfAborted();
    const response = await fetch(path, {...options, headers, credentials: "same-origin", cache: "no-store"});
    options.signal?.throwIfAborted();
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
        options.signal?.throwIfAborted();
        throw new ApiError(body?.error ?? (body?.code === "CSRF_INVALID"
            ? "页面安全凭证无效，请刷新后重试。" : `请求失败：${response.status}`), response.status, body?.code);
    }
    return response;
}

async function request<T>(path: string, options?: RequestInit, csrfToken?: string): Promise<T> {
    const result = await (await fetchApi(path, options, csrfToken)).json() as T;
    options?.signal?.throwIfAborted();
    return result;
}

export function loadSession(signal: AbortSignal) {
    return request<SessionResponse>("/api/session", {signal});
}

/** 旧凭证写入遇到 CSRF 拒绝时只验身，不更新旧作用域的凭证，不重放写入。 */
export async function recheckCsrfFailure(error: unknown, csrfToken: string, signal: AbortSignal, memberId?: string) {
    if (!(error instanceof ApiError) || error.status !== 403 || error.code !== "CSRF_INVALID") return error;
    try {
        const current = await loadSession(signal);
        if (current.csrfToken !== csrfToken || (memberId !== undefined && current.user.id !== memberId)) {
            return new ApiError("浏览器的登录会话已切换，请重新登录。", 401, "SESSION_CHANGED");
        }
    } catch (cause) {
        if (isUnauthenticated(cause)) return cause;
    }
    return error;
}

export async function login(credentials: LoginRequest, signal: AbortSignal) {
    const {csrfToken} = await request<CsrfResponse>("/api/csrf", {signal});
    return request<LoginResponse>("/api/login", {
        method: "POST", body: JSON.stringify(credentials), signal
    }, csrfToken);
}

export function loadSetupStatus(signal: AbortSignal) {
    return request<SetupStatusResponse>("/api/setup/status", {signal});
}

export async function registerSetup(credentials: SetupRegisterRequest, signal: AbortSignal) {
    const {csrfToken} = await request<CsrfResponse>("/api/csrf", {signal}).catch((error) => {
        if (signal.aborted) throw error;
        // 尚未发送注册，匿名凭证获取失败不属于写入结果未知。
        throw new ApiError("无法获取页面安全凭证。", 0, "SETUP_CSRF_UNAVAILABLE");
    });
    if (!csrfToken) throw new ApiError("无法获取页面安全凭证。", 0, "SETUP_CSRF_UNAVAILABLE");
    const result = await request<AuthActionResponse>("/api/setup/register", {
        method: "POST", body: JSON.stringify(credentials), redirect: "error", signal
    }, csrfToken);
    if (result?.ok !== true) throw new Error("无法确认首次设置结果。");
}

export function changePassword(passwords: ChangePasswordRequest, csrfToken: string, signal: AbortSignal) {
    return request<AuthActionResponse>("/api/password/change", {
        method: "POST", body: JSON.stringify(passwords), signal
    }, csrfToken);
}

export function logout(csrfToken: string, signal: AbortSignal) {
    return request<AuthActionResponse>("/api/logout", {method: "POST", body: "{}", signal}, csrfToken);
}

const zeroAiBase = "/api/zeroai/v2";
const sessionPath = (id: string) => `/${encodeURIComponent(id)}`;

function zeroAiPath(actorId: string, suffix = "", page?: { cursor: string } | { before: string }) {
    return `${zeroAiBase}/sessions${suffix}?${new URLSearchParams({actorId, ...page})}`;
}

type StreamResult = Omit<Extract<ZeroAiStreamEvent, { type: "result" }>, "turnId" | "seq">;
type StreamUpdate = Exclude<ZeroAiStreamEvent, { type: "result" }>;

/** 为一次会话固定凭证与取消信号，旧页面回调不会获取新会话的凭证。 */
export function createTeamApi(
    csrfToken: string,
    onAccessLost: (error: ApiError, operation?: "admin-write") => void,
    memberId?: string
) {
    const controller = new AbortController();
    const scopedSignal = (signal?: AbortSignal | null) => signal
        ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    async function fetchScoped(path: string, signal: AbortSignal, options?: RequestInit) {
        try {
            return await fetchApi(path, {...options, signal}, csrfToken);
        } catch (error) {
            const issue = !signal.aborted && isWrite(options)
                ? await recheckCsrfFailure(error, csrfToken, signal, memberId) : error;
            if (!signal.aborted && (isUnauthenticated(issue) || requiresPasswordChange(issue))) {
                onAccessLost(issue, path.startsWith("/api/admin/members/") && isWrite(options) ? "admin-write" : undefined);
            }
            throw issue;
        }
    }

    async function read<T>(path: string, options?: RequestInit): Promise<T> {
        const signal = scopedSignal(options?.signal);
        const data = await (await fetchScoped(path, signal, options)).json() as T;
        signal.throwIfAborted();
        return data;
    }

    async function sendZeroAi(
        path: string,
        message: ZeroAiSendRequest,
        callerSignal: AbortSignal,
        onEvent: (event: StreamUpdate) => void
    ): Promise<StreamResult> {
        const signal = scopedSignal(callerSignal);
        const response = await fetchScoped(path, signal, {
            method: "POST", headers: {Accept: "application/x-ndjson"}, body: JSON.stringify(message)
        });
        signal.throwIfAborted();
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
            const data = await response.json() as Omit<StreamResult, "type">;
            signal.throwIfAborted();
            return {...data, type: "result"};
        }
        if (!contentType.includes("application/x-ndjson") || !response.body) {
            throw new Error("服务返回了无法读取的回复。");
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let lastSeq = 0;
        let started = false;
        try {
            while (true) {
                const {done, value} = await reader.read();
                signal.throwIfAborted();
                const lines = done ? [buffer] : (buffer + value).split("\n");
                if (!done) buffer = lines.pop() ?? "";
                for (const line of lines) {
                    signal.throwIfAborted();
                    if (!line.trim()) continue;
                    const event = JSON.parse(line) as ZeroAiStreamEvent | null;
                    if (!event || event.turnId !== message.turnId || !Number.isSafeInteger(event.seq) || event.seq <= lastSeq) continue;
                    switch (event.type) {
                        case "result":
                            if (event.status === 401) {
                                const error = new ApiError("登录已失效，请重新登录。", 401);
                                onAccessLost(error);
                                throw error;
                            }
                            return event;
                        case "start":
                            lastSeq = event.seq;
                            if (!started) {
                                started = true;
                                onEvent(event);
                            }
                            break;
                        case "delta":
                            if (typeof event.content !== "string") break;
                            lastSeq = event.seq;
                            onEvent(event);
                            break;
                        case "phase":
                            if (event.phase !== "answering") break;
                            lastSeq = event.seq;
                            onEvent(event);
                            break;
                        case "tool":
                            if (typeof event.label !== "string" || !event.label.trim()) break;
                            if (event.callId !== undefined || event.status !== undefined) {
                                if (typeof event.callId !== "string" || !event.callId.trim() ||
                                    (event.status !== "pending" && event.status !== "done" && event.status !== "error")) break;
                            }
                            lastSeq = event.seq;
                            onEvent(event);
                            break;
                    }
                }
                if (done) throw new Error("回复连接已断开，请重试。");
            }
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    }

    return {
        close: () => controller.abort(),
        loadState: () => read<StateResponse>("/api/state"),
        saveState: (save: SaveRequest) => read<StateResponse>("/api/state", {
            method: "PUT", body: JSON.stringify(save)
        }),
        generateAiReminders: (actorId: string, weekId?: string) => read<StateResponse>("/api/ai-reminders", {
            method: "POST", body: JSON.stringify({actorId, weekId})
        }),
        adminMembers: {
            list: (signal: AbortSignal) => read<AdminMembersResponse>("/api/admin/members", {signal}),
            update: <Action extends AdminMemberAction>(action: Action, body: AdminMemberRequests[Action], signal: AbortSignal) =>
                read<AdminMemberActionResponse>(`/api/admin/members/${action}`, {
                    method: "POST", body: JSON.stringify(body), redirect: "error", signal
                })
        },
        zeroAi: {
            capabilities: (signal?: AbortSignal) => read<ZeroAiCapabilities>(`${zeroAiBase}/capabilities`, {signal}),
            list: (actorId: string, {signal, cursor}: { signal?: AbortSignal; cursor?: string } = {}) =>
                read<ZeroAiSessionsResponse>(zeroAiPath(actorId, "", cursor ? {cursor} : undefined), {signal}),
            open: (actorId: string, id: string, {signal, before}: { signal?: AbortSignal; before?: string } = {}) =>
                read<ZeroAiSessionResponse>(zeroAiPath(actorId, sessionPath(id), before ? {before} : undefined), {signal}),
            verifyReportRef: (actorId: string, sessionId: string, messageId: string, reportId: string, signal: AbortSignal) =>
                read<ZeroAiReportRefResponse>(zeroAiPath(actorId,
                    `${sessionPath(sessionId)}/messages/${encodeURIComponent(messageId)}/refs/report/${encodeURIComponent(reportId)}`), {signal}),
            create: (actorId: string) => read<ZeroAiSessionResponse>(zeroAiPath(actorId), {method: "POST"}),
            rename: (actorId: string, id: string, title: string) =>
                read<ZeroAiSessionResponse>(zeroAiPath(actorId, sessionPath(id)), {
                    method: "PATCH", body: JSON.stringify({title})
                }),
            remove: (actorId: string, id: string) =>
                read<ZeroAiSessionsResponse>(zeroAiPath(actorId, sessionPath(id)), {method: "DELETE"}),
            send: (actorId: string, id: string, message: ZeroAiSendRequest, signal: AbortSignal,
                   onEvent: (event: StreamUpdate) => void) =>
                sendZeroAi(zeroAiPath(actorId, `${sessionPath(id)}/messages`), message, signal, onEvent),
            selectVersion: (actorId: string, id: string, messageId: string) =>
                read<ZeroAiSessionResponse>(zeroAiPath(actorId, `${sessionPath(id)}/messages/select`), {
                    method: "POST", body: JSON.stringify({messageId})
                }),
            stop: (actorId: string, id: string, turnId: string, signal: AbortSignal) =>
                read<AuthActionResponse>(zeroAiPath(actorId, `${sessionPath(id)}/messages/stop`), {
                    method: "POST", body: JSON.stringify({turnId}), signal
                })
        },
        sendClientLog: (events: unknown[], actorId?: string, actorName?: string) => {
            void fetchScoped("/api/client-log", controller.signal, {
                method: "POST", keepalive: true, body: JSON.stringify({actorId, actorName, events})
            }).catch(() => undefined);
        }
    };
}

export type TeamApi = ReturnType<typeof createTeamApi>;
