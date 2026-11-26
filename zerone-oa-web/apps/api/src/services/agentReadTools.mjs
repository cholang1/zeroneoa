import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {StateError} from '../repositories/schema.mjs';

const maxResultBytes = 8 * 1024;
const dayMs = 86400000;
const cursorKeys = new WeakMap();
const id = {type: 'string', minLength: 1, maxLength: 128};
const text = maxLength => ({type: 'string', minLength: 1, maxLength});
const date = {type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$'};
const week = {type: 'string', pattern: '^\\d{4}-W\\d{2}$'};
const choice = (...values) => ({type: 'string', enum: values});
const page = {limit: {type: 'integer', minimum: 1, maximum: 50, default: 20}, cursor: text(512)};
const adminScope = {scope: choice('team'), ownerId: id};
const ranged = {from: date, to: date, taskId: id};
const tools = new Map(Object.entries({
    search_members: {
        description: '按姓名搜索团队成员目录，只返回成员编号和姓名，不创建成员。',
        properties: {query: text(64), ...page}, required: ['query'], refType: 'member'
    },
    list_tasks: {
        description: '查询团队任务目录，可按标题、任务编号、负责人或状态筛选。',
        properties: {query: text(80), taskId: id, ownerId: id, status: choice('active', 'paused', 'done'), ...page},
        required: [], refType: 'task'
    },
    list_weekly_plans: {
        description: '查询指定 ISO 周的计划（例如 2026-W53），默认仅本人。',
        properties: {weekId: week, taskId: id, completed: {type: 'boolean'}, ...page}, required: ['weekId'],
        refType: 'plan', business: true
    },
    list_daily_reports: {
        description: '查询北京日期闭区间内的日报（最多 31 天），默认仅本人。',
        properties: {...ranged, ...page}, required: ['from', 'to'], refType: 'report', business: true
    },
    summarize_hours: {
        description: '统计北京日期闭区间内全部匹配日报的工时（最多 31 天），不受分页影响，默认仅本人。',
        properties: {...ranged, groupBy: choice('day', 'task', 'total')}, required: ['from', 'to', 'groupBy'],
        refType: 'hours', business: true
    }
}));

function subject(principal) {
    const memberId = principal?.user?.id;
    if (typeof memberId !== 'string' || !memberId.trim() || principal.mustChangePassword === true) return null;
    return {memberId, admin: principal.isAccountAdmin === true, allowDetail: principal.allowDetail === true};
}

function schema(tool, admin) {
    const properties = {...tool.properties};
    if (tool.business && admin) Object.assign(properties, adminScope);
    if (properties.groupBy && admin) properties.groupBy = choice(...properties.groupBy.enum, 'member');
    return {type: 'object', additionalProperties: false, required: tool.required, properties};
}

export function readToolDefinitions(principal) {
    const caller = subject(principal);
    if (!caller) return [];
    return [...tools].map(([name, tool]) => ({
        type: 'function',
        function: {
            name,
            description: tool.description + (tool.business && caller.admin ?
                ' 如确需跨人，指定 scope=team 查全队，或指定 ownerId 查一人，二者不可同时使用。' : ''),
            parameters: structuredClone(schema(tool, caller.admin))
        }
    }));
}

const fail = (code, message, retryable = false) => ({ok: false, code, message, retryable});
const invalid = () => fail('INVALID_ARGUMENT', '查询参数无效。');
const forbidden = () => fail('FORBIDDEN', '没有权限查询此范围。');
const unavailable = () => fail('UNAVAILABLE', '业务查询暂不可用，请稍后重试。', true);
const tooLarge = () => fail('LIMIT_EXCEEDED', '单条查询结果过大，请缩小查询范围。');

function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
    const instant = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(+instant) && instant.toISOString().slice(0, 10) === value;
}

function validWeek(value) {
    if (value.length !== 8 || !/^\d{4}-W\d{2}$/.test(value) || value.startsWith('0000')) return false;
    const year = value.slice(0, 4);
    const firstDay = new Date(`${year}-01-01T00:00:00.000Z`).getUTCDay();
    const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
    const number = Number(value.slice(6));
    return number >= 1 && number <= (firstDay === 4 || (firstDay === 3 && leap) ? 53 : 52);
}

