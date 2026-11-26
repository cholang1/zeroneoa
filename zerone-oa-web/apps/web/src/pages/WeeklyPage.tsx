import {OaPicker} from "../shared/ui/OaPicker";
import {DailyReport, SessionUser, TeamState, WeeklyPlanItem} from "@oa/contracts";
import {ViewMode} from "../app/navigation";
import {WeekPicker} from "../features/worklog/WeekPicker";
import {DayThreadAction, ThreadHighlight} from "../features/worklog/model";
import {PersonWeekBoard} from "../features/worklog/PersonWeekBoard";

export function WeeklyPage({
                               state,
                               user,
                               viewMode,
                               setViewMode,
                               pickedDate,
                               setPickedDate,
                               weekId,
                               onAddPlan,
                               onUpdatePlan,
                               onDeletePlan,
                               onSubmitReports,
                               onUpdateReport,
                               onDeleteReport,
                               onDayThread,
                               threadHighlight,
                               focusedReportId
                           }: {
    state: TeamState;
    user: SessionUser;
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    pickedDate: string;
    setPickedDate: (date: string) => void;
    weekId: string;
    onAddPlan: (ownerId: string, taskId: string, detail: string) => void;
    onUpdatePlan: (planId: string, patch: Partial<WeeklyPlanItem>) => void;
    onDeletePlan: (planId: string) => void;
    onSubmitReports: (
        ownerId: string,
        rows: Array<{ date: string; taskId: string; detail: string; hours: number; notes: string }>
    ) => void;
    onUpdateReport: (reportId: string, patch: Partial<DailyReport>) => void;
    onDeleteReport: (reportId: string) => void;
    onDayThread: (ownerId: string, date: string, action: DayThreadAction) => void;
    threadHighlight: ThreadHighlight | null;
    focusedReportId?: string;
}) {
    // Everyone can view everyone's board — no visibility rules in this demo.
    const activeMembers = state.users;
    const visibleUsers =
        viewMode === "mine"
            ? state.users.filter((candidate) => candidate.id === user.id)
            : viewMode === "all"
                ? activeMembers
                : state.users.filter((candidate) => candidate.id === viewMode);

    return (
        <div className="page-stack">
            <div className="page-header">
                <h2>工作内容</h2>
            </div>

            <div className="cockpit-controls weekly-sticky">
                <WeekPicker pickedDate={pickedDate} onPickedDateChange={setPickedDate} state={state}/>
                <div className="compact-label inline">
                    视图
                    <OaPicker name="视图" value={viewMode} onPick={setViewMode}
                              search={activeMembers.length >= 8 ? "搜索成员姓名" : undefined}
                              options={[
                                  {value: "mine", label: "只看我（默认）"}, {value: "all", label: "所有人"},
                                  ...activeMembers.map(member => ({value: member.id, group: "成员",
                                      label: member.name + (member.id === user.id ? "（我）" : "")}))
                              ]}/>
                </div>
            </div>

            <div className="weekly-grid">
                {visibleUsers.map((owner) => (
                    <PersonWeekBoard
                        key={owner.id}
                        owner={owner}
                        user={user}
                        state={state}
                        weekId={weekId}
                        pickedDate={pickedDate}
                        onAddPlan={onAddPlan}
                        onUpdatePlan={onUpdatePlan}
                        onDeletePlan={onDeletePlan}
                        onSubmitReports={onSubmitReports}
                        onUpdateReport={onUpdateReport}
                        onDeleteReport={onDeleteReport}
                        onDayThread={onDayThread}
                        threadHighlight={threadHighlight}
                        focusedReportId={focusedReportId}
                    />
                ))}
            </div>
        </div>
    );
}
