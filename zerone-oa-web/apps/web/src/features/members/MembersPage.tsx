import {OaPicker} from "../../shared/ui/OaPicker";
import {type FormEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState} from "react";
import type {AdminMember, AdminMemberAction, AdminMemberStatus} from "@oa/contracts";
import {ApiError, isUncertainWrite, type TeamApi} from "../../shared/api";

const statusLabels: Record<AdminMemberStatus, string> = {
    unprovisioned: "未开通", active: "已启用", initial: "待修改初始口令", disabled: "已停用"
};
const actions: Record<AdminMemberAction, { title: string; confirm: string; done: string }> = {
    create: {title: "新增成员", confirm: "确认新增", done: "已新增成员。"},
    provision: {title: "开通账号", confirm: "确认开通", done: "已开通账号。"},
    reset: {title: "重置密码", confirm: "确认重置", done: "已重置密码。"},
    disable: {title: "停用账号", confirm: "确认停用", done: "已停用账号。"}
};
type Operation = { kind: "create" } | { kind: Exclude<AdminMemberAction, "create">; member: AdminMember };
type ActionFields = { name: string; loginName: string; currentPassword: string };
type InitialCredential = { password: string; name: string; loginName?: string };

function canAct(kind: Exclude<AdminMemberAction, "create">, member: AdminMember, currentMemberId: string) {
    if (kind === "provision") return member.status === "unprovisioned";
    return member.id !== currentMemberId && (member.status === "active" || member.status === "initial");
}

