import {useId, useRef} from "react";
import type {ZeroAiSessionSummary} from "@oa/contracts";

const paths = {
    more: "M4 8h.01M8 8h.01M12 8h.01",
    edit: "m10.6 3.3 2.1 2.1M3 13l3.2-.7 6.6-6.6a1.5 1.5 0 0 0-2.1-2.1L4.1 10.2 3 13Z",
    delete: "M2.5 4.5h11M6 4.5V2.8h4v1.7M4 4.5l.6 8.2h6.8l.6-8.2M6.7 7v3.6M9.3 7v3.6",
    copy: "M5.5 5.5h7.8v7.8H5.5zM2.7 10V2.7H10",
    check: "m3 8 3 3 7-7",
    regenerate: "M13.5 6.2A5.6 5.6 0 0 0 4 4L2.5 5.5M2.5 2.7v2.8h2.8M2.5 9.8A5.6 5.6 0 0 0 12 12l1.5-1.5m0 2.8v-2.8h-2.8",
    previous: "m9.5 4-4 4 4 4",
    next: "m6.5 4 4 4-4 4",
    sessions: "M2 3.5h12v9H2zM6 3.5v9"
};

export function ZeroAiIcon({name}: { name: keyof typeof paths }) {
    return (
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             strokeWidth={name === "more" ? 2.3 : 1.35} strokeLinecap="round" strokeLinejoin="round">
            <path d={paths[name]}/>
        </svg>
    );
}

export function MessageAction({icon, label, disabled, onClick}: {
    icon: keyof typeof paths; label: string; disabled?: boolean; onClick: () => void;
}) {
    return (
        <button type="button" className="zero-ai-action" aria-label={label} data-tooltip={label}
                disabled={disabled} onClick={onClick}>
            <ZeroAiIcon name={icon}/>
        </button>
    );
}

export function SessionActions({item, disabled, onRename, onDelete}: {
    item: ZeroAiSessionSummary; disabled: boolean; onRename: () => void; onDelete: () => void;
}) {
    const menuId = useId();
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    return (
        <>
            <button type="button" ref={buttonRef} className="zero-ai-more"
                    aria-label={`${item.title}的更多操作`} popoverTarget={menuId} disabled={disabled}>
                <ZeroAiIcon name="more"/>
            </button>
            <div
                id={menuId}
                ref={menuRef}
                popover="auto"
                className="zero-ai-menu"
                role="group"
                aria-label="会话操作"
                onBeforeToggle={event => {
                    if (event.newState !== "open" || !buttonRef.current) return;
                    const bounds = buttonRef.current.getBoundingClientRect();
                    const menu = event.currentTarget;
                    // 翻页后浏览器可能刚把按钮滚入视野，已排队的 scroll 不应关掉新菜单。
                    menu.dataset.openScrollTop = String(buttonRef.current.closest('.zero-ai-sessions')?.scrollTop ?? 0);
                    menu.style.right = `${Math.max(8, document.documentElement.clientWidth - bounds.right)}px`;
                    if (window.innerHeight - bounds.bottom < 96) {
                        menu.style.top = "auto";
                        menu.style.bottom = `${window.innerHeight - bounds.top + 4}px`;
                    } else {
                        menu.style.top = `${bounds.bottom + 4}px`;
                        menu.style.bottom = "auto";
                    }
                }}
                onToggle={event => {
                    if (event.newState === "open") event.currentTarget.querySelector("button")?.focus({preventScroll: true});
                }}
            >
                <button type="button" onClick={() => {
                    menuRef.current?.hidePopover();
                    onRename();
                }}>
                    <ZeroAiIcon name="edit"/> 重命名
                </button>
                <button type="button" className="zero-ai-menu-delete" onClick={() => {
                    menuRef.current?.hidePopover();
                    onDelete();
                }}>
                    <ZeroAiIcon name="delete"/> 删除
                </button>
            </div>
        </>
    );
}
