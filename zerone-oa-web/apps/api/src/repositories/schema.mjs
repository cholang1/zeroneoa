import {BSON} from 'mongodb';

// 键名是页面原有的集合名；值是 MongoDB 中可直接查询的业务集合。
export const names = Object.freeze({
    users: 'users', tasks: 'tasks', memos: 'memos', weeklyPlans: 'weekly_plans',
    dailyReports: 'daily_reports', events: 'calendar_events', dayThreads: 'day_threads',
    aiReminders: 'ai_reminders', auditLog: 'audit_log'
});
export const indexes = {
    users: [[{name: 1}, {unique: true}]],
    tasks: [[{parentId: 1, order: 1}]],
    memos: [[{scope: 1, weekId: 1}]],
    weeklyPlans: [[{ownerId: 1, weekId: 1}], [{taskId: 1, weekId: 1}], [{weekId: 1, completed: 1}]],
    dailyReports: [[{ownerId: 1, date: -1, _id: -1}], [{taskId: 1, date: -1, _id: -1}],
        [{weekId: 1, date: -1, _id: -1}], [{date: -1, _id: -1}]],
    events: [[{startDate: 1}], [{participantIds: 1, startDate: 1}]],
    dayThreads: [[{ownerId: 1, date: 1}]], aiReminders: [[{weekId: 1, ownerId: 1}]],
    auditLog: [[{entityType: 1, entityId: 1, createdAt: -1}]]
};

export class StateError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function publicRow(doc) {
    if (!doc) return null;
    const {_id, _batch, _seq, ...fields} = doc;
    return {id: _id, ...fields};
}

// 在发布批次前拒绝数据库无法可靠存储的值，避免因坏数据卡住崩溃恢复。
function checkFields(value, depth = 0) {
    if (value === null || typeof value !== 'object') return;
    if (depth > 80) throw new StateError(400, '记录嵌套过深。');
    for (const [key, child] of Object.entries(value)) {
        if (key.includes('\0') || key.startsWith('$') || key.includes('.') || key === '__proto__') throw new StateError(400, '记录包含非法字段。');
        if (/^(?:auth_accounts|auth_sessions|password(?:Hash|Verifier|Salt)?|csrfToken|sessionToken|credentialVersion)$/i.test(key)) {
            throw new StateError(400, '业务记录不能包含账号凭据字段。');
        }
        checkFields(child, depth + 1);
    }
}

export function checkChanges(changes) {
    if (!Array.isArray(changes)) throw new StateError(400, '请提交业务记录差量，不支持整份团队覆盖。');
    const seen = new Set();
    for (const change of changes) {
        const {key, id, before, after} = change ?? {};
        if (typeof key !== 'string' || !Object.hasOwn(names, key) || typeof id !== 'string' || !id || id.length > 512 || (before === null && after === null)) {
            throw new StateError(400, '集合或业务 ID 无效。');
        }
        const token = JSON.stringify([key, id]);
        if (seen.has(token)) throw new StateError(400, '不能重复提交同一条记录。');
        seen.add(token);
        for (const row of [before, after]) {
            if (row === null) continue;
            if (!row || Array.isArray(row) || row.id !== id || Object.keys(row).some(k => k.startsWith('_') || k.startsWith('$') || k.includes('.') || k.includes('\0'))) {
                throw new StateError(400, '记录 ID 不匹配或包含保留字段。');
            }
        }
        if (after) {
            checkFields(after);
            for (const [fields] of indexes[key]) for (const field of Object.keys(fields)) {
                const value = after[field];
                if (value == null) continue;
                if (field === 'participantIds' ? !Array.isArray(value) || !value.every(v => typeof v === 'string') : typeof value === 'object') {
                    throw new StateError(400, `索引字段 ${field} 的类型无效。`);
                }
            }
        }
        if (after && key === 'users' && (typeof after.name !== 'string' || !after.name.trim())) throw new StateError(400, '成员姓名不能为空。');
        if (after && key === 'dailyReports' && (
            typeof after.ownerId !== 'string' || !after.ownerId || typeof after.taskId !== 'string' ||
            typeof after.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(after.date) ||
            typeof after.weekId !== 'string' || !/^\d{4}-W\d{2}$/.test(after.weekId) ||
            typeof after.detail !== 'string' || !Number.isFinite(after.hours)
        )) throw new StateError(400, '日报缺少有效成员、任务、日期、周号、详情或工时。');
    }
}

export function checkSize(doc) {
    if (BSON.calculateObjectSize(doc) > 16 * 1024 * 1024) throw new StateError(413, '单条记录过大，未执行保存。');
}
