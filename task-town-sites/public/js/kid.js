import { $, e, icons, pill, empty, formatDate, toast, createApi, bindForm, buttonAction, initTabs, initDialog, openDialog, createSession, renderLedger, photoData } from './common.js';

const api = createApi('kid');
const selectTab = initTabs(); initDialog();
const session = createSession(api, render);
// Keep the same key after a network interruption, so retrying cannot spend twice.
const redemptionKeys = new Map();

function runCard(run, completed = false) {
  return `<article class="kcard taken${completed ? ' completed' : ''}"><div class="emoji" aria-hidden="true">${e(icons[run.category] || '⭐')}</div><h3>${e(run.title)}</h3><p>${e(run.description || '认真完成，给自己一点掌声！')}</p><span class="reward num">+${e(run.reward)} ⭐</span><span class="task-meta">${run.recurrence === 'daily' ? `${e(run.period_key)} 的习惯任务` : '一次任务'}${run.photo_required ? ' · 📷 需要照片' : ''}</span>${run.review_comment ? `<p class="return-note">爸妈说：${e(run.review_comment)}</p>` : ''}${run.status === 'claimed' ? `<button class="big-btn do" data-action="submit" data-id="${e(run.id)}">我做完啦！</button>` : `<span class="big-btn wait">${run.status === 'submitted' ? '等爸妈验收…' : `已收获 ${e(run.reward)} 颗星星！`}</span>`}</article>`;
}

function render(data, previous) {
  $('#kidGreeting').textContent = `你好，${data.user.display_name}！`;
  $('#kidSubtitle').textContent = `${data.family.name} · 今天也来收集小小的成就`;
  $('#vaultNum').textContent = data.user.balance;
  $('#progressText').textContent = `已经完成 ${data.stats.completed} 个任务 · ${data.stats.pending} 个正在等爸妈验收`;
  if (previous && previous.user.id === data.user.id && previous.user.balance < data.user.balance) {
    $('#vaultNum').classList.add('bump'); setTimeout(() => $('#vaultNum').classList.remove('bump'), 350);
    toast(`小金库多了 ${data.user.balance - previous.user.balance} 颗星星！`);
  }
  const available = data.tasks.filter((t) => t.current_status === 'available' && !t.expired);
  $('#marketGrid').innerHTML = available.length ? available.map((t) => `<article class="kcard"><div class="emoji" aria-hidden="true">${e(icons[t.category] || '⭐')}</div><span class="pill pill-available">${e(t.category)}</span><h3>${e(t.title)}</h3><p>${e(t.description || '认真做好这件小事，你就是小英雄！')}</p><span class="reward num">+${e(t.reward)} ⭐</span><span class="task-meta">${t.recurrence === 'daily' ? '🔁 每天可接一次' : t.due_at ? `截止 ${e(formatDate(t.due_at))}` : '随时可以接'}${t.photo_required ? ' · 📷 需要照片' : ''}</span><button class="big-btn" data-action="claim" data-id="${e(t.id)}">我要接！</button></article>`).join('') : empty('今天的任务都逛完啦', '去「我的任务」继续挑战，或者请爸妈发布一个新任务。');
  const mine = data.runs.filter((r) => r.status !== 'approved');
  $('#mineCount').textContent = mine.length || '';
  $('#mineGrid').innerHTML = mine.length ? mine.map((r) => runCard(r)).join('') : empty('还没有进行中的任务', '去任务集市，挑一个你想做的小挑战。');
  $('#completedGrid').innerHTML = data.runs.filter((r) => r.status === 'approved').slice(0, 30).map((r) => runCard(r, true)).join('') || empty('第一份成就，等你来完成', '认真完成任务，再请爸妈来验收。');
  $('#wishGrid').innerHTML = data.rewards.length ? data.rewards.map((r) => {
    const enough = data.user.balance >= r.price;
    return `<article class="wcard"><div class="icon" aria-hidden="true">${e(r.icon)}</div><div class="info"><h3>${e(r.title)}</h3><span class="price">${e(r.price)} ⭐</span><progress max="${e(r.price)}" value="${Math.min(data.user.balance, r.price)}" aria-label="${e(r.title)}的星星进度"></progress><span class="need">${enough ? '攒够啦，可以申请兑换！' : `还差 ${e(r.price - data.user.balance)} 颗星星，加油！`}</span></div><button class="get${enough ? '' : ' no'}" data-action="redeem" data-id="${e(r.id)}" ${enough ? '' : 'disabled'}>申请兑换</button></article>`;
  }).join('') : empty('愿望商店还在准备中', '和爸妈商量一个你喜欢的小愿望吧。');
  $('#redemptionList').innerHTML = data.redemptions.length ? data.redemptions.map((r) => `<article class="review-card"><div class="section-line">${pill(r.status)}<span class="subtle">${e(r.price)} ⭐</span></div><h3>🎁 ${e(r.title)}</h3><p class="subtle">${e(formatDate(r.created_at))}</p>${r.comment ? `<blockquote>爸妈说：${e(r.comment)}</blockquote>` : ''}<p>${r.status === 'pending' ? '已经告诉爸妈啦，等他们帮你实现。' : r.status === 'fulfilled' ? '小愿望实现啦，继续加油！' : '星星已经退回小金库，留给下一个心愿。'}</p></article>`).join('') : empty('这里会记下你的心愿', '攒够星星后，就可以向爸妈申请兑换啦。');
  $('#ledgerList').innerHTML = renderLedger(data.ledger);
}

