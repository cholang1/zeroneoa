import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {FormEvent, KeyboardEvent, ReactNode} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
    SessionUser, ZeroAiCapabilities, ZeroAiMessage, ZeroAiQueryCard, ZeroAiSendRequest, ZeroAiSession,
    ZeroAiSessionsResponse, ZeroAiSessionSummary
} from "@oa/contracts";
import {ApiError, isUncertainWrite, type TeamApi} from "../../shared/api";
import {appError} from "../../shared/error";
import {uid} from "../../shared/utils";
import {MessageAction, SessionActions, ZeroAiIcon} from "./ZeroAiActions";
import "./zeroAi.css";

const emptyDraft = (sessionId: string | null = null) => ({sessionId, turnId: uid("turn"), content: ""});
const markdownPlugins = [remarkGfm];
const isMissingSession = (cause: unknown) => cause instanceof ApiError && cause.status === 404;
const maxPromptLength = 4000;
const followUps = [
    {label: "总结一下", prompt: "请总结一下刚才的 OA 查询结果。"},
    {label: "有哪些值得关注", prompt: "刚才的 OA 查询结果里，有哪些值得关注？"},
    {label: "给我下一步建议", prompt: "请根据刚才的 OA 查询结果，给我下一步建议。"}
];
const queryTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

type OpenReportSource = (sessionId: string, messageId: string, id: string, version: number, signal: AbortSignal) =>
    Promise<string | undefined>;
type ToolActivity = { seq: number; label: string };

function QuerySources({cards, onOpen, checking}: {
    cards: ZeroAiQueryCard[];
    onOpen?: (id: string, version: number) => void;
    checking?: boolean;
}) {
    return (
        <section className="zero-ai-sources" aria-label="查询来源">
            <strong className="zero-ai-sources-title">查询来源</strong>
            {cards.map(({name, label, scopeLabel, asOf, refs, truncated, teamVersion}, index) => {
                const time = Date.parse(asOf);
                return (
                    <div className="zero-ai-source" key={`${name}:${index}`}>
                        <div className="zero-ai-source-heading">
                            <strong>{label}</strong>
                            {truncated ? <span className="zero-ai-source-limit">部分结果</span> : null}
                        </div>
                        <div className="zero-ai-source-meta">
                            {scopeLabel ? <span>范围：{scopeLabel}</span> : null}
                            {Number.isFinite(time) ? (
                                <span>查询于 <time dateTime={asOf} title={asOf}>{queryTime.format(time)}</time>（北京时间）</span>
                            ) : null}
                        </div>
                        {refs.length ? (
                            <ul className="zero-ai-source-refs">
                                {refs.map((ref, refIndex) => (
                                    <li key={`${ref.type}:${ref.id}:${refIndex}`}>
                                        <span>{ref.label}</span>
                                        {ref.type === "report" && typeof ref.id === "string" && ref.id &&
                                        typeof teamVersion === "number" && Number.isSafeInteger(teamVersion) && teamVersion >= 0 ? (
                                            <button type="button" className="text-button zero-ai-source-open"
                                                    aria-label={`打开日报：${ref.label}`} disabled={checking || !onOpen}
                                                    onClick={() => onOpen?.(ref.id, teamVersion)}>打开日报</button>
                                        ) : <small>仅供参考，无法定位</small>}
                                    </li>
                                ))}
                            </ul>
                        ) : <small className="zero-ai-source-meta">没有可定位的记录</small>}
                    </div>
                );
            })}
        </section>
    );
}

interface RecoveredDraft {
    session: ZeroAiSessionSummary;
    id: string;
    content: string;
    kind: "消息" | "编辑";
}

interface ActiveGeneration {
    controller: AbortController;
    stop?: () => Promise<{ ok: true }>;
    stopRequested: boolean;
}

async function copyText(text: string) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        // 在通过局域网 HTTP 访问时，浏览器可能没有启用 Clipboard API。
    }
    const focused = document.activeElement;
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.append(field);
    try {
        field.select();
        if (!document.execCommand("copy")) throw new Error("复制失败，请选中文本后手动复制。");
    } finally {
        field.remove();
        if (focused instanceof HTMLElement) focused.focus({preventScroll: true});
    }
}

