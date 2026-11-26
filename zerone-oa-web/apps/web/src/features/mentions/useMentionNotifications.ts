import {useEffect, useMemo, useRef, useState} from "react";
import {SessionUser, TeamState} from "@oa/contracts";
import {MentionItem, collectMentions} from "./mentions";
import {ThreadHighlight} from "../worklog/model";

export function useMentionNotifications(state: TeamState, user: SessionUser | null, loading: boolean) {
    // Browser-tab marquee + first-open toast for @ mentions.
    const myMentions = useMemo(
        () => (user ? collectMentions(state, user.id) : []),
        [state, user]
    );
    const unreadMentionCount = myMentions.filter((item) => !item.read && !item.done).length;
    const [mentionToast, setMentionToast] = useState<MentionItem[] | null>(null);
    const mentionToastCheckedRef = useRef(false);

    // Bottom-right feedback popup: my day-reports whose thread changed since I
    // last marked it read, and where the last change came from someone else.
    const [threadHighlight, setThreadHighlight] = useState<ThreadHighlight | null>(null);
    const feedbackThreads = useMemo(() => {
        if (!user) return [];
        return (state.dayThreads ?? [])
            .filter((thread) => {
                // 反馈被撤回后线程会留空壳：没有实际内容就不提示。
                const hasFeedback =
                    (thread.comments ?? []).length > 0 ||
                    Object.values(thread.reactions ?? {}).some((ids) => ids.length > 0);
                return (
                    hasFeedback &&
                    thread.ownerId === user.id &&
                    thread.updatedById !== user.id &&
                    (thread.ownerSeenAt ?? "") < thread.updatedAt
                );
            })
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }, [state.dayThreads, user]);

    useEffect(() => {
        const baseTitle = "Zerone OA";
        if (!unreadMentionCount) {
            document.title = baseTitle;
            return;
        }
        const text = `你有${unreadMentionCount}条新提醒 · ${baseTitle} · `;
        let offset = 0;
        const timer = window.setInterval(() => {
            offset = (offset + 1) % text.length;
            document.title = text.slice(offset) + text.slice(0, offset);
        }, 500);
        return () => {
            window.clearInterval(timer);
            document.title = baseTitle;
        };
    }, [unreadMentionCount]);

    // Show the bottom-left toast once per new/edited mention: the first page
    // open after the mention changed, never again afterwards.
    useEffect(() => {
        if (!user || loading || mentionToastCheckedRef.current) return;
        mentionToastCheckedRef.current = true;
        const seenKey = `oa-mention-seen-${user.id}`;
        let seen: Record<string, string> = {};
        try {
            seen = JSON.parse(localStorage.getItem(seenKey) ?? "{}") as Record<string, string>;
        } catch {
            seen = {};
        }
        const fresh = myMentions.filter(
            (item) => !item.read && !item.done && seen[`${item.kind}:${item.id}:${item.key}`] !== item.marker
        );
        const next: Record<string, string> = {};
        myMentions.forEach((item) => {
            next[`${item.kind}:${item.id}:${item.key}`] = item.marker;
        });
        try {
            localStorage.setItem(seenKey, JSON.stringify(next));
        } catch {
            // storage unavailable — toast may repeat, acceptable
        }
        if (fresh.length) setMentionToast(fresh);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, loading, myMentions]);
    return {mentionToast, setMentionToast, feedbackThreads, threadHighlight, setThreadHighlight};
}