export function MembersPage({api, currentMemberId, onBack, refreshWorkspace}: {
    api: TeamApi["adminMembers"];
    currentMemberId: string;
    onBack: () => void;
    refreshWorkspace: () => Promise<void>;
}) {
    const [members, setMembers] = useState<AdminMember[] | null>(null);
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState<AdminMemberStatus | "all">("all");
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [notice, setNotice] = useState("");
    const [actionError, setActionError] = useState("");
    const [needsReview, setNeedsReview] = useState("");
    const [operation, setOperation] = useState<Operation | null>(null);
    const [credential, setCredential] = useState<InitialCredential | null>(null);
    const [busy, setBusy] = useState(false);
    const writing = useRef(false);
    const reading = useRef(false);
    const scope = useRef<AbortController | null>(null);
    const heading = useRef<HTMLHeadingElement>(null);

    async function refresh(signal: AbortSignal, reviewing = false) {
        if (reading.current || signal.aborted) return;
        reading.current = true;
        setLoading(true);
        setLoadError("");
        try {
            const response = await api.list(signal);
            if (!Array.isArray(response?.members)) throw new Error("无法读取成员名单。");
            if (signal.aborted) return;
            setMembers(response.members);
            if (reviewing) {
                setNeedsReview("");
                setNotice("成员名单已刷新，请核对目标账号的状态和登录情况。");
                refreshBusinessMembers();
            }
        } catch (cause) {
            if (signal.aborted) return;
            if (cause instanceof ApiError && cause.status === 403) {
                setMembers(null);
                setCredential(null);
                setLoadError("当前账号没有成员管理权限。请返回工作台或重新登录。");
            } else {
                setLoadError("无法加载成员名单，请刷新成员后重试。");
            }
        } finally {
            if (!signal.aborted) {
                reading.current = false;
                setLoading(false);
            }
        }
    }

    useLayoutEffect(() => {
        heading.current?.focus({preventScroll: true});
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        scope.current = controller;
        void refresh(controller.signal);
        return () => {
            controller.abort();
            scope.current = null;
            reading.current = false;
        };
    }, [api]);

    function refreshBusinessMembers() {
        // 只读聚合快照，按工作区的保存队列和版本规则合并；不会把账号数据写入业务差量。
        void refreshWorkspace().catch(() => undefined);
    }

    function focusHeading() {
        requestAnimationFrame(() => heading.current?.focus({preventScroll: true}));
    }

    function choose(next: Operation) {
        if (loading || loadError || reading.current || busy || writing.current || !members) return;
        if (next.kind !== "create" && !canAct(next.kind, next.member, currentMemberId)) return;
        setActionError("");
        setNotice("");
        setOperation(next);
    }

    async function update(fields: ActionFields) {
        const signal = scope.current?.signal;
        if (!signal || signal.aborted || !operation || busy || writing.current) return;
        const {kind} = operation;
        if (kind !== "create" && !canAct(kind, operation.member, currentMemberId)) return;
        writing.current = true;
        setBusy(true);
        setActionError("");
        try {
            const result = kind === "create"
                ? await api.update(kind, {name: fields.name, loginName: fields.loginName}, signal)
                : kind === "provision"
                    ? await api.update(kind, {memberId: operation.member.id, loginName: fields.loginName}, signal)
                    : await api.update(kind, {
                        memberId: operation.member.id,
                        currentPassword: fields.currentPassword
                    }, signal);
            if (signal.aborted) return;
            if (typeof result?.memberId !== "string" || !result.memberId ||
                (kind !== "create" && result.memberId !== operation.member.id) ||
                (kind !== "disable" && (typeof result.initialPassword !== "string" || !result.initialPassword))) {
                throw new Error("无法确认操作结果。");
            }
            setOperation(null);
            setNotice(actions[kind].done);
            if (kind === "disable") focusHeading();
            else setCredential({
                password: result.initialPassword!,
                name: kind === "create" ? fields.name : operation.member.name,
                loginName: kind === "reset" ? operation.member.loginName : fields.loginName
            });
            refreshBusinessMembers();
            void refresh(signal);
        } catch (cause) {
            if (signal.aborted) return;
            if (isUncertainWrite(cause)) {
                setOperation(null);
                setMembers(null);
                setNeedsReview(`无法确认${actions[kind].title}是否完成。请先刷新成员、核对账号状态和登录情况，不要直接重复操作。${kind === "disable" ? "" : "初始口令无法再次查看。"}`);
                focusHeading();
            } else if (cause instanceof ApiError) {
                if (cause.code === "CSRF_INVALID" || cause.code === "ORIGIN_INVALID") {
                    setOperation(null);
                    setMembers(null);
                    setLoadError("无法验证请求的安全凭证。请重新加载页面后再试。");
                    focusHeading();
                } else if (cause.status === 403) {
                    setMembers(null);
                    setOperation(null);
                    setLoadError("当前账号没有执行此操作的权限。请刷新成员后重试。");
                    focusHeading();
                } else if (cause.status === 409 || cause.status === 404) {
                    setOperation(null);
                    setLoadError("成员状态已变化，或姓名、登录名已被使用。请刷新成员并核对后重试。");
                    focusHeading();
                } else if (cause.status === 400 || cause.status === 422) {
                    setActionError(kind === "reset" || kind === "disable" ? "请核对管理员当前密码后再试。"
                        : kind === "provision" ? "请核对登录名后再试。" : "请核对姓名和登录名后再试。");
                } else if (cause.status === 429) {
                    setActionError("操作过于频繁，请稍后再试。");
                } else {
                    setActionError("操作未完成，请核对成员状态后再试。");
                }
            }
        } finally {
            if (!signal.aborted) {
                writing.current = false;
                setBusy(false);
            }
        }
    }

    const keyword = query.normalize("NFKC").trim().toLocaleLowerCase();
    const displayed = members?.filter((member) => (status === "all" || member.status === status) &&
        [member.name, member.loginName ?? ""].some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(keyword)));
    const actionsDisabled = loading || !!loadError || busy || !members;

    return (
        <section className="page-stack members-page" aria-labelledby="members-title">
            <header className="page-header">
                <div className="panel-titles">
                    <h2 id="members-title" tabIndex={-1} ref={heading}>成员管理</h2>
                    <p className="hint">查看成员的登录账号和状态，原成员开通账号后仍使用原来的工作记录。</p>
                </div>
                <button type="button" className="secondary-action" onClick={onBack}>返回工作台</button>
            </header>
            {notice ? <p className="hint" role="status">{notice}</p> : null}
            {needsReview ? <div className="form-error" role="alert">
                <p>{needsReview}</p>
                {loadError ? <p>{loadError}</p> : null}
            </div> : null}
            <div className="panel member-directory" aria-busy={loading}>
                <div className="member-filters">
                    <label>搜索成员
                        <input type="search" value={query} placeholder="姓名或登录名" autoComplete="off"
                               onChange={(event) => setQuery(event.target.value)}/>
                    </label>
                    <div className="form-field"><span className="form-label">账号状态</span>
                        <OaPicker name="账号状态" value={status} onPick={id => setStatus(id as typeof status)}
                                  options={[{value: "all", label: "全部状态"}, ...Object.entries(statusLabels)
                                      .map(([value, label]) => ({value, label}))]}/>
                    </div>
                    <div className="member-buttons">
                        <button type="button" className="compact-action" disabled={loading || busy} onClick={() => {
                            const signal = scope.current?.signal;
                            if (!signal || signal.aborted || writing.current || reading.current) return;
                            void refresh(signal, !!needsReview);
                        }}>刷新成员
                        </button>
                        <button type="button" className="primary-action" disabled={actionsDisabled}
                                onClick={() => choose({kind: "create"})}>新增成员
                        </button>
                    </div>
                </div>
                {loading ? <p role="status" className="hint">正在读取成员名单…</p> : null}
                {loadError && !needsReview ? <p role="alert" className="form-error">{loadError}</p> : null}
                {members && displayed ? (
                    <>
                        <p className="hint" role="status">显示 {displayed.length} 位，共 {members.length} 位成员</p>
                        {displayed.length ? (
                                <ul className="member-list" aria-label="成员名单" role="list">
                                    {displayed.map((member) => {
                                        const self = member.id === currentMemberId;
                                        const hasAccount = member.status === "active" || member.status === "initial";
                                        return (
                                            <li key={member.id} data-testid="admin-member-row" data-member-id={member.id}
                                                className="member-row">
                                                <div className="member-identity">
                                                    <strong>{member.name}</strong>
                                                    <span className="hint">{member.loginName
                                                        ? <>登录名：<span>{member.loginName}</span></> : "无登录名"}</span>
                                                </div>
                                                <div className="member-badges">
                                                <span className={`member-status ${member.status}`}>
                                                    {statusLabels[member.status]}
                                                </span>
                                                    {member.isAccountAdmin ?
                                                        <span className="hint">账号管理员</span> : null}
                                                    {self ? <span className="hint">当前账号</span> : null}
                                                </div>
                                                <div className="member-buttons">
                                                    {member.status === "unprovisioned" ? (
                                                        <button type="button" className="compact-action"
                                                                disabled={actionsDisabled}
                                                                onClick={() => choose({
                                                                    kind: "provision",
                                                                    member
                                                                })}>开通账号</button>
                                                    ) : null}
                                                    {hasAccount ? (
                                                        <>
                                                            <button type="button" className="compact-action"
                                                                    disabled={actionsDisabled || self}
                                                                    onClick={() => choose({kind: "reset", member})}>重置密码
                                                            </button>
                                                            <button type="button" className="compact-action member-danger"
                                                                    disabled={actionsDisabled || self}
                                                                    onClick={() => choose({kind: "disable", member})}>停用账号
                                                            </button>
                                                        </>
                                                    ) : null}
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) :
                            <p className="member-empty hint">{members.length ? "没有符合条件的成员，请调整搜索或状态。" : "当前没有成员。"}</p>}
                    </>
                ) : null}
            </div>
            {operation ? (
                <MemberActionDialog operation={operation} busy={busy} error={actionError} onSubmit={update}
                                    onCancel={() => {
                                        if (!writing.current) setOperation(null);
                                    }}/>
            ) : null}
            {credential ? (
                <MemberDialog title="初始口令" testId="admin-initial-password-dialog"
                              describedBy="admin-credential-note">
                    <div className="modal-body">
                        <p className="member-target">
                            目标成员：<strong>{credential.name}</strong>
                            {credential.loginName ? <span>（{credential.loginName}）</span> : null}
                        </p>
                        <p id="admin-credential-note">初始口令只显示这一次。请妥善保存并私下交给该成员；首次登录时需要修改口令。</p>
                        <code className="member-password"
                              data-testid="admin-initial-password">{credential.password}</code>
                    </div>
                    <div className="modal-foot member-dialog-actions">
                        <button type="button" className="primary-action" onClick={() => {
                            setCredential(null);
                            focusHeading();
                        }}>已收好，关闭
                        </button>
                    </div>
                </MemberDialog>
            ) : null}
        </section>
    );
}

function MemberDialog({title, testId, describedBy, onCancel, children}: {
    title: string;
    testId: string;
    describedBy?: string;
    onCancel?: () => void;
    children: ReactNode;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    useLayoutEffect(() => {
        const element = dialog.current;
        if (!element) return;
        element.showModal();
        heading.current?.focus({preventScroll: true});
        return () => element.close();
    }, []);
    return (
        <dialog className="modal member-dialog" ref={dialog} aria-labelledby={`${testId}-title`}
                aria-describedby={describedBy} data-testid={testId} onCancel={(event) => {
            event.preventDefault();
            onCancel?.();
        }}>
            <header className="modal-head">
                <h3 id={`${testId}-title`} tabIndex={-1} ref={heading}>{title}</h3>
            </header>
            {children}
        </dialog>
    );
}

function MemberActionDialog({operation, busy, error, onSubmit, onCancel}: {
    operation: Operation;
    busy: boolean;
    error: string;
    onSubmit: (fields: ActionFields) => Promise<void>;
    onCancel: () => void;
}) {
    const [name, setName] = useState("");
    const [loginName, setLoginName] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [validation, setValidation] = useState("");
    const {kind} = operation;
    const needsPassword = kind === "reset" || kind === "disable";

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        if (!needsPassword && (!loginName.trim() || (kind === "create" && !name.trim()))) {
            setValidation("请填写姓名和登录名，不能只输入空格。");
            return;
        }
        setValidation("");
        void onSubmit({name: name.trim(), loginName: loginName.trim(), currentPassword});
        setCurrentPassword("");
    }

    return (
        <MemberDialog title={actions[kind].title} testId={`admin-member-${kind}-dialog`}
                      onCancel={!busy ? onCancel : undefined}>
            <form onSubmit={submit} className="member-action-form" aria-busy={busy}>
                <div className="modal-body">
                    {operation.kind !== "create" ? (
                        <p className="member-target">
                            目标成员：<strong>{operation.member.name}</strong>
                            {operation.member.loginName ? <span>（{operation.member.loginName}）</span> : null}
                        </p>
                    ) : null}
                    {kind === "create" ? (
                        <label>姓名
                            <input name="name" maxLength={128} value={name}
                                   onChange={(event) => setName(event.target.value)}
                                   autoComplete="off" required disabled={busy}/>
                        </label>
                    ) : null}
                    {needsPassword ? (
                        <>
                            <p className="hint">{kind === "reset" ? "该成员的现有登录将失效，需使用新口令重新登录。"
                                : "该成员将无法登录，现有登录将失效；工作记录仍会保留。"}</p>
                            <label>管理员当前密码
                                <input name="currentPassword" type="password" autoComplete="current-password" required
                                       maxLength={512} value={currentPassword} disabled={busy}
                                       onChange={(event) => setCurrentPassword(event.target.value)}/>
                            </label>
                        </>
                    ) : (
                        <label>登录名
                            <input name="loginName" value={loginName}
                                   onChange={(event) => setLoginName(event.target.value)}
                                   maxLength={128} autoComplete="off" spellCheck={false} autoCapitalize="none" required
                                   disabled={busy}/>
                        </label>
                    )}
                    {validation || error ? <p role="alert" className="form-error">{validation || error}</p> : null}
                </div>
                <div className="modal-foot member-dialog-actions">
                    <button type="button" className="compact-action" onClick={onCancel} disabled={busy}>取消</button>
                    <button type="submit"
                            className={kind === "disable" ? "primary-action member-confirm-danger" : "primary-action"}
                            disabled={busy}>{actions[kind].confirm}</button>
                </div>
            </form>
        </MemberDialog>
    );
}
