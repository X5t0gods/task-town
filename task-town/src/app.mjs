import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { openDatabase, transaction } from './database.mjs';
import {
  HttpError, check, text, integer, username, password, pin, hashPassword,
  verifyPassword, token, digest, parsePhoto, rateLimiter,
} from './security.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const CATEGORIES = ['家务小帮手', '自理小达人', '学习小标兵', '运动小健将', '爱心小天使'];
const ICONS = ['🎁', '🍦', '📺', '🎡', '📚', '⚽', '🧸', '🎨'];
const MAX_BODY = 3 * 1024 * 1024;
const RUN_SELECT = `SELECT r.id, r.task_id, r.child_id, r.period_key, r.status, r.note,
  r.review_comment, r.photo IS NOT NULL AS has_photo, r.claimed_at, r.submitted_at,
  r.reviewed_at, t.title, t.description, t.category, t.reward, t.photo_required,
  t.recurrence, t.due_at, c.display_name AS child_name
  FROM runs r JOIN tasks t ON t.id=r.task_id JOIN children c ON c.id=r.child_id`;

async function body(req) {
  check(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 415, '请使用 JSON 请求');
  if (Number(req.headers['content-length']) > MAX_BODY) {
    req.resume();
    throw new HttpError(413, '提交内容过大，照片需在 2MB 以内');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  check(size <= MAX_BODY, 413, '提交内容过大，照片需在 2MB 以内');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON 格式不正确'); }
  check(value && typeof value === 'object' && !Array.isArray(value), 400, '请求内容需要是 JSON 对象');
  return value;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function cookieValue(req, name) {
  return (req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export async function createApp(options = {}) {
  const db = await openDatabase(options.mysqlConfig || {});
  const now = options.now || (() => new Date());
  const origin = options.origin || process.env.APP_ORIGIN || '';
  const secure = options.cookieSecure ?? (process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production');
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === 'true';
  const registrationOpen = options.registrationOpen ?? process.env.REGISTRATION_OPEN !== 'false';
  const timeZone = options.timeZone || process.env.APP_TIMEZONE || 'Asia/Shanghai';
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => {
    const parts = Object.fromEntries(formatter.formatToParts(now()).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const timestamp = () => now().toISOString();
  const limit = rateLimiter();
  const dummyHash = `00000000000000000000000000000000:${'0'.repeat(128)}`;
  let authCleanups = 0;

  async function issueSession(res, role, userId) {
    const raw = token();
    const ttl = (role === 'parent' ? 7 : 30) * 86400;
    (await db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)')
      .run(digest(raw), role, userId, token(), now().getTime() + ttl * 1000));
    if (++authCleanups % 50 === 0) (await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now().getTime()));
    res.setHeader('Set-Cookie', `tt_${role}=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl}${secure ? '; Secure' : ''}`);
  }

  async function authenticate(req, role) {
    const raw = cookieValue(req, `tt_${role}`);
    check(raw && /^[a-f0-9]{64}$/.test(raw), 401, '请先登录');
    const session = (await db.prepare('SELECT * FROM sessions WHERE token_hash=? AND role=? AND expires_at>?')
      .get(digest(raw), role, now().getTime()));
    check(session, 401, '登录已过期，请重新登录');
    const user = (await db.prepare(`SELECT * FROM ${role === 'parent' ? 'parents' : 'children'} WHERE id=?`).get(session.user_id));
    check(user, 401, '账号不存在，请重新登录');
    if (!['GET', 'HEAD'].includes(req.method)) {
      check(req.headers['x-csrf-token'] === session.csrf_token, 403, '操作校验已过期，请刷新页面');
    }
    return { ...user, role, session };
  }

  async function ownChild(id, familyId) {
    const row = (await db.prepare('SELECT id,login_name,display_name,balance,created_at FROM children WHERE id=? AND family_id=?').get(id, familyId));
    check(row, 404, '没有找到这个孩子');
    return row;
  }

  async function addLedger(childId, delta, kind, referenceId, note) {
    const child = (await db.prepare('SELECT * FROM children WHERE id=? FOR UPDATE').get(childId));
    check(child.balance + delta >= 0 && child.balance + delta <= 1000000000, 409, '星星余额不足或已达上限');
    (await db.prepare('UPDATE children SET balance=balance+? WHERE id=?').run(delta, childId));
    (await db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), child.family_id, childId, delta, child.balance + delta, kind, referenceId, note, timestamp()));
  }

  async function getSnapshot(user) {
    const parent = user.role === 'parent';
    const family = (await db.prepare('SELECT id,name,code FROM families WHERE id=?').get(user.family_id));
    const tasks = parent
      ? (await db.prepare('SELECT * FROM tasks WHERE family_id=? ORDER BY created_at DESC,id DESC').all(user.family_id))
      : (await db.prepare('SELECT * FROM tasks WHERE child_id=? AND active=1 ORDER BY created_at DESC,id DESC').all(user.id));
    const runs = (await db.prepare(`${RUN_SELECT} WHERE r.${parent ? 'family_id' : 'child_id'}=?
      ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,
      r.claimed_at DESC,r.id DESC LIMIT 500`).all(parent ? user.family_id : user.id));
    // Fetch current occurrences separately, so a busy history cannot hide an existing claim.
    const current = (await db.prepare(`SELECT r.task_id,r.status,r.id FROM runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.${parent ? 'family_id' : 'child_id'}=? AND (r.period_key='once' OR r.period_key=?)`)
      .all(parent ? user.family_id : user.id, today()));
    const currentByTask = new Map(current.map((r) => [r.task_id, r]));
    const ledger = (await db.prepare(`SELECT l.*,c.display_name AS child_name FROM ledger l
      JOIN children c ON c.id=l.child_id WHERE l.${parent ? 'family_id' : 'child_id'}=?
      ORDER BY l.created_at DESC,l.id DESC LIMIT 100`).all(parent ? user.family_id : user.id));
    const redemptions = (await db.prepare(`SELECT r.*,c.display_name AS child_name FROM redemptions r
      JOIN children c ON c.id=r.child_id WHERE r.${parent ? 'family_id' : 'child_id'}=?
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
      r.created_at DESC,r.id DESC LIMIT 200`).all(parent ? user.family_id : user.id));
    const totals = (await db.prepare(`SELECT count(*) AS completed FROM runs
      WHERE ${parent ? 'family_id' : 'child_id'}=? AND status='approved'`).get(parent ? user.family_id : user.id));
    const pending = (await db.prepare(`SELECT count(*) AS pending FROM runs
      WHERE ${parent ? 'family_id' : 'child_id'}=? AND status='submitted'`).get(parent ? user.family_id : user.id));
    return {
      user: { id: user.id, display_name: user.display_name, role: user.role,
        ...(parent ? { username: user.username } : { login_name: user.login_name, balance: user.balance }) },
      family, csrfToken: user.session.csrf_token, today: today(), timeZone,
      children: parent ? (await db.prepare('SELECT id,login_name,display_name,balance,created_at FROM children WHERE family_id=? ORDER BY created_at,id').all(user.family_id)) : [],
      tasks: tasks.map((t) => ({ ...t, current_status: currentByTask.get(t.id)?.status || 'available',
        current_run_id: currentByTask.get(t.id)?.id || null, expired: Boolean(t.due_at && Date.parse(t.due_at) < now().getTime()) })),
      runs, rewards: (await db.prepare(`SELECT * FROM rewards WHERE family_id=?${parent ? '' : ' AND active=1'} ORDER BY created_at,id`).all(user.family_id)),
      redemptions, ledger, stats: { ...totals, ...pending }, serverTime: timestamp(),
    };
  }

  async function handleApi(req, res, path) {
    const ip = trustProxy ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
    const time = now().getTime();
    limit(`all:${ip}`, 600, 60000, time);
    if (!['GET', 'HEAD'].includes(req.method)) {
      const allowed = origin ? new URL(origin).origin : `http://${req.headers.host}`;
      check(!req.headers.origin || req.headers.origin === allowed, 403, '不允许跨站操作');
    }
    if (path === '/health' && req.method === 'GET') {
      (await db.prepare('SELECT 1').get());
      return json(res, 200, { ok: true });
    }
    if (path === '/config' && req.method === 'GET') {
      return json(res, 200, { registrationOpen, timeZone, version: '1.0.0' });
    }
    if (path.startsWith('/auth/') && req.method === 'POST') {
      limit(`auth-ip:${ip}`, 40, 15 * 60000, time);
      const input = await body(req);
      if (path === '/auth/parent/register') {
        check(registrationOpen, 403, '当前未开放新家庭注册');
        limit(`register:${ip}`, 5, 3600000, time);
        const name = username(input.username);
        const display = text(input.displayName, '家长称呼', { max: 24 });
        const familyName = text(input.familyName || `${display}的家`, '家庭名称', { max: 30 });
        const hash = await hashPassword(password(input.password));
        check(!(await db.prepare('SELECT id FROM parents WHERE username=?').get(name)), 409, '这个家长账号已被使用');
        const id = randomUUID();
        const familyId = randomUUID();
        await transaction(db, async () => {
          (await db.prepare('INSERT INTO families VALUES (?,?,?,?)').run(familyId, randomBytes(5).toString('hex').toUpperCase(), familyName, timestamp()));
          (await db.prepare('INSERT INTO parents VALUES (?,?,?,?,?,?)').run(id, familyId, name, display, hash, timestamp()));
        });
        await issueSession(res, 'parent', id);
        return json(res, 201, { ok: true });
      }
      if (path === '/auth/parent/login') {
        const name = username(input.username);
        const secret = password(input.password);
        limit(`parent-name:${name}`, 15, 15 * 60000, time);
        const user = (await db.prepare('SELECT * FROM parents WHERE username=?').get(name));
        const valid = await verifyPassword(secret, user?.password_hash || dummyHash);
        check(user && valid, 401, '账号或密码不正确');
        check((await db.prepare('SELECT password_hash FROM parents WHERE id=?').get(user.id))?.password_hash === user.password_hash, 401, '密码已更改，请重新登录');
        await issueSession(res, 'parent', user.id);
        return json(res, 200, { ok: true });
      }
      if (path === '/auth/kid/login') {
        const code = text(input.familyCode, '家庭码', { min: 10, max: 10 }).toUpperCase();
        const name = username(input.loginName, true);
        const secret = pin(input.pin);
        limit(`kid-name:${code}:${name}`, 10, 15 * 60000, time);
        const user = (await db.prepare('SELECT c.* FROM children c JOIN families f ON f.id=c.family_id WHERE f.code=? AND c.login_name=?').get(code, name));
        const valid = await verifyPassword(secret, user?.pin_hash || dummyHash);
        check(user && valid, 401, '家庭码、孩子账号或口令不正确');
        check((await db.prepare('SELECT pin_hash FROM children WHERE id=?').get(user.id))?.pin_hash === user.pin_hash, 401, '口令已更改，请重新登录');
        await issueSession(res, 'kid', user.id);
        return json(res, 200, { ok: true });
      }
      throw new HttpError(404, '接口不存在');
    }

    const role = path.startsWith('/parent/') ? 'parent' : path.startsWith('/kid/') ? 'kid' : null;
    check(role, 404, '接口不存在');
    const user = await authenticate(req, role);
    const action = path.slice(role.length + 1);
    if (action === '/snapshot' && req.method === 'GET') return json(res, 200, await getSnapshot(user));
    if (action === '/logout' && req.method === 'POST') {
      (await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.session.token_hash));
      res.setHeader('Set-Cookie', `tt_${role}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    let match;
    if ((match = /^\/runs\/([\w-]+)\/photo$/.exec(action)) && req.method === 'GET') {
      const run = (await db.prepare('SELECT * FROM runs WHERE id=? AND family_id=?').get(match[1], user.family_id));
      check(run && (role === 'parent' || run.child_id === user.id) && run.photo, 404, '照片不存在');
      res.writeHead(200, { 'Content-Type': run.photo_type, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
      return res.end(Buffer.from(run.photo));
    }

    if (role === 'parent') {
      if (action === '/children' && req.method === 'POST') {
        const input = await body(req);
        const login = username(input.loginName, true);
        const display = text(input.displayName, '孩子昵称', { max: 24 });
        check((await db.prepare('SELECT count(*) AS n FROM children WHERE family_id=?').get(user.family_id)).n < 20, 409, '每个家庭最多添加 20 个孩子');
        const hash = await hashPassword(pin(input.pin));
        check(!(await db.prepare('SELECT id FROM children WHERE family_id=? AND login_name=?').get(user.family_id, login)), 409, '这个孩子账号已存在');
        const id = randomUUID();
        (await db.prepare('INSERT INTO children VALUES (?,?,?,?,?,0,?)').run(id, user.family_id, login, display, hash, timestamp()));
        return json(res, 201, { id });
      }
      if ((match = /^\/children\/([\w-]+)\/pin$/.exec(action)) && req.method === 'POST') {
        const input = await body(req);
        await ownChild(match[1], user.family_id);
        const hash = await hashPassword(pin(input.pin));
        await transaction(db, async () => {
          (await db.prepare('UPDATE children SET pin_hash=? WHERE id=?').run(hash, match[1]));
          (await db.prepare("DELETE FROM sessions WHERE role='kid' AND user_id=?").run(match[1]));
        });
        return json(res, 200, { ok: true });
      }
      if (action === '/password' && req.method === 'POST') {
        const input = await body(req);
        check(await verifyPassword(password(input.currentPassword), user.password_hash), 400, '原密码不正确');
        const hash = await hashPassword(password(input.newPassword));
        await transaction(db, async () => {
          (await db.prepare('UPDATE parents SET password_hash=? WHERE id=?').run(hash, user.id));
          (await db.prepare("DELETE FROM sessions WHERE role='parent' AND user_id=?").run(user.id));
        });
        await issueSession(res, 'parent', user.id);
        return json(res, 200, { ok: true });
      }
      if (action === '/tasks' && req.method === 'POST') {
        const input = await body(req);
        const childId = text(input.childId, '孩子', { max: 36 });
        await ownChild(childId, user.family_id);
        const title = text(input.title, '任务名称', { max: 40 });
        const description = text(input.description || '', '任务说明', { min: 0, max: 500 });
        check(CATEGORIES.includes(input.category), 400, '任务类别不正确');
        const reward = integer(input.reward, '悬赏星星', 1, 1000);
        check(['once', 'daily'].includes(input.recurrence), 400, '重复方式不正确');
        check(typeof input.photoRequired === 'boolean', 400, '照片要求格式不正确');
        let due = null;
        if (input.dueAt) {
          check(input.recurrence === 'once', 400, '每日任务不设置单次截止时间');
          check(typeof input.dueAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.dueAt) && Number.isFinite(Date.parse(input.dueAt)), 400, '截止时间需要使用带时区的 ISO 格式');
          check(Date.parse(input.dueAt) > time, 400, '截止时间需要晚于现在');
          due = new Date(input.dueAt).toISOString();
        }
        const id = randomUUID();
        (await db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,1,?)')
          .run(id, user.family_id, childId, title, description, input.category, reward, input.recurrence, due, Number(input.photoRequired), timestamp()));
        return json(res, 201, { id });
      }
      if ((match = /^\/tasks\/([\w-]+)$/.exec(action)) && req.method === 'PATCH') {
        const input = await body(req);
        check(typeof input.active === 'boolean', 400, '任务开关格式不正确');
        const task = (await db.prepare('SELECT * FROM tasks WHERE id=? AND family_id=?').get(match[1], user.family_id));
        check(task, 404, '任务不存在');
        (await db.prepare('UPDATE tasks SET active=? WHERE id=?').run(Number(input.active), task.id));
        return json(res, 200, { ok: true });
      }
      if ((match = /^\/runs\/([\w-]+)\/review$/.exec(action)) && req.method === 'POST') {
        const input = await body(req);
        check(['approve', 'return'].includes(input.decision), 400, '验收操作不正确');
        const comment = text(input.comment || '', '验收留言', { min: input.decision === 'return' ? 1 : 0, max: 300 });
        const result = await transaction(db, async () => {
          const run = (await db.prepare('SELECT r.*,t.reward,t.title FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=? AND r.family_id=? FOR UPDATE').get(match[1], user.family_id));
          check(run, 404, '任务记录不存在');
          if (run.status === 'approved' && input.decision === 'approve') return { ok: true, alreadyApproved: true };
          check(run.status === 'submitted', 409, '任务当前不在等待验收，请刷新');
          if (input.decision === 'approve') {
            await addLedger(run.child_id, run.reward, 'task_reward', run.id, `完成任务：${run.title}`);
            (await db.prepare("UPDATE runs SET status='approved',review_comment=?,reviewed_at=?,reviewer_id=? WHERE id=?")
              .run(comment, timestamp(), user.id, run.id));
          } else {
            (await db.prepare("UPDATE runs SET status='claimed',review_comment=?,reviewed_at=?,reviewer_id=? WHERE id=?")
              .run(comment, timestamp(), user.id, run.id));
          }
          return { ok: true };
        });
        return json(res, 200, result);
      }
      if (action === '/rewards' && req.method === 'POST') {
        const input = await body(req);
        const title = text(input.title, '愿望名称', { max: 40 });
        const price = integer(input.price, '兑换星星', 1, 100000);
        check(ICONS.includes(input.icon), 400, '请选择支持的愿望图标');
        const id = randomUUID();
        (await db.prepare('INSERT INTO rewards VALUES (?,?,?,?,?,1,?)').run(id, user.family_id, title, price, input.icon, timestamp()));
        return json(res, 201, { id });
      }
      if ((match = /^\/rewards\/([\w-]+)$/.exec(action)) && req.method === 'PATCH') {
        const input = await body(req);
        check(typeof input.active === 'boolean', 400, '愿望开关格式不正确');
        check((await db.prepare('SELECT id FROM rewards WHERE id=? AND family_id=?').get(match[1], user.family_id)), 404, '愿望不存在');
        (await db.prepare('UPDATE rewards SET active=? WHERE id=?').run(Number(input.active), match[1]));
        return json(res, 200, { ok: true });
      }
      if ((match = /^\/redemptions\/([\w-]+)\/review$/.exec(action)) && req.method === 'POST') {
        const input = await body(req);
        check(['fulfilled', 'rejected'].includes(input.decision), 400, '兑现操作不正确');
        const comment = text(input.comment || '', '兑现留言', { min: input.decision === 'rejected' ? 1 : 0, max: 300 });
        await transaction(db, async () => {
          const item = (await db.prepare('SELECT * FROM redemptions WHERE id=? AND family_id=? FOR UPDATE').get(match[1], user.family_id));
          check(item, 404, '兑换记录不存在');
          if (item.status === input.decision) return;
          check(item.status === 'pending', 409, '这条兑换已处理');
          if (input.decision === 'rejected') await addLedger(item.child_id, item.price, 'redemption_refund', item.id, `退还星星：${item.title}`);
          (await db.prepare('UPDATE redemptions SET status=?,comment=?,reviewed_at=? WHERE id=?')
            .run(input.decision, comment, timestamp(), item.id));
        });
        return json(res, 200, { ok: true });
      }
      if (action === '/export' && req.method === 'GET') {
        const snapshot = await getSnapshot(user);
        delete snapshot.csrfToken;
        // Exports contain the full business history. They never contain credentials or sessions.
        snapshot.runs = (await db.prepare(`${RUN_SELECT} WHERE r.family_id=? ORDER BY r.claimed_at,r.id`).all(user.family_id));
        snapshot.ledger = (await db.prepare('SELECT * FROM ledger WHERE family_id=? ORDER BY created_at,id').all(user.family_id));
        snapshot.redemptions = (await db.prepare('SELECT * FROM redemptions WHERE family_id=? ORDER BY created_at,id').all(user.family_id));
        res.setHeader('Content-Disposition', 'attachment; filename="task-town-export.json"');
        return json(res, 200, snapshot);
      }
    }

    if (role === 'kid') {
      if ((match = /^\/tasks\/([\w-]+)\/claim$/.exec(action)) && req.method === 'POST') {
        await body(req);
        const result = await transaction(db, async () => {
          const task = (await db.prepare('SELECT * FROM tasks WHERE id=? AND child_id=? AND active=1 FOR UPDATE').get(match[1], user.id));
          check(task, 404, '这个任务暂时不能领取');
          const period = task.recurrence === 'daily' ? today() : 'once';
          const existing = (await db.prepare('SELECT id FROM runs WHERE task_id=? AND child_id=? AND period_key=?').get(task.id, user.id, period));
          if (existing) return { id: existing.id, alreadyClaimed: true };
          check(!task.due_at || Date.parse(task.due_at) >= now().getTime(), 409, '任务已过期，请让家长发布新任务');
          const id = randomUUID();
          (await db.prepare('INSERT INTO runs (id,task_id,family_id,child_id,period_key,status,claimed_at) VALUES (?,?,?,?,?,?,?)')
            .run(id, task.id, user.family_id, user.id, period, 'claimed', timestamp()));
          return { id };
        });
        return json(res, 200, result);
      }
      if ((match = /^\/runs\/([\w-]+)\/submit$/.exec(action)) && req.method === 'POST') {
        const input = await body(req);
        const note = text(input.note || '', '打卡留言', { min: 0, max: 300 });
        const photo = parsePhoto(input.photo);
        await transaction(db, async () => {
          const run = (await db.prepare('SELECT r.*,t.photo_required FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=? AND r.child_id=? FOR UPDATE').get(match[1], user.id));
          check(run, 404, '没有找到这个任务');
          check(run.status === 'claimed', 409, '这个任务已提交或已完成');
          check(!run.photo_required || photo.bytes, 400, '这个任务需要上传一张照片');
          (await db.prepare("UPDATE runs SET status='submitted',note=?,photo=?,photo_type=?,submitted_at=?,review_comment='',reviewed_at=NULL,reviewer_id=NULL WHERE id=?")
            .run(note, photo.bytes, photo.type, timestamp(), run.id));
        });
        return json(res, 200, { ok: true });
      }
      if (action === '/redemptions' && req.method === 'POST') {
        const input = await body(req);
        const rewardId = text(input.rewardId, '愿望', { max: 36 });
        const requestKey = text(input.requestKey, '请求编号', { min: 16, max: 80 });
        const result = await transaction(db, async () => {
          await db.prepare('SELECT id FROM children WHERE id=? FOR UPDATE').get(user.id);
          const existing = (await db.prepare('SELECT id,reward_id FROM redemptions WHERE child_id=? AND request_key=?').get(user.id, requestKey));
          if (existing) {
            check(existing.reward_id === rewardId, 409, '兑换请求编号重复');
            return { id: existing.id, alreadyRequested: true };
          }
          const reward = (await db.prepare('SELECT * FROM rewards WHERE id=? AND family_id=? AND active=1').get(rewardId, user.family_id));
          check(reward, 404, '这个愿望暂时下架了');
          const id = randomUUID();
          await addLedger(user.id, -reward.price, 'redemption', id, `申请兑换：${reward.title}`);
          (await db.prepare('INSERT INTO redemptions VALUES (?,?,?,?,?,?,?,\'pending\',\'\',?,NULL)')
            .run(id, user.family_id, user.id, reward.id, reward.title, reward.price, requestKey, timestamp()));
          return { id };
        });
        return json(res, 201, result);
      }
    }
    throw new HttpError(404, '接口不存在');
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path.startsWith('/api/v1')) return await handleApi(req, res, path.slice(7));
      check(['GET', 'HEAD'].includes(req.method), 405, '请求方法不支持');
      const pathname = path === '/' ? '/index.html' : path === '/parent' ? '/parent.html' : path === '/kid' ? '/kid.html' : path;
      check(/^\/(?:index\.html|parent\.html|kid\.html|favicon\.svg|(?:css|js)\/[a-z0-9-]+\.(?:css|js))$/.test(pathname), 404, '页面不存在');
      let file;
      try { file = await readFile(join(publicDir, pathname.slice(1))); }
      catch { throw new HttpError(404, '页面不存在'); }
      const ext = pathname.split('.').at(-1);
      const type = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' }[ext];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'Content-Length': file.length });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error.code === 'ER_DUP_ENTRY') error = new HttpError(409, '这条记录已存在，请刷新后重试');
      if (!(error instanceof HttpError)) console.error('Request failed:', error);
      json(res, error.status || 500, { error: error.status ? error.message : '服务暂时遇到问题，请稍后重试' });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return { server, db, close: async () => {
    if (server.listening) await new Promise((r, reject) => {
      server.close((error) => error ? reject(error) : r());
      server.closeIdleConnections();
    });
    await db.close();
  } };
}
