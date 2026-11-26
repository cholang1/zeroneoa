import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {openStore} from '../src/repositories/mongoStore.mjs';
import {executeReadTool, readToolDefinitions} from '../src/services/agentReadTools.mjs';

const a = {user: {id: 'a'}, isAccountAdmin: false, allowDetail: false};
const b = {user: {id: 'b'}, isAccountAdmin: false, allowDetail: true};
const admin = {...a, isAccountAdmin: true, allowDetail: true};
const issueTool = 'list_report_issues';
const issueReader = {...a, allowIssues: true};
const issueAdmin = {...admin, allowIssues: true};
const range = {from: '2026-12-31', to: '2027-01-01'};
const change = (key, after) => ({key, id: after.id, before: null, after});
const report = (id, ownerId, date, taskId, hours) => ({
    id, ownerId, date, weekId: '2026-W53', taskId, hours, detail: `${id} 正文`, notes: '禁发备注',
    comments: [{text: '禁发评论'}], solution: '禁发处理结果', createdById: '禁发作者'
});

async function database(t) {
    const uri = `mongodb://127.0.0.1:27018/oa_test_read_${randomUUID().replaceAll('-', '')}`;
    const inspect = new MongoClient(uri);
    const db = inspect.db();
    const store = await openStore(uri, {initializeAgentHistory: false});
    t.after(async () => {
        try {
            await store.close();
            await db.dropDatabase();
        } finally {
            await inspect.close();
        }
    });
    await store.initialize();
    return {store, db, call: (name, args, principal = a) => executeReadTool({store, principal, name, args})};
}

function success(result, type, scope) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.asOf, /\+08:00$/);
    assert.equal(result.scopeLabel, scope);
    assert.ok(Number.isSafeInteger(result.teamVersion));
    assert.equal(typeof result.truncated, 'boolean');
    for (const ref of result.refs) {
        assert.deepEqual(Object.keys(ref).sort(), ['id', 'label', 'type']);
        assert.equal(ref.type, type);
        assert.ok(ref.id && ref.label);
    }
    return result;
}

