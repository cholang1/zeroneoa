import {appError} from "../../shared/error";
import {TeamSync} from "../../sync/useTeamSync";

export function reminderActions({
                                    api,
                                    user,
                                    runServerUpdate,
                                    stateRef,
                                    persist,
                                    withAudit
                                }: Pick<TeamSync, "api" | "user" | "runServerUpdate" | "stateRef" | "persist" | "withAudit">, weekId: string) {
    async function runAi() {
        if (!user || !api) return;
        try {
            await runServerUpdate(() => api.generateAiReminders(user.id, weekId));
        } catch (error) {
            window.alert(`AI 提醒失败：${appError(error)}`);
        }
    }

    function clearAi() {
        const current = stateRef.current;
        persist(withAudit({...current, aiReminders: []}, "cleared AI reminders", "aiReminder", "ai"));
    }

    function dismissAi(id: string) {
        if (!user) return;
        const current = stateRef.current;
        persist(
            withAudit(
                {
                    ...current,
                    aiReminders: current.aiReminders.map((reminder) =>
                        reminder.id === id
                            ? {
                                ...reminder,
                                dismissedByIds: Array.from(new Set([...(reminder.dismissedByIds ?? []), user.id]))
                            }
                            : reminder
                    )
                },
                "dismissed AI reminder",
                "aiReminder",
                id
            )
        );
    }

    return {runAi, clearAi, dismissAi};
}
