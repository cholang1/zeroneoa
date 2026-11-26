import {TeamState} from "@oa/contracts";
import {findUser} from "../shared/utils";
import {childrenOf} from "../features/tasks/tree";
import {Panel} from "../shared/ui/Panel";

export function DataPage({state}: { state: TeamState }) {
    const topTasks = childrenOf(state.tasks, null);
    return (
        <div className="page-stack">
            <div className="page-header">
                <h2>数据</h2>
            </div>
            <Panel title="数据规则">
                <div className="rule-grid">
                    <div>
                        <strong>任务树</strong>
                        <p>只维护ID、父任务、名称、说明。计划与日报只引用任务ID。</p>
                    </div>
                    <div>
                        <strong>计划详情</strong>
                        <p>每条独立完成。勾选一条不代表整个任务ID完成。</p>
                    </div>
                    <div>
                        <strong>日报</strong>
                        <p>「本周完成」唯一来源。没有日报，就没有有效贡献。</p>
                    </div>
                    <div>
                        <strong>问题</strong>
                        <p>日报「问题/注意」自动汇入问题页，可标记解决方案。</p>
                    </div>
                </div>
            </Panel>

            <Panel title="一级任务">
                <div className="root-task-grid">
                    {topTasks.map((task) => (
                        <article key={task.id}>
                            <span className="task-code">{task.id}</span>
                            <h4>{task.title}</h4>
                            <p>{task.description}</p>
                        </article>
                    ))}
                </div>
            </Panel>

            <Panel title="操作记录" kicker="最近 30 条">
                <div className="audit-list">
                    {state.auditLog
                        .slice(-30)
                        .reverse()
                        .map((event) => (
                            <div key={event.id}>
                                <span>{event.createdAt.slice(0, 16).replace("T", " ")}</span>
                                <strong>{findUser(state.users, event.actorId)?.name ?? event.actorId}</strong>
                                <p>{event.action}</p>
                            </div>
                        ))}
                </div>
            </Panel>
        </div>
    );
}
