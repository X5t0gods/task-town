import { createApp } from '../src/app.mjs';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureLocalMySQL } from './local-mysql.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('演示数据禁止在生产环境创建');
if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.DB_MANAGED_LOCAL === 'true') await ensureLocalMySQL();
const baseDatabase = process.env.DB_NAME || 'task_town';
const database = baseDatabase.endsWith('_demo') ? baseDatabase : `${baseDatabase}_demo`;
const app = await createApp({ mysqlConfig: { database }, cookieSecure: false, registrationOpen: true });
const credentials = { username: 'demo_parent', password: 'TownDemo2026!' };
try {
  const count = (await app.db.prepare('SELECT count(*) AS n FROM parents').get()).n;
  if (count && !(await app.db.prepare('SELECT id FROM parents WHERE username=?').get(credentials.username))) throw new Error('演示库中有其他数据，已停止写入');
  if (!count) {
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
    function client(role) {
      let cookie = ''; let csrf = '';
      return async (path, input, isAuth = false) => {
        const response = await fetch(`${base}/${isAuth ? `auth/${role}` : role}${path}`, {
          method: input === undefined ? 'GET' : 'POST',
          headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (result.csrfToken) csrf = result.csrfToken;
        return result;
      };
    }
    const parent = client('parent'); const kid = client('kid');
    await parent('/register', { ...credentials, displayName: '妈妈', familyName: '小宝的快乐星球' }, true);
    const snapshot = await parent('/snapshot');
    const child = await parent('/children', { displayName: '小宝', loginName: 'xiaobao', pin: '246810' });
    const tasks = [
      ['摆好全家碗筷', '晚饭前把碗筷摆好，一人一副，整整齐齐。', '家务小帮手', 8, 'once'],
      ['自己刷牙洗脸', '早晚认真刷牙两分钟，洗脸后把毛巾挂好。', '自理小达人', 6, 'daily'],
      ['读一本绘本', '读完一本绘本，给爸妈讲讲你最喜欢的一页。', '学习小标兵', 6, 'daily'],
      ['收拾玩具角', '把玩具放回黄色箱子，地上一个都不留。', '家务小帮手', 5, 'once'],
      ['给绿萝浇浇水', '用小喷壶给阳台三盆绿萝浇水，和妈妈一起检查土壤。', '爱心小天使', 4, 'once'],
      ['整理小书包', '对照课表装好明天的课本，别忘了水杯。', '自理小达人', 5, 'daily'],
      ['户外运动二十分钟', '和家人一起散步、跳绳或踢球，享受户外时光。', '运动小健将', 8, 'daily'],
      ['给爷爷奶奶打电话', '问候爷爷奶奶，讲讲学校里的一件趣事。', '爱心小天使', 8, 'once'],
    ];
    const created = [];
    for (const [title, description, category, reward, recurrence] of tasks) created.push(await parent('/tasks', { title, description, category, reward, recurrence, childId: child.id, photoRequired: false }));
    for (const [title, price, icon] of [['一起读睡前故事', 5, '📚'], ['一支冰淇淋', 20, '🍦'], ['周末去游乐园', 80, '🎡'], ['自选一个小玩具', 100, '🎁']]) await parent('/rewards', { title, price, icon });
    await kid('/login', { familyCode: snapshot.family.code, loginName: 'xiaobao', pin: '246810' }, true);
    await kid('/snapshot');
    const first = await kid(`/tasks/${created[0].id}/claim`, {});
    await kid(`/runs/${first.id}/submit`, { note: '每个人的碗筷都摆好啦！' });
    await parent(`/runs/${first.id}/review`, { decision: 'approve', comment: '摆得真整齐，谢谢小帮手！' });
    const second = await kid(`/tasks/${created[1].id}/claim`, {});
    await kid(`/runs/${second.id}/submit`, { note: '今天也认真刷牙了两分钟，毛巾挂好啦。' });
    await kid(`/tasks/${created[2].id}/claim`, {});
  }
  const family = await app.db.prepare('SELECT code FROM families LIMIT 1').get();
  console.log(`演示数据库：${database}\n家长账号：${credentials.username}\n家长密码：${credentials.password}\n家庭码：${family.code}\n孩子账号：xiaobao\n孩子口令：246810\n\nPowerShell 启动演示：\n$env:DB_NAME='${database}'\nnpm start\n\n正式使用请使用 task_town 库并自行注册。`);
} finally { await app.close(); }