bindForm('#loginForm', async (input, form) => {
  await api.auth('login', { ...input, familyCode: input.familyCode.trim().toUpperCase() });
  $('[name="pin"]', form).value = '';
  redemptionKeys.clear(); await session.sync();
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || !session.data) return;
  const id = button.dataset.id;
  if (button.dataset.action === 'claim') buttonAction(button, async () => {
    await api.post(`/tasks/${id}/claim`); await session.sync(); selectTab('mine'); toast('接到任务啦！认真完成后，记得告诉爸妈');
  });
  if (button.dataset.action === 'submit') {
    const run = session.data.runs.find((r) => r.id === id);
    if (!run) return;
    openDialog('让爸妈看看你的努力', `<p class="inline-summary">${e(run.title)} · <strong>+${e(run.reward)} ⭐</strong></p><label>想对爸妈说的话（选填）<textarea name="note" maxlength="300" placeholder="例如：我把所有积木都放好啦！"></textarea></label><label>打卡照片${run.photo_required ? '（必填）' : '（选填）'}<input type="file" name="photoFile" accept="image/jpeg,image/png,image/webp" capture="environment" ${run.photo_required ? 'required' : ''}></label><p class="subtle">照片会自动缩小后上传，只有你和家长可以查看。提交后，等爸妈验收才会收到星星。</p><img id="photoPreview" class="photo-preview" alt="待上传的打卡照片" hidden>`, async (input, form) => {
      const file = $('[name="photoFile"]', form).files[0];
      const photo = await photoData(file);
      await api.post(`/runs/${id}/submit`, { note: input.note, photo });
      await session.sync(); toast('打卡已送达！等爸妈来验收吧');
    }, '提交给爸妈验收');
    let previewUrl;
    $('[name="photoFile"]', $('#actionForm')).addEventListener('change', (change) => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const file = change.target.files[0];
      $('#photoPreview').hidden = !file;
      if (file) { previewUrl = URL.createObjectURL(file); $('#photoPreview').src = previewUrl; }
    });
    $('#actionDialog').addEventListener('close', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, { once: true });
  }
  if (button.dataset.action === 'redeem') {
    const reward = session.data.rewards.find((r) => r.id === id);
    if (!reward) return;
    openDialog('向小愿望再近一步', `<div class="inline-summary"><strong>${e(reward.icon)} ${e(reward.title)}</strong><p>这次兑换需要 ${e(reward.price)} 颗星星。</p></div><p>申请后会扣除星星，再等爸妈帮你兑现。准备好了吗？</p>`, async () => {
      const keyId = `${session.data.user.id}:${id}`;
      if (!redemptionKeys.has(keyId)) redemptionKeys.set(keyId, `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
      await api.post('/redemptions', { rewardId: id, requestKey: redemptionKeys.get(keyId) });
      redemptionKeys.delete(keyId);
      await session.sync(); toast('心愿申请已告诉爸妈啦！');
    }, '用星星申请兑换');
  }
});

session.refresh();
