import { HttpError, check, text, integer, username, password, pin, hashPassword, verifyPassword, token, digest, body, parsePhoto } from './town-security.mjs';

const CATEGORIES = ['家务小帮手', '自理小达人', '学习小标兵', '运动小健将', '爱心小天使'];
const ICONS = ['🎁', '🍦', '📺', '🎡', '📚', '⚽', '🧸', '🎨'];
const RUN_SELECT = `SELECT r.id,r.task_id,r.child_id,r.period_key,r.status,r.note,
  r.review_comment,r.photo IS NOT NULL AS has_photo,r.claimed_at,r.submitted_at,
  r.reviewed_at,t.title,t.description,t.category,t.reward,t.photo_required,
  t.recurrence,t.due_at,c.display_name AS child_name
  FROM runs r JOIN tasks t ON t.id=r.task_id JOIN children c ON c.id=r.child_id`;
const timeZone = 'Asia/Shanghai';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const todayFor = date => {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const changes = result => result.meta.changes;
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
};

export async function handleApi(request, env, options = {}) {
  const url = new URL(request.url);
  const path = url.pathname.slice('/api/v1'.length);
  const now = options.now || new Date(); const stamp = now.toISOString();
  const today = todayFor(now); const time = now.getTime();
  const responseHeaders = new Headers(securityHeaders);
  const json = (status, value) => {
    responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(value), { status, headers: responseHeaders });
  };
  try {
    check(env.DB, 503, '云端数据库尚未连接，请稍后重试');
    const db = env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
    const prepare = (sql, ...args) => db.prepare(sql).bind(...args);
    const one = (sql, ...args) => prepare(sql, ...args).first();
    const all = async (sql, ...args) => (await prepare(sql, ...args).all()).results;
    const run = (sql, ...args) => prepare(sql, ...args).run();
    const batch = statements => db.batch(statements);
    const registrationOpen = env.REGISTRATION_OPEN !== 'false';
    const ip = request.headers.get('cf-connecting-ip') || 'preview';
    async function limit(key, maximum, window) {
      const hashed = await digest(key);
      const row = await prepare(`INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN expires_at<=? THEN 1 ELSE hits+1 END,
        expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING hits`,
        hashed, time + window, time, time).first();
      check(row.hits <= maximum, 429, '尝试次数过多，请稍后再试');
    }
    if (path === '/health' && request.method === 'GET') {
      await one('SELECT 1 AS ok'); return json(200, { ok: true, storage: 'sites' });
    }
    if (path === '/config' && request.method === 'GET') return json(200, { registrationOpen, timeZone, version: '1.0.0-cloud' });
    await limit(`all:${ip}`, 600, 60000);
    if (!['GET', 'HEAD'].includes(request.method)) {
      check(!request.headers.get('origin') || request.headers.get('origin') === url.origin, 403, '不允许跨站操作');
    }
    async function sessionData(role, userId, credential) {
      const raw = token(); const ttl = (role === 'parent' ? 7 : 30) * 86400;
      return { raw, ttl, role, userId, credential, hash: await digest(raw), csrf: token(), expires: time + ttl * 1000 };
    }
    function sessionStatement(data) {
      const table = data.role === 'parent' ? 'parents' : 'children';
      const field = data.role === 'parent' ? 'password_hash' : 'pin_hash';
      return prepare(`INSERT INTO sessions(token_hash,role,user_id,credential_hash,csrf_token,expires_at)
        SELECT ?,?,?,?,?,? FROM ${table} WHERE id=? AND ${field}=?`,
        data.hash, data.role, data.userId, data.credential, data.csrf, data.expires, data.userId, data.credential);
    }
    function setSession(data) {
      responseHeaders.append('Set-Cookie', `tt_${data.role}=${data.raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${data.ttl}${url.protocol === 'https:' ? '; Secure' : ''}`);
    }
    async function issueSession(role, user) {
      const data = await sessionData(role, user.id, role === 'parent' ? user.password_hash : user.pin_hash);
      check(changes(await sessionStatement(data).run()) === 1, 401, '登录信息已更改，请重新登录');
      setSession(data);
    }
    async function authenticate(role) {
      const raw = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`tt_${role}=`))?.slice(role.length + 4);
      check(raw && /^[a-f0-9]{64}$/.test(raw), 401, '请先登录');
      const session = await one('SELECT * FROM sessions WHERE token_hash=? AND role=? AND expires_at>?', await digest(raw), role, time);
      check(session, 401, '登录已过期，请重新登录');
      const user = await one(`SELECT * FROM ${role === 'parent' ? 'parents' : 'children'} WHERE id=?`, session.user_id);
      check(user && session.credential_hash === (role === 'parent' ? user.password_hash : user.pin_hash), 401, '登录信息已更改，请重新登录');
      if (!['GET', 'HEAD'].includes(request.method)) check(request.headers.get('x-csrf-token') === session.csrf_token, 403, '操作校验已过期，请刷新页面');
      return { ...user, role, session };
    }
    async function ownChild(id, familyId) {
      const row = await one('SELECT id,login_name,display_name,balance,created_at FROM children WHERE id=? AND family_id=?', id, familyId);
      check(row, 404, '没有找到这个孩子'); return row;
    }
    async function snapshot(user, full = false) {
      const parent = user.role === 'parent'; const key = parent ? user.family_id : user.id;
      const column = parent ? 'family_id' : 'child_id';
      const results = await batch([
        prepare('SELECT id,name,code FROM families WHERE id=?', user.family_id),
        parent ? prepare('SELECT * FROM tasks WHERE family_id=? ORDER BY created_at DESC,id DESC', key)
          : prepare('SELECT * FROM tasks WHERE child_id=? AND active=1 ORDER BY created_at DESC,id DESC', key),
        prepare(`${RUN_SELECT} WHERE r.${column}=? ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,r.claimed_at DESC,r.id DESC ${full ? '' : 'LIMIT 500'}`, key),
        prepare(`SELECT r.task_id,r.status,r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.${column}=? AND (r.period_key='once' OR r.period_key=?)`, key, today),
        prepare(`SELECT l.*,c.display_name AS child_name FROM ledger l JOIN children c ON c.id=l.child_id WHERE l.${column}=? ORDER BY l.created_at DESC,l.id DESC ${full ? '' : 'LIMIT 100'}`, key),
        prepare(`SELECT r.*,c.display_name AS child_name FROM redemptions r JOIN children c ON c.id=r.child_id WHERE r.${column}=? ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC ${full ? '' : 'LIMIT 200'}`, key),
        prepare(`SELECT count(*) AS completed,sum(CASE WHEN status='submitted' THEN 1 ELSE 0 END) AS pending FROM runs WHERE ${column}=?`, key),
        prepare('SELECT id,login_name,display_name,balance,created_at FROM children WHERE family_id=? ORDER BY created_at,id', user.family_id),
        prepare(`SELECT count(*) AS completed FROM runs WHERE ${column}=? AND status='approved'`, key),
        prepare(`SELECT * FROM rewards WHERE family_id=?${parent ? '' : ' AND active=1'} ORDER BY created_at,id`, user.family_id),
      ]);
      const rows = results.map(r => r.results); const current = new Map(rows[3].map(r => [r.task_id, r]));
      const balance = parent ? undefined : rows[7].find(c => c.id === user.id)?.balance;
      return {
        user: { id: user.id, display_name: user.display_name, role: user.role, ...(parent ? { username: user.username } : { login_name: user.login_name, balance }) },
        family: rows[0][0], ...(full ? {} : { csrfToken: user.session.csrf_token }), today, timeZone,
        children: parent ? rows[7] : [],
        tasks: rows[1].map(task => ({ ...task, current_status: current.get(task.id)?.status || 'available',
          current_run_id: current.get(task.id)?.id || null, expired: Boolean(task.due_at && Date.parse(task.due_at) < time) })),
        runs: rows[2], rewards: rows[9], ledger: rows[4], redemptions: rows[5], stats: { completed: rows[8][0].completed, pending: rows[6][0].pending || 0 }, serverTime: stamp,
      };
    }
    if (path.startsWith('/auth/') && request.method === 'POST') {
      await limit(`auth-ip:${ip}`, 40, 15 * 60000);
      const input = await body(request);
      if (path === '/auth/parent/register') {
        check(registrationOpen, 403, '当前未开放新家庭注册'); await limit(`register:${ip}`, 5, 3600000);
        const name = username(input.username); const display = text(input.displayName, '家长称呼', { max: 24 });
        const familyName = text(input.familyName || `${display}的家`, '家庭名称', { max: 30 });
        const hash = await hashPassword(password(input.password));
        const id = crypto.randomUUID(); const familyId = crypto.randomUUID();
        const session = await sessionData('parent', id, hash);
        await batch([
          prepare('INSERT INTO families VALUES (?,?,?,?)', familyId, token(5).toUpperCase(), familyName, stamp),
          prepare('INSERT INTO parents VALUES (?,?,?,?,?,?)', id, familyId, name, display, hash, stamp), sessionStatement(session),
        ]);
        setSession(session); return json(201, { ok: true });
      }
      if (path === '/auth/parent/login') {
        const name = username(input.username); const secret = password(input.password);
        await limit(`parent-name:${name}`, 15, 15 * 60000);
        const user = await one('SELECT * FROM parents WHERE username=?', name);
        const valid = await verifyPassword(secret, user?.password_hash);
        check(user && valid, 401, '账号或密码不正确'); await issueSession('parent', user); return json(200, { ok: true });
      }
      if (path === '/auth/kid/login') {
        const code = text(input.familyCode, '家庭码', { min: 10, max: 10 }).toUpperCase();
        const name = username(input.loginName, true); const secret = pin(input.pin);
        await limit(`kid-name:${code}:${name}`, 10, 15 * 60000);
        const user = await one('SELECT c.* FROM children c JOIN families f ON f.id=c.family_id WHERE f.code=? AND c.login_name=?', code, name);
        const valid = await verifyPassword(secret, user?.pin_hash);
        check(user && valid, 401, '家庭码、孩子账号或口令不正确'); await issueSession('kid', user); return json(200, { ok: true });
      }
      throw new HttpError(404, '接口不存在');
    }
    const role = path.startsWith('/parent/') ? 'parent' : path.startsWith('/kid/') ? 'kid' : null;
    check(role, 404, '接口不存在'); const user = await authenticate(role); const action = path.slice(role.length + 1);
    if (action === '/snapshot' && request.method === 'GET') return json(200, await snapshot(user));
    if (action === '/logout' && request.method === 'POST') {
      await run('DELETE FROM sessions WHERE token_hash=?', user.session.token_hash);
      responseHeaders.append('Set-Cookie', `tt_${role}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`);
      return json(200, { ok: true });
    }
    let match;
    if ((match = /^\/runs\/([\w-]+)\/photo$/.exec(action)) && request.method === 'GET') {
      const item = await one('SELECT * FROM runs WHERE id=? AND family_id=?', match[1], user.family_id);
      check(item && (role === 'parent' || item.child_id === user.id) && item.photo, 404, '照片不存在');
      check(env.BUCKET, 503, '照片存储尚未连接'); const photo = await env.BUCKET.get(item.photo);
      check(photo, 404, '照片不存在');
      responseHeaders.set('Content-Type', item.photo_type); responseHeaders.set('Content-Disposition', 'inline');
      return new Response(photo.body, { headers: responseHeaders });
    }
    if (role === 'parent') {
      if (action === '/children' && request.method === 'POST') {
        const input = await body(request); const login = username(input.loginName, true);
        const display = text(input.displayName, '孩子昵称', { max: 24 }); const hash = await hashPassword(pin(input.pin));
        const id = crypto.randomUUID();
        await run('INSERT INTO children VALUES (?,?,?,?,?,0,?)', id, user.family_id, login, display, hash, stamp); return json(201, { id });
      }
      if ((match = /^\/children\/([\w-]+)\/pin$/.exec(action)) && request.method === 'POST') {
        const input = await body(request); await ownChild(match[1], user.family_id); const hash = await hashPassword(pin(input.pin));
        await batch([prepare('UPDATE children SET pin_hash=? WHERE id=? AND family_id=?', hash, match[1], user.family_id),
          prepare("DELETE FROM sessions WHERE role='kid' AND user_id=?", match[1])]); return json(200, { ok: true });
      }
      if (action === '/password' && request.method === 'POST') {
        const input = await body(request);
        check(await verifyPassword(password(input.currentPassword), user.password_hash), 400, '原密码不正确');
        const hash = await hashPassword(password(input.newPassword)); const session = await sessionData('parent', user.id, hash);
        const result = await batch([
          prepare('UPDATE parents SET password_hash=? WHERE id=? AND password_hash=?', hash, user.id, user.password_hash),
          prepare("DELETE FROM sessions WHERE role='parent' AND user_id=? AND credential_hash!=? AND EXISTS (SELECT 1 FROM parents WHERE id=? AND password_hash=?)", user.id, hash, user.id, hash), sessionStatement(session),
        ]);
        check(changes(result[0]) === 1 && changes(result[2]) === 1, 409, '密码已更改，请重新登录');
        setSession(session); return json(200, { ok: true });
      }
      if (action === '/tasks' && request.method === 'POST') {
        const input = await body(request); const childId = text(input.childId, '孩子', { max: 36 }); await ownChild(childId, user.family_id);
        const title = text(input.title, '任务名称', { max: 40 }); const description = text(input.description || '', '任务说明', { min: 0, max: 500 });
        check(CATEGORIES.includes(input.category), 400, '任务类别不正确'); const reward = integer(input.reward, '悬赏星星', 1, 1000);
        check(['once', 'daily'].includes(input.recurrence), 400, '重复方式不正确'); check(typeof input.photoRequired === 'boolean', 400, '照片要求格式不正确');
        let due = null;
        if (input.dueAt) {
          check(input.recurrence === 'once', 400, '每日任务不设置单次截止时间');
          check(typeof input.dueAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.dueAt) && Number.isFinite(Date.parse(input.dueAt)), 400, '截止时间需要使用带时区的 ISO 格式');
          check(Date.parse(input.dueAt) > time, 400, '截止时间需要晚于现在'); due = new Date(input.dueAt).toISOString();
        }
        const id = crypto.randomUUID();
        await run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,1,?)', id, user.family_id, childId, title, description, input.category, reward, input.recurrence, due, Number(input.photoRequired), stamp);
        return json(201, { id });
      }
      if ((match = /^\/tasks\/([\w-]+)$/.exec(action)) && request.method === 'PATCH') {
        const input = await body(request); check(typeof input.active === 'boolean', 400, '任务开关格式不正确');
        check(changes(await run('UPDATE tasks SET active=? WHERE id=? AND family_id=?', Number(input.active), match[1], user.family_id)) === 1, 404, '任务不存在'); return json(200, { ok: true });
      }
      if ((match = /^\/runs\/([\w-]+)\/review$/.exec(action)) && request.method === 'POST') {
        const input = await body(request); check(['approve', 'return'].includes(input.decision), 400, '验收操作不正确');
        const comment = text(input.comment || '', '验收留言', { min: input.decision === 'return' ? 1 : 0, max: 300 });
        const result = await run("UPDATE runs SET status=?,review_comment=?,reviewed_at=?,reviewer_id=? WHERE id=? AND family_id=? AND status='submitted'",
          input.decision === 'approve' ? 'approved' : 'claimed', comment, stamp, user.id, match[1], user.family_id);
        if (changes(result) === 0) {
          const current = await one('SELECT status FROM runs WHERE id=? AND family_id=?', match[1], user.family_id);
          check(current, 404, '任务记录不存在');
          if (current.status === 'approved' && input.decision === 'approve') return json(200, { ok: true, alreadyApproved: true });
          throw new HttpError(409, '任务当前不在等待验收，请刷新');
        }
        return json(200, { ok: true });
      }
      if (action === '/rewards' && request.method === 'POST') {
        const input = await body(request); const title = text(input.title, '愿望名称', { max: 40 }); const price = integer(input.price, '兑换星星', 1, 100000);
        check(ICONS.includes(input.icon), 400, '请选择支持的愿望图标'); const id = crypto.randomUUID();
        await run('INSERT INTO rewards VALUES (?,?,?,?,?,1,?)', id, user.family_id, title, price, input.icon, stamp); return json(201, { id });
      }
      if ((match = /^\/rewards\/([\w-]+)$/.exec(action)) && request.method === 'PATCH') {
        const input = await body(request); check(typeof input.active === 'boolean', 400, '愿望开关格式不正确');
        check(changes(await run('UPDATE rewards SET active=? WHERE id=? AND family_id=?', Number(input.active), match[1], user.family_id)) === 1, 404, '愿望不存在'); return json(200, { ok: true });
      }
      if ((match = /^\/redemptions\/([\w-]+)\/review$/.exec(action)) && request.method === 'POST') {
        const input = await body(request); check(['fulfilled', 'rejected'].includes(input.decision), 400, '兑现操作不正确');
        const comment = text(input.comment || '', '兑现留言', { min: input.decision === 'rejected' ? 1 : 0, max: 300 });
        const result = await run("UPDATE redemptions SET status=?,comment=?,reviewed_at=? WHERE id=? AND family_id=? AND status='pending'", input.decision, comment, stamp, match[1], user.family_id);
        if (changes(result) === 0) {
          const item = await one('SELECT status FROM redemptions WHERE id=? AND family_id=?', match[1], user.family_id);
          check(item, 404, '兑换记录不存在'); check(item.status === input.decision, 409, '这条兑换已处理');
        }
        return json(200, { ok: true });
      }
      if (action === '/export' && request.method === 'GET') {
        responseHeaders.set('Content-Disposition', 'attachment; filename="task-town-export.json"'); return json(200, await snapshot(user, true));
      }
    }
    if (role === 'kid') {
      if ((match = /^\/tasks\/([\w-]+)\/claim$/.exec(action)) && request.method === 'POST') {
        await body(request); const task = await one('SELECT * FROM tasks WHERE id=? AND child_id=? AND active=1', match[1], user.id);
        check(task, 404, '这个任务暂时不能领取'); const period = task.recurrence === 'daily' ? today : 'once';
        const existing = await one('SELECT id FROM runs WHERE task_id=? AND child_id=? AND period_key=?', task.id, user.id, period);
        if (existing) return json(200, { id: existing.id, alreadyClaimed: true });
        check(!task.due_at || Date.parse(task.due_at) >= time, 409, '任务已过期，请让家长发布新任务'); const id = crypto.randomUUID();
        await run(`INSERT INTO runs (id,task_id,family_id,child_id,period_key,status,claimed_at)
          SELECT ?,id,family_id,child_id,?,'claimed',? FROM tasks WHERE id=? AND child_id=? AND active=1 AND (due_at IS NULL OR due_at>=?)
          ON CONFLICT(task_id,child_id,period_key) DO NOTHING`, id, period, stamp, task.id, user.id, stamp);
        const item = await one('SELECT id FROM runs WHERE task_id=? AND child_id=? AND period_key=?', task.id, user.id, period);
        check(item, 409, '这个任务暂时不能领取'); return json(200, { id: item.id, ...(item.id === id ? {} : { alreadyClaimed: true }) });
      }
      if ((match = /^\/runs\/([\w-]+)\/submit$/.exec(action)) && request.method === 'POST') {
        const input = await body(request); const note = text(input.note || '', '打卡留言', { min: 0, max: 300 }); const photo = parsePhoto(input.photo);
        const item = await one('SELECT r.*,t.photo_required FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=? AND r.child_id=?', match[1], user.id);
        check(item, 404, '没有找到这个任务'); check(item.status === 'claimed', 409, '这个任务已提交或已完成'); check(!item.photo_required || photo, 400, '这个任务需要上传一张照片');
        let key = null; let stored = false;
        if (photo) {
          check(env.BUCKET, 503, '照片存储尚未连接'); key = `photos/${user.family_id}/${item.id}/${token(16)}`;
          await env.BUCKET.put(key, photo.bytes, { httpMetadata: { contentType: photo.type } });
        }
        try {
          const result = await run("UPDATE runs SET status='submitted',note=?,photo=?,photo_type=?,submitted_at=?,review_comment='',reviewed_at=NULL,reviewer_id=NULL WHERE id=? AND child_id=? AND status='claimed'", note, key, photo?.type || null, stamp, item.id, user.id);
          check(changes(result) === 1, 409, '这个任务已提交或已完成'); stored = true;
        } finally { if (key && !stored) await env.BUCKET.delete(key).catch(() => {}); }
        if (item.photo) await env.BUCKET.delete(item.photo).catch(() => {});
        return json(200, { ok: true });
      }
      if (action === '/redemptions' && request.method === 'POST') {
        const input = await body(request); const rewardId = text(input.rewardId, '愿望', { max: 36 }); const requestKey = text(input.requestKey, '请求编号', { min: 16, max: 80 });
        const existing = await one('SELECT id,reward_id FROM redemptions WHERE child_id=? AND request_key=?', user.id, requestKey);
        if (existing) { check(existing.reward_id === rewardId, 409, '兑换请求编号重复'); return json(201, { id: existing.id, alreadyRequested: true }); }
        const id = crypto.randomUUID();
        await run(`INSERT INTO redemptions(id,family_id,child_id,reward_id,title,price,request_key,status,comment,created_at)
          SELECT ?,family_id,?,id,title,price,?,'pending','',? FROM rewards WHERE id=? AND family_id=? AND active=1
          ON CONFLICT(child_id,request_key) DO NOTHING`, id, user.id, requestKey, stamp, rewardId, user.family_id);
        const item = await one('SELECT id,reward_id FROM redemptions WHERE child_id=? AND request_key=?', user.id, requestKey);
        check(item, 404, '这个愿望暂时下架了'); check(item.reward_id === rewardId, 409, '兑换请求编号重复');
        return json(201, { id: item.id, ...(item.id === id ? {} : { alreadyRequested: true }) });
      }
    }
    throw new HttpError(404, '接口不存在');
  } catch (error) {
    if (!(error instanceof HttpError)) {
      const message = String(error.message || error);
      if (/ledger_balance_range|balance_range/.test(message)) error = new HttpError(409, '星星余额不足或已达上限');
      else if (/child_limit/.test(message)) error = new HttpError(409, '每个家庭最多添加 20 个孩子');
      else if (/UNIQUE constraint failed/.test(message)) error = new HttpError(409, '这条记录已存在，请刷新后重试');
      else console.error('Task Town API error', { path, message });
    }
    return json(error.status || 500, { error: error.status ? error.message : '服务暂时遇到问题，请稍后重试' });
  }
}
