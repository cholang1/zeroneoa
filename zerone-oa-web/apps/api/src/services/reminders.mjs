import {nowIso, uid, weekIdOf} from "./time.mjs";

/** Rule-based weekly reminders (plug an LLM in here if you want real "AI"). */
function buildReminders(state, weekId) {
    const today = nowIso().slice(0, 10);
    const reminders = [];

    state.users.forEach((user) => {
        const reports = state.dailyReports.filter(
            (report) => report.ownerId === user.id && report.weekId === weekId
        );
        const weeklyHours = reports.reduce((sum, report) => sum + Number(report.hours || 0), 0);
        const openPlans = state.weeklyPlans.filter(
            (plan) => plan.ownerId === user.id && !plan.completed && plan.weekId <= weekId
        );
        const issueReports = reports.filter((report) => report.notes?.trim() && !report.resolved);

        if (reports.length && weeklyHours < 40) {
            reminders.push({
                id: uid("ai"),
                date: today,
                weekId,
                ownerId: user.id,
                severity: "warning",
                summary: `${user.name} 本周（${weekId}）日报累计 ${Math.round(weeklyHours * 10) / 10} 小时。`,
                actions: ["补齐日报工时", "把日报绑定到任务ID"],
                createdAt: nowIso()
            });
        }

        if (openPlans.length) {
            reminders.push({
                id: uid("ai"),
                date: today,
                weekId,
                ownerId: user.id,
                severity: openPlans.length >= 3 ? "critical" : "warning",
                summary: `${user.name} 有 ${openPlans.length} 条未完成计划，需要确认延期、取消或继续执行。`,
                actions: openPlans.slice(0, 4).map((plan) => `处理：${plan.detail}`),
                createdAt: nowIso()
            });
        }

        if (issueReports.length) {
            reminders.push({
                id: uid("ai"),
                date: today,
                weekId,
                ownerId: user.id,
                severity: "info",
                summary: `${user.name} 的日报中有 ${issueReports.length} 条未解决的问题/注意事项。`,
                actions: issueReports.slice(0, 3).map((report) => report.notes),
                createdAt: nowIso()
            });
        }
    });

    if (!reminders.length) {
        reminders.push({
            id: uid("ai"),
            date: today,
            weekId,
            severity: "info",
            summary: `${weekId} 没有明显的延期、低工时或阻塞风险。`,
            actions: ["检查计划是否勾选完成", "确认下周计划是否分配到人"],
            createdAt: nowIso()
        });
    }

    return reminders;
}

export async function refreshReminders(store, requestedWeek, verify) {
    const weekId = requestedWeek || weekIdOf(nowIso().slice(0, 10));
    return store.refreshWeek(weekId, buildReminders, verify);
}
