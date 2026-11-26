import {clientLog} from "../../shared/clientLog";
import {TeamState} from "@oa/contracts";
import {downloadBlob, findUser, toCsv, todayIso} from "../../shared/utils";
import {appError} from "../../shared/error";
import {ExportKind, ExportRange, exportSince, sliceStateSince} from "./exports";
import {TeamSync} from "../../sync/useTeamSync";
import {hasRecordId, sameJson, teamStateKeys} from "../../sync/merge";

export function prepareImportedState(value: unknown, current: TeamState): TeamState {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("文件结构不符合 TeamState");
    }
    const file = value as Record<string, unknown>;
    const next = {...current};
    for (const key of teamStateKeys) {
        // 旧导出可能没有可选列表；缺省不等于明确清空。
        if ((key === "events" || key === "dayThreads") && !Object.hasOwn(file, key)) continue;
        const rows = file[key];
        if (!Array.isArray(rows) || !rows.every(hasRecordId) || new Set(rows.map((row) => row.id)).size !== rows.length) {
            throw new Error(`文件中的 ${key} 应为具有唯一业务 ID 的记录列表`);
        }
        Object.assign(next, {[key]: rows});
    }
    if (Object.keys(file).some(k => /^(auth_accounts|auth_sessions|accounts|sessions|passwordHash)$/i.test(k))) {
        throw new Error('业务导入文件不能包含账号或会话数据');
    }
    const original = new Map(current.users.map(row => [row.id, row]));
    const incoming = new Map(next.users.map(row => [row.id, row]));
    const mismatches = Array.from(new Set([...original.keys(), ...incoming.keys()])).filter(id => !sameJson(original.get(id), incoming.get(id)));
    if (mismatches.length) throw new Error(`导入不能变更成员身份，请先核对成员：${mismatches.slice(0, 5).join('、')}`);
    // 账号绑定与已记录的操作历史不是可还原的业务快照。
    return {...next, users: current.users, auditLog: current.auditLog};
}

export function dataActions({
                                state,
                                stateRef,
                                user, api, isActive,
                                persist
                            }: Pick<TeamSync, "state" | "stateRef" | "user" | "persist" | "api" | "isActive">, importRef: React.RefObject<HTMLInputElement | null>) {
    function handleExport(kind: ExportKind, range: ExportRange) {
        const today = todayIso();
        const since = exportSince(range);
        const data = sliceStateSince(state, since);
        const stamp = since ? `${since}_${today}` : today;
        if (kind === "json") {
            downloadBlob(
                since ? `oa-data-${stamp}.json` : `oa-team-state-${stamp}.json`,
                JSON.stringify(data, null, 2),
                "application/json"
            );
            return;
        }
        const nameOf = (id?: string) => findUser(data.users, id ?? "")?.name ?? id ?? "";
        const files = [
            {name: `tasks-${stamp}.csv`, rows: data.tasks},
            {name: `weekly-plans-${stamp}.csv`, rows: data.weeklyPlans},
            {name: `daily-reports-${stamp}.csv`, rows: data.dailyReports},
            {
                name: `day-feedback-${stamp}.csv`,
                rows: (data.dayThreads ?? []).flatMap((thread) =>
                    (thread.comments ?? []).map((comment) => ({
                        reportDate: thread.date,
                        reportOwner: nameOf(thread.ownerId),
                        author: nameOf(comment.authorId),
                        text: comment.text,
                        createdAt: comment.createdAt
                    }))
                )
            },
            {name: `memos-${stamp}.csv`, rows: data.memos},
            {
                name: `issues-${stamp}.csv`,
                rows: data.dailyReports.filter((r) => r.notes?.trim()).map((r) => ({
                    id: r.id,
                    date: r.date,
                    weekId: r.weekId,
                    owner: nameOf(r.ownerId),
                    taskId: r.taskId,
                    notes: r.notes,
                    resolved: r.resolved ? "yes" : "no",
                    solution: r.solution ?? "",
                    resolvedBy: r.resolvedById ? nameOf(r.resolvedById) : "",
                    resolvedAt: r.resolvedAt ?? ""
                }))
            },
            {name: `users-${stamp}.csv`, rows: data.users}
        ];
        files.forEach((file) => {
            if (!file.rows.length) return;
            downloadBlob(file.name, toCsv(file.rows as Array<Record<string, unknown>>), "text/csv");
        });
        if (!files.some((f) => f.rows.length)) {
            window.alert("当前没有可导出的数据。");
        }
    }

    function handleImport() {
        importRef.current?.click();
    }

    function onImportFile(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            if (!isActive()) return;
            try {
                const data = prepareImportedState(JSON.parse(String(reader.result)), stateRef.current);
                if (!window.confirm("将替换当前页面中已有的数据；导入列表中缺少的记录将删除。确认继续吗？")) return;
                clientLog(
                    "import_json",
                    {fileName: file.name, reports: data.dailyReports?.length ?? 0},
                    api ? {api, actorId: user?.id, actorName: user?.name} : undefined
                );
                persist(data);
            } catch (error) {
                window.alert(`导入失败：${appError(error)}`);
            } finally {
                if (importRef.current) importRef.current.value = "";
            }
        };
        reader.readAsText(file);
    }

    return {handleExport, handleImport, onImportFile};
}