function Message({
                     message,
                     pending,
                     copied,
                     onCopy,
                     onRevise,
                     onSelect,
                     editing,
                     activity,
                     onOpenSource,
                     checkingSource
                 }: {
    message: ZeroAiMessage;
    pending?: boolean;
    copied?: boolean;
    onCopy?: () => void;
    onRevise?: () => void;
    onSelect?: (messageId: string) => void;
    editing?: ReactNode;
    activity?: ToolActivity[];
    onOpenSource?: (id: string, version: number) => void;
    checkingSource?: boolean;
}) {
    const {role, content, status, versions, queryCards, queryBasis} = message;
    const isUser = role === "user";
    const queryNote = queryBasis === "previous" ? "沿用此前查询，本轮未刷新"
        : queryBasis === "none" ? "本轮未查询 OA" : "";
    return (
        <article className={`zero-ai-message ${role}`} data-message-id={message.id}>
            <div className="zero-ai-message-meta">{isUser ? "我" : "ZeroAI"}</div>
            {editing ?? (content ? (
                isUser ? <p className="zero-ai-prompt">{content}</p> : (
                    <div className="zero-ai-markdown">
                        <Markdown
                            skipHtml
                            remarkPlugins={markdownPlugins}
                            components={{img: ({alt}) => alt ? <span>{alt}</span> : null}}
                        >
                            {content}
                        </Markdown>
                    </div>
                )
            ) : null)}
            {activity?.length ? (
                <ul className="zero-ai-tool-activity" aria-label="查询活动">
                    {activity.map(({seq, label}) => <li key={seq}>{label}</li>)}
                </ul>
            ) : null}
            {pending && !content && !activity?.length ? <p className="zero-ai-message-status">正在回复…</p> : null}
            {!isUser && (queryCards?.length ? (
                <QuerySources cards={queryCards} onOpen={onOpenSource} checking={checkingSource}/>
            ) : queryNote ? <p className="zero-ai-message-status">{queryNote}</p> : null)}
            {status ? (
                <p className="zero-ai-message-status">{status === "stopped" ? "已停止生成" : "回复已中断"}</p>
            ) : null}
            {!pending && !editing && (versions || (content && onCopy) || onRevise) ? (
                <div className="zero-ai-message-toolbar">
                    {versions ? (
                        <div className="zero-ai-versions"
                             aria-label={`第 ${versions.current} 个版本，共 ${versions.total} 个版本`}>
                            <MessageAction icon="previous" label="上一版本" disabled={!versions.previousId || !onSelect}
                                           onClick={() => versions.previousId && onSelect?.(versions.previousId)}/>
                            <span>{versions.current} / {versions.total}</span>
                            <MessageAction icon="next" label="下一版本" disabled={!versions.nextId || !onSelect}
                                           onClick={() => versions.nextId && onSelect?.(versions.nextId)}/>
                        </div>
                    ) : null}
                    <div className="zero-ai-message-actions">
                        {content && onCopy ? (
                            <MessageAction icon={copied ? "check" : "copy"} label={copied ? "已复制" : "复制"}
                                           onClick={onCopy}/>
                        ) : null}
                        {onRevise ? (
                            <MessageAction icon={isUser ? "edit" : "regenerate"} label={isUser ? "编辑" : "重新生成"}
                                           onClick={onRevise}/>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </article>
    );
}

interface ZeroAiPageProps {
    user: SessionUser;
    visible: boolean;
    api: TeamApi["zeroAi"];
    onOpenReportSource: OpenReportSource;
}

export function ZeroAiPage(props: ZeroAiPageProps) {
    const {api} = props;
    const [capabilities, setCapabilities] = useState<ZeroAiCapabilities>();
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        const {signal} = controller;
        void api.capabilities(signal).then(result => {
            if (result?.historyV2 !== true) throw new Error("会话服务暂不可用。");
            if (!signal.aborted) setCapabilities(result);
        }).catch(cause => {
            if (!signal.aborted) setError(`无法连接会话服务：${appError(cause)}`);
        });
        return () => controller.abort();
    }, [api, retry]);

    if (!capabilities) {
        return (
            <section className="zero-ai" aria-label="ZeroAI 对话">
                <div className="zero-ai-bootstrap">
                    {error ? <div className="zero-ai-error" role="alert">
                        <span>{error}</span>
                        <button type="button" className="text-button" onClick={() => {
                            setError("");
                            setRetry(count => count + 1);
                        }}>重试
                        </button>
                    </div> : <span role="status">正在读取会话…</span>}
                </div>
            </section>
        );
    }

    return <ZeroAiChat {...props} readTools={capabilities.readTools === true}
                       readIssues={capabilities.readTools === true && capabilities.readIssues === true}/>;
}

const openIssuesPrompt = "我目前有哪些未解决的日报问题？请列出关联任务和已有的解决方案。";

function ZeroAiChat({user, visible, api: history, readTools, readIssues, onOpenReportSource}: ZeroAiPageProps & {
    readTools: boolean; readIssues: boolean
}) {
    const [sessionList, setSessionList] = useState<ZeroAiSessionsResponse>({sessions: []});
    const [listError, setListError] = useState("");
    const [session, setSession] = useState<ZeroAiSession | null>(null);
    const [draft, setDraft] = useState(() => emptyDraft());
    const [recoveredDrafts, setRecoveredDrafts] = useState<RecoveredDraft[]>([]);
    const [phase, setPhase] = useState<"loading" | "idle" | "opening" | "creating" | "saving" | "sending" | "pagingMessages" | "pagingSessions" | "unavailable">("loading");
    const [error, setError] = useState("");
    const [reviewTurn, setReviewTurn] = useState<ZeroAiSendRequest | null>(null);
    const [staleSession, setStaleSession] = useState(false);
    const [titleDraft, setTitleDraft] = useState<{ id: string; value: string } | null>(null);
    const [editDraft, setEditDraft] = useState<{ id: string; content: string } | null>(null);
    const [pending, setPending] = useState<{ turnId: string; prefixLength: number; prompt?: string } | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [reply, setReply] = useState("");
    const [activity, setActivity] = useState<ToolActivity[]>([]);
    const [sourceNotice, setSourceNotice] = useState("");
    const [checkingSource, setCheckingSource] = useState(false);
    const sourceRequest = useRef<AbortController | null>(null);
    const [stopping, setStopping] = useState(false);
    const [copiedId, setCopiedId] = useState("");
    const [reload, setReload] = useState(0);
    const logRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const focusFollowUp = useRef(false);
    const sidebarRef = useRef<HTMLElement>(null);
    const sidebarToggleRef = useRef<HTMLButtonElement>(null);
    const followReply = useRef(true);
    const prependScroll = useRef<{ top: number; height: number } | null>(null);
    const revealMessage = useRef<string | null>(null);
    const generation = useRef<ActiveGeneration | null>(null);
    const {sessions, nextCursor} = sessionList;
    const activeId = session?.id;
    const composerDraft = draft.sessionId === (activeId ?? null) ? draft : null;
    const messageCount = session?.messages.length;
    const sending = phase === "sending";
    const ready = phase === "idle";
    const canRevise = ready && !titleDraft && !editDraft && !reviewTurn && !staleSession;
    const canOpenSources = !!activeId && visible && phase !== "opening" && phase !== "loading" && phase !== "unavailable";
    const displayedMessages = pending ? session?.messages.slice(0, pending.prefixLength) : session?.messages;
    const latestMessage = displayedMessages?.at(-1);
    const offerFollowUps = readTools && latestMessage?.role === "assistant" && !!latestMessage.queryCards?.length;

    useLayoutEffect(() => {
        if (!focusFollowUp.current) return;
        focusFollowUp.current = false;
        const field = inputRef.current;
        if (!field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }, [draft]);

    useLayoutEffect(() => {
        setCheckingSource(false);
        setSourceNotice("");
        return () => {
            sourceRequest.current?.abort();
            sourceRequest.current = null;
        };
    }, [activeId, session?.branchEpoch, canOpenSources, pending?.turnId]);

    useEffect(() => {
        const controller = new AbortController();
        const {signal} = controller;
        setPhase("loading");
        followReply.current = true;

        async function load() {
            try {
                const list = await history.list(user.id, {signal});
                const first = list.sessions[0];
                const active = first ? (await history.open(user.id, first.id, {signal})).session : null;
                if (signal.aborted) return;
                setSessionList(list);
                setListError("");
                setSession(active);
                setDraft(emptyDraft(active?.id));
                setPhase("idle");
            } catch (cause) {
                if (signal.aborted) return;
                setError(appError(cause));
                setPhase("unavailable");
            }
        }

        void load();
        return () => controller.abort();
    }, [history, user.id, reload]);

    useEffect(() => () => generation.current?.controller.abort(), []);

    useEffect(() => {
        function closeOverlay() {
            sidebarRef.current?.querySelector<HTMLElement>(":popover-open")?.hidePopover();
            setSidebarOpen(false);
        }

        if (!visible) closeOverlay();
        const narrow = window.matchMedia("(max-width: 720px)");
        narrow.addEventListener("change", closeOverlay);
        return () => narrow.removeEventListener("change", closeOverlay);
    }, [visible]);

    useEffect(() => {
        if (sidebarOpen) sidebarRef.current?.querySelector<HTMLButtonElement>(".zero-ai-session[aria-current], .zero-ai-new")?.focus();
    }, [sidebarOpen]);

    useEffect(() => {
        if (!copiedId) return;
        const timer = window.setTimeout(() => setCopiedId(""), 1800);
        return () => window.clearTimeout(timer);
    }, [copiedId]);

    useEffect(() => {
        const log = logRef.current;
        if (followReply.current && visible && log) log.scrollTop = log.scrollHeight;
    }, [activeId, messageCount, reply, activity, sending, visible]);

    useLayoutEffect(() => {
        const log = logRef.current;
        if (!log) return;
        if (prependScroll.current) {
            const {top, height} = prependScroll.current;
            log.scrollTop = top + log.scrollHeight - height;
            prependScroll.current = null;
        }
        if (revealMessage.current) {
            log.querySelector(`[data-message-id="${CSS.escape(revealMessage.current)}"]`)?.scrollIntoView({block: "nearest"});
            revealMessage.current = null;
        }
    }, [session]);

    function adoptSummary({id, title}: ZeroAiSession) {
        setSessionList(list => ({...list, sessions: [{id, title}, ...list.sessions.filter(item => item.id !== id)]}));
    }

    async function refreshList(signal?: AbortSignal) {
        if (signal?.aborted) return;
        // 写入可能改变列表排序，不能继续使用旧列表的游标。
        setSessionList(list => ({sessions: list.sessions}));
        setListError("");
        try {
            setSessionList(await history.list(user.id, {signal}));
        } catch (cause) {
            if (!signal?.aborted) setListError(appError(cause));
        }
    }

    async function loadMoreSessions() {
        if (!ready || titleDraft) return;
        setPhase("pagingSessions");
        setListError("");
        try {
            if (!nextCursor) {
                await refreshList();
                return;
            }
            const page = await history.list(user.id, {cursor: nextCursor});
            const seen = new Set(sessions.map(item => item.id));
            setSessionList({...page, sessions: [...sessions, ...page.sessions.filter(item => !seen.has(item.id))]});
        } catch (cause) {
            if (cause instanceof ApiError && cause.status === 409) setSessionList({sessions});
            setListError(appError(cause));
        } finally {
            setPhase("idle");
        }
    }

    async function readEarlier(current: ZeroAiSession, before: string, signal?: AbortSignal): Promise<ZeroAiSession> {
        const {session: page} = await history.open(user.id, current.id, {before, signal});
        const seen = new Set(current.messages.map(message => message.id));
        return {
            ...current,
            before: page.before,
            messages: [...page.messages.filter(message => !seen.has(message.id)), ...current.messages]
        };
    }

    async function loadEarlierMessages() {
        if (!canRevise || !session?.before) return;
        setPhase("pagingMessages");
        setError("");
        try {
            const next = await readEarlier(session, session.before);
            const log = logRef.current;
            if (log) prependScroll.current = {top: log.scrollTop, height: log.scrollHeight};
            followReply.current = false;
            setSession(next);
        } catch (cause) {
            await showFailure(cause, {targetId: session.id, canRefresh: true});
        } finally {
            setPhase("idle");
        }
    }

    async function replaceSnapshot(next: ZeroAiSession, anchor?: string, signal?: AbortSignal) {
        const priorCount = session?.id === next.id ? session.messages.length : 0;
        const seenCursors = new Set<string>();
        let pagingError = "";
        // 只从最新快照的游标补页，不能把上一条分支的消息拼进来。
        try {
            while (next.before && !seenCursors.has(next.before) && (next.messages.length < priorCount ||
                (anchor && !next.messages.some(message => message.id === anchor)))) {
                seenCursors.add(next.before);
                next = await readEarlier(next, next.before, signal);
            }
        } catch (cause) {
            if (isMissingSession(cause)) throw cause;
            pagingError = `会话已更新，但读取更早消息失败：${appError(cause)}`;
        }
        if (!signal?.aborted) {
            if (anchor) revealMessage.current = anchor;
            setSession(next);
        }
        return {snapshot: next, pagingError};
    }

    async function openSession(id: string) {
        if (!ready || titleDraft !== null) return;
        setSidebarOpen(false);
        if (id === session?.id && !reviewTurn && !staleSession) return;
        setPhase("opening");
        setError("");
        try {
            const {session: next} = await history.open(user.id, id);
            followReply.current = true;
            if (id === session?.id) {
                const {snapshot, pagingError} = await replaceSnapshot(next);
                setError(pagingError);
                if (reviewTurn) clearSentDraft(snapshot, reviewTurn);
                if (editDraft && !snapshot.messages.some(message => message.id === editDraft.id)) setEditDraft(null);
            } else {
                setSession(next);
                setDraft(emptyDraft(next.id));
                setEditDraft(null);
            }
            setStaleSession(false);
            setReviewTurn(null);
            setCopiedId("");
        } catch (cause) {
            await showFailure(cause, {targetId: id});
        } finally {
            setPhase("idle");
        }
    }

    async function createSession() {
        if (!ready || titleDraft !== null) return;
        setPhase("creating");
        setError("");
        try {
            const {session: next} = await history.create(user.id);
            followReply.current = true;
            setSession(next);
            adoptSummary(next);
            setSidebarOpen(false);
            setDraft(emptyDraft(next.id));
            setEditDraft(null);
            setStaleSession(false);
            setReviewTurn(null);
            setCopiedId("");
            await refreshList();
        } catch (cause) {
            setError(appError(cause));
        } finally {
            setPhase("idle");
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }

    async function showFailure(cause: unknown, {targetId, canRefresh = false, current = session}: {
        targetId?: string; canRefresh?: boolean; current?: ZeroAiSession | null;
    }) {
        if (!targetId || !isMissingSession(cause)) {
            if (canRefresh && cause instanceof ApiError && cause.status === 409) setStaleSession(true);
            setError(appError(cause));
            return;
        }

        setError("这段会话已不存在。");
        setTitleDraft(null);
        setSessionList(list => ({sessions: list.sessions.filter(item => item.id !== targetId)}));
        if (current?.id !== targetId) {
            // 另一个会话被删除，不动当前会话及其草稿。
            await refreshList();
            return;
        }

        const source = {id: current.id, title: current.title};
        const copies: RecoveredDraft[] = [];
        // 首次发送自动创建会话时，本轮回调仍持有创建前的草稿。
        if (composerDraft?.content.trim()) copies.push({
            session: source, id: composerDraft.turnId, content: composerDraft.content, kind: "消息"
        });
        if (editDraft?.content.trim()) copies.push({
            session: source, id: uid("draft"), content: editDraft.content, kind: "编辑"
        });
        if (copies.length) setRecoveredDrafts(previous => [...previous, ...copies]);
        setDraft(emptyDraft());
        setSession(null);
        setEditDraft(null);
        setReviewTurn(null);
        setStaleSession(false);
        setReload(count => count + 1);
    }

    async function renameSession(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const title = titleDraft?.value.trim();
        if (!titleDraft || !title || !ready) return;
        setPhase("saving");
        setError("");
        try {
            const {session: renamed} = await history.rename(user.id, titleDraft.id, title);
            if (renamed.id === activeId) setError((await replaceSnapshot(renamed)).pagingError);
            setSessionList(list => ({
                ...list, sessions: list.sessions.map(item => item.id === renamed.id
                    ? {id: renamed.id, title: renamed.title} : item)
            }));
            setTitleDraft(null);
            await refreshList();
        } catch (cause) {
            await showFailure(cause, {targetId: titleDraft.id});
        } finally {
            setPhase("idle");
        }
    }

    async function deleteSession(item: ZeroAiSessionSummary) {
        if (!ready || !window.confirm(`确定删除「${item.title}」及其中的所有消息？`)) return;
        setPhase("saving");
        setError("");
        let targetId = item.id;
        let current = session;
        try {
            const remaining = await history.remove(user.id, item.id);
            setSessionList(remaining);
            setListError("");
            if (item.id === activeId) {
                setSidebarOpen(false);
                current = null;
                setSession(null);
                setDraft(emptyDraft());
                setEditDraft(null);
                setReviewTurn(null);
                setStaleSession(false);
                setCopiedId("");
                followReply.current = true;
                const first = remaining.sessions[0];
                if (first) {
                    targetId = first.id;
                    setSession((await history.open(user.id, targetId)).session);
                    setDraft(emptyDraft(targetId));
                }
            }
        } catch (cause) {
            await showFailure(cause, {targetId, current});
        } finally {
            setPhase("idle");
        }
    }

    function dismissSidebar() {
        setSidebarOpen(false);
        requestAnimationFrame(() => sidebarToggleRef.current?.focus());
    }

    async function selectVersion(messageId: string) {
        if (!session || !canRevise) return;
        setPhase("opening");
        setError("");
        try {
            const result = await history.selectVersion(user.id, session.id, messageId);
            followReply.current = false;
            setError((await replaceSnapshot(result.session, messageId)).pagingError);
            await refreshList();
        } catch (cause) {
            await showFailure(cause, {targetId: session.id, canRefresh: true});
        } finally {
            setPhase("idle");
        }
    }

    async function copy({content, id}: { content: string; id: string }) {
        try {
            await copyText(content);
            setCopiedId(id);
        } catch {
            setError("复制失败，请选中文本后手动复制。");
        }
    }

    async function requestStop(turn: ActiveGeneration) {
        if (!turn.stop) return;
        try {
            await turn.stop();
        } catch (cause) {
            if (!turn.controller.signal.aborted && generation.current === turn) {
                turn.stopRequested = false;
                setStopping(false);
                setError(appError(cause));
            }
        }
    }

    function stopGeneration() {
        const turn = generation.current;
        if (!turn || turn.stopRequested) return;
        turn.stopRequested = true;
        setStopping(true);
        void requestStop(turn);
    }

    async function generate(request: ZeroAiSendRequest) {
        if (!ready || titleDraft !== null || reviewTurn || staleSession || generation.current) return;
        const targetId = request.editMessageId ?? request.regenerateMessageId;
        const prefixLength = targetId
            ? session?.messages.findIndex(message => message.id === targetId) ?? -1
            : session?.messages.length ?? 0;
        if (prefixLength < 0) return;
        const turn: ActiveGeneration = {controller: new AbortController(), stopRequested: false};
        const {signal} = turn.controller;
        generation.current = turn;
        followReply.current = true;
        setPending({turnId: request.turnId, prefixLength, prompt: request.content});
        setPhase("sending");
        setError("");
        let current = session;
        try {
            if (!current) {
                current = (await history.create(user.id)).session;
                if (signal.aborted) return;
                const createdId = current.id;
                setSession(current);
                setDraft(previous => ({...previous, sessionId: createdId}));
                adoptSummary(current);
            }
            const id = current.id;
            const submission = {...request, expectedBranchEpoch: current.branchEpoch};
            const result = await history.send(user.id, id, submission, signal, event => {
                switch (event.type) {
                    case "start":
                        turn.stop = () => history.stop(user.id, id, request.turnId, signal);
                        if (turn.stopRequested) void requestStop(turn);
                        break;
                    case "delta":
                        setReply(text => text + event.content);
                        break;
                    case "tool":
                        setActivity(items => [...items, {seq: event.seq, label: event.label}]);
                        break;
                }
            });
            if (signal.aborted) return;
            if (result.status === 404) throw new ApiError(result.error ?? "这段会话已不存在。", 404);
            if (result.session) {
                const pagingError = await applyResult(result.session);
                if (!signal.aborted) setError([result.error, pagingError].filter(Boolean).join(" "));
            } else {
                setReviewTurn(request);
                setError(result.error ?? "未收到最新会话，暂时无法确认消息是否保存。");
            }
        } catch (cause) {
            if (signal.aborted) return;
            const failure = {targetId: current?.id, current, canRefresh: true};
            await showFailure(cause, failure);
            if (current && isUncertainWrite(cause)) {
                // 回复断开前可能已保存，先按同一个消息 ID 核对，不重发写入。
                try {
                    const saved = await history.open(user.id, current.id, {signal});
                    await applyResult(saved.session);
                } catch (checkError) {
                    if (signal.aborted) return;
                    if (isMissingSession(checkError)) await showFailure(checkError, failure);
                    else setReviewTurn(request);
                }
            }
        } finally {
            generation.current = null;
            if (!signal.aborted) {
                setPhase("idle");
                setPending(null);
                setReply("");
                setActivity([]);
                setStopping(false);
            }
        }

        async function applyResult(next: ZeroAiSession) {
            const {snapshot, pagingError} = await replaceSnapshot(next, undefined, signal);
            if (signal.aborted) return "";
            if (clearSentDraft(snapshot, request)) adoptSummary(next);
            // 新快照已包含本轮消息，不再叠加流式占位。
            setPending(null);
            setReply("");
            setActivity([]);
            setPhase("saving");
            await refreshList(signal);
            return pagingError;
        }
    }

    function clearSentDraft(next: ZeroAiSession, request: ZeroAiSendRequest) {
        if (!next.messages.some(message => message.id === request.turnId)) return false;
        if (request.editMessageId) setEditDraft(null);
        if (!request.editMessageId && !request.regenerateMessageId) setDraft(emptyDraft(next.id));
        return true;
    }

    async function openSource(messageId: string, id: string, version: number) {
        if (!activeId || !canOpenSources || sourceRequest.current) return;
        const controller = new AbortController();
        sourceRequest.current = controller;
        setCheckingSource(true);
        setSourceNotice("正在核对日报来源…");
        try {
            const notice = await onOpenReportSource(activeId, messageId, id, version, controller.signal);
            if (!controller.signal.aborted) setSourceNotice(notice ?? "");
        } finally {
            if (sourceRequest.current === controller) {
                sourceRequest.current = null;
                setCheckingSource(false);
            }
        }
    }

    function draftWithFollowUp(prompt: string) {
        const text = composerDraft?.content ?? "";
        return text.trim() ? `${text}${text.endsWith("\n") ? "" : "\n"}${prompt}` : prompt;
    }

    function fillFollowUp(prompt: string) {
        const content = draftWithFollowUp(prompt);
        if (!canRevise || content.length > maxPromptLength) return;
        focusFollowUp.current = true;
        setDraft({...emptyDraft(activeId), content});
    }

    function send(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const content = composerDraft?.content.trim();
        if (canRevise && composerDraft && content) void generate({turnId: composerDraft.turnId, content});
    }

    function saveEdit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const content = editDraft?.content.trim();
        const original = session?.messages.find(message => message.id === editDraft?.id);
        if (editDraft && original && content && content !== original.content) {
            void generate({turnId: uid("turn"), editMessageId: editDraft.id, content});
        }
    }

    function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (ready) event.currentTarget.form?.requestSubmit();
    }

    return (
        <section className="zero-ai" aria-label="ZeroAI 对话"
                 onKeyDown={event => {
                     if (event.key === "Escape" && sidebarOpen && !sidebarRef.current?.querySelector(":popover-open")) {
                         dismissSidebar();
                     }
                 }}>
            <aside id="zero-ai-session-list" ref={sidebarRef}
                   className={`zero-ai-sidebar${sidebarOpen ? " is-open" : ""}`} aria-label="会话">
                <div className="zero-ai-sidebar-head">
                    <strong>会话</strong>
                    <button type="button" className="zero-ai-new" onClick={createSession}
                            disabled={!ready || titleDraft !== null}>
                        <span aria-hidden="true">＋</span> 新建会话
                    </button>
                </div>
                <div className="zero-ai-sessions" onScroll={event => {
                    const menu = event.currentTarget.querySelector<HTMLElement>(":popover-open");
                    if (menu && Number(menu.dataset.openScrollTop) !== event.currentTarget.scrollTop) menu.hidePopover();
                }}>
                    {sessions.map(item => (
                        <div key={item.id} className="zero-ai-session-row"
                             data-current={item.id === activeId || undefined}>
                            <button type="button" className="zero-ai-session"
                                    aria-current={item.id === activeId ? "true" : undefined}
                                    disabled={!ready || titleDraft !== null}
                                    title={item.title} onClick={() => void openSession(item.id)}>
                                {item.title}
                            </button>
                            <SessionActions item={item} disabled={!ready || titleDraft !== null}
                                            onRename={() => {
                                                setSidebarOpen(false);
                                                setError("");
                                                setTitleDraft({id: item.id, value: item.title});
                                            }}
                                            onDelete={() => void deleteSession(item)}/>
                        </div>
                    ))}
                    {nextCursor || listError ? (
                        <div className="zero-ai-list-status">
                            {listError ? <p role="alert">读取会话列表失败：{listError}</p> : null}
                            <button type="button" className="text-button" disabled={!ready || titleDraft !== null}
                                    onClick={() => void loadMoreSessions()}>
                                {phase === "pagingSessions" ? "正在读取…" : nextCursor ? "加载更多会话" : "刷新会话列表"}
                            </button>
                        </div>
                    ) : null}
                </div>
                <small className="zero-ai-retention">聊天记录持久化于服务器</small>
            </aside>
            {sidebarOpen ? (
                <button type="button" className="zero-ai-backdrop" aria-label="关闭会话列表"
                        onClick={dismissSidebar}/>
            ) : null}
            <div className="zero-ai-chat" inert={sidebarOpen}>
                <header className="zero-ai-header">
                    <div className="zero-ai-header-main">
                        <button type="button" ref={sidebarToggleRef} className="zero-ai-action zero-ai-sidebar-toggle"
                                aria-label="打开会话列表"
                                aria-expanded={sidebarOpen} aria-controls="zero-ai-session-list"
                                onClick={() => setSidebarOpen(true)}>
                            <ZeroAiIcon name="sessions"/>
                        </button>
                        {titleDraft !== null ? (
                            <form className="zero-ai-title-form" onSubmit={renameSession}>
                                <input
                                    autoFocus
                                    aria-label="会话标题"
                                    maxLength={80}
                                    value={titleDraft.value}
                                    readOnly={!ready}
                                    onChange={event => setTitleDraft({...titleDraft, value: event.target.value})}
                                    onKeyDown={event => {
                                        if (ready && event.key === "Escape" && !event.nativeEvent.isComposing) setTitleDraft(null);
                                    }}
                                />
                                <button type="submit" className="primary-action"
                                        disabled={!ready || !titleDraft.value.trim()}>保存标题
                                </button>
                                <button type="button" className="text-button" disabled={!ready}
                                        onClick={() => setTitleDraft(null)}>取消
                                </button>
                            </form>
                        ) : (
                            <h1 title={session?.title}>{session?.title ?? "ZeroAI"}</h1>
                        )}
                    </div>
                </header>
                <div
                    className="zero-ai-log"
                    role="log"
                    aria-label="消息"
                    aria-busy={sending || phase === "pagingMessages"}
                    ref={logRef}
                    onScroll={({currentTarget: log}) => {
                        followReply.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
                    }}
                >
                    {session?.before && !pending ? (
                        <button type="button" className="text-button zero-ai-earlier"
                                onClick={() => void loadEarlierMessages()}
                                disabled={!canRevise}>
                            {phase === "pagingMessages" ? "正在读取…" : "加载更早消息"}
                        </button>
                    ) : null}
                    {displayedMessages?.map(message => (
                        <Message
                            key={message.id}
                            message={message}
                            copied={copiedId === message.id}
                            onCopy={() => void copy(message)}
                            onSelect={canRevise ? id => void selectVersion(id) : undefined}
                            onOpenSource={canOpenSources ? (id, version) => void openSource(message.id, id, version) : undefined}
                            checkingSource={checkingSource}
                            onRevise={canRevise ? () => {
                                if (message.role === "user") setEditDraft({id: message.id, content: message.content});
                                else void generate({turnId: uid("turn"), regenerateMessageId: message.id});
                            } : undefined}
                            editing={editDraft?.id === message.id && !sending ? (
                                <form className="zero-ai-edit-form" onSubmit={saveEdit}>
                                    <textarea aria-label="编辑消息" rows={3} autoFocus
                                              maxLength={maxPromptLength} value={editDraft.content}
                                              onChange={event => setEditDraft({
                                                  ...editDraft,
                                                  content: event.target.value
                                              })}
                                              onKeyDown={event => {
                                                  if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                                                      setEditDraft(null);
                                                  } else {
                                                      handleComposerKey(event);
                                                  }
                                              }}/>
                                    <div>
                                        <button type="button" className="text-button"
                                                onClick={() => setEditDraft(null)}>取消
                                        </button>
                                        <button type="submit" className="primary-action"
                                                disabled={!ready || !!reviewTurn || staleSession || !editDraft.content.trim() || editDraft.content.trim() === message.content}>
                                            发送修改
                                        </button>
                                    </div>
                                </form>
                            ) : undefined}
                        />
                    ))}
                    {!messageCount && !sending ? (
                        <div className="zero-ai-empty">
                            {phase === "loading" ? <strong>正在读取会话…</strong> : phase !== "unavailable" ? (
                                <>
                                    <strong>开始一段对话</strong>
                                    <span>{readTools ? "ZeroAI 有什么可以帮你的？" : "仅聊天，当前未开放OA数据查询。"}</span>
                                    {readIssues &&
                                        <button type="button" className="text-button" title={openIssuesPrompt}
                                                disabled={!canRevise || draftWithFollowUp(openIssuesPrompt).length > maxPromptLength}
                                                onClick={() => fillFollowUp(openIssuesPrompt)}>查我的未解决问题</button>}
                                </>
                            ) : null}
                        </div>
                    ) : null}
                    {pending ? (
                        <>
                            {pending.prompt ? (
                                <Message message={{id: pending.turnId, role: "user", content: pending.prompt}} pending/>
                            ) : null}
                            <Message pending activity={activity}
                                     message={{id: `${pending.turnId}-reply`, role: "assistant", content: reply}}/>
                        </>
                    ) : null}
                </div>
                <div className="zero-ai-composer">
                    {error || reviewTurn || staleSession ? (
                        <div className="zero-ai-error" role="alert">
                            <span>{error || (reviewTurn ? "暂时无法确认消息是否保存。" : "会话已变化，请重新打开。")}</span>
                            {phase === "unavailable" ? (
                                <button type="button" className="text-button" onClick={() => {
                                    setError("");
                                    setReload(count => count + 1);
                                }}>重试</button>
                            ) : (reviewTurn || staleSession) && activeId ? (
                                <button type="button" className="text-button" disabled={!ready || !!titleDraft}
                                        onClick={() => void openSession(activeId)}>
                                    {reviewTurn ? "重新打开会话核对" : "重新打开会话"}
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                    {recoveredDrafts.length ? (
                        <div className="zero-ai-recovered">
                            <small>以下草稿仅供复制，不会发到其他会话。</small>
                            {recoveredDrafts.map(recovered => (
                                <div key={`${recovered.session.id}:${recovered.id}`}>
                                    <label htmlFor={`zero-ai-recovered-${recovered.id}`}>
                                        已删除会话「{recovered.session.title}」的{recovered.kind}草稿
                                    </label>
                                    <textarea id={`zero-ai-recovered-${recovered.id}`} readOnly rows={2}
                                              value={recovered.content}/>
                                    <button type="button" className="text-button" onClick={() => void copy(recovered)}>
                                        {copiedId === recovered.id ? "已复制草稿" : "复制草稿"}
                                    </button>
                                    <button type="button" className="text-button" onClick={() => setRecoveredDrafts(
                                        drafts => drafts.filter(item => item !== recovered)
                                    )}>移除草稿
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {sourceNotice ? <p className="zero-ai-source-notice" role="status">{sourceNotice}</p> : null}
                    {offerFollowUps ? (
                        <div className="zero-ai-follow-ups" role="group" aria-label="快捷追问（仅填入输入框）">
                            <span>快捷追问</span>
                            {followUps.map(({label, prompt}) => (
                                <button key={label} type="button" title={prompt}
                                        disabled={!canRevise || draftWithFollowUp(prompt).length > maxPromptLength}
                                        onClick={() => fillFollowUp(prompt)}>{label}</button>
                            ))}
                        </div>
                    ) : null}
                    <form className="zero-ai-input" onSubmit={send}>
                        <textarea
                            ref={inputRef}
                            aria-label="消息内容"
                            placeholder={readTools ? "输入你的问题…" : "仅聊天，当前未开放 OA数据 查询"}
                            rows={2}
                            maxLength={maxPromptLength}
                            readOnly={!canRevise}
                            value={sending ? "" : composerDraft?.content ?? ""}
                            onChange={event => setDraft({...emptyDraft(activeId), content: event.target.value})}
                            onKeyDown={handleComposerKey}
                        />
                        {sending ? (
                            <button type="button" className="zero-ai-stop" disabled={stopping} onClick={stopGeneration}>
                                {stopping ? "正在停止…" : "停止生成"}
                            </button>
                        ) : (
                            <button type="submit" className="primary-action"
                                    disabled={!canRevise || !composerDraft?.content.trim()}>
                                发送
                            </button>
                        )}
                    </form>
                </div>
            </div>
        </section>
    );
}
