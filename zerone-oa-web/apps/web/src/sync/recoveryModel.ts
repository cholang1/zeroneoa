import type {StateChange, TeamState} from "@oa/contracts";
import {buildStateChanges, hasRecordId, sameJson, teamStateKeys} from "./merge";

export const recoveryKey = "oa-v2-pending-recovery";
export const memberRecoveryKey = (memberId: string) => `${recoveryKey}-${encodeURIComponent(memberId)}`;

type Pending = { changes: StateChange[]; followUp?: StateChange[] };
export type Recovery = Pending & { actorId: string; savedAt: string };

const token = ({key, id}: Pick<StateChange, "key" | "id">) => JSON.stringify([key, id]);

export function pendingRecovery(base: TeamState, live: TeamState, attempted: TeamState | null): Pending {
    const changes = buildStateChanges(base, live);
    if (!attempted || attempted === live) return {changes};
    // 较新的编辑可能刚好撤销在途请求，单看已确认快照会漏掉它。
    const sent = new Set(buildStateChanges(base, attempted).map(token));
    const followUp = buildStateChanges(attempted, live).filter((change) => sent.has(token(change)));
    return followUp.length ? {changes, followUp} : {changes};
}

export function recoveryChanges(server: TeamState, pending: Pending) {
    const changes = new Map(pending.changes.map((change) => [token(change), change]));
    for (const change of pending.followUp ?? []) {
        const {key, id, before} = change;
        // 只有快照证明上一笔意图已落盘，才把后续编辑基于该值提交。
        if (sameJson(server[key]?.find((row) => row.id === id), before)) changes.set(token(change), change);
    }
    return [...changes.values()];
}

function validChanges(changes: StateChange[]) {
    if (!Array.isArray(changes)) return false;
    const ids = new Set<string>();
    for (const change of changes) {
        if (!change || !teamStateKeys.includes(change.key) || typeof change.id !== "string" || !change.id) return false;
        const {id, before, after} = change;
        if ((before === null && after === null) ||
            (before !== null && (!hasRecordId(before) || before.id !== id)) ||
            (after !== null && (!hasRecordId(after) || after.id !== id))) return false;
        const key = token(change);
        if (ids.has(key)) return false;
        ids.add(key);
    }
    return true;
}

export function parseRecovery(raw: string, now = Date.now()): Recovery | null {
    const saved = JSON.parse(raw) as Recovery | null;
    if (!saved || typeof saved.actorId !== "string" || typeof saved.savedAt !== "string" || !validChanges(saved.changes)) return null;
    if (saved.followUp !== undefined && !validChanges(saved.followUp)) return null;
    const time = Date.parse(saved.savedAt);
    return Number.isFinite(time) && now - time <= 48 * 3600 * 1000 ? saved : null;
}
