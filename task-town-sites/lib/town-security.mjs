export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function check(condition, status, message) { if (!condition) throw new HttpError(status, message); }
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
export function password(value) { check(typeof value === 'string' && value.length >= 8 && value.length <= 128, 400, '家长密码需要 8–128 个字符'); return value; }
export function pin(value) { check(typeof value === 'string' && /^\d{6}$/.test(value), 400, '孩子口令需要 6 位数字'); return value; }
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const unhex = str => new Uint8Array(str.match(/../g).map(n => parseInt(n, 16)));
export const token = (bytes = 32) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export const digest = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
async function derive(value, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}
export async function hashPassword(value) { const salt = token(16); return `pbkdf2$100000$${salt}$${await derive(value, salt)}`; }
export async function verifyPassword(value, saved) {
  const [, , salt, expected] = /^pbkdf2\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(saved || '')
    ? saved.split('$') : ['pbkdf2', '100000', '0'.repeat(32), '0'.repeat(64)];
  const actual = await derive(value, salt);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
export async function body(request) {
  check(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 415, '请使用 JSON 请求');
  const max = 3 * 1024 * 1024;
  check(Number(request.headers.get('content-length') || 0) <= max, 413, '提交内容过大，照片需在 2MB 以内');
  const reader = request.body?.getReader();
  check(reader, 400, '请求内容需要是 JSON 对象');
  const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new HttpError(413, '提交内容过大，照片需在 2MB 以内'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'JSON 格式不正确'); }
  check(value && typeof value === 'object' && !Array.isArray(value), 400, '请求内容需要是 JSON 对象');
  return value;
}
export function parsePhoto(input) {
  if (input == null || input === '') return null;
  check(typeof input === 'string', 400, '照片格式不正确');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  check(match, 400, '照片只支持 JPG、PNG、WebP');
  let binary;
  try { binary = atob(match[2]); } catch { throw new HttpError(400, '照片内容不正确'); }
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  check(bytes.length > 12 && bytes.length <= 2 * 1024 * 1024, 400, '照片大小需在 2MB 以内');
  const type = match[1];
  const valid = type === 'image/jpeg'
    ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217
    : type === 'image/png'
      ? [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
      : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  check(valid, 400, '文件内容与照片类型不匹配');
  return { bytes, type };
}
