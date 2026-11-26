const annotations = ["title", "description", "default", "examples"];
const commonKeys = ["type", "enum", "const", ...annotations];
const typeKeys = {
    object: ["properties", "required", "additionalProperties"],
    array: ["items", "minItems", "maxItems"],
    string: ["minLength", "maxLength", "pattern", "format"],
    integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
    number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
    boolean: [],
    null: []
};

export function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaAssert(condition) {
    if (!condition) throw new TypeError("不支持的模型工具参数定义。");
}

function scalar(value) {
    return value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);
}

function bounds(schema, lower, upper, valid) {
    for (const key of [lower, upper]) if (Object.hasOwn(schema, key)) schemaAssert(valid(schema[key]));
    schemaAssert(schema[lower] === undefined || schema[upper] === undefined || schema[lower] <= schema[upper]);
    return value => (schema[lower] === undefined || value >= schema[lower]) &&
        (schema[upper] === undefined || value <= schema[upper]);
}

function dateIsValid(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// 只接收明确支持的 JSON Schema 子集；不认识的约束在发送工具定义之前拒绝。
export function compileToolSchema(schema, depth = 0) {
    schemaAssert(depth <= 16 && isObject(schema) && typeof schema.type === "string" && Object.hasOwn(typeKeys, schema.type));
    const {type, enum: choices} = schema;
    schemaAssert(Object.keys(schema).every(key => commonKeys.includes(key) || typeKeys[type].includes(key)));
    if (Object.hasOwn(schema, "enum")) schemaAssert(Array.isArray(choices) && choices.length > 0 && choices.every(scalar));
    const hasConst = Object.hasOwn(schema, "const");
    if (hasConst) schemaAssert(scalar(schema.const));
    const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
    let valid;
    switch (type) {
        case "object": {
            const {properties = {}, required = []} = schema;
            schemaAssert(isObject(properties) && Array.isArray(required) && new Set(required).size === required.length &&
                required.every(key => typeof key === "string" && Object.hasOwn(properties, key)) &&
                (!Object.hasOwn(schema, "additionalProperties") || schema.additionalProperties === false));
            schema.additionalProperties = false;
            const fields = new Map(Object.entries(properties).map(([key, field]) => [key, compileToolSchema(field, depth + 1)]));
            valid = value => isObject(value) && required.every(key => Object.hasOwn(value, key)) &&
                Object.entries(value).every(([key, field]) => fields.get(key)?.(field));
            break;
        }
        case "array": {
            const item = compileToolSchema(schema.items, depth + 1);
            const length = bounds(schema, "minItems", "maxItems", nonNegativeInteger);
            valid = value => Array.isArray(value) && length(value.length) && value.every(item);
            break;
        }
        case "string": {
            const length = bounds(schema, "minLength", "maxLength", nonNegativeInteger);
            schemaAssert(!Object.hasOwn(schema, "pattern") || typeof schema.pattern === "string");
            schemaAssert(!Object.hasOwn(schema, "format") || schema.format === "date");
            const pattern = schema.pattern === undefined ? null : new RegExp(schema.pattern, "u");
            valid = value => typeof value === "string" && length([...value].length) &&
                (!pattern || pattern.test(value)) && (!schema.format || dateIsValid(value));
            break;
        }
        case "integer":
        case "number": {
            const range = bounds(schema, "minimum", "maximum", Number.isFinite);
            for (const key of ["exclusiveMinimum", "exclusiveMaximum"]) {
                if (Object.hasOwn(schema, key)) schemaAssert(Number.isFinite(schema[key]));
            }
            valid = value => (type === "integer" ? Number.isSafeInteger(value) : Number.isFinite(value)) && range(value) &&
                (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum) &&
                (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum);
            break;
        }
        case "boolean":
            valid = value => typeof value === "boolean";
            break;
        case "null":
            valid = value => value === null;
            break;
    }
    return value => valid(value) && (!choices || choices.includes(value)) && (!hasConst || value === schema.const);
}
