import { $, $$, e, icons, pill, empty, formatDate, toast, createApi, bindForm, buttonAction, initTabs, initDialog, openDialog, createSession, renderLedger } from './common.js';

const api = createApi('parent');
initTabs(); initDialog();
let filter = 'all';
let childFilter = 'all';
const session = createSession(api, render);
const taskDialog = $('#taskDialog');
const taskForm = $('#taskForm');
const taskAnchor = document.createComment('task-form-home');
taskForm.before(taskAnchor);
$('#mobilePublish').addEventListener('click', () => { $('#mobileTaskMount').append(taskForm); taskDialog.showModal(); });
$$('[data-close-task]').forEach((button) => button.addEventListener('click', () => { if (!taskForm.dataset.busy) taskDialog.close(); }));
taskDialog.addEventListener('close', () => taskAnchor.after(taskForm));
taskDialog.addEventListener('cancel', (event) => { if (taskForm.dataset.busy) event.preventDefault(); });
window.matchMedia('(max-width:760px)').addEventListener('change', (event) => { if (!event.matches && taskDialog.open) taskDialog.close(); });

function taskStatus(task) {
  return !task.active ? 'paused' : task.current_status === 'available' && task.expired ? 'expired' : task.current_status;
}

function renderTasks(data) {
  const children = new Map(data.children.map((c) => [c.id, c]));
  const tasks = data.tasks.filter((t) => (childFilter === 'all' || t.child_id === childFilter) && (filter === 'all' || taskStatus(t) === filter));
  $('#taskList').innerHTML = tasks.length ? tasks.map((t) => `<article class="mitem s-${e(t.current_status)}">
    <span class="coin2 num">+${e(t.reward)}</span><div class="item-info"><b>${e(t.title)}</b><p>${e(t.description)}</p>
    <span class="meta">${e(children.get(t.child_id)?.display_name)} · ${e(t.category)} · ${t.recurrence === 'daily' ? '每天可接 · 今天的状态' : t.due_at ? `截止 ${e(formatDate(t.due_at))}` : '随时可接'}${t.photo_required ? ' · 需要照片' : ''}</span>
    <div class="item-actions">${pill(taskStatus(t))}<button class="small-button secondary" data-action="toggleTask" data-id="${e(t.id)}">${t.active ? '暂停发布' : '恢复发布'}</button>${t.current_status === 'submitted' ? '<button class="small-button approve" data-go="review">去验收 →</button>' : ''}</div></div></article>`).join('') : empty('这里还没有悬赏', data.children.length ? '写好任务后，孩子就能在自己的页面看见。' : '先添加孩子，让任务找到它的小英雄。');
}

