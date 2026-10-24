export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const e = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const statusNames = { available: '待接单', claimed: '进行中', submitted: '待验收', approved: '已完成', paused: '已暂停', expired: '已过期', pending: '等待兑现', fulfilled: '已兑现', rejected: '已退还星星' };
export const icons = { 家务小帮手: '🧸', 自理小达人: '🎒', 学习小标兵: '📖', 运动小健将: '⚽', 爱心小天使: '💛' };
export const pill = (status) => `<span class="pill pill-${e(status)}">${e(statusNames[status] || status)}</span>`;
export const empty = (title, description = '') => `<div class="empty-tip"><span class="icon" aria-hidden="true">🌱</span><b>${e(title)}</b>${e(description)}</div>`;
let zone = 'Asia/Shanghai';
export function formatDate(value) {
  return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
}
let toastTimer;
export function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4200);
}

export function createApi(role) {
  let csrf = '';
  async function request(path, method = 'GET', input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`/api/v1${path}`, {
        method, credentials: 'same-origin', signal: controller.signal,
        headers: { ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) },
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || '操作失败，请重试'), { status: response.status });
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('连接超时，请检查网络后刷新状态');
      if (error instanceof TypeError) throw new Error('暂时连接不上服务器，请检查网络后重试');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  return {
    get: (path) => request(`/${role}${path}`),
    post: (path, input = {}) => request(`/${role}${path}`, 'POST', input),
    patch: (path, input) => request(`/${role}${path}`, 'PATCH', input),
    auth: (kind, input) => request(`/auth/${role}/${kind}`, 'POST', input),
    config: () => request('/config'),
    setCsrf: (value) => { csrf = value; },
  };
}

export function fields(form) { return Object.fromEntries(new FormData(form)); }
export function bindForm(selector, callback) {
  const form = typeof selector === 'string' ? $(selector) : selector;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (form.dataset.busy) return;
    const errorBox = $('.form-error', form);
    if (errorBox) errorBox.textContent = '';
    form.dataset.busy = 'true';
    const buttons = $$('button[type="submit"]', form);
    buttons.forEach((b) => { b.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    try { await callback(fields(form), form); }
    catch (error) { if (errorBox) errorBox.textContent = error.message; else toast(error.message); }
    finally {
      delete form.dataset.busy;
      form.removeAttribute('aria-busy');
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
}

export async function buttonAction(button, callback) {
  if (button.disabled) return;
  button.disabled = true;
  try { await callback(); } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

export function initTabs() {
  const tabs = $$('[data-panel]');
  const select = (name, focus = false) => {
    if (!tabs.some((t) => t.dataset.panel === name)) return;
    tabs.forEach((t) => {
      const active = t.dataset.panel === name;
      t.classList.toggle('on', active);
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
      if (active && focus) t.focus();
    });
    $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== name; });
    $$('.mobile-nav [data-go]').forEach((b) => {
      const active = b.dataset.go === name;
      b.classList.toggle('on', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if ($('#mobilePublish')) $('#mobilePublish').hidden = name !== 'tasks';
    if (window.matchMedia('(max-width:760px)').matches) window.scrollTo(0, 0);
    history.replaceState(null, '', `#${name}`);
    window.dispatchEvent(new Event('tasktown:tab-change'));
  };
  tabs.forEach((t, i) => {
    t.id = `tab-${t.dataset.panel}`;
    t.setAttribute('aria-controls', `view-${t.dataset.panel}`);
    const view = $(`[data-view="${t.dataset.panel}"]`);
    view.id = `view-${t.dataset.panel}`;
    view.setAttribute('role', 'tabpanel');
    view.setAttribute('aria-labelledby', t.id);
    t.addEventListener('click', () => select(t.dataset.panel));
    t.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); select(tabs[next].dataset.panel, true); }
    });
  });
  const initial = location.hash.slice(1);
  select(tabs.some((t) => t.dataset.panel === initial) ? initial : tabs[0].dataset.panel);
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-go]');
    if (button) select(button.dataset.go);
  });
  return select;
}

