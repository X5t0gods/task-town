import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.mjs';
import { ensureLocalMySQL, localAdmin, readLocalConfig } from '../scripts/local-mysql.mjs';
import { transaction } from '../src/database.mjs';
import { mysqlFile } from '../scripts/mysql-tools.mjs';
import { randomBytes } from 'node:crypto';

await ensureLocalMySQL();

async function harness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task-town-test-'));
  const local = readLocalConfig();
  const database = `task_town_test_${randomBytes(6).toString('hex')}`;
  const admin = await localAdmin();
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const mysqlConfig = { host: '127.0.0.1', port: local.port, user: 'root', password: local.rootPassword, database };
  const h = { app: null, base: '', root, mysqlConfig };
  async function start() {
    h.app = await createApp({ mysqlConfig, cookieSecure: false, ...options });
    await new Promise((r) => h.app.server.listen(0, '127.0.0.1', r));
    h.base = `http://127.0.0.1:${h.app.server.address().port}`;
  }
  await start();
  t.after(async () => {
    await h.app.close();
    assert.match(database, /^task_town_test_[a-f0-9]{12}$/);
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'task-town-test-')));
    await rm(root, { recursive: true, force: true });
  });
  h.restart = async () => { await h.app.close(); await start(); };
  h.client = () => {
    const cookies = new Map(); let csrf = '';
    return {
      async request(path, input, method = input === undefined ? 'GET' : 'POST', headers = {}) {
        const response = await fetch(`${h.base}/api/v1${path}`, {
          method, signal: AbortSignal.timeout(10000),
          headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'X-CSRF-Token': csrf,
            ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        });
        for (const cookie of response.headers.getSetCookie()) {
          const part = cookie.split(';')[0]; const index = part.indexOf('=');
          cookies.set(part.slice(0, index), part.slice(index + 1));
        }
        const isJson = response.headers.get('content-type')?.startsWith('application/json');
        const data = isJson ? await response.json() : Buffer.from(await response.arrayBuffer());
        if (data.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      },
      async ok(path, input, method, headers) {
        const result = await this.request(path, input, method, headers);
        assert.ok(result.status >= 200 && result.status < 300, `${path}: ${result.status} ${JSON.stringify(result.data)}`);
        return result.data;
      },
    };
  };
  return h;
}

async function family(h, suffix = 'one') {
  const parent = h.client();
  await parent.ok('/auth/parent/register', { username: `parent_${suffix}`, password: 'TestPassword2026!', displayName: '妈妈', familyName: `${suffix}的家` });
  const snapshot = await parent.ok('/parent/snapshot');
  const child = await parent.ok('/parent/children', { loginName: 'xiaobao', displayName: '小宝', pin: '123456' });
  const kid = h.client();
  await kid.ok('/auth/kid/login', { familyCode: snapshot.family.code, loginName: 'xiaobao', pin: '123456' });
  await kid.ok('/kid/snapshot');
  return { parent, kid, childId: child.id, code: snapshot.family.code };
}

async function task(f, overrides = {}) {
  return f.parent.ok('/parent/tasks', {
    childId: f.childId, title: '整理书包', description: '检查明天的课本和水杯', category: '自理小达人',
    reward: 8, recurrence: 'once', photoRequired: false, ...overrides,
  });
}

async function earn(f, amount = 8) {
  const created = await task(f, { reward: amount });
  const run = await f.kid.ok(`/kid/tasks/${created.id}/claim`, {});
  await f.kid.ok(`/kid/runs/${run.id}/submit`, { note: '完成啦' });
  await f.parent.ok(`/parent/runs/${run.id}/review`, { decision: 'approve' });
  return run;
}

