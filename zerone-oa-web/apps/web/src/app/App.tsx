import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {DailyReport, SessionUser} from "@oa/contracts";
import {ApiError, type TeamApi} from "../shared/api";
import {sameJson} from "../sync/merge";
import {exportClientLogText} from "../shared/clientLog";
import {dateToWeekId, downloadBlob, todayIso} from "../shared/utils";
import {Page, ViewMode} from "./navigation";
import {ExportDialog} from "../features/data-tools/ExportDialog";
import {LoginScreen, PasswordChangeScreen} from "../features/session/LoginScreen";
import {MembersPage} from "../features/members/MembersPage";
import {TopShell} from "./TopShell";
import {HomePage} from "../pages/HomePage";
import {WeeklyPage} from "../pages/WeeklyPage";
import {IssuesPage} from "../features/issues/IssuesPage";
import {StatsPage} from "../features/stats/StatsPage";
import {DataPage} from "../pages/DataPage";
import {useTeamSync, type TeamSync} from "../sync/useTeamSync";
import {useMentionNotifications} from "../features/mentions/useMentionNotifications";
import {taskActions} from "../features/tasks/taskActions";
import {memoActions} from "../features/memos/memoActions";
import {workActions} from "../features/worklog/workActions";
import {threadActions} from "../features/worklog/threadActions";
import {eventActions} from "../features/calendar/eventActions";
import {reminderActions} from "../features/reminders/reminderActions";
import {mentionActions} from "../features/mentions/mentionActions";
import {dataActions} from "../features/data-tools/dataActions";
import {ZeroAiPage} from "../features/zero-ai/ZeroAiPage";

export default function App() {
    const team = useTeamSync();
    const {authSession, authBusy, notice, user, api, loading, loadError, workspaceId} = team;
    const [changePasswordFor, setChangePasswordFor] = useState<number>();

    if (loading || (authSession && !authSession.mustChangePassword && !user && !loadError)) {
        return (
            <main className="loading-screen" role="status">
                <div className="loader" aria-hidden="true"/>
                <p>正在连接工作台...</p>
            </main>
        );
    }
    if (loadError) {
        return (
            <main className="login-page">
                <section className="login-card">
                    <h1>无法继续</h1>
                    <p role="alert" className="form-error">{loadError}</p>
                    <button type="button" className="primary-action" onClick={() => window.location.reload()}>重新加载
                    </button>
                    {authSession ? (
                        <button type="button" className="secondary-action" onClick={() => void team.signOut()}
                                disabled={authBusy}>
                            退出登录
                        </button>
                    ) : null}
                </section>
            </main>
        );
    }
    if (!authSession) return <LoginScreen onLogin={team.signIn} onRegister={team.setUpFirstAdmin}
                                          notice={notice} busy={authBusy}/>;

    const required = authSession.mustChangePassword;
    const showPasswordForm = required || (workspaceId !== undefined && changePasswordFor === workspaceId);
    return (
        <>
            {showPasswordForm ? (
                <PasswordChangeScreen key={required ? "required" : workspaceId} required={required} busy={authBusy}
                                      onChange={team.updatePassword} onLogout={() => void team.signOut()}
                                      onCancel={() => setChangePasswordFor(undefined)}/>
            ) : null}
            {user && api ? (
                <div hidden={showPasswordForm}>
                    <Workspace key={workspaceId} team={team} user={user} api={api} suspended={showPasswordForm}
                               onChangePassword={() => setChangePasswordFor(workspaceId)}/>
                </div>
            ) : null}
        </>
    );
}

