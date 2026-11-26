import {StateError} from '../repositories/schema.mjs';

// 只接受固定的查询条件，不把调用方提供的 MongoDB 表达式交给数据库。
export async function queryReports(store, params) {
    const filter = {};
    for (const key of params.keys()) {
        if (!['ownerId', 'taskId', 'weekId', 'from', 'to', 'limit', 'cursor'].includes(key)) throw new StateError(400, `不支持查询参数 ${key}。`);
    }
    for (const field of ['ownerId', 'taskId', 'weekId']) if (params.has(field)) filter[field] = params.get(field);
    const limit = Number(params.get('limit') ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StateError(400, 'limit 必须为 1 到 100 的整数。');
    const date = /^\d{4}-\d{2}-\d{2}$/;
    for (const [param, op] of [['from', '$gte'], ['to', '$lte']]) if (params.has(param)) {
        const value = params.get(param);
        if (!date.test(value)) throw new StateError(400, '日期格式应为 YYYY-MM-DD。');
        (filter.date ??= {})[op] = value;
    }
    if (filter.date?.$gte > filter.date?.$lte) throw new StateError(400, '开始日期不能晚于结束日期。');
    if (params.has('cursor')) {
        try {
            const [lastDate, id] = JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString());
            if (typeof lastDate !== 'string' || !date.test(lastDate) || typeof id !== 'string' || !id) throw Error();
            filter.$or = [{date: {$lt: lastDate}}, {date: lastDate, _id: {$lt: id}}];
        } catch {
            throw new StateError(400, '分页游标无效。');
        }
    }
    const rows = await store.reports(filter, limit + 1);
    const items = rows.slice(0, limit), last = items.at(-1);
    const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify([last.date, last.id])).toString('base64url') : null;
    return {items, nextCursor};
}