function parseArguments(tool, caller, args) {
    if (!args || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return invalid();
    if (tool.business && !caller.admin && (Object.hasOwn(args, 'scope') || Object.hasOwn(args, 'ownerId') ||
        (tool.refType === 'hours' && args.groupBy === 'member'))) return forbidden();
    const {properties, required} = schema(tool, caller.admin);
    if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) || required.some(key => !Object.hasOwn(args, key))) return invalid();
    const values = {};
    for (const [key, rules] of Object.entries(properties)) {
        if (!Object.hasOwn(args, key)) {
            if (rules.default !== undefined) values[key] = rules.default;
            continue;
        }
        let value = args[key];
        if (rules.type === 'integer') {
            if (!Number.isInteger(value) || value < rules.minimum || value > rules.maximum) return invalid();
        } else if (typeof value !== rules.type) return invalid();
        if (key === 'query') value = value.trim();
        if (rules.maxLength && (!value || value.includes('\0') || value.length > rules.maxLength * 2 ||
            [...value].length > rules.maxLength)) return invalid();
        if (rules.enum && !rules.enum.includes(value)) return invalid();
        if ((rules === date && !validDate(value)) || (rules === week && !validWeek(value))) return invalid();
        values[key] = value;
    }
    if (values.scope !== undefined && values.ownerId !== undefined) return invalid();
    if (values.from && (values.from > values.to || Date.parse(values.to) - Date.parse(values.from) >= 31 * dayMs)) {
        return fail('INVALID_ARGUMENT', '日期必须是最多 31 天的闭区间，开始日期不能晚于结束日期。');
    }
    return {ok: true, values};
}

function cursorKey(store) {
    // 每个仓储实例独立签名：不同工作区或重启后的游标需从第一页重查。
    if (!cursorKeys.has(store)) cursorKeys.set(store, randomBytes(32));
    return cursorKeys.get(store);
}

function sign(key, binding, payload) {
    return createHmac('sha256', key).update(binding).update('.').update(payload).digest('base64url');
}

function readCursor(token, key, binding) {
    if (!/^[\w-]+\.[\w-]{43}$/.test(token)) return null;
    const [encoded, signature] = token.split('.');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(key, binding, encoded)))) return null;
    const [teamVersion, offset, id, date] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return {teamVersion, offset, ...(id !== undefined && {id, date})};
}

function nextCursor(teamVersion, offset, row, key, binding) {
    const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
    let encoded = encode(row.date === undefined ? [teamVersion, offset, row.id] : [teamVersion, offset, row.id, row.date]);
    // 极长旧编号不能让分页断掉；版本仍相同才可按同一排序从位置续查。
    if (encoded.length > 468) encoded = encode([teamVersion, offset]);
    return `${encoded}.${sign(key, binding, encoded)}`;
}

function bounded(value, max) {
    if (typeof value !== 'string') return {value: null, clipped: false};
    const chars = [...value];
    return {value: chars.length > max ? chars.slice(0, max).join('') : value, clipped: chars.length > max};
}

function projectRow(row, type, includeOwner, allowDetail) {
    if (typeof row.id !== 'string' || !row.id) return null;
    const item = {id: row.id};
    let clipped = false;

    function copy(field, expected) {
        if (typeof row[field] === expected) item[field] = row[field];
    }

    function copyText(field, max) {
        const text = bounded(row[field], max);
        if (text.value !== null) item[field] = text.value;
        clipped ||= text.clipped;
    }

    let label;
    if (type === 'member') {
        copyText('name', 256);
        if (!item.name) return null;
        label = item.name;
    } else if (type === 'task') {
        copyText('title', 256);
        if (row.parentId === null) item.parentId = null;
        else copy('parentId', 'string');
        if ([1, 2, 3].includes(row.level)) item.level = row.level;
        if (['active', 'paused', 'done'].includes(row.status)) item.status = row.status;
        copy('ownerId', 'string');
        label = item.title || '任务';
    } else {
        copy('weekId', 'string');
        copy('taskId', 'string');
        if (type === 'plan') {
            copy('completed', 'boolean');
            if (!item.weekId || !validWeek(item.weekId)) return null;
            label = `${item.weekId} 周计划`;
        } else {
            if (typeof row.date !== 'string' || !validDate(row.date) || !Number.isFinite(row.hours) ||
                !item.weekId || !validWeek(item.weekId)) return null;
            item.date = row.date;
            item.hours = row.hours;
            label = `${item.date} 日报`;
        }
        if (includeOwner) {
            copy('ownerId', 'string');
            copyText('ownerName', 256);
        }
        if (allowDetail) copyText('detail', 1000);
    }
    return {item, ref: {type, id: row.id, label}, clipped};
}

