import type {TeamApi} from "./api";

export type ClientLogEvent = {
    ts: string;
    event: string;
    [key: string]: unknown;
};

const STORAGE_KEY = "oa-client-log";
const MAX_EVENTS = 300;
let buffer: ClientLogEvent[] = [];

export function clientLog(
    event: string,
    data: Record<string, unknown> = {},
    remote?: { api: TeamApi; actorId?: string; actorName?: string }
) {
    const entry: ClientLogEvent = {ts: new Date().toISOString(), event, ...data};
    console.info(`[oa] ${event}`, data);
    buffer.push(entry);
    if (buffer.length > MAX_EVENTS) buffer.shift();
    remote?.api.sendClientLog([entry], remote.actorId, remote.actorName);
}

export function clearClientLog() {
    buffer = [];
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 旧记录不会再读取。
    }
}

export function exportClientLogText(): string {
    return JSON.stringify(buffer, null, 2);
}
