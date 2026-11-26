import {AiReminder, SessionUser, User} from "@oa/contracts";
import {findUser, todayIso} from "../../shared/utils";
import {Panel} from "../../shared/ui/Panel";

export function AiPanel({
                            reminders,
                            users,
                            user,
                            weekId,
                            onGenerate,
                            onClear,
                            onDismiss
                        }: {
    reminders: AiReminder[];
    users: User[];
    user: SessionUser;
    weekId: string;
    onGenerate: () => void;
    onClear: () => void;
    onDismiss: (id: string) => void;
}) {
    const today = todayIso();
    const filtered = reminders.filter(
        (r) =>
            (!r.weekId || r.weekId === weekId) &&
            (!r.date || r.date >= today) &&
            !(r.dismissedByIds ?? []).includes(user.id)
    );
    return (
        <Panel
            title={`AI 提醒 · ${weekId}`}
            actions={
                <div className="panel-actions">
                    <button className="compact-action" onClick={onGenerate}>
                        生成
                    </button>
                    <button
                        className="text-button mini"
                        onClick={() => {
                            if (!reminders.length) return;
                            if (window.confirm("清空所有 AI 提醒？")) onClear();
                        }}
                    >
                        清空
                    </button>
                </div>
            }
        >
            <div className="reminder-list">
                {filtered.length ? (
                    filtered.slice(0, 8).map((reminder) => {
                        const owner = reminder.ownerId ? findUser(users, reminder.ownerId) : undefined;
                        return (
                            <article key={reminder.id} className={`reminder ${reminder.severity}`}>
                                <div className="reminder-head">
                                    <strong>
                                        {owner ? `${owner.name} · ` : ""}
                                        {reminder.summary}
                                    </strong>
                                    <button className="text-button mini" onClick={() => onDismiss(reminder.id)}>
                                        忽略
                                    </button>
                                </div>
                                <ul>
                                    {reminder.actions.slice(0, 3).map((action, index) => (
                                        <li key={`${reminder.id}-${index}`}>{action}</li>
                                    ))}
                                </ul>
                            </article>
                        );
                    })
                ) : (
                    <p className="empty">{weekId} 还没有提醒。点「生成」让 AI 扫描该周的日报、计划与阻塞。</p>
                )}
            </div>
        </Panel>
    );
}
