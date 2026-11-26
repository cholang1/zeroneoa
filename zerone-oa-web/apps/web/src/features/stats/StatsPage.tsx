import {OaPicker} from "../../shared/ui/OaPicker";
import {useEffect, useMemo, useState} from "react";
import {TeamState} from "@oa/contracts";
import {findTask, findUser, formatHours, todayIso} from "../../shared/utils";
import {uniqueWeekIds, weekLabel} from "../../shared/weeks";
import {Panel} from "../../shared/ui/Panel";

export type StatsPeriod = "week" | "month" | "all";

export function StatsPage({state, weekId}: { state: TeamState; weekId: string }) {
    const [period, setPeriod] = useState<StatsPeriod>("week");
    const [selectedWeekId, setSelectedWeekId] = useState(weekId);
    const [selectedMonth, setSelectedMonth] = useState(todayIso().slice(0, 7));
    const weekOptions = useMemo(() => uniqueWeekIds(state, weekId), [state, weekId]);
    const monthOptions = useMemo(() => {
        const months = new Set<string>([todayIso().slice(0, 7)]);
        state.dailyReports.forEach((report) => months.add(report.date.slice(0, 7)));
        return [...months].sort().reverse();
    }, [state.dailyReports]);

    useEffect(() => {
        setSelectedWeekId((current) => (weekOptions.includes(current) ? current : weekId));
    }, [weekOptions, weekId]);

    const filtered = useMemo(() => {
        if (period === "all") return state.dailyReports;
        if (period === "week") return state.dailyReports.filter((r) => r.weekId === selectedWeekId);
        return state.dailyReports.filter((r) => r.date.startsWith(selectedMonth));
    }, [period, state.dailyReports, selectedWeekId, selectedMonth]);

    const totalHours = filtered.reduce((s, r) => s + Number(r.hours || 0), 0);

    const byPerson = useMemo(() => {
        const map = new Map<string, number>();
        filtered.forEach((r) => map.set(r.ownerId, (map.get(r.ownerId) ?? 0) + Number(r.hours || 0)));
        return [...map.entries()]
            .map(([id, hours]) => {
                const u = findUser(state.users, id);
                return {
                    id,
                    label: u?.name ?? id,
                    color: u?.color ?? "#888",
                    value: hours
                };
            })
            .sort((a, b) => b.value - a.value);
    }, [filtered, state.users]);

    const byTask = useMemo(() => {
        const map = new Map<string, number>();
        filtered.forEach((r) => map.set(r.taskId, (map.get(r.taskId) ?? 0) + Number(r.hours || 0)));
        const palette = ["#2563eb", "#0f9b8e", "#d97706", "#7c3aed", "#be123c", "#15803d", "#b45309"];
        return [...map.entries()]
            .map(([id, hours], i) => {
                const t = findTask(state.tasks, id);
                return {
                    id,
                    label: t ? `${t.id} ${t.title}` : id,
                    color: palette[i % palette.length],
                    value: hours
                };
            })
            .sort((a, b) => b.value - a.value)
            .slice(0, 12);
    }, [filtered, state.tasks]);

    const periodLabel =
        period === "week" ? `周 ${selectedWeekId}` : period === "month" ? `月 ${selectedMonth}` : "全部历史";

    return (
        <div className="page-stack">
            <div className="page-header">
                <h2>统计</h2>
                <div className="stats-controls">
                    <div className="segmented">
                        <button className={period === "week" ? "active" : ""} onClick={() => setPeriod("week")}>
                            按周
                        </button>
                        <button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>
                            按月
                        </button>
                        <button className={period === "all" ? "active" : ""} onClick={() => setPeriod("all")}>
                            全部
                        </button>
                    </div>
                    {period === "week" ? (
                        <OaPicker name="统计周次" value={selectedWeekId} onPick={setSelectedWeekId}
                                  options={weekOptions.map(week => ({value: week, label: weekLabel(week)}))}/>
                    ) : null}
                    {period === "month" ? (
                        <OaPicker name="统计月份" value={selectedMonth} onPick={setSelectedMonth}
                                  options={monthOptions.map(month => ({value: month, label: month}))}/>
                    ) : null}
                </div>
            </div>

            <section className="stats-summary">
                <div className="stat-tile big">
                    <span>{periodLabel}</span>
                    <strong>{formatHours(totalHours)}</strong>
                </div>
                <div className="stat-tile">
                    <span>日报条数</span>
                    <strong>{filtered.length}</strong>
                </div>
                <div className="stat-tile">
                    <span>覆盖任务</span>
                    <strong>{byTask.length}</strong>
                </div>
                <div className="stat-tile">
                    <span>参与人数</span>
                    <strong>{byPerson.length}</strong>
                </div>
            </section>

            <div className="stats-layout">
                <Panel title="按人贡献" kicker={periodLabel}>
                    {byPerson.length ? (
                        <div className="stats-donut-row">
                            <Donut data={byPerson} total={totalHours}/>
                            <div className="bar-list">
                                {byPerson.map((item) => (
                                    <div key={item.id} className="bar-row">
                    <span className="bar-label">
                      <span className="dot" style={{background: item.color}}/> {item.label}
                    </span>
                                        <div className="bar-track">
                                            <div
                                                className="bar-fill"
                                                style={{
                                                    width: `${(item.value / (byPerson[0]?.value || 1)) * 100}%`,
                                                    background: item.color
                                                }}
                                            />
                                        </div>
                                        <span className="bar-value">{formatHours(item.value)}</span>
                                        <span className="bar-pct">
                      {totalHours ? Math.round((item.value / totalHours) * 100) : 0}%
                    </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <p className="empty">该时段还没有数据。</p>
                    )}
                </Panel>

                <Panel title="按任务贡献（Top 12）" kicker={periodLabel}>
                    {byTask.length ? (
                        <div className="bar-list">
                            {byTask.map((item) => (
                                <div key={item.id} className="bar-row">
                  <span className="bar-label" title={item.label}>
                    <span className="task-code small">{item.id}</span>
                    <span className="trim">
                      {findTask(state.tasks, item.id)?.title ?? "（已删除任务）"}
                    </span>
                  </span>
                                    <div className="bar-track">
                                        <div
                                            className="bar-fill"
                                            style={{
                                                width: `${(item.value / (byTask[0]?.value || 1)) * 100}%`,
                                                background: item.color
                                            }}
                                        />
                                    </div>
                                    <span className="bar-value">{formatHours(item.value)}</span>
                                    <span className="bar-pct">
                    {totalHours ? Math.round((item.value / totalHours) * 100) : 0}%
                  </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="empty">该时段还没有数据。</p>
                    )}
                </Panel>
            </div>
        </div>
    );
}

export function Donut({
                          data,
                          total,
                          size = 200,
                          thickness = 28
                      }: {
    data: Array<{ id: string; color: string; value: number }>;
    total: number;
    size?: number;
    thickness?: number;
}) {
    if (total <= 0) return null;
    const radius = (size - thickness) / 2;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    return (
        <div className="donut-wrap">
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="donut">
                <g transform={`translate(${size / 2}, ${size / 2}) rotate(-90)`}>
                    <circle
                        r={radius}
                        cx={0}
                        cy={0}
                        fill="none"
                        stroke="var(--line)"
                        strokeWidth={thickness}
                    />
                    {data.map((seg) => {
                        const len = (seg.value / total) * circumference;
                        const dasharray = `${len} ${circumference}`;
                        const dashoffset = -offset;
                        offset += len;
                        return (
                            <circle
                                key={seg.id}
                                r={radius}
                                cx={0}
                                cy={0}
                                fill="none"
                                stroke={seg.color}
                                strokeWidth={thickness}
                                strokeDasharray={dasharray}
                                strokeDashoffset={dashoffset}
                            />
                        );
                    })}
                </g>
                <text x={size / 2} y={size / 2 - 6} className="donut-total" textAnchor="middle">
                    {formatHours(total)}
                </text>
                <text x={size / 2} y={size / 2 + 14} className="donut-total-label" textAnchor="middle">
                    总工时
                </text>
            </svg>
        </div>
    );
}
