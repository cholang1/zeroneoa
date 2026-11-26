import {DailyReport, WeeklyPlanItem} from "@oa/contracts";
import {dateToWeekId, isoWeekId, nowIso, uid} from "../../shared/utils";
import {TeamSync} from "../../sync/useTeamSync";

export function workActions({
                                user,
                                stateRef,
                                persist,
                                withAudit
                            }: Pick<TeamSync, "user" | "stateRef" | "persist" | "withAudit">, weekId: string) {
    function addPlan(ownerId: string, taskId: string, detail: string) {
        if (!user) return;
        const current = stateRef.current;
        const plan: WeeklyPlanItem = {
            id: uid("plan"),
            weekId: weekId || isoWeekId(),
            ownerId,
            taskId,
            detail,
            completed: false,
            createdById: user.id,
            updatedById: user.id,
            createdAt: nowIso(),
            updatedAt: nowIso()
        };
        persist(
            withAudit(
                {...current, weeklyPlans: [plan, ...current.weeklyPlans]},
                "added weekly plan",
                "weeklyPlan",
                plan.id
            )
        );
    }

    function updatePlan(planId: string, patch: Partial<WeeklyPlanItem>) {
        if (!user) return;
        const current = stateRef.current;
        persist(
            withAudit(
                {
                    ...current,
                    weeklyPlans: current.weeklyPlans.map((plan) =>
                        plan.id === planId
                            ? {...plan, ...patch, updatedById: user.id, updatedAt: nowIso()}
                            : plan
                    )
                },
                "updated weekly plan",
                "weeklyPlan",
                planId
            )
        );
    }

    function deletePlan(planId: string) {
        const current = stateRef.current;
        persist(
            withAudit(
                {...current, weeklyPlans: current.weeklyPlans.filter((p) => p.id !== planId)},
                "deleted weekly plan",
                "weeklyPlan",
                planId
            )
        );
    }

    function submitReports(
        ownerId: string,
        rows: Array<{ date: string; taskId: string; detail: string; hours: number; notes: string }>
    ) {
        if (!user) return;
        const current = stateRef.current;
        const newReports: DailyReport[] = rows.map((row) => ({
            id: uid("report"),
            date: row.date,
            weekId: dateToWeekId(row.date),
            ownerId,
            taskId: row.taskId,
            detail: row.detail,
            hours: row.hours,
            notes: row.notes,
            createdById: user.id,
            updatedById: user.id,
            createdAt: nowIso(),
            updatedAt: nowIso()
        }));
        persist(
            withAudit(
                {...current, dailyReports: [...newReports, ...current.dailyReports]},
                `submitted ${newReports.length} report row(s)`,
                "dailyReport",
                newReports[0]?.id ?? "batch"
            )
        );
    }

    function updateReport(reportId: string, patch: Partial<DailyReport>) {
        if (!user) return;
        const current = stateRef.current;
        persist(
            withAudit(
                {
                    ...current,
                    dailyReports: current.dailyReports.map((report) =>
                        report.id === reportId
                            ? {...report, ...patch, updatedById: user.id, updatedAt: nowIso()}
                            : report
                    )
                },
                "updated daily report",
                "dailyReport",
                reportId
            )
        );
    }

    function deleteReport(reportId: string) {
        const current = stateRef.current;
        persist(
            withAudit(
                {...current, dailyReports: current.dailyReports.filter((r) => r.id !== reportId)},
                "deleted daily report",
                "dailyReport",
                reportId
            )
        );
    }

    return {addPlan, updatePlan, deletePlan, submitReports, updateReport, deleteReport};
}
