import {type FormEvent, type ReactNode, useEffect, useRef, useState} from "react";
import type {ChangePasswordRequest, LoginRequest, SetupRegisterRequest} from "@oa/contracts";
import {ApiError, isUnauthenticated, isUncertainWrite, loadSetupStatus} from "../../shared/api";
import {appError} from "../../shared/error";

function AuthCard({title, description, children}: { title: string; description: string; children: ReactNode }) {
    return (
        <main className="login-page">
            <section className="login-card" aria-labelledby="auth-title">
                <div className="login-brand">
                    <span className="brand-mark" aria-hidden="true">T</span>
                    <div>
                        <p className="eyebrow">Zerone OA</p>
                        <h1 id="auth-title">{title}</h1>
                    </div>
                </div>
                <p className="subline">{description}</p>
                {children}
            </section>
        </main>
    );
}

type LoginProps = {
    onLogin: (credentials: LoginRequest) => Promise<void>;
    notice: string;
    busy: boolean;
};

export function LoginScreen({onRegister, ...login}: LoginProps & {
    onRegister: (credentials: SetupRegisterRequest) => Promise<void>;
}) {
    const [setupAvailable, setSetupAvailable] = useState(false);
    const [showSetup, setShowSetup] = useState(false);
    const [setupNotice, setSetupNotice] = useState("");

    useEffect(() => {
        const controller = new AbortController();
        void loadSetupStatus(controller.signal).then((status) => {
            if (!controller.signal.aborted) setSetupAvailable(status?.available === true);
        }).catch(() => undefined);
        return () => controller.abort();
    }, []);

    if (showSetup && setupAvailable) return (
        <SetupScreen busy={login.busy} onRegister={onRegister} onBack={() => setShowSetup(false)}
                     onClose={(message) => {
                         setSetupNotice(message);
                         setSetupAvailable(false);
                         setShowSetup(false);
                     }}/>
    );

    return <LoginForm {...login} notice={setupNotice || login.notice} onSetup={setupAvailable ? () => {
        if (!login.busy) setShowSetup(true);
    } : undefined}/>;
}

function LoginForm({onLogin, notice, busy, onSetup}: LoginProps & { onSetup?: () => void }) {
    const [loginName, setLoginName] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        if (!loginName.trim() || !password) {
            setError("请输入登录名和密码。");
            return;
        }
        setError("");
        try {
            await onLogin({loginName: loginName.trim(), password});
        } catch (cause) {
            setError(isUnauthenticated(cause) ? "登录名或密码错误" : appError(cause));
        } finally {
            setPassword("");
        }
    }

    return (
        <AuthCard title="团队任务工作台" description="任务树 · 周计划 · 日报 · 问题 · AI 提醒，共享一份结构化数据。">
            {notice ? <p role="status" className="hint">{notice}</p> : null}
            <form className="auth-form" onSubmit={submit} aria-busy={busy}>
                <label>
                    登录名
                    <input name="loginName" value={loginName} onChange={(event) => setLoginName(event.target.value)}
                           autoComplete="username" maxLength={128} required autoFocus/>
                </label>
                <label>
                    密码
                    <input name="password" type="password" value={password}
                           onChange={(event) => setPassword(event.target.value)}
                           autoComplete="current-password" maxLength={512} required/>
                </label>
                {error ? <p role="alert" className="form-error">{error}</p> : null}
                <button type="submit" className="primary-action" disabled={busy}>登录</button>
            </form>
            <p className="hint">需要开通账号或忘记密码？请联系维护人员。</p>
            {onSetup ? <button className="secondary-action" type="button" onClick={onSetup} disabled={busy}>
                首次设置
            </button> : null}
        </AuthCard>
    );
}

