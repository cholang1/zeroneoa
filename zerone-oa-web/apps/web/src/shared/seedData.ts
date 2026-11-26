import {TeamState} from "@oa/contracts";

/** Blank starting state, shown until the server's state has loaded. */
export const emptyTeamState: TeamState = {
    version: 0,
    users: [],
    tasks: [],
    memos: [],
    weeklyPlans: [],
    dailyReports: [],
    aiReminders: [],
    events: [],
    dayThreads: [],
    auditLog: []
};
