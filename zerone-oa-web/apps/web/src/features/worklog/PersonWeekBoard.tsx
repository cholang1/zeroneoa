import {useEffect, useLayoutEffect, useRef, useState} from "react";
import {DailyReport, SessionUser, TeamState, User, WeeklyPlanItem} from "@oa/contracts";
import {findTask, findUser, formatHours, nowIso, summarizeReportsByTask} from "../../shared/utils";
import {AutoGrowTextarea} from "../../shared/ui/AutoGrowTextarea";
import {DraftRow, emptyDraftRow, DayThreadAction, DayEntryRef, ThreadHighlight, entryNo} from "./model";
import {ReactionMenu, DayThreadBar} from "./DayThread";
import {TaskSelectInline} from "../tasks/TaskSelectInline";

export function PersonWeekBoard({
                                    owner,
                                    user,
                                    state,
                                    weekId,
                                    pickedDate,
                                    onAddPlan,
                                    onUpdatePlan,
                                    onDeletePlan,
                                    onSubmitReports,
                                    onUpdateReport,
                                    onDeleteReport,
                                    onDayThread,
                                    threadHighlight,
                                    focusedReportId
                                }: {
    owner: User;
    user: SessionUser;
    state: TeamState;
    weekId: string;
    pickedDate: string;
    threadHighlight: ThreadHighlight | null;
    focusedReportId?: string;
    onAddPlan: (ownerId: string, taskId: string, detail: string) => void;
    onUpdatePlan: (planId: string, patch: Partial<WeeklyPlanItem>) => void;
    onDeletePlan: (planId: string) => void;
    onSubmitReports: (
        ownerId: string,
        rows: Array<{ date: string; taskId: string; detail: string; hours: number; notes: string }>
    ) => void;
    onUpdateReport: (reportId: string, patch: Partial<DailyReport>) => void;
    onDeleteReport: (reportId: string) => void;
    onDayThread: (ownerId: string, date: string, action: DayThreadAction) => void;
}) {
    const defaultTaskId =
        state.tasks.find((task) => task.level === 3)?.id ?? state.tasks[0]?.id ?? "";
    const [planTaskId, setPlanTaskId] = useState(defaultTaskId);
    const [planDetail, setPlanDetail] = useState("");
    // 用无歧义的二元组隔离操作者和日报归属，不读取分隔符有歧义的旧键。
    const draftKey = `oa-v3-report-drafts-${JSON.stringify([user.id, owner.id])}`;
    const [drafts, setDrafts] = useState<DraftRow[]>(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(draftKey) || "null") as DraftRow[] | null;
            if (Array.isArray(saved) && saved.length && saved.every((row) => row &&
                [row.taskId, row.detail, row.hours, row.notes].every((value) => typeof value === "string"))) return saved;
        } catch {
            // 本地记录损坏时从空草稿开始。
        }
        return [emptyDraftRow(defaultTaskId)];
    });
    useEffect(() => {
        try {
            if (drafts.some((row) => row.detail.trim() || row.notes.trim())) {
                localStorage.setItem(draftKey, JSON.stringify(drafts));
            } else {
                localStorage.removeItem(draftKey);
            }
        } catch {
            // storage unavailable — drafts stay in memory only
        }
    }, [drafts, draftKey]);
    const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
    const focusedReport = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const row = focusedReport.current;
        if (row) {
            row.focus({preventScroll: true});
            row.scrollIntoView({block: "center", inline: "nearest"});
        }
    }, [focusedReportId]);

    const plans = state.weeklyPlans
        .filter((plan) => plan.ownerId === owner.id && plan.weekId === weekId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const weekReports = state.dailyReports
        .filter((report) => report.ownerId === owner.id && report.weekId === weekId)
        .sort((a, b) => b.date.localeCompare(a.date));
    const dayReports = weekReports.filter((report) => report.date === pickedDate);
    const dayThread = (state.dayThreads ?? []).find(
        (thread) => thread.ownerId === owner.id && thread.date === pickedDate
    );
    const dayEntries: DayEntryRef[] = dayReports.map((report, index) => ({
        no: entryNo(pickedDate, index),
        label: `${entryNo(pickedDate, index)} · ${
            report.detail.length > 24 ? `${report.detail.slice(0, 24)}…` : report.detail
        }`
    }));
    const summaries = summarizeReportsByTask(weekReports);
    const totalHours = summaries.reduce((sum, s) => sum + s.totalHours, 0);
    const unfinished = state.weeklyPlans
        .filter((plan) => plan.ownerId === owner.id && !plan.completed && plan.weekId < weekId)
        .sort((a, b) => b.weekId.localeCompare(a.weekId));

    const isMe = owner.id === user.id;
    // ② 每日报告 is personal: each person fills and edits their own.
    const canEditReports = isMe;

    function reportRowProps(id: string) {
        const focused = id === focusedReportId;
        return {
            "data-report-id": id,
            "data-source-focus": focused || undefined,
            ref: focused ? focusedReport : undefined,
            tabIndex: focused ? -1 : undefined,
            role: focused ? "group" : undefined,
            "aria-label": focused ? "引用的日报" : undefined
        };
    }

    function updateDraft(index: number, patch: Partial<DraftRow>) {
        setDrafts((prev) => prev.map((row, i) => (i === index ? {...row, ...patch} : row)));
    }

    function commitDrafts() {
        const valid = drafts
            .filter((row) => row.detail.trim())
            .map((row) => ({
                date: pickedDate,
                taskId: row.taskId || defaultTaskId,
                detail: row.detail.trim(),
                hours: Number(row.hours) || 0,
                notes: row.notes.trim()
            }));
        if (!valid.length) return;
        onSubmitReports(owner.id, valid);
        setDrafts([emptyDraftRow(defaultTaskId)]);
    }

    return (
        <section className="person-board" data-peer-view={!isMe || undefined} style={{borderTopColor: owner.color}}>
            <div className="person-head">
                <h3>
                    {owner.name}
                    {isMe ? <span className="me-tag">我</span> : null}
                </h3>
                <div className={totalHours >= 45 ? "hour-badge ok" : "hour-badge"}>
                    <strong>{formatHours(totalHours)}</strong>
                    <span>/ 45h</span>
                </div>
            </div>

            <div className="person-sections">
                {/* ========= Plans ========= */}
                <section className="work-card">
                    <div className="work-card-head">
                        <h4>① 本周计划</h4>
                        <span>每条独立勾选</span>
                    </div>
                    <div className="plan-list">
                        {plans.length ? (
                            plans.map((plan) => {
                                const editor = findUser(state.users, plan.updatedById);
                                const task = findTask(state.tasks, plan.taskId);
                                return (
                                    <article
                                        key={plan.id}
                                        className={plan.completed ? "plan-row done" : "plan-row"}
                                        style={{borderLeftColor: editor?.color ?? owner.color}}
                                    >
                                        <div className="plan-row-main">
                                            <input
                                                type="checkbox"
                                                checked={plan.completed}
                                                onChange={(event) =>
                                                    onUpdatePlan(plan.id, {completed: event.target.checked})
                                                }
                                            />
                                            <span className="task-code small">{plan.taskId}</span>
                                            <span className="plan-title">{task?.title ?? "（已删除任务）"}</span>
                                            <textarea rows={1} className="plan-detail"
                                                      defaultValue={plan.detail}
                                                      onBlur={(event) => {
                                                          const detail = event.currentTarget.value;
                                                          if (detail !== plan.detail) onUpdatePlan(plan.id, {detail});
                                                      }}
                                                      placeholder="详情"
                                            />
                                            <button className="text-button mini" onClick={() => onDeletePlan(plan.id)}>
                                                删
                                            </button>
                                        </div>
                                        <div className="plan-row-meta">
                                            <input
                                                className="plan-comment"
                                                defaultValue={plan.comment ?? ""}
                                                placeholder="评论 / 备注"
                                                onBlur={(event) => {
                                                    const comment = event.currentTarget.value;
                                                    if (comment !== (plan.comment ?? "")) onUpdatePlan(plan.id, {comment});
                                                }}
                                            />
                                            <label className="approval-check">
                                                <input
                                                    type="checkbox"
                                                    checked={!!plan.approved}
                                                    onChange={(event) =>
                                                        onUpdatePlan(plan.id, {
                                                            approved: event.target.checked,
                                                            approvedById: event.target.checked ? user.id : undefined,
                                                            approvedAt: event.target.checked ? nowIso() : undefined
                                                        })
                                                    }
                                                />
                                                {plan.approved
                                                    ? `已审批 · ${
                                                        findUser(state.users, plan.approvedById ?? "")?.name ?? "?"
                                                    }${plan.approvedAt ? ` · ${plan.approvedAt.slice(0, 10)}` : ""}`
                                                    : "审批"}
                                            </label>
                                            <span className="last-editor" title="最后编辑人及时间">
                        最后编辑 {editor ? editor.name : plan.updatedById}
                                                {plan.updatedAt ? ` · ${plan.updatedAt.slice(5, 16).replace("T", " ")}` : ""}
                      </span>
                                        </div>
                                    </article>
                                );
                            })
                        ) : (
                            <p className="empty">本周还没有计划。</p>
                        )}
                    </div>
                    <div className="plan-add-row">
                        <TaskSelectInline
                            tasks={state.tasks}
                            value={planTaskId}
                            onChange={setPlanTaskId}
                            leafOnly
                        />
                        <input
                            value={planDetail}
                            onChange={(event) => setPlanDetail(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && planDetail.trim()) {
                                    onAddPlan(owner.id, planTaskId, planDetail.trim());
                                    setPlanDetail("");
                                }
                            }}
                            placeholder="任务详情，回车保存"
                        />
                        <button
                            className="secondary-action small"
                            onClick={() => {
                                if (!planDetail.trim()) return;
                                onAddPlan(owner.id, planTaskId, planDetail.trim());
                                setPlanDetail("");
                            }}
                        >
                            添加
                        </button>
                    </div>
                </section>

                {/* ========= Daily report table ========= */}
                <section className="work-card">
                    <div className="work-card-head">
                        <div className="work-card-head-left">
                            <h4>② 每日报告</h4>
                            <ReactionMenu
                                reactions={dayThread?.reactions ?? {}}
                                users={state.users}
                                user={user}
                                onReact={(emoji) => onDayThread(owner.id, pickedDate, {kind: "react", emoji})}
                            />
                        </div>
                        <span>本周完成的唯一来源</span>
                    </div>
                    <div className="report-table">
                        <div className="report-table-head">
                            <span>编号</span>
                            <span>任务</span>
                            <span>产出</span>
                            <span>时长</span>
                            <span>问题</span>
                            <span></span>
                        </div>
                        {dayReports.map((report, reportIndex) =>
                                !canEditReports ? (
                                    <div key={report.id}
                                         className="report-table-row saved readonly" {...reportRowProps(report.id)}>
                  <span className="cell mono entry-no-cell" title={report.date}>
                    {entryNo(report.date, reportIndex)}
                  </span>
                                        <span className="report-task">
                                            <span className="task-code small">{report.taskId}</span>{" "}
                                            <span>{findTask(state.tasks, report.taskId)?.title ?? "（已删除任务）"}</span>
                                        </span>
                                        <span className="cell-text">{report.detail}</span>
                                        <span className="cell mono">{formatHours(report.hours)}</span>
                                        <span
                                            className={
                                                report.notes
                                                    ? report.resolved
                                                        ? "cell-text issue done"
                                                        : "cell-text issue open"
                                                    : "cell-text"
                                            }
                                        >
                    {report.notes}
                  </span>
                                        <span/>
                                    </div>
                                ) : (
                                    <div key={report.id} className="report-table-row saved" {...reportRowProps(report.id)}>
                <span className="cell mono entry-no-cell" title={report.date}>
                  {entryNo(report.date, reportIndex)}
                </span>
                                        <TaskSelectInline
                                            tasks={state.tasks}
                                            value={report.taskId}
                                            onChange={(taskId) => onUpdateReport(report.id, {taskId})}
                                            leafOnly
                                        />
                                        <AutoGrowTextarea
                                            defaultValue={report.detail}
                                            placeholder="产出"
                                            onBlur={(event) => {
                                                const detail = event.currentTarget.value;
                                                if (detail !== report.detail) onUpdateReport(report.id, {detail});
                                            }}
                                        />
                                        <input
                                            type="number"
                                            step="0.5"
                                            min="0"
                                            defaultValue={String(report.hours)}
                                            onBlur={(event) => {
                                                const hours = Number(event.currentTarget.value) || 0;
                                                if (hours !== report.hours) onUpdateReport(report.id, {hours});
                                            }}
                                        />
                                        <input
                                            defaultValue={report.notes}
                                            placeholder="问题/注意"
                                            className={
                                                report.notes
                                                    ? report.resolved
                                                        ? "issue done"
                                                        : "issue open"
                                                    : ""
                                            }
                                            onBlur={(event) => {
                                                const notes = event.currentTarget.value;
                                                if (notes !== report.notes) onUpdateReport(report.id, {notes});
                                            }}
                                        />
                                        <button
                                            className="text-button mini"
                                            onClick={() => onDeleteReport(report.id)}
                                        >
                                            删
                                        </button>
                                    </div>
                                )
                        )}
                        {canEditReports ? drafts.map((row, index) => (
                            <div key={`draft-${index}`} className="report-table-row draft">
                <span className="cell mono entry-no-cell" title={pickedDate}>
                  {entryNo(pickedDate, dayReports.length + index)}
                </span>
                                <TaskSelectInline
                                    tasks={state.tasks}
                                    value={row.taskId}
                                    onChange={(taskId) => updateDraft(index, {taskId})}
                                    leafOnly
                                />
                                <AutoGrowTextarea
                                    value={row.detail}
                                    onChange={(event) => updateDraft(index, {detail: event.target.value})}
                                    placeholder="今天做了什么"
                                />
                                <input
                                    type="number"
                                    step="0.5"
                                    min="0"
                                    value={row.hours}
                                    onChange={(event) => updateDraft(index, {hours: event.target.value})}
                                    placeholder="h"
                                />
                                <input
                                    value={row.notes}
                                    onChange={(event) => updateDraft(index, {notes: event.target.value})}
                                    placeholder="问题/注意"
                                />
                                <button
                                    className="text-button mini"
                                    onClick={() => {
                                        setDrafts((prev) =>
                                            prev.length <= 1
                                                ? [emptyDraftRow(defaultTaskId)]
                                                : prev.filter((_, i) => i !== index)
                                        );
                                    }}
                                >
                                    ✕
                                </button>
                            </div>
                        )) : null}
                    </div>
                    <div className="report-table-foot">
                        {canEditReports ? (
                            <button className="primary-action small" onClick={commitDrafts}>
                                保存填写行
                            </button>
                        ) : (
                            <span className="readonly-hint">每日报告由本人填写</span>
                        )}
                    </div>
                    <DayThreadBar
                        thread={dayThread}
                        entries={dayEntries}
                        users={state.users}
                        user={user}
                        highlightNonce={
                            threadHighlight &&
                            threadHighlight.ownerId === owner.id &&
                            threadHighlight.date === pickedDate
                                ? threadHighlight.nonce
                                : undefined
                        }
                        onAction={(action) => onDayThread(owner.id, pickedDate, action)}
                    />
                </section>

                {/* ========= Weekly summary ========= */}
                <section className="work-card">
                    <div className="work-card-head">
                        <h4>③ 本周完成</h4>
                        <span>按任务ID聚合</span>
                    </div>
                    <div className="summary-list">
                        {summaries.length ? (
                            summaries.map((summary) => {
                                const task = findTask(state.tasks, summary.taskId);
                                const expanded = expandedTaskId === summary.taskId;
                                return (
                                    <article key={summary.taskId} className="summary-item">
                                        <button
                                            className="summary-row"
                                            onClick={() => setExpandedTaskId(expanded ? null : summary.taskId)}
                                        >
                                            <span className="task-code small">{summary.taskId}</span>
                                            <span className="summary-title">
                        {task?.title ?? "（已删除任务）"}
                      </span>
                                            <span className="hours-pill">{formatHours(summary.totalHours)}</span>
                                            <span className="chev">{expanded ? "▾" : "▸"}</span>
                                        </button>
                                        {expanded ? (
                                            <div className="report-list">
                                                {summary.reports.map((report) => (
                                                    <div key={report.id} className="report-line">
                                                        <b>{report.date.slice(5)}</b>
                                                        <span>{formatHours(report.hours)}</span>
                                                        <p>{report.detail}</p>
                                                        {report.notes ? <em>问题：{report.notes}</em> : null}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : null}
                                    </article>
                                );
                            })
                        ) : (
                            <p className="empty">还没有日报，因此没有完成统计。</p>
                        )}
                    </div>
                </section>

                {/* ========= Unfinished ========= */}
                <section className="work-card danger-zone">
                    <div className="work-card-head">
                        <h4>④ 未完成</h4>
                        <span>跨周追踪</span>
                    </div>
                    {unfinished.length ? (
                        <div className="unfinished-list">
                            {unfinished.map((plan) => (
                                <article key={plan.id} className="unfinished-item">
                                    <strong>
                                        <span className="task-code small">{plan.weekId}</span>{" "}
                                        {plan.taskId} {findTask(state.tasks, plan.taskId)?.title ?? "（已删除任务）"}
                                    </strong>
                                    <p>{plan.detail}</p>
                                    <button onClick={() => onUpdatePlan(plan.id, {completed: true})}>
                                        标记完成
                                    </button>
                                </article>
                            ))}
                        </div>
                    ) : (
                        <p className="empty">没有未完成。</p>
                    )}
                </section>
            </div>
        </section>
    );
}