function SetupScreen({busy, onRegister, onBack, onClose}: {
    busy: boolean;
    onRegister: (credentials: SetupRegisterRequest) => Promise<void>;
    onBack: () => void;
    onClose: (notice: string) => void;
}) {
    const [setupKey, setSetupKey] = useState("");
    const [name, setName] = useState("");
    const [loginName, setLoginName] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const submitting = useRef(false);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || submitting.current) return;
        if (!name.trim() || !loginName.trim() || !setupKey.trim() || !password.trim()) {
            setError("请填写初始化凭证、姓名、登录名和密码。");
            return;
        }
        submitting.current = true;
        setError("");
        const credentials = {setupKey, name: name.trim(), loginName: loginName.trim(), password};
        setSetupKey("");
        setPassword("");
        try {
            await onRegister(credentials);
            onClose("");
        } catch (cause) {
            if (isUncertainWrite(cause)) {
                onClose("无法确认首次设置结果。请先尝试用刚设置的账号登录，或联系维护人员核对，不要重复注册。");
            } else if (cause instanceof ApiError) {
                if (cause.status === 404 || (cause.status === 409 && cause.code !== "SETUP_AUTH_BUSY")) {
                    onClose("首次设置已关闭。若刚提交过，请尝试登录；如有疑问，请联系维护人员。");
                } else if (cause.status === 401 || cause.code === "SETUP_AUTH_BUSY") {
                    onClose("当前无法进行首次设置。请刷新页面核对登录状态。");
                } else if (cause.code === "CSRF_INVALID" || cause.code === "SETUP_CSRF_UNAVAILABLE") {
                    setError("无法验证页面安全凭证，请重新提交。");
                } else if (cause.code === "ORIGIN_INVALID") {
                    setError("请求来源不受信任，请从工作台的正式地址打开此页面。");
                } else if (cause.status === 403) {
                    setError("无法完成首次设置，请核对初始化凭证。");
                } else if (cause.status === 400) {
                    setError("请核对姓名、登录名和密码格式后再试。");
                } else if (cause.status === 429) {
                    setError("提交过于频繁，请稍后再试。");
                } else {
                    setError("首次设置未完成，请联系维护人员。");
                }
            }
        } finally {
            submitting.current = false;
        }
    }

    return (
        <AuthCard title="首次设置" description="使用部署方提供的初始化凭证创建首位账号管理员。设置完成后，此入口将关闭。">
            <form className="auth-form setup-form" onSubmit={submit} aria-busy={busy}>
                <label>
                    初始化凭证
                    <input name="setupKey" type="password" value={setupKey} autoComplete="off" autoFocus required
                           maxLength={256} onChange={(event) => setSetupKey(event.target.value)} disabled={busy}/>
                </label>
                <label>
                    姓名
                    <input name="name" value={name} onChange={(event) => setName(event.target.value)}
                           autoComplete="name" maxLength={128} required disabled={busy}/>
                </label>
                <label>
                    登录名
                    <input name="loginName" value={loginName} onChange={(event) => setLoginName(event.target.value)}
                           autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128}
                           required disabled={busy}/>
                </label>
                <label>
                    密码
                    <input name="password" type="password" value={password} autoComplete="new-password"
                           minLength={12} maxLength={512} aria-describedby="setup-password-hint" required
                           onChange={(event) => setPassword(event.target.value)} disabled={busy}/>
                </label>
                <p className="hint" id="setup-password-hint">至少 12 个字符，不能全为空白。</p>
                {error ? <p role="alert" className="form-error">{error}</p> : null}
                <button type="submit" className="primary-action" disabled={busy}>创建管理员账号</button>
            </form>
            <button className="secondary-action" type="button" onClick={() => {
                if (!submitting.current) onBack();
            }} disabled={busy}>返回登录
            </button>
        </AuthCard>
    );
}

export function PasswordChangeScreen({required, busy, onChange, onLogout, onCancel}: {
    required: boolean;
    busy: boolean;
    onChange: (passwords: ChangePasswordRequest) => Promise<void>;
    onLogout: () => void;
    onCancel: () => void;
}) {
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        if (newPassword !== confirmPassword) {
            setError("两次输入的新密码不一致。");
            return;
        }
        setError("");
        try {
            await onChange({currentPassword, newPassword});
        } catch (cause) {
            setError(appError(cause));
            setCurrentPassword("");
        }
    }

    return (
        <AuthCard title="修改密码" description={required
            ? "请使用初始口令设置新密码，修改后重新登录工作台。"
            : "修改密码后，所有设备上的会话都会退出。请使用新密码重新登录。"}>
            <form className="auth-form" onSubmit={submit} aria-busy={busy}>
                <label>
                    当前口令
                    <input name="currentPassword" type="password" value={currentPassword}
                           onChange={(event) => setCurrentPassword(event.target.value)}
                           autoComplete="current-password" required autoFocus/>
                </label>
                <label>
                    新密码
                    <input name="newPassword" type="password" value={newPassword}
                           onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password"
                           required/>
                </label>
                <label>
                    确认新密码
                    <input name="confirmPassword" type="password" value={confirmPassword}
                           onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password"
                           required/>
                </label>
                {error ? <p role="alert" className="form-error">{error}</p> : null}
                <button type="submit" className="primary-action" disabled={busy}>修改密码</button>
            </form>
            {required ? (
                <button type="button" className="secondary-action" onClick={onLogout} disabled={busy}>退出登录</button>
            ) : (
                <button type="button" className="secondary-action" onClick={onCancel} disabled={busy}>取消</button>
            )}
        </AuthCard>
    );
}