function render(data) {
  $('#familyTitle').textContent = data.family.name;
  $('#parentGreeting').textContent = `${data.user.display_name}，欢迎回家`;
  $('#familyCode').textContent = data.family.code;
  $('#reviewCount').textContent = data.stats.pending || '';
  $('#stats').innerHTML = [
    [data.children.length, '位小英雄'], [data.stats.completed, '个任务已完成'],
    [data.stats.pending, '份努力待验收'], [data.children.reduce((sum, c) => sum + c.balance, 0), '颗星星在小金库'],
  ].map(([value, label]) => `<div class="stat"><strong class="num">${e(value)}</strong><span>${e(label)}</span></div>`).join('');
  const key = data.children.map((c) => `${c.id}:${c.display_name}`).join('|');
  if ($('#taskChild').dataset.keys !== key) {
    const old = $('#taskChild').value;
    const options = data.children.map((c) => `<option value="${e(c.id)}">${e(c.display_name)}</option>`).join('');
    $('#taskChild').innerHTML = options || '<option value="">请先添加孩子</option>';
    if (data.children.some((c) => c.id === old)) $('#taskChild').value = old;
    $('#taskChild').dataset.keys = key;
    $('#childFilter').innerHTML = `<option value="all">所有孩子</option>${options}`;
    if (!data.children.some((c) => c.id === childFilter)) childFilter = 'all';
    $('#childFilter').value = childFilter;
  }
  $('#firstChildNotice').hidden = Boolean(data.children.length);
  $('#publishButton').disabled = !data.children.length;
  $('#mobilePublish').disabled = !data.children.length;
  renderTasks(data);
  const pending = data.runs.filter((r) => r.status === 'submitted');
  $('#reviewList').innerHTML = pending.length ? pending.map((r) => `<article class="review-card">
    <div class="section-line">${pill('submitted')}<span class="positive">+${e(r.reward)} ⭐</span></div>
    <h3>${e(icons[r.category])} ${e(r.title)}</h3><p class="subtle">${e(r.child_name)} · ${e(formatDate(r.submitted_at))}${r.recurrence === 'daily' ? ` · ${e(r.period_key)} 的习惯任务` : ''}</p><p>任务要求：${e(r.description || '认真完成任务')}</p>
    ${r.note ? `<blockquote>孩子说：${e(r.note)}</blockquote>` : ''}
    ${r.has_photo ? `<a href="/api/v1/parent/runs/${e(r.id)}/photo" target="_blank" rel="noopener"><img class="review-photo" src="/api/v1/parent/runs/${e(r.id)}/photo" alt="${e(r.child_name)}的任务打卡照片" loading="lazy"></a>` : '<p class="subtle">孩子没有附照片</p>'}
    <div class="item-actions"><button class="btn btn-cheese btn-sm" data-action="approve" data-id="${e(r.id)}">验收通过 · 发星星</button><button class="small-button secondary" data-action="return" data-id="${e(r.id)}">再试一次</button></div></article>`).join('') : empty('还没有等待验收的任务', '孩子完成打卡后，会出现在这里。');
  $('#rewardList').innerHTML = data.rewards.length ? data.rewards.map((r) => `<div class="compact-card"><div><strong>${e(r.icon)} ${e(r.title)}</strong><p>${e(r.price)} ⭐ · ${r.active ? '已上架' : '已下架'}</p></div><button class="small-button secondary" data-action="toggleReward" data-id="${e(r.id)}">${r.active ? '下架' : '上架'}</button></div>`).join('') : empty('商店还在准备中', '添一个孩子期待的小愿望吧。');
  $('#redemptionList').innerHTML = data.redemptions.length ? data.redemptions.map((r) => `<article class="review-card"><div class="section-line">${pill(r.status)}<span class="subtle">${e(r.price)} ⭐</span></div><h3>🎁 ${e(r.title)}</h3><p>${e(r.child_name)} · ${e(formatDate(r.created_at))}</p>${r.comment ? `<blockquote>${e(r.comment)}</blockquote>` : ''}${r.status === 'pending' ? `<div class="item-actions"><button class="btn btn-cheese btn-sm" data-action="fulfill" data-id="${e(r.id)}">已经兑现</button><button class="small-button secondary" data-action="rejectRedemption" data-id="${e(r.id)}">退回并还星星</button></div>` : ''}</article>`).join('') : empty('还没有兑换申请', '孩子攒够星星，就能来实现小愿望。');
  $('#childList').innerHTML = data.children.length ? data.children.map((c) => `<div class="compact-card"><div><strong>🧒 ${e(c.display_name)}</strong><p>账号：${e(c.login_name)} · 小金库 ${e(c.balance)} ⭐</p></div><button class="small-button secondary" data-action="resetPin" data-id="${e(c.id)}">重设口令</button></div>`).join('') : empty('小英雄还没到齐', '添加孩子后，把家庭码、账号和口令告诉他们。');
  $('#ledgerList').innerHTML = renderLedger(data.ledger, true);
}

$$('[data-auth]').forEach((button) => button.addEventListener('click', () => {
  $$('[data-auth]').forEach((b) => b.classList.toggle('on', b === button));
  $('#loginForm').hidden = button.dataset.auth !== 'login';
  $('#registerForm').hidden = button.dataset.auth !== 'register';
}));
api.config().then((config) => { $('#registerTab').hidden = !config.registrationOpen; }).catch(() => {});
bindForm('#loginForm', async (input) => { await api.auth('login', input); await session.sync(); });
bindForm('#registerForm', async (input, form) => { await api.auth('register', input); form.reset(); await session.sync(); toast('家庭创建成功！先添加一位小英雄吧'); });

