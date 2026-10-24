import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { handleApi } from '../lib/town-api.mjs';

test('Sites 线上版：D1 / R2 集成验证', async t => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ready"); } }',
    compatibilityDate: '2026-05-15', d1Databases: ['DB'], r2Buckets: ['BUCKET'], cf: false });
  t.after(() => mf.dispose());
  const env = { DB: await mf.getD1Database('DB'), BUCKET: await mf.getR2Bucket('BUCKET') };
  for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
  }
  let now = new Date('2026-10-18T08:00:00.000Z'); let familyCounter = 0;
  function client() {
    const cookies = new Map(); let csrf = ''; const ip = crypto.randomUUID();
    return {
      async request(path, input, method = input === undefined ? 'GET' : 'POST', extra = {}) {
        const headers = { Origin: 'https://town.test', Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '),
          'cf-connecting-ip': ip, 'X-CSRF-Token': csrf, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra };
        const request = new Request(`https://town.test/api/v1${path}`, { method, headers,
          ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
        const response = await handleApi(request, env, { now });
        for (const cookie of response.headers.getSetCookie()) {
          const value = cookie.split(';')[0]; const index = value.indexOf('='); cookies.set(value.slice(0,index), value.slice(index+1));
        }
        const json = response.headers.get('content-type')?.includes('application/json');
        const data = json ? await response.json() : new Uint8Array(await response.arrayBuffer());
        if (data.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      },
      async ok(...args) { const result = await this.request(...args); assert.ok(result.status >= 200 && result.status < 300, `${args[0]}: ${result.status} ${JSON.stringify(result.data)}`); return result.data; },
    };
  }
  async function family() {
    const parent = client(); const name = `cloud_parent_${++familyCounter}`;
    const registered = await parent.request('/auth/parent/register', { username:name, password:'CloudTest2026!', displayName:'妈妈', familyName:'测试家庭' });
    assert.equal(registered.status,201); assert.match(registered.headers.get('set-cookie'),/HttpOnly.*SameSite=Strict.*Secure/);
    const snapshot = await parent.ok('/parent/snapshot');
    const child = await parent.ok('/parent/children', { loginName:'xiaobao', displayName:'小宝', pin:'123456' });
    const kid = client(); await kid.ok('/auth/kid/login', { familyCode:snapshot.family.code, loginName:'xiaobao', pin:'123456' }); await kid.ok('/kid/snapshot');
    return { parent, kid, childId:child.id, familyId:snapshot.family.id, name, code:snapshot.family.code };
  }
  const task = (f, overrides={}) => f.parent.ok('/parent/tasks', { childId:f.childId, title:'整理书包', description:'检查课本与水杯', category:'自理小达人', reward:8, recurrence:'once', photoRequired:false, ...overrides });
  async function submit(f, overrides={}) { const created=await task(f,overrides); const claimed=await f.kid.ok(`/kid/tasks/${created.id}/claim`,{}); await f.kid.ok(`/kid/runs/${claimed.id}/submit`,{note:'完成啦'}); return {taskId:created.id,runId:claimed.id}; }

  await t.test('完整流程、界面数据协议、并发验收只奖励一次', async () => {
    const f=await family(); const first=await submit(f); const second=await submit(f,{reward:9});
    let snapshot=await f.kid.ok('/kid/snapshot'); assert.equal(snapshot.user.balance,0); assert.equal(snapshot.stats.pending,2);
    assert.equal(snapshot.tasks[0].current_status,'submitted'); assert.ok(snapshot.tasks[0].current_run_id); assert.ok(Array.isArray(snapshot.rewards));
    await Promise.all(Array.from({length:4},()=>f.parent.ok(`/parent/runs/${first.runId}/review`,{decision:'approve'})));
    await f.parent.ok(`/parent/runs/${second.runId}/review`,{decision:'approve'});
    snapshot=await f.kid.ok('/kid/snapshot'); assert.equal(snapshot.user.balance,17); assert.equal(snapshot.ledger.length,2); assert.equal(snapshot.stats.completed,2); assert.equal(snapshot.stats.pending,0);
    const retry=await f.kid.ok(`/kid/tasks/${first.taskId}/claim`,{}); assert.equal(retry.id,first.runId);
  });
  await t.test('退回重做、跨家庭与同家庭不同孩子权限、CSRF和同源校验', async () => {
    const f=await family(); const g=await family(); const item=await submit(f);
    assert.equal((await g.parent.request(`/parent/runs/${item.runId}/review`,{decision:'approve'})).status,404);
    assert.equal((await f.kid.request(`/kid/runs/${item.runId}/review`,{decision:'approve'})).status,404);
    assert.equal((await f.parent.request(`/parent/runs/${item.runId}/review`,{decision:'approve'},'POST',{'X-CSRF-Token':''})).status,403);
    assert.equal((await f.parent.request(`/parent/runs/${item.runId}/review`,{decision:'approve'},'POST',{Origin:'https://other.test'})).status,403);
    assert.equal((await g.kid.request(`/kid/tasks/${item.taskId}/claim`,{})).status,404);
    const sibling=await f.parent.ok('/parent/children',{loginName:'sibling',displayName:'妹妹',pin:'654321'});
    const siblingClient=client(); await siblingClient.ok('/auth/kid/login',{familyCode:f.code,loginName:'sibling',pin:'654321'}); await siblingClient.ok('/kid/snapshot');
    assert.equal((await siblingClient.request(`/kid/tasks/${item.taskId}/claim`,{})).status,404); assert.notEqual(sibling.id,f.childId);
    await f.parent.ok(`/parent/runs/${item.runId}/review`,{decision:'return',comment:'再检查一下'});
    assert.equal((await f.kid.ok('/kid/snapshot')).user.balance,0);
    await f.kid.ok(`/kid/runs/${item.runId}/submit`,{note:'重新检查好了'}); await f.parent.ok(`/parent/runs/${item.runId}/review`,{decision:'approve'});
    assert.equal((await f.kid.ok('/kid/snapshot')).user.balance,8);
  });
  await t.test('兑换并发不超支、请求重试不扣两次、退款只生效一次', async () => {
    const f=await family(); const item=await submit(f,{reward:17}); await f.parent.ok(`/parent/runs/${item.runId}/review`,{decision:'approve'});
    const reward=await f.parent.ok('/parent/rewards',{title:'睡前故事',price:10,icon:'📚'});
    const attempts=await Promise.all(['a','b','c'].map(n=>f.kid.request('/kid/redemptions',{rewardId:reward.id,requestKey:`cloud-request-${n}-123456789`}))); 
    assert.equal(attempts.filter(r=>r.status===201).length,1); assert.equal(attempts.filter(r=>r.status===409).length,2);
    let snapshot=await f.kid.ok('/kid/snapshot'); assert.equal(snapshot.user.balance,7); assert.equal(snapshot.redemptions.length,1);
    const redemption=snapshot.redemptions[0];
    const retry=await f.kid.ok('/kid/redemptions',{rewardId:reward.id,requestKey:redemption.request_key}); assert.equal(retry.id,redemption.id); assert.equal((await f.kid.ok('/kid/snapshot')).user.balance,7);
    await Promise.all([1,2,3].map(()=>f.parent.ok(`/parent/redemptions/${redemption.id}/review`,{decision:'rejected',comment:'改天再兑换'})));
    snapshot=await f.kid.ok('/kid/snapshot'); assert.equal(snapshot.user.balance,17); assert.equal(snapshot.ledger.filter(l=>l.kind==='redemption_refund').length,1);
    assert.equal((await f.parent.request(`/parent/redemptions/${redemption.id}/review`,{decision:'fulfilled'})).status,409);
    const reward2=await f.parent.ok('/parent/rewards',{title:'冰淇淋',price:3,icon:'🍦'});
    assert.equal((await f.kid.request('/kid/redemptions',{rewardId:reward2.id,requestKey:redemption.request_key})).status,409);
  });
  await t.test('必需照片校验、R2保存、私有照片访问及重做替换', async () => {
    const f=await family(); const g=await family(); const created=await task(f,{photoRequired:true}); const run=await f.kid.ok(`/kid/tasks/${created.id}/claim`,{});
    assert.equal((await f.kid.request(`/kid/runs/${run.id}/submit`,{note:'完成'})).status,400);
    assert.equal((await f.kid.request(`/kid/runs/${run.id}/submit`,{photo:'data:image/png;base64,aGVsbG8='})).status,400);
    const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO5sAAAAASUVORK5CYII=';
    await f.kid.ok(`/kid/runs/${run.id}/submit`,{photo,note:'附上照片'});
    const stored=await f.parent.request(`/parent/runs/${run.id}/photo`); assert.equal(stored.status,200); assert.equal(stored.headers.get('content-type'),'image/png'); assert.ok(stored.data.length>12);
    assert.equal((await g.parent.request(`/parent/runs/${run.id}/photo`)).status,404); assert.equal((await client().request(`/kid/runs/${run.id}/photo`)).status,401);
    const before=await env.BUCKET.list(); await f.parent.ok(`/parent/runs/${run.id}/review`,{decision:'return',comment:'请再拍一张'});
    await f.kid.ok(`/kid/runs/${run.id}/submit`,{photo}); const after=await env.BUCKET.list(); assert.equal(after.objects.length,before.objects.length); assert.notEqual(after.objects[0].key,before.objects[0].key);
  });
  await t.test('修改密码和口令后旧会话失效，登出和导出正常', async () => {
    const f=await family(); const oldParent=client(); await oldParent.ok('/auth/parent/login',{username:f.name,password:'CloudTest2026!'}); await oldParent.ok('/parent/snapshot');
    await f.parent.ok('/parent/password',{currentPassword:'CloudTest2026!',newPassword:'NewCloudPass2026!'});
    assert.equal((await oldParent.request('/parent/snapshot')).status,401); await f.parent.ok('/parent/snapshot');
    await f.parent.ok(`/parent/children/${f.childId}/pin`,{pin:'222222'}); assert.equal((await f.kid.request('/kid/snapshot')).status,401);
    const fresh=client(); await fresh.ok('/auth/kid/login',{familyCode:f.code,loginName:'xiaobao',pin:'222222'}); await fresh.ok('/kid/snapshot');
    const exported=await f.parent.request('/parent/export'); assert.equal(exported.status,200); assert.match(exported.headers.get('content-disposition'),/attachment/);
    assert.ok(!JSON.stringify(exported.data).includes('password_hash')); assert.ok(!JSON.stringify(exported.data).includes('csrfToken'));
    await fresh.ok('/kid/logout',{}); assert.equal((await fresh.request('/kid/snapshot')).status,401);
  });
  await t.test('余额上限失败时整条验收回滚', async () => {
    const f=await family(); const item=await submit(f);
    await env.DB.prepare('UPDATE children SET balance=1000000000 WHERE id=?').bind(f.childId).run();
    assert.equal((await f.parent.request(`/parent/runs/${item.runId}/review`,{decision:'approve'})).status,409);
    const snapshot=await f.kid.ok('/kid/snapshot'); assert.equal(snapshot.user.balance,1000000000); assert.equal(snapshot.runs[0].status,'submitted'); assert.equal(snapshot.ledger.length,0);
  });
  await t.test('北京时间每日任务跨日开放、单次过期和暂停任务', async () => {
    now=new Date('2026-10-18T15:59:50.000Z'); const f=await family(); const daily=await task(f,{recurrence:'daily'});
    const first=await f.kid.ok(`/kid/tasks/${daily.id}/claim`,{}); const expired=await task(f,{dueAt:'2026-10-18T15:59:59.000Z'});
    const paused=await task(f); await f.parent.ok(`/parent/tasks/${paused.id}`,{active:false},'PATCH'); assert.equal((await f.kid.request(`/kid/tasks/${paused.id}/claim`,{})).status,404);
    now=new Date('2026-10-18T16:00:10.000Z'); const snapshot=await f.kid.ok('/kid/snapshot'); assert.equal(snapshot.today,'2026-10-19');
    assert.equal(snapshot.tasks.find(task=>task.id===daily.id).current_status,'available'); assert.equal(snapshot.tasks.find(task=>task.id===expired.id).expired,true);
    const second=await f.kid.ok(`/kid/tasks/${daily.id}/claim`,{}); assert.notEqual(second.id,first.id); assert.equal((await f.kid.request(`/kid/tasks/${expired.id}/claim`,{})).status,409);
  });
});
