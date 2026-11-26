import {useEffect, useMemo, useRef, useState} from "react";
import {SessionUser, TeamState} from "@oa/contracts";
import {collectMentions} from "./mentions";

export function MentionBanner({
                                  state,
                                  user,
                                  onSetMention
                              }: {
    state: TeamState;
    user: SessionUser;
    onSetMention: (
        kind: "event" | "memo",
        id: string,
        key: string,
        field: "read" | "done",
        value: boolean
    ) => void;
}) {
    const [open, setOpen] = useState(false);
    const hostRef = useRef<HTMLDivElement>(null);
    const items = useMemo(() => collectMentions(state, user.id), [state, user.id]);
    const pendingTotal = items.filter((item) => !item.read && !item.done).length;
    const nextItem = items.find((item) => !item.read && !item.done);

    useEffect(() => {
        if (!open) return;

        function handleClick(event: MouseEvent) {
            if (hostRef.current?.contains(event.target as Node)) return;
            setOpen(false);
        }

        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open]);

    return (
        <div className="mention-banner-host" ref={hostRef}>
            <button className="mention-banner" type="button" onClick={() => setOpen((value) => !value)}>
                <span className="mention-icon">📌</span>
                <strong>你有 {pendingTotal} 条 @ 提醒</strong>
                <span className="mention-next">
          {nextItem
              ? nextItem.kind === "event"
                  ? `下一场：${nextItem.detail} · ${nextItem.title}`
                  : `备忘：${nextItem.title}`
              : "当前没有待处理提醒"}
        </span>
                <span className="mention-open">{open ? "收起" : "处理"}</span>
            </button>
            {open ? (
                <div className="mention-pop" onClick={(event) => event.stopPropagation()}>
                    {items.length ? (
                        items.map((item) => {
                            // 已阅=灰色、完成=灰色+划线。用内联样式保证优先级高于备忘自定义颜色。
                            const stateStyle: React.CSSProperties | undefined = item.done
                                ? {color: "#9aa1ad", textDecoration: "line-through"}
                                : item.read
                                    ? {color: "#9aa1ad"}
                                    : undefined;
                            return (
                                <div
                                    className={
                                        item.done
                                            ? "mention-pop-row done"
                                            : item.read
                                                ? "mention-pop-row dismissed"
                                                : "mention-pop-row"
                                    }
                                    key={`${item.kind}-${item.id}-${item.key}`}
                                >
                                    <div className="mention-pop-main">
                                        <strong
                                            style={stateStyle ?? (item.color ? {color: item.color} : undefined)}
                                        >
                                            {item.title}
                                        </strong>
                                        <span style={stateStyle}>{item.detail}</span>
                                    </div>
                                    <div className="mention-actions">
                                        <label className="mention-state">
                                            <input
                                                type="checkbox"
                                                checked={item.read}
                                                onChange={(event) =>
                                                    onSetMention(item.kind, item.id, item.key, "read", event.target.checked)
                                                }
                                            />
                                            已阅
                                        </label>
                                        <label className="mention-state">
                                            <input
                                                type="checkbox"
                                                checked={item.done}
                                                onChange={(event) =>
                                                    onSetMention(item.kind, item.id, item.key, "done", event.target.checked)
                                                }
                                            />
                                            完成
                                        </label>
                                    </div>
                                </div>
                            );
                        })
                    ) : (
                        <p className="empty">当前没有 @ 你的事件或备忘。</p>
                    )}
                </div>
            ) : null}
        </div>
    );
}