test('声明五个原生函数；本人/管理员 schema 和运行时均拒绝未授权字段', async () => {
    assert.deepEqual(readToolDefinitions(null), []);
    const normal = readToolDefinitions(a), elevated = readToolDefinitions(admin);
    assert.deepEqual(normal.map(def => def.function.name), [
        'search_members', 'list_tasks', 'list_weekly_plans', 'list_daily_reports', 'summarize_hours'
    ]);
    assert.ok(elevated.every(def => def.type === 'function' && def.function.parameters.additionalProperties === false));
    for (const index of [2, 3, 4]) {
        assert.equal(normal[index].function.parameters.properties.scope, undefined);
        assert.equal(normal[index].function.parameters.properties.ownerId, undefined);
        assert.deepEqual(elevated[index].function.parameters.properties.scope.enum, ['team']);
        assert.ok(elevated[index].function.parameters.properties.ownerId);
    }
    assert.deepEqual(normal[4].function.parameters.properties.groupBy.enum, ['day', 'task', 'total']);
    assert.deepEqual(elevated[4].function.parameters.properties.groupBy.enum, ['day', 'task', 'total', 'member']);
    assert.equal(normal[3].function.parameters.properties.limit.default, 20);
    normal[4].function.parameters.properties.groupBy.enum.push('injected');
    assert.equal(readToolDefinitions(a)[4].function.parameters.properties.groupBy.enum.includes('injected'), false);

    let reads = 0;
    const store = {
        agentReadPage() {
            reads++;
        }, agentSummarizeHours() {
            reads++;
        }
    };
    const call = (name, args, principal = a) => executeReadTool({store, principal, name, args});
    for (const [name, args, principal, code = 'INVALID_ARGUMENT'] of [
        ['list_daily_reports', range, null, 'FORBIDDEN'],
        ['list_daily_reports', {...range, ownerId: 'b'}, a, 'FORBIDDEN'],
        ['list_daily_reports', {...range, scope: 'team'}, {...a, isAccountAdmin: 'true'}, 'FORBIDDEN'],
        ['list_daily_reports', {...range, scope: 'team', ownerId: 'b'}, admin],
        ['list_weekly_plans', {weekId: '2027-W01', ownerId: {$ne: 'a'}}, admin],
        ['list_daily_reports', {...range, principal: admin}, a],
        ['list_daily_reports', {...range, taskId: {$ne: 'a'}}, a],
        ['list_daily_reports', {...range, limit: '1'}, a],
        ['list_daily_reports', {...range, limit: 51}, a],
        ['list_daily_reports', {...range, cursor: 'fake'}, a],
        ['list_daily_reports', {from: '2027-02-29', to: '2027-03-01'}, a],
        ['list_daily_reports', {from: '2026-12-31', to: '2027-01-31'}, a],
        ['list_daily_reports', {from: range.to, to: range.from}, a],
        ['list_weekly_plans', {weekId: '2027-W53'}, a],
        ['list_weekly_plans', {weekId: '2026-W00'}, a],
        ['list_weekly_plans', {weekId: '2027-W01', completed: 'false'}, a],
        ['summarize_hours', {...range, groupBy: 'member'}, a, 'FORBIDDEN'],
        ['summarize_hours', {...range, groupBy: 'total', limit: 10}, a],
        ['search_members', {query: '  '}, a],
        ['list_tasks', [], a],
        ['list_tasks', JSON.parse('{"__proto__":{"ownerId":"b"}}'), a],
        ['toString', {}, a]
    ]) {
        const result = await call(name, args, principal);
        assert.equal(result.ok, false, JSON.stringify({name, args, result}));
        assert.equal(result.code, code, JSON.stringify({name, args, result}));
    }
    assert.equal(reads, 0);
});

test('日报问题需要独立授权；工具声明和执行共用范围与参数校验', async () => {
    let reads = 0;
    const store = {
        agentReadPage() {
            reads++;
        }
    };
    const definition = principal => readToolDefinitions(principal).find(def => def.function.name === issueTool)?.function.parameters;
    const call = (args, principal = issueReader) => executeReadTool({store, principal, name: issueTool, args});
    for (const principal of [a, b, admin, {...issueAdmin, allowIssues: 'true'}, {
        ...issueAdmin,
        mustChangePassword: true
    }]) {
        assert.equal(definition(principal), undefined);
        assert.equal((await call({}, principal)).code, 'FORBIDDEN');
    }
    const schema = definition(issueReader);
    assert.deepEqual(schema.required, []);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.status.enum, ['open', 'resolved', 'all']);
    assert.equal(schema.properties.status.default, 'open');
    assert.deepEqual(schema.properties.dateBy.enum, ['reported', 'resolved']);
    assert.equal(schema.properties.dateBy.default, 'reported');
    assert.equal(schema.properties.resolvedByMe.type, 'boolean');
    assert.equal(schema.properties.scope, undefined);
    assert.equal(schema.properties.ownerId, undefined);
    assert.deepEqual(definition(issueAdmin).properties.scope.enum, ['team']);
    assert.equal(definition(issueAdmin).properties.ownerId.type, 'string');
    for (const args of [{ownerId: 'b', resolvedByMe: true}, {scope: 'team', resolvedByMe: true}]) {
        assert.equal((await call(args)).code, 'FORBIDDEN');
    }
    for (const args of [
        {from: range.from}, {to: range.to}, {from: range.to, to: range.from},
        {from: '2027-02-29', to: '2027-03-01'}, {from: range.from, to: '2027-01-31', dateBy: 'resolved'},
        {status: 'closed'}, {dateBy: 'date'}, {resolvedByMe: 'true'}, {taskId: {$ne: 'T'}},
        {scope: 'team', ownerId: 'b'}, {resolvedById: 'b'}, {allowIssues: true}, {detail: true}
    ]) assert.equal((await call(args, issueAdmin)).code, 'INVALID_ARGUMENT', JSON.stringify(args));
    for (const args of [{resolvedByMe: true}, {...range, dateBy: 'resolved'}]) {
        const result = await call({...args, status: 'open'});
        assert.equal(result.code, 'INVALID_ARGUMENT');
        assert.match(result.message, /resolved 或 all/);
    }
    assert.equal(reads, 0);
});

