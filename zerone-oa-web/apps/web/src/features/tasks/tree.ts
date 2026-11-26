import {TaskNode} from "@oa/contracts";

export function childrenOf(tasks: TaskNode[], parentId: string | null) {
    return tasks
        .filter((task) => task.parentId === parentId)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function descendantIds(tasks: TaskNode[], rootId: string): string[] {
    const out: string[] = [];
    const queue = [rootId];
    while (queue.length) {
        const id = queue.shift()!;
        out.push(id);
        tasks.filter((t) => t.parentId === id).forEach((child) => queue.push(child.id));
    }
    return out;
}

export function nextChildId(tasks: TaskNode[], parent: TaskNode | null): string {
    if (!parent) {
        const roots = tasks.filter((t) => t.parentId === null);
        const usedNumbers = roots
            .map((t) => Number(t.id.replace(/^T0?/, "")))
            .filter((n) => !Number.isNaN(n));
        const next = (usedNumbers.length ? Math.max(...usedNumbers) : 0) + 1;
        return `T${String(next).padStart(2, "0")}`;
    }
    const siblings = tasks.filter((t) => t.parentId === parent.id);
    const sep = parent.level >= 3 ? "-" : ".";
    const used = siblings.map((s) => {
        const tail = s.id.slice(parent.id.length + 1);
        const num = Number(tail.split(/[-.]/)[0]);
        return Number.isNaN(num) ? 0 : num;
    });
    const next = (used.length ? Math.max(...used) : 0) + 1;
    return `${parent.id}${sep}${next}`;
}
