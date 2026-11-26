import {CalendarEvent, DailyReport, Recurrence, TaskNode, User, WeeklyTaskSummary} from "@oa/contracts";

const BEIJING_TZ = "Asia/Shanghai";

export function uid(prefix: string) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pad(n: number, width = 2) {
    return String(n).padStart(width, "0");
}

function beijingParts(input: Date) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: BEIJING_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
    const parts: Record<string, string> = {};
    fmt.formatToParts(input).forEach((part) => {
        if (part.type !== "literal") parts[part.type] = part.value;
    });
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
        second: Number(parts.second)
    };
}

/** ISO timestamp in Beijing time (e.g. 2026-05-08T15:23:45.123+08:00). */
export function nowIso() {
    const now = new Date();
    const p = beijingParts(now);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(now.getMilliseconds(), 3)}+08:00`;
}

/** Today's date YYYY-MM-DD in Beijing. */
export function todayIso() {
    const p = beijingParts(new Date());
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function weekIdForCalendar(year: number, month: number, day: number) {
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const dayNum = utcDate.getUTCDay() || 7;
    utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${utcDate.getUTCFullYear()}-W${pad(weekNo)}`;
}

export function isoWeekId(input: Date = new Date()) {
    const p = beijingParts(input);
    return weekIdForCalendar(p.year, p.month, p.day);
}

export function dateToWeekId(date: string) {
    const parts = date.split("-").map(Number);
    return weekIdForCalendar(parts[0] ?? 0, parts[1] ?? 1, parts[2] ?? 1);
}

export function taskLabel(task?: TaskNode) {
    return task ? `${task.id} ${task.title}` : "未选择任务";
}

export function findTask(tasks: TaskNode[], taskId: string) {
    return tasks.find((task) => task.id === taskId);
}

export function findUser(users: User[], userId: string) {
    return users.find((user) => user.id === userId);
}

export function filterTasksByKeyword(tasks: TaskNode[], keyword: string) {
    const query = keyword.trim().toLowerCase();
    if (!query) {
        return tasks;
    }
    return tasks.filter((task) => {
        const haystack = `${task.id} ${task.title} ${task.description}`.toLowerCase();
        return haystack.includes(query);
    });
}

export function summarizeReportsByTask(reports: DailyReport[]): WeeklyTaskSummary[] {
    const map = new Map<string, WeeklyTaskSummary>();

    reports.forEach((report) => {
        const current = map.get(report.taskId) ?? {
            taskId: report.taskId,
            totalHours: 0,
            reports: []
        };
        current.totalHours += Number(report.hours) || 0;
        current.reports.push(report);
        map.set(report.taskId, current);
    });

    return [...map.values()].sort((a, b) => b.totalHours - a.totalHours);
}

export function formatHours(hours: number) {
    return `${Math.round(hours * 10) / 10}h`;
}

/* ---------- date helpers ---------- */

export function weekIdToDateRange(weekId: string): { start: string; end: string } | null {
    const match = /^(\d{4})-W(\d{2})$/.exec(weekId);
    if (!match) return null;
    const year = Number(match[1]);
    const week = Number(match[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const monday = new Date(jan4);
    monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
        start: monday.toISOString().slice(0, 10),
        end: sunday.toISOString().slice(0, 10)
    };
}

/* ---------- export / import ---------- */

export function downloadBlob(filename: string, content: string, mime = "text/plain") {
    const blob = new Blob([content], {type: `${mime};charset=utf-8`});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function csvCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    const s = String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/* ---------- calendar / recurrence ---------- */

export function shiftDate(date: string, deltaDays: number): string {
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
}

export function shiftMonth(date: string, deltaMonths: number): string {
    const d = new Date(date + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + deltaMonths);
    return d.toISOString().slice(0, 10);
}

function nextOccurrence(date: string, kind: Recurrence): string {
    switch (kind) {
        case "daily":
            return shiftDate(date, 1);
        case "weekly":
            return shiftDate(date, 7);
        case "biweekly":
            return shiftDate(date, 14);
        case "monthly":
            return shiftMonth(date, 1);
        default:
            return shiftDate(date, 36500); // effectively stop
    }
}

export interface EventOccurrence {
    event: CalendarEvent;
    date: string; // YYYY-MM-DD of this occurrence
}

export function expandEvents(
    events: CalendarEvent[],
    rangeStart: string,
    rangeEnd: string
): EventOccurrence[] {
    const out: EventOccurrence[] = [];
    for (const ev of events) {
        const recurrence = ev.recurrence ?? "none";
        if (recurrence === "none") {
            if (ev.startDate >= rangeStart && ev.startDate <= rangeEnd) {
                out.push({event: ev, date: ev.startDate});
            }
            continue;
        }
        const recEnd = ev.recurrenceEnd
            ? ev.recurrenceEnd < rangeEnd
                ? ev.recurrenceEnd
                : rangeEnd
            : rangeEnd;
        let cursor = ev.startDate;
        let safety = 366; // worst case once-a-day for a year
        while (cursor <= recEnd && safety-- > 0) {
            if (cursor >= rangeStart) out.push({event: ev, date: cursor});
            cursor = nextOccurrence(cursor, recurrence);
        }
    }
    out.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const at = a.event.startTime ?? "";
        const bt = b.event.startTime ?? "";
        return at.localeCompare(bt);
    });
    return out;
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
    if (rows.length === 0) return "";
    const keys = Array.from(
        rows.reduce((set, row) => {
            Object.keys(row).forEach((k) => set.add(k));
            return set;
        }, new Set<string>())
    );
    const header = keys.join(",");
    const body = rows
        .map((row) => keys.map((k) => csvCell((row as Record<string, unknown>)[k])).join(","))
        .join("\n");
    return `${header}\n${body}`;
}
