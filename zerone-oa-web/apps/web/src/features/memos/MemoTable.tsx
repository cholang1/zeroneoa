import {useState} from "react";
import {Memo, SessionUser, User} from "@oa/contracts";
import {findUser, nowIso, uid} from "../../shared/utils";
import {Panel} from "../../shared/ui/Panel";
import {AutoGrowTextarea} from "../../shared/ui/AutoGrowTextarea";
import {MemoMentionPicker} from "./MemoMentionPicker";
import {IssueCommentInput} from "../issues/IssuesPage";

export function MemoTable({
                              memos,
                              users,
                              user,
                              weekId,
                              onAddMemo,
                              onUpdateMemo,
                              onDeleteMemo
                          }: {
    memos: Memo[];
    users: User[];
    user: SessionUser;
    weekId: string;
    onAddMemo: (
        scope: "weekly" | "longTerm",
        text: string,
        weekId: string,
        options: Pick<Memo, "color" | "mentionAll" | "mentionUserIds">
    ) => void;
    onUpdateMemo: (id: string, patch: Partial<Memo>) => void;
    onDeleteMemo: (id: string) => void;
}) {
    type MemoDraft = {
        text: string;
        color: string;
        mentionAll: boolean;
        mentionUserIds: string[];
    };
    const emptyDraft = (): MemoDraft => ({
        text: "",
        color: "#1f2937",
        mentionAll: false,
        mentionUserIds: []
    });
    const [draft, setDraft] = useState<Record<"weekly" | "longTerm", MemoDraft>>({
        weekly: emptyDraft(),
        longTerm: emptyDraft()
    });
    const [commentsOpenId, setCommentsOpenId] = useState<string | null>(null);

    function updateDraft(scope: "weekly" | "longTerm", patch: Partial<MemoDraft>) {
        setDraft((prev) => ({...prev, [scope]: {...prev[scope], ...patch}}));
    }

    function submitDraft(scope: "weekly" | "longTerm") {
        const current = draft[scope];
        const text = current.text.trim();
        if (!text) return;
        onAddMemo(scope, text, weekId, {
            color: current.color,
            mentionAll: current.mentionAll,
            mentionUserIds: current.mentionAll ? [] : current.mentionUserIds
        });
        setDraft((prev) => ({...prev, [scope]: emptyDraft()}));
    }

    function mentionLabel(mentionAll?: boolean, mentionUserIds: string[] = []) {
        if (mentionAll) return "@全体";
        if (!mentionUserIds.length) return "@选择";
        return mentionUserIds.map((id) => findUser(users, id)?.name ?? id).join("、");
    }

    const sections: Array<{ scope: "weekly" | "longTerm"; title: string; filter: (m: Memo) => boolean }> = [
        {
            scope: "weekly",
            title: `本周备忘 · ${weekId}`,
            filter: (m) =>
                m.scope === "weekly" && (!m.weekId || m.weekId === weekId)
        },
        {
            scope: "longTerm",
            title: "长期备忘",
            filter: (m) => m.scope === "longTerm"
        }
    ];

    return (
        <Panel title="共享备忘" kicker="一行一条">
            <div className="memo-tables">
                {sections.map(({scope, title, filter}) => {
                    const rows = memos.filter(filter);
                    return (
                        <div key={scope} className="memo-section">
                            <div className="memo-section-head">
                                <h4>{title}</h4>
                                <span>{rows.length} 条</span>
                            </div>
                            <ul className="memo-rows">
                                {rows.length === 0 ? <li className="empty-row">暂无</li> : null}
                                {rows.map((memo) => {
                                    // 发布人始终显示创建者：评论、勾选完成等更新不改变头像归属。
                                    const author = findUser(users, memo.createdById) ?? findUser(users, memo.updatedById);
                                    const comments = memo.comments ?? [];
                                    const commentsOpen = commentsOpenId === memo.id;
                                    const nameOf = (id: string) => findUser(users, id)?.name ?? id;
                                    const readIds = memo.dismissedMentionByIds ?? [];
                                    const doneIds = memo.mentionDoneByIds ?? [];
                                    const targetIds = memo.mentionAll
                                        ? users.map((item) => item.id)
                                        : memo.mentionUserIds ?? [];
                                    const unreadNames = targetIds
                                        .filter((id) => !readIds.includes(id) && !doneIds.includes(id))
                                        .map(nameOf);
                                    const hasMentions = Boolean(memo.mentionAll || targetIds.length);
                                    return (
                                        <li key={memo.id} className="memo-row">
                      <span
                          className="user-tag"
                          style={{background: author?.color ?? "#888"}}
                          title={author ? `发布人：${author.name}` : undefined}
                      >
                        {author?.name.slice(0, 1) ?? "?"}
                      </span>
                                            <div className={memo.completed ? "memo-main completed" : "memo-main"}>
                                                <AutoGrowTextarea
                                                    defaultValue={memo.text}
                                                    style={{color: memo.color ?? "#1f2937"}}
                                                    onBlur={(event) => {
                                                        const text = event.currentTarget.value.trim();
                                                        if (text && text !== memo.text) onUpdateMemo(memo.id, {text});
                                                    }}
                                                />
                                                <div className="memo-meta">
                                                    <MemoMentionPicker
                                                        users={users}
                                                        currentUserId={user.id}
                                                        mentionAll={Boolean(memo.mentionAll)}
                                                        mentionUserIds={memo.mentionUserIds ?? []}
                                                        label={mentionLabel(memo.mentionAll, memo.mentionUserIds ?? [])}
                                                        onChange={(mentionAll, mentionUserIds) =>
                                                            onUpdateMemo(memo.id, {mentionAll, mentionUserIds})
                                                        }
                                                    />
                                                    {hasMentions ? (
                                                        <span className="memo-receipt">
                              回复详情
                              <span className="memo-receipt-pop">
                                <span>
                                  已阅：{readIds.length ? readIds.map(nameOf).join("、") : "暂无"}
                                </span>
                                <span>
                                  完成：{doneIds.length ? doneIds.map(nameOf).join("、") : "暂无"}
                                </span>
                                  {unreadNames.length ? <span>未阅：{unreadNames.join("、")}</span> : null}
                              </span>
                            </span>
                                                    ) : null}
                                                    <input
                                                        type="color"
                                                        value={memo.color ?? "#1f2937"}
                                                        title="文字颜色"
                                                        onChange={(event) => onUpdateMemo(memo.id, {color: event.target.value})}
                                                    />
                                                    <label className="memo-complete" title="标记完成后灰色划线显示">
                                                        <input
                                                            type="checkbox"
                                                            checked={Boolean(memo.completed)}
                                                            onChange={(event) =>
                                                                onUpdateMemo(memo.id, {
                                                                    completed: event.target.checked,
                                                                    completedById: event.target.checked ? user.id : undefined,
                                                                    completedAt: event.target.checked ? nowIso() : undefined
                                                                })
                                                            }
                                                        />
                                                        完成
                                                        {memo.completed && memo.completedById
                                                            ? `（${findUser(users, memo.completedById)?.name ?? "?"}）`
                                                            : ""}
                                                    </label>
                                                    <button
                                                        className="memo-comment-toggle"
                                                        type="button"
                                                        onClick={() => setCommentsOpenId(commentsOpen ? null : memo.id)}
                                                    >
                                                        💬 {comments.length ? `${comments.length} 条评论` : "评论"}
                                                        {commentsOpen ? " ▲" : " ▼"}
                                                    </button>
                                                </div>
                                                {commentsOpen ? (
                                                    <div className="issue-comments memo-comments">
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
                                                                        <p title={author?.name ?? comment.authorId}>{comment.text}</p>
                                                                    </div>
                                                                    <span className="issue-comment-date">
                                    {comment.createdAt.slice(5, 16).replace("T", " ")}
                                  </span>
                                                                    {canDelete ? (
                                                                        <button
                                                                            className="text-button mini"
                                                                            title="删除评论"
                                                                            onClick={() =>
                                                                                onUpdateMemo(memo.id, {
                                                                                    comments: comments.filter((item) => item.id !== comment.id)
                                                                                })
                                                                            }
                                                                        >
                                                                            删
                                                                        </button>
                                                                    ) : null}
                                                                </div>
                                                            );
                                                        })}
                                                        <IssueCommentInput
                                                            onSubmit={(text) =>
                                                                onUpdateMemo(memo.id, {
                                                                    comments: [
                                                                        ...comments,
                                                                        {
                                                                            id: uid("cmt"),
                                                                            authorId: user.id,
                                                                            text,
                                                                            createdAt: nowIso()
                                                                        }
                                                                    ]
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                ) : null}
                                            </div>
                                            <button
                                                className="text-button mini"
                                                onClick={() => onDeleteMemo(memo.id)}
                                            >
                                                删除
                                            </button>
                                        </li>
                                    );
                                })}
                                <li className="memo-row add">
                  <span
                      className="user-tag"
                      style={{background: user.color}}
                      title={user.name}
                  >
                    {user.name.slice(0, 1)}
                  </span>
                                    <AutoGrowTextarea
                                        value={draft[scope].text}
                                        style={{color: draft[scope].color}}
                                        onChange={(event) => updateDraft(scope, {text: event.target.value})}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                                                event.preventDefault();
                                                submitDraft(scope);
                                            }
                                        }}
                                        placeholder={`添加${scope === "weekly" ? "本周" : "长期"}备忘，Ctrl+Enter 保存`}
                                    />
                                    <div className="memo-meta add-meta">
                                        <MemoMentionPicker
                                            users={users}
                                            currentUserId={user.id}
                                            mentionAll={draft[scope].mentionAll}
                                            mentionUserIds={draft[scope].mentionUserIds}
                                            label={mentionLabel(draft[scope].mentionAll, draft[scope].mentionUserIds)}
                                            onChange={(mentionAll, mentionUserIds) =>
                                                updateDraft(scope, {mentionAll, mentionUserIds})
                                            }
                                        />
                                        <input
                                            type="color"
                                            value={draft[scope].color}
                                            title="文字颜色"
                                            onChange={(event) => updateDraft(scope, {color: event.target.value})}
                                        />
                                    </div>
                                    <button
                                        className="text-button mini"
                                        onClick={() => {
                                            submitDraft(scope);
                                        }}
                                    >
                                        添加
                                    </button>
                                </li>
                            </ul>
                        </div>
                    );
                })}
            </div>
        </Panel>
    );
}