test('Mongo 目录是纯文本、有界且只返回展示字段，周计划默认本人且正文需明确许可', async t => {
    const {store, db, call} = await database(t);
    await store.patch(1, [
        change('users', {id: 'a', name: '张[甲]', color: '禁发颜色'}),
        change('users', {id: 'b', name: '张乙', color: '禁发颜色'}),
        change('tasks', {
            id: 'T01',
            title: '计划.一',
            parentId: null,
            level: 1,
            status: 'active',
            ownerId: 'a',
            description: '禁发描述'
        }),
        change('tasks', {id: 'T02', title: '计划.一', parentId: 'T01', level: 2, status: 'paused', ownerId: 'b'}),
        change('tasks', {id: 'T03', title: '计划一', parentId: null, level: 1, status: 'done'}),
        ...[['p-a-open', 'a', false], ['p-a-done', 'a', true], ['p-b-open', 'b', false]].map(([id, ownerId, completed]) =>
            change('weeklyPlans', {
                id, ownerId, weekId: '2026-W53', taskId: 'T01', detail: `${id} 正文`, completed,
                comments: ['禁发评论'], comment: '禁发单评', approved: true, approverId: '禁发审批人'
            }))
    ]);
    const users = success(await call('search_members', {query: ' [甲] '}), 'member', '团队目录');
    assert.deepEqual(users.data.items, [{id: 'a', name: '张[甲]'}]);
    assert.deepEqual(success(await call('search_members', {query: '.*'}), 'member', '团队目录').data.items, []);
    assert.equal(await db.collection('users').countDocuments(), 2);
    const taskPage = success(await call('list_tasks', {query: '.', limit: 1}), 'task', '团队目录');
    assert.deepEqual(taskPage.data.items, [{
        id: 'T01',
        title: '计划.一',
        parentId: null,
        level: 1,
        status: 'active',
        ownerId: 'a'
    }]);
    assert.equal(taskPage.truncated, true);
    const taskNext = success(await call('list_tasks', {
        query: '.',
        limit: 1,
        cursor: taskPage.nextCursor
    }), 'task', '团队目录');
    assert.equal(taskNext.data.items[0].id, 'T02');
    assert.equal(taskNext.data.items[0].parentId, 'T01');
    assert.equal(taskNext.nextCursor, null);
    assert.deepEqual((await call('list_tasks', {
        taskId: 'T02',
        ownerId: 'b',
        status: 'paused'
    })).data.items, taskNext.data.items);
    assert.deepEqual((await call('list_tasks', {taskId: 'T02', ownerId: 'a'})).data.items, []);

    const plans = {weekId: '2026-W53', taskId: 'T01', completed: false};
    const own = success(await call('list_weekly_plans', plans), 'plan', '本人');
    assert.deepEqual(own.data.items, [{id: 'p-a-open', weekId: '2026-W53', taskId: 'T01', completed: false}]);
    const ownAdmin = success(await call('list_weekly_plans', plans, admin), 'plan', '本人');
    assert.deepEqual(ownAdmin.data.items, [{...own.data.items[0], detail: 'p-a-open 正文'}]);
    const targeted = success(await call('list_weekly_plans', {...plans, ownerId: 'b'}, admin), 'plan', '指定成员');
    assert.deepEqual(targeted.data.items, [{
        ...own.data.items[0],
        id: 'p-b-open',
        ownerId: 'b',
        ownerName: '张乙',
        detail: 'p-b-open 正文'
    }]);
    const team = success(await call('list_weekly_plans', {...plans, scope: 'team', limit: 1}, admin), 'plan', '全队');
    assert.deepEqual(team.data.items, targeted.data.items);
    const teamNext = success(await call('list_weekly_plans', {
        ...plans,
        scope: 'team',
        limit: 1,
        cursor: team.nextCursor
    }, admin), 'plan', '全队');
    assert.deepEqual(teamNext.data.items, [{
        ...own.data.items[0],
        ownerId: 'a',
        ownerName: '张[甲]',
        detail: 'p-a-open 正文'
    }]);
    assert.doesNotMatch(JSON.stringify([ownAdmin, targeted, team, teamNext]), /禁发|approved|comment/);
});

