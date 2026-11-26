import {TeamState} from "@oa/contracts";
import {findTask, findUser, formatHours} from "../../shared/utils";
import {descendantIds} from "./tree";
import {Panel} from "../../shared/ui/Panel";

export function TaskDetailPanel({
                                    state,
                                    taskId,
                                    onClose
                                }: {
    state: TeamState;
    taskId: string;
    onClose: () => void;
}) {
    const task = findTask(state.tasks, taskId);
    // Include reports for this task AND any descendants (so a level-2 selection
    // shows aggregate of its level-3 children, when applicable).
    const descendantSet = new Set(descendantIds(state.tasks, taskId));
    const reports = state.dailyReports.filter((r) => descendantSet.has(r.taskId));
    const totalHours = reports.reduce((s, r) => s + Number(r.hours || 0), 0);
    const personMap = new Map<string, { hours: number; count: number }>();
    reports.forEach((r) => {
        const e = personMap.get(r.ownerId) ?? {hours: 0, count: 0};
        e.hours += Number(r.hours || 0);
        e.count += 1;
        personMap.set(r.ownerId, e);
    });
    const personEntries = [...personMap.entries()]
        .map(([id, v]) => ({id, ...v, user: findUser(state.users, id)}))
        .sort((a, b) => b.hours - a.hours);
    const recent = [...reports].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
    const maxHours = personEntries[0]?.hours || 1;

    return (
        <Panel
            title={`${task?.id ?? taskId} ${task?.title ?? ""}`}
            kicker="任务贡献详情"
            actions={
                <button className="icon-btn" title="关闭" onClick={onClose}>
                    ✕
                </button>
            }
        >
            <div className="task-detail-stats">
                <div className="stat-tile">
                    <span>总工时</span>
                    <strong>{formatHours(totalHours)}</strong>
                </div>
                <div className="stat-tile">
                    <span>日报条数</span>
                    <strong>{reports.length}</strong>
                </div>
                <div className="stat-tile">
                    <span>参与人数</span>
                    <strong>{personEntries.length}</strong>
                </div>
            </div>

            <div className="detail-section">
                <h4>每人贡献</h4>
                {personEntries.length ? (
                    <div className="bar-list">
                        {personEntries.map((p) => (
                            <div key={p.id} className="bar-row">
                                <span className="bar-label">{p.user?.name ?? p.id}</span>
                                <div className="bar-track">
                                    <div
                                        className="bar-fill"
                                        style={{
                                            width: `${(p.hours / maxHours) * 100}%`,
                                            background: p.user?.color ?? "var(--primary)"
                                        }}
                                    />
                                </div>
                                <span className="bar-value">{formatHours(p.hours)}</span>
                                <span className="bar-pct">{p.count} 条</span>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="empty">这个任务还没有日报记录。</p>
                )}
            </div>

            <div className="detail-section">
                <h4>最近日报</h4>
                {recent.length ? (
                    <div className="task-detail-reports">
                        {recent.map((r) => {
                            const owner = findUser(state.users, r.ownerId);
                            return (
                                <div key={r.id} className="detail-report-row">
                  <span
                      className="user-tag"
                      style={{background: owner?.color ?? "#888"}}
                      title={owner?.name}
                  >
                    {owner?.name.slice(0, 1) ?? "?"}
                  </span>
                                    <b>{r.date.slice(5)}</b>
                                    <span className="hours">{formatHours(r.hours)}</span>
                                    <p>{r.detail}</p>
                                    {r.notes ? <em>问题：{r.notes}</em> : null}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="empty">暂无</p>
                )}
            </div>
        </Panel>
    );
}
