import type {StateChange, TeamState, TeamStateKey, TeamStateRecord} from "@oa/contracts";

const labels = {
    users: "user",
    tasks: "task",
    memos: "memo",
    weeklyPlans: "weeklyPlan",
    dailyReports: "dailyReport",
    aiReminders: "aiReminder",
    events: "calendarEvent",
    dayThreads: "dayThread",
    auditLog: "auditLog"
} satisfies Record<TeamStateKey, string>;

// 审计记录最后提交；已有记录的位置以服务端为准。
export const teamStateKeys = Object.keys(labels) as TeamStateKey[];
const newestFirst = new Set<TeamStateKey>(["memos", "weeklyPlans", "dailyReports", "aiReminders"]);

export function sameJson(a: unknown, b: unknown) {
    if (a === b) return true;
    const sorted = (_key: string, value: unknown) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    };
    return JSON.stringify(a ?? null, sorted) === JSON.stringify(b ?? null, sorted);
}

export function buildStateChanges(base: TeamState, next: TeamState): StateChange[] {
    const changes: StateChange[] = [];
    for (const key of teamStateKeys) {
        const left = new Map((base[key] ?? []).map((row) => [row.id, row]));
        for (const after of next[key] ?? []) {
            const before = left.get(after.id) ?? null;
            left.delete(after.id);
            if (!sameJson(before, after)) changes.push({key, id: after.id, before, after} as StateChange);
        }
        for (const [id, before] of left) changes.push({key, id, before, after: null} as StateChange);
    }
    return changes;
}

function orderedRows(
    key: TeamStateKey,
    server: TeamStateRecord[],
    local: TeamStateRecord[],
    merged: Map<string, TeamStateRecord>
) {
    const serverIds = new Set(server.map((row) => row.id));
    const additions = local.filter((row) => !serverIds.has(row.id));
    const order = newestFirst.has(key) ? [...additions, ...server] : [...server, ...additions];
    return order.flatMap(({id}) => {
        const row = merged.get(id);
        return row ? [row] : [];
    });
}

export function mergeTeamState(
    base: TeamState,
    server: TeamState,
    local: TeamState,
    preferLocalConflicts = false
): { state: TeamState; conflicts: string[] } {
    const state = {...server};
    const conflicts: string[] = [];
    for (const key of teamStateKeys) {
        const serverRows = server[key] ?? [];
        const localRows = local[key] ?? [];
        const left = new Map((base[key] ?? []).map((row) => [row.id, row]));
        const remote = new Map(serverRows.map((row) => [row.id, row]));
        const pending = new Map(localRows.map((row) => [row.id, row]));
        const ids = new Set([...left.keys(), ...remote.keys(), ...pending.keys()]);
        const merged = new Map<string, TeamStateRecord>();
        for (const id of ids) {
            const before = left.get(id);
            const serverRow = remote.get(id);
            const localRow = pending.get(id);
            let winner = serverRow;
            if (!sameJson(localRow, before)) {
                if (sameJson(serverRow, before)) {
                    winner = localRow;
                } else if (!sameJson(localRow, serverRow)) {
                    conflicts.push(`${labels[key]}:${id}`);
                    if (preferLocalConflicts) winner = localRow;
                }
            }
            if (winner) merged.set(id, winner);
        }
        Object.assign(state, {[key]: orderedRows(key, serverRows, localRows, merged)});
    }
    return {state, conflicts};
}

/** 只覆盖已知的记录，未出现在差量中的服务器记录不受影响。 */
export function overlayStateChanges(state: TeamState, changes: StateChange[], side: "before" | "after") {
    const next = {...state};
    for (const key of teamStateKeys) {
        const selected = changes.filter((change) => change.key === key);
        if (!selected.length) continue;
        const rows = state[key] ?? [];
        const merged = new Map(rows.map((row) => [row.id, row]));
        const additions: TeamStateRecord[] = [];
        for (const change of selected) {
            const row = change[side];
            if (row) {
                additions.push(row);
                merged.set(change.id, row);
            } else {
                merged.delete(change.id);
            }
        }
        Object.assign(next, {[key]: orderedRows(key, rows, additions, merged)});
    }
    return next;
}

export function foldSaveSnapshot(chainHead: TeamState, saved: TeamState, live: TeamState) {
    if (live === chainHead) return {base: saved, state: saved};
    const folded = mergeTeamState(chainHead, saved, live, true);
    if (!folded.conflicts.length) return {base: saved, state: folded.state};

    // 排队编辑的 before 必须是用户看到的值，而不能悄悄换成这次响应带回的并发版本。
    const queued = buildStateChanges(chainHead, live).filter(({key, id, after}) =>
        !sameJson(after, saved[key]?.find((row) => row.id === id))
    );
    return {base: overlayStateChanges(saved, queued, "before"), state: folded.state};
}

export function hasRecordId(row: unknown): row is { id: string } {
    return typeof row === "object" && row !== null && !Array.isArray(row) &&
        "id" in row && typeof row.id === "string" && row.id.length > 0;
}
