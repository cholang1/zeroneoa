import {randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {StateError} from '../repositories/schema.mjs';

const scryptAsync = promisify(scrypt);
const options = {N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024};
const salt = () => randomBytes(16).toString('base64url');
const dummy = {salt: salt(), hash: randomBytes(32).toString('base64url')};
let inFlight = 0;

export const validPasswordInput = value => typeof value === 'string' && value.length > 0 &&
    value.length <= 512 && value.isWellFormed();

export function checkNewPassword(password) {
    if (!validPasswordInput(password) || [...password].length < 12 || !password.trim()) {
        throw new StateError(400, '新密码至少需要 12 个字符，不能全为空白，长度不能超过 512 个 UTF-16 码元。');
    }
}

async function derive(password, value) {
    // 每次派生约占 32 MiB；不允许登录请求无限堆积到 libuv 队列。
    if (inFlight >= 4) throw new StateError(503, '密码服务繁忙，请稍后重试。');
    inFlight++;
    try {
        return await scryptAsync(password, Buffer.from(value, 'base64url'), 32, options);
    } finally {
        inFlight--;
    }
}

export const generateInitialPassword = () => randomBytes(24).toString('base64url');

export async function hashPassword(password) {
    const value = salt();
    const digest = await derive(password, value);
    return {salt: value, hash: digest.toString('base64url')};
}

export async function verifyPassword(password, credentials) {
    const valid = credentials && typeof credentials.salt === 'string' && /^[\w-]{22}$/.test(credentials.salt) &&
        typeof credentials.hash === 'string' && /^[\w-]{43}$/.test(credentials.hash);
    // 缺失或不可登录的账号仍执行同等代价的派生，避免跳过密码计算泄露账号存在性。
    const stored = valid ? credentials : dummy;
    const digest = await derive(password, stored.salt);
    const match = timingSafeEqual(digest, Buffer.from(stored.hash, 'base64url'));
    return Boolean(valid && match);
}