test('任务跨端同步；孩子不能自行完成或加星；退回重做；并发验收只发一次奖励', async (t) => {
  const h = await harness(t); const f = await family(h);
  const created = await task(f);
  let state = await f.kid.ok('/kid/snapshot');
  assert.equal(state.tasks[0].id, created.id); assert.equal(state.user.balance, 0);
  const claims = await Promise.all([f.kid.ok(`/kid/tasks/${created.id}/claim`, {}), f.kid.ok(`/kid/tasks/${created.id}/claim`, {})]);
  assert.equal(claims[0].id, claims[1].id);
  const runId = claims[0].id;
  assert.equal((await f.parent.request(`/parent/runs/${runId}/review`, { decision: 'approve' })).status, 409);
  assert.equal((await f.kid.request(`/parent/runs/${runId}/review`, { decision: 'approve' })).status, 401);
  await f.kid.ok(`/kid/runs/${runId}/submit`, { note: '课本和水杯放好了' });
  state = await f.kid.ok('/kid/snapshot'); assert.equal(state.user.balance, 0); assert.equal(state.runs[0].status, 'submitted');
  assert.equal((await f.parent.request(`/parent/runs/${runId}/review`, { decision: 'return' })).status, 400);
  await f.parent.ok(`/parent/runs/${runId}/review`, { decision: 'return', comment: '再检查一下水杯有没有装满' });
  state = await f.kid.ok('/kid/snapshot'); assert.equal(state.runs[0].status, 'claimed'); assert.match(state.runs[0].review_comment, /水杯/); assert.equal(state.user.balance, 0);
  await f.kid.ok(`/kid/runs/${runId}/submit`, { note: '这次都检查好啦' });
  await Promise.all([f.parent.ok(`/parent/runs/${runId}/review`, { decision: 'approve' }), f.parent.ok(`/parent/runs/${runId}/review`, { decision: 'approve' })]);
  state = await f.kid.ok('/kid/snapshot');
  assert.equal(state.user.balance, 8); assert.equal(state.ledger.length, 1); assert.equal(state.stats.completed, 1);
  assert.equal((await f.kid.request(`/kid/runs/${runId}/submit`, {})).status, 409);
});

test('愿望兑换扣星、防超支、网络重试幂等、退还不重复、兑现不能再退款', async (t) => {
  const h = await harness(t); const f = await family(h);
  await earn(f, 12);
  const reward = await f.parent.ok('/parent/rewards', { title: '一起踢球', price: 7, icon: '⚽' });
  const input = { rewardId: reward.id, requestKey: 'stable-request-key-0001' };
  const results = await Promise.all([f.kid.ok('/kid/redemptions', input), f.kid.ok('/kid/redemptions', input)]);
  assert.equal(results[0].id, results[1].id);
  let state = await f.kid.ok('/kid/snapshot'); assert.equal(state.user.balance, 5); assert.equal(state.redemptions.length, 1);
  assert.equal((await f.kid.request('/kid/redemptions', { ...input, requestKey: 'different-request-0002' })).status, 409);
  const id = results[0].id;
  await f.parent.ok(`/parent/redemptions/${id}/review`, { decision: 'rejected', comment: '今天下雨，我们改天去' });
  await f.parent.ok(`/parent/redemptions/${id}/review`, { decision: 'rejected', comment: '重复请求' });
  state = await f.kid.ok('/kid/snapshot'); assert.equal(state.user.balance, 12); assert.equal(state.ledger.length, 3);
  const next = await f.kid.ok('/kid/redemptions', { ...input, requestKey: 'another-request-0003' });
  await f.parent.ok(`/parent/redemptions/${next.id}/review`, { decision: 'fulfilled' });
  assert.equal((await f.parent.request(`/parent/redemptions/${next.id}/review`, { decision: 'rejected', comment: '不能再退' })).status, 409);
  state = await f.kid.ok('/kid/snapshot'); assert.equal(state.user.balance, 5);
});

