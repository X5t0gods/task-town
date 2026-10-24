import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const token = () => randomBytes(32).toString('hex');
export const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(value, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(value, saved) {
  const [salt, expected] = saved.split(':');
  const hash = await scrypt(value, salt, 64);
  const decoded = Buffer.from(expected, 'hex');
  return hash.length === decoded.length && timingSafeEqual(hash, decoded);
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function check(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

export function text(value, name, { min = 1, max = 100 } = {}) {
  check(typeof value === 'string', 400, `${name}格式不正确`);
  const result = value.trim();
  check(result.length >= min && result.length <= max, 400, `${name}需要 ${min}–${max} 个字符`);
  return result;
}

export function integer(value, name, min, max) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, 400, `${name}需要是 ${min}–${max} 的整数`);
  return value;
}

export function username(value, child = false) {
  const result = text(value, '账号', { min: child ? 2 : 3, max: 32 }).toLowerCase();
  check(/^[a-z0-9_]+$/.test(result), 400, '账号只能使用英文字母、数字和下划线');
  return result;
}

export function password(value) {
  check(typeof value === 'string' && value.length >= 8 && value.length <= 128, 400, '家长密码需要 8–128 个字符');
  return value;
}

export function pin(value) {
  check(typeof value === 'string' && /^\d{6}$/.test(value), 400, '孩子口令需要 6 位数字');
  return value;
}

export function parsePhoto(input) {
  if (input == null || input === '') return { bytes: null, type: null };
  check(typeof input === 'string', 400, '照片格式不正确');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  check(match, 400, '照片只支持 JPG、PNG、WebP');
  const bytes = Buffer.from(match[2], 'base64');
  check(bytes.length > 12 && bytes.length <= 2 * 1024 * 1024, 400, '照片大小需在 2MB 以内');
  const [type] = match.slice(1);
  const valid = type === 'image/jpeg'
    ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217
    : type === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  check(valid, 400, '文件内容与照片类型不匹配');
  return { bytes, type };
}

export function rateLimiter() {
  const entries = new Map();
  return (key, limit, windowMs, now) => {
    if (entries.size > 5000) {
      for (const [k, v] of entries) if (v.reset <= now) entries.delete(k);
      check(entries.size < 10000, 429, '请求较多，请稍后再试');
    }
    let entry = entries.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      entries.set(key, entry);
    }
    entry.count++;
    check(entry.count <= limit, 429, '尝试次数过多，请稍后再试');
  };
}
