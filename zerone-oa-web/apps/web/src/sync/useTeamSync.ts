import {useEffect, useRef, useState} from "react";
import type {
    AuditEvent,
    ChangePasswordRequest,
    LoginRequest,
    SessionResponse,
    SessionUser,
    SetupRegisterRequest,
    StateResponse,
    TeamState
} from "@oa/contracts";
import {
    ApiError, createTeamApi, isUnauthenticated, requiresPasswordChange, loadSession, recheckCsrfFailure,
    login as requestLogin, logout as requestLogout, changePassword as requestPasswordChange, registerSetup, type TeamApi
} from "../shared/api";
import {clearClientLog, clientLog} from "../shared/clientLog";
import {emptyTeamState} from "../shared/seedData";
import {nowIso, uid} from "../shared/utils";
import {clearLegacySession} from "../features/session/storage";
import {appError} from "../shared/error";
import {buildStateChanges, foldSaveSnapshot, mergeTeamState, overlayStateChanges} from "./merge";
import {
    memberRecoveryKey,
    parseRecovery,
    pendingRecovery,
    recoveryChanges,
    recoveryKey,
    type Recovery
} from "./recoveryModel";

function confirmSaveConflicts(conflicts: string[]) {
    const preview = conflicts.slice(0, 6).join("\n");
    const more = conflicts.length > 6 ? `\n...另有 ${conflicts.length - 6} 条` : "";
    return window.confirm(
        `检测到同一条数据被多人同时修改：\n${preview}${more}\n\n` +
        "确定：保留你的版本并覆盖这些冲突项。\n取消：暂不保存，当前页面内容会保留。"
    );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorStatus = (error: unknown) => error instanceof ApiError ? error.status : 0;
const transientStatus = (status: number) => [0, 502, 503, 504].includes(status);

function accessLostNotice(error: ApiError) {
    const reason = error.code === "SESSION_CHANGED" ? "浏览器的登录会话已切换" : "登录已失效";
    return `${reason}，请重新登录。未保存的更改只会在原成员登录后恢复。`;
}

type Workspace = { id: number; user: SessionUser; api: TeamApi; ready: boolean };

export async function saveWithMerge(
    base: TeamState,
    candidate: TeamState,
    actor: SessionUser,
    isActive: () => boolean,
    api: Pick<TeamApi, "loadState" | "saveState">,
    resolveConflicts = confirmSaveConflicts
): Promise<TeamState | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
        if (attempt > 0) await delay(250 * attempt);
        if (!isActive()) return null;
        const changes = buildStateChanges(base, candidate);
        if (!changes.length) return base;
        clientLog("save_attempt", {baseVersion: base.version, changes: changes.length, attempt});
        try {
            const result = await api.saveState({actorId: actor.id, baseVersion: base.version, changes});
            return isActive() ? result.state : null;
        } catch (error) {
            if (!isActive()) return null;
            lastError = error;
            const status = errorStatus(error);
            const transient = transientStatus(status);
            if (status !== 409 && !transient) throw error;

            // 响应丢失时写入可能已经提交，先读回聚合快照再判断是否需要重试。
            clientLog(transient ? "save_transient_retry" : "save_conflict_409", {
                attempt,
                status,
                baseVersion: base.version
            });
            if (transient) await delay(800 * (attempt + 1));
            if (!isActive()) return null;
            let latest: TeamState;
            try {
                latest = (await api.loadState()).state;
            } catch (loadError) {
                if (!isActive()) return null;
                if (transient && transientStatus(errorStatus(loadError)) && attempt < 5) continue;
                throw loadError;
            }
            if (!isActive()) return null;
            // 不用较旧的聚合快照重写差量基线。
            if (latest.version < base.version) continue;
            const merged = mergeTeamState(base, latest, candidate);
            if (merged.conflicts.length) {
                const overwrite = resolveConflicts(merged.conflicts);
                clientLog(overwrite ? "save_conflict_overwrite" : "save_cancelled_by_user", {
                    conflicts: merged.conflicts.slice(0, 20)
                });
                if (!overwrite) return null;
                candidate = mergeTeamState(base, latest, candidate, true).state;
            } else {
                candidate = merged.state;
            }
            base = latest;
            if (!buildStateChanges(base, candidate).length) return base;
        }
    }
    throw lastError;
}