let dialogCallback;
export function initDialog() {
  $$('[data-close]').forEach((button) => button.addEventListener('click', () => {
    if (!$('#actionForm').dataset.busy) $('#actionDialog').close();
  }));
  $('#actionDialog').addEventListener('cancel', (event) => {
    if ($('#actionForm').dataset.busy) event.preventDefault();
  });
  bindForm('#actionForm', async (input, form) => {
    await dialogCallback(input, form);
    $('#actionDialog').close();
  });
}

export function openDialog(title, html, callback, label = '确认') {
  $('#dialogTitle').textContent = title;
  $('#dialogFields').innerHTML = html;
  $('#dialogSubmit').textContent = label;
  $('.form-error', $('#actionForm')).textContent = '';
  dialogCallback = callback;
  $('#actionDialog').showModal();
}

export function createSession(api, render) {
  let snapshot = null;
  let inFlight = null;
  let epoch = 0;
  const showAuth = () => {
    epoch++;
    snapshot = null;
    api.setCsrf('');
    $('#auth').hidden = false; $('#app').hidden = true; $('#boot').hidden = true; $('#logout').hidden = true;
    document.body.classList.remove('signed-in');
    if ($('#actionDialog').open) $('#actionDialog').close();
    if ($('#taskDialog')?.open) $('#taskDialog').close();
  };
  function refresh() {
    if (inFlight) return inFlight;
    const requestEpoch = epoch;
    inFlight = (async () => {
      try {
        const data = await api.get('/snapshot');
        if (requestEpoch !== epoch) return false;
        zone = data.timeZone;
        api.setCsrf(data.csrfToken);
        const previous = snapshot;
        snapshot = data;
        render(data, previous);
        $('#auth').hidden = true; $('#app').hidden = false; $('#boot').hidden = true; $('#logout').hidden = false;
        document.body.classList.add('signed-in');
        if (!previous) { window.scrollTo(0, 0); requestAnimationFrame(() => window.scrollTo(0, 0)); }
        $('#connection').classList.remove('offline');
        $('#connection').textContent = `已同步 · ${formatDate(data.serverTime)}`;
        return true;
      } catch (error) {
        if (requestEpoch !== epoch) return false;
        if (error.status === 401) showAuth();
        else {
          if (!snapshot) { showAuth(); toast(error.message); }
          $('#connection').classList.add('offline');
          $('#connection').textContent = '同步中断，请检查网络';
        }
        return false;
      } finally { inFlight = null; }
    })();
    return inFlight;
  }
  $('#logout').addEventListener('click', (event) => buttonAction(event.currentTarget, async () => {
    await api.post('/logout'); showAuth(); toast('已退出登录');
  }));
  setInterval(() => { if (!document.hidden && snapshot) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && snapshot) refresh(); });
  window.addEventListener('online', () => { if (snapshot) refresh(); });
  window.addEventListener('tasktown:tab-change', () => { if (snapshot) refresh(); });
  return { refresh, sync: async () => { if (inFlight) await inFlight; return refresh(); }, get data() { return snapshot; } };
}

export function renderLedger(rows, withChild = false) {
  if (!rows.length) return empty('第一颗星星正在路上', '完成任务并通过家长验收后，这里会记下你的收获。');
  return `<table><thead><tr><th>时间</th>${withChild ? '<th>小英雄</th>' : ''}<th>发生了什么</th><th>星星变动</th><th>变动后余额</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${e(formatDate(r.created_at))}</td>${withChild ? `<td>${e(r.child_name)}</td>` : ''}<td class="reason">${e(r.note)}</td><td class="${r.delta > 0 ? 'positive' : 'negative'}">${r.delta > 0 ? '+' : ''}${e(r.delta)} ⭐</td><td class="num">${e(r.balance_after)}</td></tr>`).join('')}</tbody></table>`;
}

export async function photoData(file) {
  if (!file || !file.size) return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 照片');
  if (file.size > 20 * 1024 * 1024) throw new Error('照片太大了，请选择 20MB 以内的照片');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('这张照片无法读取，请换一张'); });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const data = canvas.toDataURL('image/jpeg', 0.82);
  if (data.length > 2 * 1024 * 1024 * 4 / 3) throw new Error('照片仍超过 2MB，请选择更小的照片');
  return data;
}
