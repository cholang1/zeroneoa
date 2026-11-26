import {Memo} from "@oa/contracts";
import {nowIso, uid} from "../../shared/utils";
import {TeamSync} from "../../sync/useTeamSync";

export function memoActions({
                                user,
                                stateRef,
                                persist,
                                withAudit
                            }: Pick<TeamSync, "user" | "stateRef" | "persist" | "withAudit">) {
    function addMemo(
        scope: "weekly" | "longTerm",
        text: string,
        weekIdParam: string,
        options: Pick<Memo, "color" | "mentionAll" | "mentionUserIds">
    ) {
        if (!user) return;
        const current = stateRef.current;
        const memo: Memo = {
            id: uid("memo"),
            scope,
            weekId: scope === "weekly" ? weekIdParam : undefined,
            text,
            color: options.color,
            mentionAll: options.mentionAll,
            mentionUserIds: options.mentionUserIds,
            createdById: user.id,
            updatedById: user.id,
            createdAt: nowIso(),
            updatedAt: nowIso()
        };
        persist(
            withAudit({...current, memos: [memo, ...current.memos]}, `added ${scope} memo`, "memo", memo.id)
        );
    }

    function updateMemo(id: string, patch: Partial<Memo>) {
        if (!user) return;
        const current = stateRef.current;
        const shouldResetDismissals =
            "text" in patch || "mentionAll" in patch || "mentionUserIds" in patch;
        // 勾选已阅/完成不算编辑：不更新 updatedAt/updatedById，避免重触发他人的
        // 新提醒 toast，也不改变备忘的"最后编辑"归属。
        const receiptOnly = Object.keys(patch).every(
            (key) => key === "dismissedMentionByIds" || key === "mentionDoneByIds"
        );
        persist(
            withAudit(
                {
                    ...current,
                    memos: current.memos.map((memo) =>
                        memo.id === id
                            ? {
                                ...memo,
                                ...patch,
                                dismissedMentionByIds: shouldResetDismissals ? [] : patch.dismissedMentionByIds ?? memo.dismissedMentionByIds,
                                mentionDoneByIds: shouldResetDismissals ? [] : patch.mentionDoneByIds ?? memo.mentionDoneByIds,
                                updatedById: receiptOnly ? memo.updatedById : user.id,
                                updatedAt: receiptOnly ? memo.updatedAt : nowIso()
                            }
                            : memo
                    )
                },
                "updated memo",
                "memo",
                id
            )
        );
    }

    function deleteMemo(id: string) {
        const current = stateRef.current;
        persist(
            withAudit(
                {...current, memos: current.memos.filter((m) => m.id !== id)},
                "deleted memo",
                "memo",
                id
            )
        );
    }

    return {addMemo, updateMemo, deleteMemo};
}
