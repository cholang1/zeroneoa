import {useEffect, useMemo, useRef, useState} from "react";
import {SessionUser, TaskNode} from "@oa/contracts";
import {childrenOf, descendantIds, nextChildId} from "./tree";
import {Panel} from "../../shared/ui/Panel";

export type TreeMode =
    | { kind: "idle" }
    | { kind: "edit"; nodeId: string }
    | { kind: "add-child"; parentId: string }
    | { kind: "add-root" };

export function TaskTree({
                             tasks,
                             user,
                             onAddTask,
                             onUpdateTask,
                             onDeleteTask,
                             onSelectTask,
                             selectedTaskId
                         }: {
    tasks: TaskNode[];
    user: SessionUser;
    onAddTask: (parentId: string | null, title: string, description: string) => void;
    onUpdateTask: (taskId: string, patch: Partial<TaskNode>) => void;
    onDeleteTask: (taskId: string) => void;
    onSelectTask?: (taskId: string | null) => void;
    selectedTaskId?: string | null;
}) {
    const [mode, setMode] = useState<TreeMode>({kind: "idle"});
    const [open, setOpen] = useState<Record<string, boolean>>(() => {
        const init: Record<string, boolean> = {};
        const firstRoot = tasks
            .filter((t) => t.parentId === null)
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
        if (firstRoot) init[firstRoot.id] = true;
        return init;
    });
    const [filter, setFilter] = useState("");

    const filteredIds = useMemo(() => {
        if (!filter.trim()) return null;
        const q = filter.trim().toLowerCase();
        const matches = new Set<string>();
        tasks.forEach((t) => {
            if (`${t.id} ${t.title} ${t.description}`.toLowerCase().includes(q)) {
                matches.add(t.id);
                let cur: string | null = t.parentId;
                while (cur) {
                    matches.add(cur);
                    const parent = tasks.find((x) => x.id === cur);
                    cur = parent?.parentId ?? null;
                }
            }
        });
        return matches;
    }, [filter, tasks]);

    function isVisible(id: string) {
        return filteredIds === null || filteredIds.has(id);
    }

    function renderNode(task: TaskNode) {
        if (!isVisible(task.id)) return null;
        const kids = childrenOf(tasks, task.id);
        // default-expand level 1; collapse level 2 (so level 3 hidden) unless filter is on
        // Only default-expand a node if it was explicitly opened (e.g., the first
        // root task at boot, or whatever the user clicked). Everything else stays
        // collapsed so the tree opens with a tight overview.
        const expanded = filter ? true : open[task.id] ?? false;

        if (mode.kind === "edit" && mode.nodeId === task.id) {
            return (
                <TreeEditRow
                    key={task.id}
                    task={task}
                    onSave={(patch) => {
                        onUpdateTask(task.id, patch);
                        setMode({kind: "idle"});
                    }}
                    onCancel={() => setMode({kind: "idle"})}
                />
            );
        }

        const isSelected = selectedTaskId === task.id;
        return (
            <div
                key={task.id}
                className={`tree-node depth-${task.level}${isSelected ? " selected" : ""}`}
            >
                <div className="tree-row">
                    <button
                        className="tree-toggle-btn"
                        onClick={() => setOpen((prev) => ({...prev, [task.id]: !expanded}))}
                        aria-label="展开/收起"
                    >
                        {kids.length ? (expanded ? "▾" : "▸") : "·"}
                    </button>
                    <span className="task-code">{task.id}</span>
                    <div className="tree-main">
                        <strong>{task.title}</strong>
                        {task.description ? <small>{task.description}</small> : null}
                    </div>
                    <div className="tree-actions">
                        {onSelectTask ? (
                            <button
                                className="icon-btn"
                                title="贡献详情"
                                onClick={() => onSelectTask(isSelected ? null : task.id)}
                            >
                                📊
                            </button>
                        ) : null}
                        {task.level < 3 ? (
                            <button
                                className="icon-btn"
                                title="添加子任务"
                                onClick={() => {
                                    setOpen((prev) => ({...prev, [task.id]: true}));
                                    setMode({kind: "add-child", parentId: task.id});
                                }}
                            >
                                ＋
                            </button>
                        ) : null}
                        <button
                            className="icon-btn"
                            title="编辑"
                            onClick={() => setMode({kind: "edit", nodeId: task.id})}
                        >
                            ✎
                        </button>
                        <button
                            className="icon-btn danger"
                            title="删除（含子任务）"
                            onClick={() => {
                                const desc = descendantIds(tasks, task.id);
                                const msg =
                                    desc.length > 1
                                        ? `确认删除 ${task.id}（含 ${desc.length - 1} 个子任务）？`
                                        : `确认删除 ${task.id}？`;
                                if (window.confirm(msg)) onDeleteTask(task.id);
                            }}
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {expanded && (kids.length || (mode.kind === "add-child" && mode.parentId === task.id)) ? (
                    <div className="tree-children">
                        {kids.map(renderNode)}
                        {mode.kind === "add-child" && mode.parentId === task.id ? (
                            <TreeAddRow
                                placeholderId={nextChildId(tasks, task)}
                                onSave={(title, description) => {
                                    onAddTask(task.id, title, description);
                                    setMode({kind: "idle"});
                                }}
                                onCancel={() => setMode({kind: "idle"})}
                            />
                        ) : null}
                    </div>
                ) : null}
            </div>
        );
    }

    const roots = childrenOf(tasks, null);

    return (
        <Panel
            title="任务树"
            actions={
                <div className="panel-actions">
                    <input
                        className="filter-input"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        placeholder="ID / 关键字"
                    />
                    <button className="compact-action" onClick={() => setMode({kind: "add-root"})}>
                        ＋ 一级
                    </button>
                </div>
            }
        >
            <div className="tree">
                {roots.map(renderNode)}
                {mode.kind === "add-root" ? (
                    <TreeAddRow
                        placeholderId={nextChildId(tasks, null)}
                        level={1}
                        onSave={(title, description) => {
                            onAddTask(null, title, description);
                            setMode({kind: "idle"});
                        }}
                        onCancel={() => setMode({kind: "idle"})}
                    />
                ) : null}
            </div>
            <p className="tree-hint">
                点 ＋ 添加子任务（最多三级）。点击节点折叠/展开。当前操作者：
                <strong style={{color: user.color}}> {user.name}</strong>
            </p>
        </Panel>
    );
}