const withinBudget = result => Buffer.byteLength(JSON.stringify(result)) <= maxResultBytes;

export async function executeReadTool({store, principal, name, args} = {}) {
    const caller = subject(principal);
    if (!caller) return forbidden();
    const tool = tools.get(name);
    if (!tool) return fail('INVALID_ARGUMENT', '不支持此查询工具。');
    const parsed = parseArguments(tool, caller, args);
    if (!parsed.ok) return parsed;
    const {cursor, limit, scope, ...filters} = parsed.values;
    const ownerId = tool.business ? (scope === 'team' ? undefined : filters.ownerId ?? caller.memberId) : undefined;
    const includeOwner = tool.business && ownerId !== caller.memberId;
    const scopeLabel = !tool.business ? '团队目录' : scope === 'team' ? '全队' : includeOwner ? '指定成员' : '本人';
    const binding = JSON.stringify([caller, name, scopeLabel, filters, limit]);
    if (!store) return unavailable();
    try {
        if (tool.refType === 'hours') {
            const {totalHours, reportCount, groups, negativeCount, invalidCount, invalidDateCount, asOf, teamVersion} =
                await store.agentSummarizeHours({filters, ownerId});
            if (invalidCount || invalidDateCount || !Number.isFinite(totalHours)) {
                return fail('UNAVAILABLE', '匹配的日报存在无效日期或工时，无法可靠统计。');
            }
            if (!Number.isSafeInteger(reportCount)) return unavailable();
            const ref = {
                type: 'hours',
                id: `hours-${createHash('sha256').update(binding).update(`:${teamVersion}`).digest('hex')}`,
                label: `${filters.from} 至 ${filters.to} 工时`
            };
            const projected = groups.map(group => {
                if (typeof group.key !== 'string' || !Number.isFinite(group.hours) || !Number.isSafeInteger(group.count)) return null;
                const memberName = filters.groupBy === 'member' ? bounded(group.memberName, 256) : null;
                return {
                    item: {
                        key: group.key, hours: group.hours, count: group.count,
                        // 分母包含未展示的分组；零总额或历史负工时不计算占比。
                        ...(filters.groupBy !== 'total' && totalHours > 0 && !negativeCount &&
                            {percentOfTotal: Number((group.hours / totalHours * 100).toFixed(2))}),
                        ...(memberName?.value != null && {memberName: memberName.value})
                    }, clipped: memberName?.clipped
                };
            });
            if (projected.includes(null)) return unavailable();
            for (let count = Math.min(projected.length, 50); count >= 0; count--) {
                const shown = projected.slice(0, count);
                const groupsTruncated = count < projected.length;
                const result = {
                    ok: true, data: {
                        totalHours, reportCount, groups: shown.map(group => group.item), groupsTruncated,
                        ...(negativeCount > 0 && {negativeCount})
                    }, refs: [ref], asOf, teamVersion, scopeLabel,
                    truncated: groupsTruncated || shown.some(group => group.clipped)
                };
                if (withinBudget(result)) return result;
            }
            return tooLarge();
        }

        const key = cursorKey(store);
        const before = cursor === undefined ? null : readCursor(cursor, key, binding);
        if (cursor !== undefined && !before) return fail('INVALID_ARGUMENT', '分页游标无效，请从第一页重查。');
        const {rows, asOf, teamVersion} = await store.agentReadPage(name, {
            filters, ownerId, includeOwner, allowDetail: caller.allowDetail, before, limit
        });
        const projected = rows.slice(0, limit).map(row => projectRow(row, tool.refType, includeOwner, caller.allowDetail));
        if (projected.includes(null)) return unavailable();
        for (let count = projected.length; count >= Math.min(1, projected.length); count--) {
            const page = projected.slice(0, count);
            const next = rows.length > count ? nextCursor(teamVersion, (before?.offset ?? 0) + count, page.at(-1).item, key, binding) : null;
            const result = {
                ok: true, data: {items: page.map(row => row.item)}, refs: page.map(row => row.ref), asOf, teamVersion,
                scopeLabel, nextCursor: next, truncated: next !== null || page.some(row => row.clipped)
            };
            if (withinBudget(result)) return result;
        }
        return tooLarge();
    } catch (error) {
        if (error instanceof StateError && error.status === 409) {
            return fail('CONFLICT', '团队数据已更新，请从第一页重查。', true);
        }
        return unavailable();
    }
}