test('不同家庭及兄弟姐妹隔离；角色、CSRF 与跨站请求受到校验', async (t) => {
  const h = await harness(t); const f = await family(h); const other = await family(h, 'two');
  const created = await task(f);
  assert.equal((await other.kid.ok('/kid/snapshot')).tasks.length, 0);
  assert.equal((await other.kid.request(`/kid/tasks/${created.id}/claim`, {})).status, 404);
  assert.equal((await other.parent.request(`/parent/tasks/${created.id}`, { active: false }, 'PATCH')).status, 404);
  assert.equal((await f.kid.request('/parent/snapshot')).status, 401);
  const missing = await f.parent.request('/parent/rewards', { title: '愿望', price: 3, icon: '🎁' }, 'POST', { 'X-CSRF-Token': '' });
  assert.equal(missing.status, 403);
  assert.equal((await f.parent.request('/parent/logout', {}, 'POST', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.parent.request('/parent/tasks', { childId: other.childId })).status, 404);
  await f.parent.ok('/parent/children', { loginName: 'sibling', displayName: '妹妹', pin: '654321' });
  const sibling = h.client(); await sibling.ok('/auth/kid/login', { familyCode: f.code, loginName: 'sibling', pin: '654321' }); await sibling.ok('/kid/snapshot');
  assert.equal((await sibling.request(`/kid/tasks/${created.id}/claim`, {})).status, 404);
  const exported = await f.parent.ok('/parent/export');
  assert.equal(JSON.stringify(exported).includes('password_hash'), false); assert.equal(JSON.stringify(exported).includes('csrfToken'), false);
});

test('每天任务以北京时间零点重新开放；一次任务不重复；截止后禁止新接单', async (t) => {
  let clock = new Date('2026-10-15T15:59:00Z');
  const h = await harness(t, { now: () => clock }); const f = await family(h);
  const daily = await task(f, { recurrence: 'daily' });
  const once = await task(f);
  const expires = await task(f, { dueAt: '2026-10-15T15:59:30Z' });
  const first = await f.kid.ok(`/kid/tasks/${daily.id}/claim`, {});
  await f.kid.ok(`/kid/runs/${first.id}/submit`, {});
  await f.parent.ok(`/parent/runs/${first.id}/review`, { decision: 'approve' });
  const single = await f.kid.ok(`/kid/tasks/${once.id}/claim`, {});
  assert.equal((await f.kid.ok(`/kid/tasks/${daily.id}/claim`, {})).id, first.id);
  clock = new Date('2026-10-15T16:00:01Z');
  const state = await f.kid.ok('/kid/snapshot');
  assert.equal(state.today, '2026-10-16'); assert.equal(state.tasks.find((v) => v.id === daily.id).current_status, 'available');
  const second = await f.kid.ok(`/kid/tasks/${daily.id}/claim`, {}); assert.notEqual(second.id, first.id);
  assert.equal((await f.kid.ok(`/kid/tasks/${once.id}/claim`, {})).id, single.id);
  assert.equal((await f.kid.request(`/kid/tasks/${expires.id}/claim`, {})).status, 409);
  await f.kid.ok(`/kid/runs/${single.id}/submit`, {}); // Accepted tasks may still be submitted.
  assert.equal((await f.parent.request('/parent/tasks', { childId: f.childId, title: '过期', category: '自理小达人', reward: 1, recurrence: 'once', photoRequired: false, dueAt: '2026-01-01T00:00:00Z' })).status, 400);
});

test('拍照要求、图片类型、私有照片访问和导出数据', async (t) => {
  const h = await harness(t); const f = await family(h); const other = await family(h, 'two');
  const created = await task(f, { photoRequired: true });
  const run = await f.kid.ok(`/kid/tasks/${created.id}/claim`, {});
  assert.equal((await f.kid.request(`/kid/runs/${run.id}/submit`, {})).status, 400);
  assert.equal((await f.kid.request(`/kid/runs/${run.id}/submit`, { photo: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  assert.equal((await f.kid.request(`/kid/runs/${run.id}/submit`, { photo: 'data:image/png;base64,aGVsbG8gd29ybGQhISE=' })).status, 400);
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  await f.kid.ok(`/kid/runs/${run.id}/submit`, { photo, note: '看，这是我整理好的书包' });
  const response = await f.parent.request(`/parent/runs/${run.id}/photo`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.data.equals(Buffer.from(photo.split(',')[1], 'base64')));
  assert.equal((await f.kid.request(`/kid/runs/${run.id}/photo`)).status, 200);
  assert.equal((await other.parent.request(`/parent/runs/${run.id}/photo`)).status, 404);
  assert.equal((await other.kid.request(`/kid/runs/${run.id}/photo`)).status, 404);
  const snapshot = await f.parent.ok('/parent/snapshot'); assert.equal(snapshot.runs[0].has_photo, 1); assert.equal(snapshot.runs[0].photo, undefined);
});

test('密码和孩子口令更改会撤销旧登录；独立页面可在同浏览器共存', async (t) => {
  const h = await harness(t); const f = await family(h);
  const secondParent = h.client();
  await secondParent.ok('/auth/parent/login', { username: 'parent_one', password: 'TestPassword2026!' }); await secondParent.ok('/parent/snapshot');
  await f.parent.ok('/auth/kid/login', { familyCode: f.code, loginName: 'xiaobao', pin: '123456' });
  await f.parent.ok('/kid/snapshot'); await f.parent.ok('/parent/snapshot');
  await f.parent.ok(`/parent/children/${f.childId}/pin`, { pin: '654321' });
  assert.equal((await f.kid.request('/kid/snapshot')).status, 401);
  assert.equal((await f.kid.request('/auth/kid/login', { familyCode: f.code, loginName: 'xiaobao', pin: '123456' })).status, 401);
  await f.kid.ok('/auth/kid/login', { familyCode: f.code, loginName: 'xiaobao', pin: '654321' });
  await f.parent.ok('/parent/password', { currentPassword: 'TestPassword2026!', newPassword: 'NewStrongPassword2026!' });
  await f.parent.ok('/parent/snapshot');
  assert.equal((await secondParent.request('/parent/snapshot')).status, 401);
  assert.equal((await secondParent.request('/auth/parent/login', { username: 'parent_one', password: 'TestPassword2026!' })).status, 401);
  await secondParent.ok('/auth/parent/login', { username: 'parent_one', password: 'NewStrongPassword2026!' });
});

test('数据库与登录在服务重启后保留；会话到期后失效', async (t) => {
  let clock = new Date('2026-10-15T10:00:00Z');
  const h = await harness(t, { now: () => clock }); const f = await family(h);
  await earn(f, 13);
  await h.restart();
  assert.equal((await f.kid.ok('/kid/snapshot')).user.balance, 13);
  assert.equal((await f.parent.ok('/parent/snapshot')).stats.completed, 1);
  clock = new Date('2026-11-20T10:00:00Z');
  assert.equal((await f.kid.request('/kid/snapshot')).status, 401);
  assert.equal((await f.parent.request('/parent/snapshot')).status, 401);
});

test('输入边界、请求限流、暂停任务和下架愿望均由服务器执行', async (t) => {
  const h = await harness(t); const f = await family(h);
  assert.equal((await taskRequest({ reward: -1 })).status, 400);
  assert.equal((await taskRequest({ reward: 1.5 })).status, 400);
  assert.equal((await taskRequest({ category: '随便一个类别' })).status, 400);
  async function taskRequest(overrides) { return f.parent.request('/parent/tasks', { childId: f.childId, title: '测试', category: '自理小达人', reward: 5, recurrence: 'once', photoRequired: false, ...overrides }); }
  const created = await task(f);
  await f.parent.ok(`/parent/tasks/${created.id}`, { active: false }, 'PATCH');
  assert.equal((await f.kid.request(`/kid/tasks/${created.id}/claim`, {})).status, 404);
  await f.parent.ok(`/parent/tasks/${created.id}`, { active: true }, 'PATCH');
  await f.kid.ok(`/kid/tasks/${created.id}/claim`, {});
  const reward = await f.parent.ok('/parent/rewards', { title: '测试心愿', price: 2, icon: '🎁' });
  await f.parent.ok(`/parent/rewards/${reward.id}`, { active: false }, 'PATCH');
  assert.equal((await f.kid.request('/kid/redemptions', { rewardId: reward.id, requestKey: 'hidden-reward-key-0001' })).status, 404);
  const bad = h.client();
  for (let i = 0; i < 10; i++) assert.equal((await bad.request('/auth/kid/login', { familyCode: f.code, loginName: 'wrong_name', pin: '000000' })).status, 401);
  assert.equal((await bad.request('/auth/kid/login', { familyCode: f.code, loginName: 'wrong_name', pin: '000000' })).status, 429);
});

test('三个真实页面及资源可访问，数据库与源码不会被静态暴露', async (t) => {
  const h = await harness(t);
  for (const path of ['/', '/parent.html', '/kid.html', '/css/style.css', '/css/app.css', '/js/parent.js', '/js/kid.js', '/favicon.svg']) {
    const response = await fetch(`${h.base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    const source = await response.text();
    if (path === '/') { assert.equal(source.includes('setTimeout(function'), false); assert.equal(source.includes('fonts.googleapis.com'), false); }
  }
  for (const path of ['/database/schema.sql', '/.env', '/src/app.mjs', '/package.json', '/api/v1/parent/snapshot']) {
    assert.ok([401, 404].includes((await fetch(`${h.base}${path}`)).status), path);
  }
});

test('较长历史不会挤掉待验收任务，完整家庭导出不截断记录', async (t) => {
  const h = await harness(t); const f = await family(h);
  const created = await task(f, { recurrence: 'daily' });
  const pending = await f.kid.ok(`/kid/tasks/${created.id}/claim`, {});
  await f.kid.ok(`/kid/runs/${pending.id}/submit`, { note: '较早提交，仍需验收' });
  const familyId = (await f.parent.ok('/parent/snapshot')).family.id;
  const db = h.app.db;
  await db.prepare('UPDATE runs SET claimed_at=? WHERE id=?').run('2024-01-01T00:00:00Z', pending.id);
  const insert = db.prepare('INSERT INTO runs (id,task_id,family_id,child_id,period_key,status,claimed_at) VALUES (?,?,?,?,?,?,?)');
  await transaction(db, async () => {
    for (let i = 0; i < 505; i++) {
      const date = new Date(Date.UTC(2024, 0, i + 2)).toISOString();
      await insert.run(`history-${i}`, created.id, familyId, f.childId, date.slice(0, 10), 'approved', date);
    }
  });
  const parentState = await f.parent.ok('/parent/snapshot');
  assert.equal(parentState.runs.length, 500);
  assert.ok(parentState.runs.some((r) => r.id === pending.id));
  assert.ok((await f.kid.ok('/kid/snapshot')).runs.some((r) => r.id === pending.id));
  assert.equal((await f.parent.ok('/parent/export')).runs.length, 506);
});

test('在线备份可以恢复独立服务，余额、登录和私有照片完整保留', async (t) => {
  const h = await harness(t); const f = await family(h);
  await earn(f, 13);
  const created = await task(f, { photoRequired: true });
  const run = await f.kid.ok(`/kid/tasks/${created.id}/claim`, {});
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  await f.kid.ok(`/kid/runs/${run.id}/submit`, { photo });
  const target = join(h.root, 'backup.sql');
  await mysqlFile(h.mysqlConfig, target);
  const restoreName = `${h.mysqlConfig.database}_restore`;
  const admin = await localAdmin();
  await admin.query(`CREATE DATABASE \`${restoreName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const restoredConfig = { ...h.mysqlConfig, database: restoreName };
  await mysqlFile(restoredConfig, target, true);
  const restored = await createApp({ mysqlConfig: restoredConfig, cookieSecure: false });
  const originalBase = h.base;
  try {
    await new Promise((r) => restored.server.listen(0, '127.0.0.1', r));
    h.base = `http://127.0.0.1:${restored.server.address().port}`;
    const state = await f.kid.ok('/kid/snapshot');
    assert.equal(state.user.balance, 13); assert.equal(state.ledger.length, 1);
    const image = await f.parent.request(`/parent/runs/${run.id}/photo`);
    assert.equal(image.status, 200); assert.ok(image.data.equals(Buffer.from(photo.split(',')[1], 'base64')));
  } finally {
    h.base = originalBase; await restored.close();
    assert.match(restoreName, /^task_town_test_[a-f0-9]{12}_restore$/);
    await admin.query(`DROP DATABASE \`${restoreName}\``); await admin.end();
  }
});

test('MySQL 多连接同时验收不丢余额，同时兑换不同申请不会超支', async (t) => {
  const h = await harness(t); const f = await family(h);
  const runs = [];
  for (const amount of [5, 7]) {
    const created = await task(f, { reward: amount });
    const run = await f.kid.ok(`/kid/tasks/${created.id}/claim`, {});
    await f.kid.ok(`/kid/runs/${run.id}/submit`, {}); runs.push(run);
  }
  await Promise.all(runs.map((run) => f.parent.ok(`/parent/runs/${run.id}/review`, { decision: 'approve' })));
  assert.equal((await f.kid.ok('/kid/snapshot')).user.balance, 12);
  const reward = await f.parent.ok('/parent/rewards', { title: '小心愿', price: 8, icon: '🎁' });
  const responses = await Promise.all(['concurrent-purchase-a', 'concurrent-purchase-b'].map((requestKey) => f.kid.request('/kid/redemptions', { rewardId: reward.id, requestKey })));
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const state = await f.kid.ok('/kid/snapshot');
  assert.equal(state.user.balance, 4); assert.equal(state.redemptions.length, 1); assert.equal(state.ledger.length, 3);
});
