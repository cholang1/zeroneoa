import {SessionUser, TeamState} from "@oa/contracts";
import {formatHours} from "../utils";

export function MetricStrip({state, weekId, user}: { state: TeamState; weekId: string; user: SessionUser }) {
    const weekReports = state.dailyReports.filter((r) => r.weekId === weekId && r.ownerId === user.id);
    const weekHours = weekReports.reduce((sum, r) => sum + Number(r.hours || 0), 0);
    const openPlans = state.weeklyPlans.filter((p) => p.ownerId === user.id && !p.completed && p.weekId <= weekId);
    const openIssues = state.dailyReports.filter(
        (r) => r.ownerId === user.id && r.notes?.trim() && !r.resolved
    ).length;

    return (
        <section className="metric-strip">
            <Metric label="本周总工时" value={formatHours(weekHours)}/>
            <Metric
                label="未完成计划"
                value={String(openPlans.length)}
                tone={openPlans.length >= 5 ? "warn" : undefined}
            />
            <Metric label="未解决问题" value={String(openIssues)} tone={openIssues > 0 ? "warn" : undefined}/>
            <Metric label="任务节点" value={String(state.tasks.length)}/>
        </section>
    );
}

export function Metric({label, value, tone}: { label: string; value: string; tone?: "warn" }) {
    return (
        <div className={tone === "warn" ? "metric warn" : "metric"}>
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}