export function TreeAddRow({
                               placeholderId,
                               level = 0,
                               onSave,
                               onCancel
                           }: {
    placeholderId: string;
    level?: number;
    onSave: (title: string, description: string) => void;
    onCancel: () => void;
}) {
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const titleRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        titleRef.current?.focus();
    }, []);

    function commit() {
        if (!title.trim()) return;
        onSave(title.trim(), description.trim());
    }

    return (
        <div className={`tree-add-row level-${level}`}>
            <span className="task-code placeholder">{placeholderId}</span>
            <div className="tree-add-fields">
                <input
                    ref={titleRef}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") commit();
                        if (event.key === "Escape") onCancel();
                    }}
                    placeholder="任务标题（必填）"
                />
                <input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") commit();
                        if (event.key === "Escape") onCancel();
                    }}
                    placeholder="任务说明 / 验收口径（可选）"
                />
            </div>
            <div className="tree-add-actions">
                <button className="icon-btn primary" title="保存" onClick={commit}>
                    ✓
                </button>
                <button className="icon-btn" title="取消" onClick={onCancel}>
                    ✕
                </button>
            </div>
        </div>
    );
}

export function TreeEditRow({
                                task,
                                onSave,
                                onCancel
                            }: {
    task: TaskNode;
    onSave: (patch: Partial<TaskNode>) => void;
    onCancel: () => void;
}) {
    const [title, setTitle] = useState(task.title);
    const [description, setDescription] = useState(task.description);

    function commit() {
        if (!title.trim()) return;
        onSave({title: title.trim(), description: description.trim()});
    }

    return (
        <div className={`tree-node depth-${task.level} editing`}>
            <div className="tree-row">
                <span className="tree-toggle-btn">·</span>
                <span className="task-code">{task.id}</span>
                <div className="tree-add-fields">
                    <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") commit();
                            if (event.key === "Escape") onCancel();
                        }}
                        autoFocus
                    />
                    <input
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") commit();
                            if (event.key === "Escape") onCancel();
                        }}
                    />
                </div>
                <div className="tree-actions">
                    <button className="icon-btn primary" title="保存" onClick={commit}>
                        ✓
                    </button>
                    <button className="icon-btn" title="取消" onClick={onCancel}>
                        ✕
                    </button>
                </div>
            </div>
        </div>
    );
}