test('Mongo 日报分页完整归属，工时超过分页/分组上限仍按全部匹配计算', async t => {
    const {store, db, call} = await database(t);
    const records = Object.values(range).flatMap((date, day) => Array.from({length: 60}, (_, i) =>
        report(`r-${day}-${String(i).padStart(2, '0')}`, 'a', date, `T${String(i).padStart(2, '0')}`, 0.25)));
    const seeded = await store.patch(1, [
        change('users', {id: 'a', name: '成员甲'}), change('users', {id: 'b', name: '成员乙'}),
        ...[...records, report('r-b', 'b', range.to, 'T00', 8), report('out', 'a', '2027-01-02', 'T00', 80)]
            .map(row => change('dailyReports', row)),
        change('aiReminders', {id: 'keep', weekId: '2026-W53', ownerId: 'a'})
    ]);
    const reminder = await db.collection('ai_reminders').findOne({_id: 'keep'});
    const rows = [];
    let cursor, version;
    do {
        const page = success(await call('list_daily_reports', {
            ...range,
            limit: 50, ...(cursor && {cursor})
        }), 'report', '本人');
        assert.equal(page.teamVersion, seeded.version);
        version = page.teamVersion;
        assert.equal(page.truncated, Boolean(page.nextCursor));
        assert.deepEqual(page.refs.map(ref => ref.id), page.data.items.map(row => row.id));
        for (const row of page.data.items) assert.deepEqual(Object.keys(row).sort(), ['date', 'hours', 'id', 'taskId', 'weekId']);
        rows.push(...page.data.items);
        cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(rows.map(row => row.id), records.map(row => row.id).reverse());
    assert.equal(rows[0].date, '2027-01-01');
    assert.equal(rows[0].weekId, '2026-W53');
    const detail = success(await call('list_daily_reports', {...range, taskId: 'T00'}, {
        ...a,
        allowDetail: true
    }), 'report', '本人');
    assert.deepEqual(detail.data.items.map(row => row.detail), ['r-1-00 正文', 'r-0-00 正文']);
    const targeted = success(await call('list_daily_reports', {...range, ownerId: 'b'}, admin), 'report', '指定成员');
    assert.deepEqual(targeted.data.items.map(row => [row.id, row.ownerId, row.ownerName]), [['r-b', 'b', '成员乙']]);
    assert.doesNotMatch(JSON.stringify([detail, targeted]), /禁发|notes|comments|solution/);

    const day = success(await call('summarize_hours', {...range, groupBy: 'day'}), 'hours', '本人');
    assert.deepEqual(day.data, {
        totalHours: 30, reportCount: 120, groups: [
            {key: range.from, hours: 15, count: 60, percentOfTotal: 50}, {
                key: range.to,
                hours: 15,
                count: 60,
                percentOfTotal: 50
            }
        ], groupsTruncated: false
    });
    const tasks = success(await call('summarize_hours', {...range, groupBy: 'task'}), 'hours', '本人');
    assert.equal(tasks.data.groups.length, 50);
    assert.equal(tasks.data.groupsTruncated, true);
    assert.equal(tasks.truncated, true);
    assert.deepEqual([tasks.data.totalHours, tasks.data.reportCount], [30, 120]);
    const selfAdmin = success(await call('summarize_hours', {...range, groupBy: 'total'}, admin), 'hours', '本人');
    assert.deepEqual(selfAdmin.data.groups, [{key: 'total', hours: 30, count: 120}]);
    const team = success(await call('summarize_hours', {
        ...range,
        scope: 'team',
        groupBy: 'member'
    }, admin), 'hours', '全队');
    assert.deepEqual(team.data, {
        totalHours: 38, reportCount: 121, groups: [
            {key: 'a', memberName: '成员甲', hours: 30, count: 120, percentOfTotal: 78.95}, {
                key: 'b', percentOfTotal: 21.05,
                memberName: '成员乙',
                hours: 8,
                count: 1
            }
        ], groupsTruncated: false
    });
    const empty = success(await call('summarize_hours', {
        ...range,
        taskId: 'absent',
        groupBy: 'total'
    }, b), 'hours', '本人');
    assert.deepEqual(empty.data, {totalHours: 0, reportCount: 0, groups: [], groupsTruncated: false});
    assert.equal((await db.collection('team_meta').findOne({_id: 'default'})).version, version);
    assert.deepEqual(await db.collection('ai_reminders').findOne({_id: 'keep'}), reminder);
});

test('Mongo 日报问题默认只查本人历史积压；按解决人筛选不扩大归属且只读取白名单', async t => {
    const {store, db, call} = await database(t);
    const date = range.to;
    const resolvedAt = '2027-01-01T12:00:00.000+08:00';
    const open = {
        ...report('open-a', 'a', date, 'T1', 1), notes: '  待处理  ', solution: '待验证方案',
        resolved: false, resolvedById: 'a', resolvedAt
    };
    const fixed = (id, owner, resolver, taskId = 'T1') => ({
        ...report(id, owner, date, taskId, 1), notes: '已记录的问题', solution: '解决方案',
        resolved: true, resolvedAt, resolvedById: resolver
    });
    await store.patch(1, [
        change('users', {id: 'a', name: '成员甲'}), change('users', {id: 'b', name: '成员乙'}),
        ...[
            open, {...report('open-b', 'b', date, 'T2', 1), notes: '另一个人的问题'},
            fixed('fixed-a-self', 'a', 'a'), fixed('fixed-a-other', 'a', 'b'), fixed('fixed-b', 'b', 'a', 'T2')
        ].map(row => change('dailyReports', row))
    ]);
    const backlog = {date: '2023-01-01', taskId: 'T1', notes: String.fromCodePoint(0x0085)};
    assert.notEqual(backlog.notes.trim(), '');
    const blank = '\t\r\n ' + String.fromCodePoint(0x00A0, 0x2028, 0x3000, 0xFEFF);
    assert.equal(blank.trim(), '');
    await db.collection('daily_reports').insertMany([
        {_id: 'legacy', ownerId: 'a', ...backlog},
        {_id: 'blank', ownerId: 'a', date, taskId: 'T1', notes: blank},
        {_id: 'null', ownerId: 'a', date, taskId: 'T1', notes: null},
        {_id: 'array', ownerId: 'a', date, taskId: 'T1', notes: ['不应匹配']},
        {_id: 'missing', ownerId: 'a', date, taskId: 'T1'},
        {
            _id: 'array-owner', ownerId: ['a', 'b'], date, taskId: 'T1', notes: '不应冒充本人',
            resolved: true, resolvedById: 'a'
        }
    ]);
    const query = (args, principal = issueReader) => call(issueTool, args, principal);
    assert.equal((await query({}, admin)).code, 'FORBIDDEN');
    assert.equal((await query({ownerId: 'b', resolvedByMe: true})).code, 'FORBIDDEN');
    await db.command({profile: 2});
    let own;
    try {
        // 同时授予正文权限，也不能让问题工具读取正文或评论。
        own = success(await query({}, issueAdmin), 'report', '本人');
    } finally {
        await db.command({profile: 0});
    }
    assert.deepEqual(own.data.items, [
        {id: 'open-a', date, taskId: 'T1', notes: open.notes, resolved: false, solution: open.solution},
        {id: 'legacy', ...backlog, resolved: false}
    ]);
    assert.deepEqual(own.refs, [
        {type: 'report', id: 'open-a', label: `${date} T1 日报问题`},
        {type: 'report', id: 'legacy', label: `${backlog.date} T1 日报问题`}
    ]);
    const reads = await db.collection('system.profile').find({'command.find': 'daily_reports'}).toArray();
    assert.equal(reads.length, 1);
    assert.equal(reads[0].command.filter.ownerId, 'a');
    assert.deepEqual(Object.keys(reads[0].command.projection).sort(),
        ['date', 'notes', 'resolved', 'resolvedAt', 'resolvedById', 'solution', 'taskId']);

    const ids = result => result.data.items.map(row => row.id);
    assert.deepEqual(ids(await query({resolvedByMe: true})), ['fixed-a-self']);
    assert.deepEqual(ids(await query({status: 'resolved', resolvedByMe: true})), ['fixed-a-self']);
    assert.deepEqual(ids(await query({status: 'all', resolvedByMe: false})), ['open-a', 'fixed-a-other', 'legacy']);
    assert.deepEqual(ids(await query({status: 'all', resolvedByMe: true}, issueAdmin)), ['fixed-a-self']);
    const team = success(await query({scope: 'team', status: 'resolved', resolvedByMe: true, taskId: 'T2'}, issueAdmin),
        'report', '全队');
    assert.deepEqual(team.data.items, [{
        id: 'fixed-b', date, taskId: 'T2', notes: '已记录的问题', resolved: true, solution: '解决方案',
        resolvedAt, resolvedById: 'a', ownerId: 'b', ownerName: '成员乙'
    }]);
    const targeted = success(await query({ownerId: 'b', status: 'all', resolvedByMe: true}, issueAdmin),
        'report', '指定成员');
    assert.deepEqual(targeted.data.items, team.data.items);
    const other = success(await query({status: 'all', resolvedByMe: true}, {
        ...issueReader,
        user: b.user
    }), 'report', '本人');
    assert.deepEqual(other.data.items, []);
    assert.doesNotMatch(JSON.stringify([own, team, targeted]), /禁发|detail|comments|hours|weekId|createdById/);
});

test('Mongo 日报问题区分上报日期和北京解决日期，严格按日报 date、id 续页', async t => {
    const {store, call} = await database(t);
    const date = range.to;
    const yesterday = range.from;
    const zStart = '2026-12-31T16:00:00.000Z';
    const bjEnd = '2027-01-01T23:59:59.999+08:00';
    await store.patch(1, [
        ['z-start', date, zStart, true], ['bj-end', yesterday, bjEnd, true],
        ['a-same-report-date', date, bjEnd, true],
        ['z-next', date, '2027-01-01T16:00:00.000Z', true],
        ['bj-previous', date, '2026-12-31T23:59:59.999+08:00', true],
        ['reopened', date, bjEnd, false], ['invalid', date, '不能解析的日期', true], ['missing', date, undefined, true]
    ].map(([id, reportDate, resolvedAt, resolved]) => change('dailyReports', {
        ...report(id, 'a', reportDate, 'T1', 1), notes: '问题', resolved, resolvedAt
    })));
    const query = (args, principal = issueReader) => call(issueTool, args, principal);
    const dates = {from: date, to: date};
    const params = {...dates, dateBy: 'resolved', status: 'all', limit: 1};
    const first = success(await query(params), 'report', '本人');
    assert.deepEqual(first.data.items.map(row => [row.id, row.date, row.resolvedAt]), [['z-start', date, zStart]]);
    assert.ok(first.nextCursor);
    const second = success(await query({...params, cursor: first.nextCursor}), 'report', '本人');
    assert.deepEqual(second.data.items.map(row => row.id), ['a-same-report-date']);
    const last = success(await query({...params, cursor: second.nextCursor}), 'report', '本人');
    assert.deepEqual(last.data.items.map(row => [row.id, row.date, row.resolvedAt]), [['bj-end', yesterday, bjEnd]]);
    assert.equal(last.nextCursor, null);
    for (const changed of [{dateBy: 'reported'}, {status: 'resolved'}, {resolvedByMe: true}, {taskId: 'T1'}]) {
        assert.equal((await query({...params, ...changed, cursor: first.nextCursor})).code, 'INVALID_ARGUMENT');
    }
    assert.equal((await query({...params, cursor: first.nextCursor}, a)).code, 'FORBIDDEN');
    const ids = result => result.data.items.map(row => row.id);
    assert.deepEqual(ids(await query({...dates, status: 'all'})),
        ['z-start', 'z-next', 'reopened', 'missing', 'invalid', 'bj-previous', 'a-same-report-date']);
    assert.deepEqual(ids(await query({...dates, dateBy: 'resolved'})), ['z-start', 'a-same-report-date', 'bj-end']);
    assert.deepEqual(ids(await query({from: '2026-12-02', to: date})), ['reopened']);
    assert.deepEqual(ids(await query({dateBy: 'resolved'})), ['reopened']);
    assert.deepEqual(ids(await query({dateBy: 'resolved', status: 'resolved'})),
        ['z-start', 'z-next', 'missing', 'invalid', 'bj-previous', 'a-same-report-date', 'bj-end']);
    await store.patch(first.teamVersion, [change('dailyReports', report('new', 'a', date, 'T1', 1))]);
    assert.equal((await query({...params, cursor: first.nextCursor})).code, 'CONFLICT');
});

test('Mongo 游标与主体、权限、工具、过滤条件和恢复后版本绑定，超长编号也可续页', async t => {
    const {store, db, call} = await database(t);
    const longId = '上' + '😀'.repeat(200);
    await store.patch(1, [
        change('dailyReports', report(longId, 'a', range.to, 'T01', 1)),
        change('dailyReports', report('short', 'a', range.to, 'T01', 1)),
        change('dailyReports', report('old', 'a', range.from, 'T01', 1))
    ]);
    const params = {...range, limit: 1};
    const head = success(await call('list_daily_reports', params), 'report', '本人');
    assert.equal(head.data.items[0].id, longId);
    assert.ok(head.nextCursor.length <= 512);
    const args = {...params, cursor: head.nextCursor};
    const next = success(await call('list_daily_reports', args), 'report', '本人');
    assert.equal(next.data.items[0].id, 'short');
    assert.equal((await call('list_daily_reports', {...params, cursor: next.nextCursor})).data.items[0].id, 'old');
    for (const [modified, principal] of [
        [args, {...a, user: b.user}], [args, {...a, allowDetail: true}], [args, {...a, isAccountAdmin: true}],
        [{...args, taskId: 'T01'}, a], [{...args, limit: 2}, a], [{...args, cursor: `i${head.nextCursor}`}, a]
    ]) assert.equal((await call('list_daily_reports', modified, principal)).code, 'INVALID_ARGUMENT');
    assert.equal((await call('list_tasks', {cursor: head.nextCursor, limit: 1})).code, 'INVALID_ARGUMENT');

    assert.deepEqual(await store.verifyAgentReport(longId, head.teamVersion, 'a'), {
        id: longId,
        teamVersion: head.teamVersion
    });
    assert.deepEqual(await store.verifyAgentReport(longId, head.teamVersion, null), {
        id: longId,
        teamVersion: head.teamVersion
    });
    await assert.rejects(store.verifyAgentReport(longId, head.teamVersion, 'b'), {status: 404});
    await assert.rejects(store.verifyAgentReport('absent', head.teamVersion, null), {status: 404});
    await assert.rejects(store.verifyAgentReport({$ne: ''}, head.teamVersion, null), {status: 404});

    const {id, ...fields} = report('recover-me', 'a', range.to, 'T01', 2);
    const doc = {_id: id, _batch: 3, _seq: 0, ...fields};
    await db.collection('pending_changes').insertOne({
        _id: 'saved:0',
        batch: 'saved',
        seq: 0,
        key: 'dailyReports',
        id,
        doc
    });
    await db.collection('team_meta').updateOne({_id: 'default'}, {$set: {pending: {batch: 'saved', count: 1}}});
    assert.equal((await call('list_daily_reports', args)).code, 'CONFLICT');
    await assert.rejects(store.verifyAgentReport(longId, head.teamVersion, 'a'), {status: 409});
    assert.deepEqual((await call('summarize_hours', {...range, groupBy: 'total'})).data.groups, [{
        key: 'total',
        hours: 5,
        count: 4
    }]);
    assert.equal(await db.collection('pending_changes').countDocuments(), 0);
});

test('Mongo 查询投影不取未批准正文；坏归属不泄漏，坏数据或掉线不报 0', async t => {
    const {store, db, call} = await database(t);
    await store.patch(1, [
        change('dailyReports', report('one', 'a', range.to, 'T', -1)),
        change('weeklyPlans', {
            id: 'plan',
            ownerId: 'a',
            weekId: '2026-W53',
            taskId: 'T',
            completed: false,
            detail: '不得从数据库读取'
        })
    ]);
    const reports = db.collection('daily_reports');
    await reports.insertOne({_id: 'foreign', ...report('foreign', ['a', 'b'], range.to, 'T', 100)});
    await db.command({profile: 2});
    try {
        assert.deepEqual((await call('list_daily_reports', range)).data.items.map(row => row.id), ['one']);
        assert.equal((await call('list_weekly_plans', {weekId: '2026-W53'})).data.items[0].detail, undefined);
    } finally {
        await db.command({profile: 0});
    }
    const finds = await db.collection('system.profile').find({'command.find': {$in: ['daily_reports', 'weekly_plans']}}).toArray();
    assert.equal(finds.length, 2);
    assert.ok(finds.every(entry => !Object.hasOwn(entry.command.projection, 'detail') && entry.command.filter.ownerId === 'a'));
    const total = success(await call('summarize_hours', {...range, groupBy: 'total'}), 'hours', '本人');
    assert.deepEqual([total.data.totalHours, total.data.reportCount, total.data.negativeCount], [-1, 1, 1]);
    await reports.insertOne({_id: 'invalid', ...report('invalid', 'a', '2027-02-30', 'T', 2)});
    const invalid = await call('summarize_hours', {from: '2027-02-27', to: '2027-03-02', groupBy: 'total'});
    assert.equal(invalid.code, 'UNAVAILABLE');
    assert.equal(invalid.data, undefined);
    await store.close();
    const unavailable = await call('summarize_hours', {...range, groupBy: 'total'});
    assert.equal(unavailable.code, 'UNAVAILABLE');
    assert.equal(unavailable.data, undefined);
});

test('Mongo 过长正文被标记，8 KiB 裁整行后游标可完整续读', async t => {
    const {store, call} = await database(t);
    const detail = '中'.repeat(5000);
    await store.patch(1, Array.from({length: 6}, (_, i) =>
        change('dailyReports', {...report(`r-${i}`, 'a', range.to, 'T', 1), detail})));
    const ids = [];
    let cursor;
    do {
        const page = success(await call('list_daily_reports', {
            ...range,
            limit: 50, ...(cursor && {cursor})
        }, admin), 'report', '本人');
        assert.equal(page.truncated, true);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8 * 1024);
        assert.ok(page.data.items.every(row => row.detail === detail.slice(0, 1000)));
        ids.push(...page.data.items.map(row => row.id));
        cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, ['r-5', 'r-4', 'r-3', 'r-2', 'r-1', 'r-0']);
});
