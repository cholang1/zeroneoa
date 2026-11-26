import {TeamState} from "@oa/contracts";
import {expandEvents, isoWeekId, shiftDate, todayIso} from "../../shared/utils";

export type MentionItem = {
    kind: "event" | "memo";
    id: string;
    key: string;
    title: string;
    detail: string;
    read: boolean;
    done: boolean;
    marker: string;
    color?: string;
};

export function collectMentions(state: TeamState, userId: string): MentionItem[] {
    const today = todayIso();
    const rangeEnd = shiftDate(today, 7);
    const occurrences = expandEvents(state.events ?? [], today, rangeEnd);
    const eventItems: MentionItem[] = occurrences
        .filter((o) => o.date >= today && o.event.participantIds.includes(userId))
        .map((o) => ({
            kind: "event",
            id: o.event.id,
            key: o.date,
            title: o.event.title,
            detail: `${o.date.slice(5)} ${o.event.startTime ?? ""}${
                o.event.location ? ` · ${o.event.location}` : ""
            }`,
            read: (o.event.dismissedMentionDatesByUser?.[userId] ?? []).includes(o.date),
            done: (o.event.doneMentionDatesByUser?.[userId] ?? []).includes(o.date),
            marker: `${o.event.updatedAt}|${o.date}`
        }));
    const currentWeekId = isoWeekId();
    const memoItems: MentionItem[] = (state.memos ?? [])
        .filter(
            (memo) =>
                (memo.scope === "longTerm" || memo.weekId === currentWeekId) &&
                (memo.mentionAll || (memo.mentionUserIds ?? []).includes(userId))
        )
        .map((memo) => ({
            kind: "memo",
            id: memo.id,
            key: "memo",
            title: memo.text,
            detail: memo.scope === "longTerm" ? "长期备忘" : "本周备忘",
            read: (memo.dismissedMentionByIds ?? []).includes(userId),
            done: (memo.mentionDoneByIds ?? []).includes(userId),
            marker: memo.updatedAt,
            color: memo.color
        }));
    return [...eventItems, ...memoItems];
}
