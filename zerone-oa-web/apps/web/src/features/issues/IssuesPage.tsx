import {useState} from "react";
import {DailyReport, SessionUser, TeamState} from "@oa/contracts";
import {findTask, findUser, nowIso, uid} from "../../shared/utils";
import {Panel} from "../../shared/ui/Panel";

export function IssuesPage({
                               state,
                               user,
                               onUpdateReport
                           }: {
    state: TeamState;
    user: SessionUser;
    onUpdateReport: (reportId: string, patch: Partial<DailyReport>) => void;
}) {
    const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
    const issues = state.dailyReports
        .filter((r) => r.notes?.trim())
        .filter((r) => {
            if (filter === "open") return !r.resolved;
            if (filter === "resolved") return r.resolved;
            return true;
        })
        .sort((a, b) => b.date.localeCompare(a.date));

    return (
        <div className="page-stack">
            <div className="page-header">
                <h2>问题</h2>
                <div className="segmented">
                    <button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>
                        未解决
                    </button>
                    <button
                        className={filter === "resolved" ? "active" : ""}
                        onClick={() => setFilter("resolved")}
                    >
                        已解决
                    </button>
                    <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
                        全部
                    </button>
                </div>
            </div>

            <Panel title={`问题列表 · ${issues.length}`} kicker="日报中『问题/注意』自动归档">
                {issues.length === 0 ? (
                    <p className="empty">没有匹配的问题。</p>
                ) : (
                    <div className="issue-list">
                        {issues.map((report) => {
                            const owner = findUser(state.users, report.ownerId);
                            const task = findTask(state.tasks, report.taskId);
                            return (
                                <article
                                    key={report.id}
                                    className={report.resolved ? "issue-card resolved" : "issue-card"}
                                >
                                    <div className="issue-head">
                                        <span className="task-code small">{report.taskId}</span>
                                        <strong>{task?.title ?? "（已删除任务）"}</strong>
                                        <span className="issue-meta">
                      {owner?.name ?? "?"} · {report.date}
                    </span>
                                        <span
                                            className={
                                                report.resolved ? "issue-status done" : "issue-status open"
                                            }
                                        >
                      {report.resolved ? "已解决" : "未解决"}
                    </span>
                                    </div>
                                    <p className="issue-body">{report.notes}</p>
                                    <div className="issue-solution">
                                        <label>
                                            解决方案
                                            <textarea
                                                defaultValue={report.solution ?? ""}
                                                placeholder="写下解决思路、链接或结论"
                                                onBlur={(event) => {
                                                    const solution = event.currentTarget.value;
                                                    if (solution !== (report.solution ?? "")) {
                                                        onUpdateReport(report.id, {solution});
                                                    }
                                                }}
                                            />
                                        </label>
                                        <div className="issue-actions">
                                            {report.resolved ? (
                                                <>
                          <span className="resolved-by">
                            由{" "}
                              {findUser(state.users, report.resolvedById ?? "")?.name ?? "?"} 标记于{" "}
                              {report.resolvedAt?.slice(0, 10) ?? "—"}
                          </span>
                                                    <button
                                                        className="text-button mini"
                                                        onClick={() =>
                                                            onUpdateReport(report.id, {
                                                                resolved: false,
                                                                resolvedById: undefined,
                                                                resolvedAt: undefined
                                                            })
                                                        }
                                                    >
                                                        重新打开
                                                    </button>
                                                </>
                                            ) : (
                                                <button
                                                    className="primary-action small"
                                                    onClick={() =>
                                                        onUpdateReport(report.id, {
                                                            resolved: true,
                                                            resolvedById: user.id,
                                                            resolvedAt: nowIso()
                                                        })
                                                    }
                                                >
                                                    标记已解决
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div className="issue-comments">
                                        {(report.comments ?? []).map((comment) => {
                                            const author = findUser(state.users, comment.authorId);
                                            const canDelete = comment.authorId === user.id;
                                            return (
                                                <div key={comment.id} className="issue-comment">
                          <span
                              className="user-tag"
                              style={{background: author?.color ?? "#888"}}
                              title={author?.name}
                          >
                            {author?.name.slice(0, 1) ?? "?"}
                          </span>
                                                    <div className="issue-comment-main">
                            <span className="issue-comment-meta">
                              {author?.name ?? comment.authorId} ·{" "}
                                {comment.createdAt.slice(0, 16).replace("T", " ")}
                            </span>
                                                        <p>{comment.text}</p>
                                                    </div>
                                                    {canDelete ? (
                                                        <button
                                                            className="text-button mini"
                                                            title="删除评论"
                                                            onClick={() =>
                                                                onUpdateReport(report.id, {
                                                                    comments: (report.comments ?? []).filter(
                                                                        (item) => item.id !== comment.id
                                                                    )
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
                                                onUpdateReport(report.id, {
                                                    comments: [
                                                        ...(report.comments ?? []),
                                                        {id: uid("cmt"), authorId: user.id, text, createdAt: nowIso()}
                                                    ]
                                                })
                                            }
                                        />
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}
            </Panel>
        </div>
    );
}

export function IssueCommentInput({onSubmit}: { onSubmit: (text: string) => void }) {
    const [text, setText] = useState("");

    function submit() {
        const trimmed = text.trim();
        if (!trimmed) return;
        onSubmit(trimmed);
        setText("");
    }

    return (
        <div className="issue-comment-input">
            <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="添加评论..."
                onKeyDown={(event) => {
                    if (event.key === "Enter") submit();
                }}
            />
            <button className="text-button mini" onClick={submit}>
                发送
            </button>
        </div>
    );
}