export function useTeamSync() {
    const [state, setState] = useState<TeamState>(emptyTeamState);
    const [workspace, setWorkspace] = useState<Workspace | null>(null);
    const [authSession, setAuthSession] = useState<SessionResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [notice, setNotice] = useState("");
    const [authBusy, setAuthBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const stateRef = useRef<TeamState>(emptyTeamState);
    const latestSavedStateRef = useRef<TeamState>(emptyTeamState);
    const attemptedStateRef = useRef<TeamState | null>(null);
    const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
    const savingCountRef = useRef(0);
    const workspaceRef = useRef<Workspace | null>(null);
    const authRef = useRef<SessionResponse | null>(null);
    const authActionRef = useRef<AbortController | null>(null);
    const nextWorkspaceId = useRef(0);
    const lastRecoveryRef = useRef<string | null>(null);
    const memoryRecoveryRef = useRef(new Map<string, Recovery>());
    const user = workspace?.user ?? null;
    const api = workspace?.api ?? null;
    const isActive = () => workspace !== null && workspaceRef.current === workspace;

    function showState(next: TeamState) {
        stateRef.current = next;
        setState(next);
    }

    function setAuth(session: SessionResponse | null) {
        authRef.current = session;
        setAuthSession(session);
    }

    function clearWorkspace() {
        const previous = workspaceRef.current;
        workspaceRef.current = null;
        if (previous?.ready) writeRecovery(previous.user);
        previous?.api.close();
        saveQueueRef.current = Promise.resolve();
        savingCountRef.current = 0;
        lastRecoveryRef.current = null;
        latestSavedStateRef.current = emptyTeamState;
        attemptedStateRef.current = null;
        showState(emptyTeamState);
        setSaving(false);
        setWorkspace(null);
        clearClientLog();
    }

    function currentPending() {
        return pendingRecovery(latestSavedStateRef.current, stateRef.current, attemptedStateRef.current);
    }

    function writeRecovery(actor: SessionUser) {
        const pending = currentPending();
        const backup = pending.changes.length || pending.followUp?.length
            ? {actorId: actor.id, savedAt: nowIso(), ...pending} : null;
        const key = memberRecoveryKey(actor.id);
        try {
            if (backup) {
                const raw = JSON.stringify(backup);
                localStorage.setItem(key, raw);
                lastRecoveryRef.current = raw;
            } else if (lastRecoveryRef.current !== null) {
                // 不清除另一标签页后来写入的备份。
                if (localStorage.getItem(key) === lastRecoveryRef.current) localStorage.removeItem(key);
                lastRecoveryRef.current = null;
            }
            memoryRecoveryRef.current.delete(actor.id);
            return true;
        } catch {
            // 本地存储不可用时，在本标签页仍可由原成员重新登录恢复。
            if (backup) memoryRecoveryRef.current.set(actor.id, backup);
            else memoryRecoveryRef.current.delete(actor.id);
            return false;
        }
    }

    function readRecovery(actor: SessionUser) {
        function forActor(raw: string | null) {
            try {
                const saved = raw ? parseRecovery(raw) : null;
                return saved?.actorId === actor.id ? saved : null;
            } catch {
                return null;
            }
        }

        const memory = memoryRecoveryRef.current.get(actor.id);
        try {
            const key = memberRecoveryKey(actor.id);
            const raw = localStorage.getItem(key);
            const saved = forActor(raw);
            if (saved) lastRecoveryRef.current = raw;
            const backup = memory ?? saved;
            if (backup) return backup;

            // 旧版没有服务端认证，只有同一成员明确确认才迁移其共享键备份。
            const legacy = localStorage.getItem(recoveryKey);
            const migrated = forActor(legacy);
            if (!migrated || legacy === null || !window.confirm("检测到此成员在旧版留下的未保存更改。要恢复这些更改吗？")) return null;
            try {
                localStorage.setItem(key, legacy);
                lastRecoveryRef.current = legacy;
                if (localStorage.getItem(recoveryKey) === legacy) localStorage.removeItem(recoveryKey);
            } catch {
                // 即使无法迁移，当前成员也能尝试恢复。
            }
            return migrated;
        } catch {
            return memory;
        }
    }

    function restorePending(actor: SessionUser, server: TeamState, pending: ReturnType<typeof currentPending>) {
        const changes = recoveryChanges(server, pending);
        const base = overlayStateChanges(server, changes, "before");
        const local = overlayStateChanges(server, changes, "after");
        const merged = mergeTeamState(base, server, local);
        attemptedStateRef.current = null;
        if (merged.conflicts.length && !confirmSaveConflicts(merged.conflicts)) {
            // 暂不写入有冲突的记录，保留原前镜像，在下一次保存时重新判断。
            latestSavedStateRef.current = base;
            showState(local);
            writeRecovery(actor);
            return false;
        }
        latestSavedStateRef.current = server;
        showState(merged.conflicts.length ? mergeTeamState(base, server, local, true).state : merged.state);
        writeRecovery(actor);
        return true;
    }

    function adoptServerSnapshot(scope: Workspace, snapshot: TeamState) {
        const base = latestSavedStateRef.current;
        if (workspaceRef.current !== scope || attemptedStateRef.current || snapshot.version <= base.version) return false;
        const merged = mergeTeamState(base, snapshot, stateRef.current);
        // 后台读取不能替用户解决同条冲突，也不能把基线移到冲突的新版本。
        if (merged.conflicts.length) return false;
        latestSavedStateRef.current = snapshot;
        showState(merged.state);
        writeRecovery(scope.user);
        return true;
    }

    async function enqueue(scope: Workspace, run: () => Promise<void>) {
        if (workspaceRef.current !== scope) return;
        savingCountRef.current += 1;
        setSaving(true);
        const next = saveQueueRef.current.catch(() => undefined).then(async () => {
            if (workspaceRef.current === scope) await run();
        });
        saveQueueRef.current = next;
        try {
            await next;
        } finally {
            if (workspaceRef.current === scope) {
                savingCountRef.current -= 1;
                if (savingCountRef.current === 0) setSaving(false);
            }
        }
    }

    async function persistFor(scope: Workspace, next: TeamState) {
        const active = () => workspaceRef.current === scope;
        if (!active()) return;
        const {user, api} = scope;
        showState(next);
        // 请求在途或排队时关闭页面也能恢复，删除则保留原记录和 null 后镜像。
        writeRecovery(user);
        await enqueue(scope, async () => {
            try {
                // 上一请求未确认且读回也失败时，先对账，避免把可能已提交的变更当成没发生。
                if (attemptedStateRef.current) {
                    const {state: snapshot} = await api.loadState();
                    if (!active()) return;
                    if (snapshot.version < latestSavedStateRef.current.version) throw new Error("服务端快照版本较旧，请刷新后重试。");
                    if (!restorePending(user, snapshot, currentPending())) return;
                }
                // 开始执行时才采集最新编辑，避免发送已被前一请求合并掉的旧快照。
                const chainHead = stateRef.current;
                attemptedStateRef.current = chainHead;
                const saved = await saveWithMerge(latestSavedStateRef.current, chainHead, user, active, api);
                if (!active()) return;
                if (!saved) {
                    attemptedStateRef.current = null;
                    writeRecovery(user);
                    return;
                }
                if (saved.version < latestSavedStateRef.current.version) {
                    throw new Error("服务端返回了较旧的保存快照。");
                }
                // 聚合快照可能带回其他用户的数据。只叠加发送后发生的本地编辑。
                const folded = foldSaveSnapshot(chainHead, saved, stateRef.current);
                attemptedStateRef.current = null;
                latestSavedStateRef.current = folded.base;
                showState(folded.state);
                writeRecovery(user);
                clientLog("save_ok", {version: saved.version});
            } catch (error) {
                if (!active()) return;
                const backedUp = writeRecovery(user);
                clientLog("save_failed", {error: appError(error)}, {api, actorId: user.id, actorName: user.name});
                window.alert(`保存失败：${appError(error)}。${backedUp
                    ? "未保存的更改已备份在本设备，重新打开页面会尝试恢复。"
                    : "无法在本设备备份，请保留当前页面并重试。"}`);
            }
        });
    }

    async function persist(next: TeamState) {
        if (workspace) await persistFor(workspace, next);
    }

    async function runServerUpdate(update: () => Promise<StateResponse>) {
        if (!workspace) return;
        await enqueue(workspace, async () => {
            try {
                const {state: snapshot} = await update();
                adoptServerSnapshot(workspace, snapshot);
            } catch (error) {
                if (isActive()) throw error;
            }
        });
    }

    function stateForReference(version: number) {
        const current = stateRef.current;
        const saved = latestSavedStateRef.current;
        if (!isActive() || savingCountRef.current || attemptedStateRef.current ||
            current.version !== version || saved.version !== version ||
            buildStateChanges(saved, current).length) return;
        return current;
    }

    async function openVerifiedSession(session: SessionResponse, signal: AbortSignal) {
        signal.throwIfAborted();
        setAuth(session);
        if (session.mustChangePassword) return;
        const scope: Workspace = {
            id: ++nextWorkspaceId.current,
            user: session.user,
            api: createTeamApi(session.csrfToken, (error, operation) => {
                if (workspaceRef.current !== scope) return;
                clearWorkspace();
                setLoadError("");
                if (requiresPasswordChange(error)) {
                    setAuth({...session, mustChangePassword: true});
                } else {
                    setAuth(null);
                    const reason = accessLostNotice(error);
                    setNotice(operation === "admin-write"
                        ? `${reason} 成员操作的结果未确认，请重新登录后核对，不要直接重复提交。` : reason);
                }
            }, session.user.id),
            ready: false
        };
        workspaceRef.current = scope;
        try {
            const {state: snapshot} = await scope.api.loadState();
            if (signal.aborted || workspaceRef.current !== scope) return;
            latestSavedStateRef.current = snapshot;
            showState(snapshot);
            const saved = readRecovery(scope.user);
            const shouldRecover = saved && restorePending(scope.user, snapshot, saved)
                && buildStateChanges(snapshot, stateRef.current).length > 0;
            scope.ready = true;
            setWorkspace(scope);
            clientLog("state_loaded", {version: snapshot.version, reports: snapshot.dailyReports.length});
            if (shouldRecover) {
                clientLog("recovery_applied", {savedAt: saved.savedAt});
                void persistFor(scope, stateRef.current);
            }
        } catch (error) {
            if (signal.aborted || workspaceRef.current !== scope) return;
            clearWorkspace();
            setLoadError(appError(error));
        }
    }

    useEffect(() => {
        clearLegacySession();
        clearClientLog();
        const controller = new AbortController();
        authActionRef.current = controller;

        async function restoreSession() {
            try {
                await openVerifiedSession(await loadSession(controller.signal), controller.signal);
            } catch (error) {
                if (!controller.signal.aborted && !isUnauthenticated(error)) setLoadError(appError(error));
            } finally {
                if (!controller.signal.aborted) {
                    authActionRef.current = null;
                    setLoading(false);
                }
            }
        }

        void restoreSession();
        return () => {
            controller.abort();
            authActionRef.current?.abort();
            authActionRef.current = null;
            const scope = workspaceRef.current;
            workspaceRef.current = null;
            scope?.api.close();
        };
    }, []);

    async function runAuthAction(action: (signal: AbortSignal) => Promise<void>) {
        if (authActionRef.current) return;
        const controller = new AbortController();
        authActionRef.current = controller;
        setAuthBusy(true);
        try {
            await action(controller.signal);
        } finally {
            if (authActionRef.current === controller) {
                authActionRef.current = null;
                setAuthBusy(false);
            }
        }
    }

    async function signIn(credentials: LoginRequest) {
        if (authRef.current) return;
        await runAuthAction(async (signal) => {
            const loggedIn = await requestLogin(credentials, signal);
            setNotice("");
            let verified: SessionResponse;
            try {
                verified = await loadSession(signal);
            } catch (error) {
                if (signal.aborted) return;
                if (isUnauthenticated(error)) throw new Error("无法建立登录会话，请检查浏览器是否允许本站 Cookie 后重试。");
                setAuth(loggedIn);
                setLoadError(appError(error));
                return;
            }
            if (verified.user.id !== loggedIn.user.id || verified.csrfToken !== loggedIn.csrfToken) {
                throw new Error("登录会话已在其他页面切换，请重试。");
            }
            await openVerifiedSession(verified, signal);
        });
    }

    async function setUpFirstAdmin(credentials: SetupRegisterRequest) {
        if (authRef.current || authActionRef.current) {
            throw new ApiError("当前无法进行首次设置。", 409, "SETUP_AUTH_BUSY");
        }
        await runAuthAction(async (signal) => {
            await registerSetup(credentials, signal);
            setNotice("管理员账号已创建，请使用新账号登录。");
        });
    }

    async function signOut() {
        if (!authSession || authRef.current !== authSession) return;
        await runAuthAction(async (signal) => {
            clearWorkspace();
            setLoadError("");
            setLoading(true);
            try {
                await requestLogout(authSession.csrfToken, signal);
                setAuth(null);
                setNotice("");
            } catch (error) {
                if (signal.aborted) return;
                const issue = await recheckCsrfFailure(error, authSession.csrfToken, signal, authSession.user.id);
                if (signal.aborted) return;
                if (isUnauthenticated(issue)) {
                    setAuth(null);
                    setNotice(issue.code === "SESSION_CHANGED" ? accessLostNotice(issue) : "");
                } else {
                    setLoadError(`退出登录失败：${appError(issue)}`);
                }
            } finally {
                if (!signal.aborted) setLoading(false);
            }
        });
    }

    async function updatePassword(passwords: ChangePasswordRequest) {
        if (!authSession || authRef.current !== authSession) return;
        await runAuthAction(async (signal) => {
            try {
                await requestPasswordChange(passwords, authSession.csrfToken, signal);
                clearWorkspace();
                setAuth(null);
                setLoadError("");
                setNotice("密码已修改，请使用新密码登录。");
            } catch (error) {
                if (signal.aborted) return;
                const issue = await recheckCsrfFailure(error, authSession.csrfToken, signal, authSession.user.id);
                if (signal.aborted) return;
                if (!isUnauthenticated(issue)) throw issue;
                clearWorkspace();
                setAuth(null);
                setNotice(accessLostNotice(issue));
            }
        });
    }

    useEffect(() => {
        if (!workspace || loading) return;
        const scope = workspace;
        let cancelled = false;
        let refreshing = false;

        async function refreshFromServer(reason: string) {
            if (workspaceRef.current !== scope || refreshing || savingCountRef.current > 0) return;
            refreshing = true;
            try {
                const {state: snapshot} = await scope.api.loadState();
                if (!cancelled && savingCountRef.current === 0 && adoptServerSnapshot(scope, snapshot)) {
                    clientLog("background_refresh", {reason, version: snapshot.version});
                }
            } catch {
                // 暂时离线时等待下次刷新。
            } finally {
                refreshing = false;
            }
        }

        function onFocusOrVisible() {
            if (document.visibilityState === "visible") void refreshFromServer("focus");
        }

        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") void refreshFromServer("interval");
        }, 30000);
        window.addEventListener("focus", onFocusOrVisible);
        document.addEventListener("visibilitychange", onFocusOrVisible);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            window.removeEventListener("focus", onFocusOrVisible);
            document.removeEventListener("visibilitychange", onFocusOrVisible);
        };
    }, [workspace, loading]);

    useEffect(() => {
        if (!authSession?.mustChangePassword || loading) return;
        const session = authSession;
        const controller = new AbortController();
        let checking = false;

        async function verifyOnFocus() {
            if (document.visibilityState !== "visible" || authRef.current !== session || authActionRef.current || checking) return;
            checking = true;
            try {
                const current = await loadSession(controller.signal);
                if (current.csrfToken !== session.csrfToken || current.user.id !== session.user.id) {
                    throw new ApiError("浏览器的登录会话已切换。", 401, "SESSION_CHANGED");
                }
            } catch (error) {
                if (!controller.signal.aborted && authRef.current === session && !authActionRef.current && isUnauthenticated(error)) {
                    setAuth(null);
                    setNotice(accessLostNotice(error));
                }
            } finally {
                checking = false;
            }
        }

        window.addEventListener("focus", verifyOnFocus);
        document.addEventListener("visibilitychange", verifyOnFocus);
        return () => {
            controller.abort();
            window.removeEventListener("focus", verifyOnFocus);
            document.removeEventListener("visibilitychange", verifyOnFocus);
        };
    }, [authSession, loading]);

    useEffect(() => {
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            if (savingCountRef.current > 0) {
                event.preventDefault();
                event.returnValue = "数据正在保存中，现在离开可能丢失刚填写的内容。";
            }
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, []);

    function withAudit(next: TeamState, action: string, entityType: AuditEvent["entityType"], entityId: string) {
        if (!user) return next;
        return {
            ...next,
            auditLog: [...next.auditLog, {
                id: uid("audit"), entityType, entityId, actorId: user.id, action, createdAt: nowIso()
            }]
        };
    }

    return {
        state,
        user,
        api,
        workspaceId: workspace?.id,
        isActive,
        authSession,
        loading,
        loadError,
        notice,
        authBusy,
        signIn,
        signOut,
        setUpFirstAdmin,
        updatePassword,
        saving,
        stateRef,
        persist,
        runServerUpdate,
        stateForReference,
        withAudit
    };
}

export type TeamSync = ReturnType<typeof useTeamSync>;
