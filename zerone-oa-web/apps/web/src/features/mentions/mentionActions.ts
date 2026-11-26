import {TeamSync} from "../../sync/useTeamSync";
import {memoActions} from "../memos/memoActions";
import {eventActions} from "../calendar/eventActions";

export function mentionActions({
                                   user,
                                   stateRef
                               }: Pick<TeamSync, "user" | "stateRef">, updateEvent: ReturnType<typeof eventActions>["updateEvent"], updateMemo: ReturnType<typeof memoActions>["updateMemo"]) {
    function dismissMention(
        kind: "event" | "memo",
        id: string,
        key: string,
        field: "read" | "done",
        value: boolean
    ) {
        if (!user) return;
        if (kind === "event") {
            const event = (stateRef.current.events ?? []).find((item) => item.id === id);
            const store =
                field === "read"
                    ? event?.dismissedMentionDatesByUser
                    : event?.doneMentionDatesByUser;
            const currentDates = store?.[user.id] ?? [];
            const nextDates = value
                ? Array.from(new Set([...currentDates, key]))
                : currentDates.filter((item) => item !== key);
            const patchField =
                field === "read" ? "dismissedMentionDatesByUser" : "doneMentionDatesByUser";
            updateEvent(id, {
                [patchField]: {...(store ?? {}), [user.id]: nextDates}
            });
            return;
        }
        const memo = stateRef.current.memos.find((item) => item.id === id);
        const currentIds =
            (field === "read" ? memo?.dismissedMentionByIds : memo?.mentionDoneByIds) ?? [];
        const nextIds = value
            ? Array.from(new Set([...currentIds, user.id]))
            : currentIds.filter((item) => item !== user.id);
        updateMemo(
            id,
            field === "read" ? {dismissedMentionByIds: nextIds} : {mentionDoneByIds: nextIds}
        );
    }

    return {dismissMention};
}