$$('[data-step]').forEach((button) => button.addEventListener('click', () => {
  const input = $('[name="reward"]', $('#taskForm'));
  input.value = Math.min(1000, Math.max(1, Number(input.value || 5) + Number(button.dataset.step)));
}));
$('#recurrence').addEventListener('change', () => {
  const daily = $('#recurrence').value === 'daily';
  $('#dueField').hidden = daily;
  if (daily) $('[name="dueAt"]', $('#taskForm')).value = '';
});
$('#taskFilters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  filter = button.dataset.filter;
  $$('[data-filter]').forEach((b) => b.classList.toggle('on', b === button));
  if (session.data) renderTasks(session.data);
});
$('#childFilter').addEventListener('change', () => { childFilter = $('#childFilter').value; if (session.data) renderTasks(session.data); });

bindForm('#taskForm', async (input, form) => {
  await api.post('/tasks', { ...input, reward: Number(input.reward), photoRequired: $('[name="photoRequired"]', form).checked, dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : null });
  const child = input.childId;
  form.reset(); $('#taskChild').value = child; $('#dueField').hidden = false;
  filter = 'all'; $$('[data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === 'all'));
  await session.sync(); if (taskDialog.open) taskDialog.close(); toast('悬赏已发布，孩子刷新后就能看见啦');
});
bindForm('#childForm', async (input, form) => { await api.post('/children', input); form.reset(); await session.sync(); toast('小英雄加入成功！记得把账号和口令告诉孩子'); });
bindForm('#rewardForm', async (input, form) => { await api.post('/rewards', { ...input, price: Number(input.price) }); form.reset(); await session.sync(); toast('新的小愿望已上架'); });
bindForm('#passwordForm', async (input, form) => { await api.post('/password', input); form.reset(); await session.sync(); toast('密码已更改，其他家长登录已退出'); });

$('#copyCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(session.data.family.code); toast('家庭码已复制'); }
  catch { toast(`家庭码：${session.data.family.code}，可长按上方文字复制`); }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || !session.data) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === 'toggleTask' || action === 'toggleReward') {
    const task = action === 'toggleTask';
    const item = (task ? session.data.tasks : session.data.rewards).find((i) => i.id === id);
    if (!item) return;
    buttonAction(button, async () => { await api.patch(`/${task ? 'tasks' : 'rewards'}/${id}`, { active: !item.active }); await session.sync(); toast(item.active ? (task ? '任务已暂停，已接任务仍可完成' : '愿望已下架') : '已恢复发布'); });
  }
  if (action === 'approve') buttonAction(button, async () => { await api.post(`/runs/${id}/review`, { decision: 'approve' }); await session.sync(); toast('验收通过，星星已发到孩子的小金库'); });
  if (action === 'return') openDialog('给小英雄一点建议', '<p class="subtle">告诉孩子哪里还需要改进，孩子就能继续完成并重新打卡。</p><label>给孩子的话<textarea name="comment" required maxlength="300" placeholder="例如：还有几块积木在地上，再检查一下吧。"></textarea></label>', async (input) => { await api.post(`/runs/${id}/review`, { decision: 'return', comment: input.comment }); await session.sync(); toast('建议已送达，等待孩子重新打卡'); }, '让孩子再试一次');
  if (action === 'resetPin') openDialog('重设孩子的登录口令', '<p class="subtle">设置后，孩子的设备需要使用新口令重新登录。</p><label>新的 6 位数字口令<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required autocomplete="new-password"></label>', async (input) => { await api.post(`/children/${id}/pin`, input); await session.sync(); toast('口令已更新，请把新口令告诉孩子'); }, '保存新口令');
  if (action === 'fulfill') buttonAction(button, async () => { await api.post(`/redemptions/${id}/review`, { decision: 'fulfilled' }); await session.sync(); toast('心愿已兑现，谢谢你遵守约定'); });
  if (action === 'rejectRedemption') openDialog('退回这次兑换', '<label>给孩子一个解释<textarea name="comment" required maxlength="300" placeholder="例如：这周末有雨，我们换个时间再去。"></textarea></label><p class="subtle">本次扣除的星星会全部退回孩子的小金库。</p>', async (input) => { await api.post(`/redemptions/${id}/review`, { decision: 'rejected', comment: input.comment }); await session.sync(); toast('兑换已退回，星星已退还'); }, '退回并还星星');
});

session.refresh();
