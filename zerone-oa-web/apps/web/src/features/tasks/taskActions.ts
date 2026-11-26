import {TaskNode} from "@oa/contracts";
import {findTask, nowIso} from "../../shared/utils";
import {descendantIds, nextChildId} from "./tree";
import {TeamSync} from "../../sync/useTeamSync";

export function taskActions({
                                user,
                                stateRef,
                                persist,
                                withAudit
                            }: Pick<TeamSync, "user" | "stateRef" | "persist" | "withAudit">) {
    function addTask(parentId: string | null, title: string, description: string) {
        if (!user) return;
        const current = stateRef.current;
        const parent = parentId ? findTask(current.tasks, parentId) ?? null : null;
        const id = nextChildId(current.tasks, parent);
        const level = parent ? Math.min(parent.level + 1, 3) : 1;
        const orderBase = parent ? parent.order * 100 : 1;
        const siblings = current.tasks.filter((t) => t.parentId === (parent ? parent.id : null));
        const next: TaskNode = {
            id,
            parentId: parent ? parent.id : null,
            title,
            description,
            ownerId: user.id,
            status: "active",
            level: level as 1 | 2 | 3,
            order: orderBase + siblings.length + 1,
            createdById: user.id,
            createdAt: nowIso()
        };
        persist(withAudit({...current, tasks: [...current.tasks, next]}, `added task ${id}`, "task", id));
    }

    function updateTask(taskId: string, patch: Partial<TaskNode>) {
        const current = stateRef.current;
        persist(
            withAudit(
                {
                    ...current,
                    tasks: current.tasks.map((t) => (t.id === taskId ? {...t, ...patch} : t))
                },
                `updated task ${taskId}`,
                "task",
                taskId
            )
        );
    }

    function deleteTask(taskId: string) {
        const current = stateRef.current;
        const idsToRemove = new Set(descendantIds(current.tasks, taskId));
        persist(
            withAudit(
                {
                    ...current,
                    tasks: current.tasks.filter((t) => !idsToRemove.has(t.id))
                },
                `deleted task ${taskId} (${idsToRemove.size} nodes)`,
                "task",
                taskId
            )
        );
    }

    return {addTask, updateTask, deleteTask};
}