function Workspace({team, user, api, suspended, onChangePassword}: {
    team: TeamSync;
    user: SessionUser;
    api: TeamApi;
    suspended: boolean;
    onChangePassword: () => void;
}) {
    const {state, saving, authSession} = team;
    const canManageMembers = !suspended && authSession?.isAccountAdmin === true;
    const [page, setPage] = useState<Page>("home");
    const [openedZeroAi, setOpenedZeroAi] = useState(false);
    const pageScrollRef = useRef<Partial<Record<Page, number>>>({});
    const sourceAllowed = useRef(false);
    const [reportTarget, setReportTarget] = useState<{ report: DailyReport; version: number } | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>("mine");
    const [pickedDate, setPickedDate] = useState(todayIso());
    const weekId = dateToWeekId(pickedDate);

    useLayoutEffect(() => {
        sourceAllowed.current = page === "zeroAi" && !suspended;
        return () => {
            sourceAllowed.current = false;
        };
    }, [page, suspended]);

    // 切回普通页面时恢复原滚动位置；日报引用由目标行接管滚动。
    function changePage(next: Page, target: typeof reportTarget = null) {
        if (next === page || (next === "members" && !canManageMembers)) return;
        sourceAllowed.current = false;
        pageScrollRef.current[page] = window.scrollY;
        if (next === "zeroAi") setOpenedZeroAi(true);
        setReportTarget(target);
        setPage(next);
    }

    useEffect(() => {
        if (page === "weekly" && reportTarget) return;
        const y = pageScrollRef.current[page] ?? 0;
        const raf = requestAnimationFrame(() => window.scrollTo(0, y));
        return () => cancelAnimationFrame(raf);
    }, [page, reportTarget]);

    const reportFocus = reportTarget && reportTarget.version === state.version &&
    reportTarget.report.date === pickedDate &&
    (viewMode === "mine" ? user.id : viewMode) === reportTarget.report.ownerId &&
    state.dailyReports.some(report => sameJson(report, reportTarget.report)) ? reportTarget.report.id : undefined;

    async function openReportSource(sessionId: string, messageId: string, id: string, version: number, signal: AbortSignal) {
        const unavailable = "无法定位原日报。请重新查询后再试。";
        const changed = "来源数据版本已变化，请重新查询后再打开。";
        if (!sourceAllowed.current || signal.aborted || !team.isActive()) return;
        try {
            const verified = await api.zeroAi.verifyReportRef(user.id, sessionId, messageId, id, signal);
            if (!sourceAllowed.current || signal.aborted || !team.isActive()) return;
            if (verified?.id !== id) return unavailable;
            if (verified.teamVersion !== version) return changed;
            // 只有服务端确认的原引用和干净、同版本的工作台快照才能用于导航。
            const snapshot = team.stateForReference(verified.teamVersion);
            if (!snapshot) return team.stateRef.current.version === version
                ? "工作台有待同步的更改，请同步后再打开原日报。"
                : "工作台与来源版本不同步，请刷新数据或重新查询。";
            const matches = snapshot.dailyReports.filter(report => report.id === verified.id);
            const report = matches[0];
            if (!report || matches.length !== 1 || !snapshot.users.some(member => member.id === report.ownerId) ||
                !/^\d{4}-\d{2}-\d{2}$/.test(report.date) || dateToWeekId(report.date) !== report.weekId) return unavailable;
            setViewMode(report.ownerId === user.id ? "mine" : report.ownerId);
            setPickedDate(report.date);
            changePage("weekly", {report, version});
        } catch (error) {
            if (!sourceAllowed.current || signal.aborted || !team.isActive()) return;
            if (error instanceof ApiError) {
                if (error.status === 409) return changed;
                if (error.status === 403 || error.status === 404) return unavailable;
            }
            return "暂时无法核对日报，请稍后再打开。";
        }
    }

    const importRef = useRef<HTMLInputElement>(null);
    const [exportOpen, setExportOpen] = useState(false);
    const {
        feedbackThreads,
        threadHighlight,
        setThreadHighlight,
        mentionToast,
        setMentionToast
    } = useMentionNotifications(state, user, false);
    const {addTask, updateTask, deleteTask} = taskActions(team);
    const {addMemo, updateMemo, deleteMemo} = memoActions(team);
    const {addPlan, updatePlan, deletePlan, submitReports, updateReport, deleteReport} = workActions(team, weekId);
    const {mutateDayThread} = threadActions(team);
    const {addEvent, updateEvent, deleteEvent} = eventActions(team);
    const {runAi, clearAi, dismissAi} = reminderActions(team, weekId);
    const {dismissMention} = mentionActions(team, updateEvent, updateMemo);
    const {handleExport, handleImport, onImportFile} = dataActions(team, importRef);

    return (
        <>
            <input
                ref={importRef}
                type="file"
                accept="application/json"
                style={{display: "none"}}
                onChange={onImportFile}
            />
            {exportOpen ? (
                <ExportDialog
                    state={state}
                    onExport={(kind, range) => {
                        handleExport(kind, range);
                        setExportOpen(false);
                    }}
                    onClose={() => setExportOpen(false)}
                />
            ) : null}
            <TopShell
                user={user}
                page={page}
                setPage={changePage}
                saving={saving}
                onManageMembers={canManageMembers ? () => changePage("members") : undefined}
                onChangePassword={onChangePassword}
                onLogout={() => void team.signOut()}
                onExport={() => setExportOpen(true)}
                onImport={handleImport}
                onExportLog={() =>
                    downloadBlob(`oa-client-log-${todayIso()}.json`, exportClientLogText(), "application/json")
                }
            >
                {page === "home" ? (
                    <HomePage
                        state={state}
                        user={user}
                        pickedDate={pickedDate}
                        setPickedDate={setPickedDate}
                        weekId={weekId}
                        onAddTask={addTask}
                        onUpdateTask={updateTask}
                        onDeleteTask={deleteTask}
                        onAddMemo={addMemo}
                        onUpdateMemo={updateMemo}
                        onDeleteMemo={deleteMemo}
                        onGenerateAi={runAi}
                        onClearAi={clearAi}
                        onDismissAi={dismissAi}
                        onAddEvent={addEvent}
                        onUpdateEvent={updateEvent}
                        onDeleteEvent={deleteEvent}
                        onDismissMention={dismissMention}
                    />
                ) : null}

                {page === "weekly" ? (
                    <WeeklyPage
                        state={state}
                        user={user}
                        onDayThread={mutateDayThread}
                        threadHighlight={threadHighlight}
                        focusedReportId={reportFocus}
                        viewMode={viewMode}
                        setViewMode={setViewMode}
                        pickedDate={pickedDate}
                        setPickedDate={setPickedDate}
                        weekId={weekId}
                        onAddPlan={addPlan}
                        onUpdatePlan={updatePlan}
                        onDeletePlan={deletePlan}
                        onSubmitReports={submitReports}
                        onUpdateReport={updateReport}
                        onDeleteReport={deleteReport}
                    />
                ) : null}

                {openedZeroAi ? (
                    <div hidden={page !== "zeroAi"}>
                        <ZeroAiPage user={user} visible={page === "zeroAi" && !suspended} api={api.zeroAi}
                                    onOpenReportSource={openReportSource}/>
                    </div>
                ) : null}

                {page === "issues" ? (
                    <IssuesPage state={state} user={user} onUpdateReport={updateReport}/>
                ) : null}

                {page === "stats" ? <StatsPage state={state} weekId={weekId}/> : null}

                {page === "data" ? (
                    <DataPage state={state}/>
                ) : null}

                {page === "members" && canManageMembers ? (
                    <MembersPage api={api.adminMembers} currentMemberId={user.id} onBack={() => changePage("home")}
                                 refreshWorkspace={() => team.runServerUpdate(api.loadState)}/>
                ) : null}
            </TopShell>

            {page === "home" && user && feedbackThreads.length ? (
                <div className="toast-stack">
                    {feedbackThreads.length ? (
                        <div className="feedback-toast">
                            <div className="mention-toast-head">
                                <strong>💬 工作报告新反馈</strong>
                            </div>
                            {feedbackThreads.slice(0, 5).map((thread) => (
                                <div key={thread.id} className="feedback-toast-row">
                                    <button
                                        type="button"
                                        className="feedback-jump"
                                        title="点击跳转到当天的评论区"
                                        onClick={() => {
                                            setViewMode("mine");
                                            setPickedDate(thread.date);
                                            changePage("weekly");
                                            setThreadHighlight({
                                                ownerId: thread.ownerId,
                                                date: thread.date,
                                                nonce: Date.now()
                                            });
                                        }}
                                    >
                                        {Number(thread.date.slice(5, 7))}月{Number(thread.date.slice(8, 10))}日
                                        的工作报告有新反馈
                                    </button>
                                    <button
                                        type="button"
                                        className="text-button mini"
                                        onClick={() => mutateDayThread(thread.ownerId, thread.date, {kind: "seen"})}
                                    >
                                        已读
                                    </button>
                                </div>
                            ))}
                            {feedbackThreads.length > 5 ? (
                                <p className="mention-toast-more">另有 {feedbackThreads.length - 5} 条</p>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {mentionToast?.length ? (
                <div className="mention-toast">
                    <div className="mention-toast-head">
                        <strong>📌 你有 {mentionToast.length} 条新 @ 提醒</strong>
                        <button className="text-button mini" onClick={() => setMentionToast(null)}>
                            关闭
                        </button>
                    </div>
                    {mentionToast.slice(0, 5).map((item) => (
                        <div key={`${item.kind}-${item.id}-${item.key}`} className="mention-toast-row">
                            <strong style={item.color ? {color: item.color} : undefined}>{item.title}</strong>
                            <span>{item.detail}</span>
                        </div>
                    ))}
                    {mentionToast.length > 5 ? (
                        <p className="mention-toast-more">
                            另有 {mentionToast.length - 5} 条，点击顶部 📌 查看
                        </p>
                    ) : null}
                </div>
            ) : null}
        </>
    );
}
