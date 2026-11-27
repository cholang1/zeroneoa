import {useMemo} from "react";
import {TaskNode} from "@oa/contracts";
import {OaPicker} from "../../shared/ui/OaPicker";

function taskLabel(task: TaskNode, indent = false) {
    return <span className="oa-picker-task" style={indent ? {paddingLeft: `${(task.level - 1) * .85}rem`} : undefined}>
        <span className="task-code small">{task.id}</span><span className="trim">{task.title}</span>
    </span>;
}

export function TaskSelectInline({tasks, value, onChange, leafOnly = false}: {
    tasks: TaskNode[]; value: string; onChange: (value: string) => void; leafOnly?: boolean;
}) {
    const options = useMemo(() => tasks.filter(task => !leafOnly || task.level === 3)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map(task => ({
            value: task.id, label: `${task.id} ${task.title}`, keywords: task.description,
            content: taskLabel(task, true)
        })), [tasks, leafOnly]);
    const current = tasks.find(task => task.id === value);
    return <OaPicker name="选择任务" options={options} value={value} onPick={onChange} minWidth={280}
                     triggerClass="inline-task-select-btn"
                     summary={current ? `${current.id} ${current.title}` : "选择任务"}
                     triggerContent={current && taskLabel(current)}
                     search={leafOnly ? "搜索三级任务编号或关键词" : "搜索任务编号或关键词"}
                     empty="无匹配任务"/>;
}
