import {TeamState} from "@oa/contracts";
import {isoWeekId, weekIdToDateRange} from "./utils";

export function uniqueWeekIds(state: TeamState, currentWeek = isoWeekId()) {
    const weeks = new Set<string>([isoWeekId(), currentWeek]);
    state.weeklyPlans.forEach((plan) => weeks.add(plan.weekId));
    state.dailyReports.forEach((report) => weeks.add(report.weekId));
    return [...weeks].sort().reverse();
}

export function weekLabel(weekId: string) {
    const range = weekIdToDateRange(weekId);
    if (!range) return weekId;
    return `${weekId} · ${range.start.slice(5)} → ${range.end.slice(5)}`;
}
