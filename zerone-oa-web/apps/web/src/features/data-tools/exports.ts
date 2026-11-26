import {ReportComment, TeamState} from "@oa/contracts";
import {shiftDate, todayIso, weekIdToDateRange} from "../../shared/utils";

export type ExportKind = "json" | "csv";

export type ExportRange = "3d" | "1w" | "1m" | "all";

export const EXPORT_RANGES: Array<{ key: ExportRange; label: string; days: number | null }> = [
    {key: "3d", label: "最近三天", days: 3},
    {key: "1w", label: "最近一周", days: 7},
    {key: "1m", label: "最近一个月", days: 30},
    {key: "all", label: "全部", days: null}
];

export function exportSince(range: ExportRange) {
    const days = EXPORT_RANGES.find((item) => item.key === range)?.days;
    return days ? shiftDate(todayIso(), -(days - 1)) : null;
}

export function sliceStateSince(state: TeamState, since: string | null): TeamState {
    if (!since) return state;
    const day = (value?: string | null) => String(value ?? "").slice(0, 10);
    const weekTouches = (weekId?: string) => {
        const range = weekId ? weekIdToDateRange(weekId) : null;
        return Boolean(range && range.end >= since);
    };
    const commentedSince = (comments?: ReportComment[]) =>
        (comments ?? []).some((comment) => day(comment.createdAt) >= since);
    return {
        ...state,
        weeklyPlans: state.weeklyPlans.filter((plan) => weekTouches(plan.weekId)),
        dailyReports: state.dailyReports.filter((report) => report.date >= since),
        dayThreads: (state.dayThreads ?? []).filter(
            (thread) => thread.date >= since || commentedSince(thread.comments)
        ),
        memos: state.memos.filter(
            (memo) =>
                day(memo.updatedAt) >= since ||
                (memo.scope === "weekly" && weekTouches(memo.weekId)) ||
                commentedSince(memo.comments)
        ),
        events: (state.events ?? []).filter(
            (event) =>
                event.startDate >= since ||
                day(event.updatedAt) >= since ||
                (Boolean(event.recurrence) &&
                    event.recurrence !== "none" &&
                    (!event.recurrenceEnd || event.recurrenceEnd >= since))
        ),
        aiReminders: state.aiReminders.filter((reminder) => reminder.date >= since),
        auditLog: state.auditLog.filter((entry) => day(entry.createdAt) >= since)
    };
}
