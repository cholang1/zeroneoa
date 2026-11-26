export type DraftRow = {
    taskId: string;
    detail: string;
    hours: string;
    notes: string;
};

export function emptyDraftRow(defaultTaskId: string): DraftRow {
    return {taskId: defaultTaskId, detail: "", hours: "", notes: ""};
}

export type DayThreadAction =
    | { kind: "comment"; text: string }
    | { kind: "deleteComment"; commentId: string }
    | { kind: "react"; emoji: string }
    | { kind: "seen" };

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "💪", "✅", "👏", "🔥"];

export type DayEntryRef = { no: string; label: string };

export type ThreadHighlight = { ownerId: string; date: string; nonce: number };

export function entryNo(date: string, index: number) {
    return `${date.replace(/-/g, "")}-${index + 1}`;
}

export function renderEntryRefs(text: string) {
    return text.split(/(#\d{8}-\d+|#\d+)/g).map((part, index) =>
        /^#(\d{8}-)?\d+$/.test(part) ? (
            <mark key={index} className="entry-ref">
                {part}
            </mark>
        ) : (
            part
        )
    );
}
