import {useEffect, useRef, useState} from "react";
import {SessionUser} from "@oa/contracts";
import {Page} from "./navigation";

export function TopShell({
                             user,
                             page,
                             setPage,
                             saving,
                             onManageMembers,
                             onChangePassword,
                             onLogout,
                             onExport,
                             onImport,
                             onExportLog,
                             children
                         }: {
    user: SessionUser;
    page: Page;
    setPage: (page: Page) => void;
    saving: boolean;
    onManageMembers?: () => void;
    onChangePassword: () => void;
    onLogout: () => void;
    onExport: () => void;
    onImport: () => void;
    onExportLog: () => void;
    children: React.ReactNode;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const topbarRef = useRef<HTMLElement>(null);

    // Publish the topbar height so sticky in-page toolbars can pin right below it.
    useEffect(() => {
        const el = topbarRef.current;
        if (!el) return;
        const apply = () =>
            document.documentElement.style.setProperty("--topbar-h", `${el.offsetHeight}px`);
        apply();
        const observer = new ResizeObserver(apply);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const pages: Array<{ id: Page; label: string }> = [
        {id: "home", label: "总览"},
        {id: "weekly", label: "工作内容"},
        {id: "zeroAi", label: "ZeroAI"},
        {id: "issues", label: "问题"},
        {id: "stats", label: "统计"},
        {id: "data", label: "数据"}
    ];
    return (
        <div className="app-shell">
            <header className="topbar" ref={topbarRef}>
                <div className="top-brand">
                    <span className="brand-mark small">T</span>
                    <div className="top-brand-text">
                        <strong>Zerone OA</strong>
                        <span>Task OS</span>
                    </div>
                </div>

                <nav className="top-tabs">
                    {pages.map((item) => (
                        <button
                            key={item.id}
                            aria-current={page === item.id ? "page" : undefined}
                            className={page === item.id ? "tab active" : "tab"}
                            onClick={() => setPage(item.id)}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>

                <div className="top-right">
          <span className={saving ? "sync-pill saving" : "sync-pill"}>
            <span className="status-dot"/>
              {saving ? "同步中" : "已连接"}
          </span>

                    <div className="menu-host">
                        <button className="icon-btn" type="button" onClick={() => setMenuOpen((open) => !open)}
                                title="菜单" aria-label="菜单" aria-expanded={menuOpen}>
                            ⋯
                        </button>
                        {menuOpen ? (
                            <div className="menu" onClick={() => setMenuOpen(false)}>
                                <div className="menu-section">
                                    <button onClick={onExport}>导出数据…</button>
                                    <button onClick={onImport}>导入 JSON</button>
                                    <button onClick={onExportLog}>导出诊断日志</button>
                                </div>
                                <div className="menu-section">
                                    <div className="menu-user">
                    <span
                        className="avatar small"
                        style={{background: user.color}}
                    >
                      {user.name.slice(0, 1)}
                    </span>
                                        <strong>{user.name}</strong>
                                    </div>
                                    {onManageMembers ?
                                        <button type="button" onClick={onManageMembers}>成员管理</button> : null}
                                    <button onClick={onChangePassword}>修改密码</button>
                                    <button onClick={onLogout}>退出登录</button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
            </header>

            <main className="workspace">{children}</main>
        </div>
    );
}
