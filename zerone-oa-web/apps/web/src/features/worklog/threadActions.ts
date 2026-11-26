import {DayThread} from "@oa/contracts";
import {dateToWeekId, nowIso, uid} from "../../shared/utils";
import {DayThreadAction} from "./model";
import {TeamSync} from "../../sync/useTeamSync";

export function threadActions({
                                  user,
                                  stateRef,
                                  persist,
                                  withAudit
                              }: Pick<TeamSync, "user" | "stateRef" | "persist" | "withAudit">) {
    function mutateDayThread(ownerId: string, date: string, action: DayThreadAction) {
        if (!user) return;
        const current = stateRef.current;
        const threadId = `thread-${ownerId}-${date}`;
        const existing = (current.dayThreads ?? []).find((thread) => thread.id === threadId);
        const now = nowIso();
        const base: DayThread = existing ?? {
            id: threadId,
            ownerId,
            date,
            weekId: dateToWeekId(date),
            comments: [],
            reactions: {},
            createdById: user.id,
            updatedById: user.id,
            createdAt: now,
            updatedAt: now
        };
        let nextThread: DayThread;
        if (action.kind === "comment") {
            nextThread = {
                ...base,
                comments: [
                    ...(base.comments ?? []),
                    {id: uid("cmt"), authorId: user.id, text: action.text, createdAt: now}
                ]
            };
        } else if (action.kind === "deleteComment") {
            nextThread = {
                ...base,
                comments: (base.comments ?? []).filter((comment) => comment.id !== action.commentId)
            };
        } else if (action.kind === "seen") {
            if (!existing) return;
            // 标记已读是回执，不算内容变化：不动 updatedAt/updatedById，这样
            // 只有评论区出现新状态时反馈提示才会再次出现。
            nextThread = {...base, ownerSeenAt: base.updatedAt};
        } else {
            const ids = (base.reactions ?? {})[action.emoji] ?? [];
            const nextIds = ids.includes(user.id)
                ? ids.filter((id) => id !== user.id)
                : [...ids, user.id];
            const reactions = {...(base.reactions ?? {})};
            if (nextIds.length) reactions[action.emoji] = nextIds;
            else delete reactions[action.emoji];
            nextThread = {...base, reactions};
        }
        if (action.kind !== "seen") {
            nextThread = {...nextThread, updatedById: user.id, updatedAt: now};
        }
        const dayThreads = existing
            ? (current.dayThreads ?? []).map((thread) => (thread.id === threadId ? nextThread : thread))
            : [...(current.dayThreads ?? []), nextThread];
        persist(
            withAudit(
                {...current, dayThreads},
                `updated day thread ${date} (${action.kind})`,
                "dailyReport",
                threadId
            )
        );
    }

    return {mutateDayThread};
}
