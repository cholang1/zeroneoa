import {CalendarEvent} from "@oa/contracts";
import {nowIso, uid} from "../../shared/utils";
import {TeamSync} from "../../sync/useTeamSync";

export function eventActions({
                                 user,
                                 stateRef,
                                 persist,
                                 withAudit
                             }: Pick<TeamSync, "user" | "stateRef" | "persist" | "withAudit">) {
    function addEvent(input: Omit<CalendarEvent, "id" | "createdById" | "updatedById" | "createdAt" | "updatedAt">) {
        if (!user) return;
        const current = stateRef.current;
        const now = nowIso();
        const ev: CalendarEvent = {
            ...input,
            id: uid("ev"),
            createdById: user.id,
            updatedById: user.id,
            createdAt: now,
            updatedAt: now
        };
        persist(withAudit({
            ...current,
            events: [...(current.events ?? []), ev]
        }, `added event ${ev.title}`, "calendarEvent", ev.id));
    }

    function updateEvent(id: string, patch: Partial<CalendarEvent>) {
        if (!user) return;
        const current = stateRef.current;
        const now = nowIso();
        const events = (current.events ?? []).map((ev) =>
            ev.id === id ? {...ev, ...patch, updatedById: user.id, updatedAt: now} : ev
        );
        persist(withAudit({...current, events}, "updated event", "calendarEvent", id));
    }

    function deleteEvent(id: string) {
        if (!user) return;
        const current = stateRef.current;
        const events = (current.events ?? []).filter((ev) => ev.id !== id);
        persist(withAudit({...current, events}, "deleted event", "calendarEvent", id));
    }

    return {addEvent, updateEvent, deleteEvent};
}
