const BEIJING_TZ = "Asia/Shanghai";
const beijingFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BEIJING_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
});

/** Current time as an ISO string in Beijing time, e.g. 2026-01-01T09:00:00.000+08:00. */
export function nowIso() {
    const now = new Date();
    const parts = {};
    beijingFormatter.formatToParts(now).forEach((p) => {
        if (p.type !== "literal") parts[p.type] = p.value;
    });
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    const hour = String(Number(parts.hour) % 24).padStart(2, "0");
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}.${ms}+08:00`;
}

export function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** ISO week id (YYYY-Www) of a Beijing date string YYYY-MM-DD. */
export function weekIdOf(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const target = new Date(Date.UTC(y, m - 1, d));
    const dayNum = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
