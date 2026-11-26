import {useEffect, useRef, useState} from "react";
import {DayThread, SessionUser, User} from "@oa/contracts";
import {findUser} from "../../shared/utils";
import {DayThreadAction, REACTION_EMOJIS, DayEntryRef, renderEntryRefs} from "./model";

export function DayCommentInput({
                                    entries,
                                    onSubmit
                                }: {
    entries: DayEntryRef[];
    onSubmit: (text: string) => void;
}) {
    const [text, setText] = useState("");
    const [showRefs, setShowRefs] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    function submit() {
        const trimmed = text.trim();
        if (!trimmed) return;
        onSubmit(trimmed);
        setText("");
        setShowRefs(false);
    }

    return (
        <div className="issue-comment-input day-comment-input">
            <input
                ref={inputRef}
                value={text}
                onChange={(event) => {
                    const value = event.target.value;
                    setText(value);
                    // 中文输入法可能输出全角＃，两种都触发条目选择。
                    const cursor = event.target.selectionStart ?? value.length;
                    const lastChar = value.slice(cursor - 1, cursor);
                    setShowRefs(entries.length > 0 && (lastChar === "#" || lastChar === "＃"));
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && !showRefs) submit();
                    if (event.key === "Escape") setShowRefs(false);
                }}
                placeholder={entries.length ? "评论今天的日报，输入 # 引用条目编号..." : "评论今天的日报..."}
            />
            {showRefs ? (
                <div className="entry-ref-pop">
                    {entries.map((entry) => (
                        <button
                            key={entry.no}
                            type="button"
                            onClick={() => {
                                setText((prev) => {
                                    const last = prev.slice(-1);
                                    return last === "#" || last === "＃"
                                        ? `${prev.slice(0, -1)}#${entry.no} `
                                        : `${prev}#${entry.no} `;
                                });
                                setShowRefs(false);
                                inputRef.current?.focus();
                            }}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
            ) : null}
            {entries.length ? (
                <button
                    className="text-button mini"
                    type="button"
                    title="引用某条日报编号"
                    onClick={() => {
                        setShowRefs((value) => !value);
                        inputRef.current?.focus();
                    }}
                >
                    #引用
                </button>
            ) : null}
            <button className="text-button mini" onClick={submit}>
                发送
            </button>
        </div>
    );
}

export function ReactionMenu({
                                 reactions,
                                 users,
                                 user,
                                 onReact
                             }: {
    reactions: Record<string, string[]>;
    users: User[];
    user: SessionUser;
    onReact: (emoji: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [namesEmoji, setNamesEmoji] = useState<string | null>(null);
    const hostRef = useRef<HTMLSpanElement>(null);
    const reactionEntries = Object.entries(reactions).filter(([, ids]) => ids.length);
    const nameOf = (id: string) => findUser(users, id)?.name ?? id;

    useEffect(() => {
        if (!open && !namesEmoji) return;

        function handleClick(event: MouseEvent) {
            if (hostRef.current?.contains(event.target as Node)) return;
            setOpen(false);
            setNamesEmoji(null);
        }

        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open, namesEmoji]);

    return (
        <span className="head-reactions" ref={hostRef}>
      <button
          type="button"
          className="reaction-more"
          title="回应一个表情"
          onClick={() => {
              setOpen((value) => !value);
              setNamesEmoji(null);
          }}
      >
        ⋯
      </button>
            {open ? (
                <span className="reaction-palette head">
          {REACTION_EMOJIS.map((emoji) => (
              <button
                  key={emoji}
                  type="button"
                  className={
                      (reactions[emoji] ?? []).includes(user.id)
                          ? "reaction-option mine"
                          : "reaction-option"
                  }
                  onClick={() => {
                      onReact(emoji);
                      setOpen(false);
                  }}
              >
                  {emoji}
              </button>
          ))}
        </span>
            ) : null}
            {reactionEntries.map(([emoji, ids]) => (
                <span key={emoji} className="reaction-chip-host">
          <button
              type="button"
              className={ids.includes(user.id) ? "reaction-chip mine" : "reaction-chip"}
              title={ids.map(nameOf).join("、")}
              onClick={() => {
                  setNamesEmoji(namesEmoji === emoji ? null : emoji);
                  setOpen(false);
              }}
          >
            {emoji} {ids.length}
          </button>
                    {namesEmoji === emoji ? (
                        <span className="reaction-names head">
              {ids.map(nameOf).join("、")}
                            <button
                                type="button"
                                className="text-button mini"
                                onClick={() => {
                                    onReact(emoji);
                                    setNamesEmoji(null);
                                }}
                            >
                {ids.includes(user.id) ? "取消我的" : "+1"}
              </button>
            </span>
                    ) : null}
        </span>
            ))}
    </span>
    );
}

export function DayThreadBar({
                                 thread,
                                 entries,
                                 users,
                                 user,
                                 highlightNonce,
                                 onAction
                             }: {
    thread: DayThread | undefined;
    entries: DayEntryRef[];
    users: User[];
    user: SessionUser;
    highlightNonce?: number;
    onAction: (action: DayThreadAction) => void;
}) {
    const [open, setOpen] = useState(false);
    const [flashing, setFlashing] = useState(false);
    const hostRef = useRef<HTMLDivElement>(null);
    const comments = thread?.comments ?? [];

    // Feedback-popup jump: open the thread, scroll to it, pulse it larger.
    useEffect(() => {
        if (!highlightNonce) return;
        setOpen(true);
        setFlashing(true);
        const scroll = window.setTimeout(() => {
            hostRef.current?.scrollIntoView({behavior: "smooth", block: "center"});
        }, 200);
        const stop = window.setTimeout(() => setFlashing(false), 3200);
        return () => {
            window.clearTimeout(scroll);
            window.clearTimeout(stop);
        };
    }, [highlightNonce]);

    return (
        <div className={flashing ? "day-thread flash" : "day-thread"} ref={hostRef}>
            <div className="day-thread-bar">
                <button
                    className="memo-comment-toggle"
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                >
                    💬 {comments.length ? `${comments.length} 条评论` : "评论"}
                    {open ? " ▲" : " ▼"}
                </button>
            </div>
            {open ? (
                <div className="issue-comments day-thread-comments">
                    {comments.map((comment) => {
                        const author = findUser(users, comment.authorId);
                        const canDelete = comment.authorId === user.id;
                        return (
                            <div key={comment.id} className="issue-comment">
                <span
                    className="user-tag"
                    style={{background: author?.color ?? "#888"}}
                    title={author?.name ?? comment.authorId}
                >
                  {author?.name.slice(0, 1) ?? "?"}
                </span>
                                <div className="issue-comment-main compact">
                                    <p title={author?.name ?? comment.authorId}>{renderEntryRefs(comment.text)}</p>
                                </div>
                                <span className="issue-comment-date">
                  {comment.createdAt.slice(5, 16).replace("T", " ")}
                </span>
                                {canDelete ? (
                                    <button
                                        className="text-button mini"
                                        title="删除评论"
                                        onClick={() => onAction({kind: "deleteComment", commentId: comment.id})}
                                    >
                                        删
                                    </button>
                                ) : null}
                            </div>
                        );
                    })}
                    <DayCommentInput
                        entries={entries}
                        onSubmit={(text) => onAction({kind: "comment", text})}
                    />
                </div>
            ) : null}
        </div>
    );
}
