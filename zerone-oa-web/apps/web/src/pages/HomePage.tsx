import {useState} from "react";
import {CalendarEvent, Memo, SessionUser, TaskNode, TeamState} from "@oa/contracts";
import {MetricStrip} from "../shared/ui/Metrics";
import {TaskTree} from "../features/tasks/TaskTree";
import {MemoTable} from "../features/memos/MemoTable";
import {AiPanel} from "../features/reminders/AiPanel";
import {MentionBanner} from "../features/mentions/MentionBanner";
import {CalendarPanel} from "../features/calendar/CalendarPanel";
import {TaskDetailPanel} from "../features/tasks/TaskDetailPanel";
import {WeekPicker} from "../features/worklog/WeekPicker";

export function HomePage(props: {
    state: TeamState;
    user: SessionUser;
    pickedDate: string;
    setPickedDate: (date: string) => void;
    weekId: string;
    onAddTask: (parentId: string | null, title: string, description: string) => void;
    onUpdateTask: (taskId: string, patch: Partial<TaskNode>) => void;
    onDeleteTask: (taskId: string) => void;
    onAddMemo: (
        scope: "weekly" | "longTerm",
        text: string,
        weekId: string,
        options: Pick<Memo, "color" | "mentionAll" | "mentionUserIds">
    ) => void;
    onUpdateMemo: (id: string, patch: Partial<Memo>) => void;
    onDeleteMemo: (id: string) => void;
    onGenerateAi: () => void;
    onClearAi: () => void;
    onDismissAi: (id: string) => void;
    onAddEvent: (
        input: Omit<CalendarEvent, "id" | "createdById" | "updatedById" | "createdAt" | "updatedAt">
    ) => void;
    onUpdateEvent: (id: string, patch: Partial<CalendarEvent>) => void;
    onDeleteEvent: (id: string) => void;
    onDismissMention: (
        kind: "event" | "memo",
        id: string,
        key: string,
        field: "read" | "done",
        value: boolean
    ) => void;
}) {
    const {
        state,
        user,
        pickedDate,
        setPickedDate,
        weekId,
        onAddTask,
        onUpdateTask,
        onDeleteTask,
        onAddMemo,
        onUpdateMemo,
        onDeleteMemo,
        onGenerateAi,
        onClearAi,
        onDismissAi,
        onAddEvent,
        onUpdateEvent,
        onDeleteEvent,
        onDismissMention
    } = props;
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

    return (
        <div className="page-stack">
            <div className="page-header">
                <h2>总览</h2>
                <WeekPicker pickedDate={pickedDate} onPickedDateChange={setPickedDate} state={state}/>
            </div>
            <MentionBanner state={state} user={user} onSetMention={onDismissMention}/>
            <MetricStrip state={state} weekId={weekId} user={user}/>
            <CalendarPanel
                state={state}
                user={user}
                pickedDate={pickedDate}
                onAddEvent={onAddEvent}
                onUpdateEvent={onUpdateEvent}
                onDeleteEvent={onDeleteEvent}
            />
            <div className="home-layout">
                <TaskTree
                    tasks={state.tasks}
                    user={user}
                    onAddTask={onAddTask}
                    onUpdateTask={onUpdateTask}
                    onDeleteTask={onDeleteTask}
                    onSelectTask={setSelectedTaskId}
                    selectedTaskId={selectedTaskId}
                />
                <div className="right-rail">
                    {selectedTaskId ? (
                        <TaskDetailPanel
                            state={state}
                            taskId={selectedTaskId}
                            onClose={() => setSelectedTaskId(null)}
                        />
                    ) : (
                        <>
                            <MemoTable
                                memos={state.memos}
                                users={state.users}
                                user={user}
                                weekId={weekId}
                                onAddMemo={onAddMemo}
                                onUpdateMemo={onUpdateMemo}
                                onDeleteMemo={onDeleteMemo}
                            />
                            <AiPanel
                                reminders={state.aiReminders}
                                users={state.users}
                                user={user}
                                weekId={weekId}
                                onGenerate={onGenerateAi}
                                onClear={onClearAi}
                                onDismiss={onDismissAi}
                            />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
