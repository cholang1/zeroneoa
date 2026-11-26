export type TaskStatus = "active" | "paused" | "done";
export type TaskLevel = 1 | 2 | 3;
export type MemoScope = "weekly" | "longTerm";
export type ReminderSeverity = "info" | "warning" | "critical";

/** A team member. No roles or permissions: every member sees and can do the same things. */
export interface User {
    id: string;
    name: string;
    color: string;
    createdAt: string;
}

export interface TaskNode {
    id: string;
    parentId: string | null;
    title: string;
    description: string;
    ownerId?: string;
    status: TaskStatus;
    level: TaskLevel;
    order: number;
    /** Absent on tasks created before 2026-08. */
    createdById?: string;
    createdAt?: string;
}

export interface Memo {
    id: string;
    scope: MemoScope;
    weekId?: string;
    text: string;
    color?: string;
    mentionAll?: boolean;
    mentionUserIds?: string[];
    /** Users who marked this mention as 已阅 (gray in the mention list). */
    dismissedMentionByIds?: string[];
    /** Users who marked this mention as 完成 (struck through in the mention list). */
    mentionDoneByIds?: string[];
    /** Memo-level completion: gray + strikethrough for everyone. */
    completed?: boolean;
    completedById?: string;
    completedAt?: string;
    comments?: ReportComment[];
    createdById: string;
    updatedById: string;
    createdAt: string;
    updatedAt: string;
}

export interface WeeklyPlanItem {
    id: string;
    weekId: string;
    ownerId: string;
    taskId: string;
    detail: string;
    completed: boolean;
    comment?: string;
    approverId?: string;
    approved?: boolean;
    approvedById?: string;
    approvedAt?: string;
    createdById: string;
    updatedById: string;
    createdAt: string;
    updatedAt: string;
}

export interface ReportComment {
    id: string;
    authorId: string;
    text: string;
    createdAt: string;
}

export interface DailyReport {
    id: string;
    date: string;
    weekId: string;
    ownerId: string;
    taskId: string;
    detail: string;
    hours: number;
    notes: string;
    resolved?: boolean;
    solution?: string;
    resolvedById?: string;
    resolvedAt?: string;
    /** Discussion thread shown in the 问题 page. */
    comments?: ReportComment[];
    createdById: string;
    updatedById: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * One shared discussion per person per day, attached to the bottom of that
 * day's ② 每日报告 block: a comment thread plus emoji reactions.
 * id is deterministic: thread-<ownerId>-<date>.
 */
export interface DayThread {
    id: string;
    ownerId: string;
    date: string; // YYYY-MM-DD
    weekId: string;
    comments?: ReportComment[];
    /** emoji -> ids of users who reacted with it */
    reactions?: Record<string, string[]>;
    /**
     * Set to updatedAt when the report owner marks the feedback as read; the
     * home-page feedback popup shows threads whose updatedAt is newer than this.
     */
    ownerSeenAt?: string;
    createdById: string;
    updatedById: string;
    createdAt: string;
    updatedAt: string;
}

export interface AiReminder {
    id: string;
    date: string;
    weekId?: string;
    ownerId?: string;
    severity: ReminderSeverity;
    summary: string;
    actions: string[];
    dismissedByIds?: string[];
    createdAt: string;
}

export interface AuditEvent {
    id: string;
    entityType: "task" | "memo" | "weeklyPlan" | "dailyReport" | "aiReminder" | "user" | "calendarEvent";
    entityId: string;
    actorId: string;
    action: string;
    createdAt: string;
}

export type Recurrence = "none" | "daily" | "weekly" | "biweekly" | "monthly";

export interface CalendarEvent {
    id: string;
    title: string;
    startDate: string;        // YYYY-MM-DD
    startTime?: string;       // HH:MM
    endTime?: string;         // HH:MM
    location?: string;
    meetingLink?: string;
    notes?: string;
    participantIds: string[]; // user IDs (these get @mentioned)
    recurrence?: Recurrence;
    recurrenceEnd?: string;   // YYYY-MM-DD, optional
    dismissedByIds?: string[];
    dismissedMentionDatesByUser?: Record<string, string[]>;
    /** Per-user occurrence dates marked 完成 in the mention list. */
    doneMentionDatesByUser?: Record<string, string[]>;
    createdById: string;
    updatedById: string;
    createdAt: string;
    updatedAt: string;
}

export interface TeamState {
    version: number;
    users: User[];
    tasks: TaskNode[];
    memos: Memo[];
    weeklyPlans: WeeklyPlanItem[];
    dailyReports: DailyReport[];
    aiReminders: AiReminder[];
    events?: CalendarEvent[];
    dayThreads?: DayThread[];
    auditLog: AuditEvent[];
}

/** 服务端会话关联的成员展示信息，不是登录凭证。 */
export interface SessionUser {
    id: string;
    name: string;
    color: string;
}

export interface ZeroAiQueryRef {
    type: string;
    id: string;
    label: string;
}

export interface ZeroAiQueryCard {
    name: string;
    label: string;
    asOf: string;
    scopeLabel?: string;
    refs: ZeroAiQueryRef[];
    truncated?: boolean;
    teamVersion?: number;
}

export interface ZeroAiMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    /** 仅助手消息可带服务器返回的只读查询来源。 */
    queryCards?: ZeroAiQueryCard[];
    /** 没有新来源卡时，区分沿用历史查询与未查询。 */
    queryBasis?: "previous" | "none";
    status?: "stopped" | "interrupted";
    versions?: { current: number; total: number; previousId?: string; nextId?: string };
}

