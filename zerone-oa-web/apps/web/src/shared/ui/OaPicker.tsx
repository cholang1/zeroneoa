import {Fragment, type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState} from "react";
import "./oaPicker.css";

type Choice = {value: string; label: string; group?: string; keywords?: string; content?: ReactNode};
type Props = {
    name: string; options: Choice[]; value: string | string[]; onPick: (value: string) => void;
    summary?: string; triggerContent?: ReactNode; triggerClass?: string;
    search?: string; empty?: string; minWidth?: number; footer?: (close: () => void) => ReactNode;
};

export function OaPicker({name, options, value, onPick, summary, triggerContent, triggerClass = "",
                             search, empty = "没有匹配的选项", minWidth = 150, footer}: Props) {
    const listId = useId();
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(0);
    const multi = Array.isArray(value);
    const hasTools = Boolean(search || footer);
    const selected = (id: string) => Array.isArray(value) ? value.includes(id) : id === value;
    const text = summary ?? options.find(item => selected(item.value))?.label ?? (multi ? "请选择" : value);
    const needle = query.trim().toLowerCase();
    const rows = needle ? options.filter(item => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(needle)) : options;
    const active = Math.min(cursor, rows.length - 1);
    const activeId = active >= 0 ? `${listId}-${active}` : undefined;

    function show() {
        setCursor(Math.max(0, options.findIndex(item => selected(item.value))));
        setQuery("");
        setOpen(true);
    }
    function close() {
        trigger.current?.focus({preventScroll: true});
        setOpen(false);
    }
    function pick(id: string) {
        onPick(id);
        if (!multi) close();
    }

    useLayoutEffect(() => {
        if (!open) return;
        const box = panel.current!;
        const anchor = trigger.current!;
        // 浏览器顶层只负责防裁切；面板、列表、焦点和定位均由 OA 控制。
        box.showPopover();
        function place() {
            const rect = anchor.getBoundingClientRect();
            const edge = 8, gap = 4;
            const view = window.visualViewport;
            const x = view?.offsetLeft ?? 0, y = view?.offsetTop ?? 0;
            const right = x + (view?.width ?? window.innerWidth), bottom = y + (view?.height ?? window.innerHeight);
            if (rect.bottom < y || rect.top > bottom || rect.right < x || rect.left > right) {
                setOpen(false);
                return;
            }
            const width = Math.min(Math.max(rect.width, minWidth), right - x - 2 * edge);
            box.style.width = `${width}px`;
            box.style.left = `${Math.max(x + edge, Math.min(rect.left, right - edge - width))}px`;
            const above = rect.top - y - edge - gap, below = bottom - rect.bottom - edge - gap;
            const wanted = (list.current?.scrollHeight ?? 0) + box.offsetHeight - (list.current?.clientHeight ?? 0);
            const maxHeight = Number.parseFloat(getComputedStyle(box).getPropertyValue("--oa-picker-max-height"));
            const flip = below < Math.min(maxHeight, wanted) && above > below;
            box.style.maxHeight = `${Math.max(0, Math.min(maxHeight, flip ? above : below))}px`;
            box.style.top = `${flip ? rect.top - gap - box.offsetHeight : rect.bottom + gap}px`;
        }
        function outside(event: PointerEvent) {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        }
        place();
        (input.current ?? list.current)?.focus({preventScroll: true});
        const observer = new ResizeObserver(place);
        observer.observe(anchor);
        observer.observe(box);
        document.addEventListener("pointerdown", outside, true);
        window.addEventListener("scroll", place, true);
        window.addEventListener("resize", place);
        window.visualViewport?.addEventListener("resize", place);
        window.visualViewport?.addEventListener("scroll", place);
        return () => {
            observer.disconnect();
            document.removeEventListener("pointerdown", outside, true);
            window.removeEventListener("scroll", place, true);
            window.removeEventListener("resize", place);
            window.visualViewport?.removeEventListener("resize", place);
            window.visualViewport?.removeEventListener("scroll", place);
            if (box.matches(":popover-open")) box.hidePopover();
        };
    }, [open, minWidth, hasTools]);

    useLayoutEffect(() => {
        if (open && activeId) document.getElementById(activeId)?.scrollIntoView({block: "nearest"});
    }, [open, activeId, query]);

    function navigate(event: KeyboardEvent) {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); close(); return;
        }
        if (event.target !== list.current && event.target !== input.current) return;
        if (event.key === "ArrowDown") setCursor(Math.max(0, Math.min(rows.length - 1, active + 1)));
        else if (event.key === "ArrowUp") setCursor(Math.max(0, active - 1));
        else if (event.key === "Home" && !search) setCursor(0);
        else if (event.key === "End" && !search) setCursor(Math.max(0, rows.length - 1));
        else if (event.key === "Enter" || (event.key === " " && !search)) {
            if (rows[active]) pick(rows[active].value);
        } else return;
        event.preventDefault(); event.stopPropagation();
    }

    return <div className="oa-picker" ref={root} onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}>
        <button type="button" className={`oa-picker-trigger ${triggerClass}`} ref={trigger}
                aria-label={`${name}：${text}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
                onClick={() => open ? close() : show()} onKeyDown={event => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
                }}>
            <span className="oa-picker-value">{triggerContent ?? text}</span><span className="oa-picker-arrow" aria-hidden="true"/>
        </button>
        {open && <div popover="manual" className="oa-picker-panel" data-has-tools={hasTools || undefined}
                      ref={panel} onKeyDown={navigate}>
            {search && <input ref={input} role="combobox" aria-label={search} placeholder={search} value={query}
                              aria-autocomplete="list" aria-controls={listId} aria-expanded="true" aria-activedescendant={activeId}
                              onChange={event => {setQuery(event.target.value); setCursor(0);}}/>}
            <div className="oa-picker-list" id={listId} ref={list} role="listbox" aria-label={name}
                 aria-multiselectable={multi || undefined} tabIndex={search ? -1 : 0} aria-activedescendant={search ? undefined : activeId}>
                {rows.map((item, i) => <Fragment key={item.value}>
                    {item.group && item.group !== rows[i - 1]?.group && <div className="oa-picker-group" role="presentation">{item.group}</div>}
                    <div role="option" id={`${listId}-${i}`} aria-selected={selected(item.value)} aria-label={item.label}
                         className="oa-picker-option" data-current={active === i || undefined}
                         onMouseDown={event => event.preventDefault()} onClick={() => {setCursor(i); pick(item.value);}}>
                        <span className="oa-picker-item-label">{item.content ?? item.label}</span>
                        {selected(item.value) && <span aria-hidden="true" className="oa-picker-check">✓</span>}
                    </div>
                </Fragment>)}
            </div>
            {!rows.length && <div role="status" className="oa-picker-empty">{empty}</div>}
            {footer && <div className="oa-picker-foot">{footer(close)}</div>}
        </div>}
    </div>;
}