export interface ZeroAiSessionSummary {
    id: string;
    title: string;
}

export interface ZeroAiSession extends ZeroAiSessionSummary {
    messages: ZeroAiMessage[];
    /** 历史的前页游标，只能用于这次快照对应的对话分支。 */
    before?: string;
    /** 活动分支的版本；提交消息时用于核对分支是否已变化。 */
    branchEpoch: number;
}

export type ZeroAiCapabilities = { historyV2: true; readTools?: true };
export type ZeroAiReportRefResponse = { id: string; teamVersion: number };
export type ZeroAiSessionsResponse = { sessions: ZeroAiSessionSummary[]; nextCursor?: string };
export type ZeroAiSessionResponse = { session: ZeroAiSession };

export type ZeroAiSendRequest = { turnId: string; expectedBranchEpoch?: number } & (
    | { content: string; editMessageId?: string; regenerateMessageId?: never }
    | { regenerateMessageId: string; content?: never; editMessageId?: never }
    );

/** 流帧带有请求轮次和序号。 */
export type ZeroAiStreamEvent = { turnId: string; seq: number } & (
    | { type: "start" }
    | { type: "delta"; content: string }
    | { type: "tool"; label: string }
    | { type: "result"; session?: ZeroAiSession; error?: string; status?: number }
    );

export interface WeeklyTaskSummary {
    taskId: string;
    totalHours: number;
    reports: DailyReport[];
}

export type TeamStateKey = Exclude<keyof TeamState, "version">;
export type TeamStateRecord<K extends TeamStateKey = TeamStateKey> = NonNullable<TeamState[K]>[number];

/** 用原数组键和业务 ID 标识记录；新增的 before、删除的 after 为 null。 */
export type StateChange = {
    [K in TeamStateKey]: { key: K; id: string; before: TeamStateRecord<K> | null; after: TeamStateRecord<K> | null };
}[TeamStateKey];

export type StateResponse = { state: TeamState };
/** baseVersion 是客户端基线；冲突按记录的 before/after 判断。 */
export type SaveRequest = { actorId: string; baseVersion: number; changes: StateChange[] };
export type CsrfResponse = { csrfToken: string };
export type LoginRequest = { loginName: string; password: string };
export type SessionResponse = CsrfResponse & {
    user: SessionUser;
    mustChangePassword: boolean;
    expiresAt: string;
    isAccountAdmin?: boolean;
};
export type LoginResponse = SessionResponse;
export type ChangePasswordRequest = { currentPassword: string; newPassword: string };
export type AuthActionResponse = { ok: true };

export type SetupStatusResponse = { available: boolean };
export type SetupRegisterRequest = { setupKey: string; name: string; loginName: string; password: string };

export type AdminMemberStatus = "unprovisioned" | "active" | "initial" | "disabled";
export type AdminMember = {
    id: string;
    name: string;
    loginName?: string;
    status: AdminMemberStatus;
    isAccountAdmin: boolean;
};
export type AdminMembersResponse = { members: AdminMember[] };
export type AdminMemberRequests = {
    create: { name: string; loginName: string };
    provision: { memberId: string; loginName: string };
    reset: { memberId: string; currentPassword: string };
    disable: { memberId: string; currentPassword: string };
};
export type AdminMemberAction = keyof AdminMemberRequests;
export type AdminMemberActionResponse = { memberId: string; initialPassword?: string };
