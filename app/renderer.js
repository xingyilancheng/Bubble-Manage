const $ = (id) => document.getElementById(id);

const state = {
  tabs: [], active: -1, captures: [], settings: {},
  view: 'browser',
  favorites: [], history: [], showHist: false,
  books: [], filter: 'all', manage: false, query: '',
  sort: 'added', folders: [], bookmarks: [],
  readerBg: 'default', readerFlow: 'page', readerAuto: 'off', readerSpeed: 5,
  readerFontPct: 100, readerLineHeight: 1.8, readerParaSpacing: 0.8,
  readerFontFamily: '',
  user: null,
  accounts: {},
  session: null,
  machineCode: '',
  firstRun: 0,
  activation: null,
  activity: [],
  seenHwnds: new Set(),
};

let currentBook = null;

// Curated quick links shown on the home page.
const SITES = [
  { title: '微信读书', url: 'https://weread.qq.com' },
  { title: '起点中文网', url: 'https://www.qidian.com' },
  { title: '番茄小说', url: 'https://fanqienovel.com' },
  { title: '豆瓣阅读', url: 'https://read.douban.com' },
  { title: '红果短剧', url: 'https://hongguoduanju.com' },
  { title: '哔哩哔哩', url: 'https://www.bilibili.com' },
];

const SEARCH = [
  { title: '百度', url: 'https://www.baidu.com' },
  { title: '必应 Bing', url: 'https://www.bing.com' },
  { title: 'Yandex', url: 'https://yandex.com' },
];

const AI = [
  { title: '豆包', url: 'https://www.doubao.com' },
  { title: '通义千问', url: 'https://tongyi.aliyun.com/qianwen/' },
];

const AV = ['#5b9dff', '#7c6cff', '#ff7a59', '#39c5a8', '#f2b134', '#e56399', '#4aa8ff', '#9b8cff'];

function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u || ''; } }
function colorFor(s) { let h = 0; s = s || ''; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AV[h % AV.length]; }

const READABLE = ['epub', 'pdf', 'txt'];
const HOME_URL = 'https://www.baidu.com';

function normalizeUrl(u) {
  u = (u || '').trim();
  if (!u) return 'about:blank';
  if (/^(about|https?):/i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+/.test(u)) return 'https://' + u;
  return 'https://www.baidu.com/s?wd=' + encodeURIComponent(u);
}

// True only for the clean Baidu home page — a search-results URL may carry
// private query terms, so it does not count as the safe default for boss mode.
function isBaiduHome(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /^www\.baidu\.com$/i.test(u.hostname) && (u.pathname === '/' || u.pathname === '');
  } catch (e) { return false; }
}

// ── View switching ──────────────────────────────────────

function setView(v) {
  if (v === state.view) return;
  if (state.view === 'ebook' && v !== 'ebook') setManage(false);
  // Keep the reader alive when leaving so returning to the same book restores
  // it exactly; just pause auto-reading and dismiss its popups.
  if (state.view === 'reader' && v !== 'reader') {
    if (state.readerAuto !== 'off') setAuto('off');
    closeReaderSettings();
    $('popup-rlist').classList.add('hidden');
  }
  if (state.view === 'notes' && v !== 'notes') nvFlush();
  state.view = v;
  document.body.classList.remove('view-browser', 'view-home', 'view-ebook', 'view-reader', 'view-notes');
  document.body.classList.add('view-' + v);
  // The bookshelf and reader behave like a browser tab switch: bound/captured
  // windows keep their state instead of being hidden. Only the home view pauses.
  const paused = v === 'home';
  window.api.toEngine({ cmd: 'set_paused', value: paused });
  if (v === 'home') renderHome();
  if (v === 'ebook') renderShelf();
  if (v === 'browser') { updateFavBtn(); setTimeout(sendBrowserArea, 30); }
  // reader-host was display:none while away, so re-flow on return in case the
  // window was resized in the meantime.
  if (v === 'reader' && reader && reader.reflow) requestAnimationFrame(() => { try { reader.reflow(); } catch (e) { /* ignore */ } });
}

function toggleView(v) { setView(state.view === v ? 'browser' : v); }

function openUrl(url) { setView('browser'); newTab(url); }

// ── Auth (local placeholder) ────────────────────────────
// No auth server yet: the first login for an account auto-registers it (password
// stored as a local hash), later logins validate the same account's password
// locally, and per-account settings/usage/activation live under state.accounts.
// WeChat login and WeChat activation are UI placeholders pending a backend.
const APP_START = Date.now();

function isLoggedIn() { return !!state.user; }
function currentAccount() { return state.user ? state.accounts[state.user.account] : null; }

// Lightweight local hash (placeholder — not cryptographic security).
function hashPass(s) {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0; h1 = (h1 * 0x01000193) >>> 0;
    h2 = (h2 + c * (i + 7)) >>> 0; h2 = (h2 ^ (h2 << 13) | (h2 >>> 19)) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}

function persistUser() { try { window.api.saveUser(state.user); } catch (e) { /* ignore */ } }
function persistAccounts() { try { window.api.saveAccounts(state.accounts); } catch (e) { /* ignore */ } }

function updateLoginUI() {
  const btn = $('set-login');
  if (btn) btn.textContent = isLoggedIn() ? '注销' : '登录';
  const pb = $('set-pass');
  if (pb) pb.disabled = !isLoggedIn();
  // Only logged-in sessions may bind (capture) windows.
  try { window.api.toEngine({ cmd: 'set_capture_enabled', value: isLoggedIn() }); } catch (e) { /* ignore */ }
}

// Gate for core features. Returns true when logged in; otherwise opens the
// login dialog and returns false so the caller can abort the action.
function ensureLoggedIn() {
  if (isLoggedIn()) return true;
  openLogin();
  return false;
}

// ── Trial / activation gating ───────────────────────────
// Before a valid machine-code activation exists the app runs in a 3-day trial.
// Once the trial lapses every core action is blocked and the activation dialog
// opens instead.
const TRIAL_DAYS = 3;
function isActivated() { return !!state.activation; }
function trialRemainingDays() {
  if (isActivated()) return Infinity;
  if (!state.firstRun) return TRIAL_DAYS;
  const elapsed = Date.now() - state.firstRun;
  const left = Math.ceil((TRIAL_DAYS * 86400000 - elapsed) / 86400000);
  return left > 0 ? left : 0;
}
function isLocked() { return !isActivated() && trialRemainingDays() <= 0; }

// Combined gate for core features: locked (trial over) → activation dialog;
// otherwise not logged in → login dialog. Returns true when the action may run.
function ensureCanUse() {
  if (isLocked()) { openActivate(); return false; }
  return ensureLoggedIn();
}

function logActivity(type, title, detail) {
  const acct = state.user ? state.user.account : '';
  const item = { type, title: title || '', detail: detail || '', account: acct, at: Date.now() };
  state.activity.unshift(item);
  if (state.activity.length > 1000) state.activity.length = 1000;
  try { window.api.activity.add(item); } catch (e) { /* ignore */ }
}

function readerPrefsObj() {
  return {
    readerBg: state.readerBg, readerFlow: state.readerFlow, readerSpeed: state.readerSpeed,
    readerFontPct: state.readerFontPct, readerLineHeight: state.readerLineHeight,
    readerParaSpacing: state.readerParaSpacing, readerFontFamily: state.readerFontFamily,
  };
}

// Save current reader prefs into the logged-in account's profile.
function saveReaderToAccount() {
  const acc = currentAccount();
  if (!acc) return;
  acc.reader = readerPrefsObj();
  persistAccounts();
}

// Load the logged-in account's reader prefs (if any) and apply them live.
function loadAccountReader() {
  const acc = currentAccount();
  if (acc && acc.reader && Object.keys(acc.reader).length) Object.assign(state, acc.reader);
  syncReaderUI();
  try { applyBg(state.readerBg); } catch (e) { /* ignore */ }
  if (reader && reader.applyType) { try { reader.applyType(); } catch (e) { /* ignore */ } }
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => ('0' + n).slice(-2);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtTimeOnly(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => ('0' + n).slice(-2);
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtDur(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return h + ' 小时 ' + m + ' 分';
  if (m) return m + ' 分 ' + sec + ' 秒';
  return sec + ' 秒';
}

// Append the current login session to the account's usage log.
function flushUsage() {
  if (!state.session) return;
  const acc = state.accounts[state.session.account];
  if (acc) {
    const dur = Date.now() - state.session.start;
    if (dur > 1000) {
      if (!Array.isArray(acc.usage)) acc.usage = [];
      acc.usage.push({ start: state.session.start, dur });
      persistAccounts();
    }
  }
  state.session = null;
}

function openLogin() {
  $('lg-err').textContent = '';
  $('popup-about').classList.add('hidden');
  $('popup-activate').classList.add('hidden');
  $('popup-usage').classList.add('hidden');
  $('popup-settings').classList.add('hidden');
  // Defer the reveal by one tick: when a gated action opens this dialog during
  // its own click, the click would otherwise bubble to the document handler and
  // close the dialog we just showed.
  setTimeout(() => {
    $('popup-login').classList.remove('hidden');
    setTimeout(() => { try { $('lg-user').focus(); } catch (e) { /* ignore */ } }, 30);
  }, 0);
}

function closeLogin() { $('popup-login').classList.add('hidden'); }

function switchLoginTab(name) {
  document.querySelectorAll('#popup-login .lg-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('#popup-login .lg-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
}

function doLogin() {
  const account = $('lg-user').value.trim();
  const pass = $('lg-pass').value;
  const err = $('lg-err');
  if (!account) { err.textContent = '请输入账号'; return; }
  if (!pass || pass.length < 6) { err.textContent = '密码至少 6 位'; return; }
  const h = hashPass(pass);
  const existing = state.accounts[account];
  if (existing) {
    if (existing.pass !== h) { err.textContent = '密码错误，请重试'; return; }
  } else {
    // First login for this account: auto-register.
    state.accounts[account] = { pass: h, createdAt: Date.now(), reader: {}, usage: [], activation: null };
  }
  err.textContent = '';
  flushUsage();
  state.user = { account, method: 'password', at: Date.now() };
  state.session = { account, start: Date.now() };
  persistAccounts();
  persistUser();
  loadAccountReader();
  updateLoginUI();
  $('lg-pass').value = '';
  closeLogin();
}

function doLogout() {
  saveReaderToAccount();
  flushUsage();
  state.user = null;
  persistUser();
  updateLoginUI();
  $('popup-settings').classList.add('hidden');
}

function openAbout() {
  $('popup-login').classList.add('hidden');
  $('popup-activate').classList.add('hidden');
  $('popup-usage').classList.add('hidden');
  $('popup-settings').classList.add('hidden');
  $('ab-up-tip').textContent = '';
  $('popup-about').classList.remove('hidden');
}

function closeAbout() { $('popup-about').classList.add('hidden'); $('popup-qrzoom').classList.add('hidden'); }

function openHelp() {
  closeToolbarPopups();
  $('popup-help').classList.remove('hidden');
}
function closeHelp() { $('popup-help').classList.add('hidden'); }

// ── Activation ──────────────────────────────────────────
function refreshActivateStatus() {
  const el = $('ac-status');
  if (state.activation) {
    el.textContent = '已激活 · 本机码 · ' + fmtTime(state.activation.at);
    el.classList.add('on');
  } else {
    const left = trialRemainingDays();
    el.textContent = left > 0 ? ('未激活 · 试用剩余 ' + left + ' 天') : '未激活 · 试用已结束';
    el.classList.remove('on');
  }
}

function openActivate() {
  $('popup-login').classList.add('hidden');
  $('popup-about').classList.add('hidden');
  $('popup-usage').classList.add('hidden');
  $('popup-settings').classList.add('hidden');
  $('ac-err').textContent = '';
  // Defer reveal one tick so the gating click that opened this dialog cannot
  // immediately bubble to the document handler and close it.
  setTimeout(() => {
    $('popup-activate').classList.remove('hidden');
    window.api.getMachineCode().then((c) => { state.machineCode = c || ''; $('ac-machine').textContent = c || '————'; });
    refreshActivateStatus();
  }, 0);
}

function closeActivate() { $('popup-activate').classList.add('hidden'); $('popup-qrzoom').classList.add('hidden'); }

function doActivate() {
  const code = $('ac-code-input').value.trim();
  const err = $('ac-err');
  if (code.length < 6) { err.textContent = '请输入激活码'; return; }
  err.textContent = '';
  window.api.activate(code).then((res) => {
    if (res && res.ok) {
      state.activation = res.activation;
      $('ac-code-input').value = '';
      refreshActivateStatus();
      updateStatus();
    } else {
      err.textContent = '激活码无效，请检查本机码后重试';
    }
  });
}

// ── Usage query ─────────────────────────────────────────
let usageTimer = null;
let usageDayOffset = 0; // 0 = today, up to 6 = 6 days ago (7-day window)

// Return [startMs, endMs) for the calendar day `offset` days before today.
function dayRange(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return [d.getTime(), d.getTime() + 86400000];
}
function dayLabel(offset) {
  if (offset === 0) return '今天';
  if (offset === 1) return '昨天';
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - offset);
  const p = (n) => ('0' + n).slice(-2);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function renderUsage() {
  const acc = currentAccount();
  $('us-acct').textContent = state.user ? ('账户：' + state.user.account) : '未登录';
  const acctName = state.user ? state.user.account : '';

  // Day selector: last 7 days.
  const sel = $('us-day');
  if (sel && sel.options.length !== 7) {
    sel.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const o = document.createElement('option');
      o.value = String(i); o.textContent = dayLabel(i);
      sel.appendChild(o);
    }
  }
  if (sel) sel.value = String(usageDayOffset);

  const openAt = state.session ? state.session.start : (state.user && state.user.at);
  const curDur = state.session ? (Date.now() - state.session.start) : 0;
  const totalMs = acc ? ((acc.usage || []).reduce((s, u) => s + (u.dur || 0), 0) + curDur) : 0;
  $('us-open').textContent = fmtTimeOnly(openAt);
  $('us-dur').textContent = fmtDur(curDur);
  $('us-total').textContent = acc ? fmtDur(totalMs) : '—';

  const [ds, de] = dayRange(usageDayOffset);
  const inDay = (ts) => ts >= ds && ts < de;

  // Browse records for the selected day.
  const histBox = $('us-hist'); histBox.innerHTML = '';
  const hist = (state.history || []).filter((h) => (h.account || '') === acctName && inDay(h.at || 0)).slice(0, 80);
  if (!hist.length) histBox.appendChild(usageEmpty('当日暂无浏览记录'));
  else for (const h of hist) {
    const row = document.createElement('div'); row.className = 'us-hi';
    const tm = document.createElement('span'); tm.className = 'us-hi-time'; tm.textContent = (new Date(h.at)).toTimeString().slice(0, 5);
    const t = document.createElement('span'); t.className = 'us-hi-t'; t.textContent = h.title || h.url;
    const u = document.createElement('span'); u.className = 'us-hi-u'; u.textContent = h.url;
    row.appendChild(tm); row.appendChild(t); row.appendChild(u); histBox.appendChild(row);
  }

  // Reading + capture records for the selected day.
  const readBox = $('us-read'); readBox.innerHTML = '';
  const capBox = $('us-cap'); capBox.innerHTML = '';
  const sesBox = $('us-session'); sesBox.innerHTML = '';
  // Activity records for the selected day. Open/close are app-level (no account
  // filter); read/capture belong to the account but pre-login records (empty
  // account) still show so nothing is lost.
  const acts = (state.activity || []).filter((a) => inDay(a.at || 0));
  const own = (a) => (a.account || '') === acctName || !(a.account || '');
  const reads = acts.filter((a) => a.type === 'read' && own(a)).slice(0, 80);
  const caps = acts.filter((a) => a.type === 'capture' && own(a)).slice(0, 80);
  const sessions = acts.filter((a) => a.type === 'open' || a.type === 'close').slice(0, 80);
  if (!reads.length) readBox.appendChild(usageEmpty('当日暂无阅读记录'));
  else for (const a of reads) readBox.appendChild(activityRow(a));
  if (!caps.length) capBox.appendChild(usageEmpty('当日暂无绑定窗口记录'));
  else for (const a of caps) capBox.appendChild(activityRow(a));
  if (!sessions.length) sesBox.appendChild(usageEmpty('当日暂无启动/关闭记录'));
  else for (const a of sessions) sesBox.appendChild(activityRow(a));
}
function activityRow(a) {
  const row = document.createElement('div'); row.className = 'us-hi';
  const tm = document.createElement('span'); tm.className = 'us-hi-time'; tm.textContent = (new Date(a.at)).toTimeString().slice(0, 5);
  const t = document.createElement('span'); t.className = 'us-hi-t'; t.textContent = a.title || '—';
  const d = document.createElement('span'); d.className = 'us-hi-u'; d.textContent = a.detail || '';
  row.appendChild(tm); row.appendChild(t); row.appendChild(d);
  return row;
}
function usageEmpty(msg) {
  const d = document.createElement('div'); d.className = 'us-empty'; d.textContent = msg; return d;
}

function openUsage() {
  if (!ensureCanUse()) return;
  $('popup-login').classList.add('hidden');
  $('popup-about').classList.add('hidden');
  $('popup-activate').classList.add('hidden');
  $('popup-settings').classList.add('hidden');
  setTimeout(() => {
    $('popup-usage').classList.remove('hidden');
    Promise.all([window.api.history.list(), window.api.activity.list()]).then(([h, a]) => {
      state.history = h || []; state.activity = a || []; renderUsage();
    });
    renderUsage();
    clearInterval(usageTimer);
    usageTimer = setInterval(() => { if (!$('popup-usage').classList.contains('hidden')) renderUsage(); }, 1000);
  }, 0);
}

function closeUsage() { $('popup-usage').classList.add('hidden'); clearInterval(usageTimer); usageTimer = null; }

// Close every toolbar-anchored popup. Also bound to window blur so clicks that
// land inside the <webview> (which never bubble to the host document) dismiss them.
function closeToolbarPopups() {
  ['popup-opacity', 'popup-zoom', 'popup-settings', 'popup-about', 'popup-login', 'popup-activate', 'popup-usage', 'popup-pass', 'popup-help'].forEach((id) => {
    const el = $(id); if (el) el.classList.add('hidden');
  });
  try { hideTabMenu(); } catch (e) { /* ignore */ }
  clearInterval(usageTimer); usageTimer = null;
}

// ── Notes (browser + reader) ────────────────────────────
function noteContext() {
  if (state.view === 'reader') {
    const t = ($('reader-title') && $('reader-title').textContent) || '';
    const p = ($('reader-pos') && $('reader-pos').textContent) || '';
    return { kind: 'reader', ctx: [t, p].filter(Boolean).join(' · ') };
  }
  const t = state.tabs.find((x) => x.el && x.el.style.display !== 'none');
  const title = t ? t.title : '';
  const url = $('url').value || (t && t.url) || '';
  return { kind: 'browser', ctx: [title, url].filter(Boolean).join(' · ') };
}
function renderNotes(list) {
  const box = $('nt-list');
  if (!box) return;
  box.innerHTML = '';
  if (!list || !list.length) {
    const e = document.createElement('div'); e.className = 'nt-empty'; e.textContent = '暂无笔记';
    box.appendChild(e); return;
  }
  for (const n of list) {
    const item = document.createElement('div'); item.className = 'nt-item';
    const text = document.createElement('div'); text.className = 'nt-text'; text.textContent = n.text;
    item.appendChild(text);
    if (n.ctx) {
      const c = document.createElement('div'); c.className = 'nt-ctx'; c.textContent = n.ctx;
      item.appendChild(c);
    }
    const meta = document.createElement('div'); meta.className = 'nt-meta';
    const tag = document.createElement('span'); tag.className = 'nt-tag';
    tag.textContent = n.kind === 'reader' ? '电子书' : '浏览器';
    const time = document.createElement('span'); time.className = 'nt-time'; time.textContent = fmtTime(n.at);
    const del = document.createElement('button'); del.className = 'nt-del'; del.textContent = '删除';
    del.onclick = () => { window.api.notes.del(n.id).then(refreshNotes); };
    meta.append(tag, time, del);
    item.appendChild(meta);
    box.appendChild(item);
  }
}
function refreshNotes() { window.api.notes.list().then(renderNotes); }
function openNotes() {
  $('popup-login').classList.add('hidden');
  $('popup-about').classList.add('hidden');
  $('popup-activate').classList.add('hidden');
  $('popup-settings').classList.add('hidden');
  $('popup-usage').classList.add('hidden');
  const c = noteContext();
  $('nt-ctx').textContent = c.ctx ? ('当前：' + c.ctx) : '';
  $('nt-input').value = '';
  setTimeout(() => { $('popup-notes').classList.remove('hidden'); refreshNotes(); }, 0);
}
function closeNotes() { $('popup-notes').classList.add('hidden'); }

// ── Change password (local placeholder auth) ────────────
function openPass() {
  if (!ensureLoggedIn()) return;
  $('ps-old').value = '';
  $('ps-new').value = '';
  $('ps-new2').value = '';
  $('ps-err').textContent = '';
  $('popup-settings').classList.add('hidden');
  setTimeout(() => {
    $('popup-pass').classList.remove('hidden');
    setTimeout(() => { try { $('ps-old').focus(); } catch (e) { /* ignore */ } }, 30);
  }, 0);
}
function closePass() { $('popup-pass').classList.add('hidden'); }
function doChangePass() {
  const err = $('ps-err');
  const acc = currentAccount();
  if (!acc) { err.textContent = '请先登录'; return; }
  const oldP = $('ps-old').value;
  const n1 = $('ps-new').value;
  const n2 = $('ps-new2').value;
  if (hashPass(oldP) !== acc.pass) { err.textContent = '当前密码错误'; return; }
  if (n1.length < 6) { err.textContent = '新密码至少 6 位'; return; }
  if (n1 !== n2) { err.textContent = '两次输入的新密码不一致'; return; }
  acc.pass = hashPass(n1);
  persistAccounts();
  err.textContent = '';
  closePass();
}


// ── Browser tabs (webview) ──────────────────────────────

function newTab(url) {
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:catcher');
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36');
  wv.style.display = 'none';
  const tab = { id: state.tabs.length + '-' + Date.now(), title: '新标签', url: url || '', el: wv };
  wv.addEventListener('page-title-updated', (e) => { tab.title = e.title; renderTabs(); updateFavBtn(); });
  wv.addEventListener('did-navigate', (e) => { tab.url = e.url; onTabNav(tab); });
  wv.addEventListener('did-navigate-in-page', (e) => { tab.url = e.url; onTabNav(tab); });
  wv.addEventListener('did-start-loading', () => {
    if (state.tabs[state.active] === tab) $('nav-reload').classList.add('loading');
    renderTabs();
  });
  wv.addEventListener('did-stop-loading', () => {
    $('nav-reload').classList.remove('loading');
    renderTabs();
    if (tab.url && /^https?:/i.test(tab.url)) {
      const acct = state.user ? state.user.account : '';
      window.api.history.add({ title: tab.title, url: tab.url, account: acct });
    }
  });
  $('browser-area').appendChild(wv);
  if (url) wv.src = normalizeUrl(url);
  state.tabs.push(tab);
  activate(state.tabs.length - 1);
}

// Opens the full notes editor as a browser tab. The guest preload only exposes
// the notes API to first-party app:// pages, so this is safe.
function openNotesView() {
  if (state.view !== 'notes') state.nvReturn = state.view;
  setView('notes');
  nvFlush();
  window.api.notes.list().then((list) => {
    state.nvNotes = (list || []).slice();
    renderNotesView();
  });
}

function renderNotesView() {
  const list = state.nvNotes || [];
  const wrap = $('nv-list');
  wrap.innerHTML = '';
  $('nv-empty').style.display = list.length ? 'none' : '';
  $('nv-count').textContent = list.length ? ('共 ' + list.length + ' 条') : '';
  list.forEach((n, i) => {
    const card = document.createElement('div');
    card.className = 'nv-card';
    const ta = document.createElement('textarea');
    ta.value = n.text || '';
    ta.spellcheck = false;
    ta.addEventListener('input', () => { n.text = ta.value; nvScheduleSave(); });
    const meta = document.createElement('div');
    meta.className = 'nv-meta';
    const ctx = document.createElement('span');
    ctx.textContent = [n.ctx, n.at ? fmtTime(n.at) : ''].filter(Boolean).join(' · ');
    ctx.title = ctx.textContent;
    meta.appendChild(ctx);
    const acts = document.createElement('div');
    acts.className = 'nv-acts';
    const mk = (label, disabled, fn) => {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = label;
      b.disabled = !!disabled;
      b.onclick = fn;
      return b;
    };
    acts.appendChild(mk('上移', i === 0, () => {
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
      renderNotesView(); nvScheduleSave();
    }));
    acts.appendChild(mk('下移', i === list.length - 1, () => {
      [list[i + 1], list[i]] = [list[i], list[i + 1]];
      renderNotesView(); nvScheduleSave();
    }));
    acts.appendChild(mk('删除', false, () => {
      list.splice(i, 1);
      renderNotesView(); nvScheduleSave();
    }));
    meta.appendChild(acts);
    card.appendChild(ta);
    card.appendChild(meta);
    wrap.appendChild(card);
  });
}

let nvTimer = null;
let nvDirty = false;
function nvScheduleSave() {
  nvDirty = true;
  clearTimeout(nvTimer);
  nvTimer = setTimeout(nvFlush, 600);
}
function nvFlush() {
  clearTimeout(nvTimer);
  if (!nvDirty) return;
  nvDirty = false;
  const list = (state.nvNotes || [])
    .map((n) => Object.assign({}, n, { text: String(n.text || '').trim() }))
    .filter((n) => n.text);
  state.nvNotes = list;
  window.api.notes.setAll(list).then(() => {
    renderNotesView();
    refreshNotes();
  });
}

function onTabNav(tab) {
  if (state.tabs[state.active] === tab) {
    $('url').value = tab.url || '';
    window.api.saveUrl(tab.url);
    updateFavBtn();
  }
  renderTabs();
}

function activate(i) {
  if (i < 0 || i >= state.tabs.length) return;
  state.active = i;
  state.tabs.forEach((t, idx) => { t.el.style.display = idx === i ? 'flex' : 'none'; });
  const t = state.tabs[i];
  if (t) $('url').value = t.url || '';
  renderTabs();
  updateFavBtn();
  updateStatus();
}

function closeTab(i) {
  if (i < 0 || i >= state.tabs.length) return;
  const t = state.tabs.splice(i, 1)[0];
  if (t && t.el) t.el.remove();
  if (!state.tabs.length) { newTab(HOME_URL); return; }
  activate(Math.min(i, state.tabs.length - 1));
}

function activeWebview() {
  const t = state.tabs[state.active];
  return t ? t.el : null;
}

function activeTab() { return state.tabs[state.active] || null; }

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  state.tabs.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tab' + (i === state.active ? ' active' : '');
    const tt = document.createElement('span');
    tt.className = 't';
    tt.textContent = t.title || '新标签';
    tt.title = t.title || '';
    tt.onclick = () => { setView('browser'); activate(i); };
    d.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm('关闭标签「' + (t.title || '') + '」？')) closeTab(i);
    };
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    d.appendChild(tt); d.appendChild(x);
    box.appendChild(d);
  });
  state.captures.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'tab cap';
    const tt = document.createElement('span');
    tt.className = 't';
    tt.textContent = (c.minimized ? '▁ ' : '') + c.title;
    tt.title = c.title;
    tt.onclick = () => {
      setView('browser');
      window.api.toEngine(c.minimized
        ? { cmd: 'tab_restore', hwnd: c.hwnd }
        : { cmd: 'bring_top', hwnd: c.hwnd });
    };
    tt.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm('确定要释放窗口「' + c.title + '」吗？')) {
        window.api.toEngine({ cmd: 'release', hwnd: c.hwnd });
      }
    };
    d.appendChild(tt);
    if (!c.minimized) {
      const m = document.createElement('span');
      m.className = 'x';
      m.textContent = '─';
      m.onclick = (e) => { e.stopPropagation(); window.api.toEngine({ cmd: 'tab_minimize', hwnd: c.hwnd }); };
      d.appendChild(m);
    }
    box.appendChild(d);
  });
  updateOverflow();
  updateNavBtns();
  if (!$('tab-menu').classList.contains('hidden')) renderTabMenu();
}

// ── Tab overflow ────────────────────────────────────────

function updateOverflow() {
  const tabs = $('tabs');
  const over = tabs.scrollWidth > tabs.clientWidth + 1;
  $('tab-overflow').classList.toggle('hidden', !over);
  if (!over) hideTabMenu();
}

function hideTabMenu() {
  $('tab-menu').classList.add('hidden');
  $('tab-overflow').classList.remove('on');
}

function showTabMenu() {
  const menu = $('tab-menu');
  renderTabMenu();
  menu.classList.remove('hidden');
  $('tab-overflow').classList.add('on');
  const r = $('tab-overflow').getBoundingClientRect();
  const mw = menu.offsetWidth;
  let left = r.right - mw;
  if (left < 6) left = 6;
  if (left + mw > window.innerWidth - 6) left = window.innerWidth - mw - 6;
  menu.style.left = left + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
}

function toggleTabMenu() {
  if ($('tab-menu').classList.contains('hidden')) showTabMenu();
  else hideTabMenu();
}

function renderTabMenu() {
  const menu = $('tab-menu');
  menu.innerHTML = '';
  if (state.tabs.length) {
    const h = document.createElement('div');
    h.className = 'tm-head';
    h.textContent = '标签页 (' + state.tabs.length + ')';
    menu.appendChild(h);
    state.tabs.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'tm-row' + (i === state.active ? ' active' : '');
      const tt = document.createElement('span');
      tt.className = 'tm-t';
      tt.textContent = t.title || '新标签';
      tt.title = t.url || t.title || '';
      row.appendChild(tt);
      const x = document.createElement('span');
      x.className = 'tm-x';
      x.textContent = '×';
      x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
      row.appendChild(x);
      row.onclick = () => { setView('browser'); activate(i); hideTabMenu(); };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        if (confirm('关闭标签「' + (t.title || '') + '」？')) { closeTab(i); hideTabMenu(); }
      };
      menu.appendChild(row);
    });
  }
  if (state.captures.length) {
    const sep = document.createElement('div');
    sep.className = 'tm-sep';
    menu.appendChild(sep);
    const h = document.createElement('div');
    h.className = 'tm-head';
    h.textContent = '捕获窗口 (' + state.captures.length + ')';
    menu.appendChild(h);
    state.captures.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'tm-row';
      const tt = document.createElement('span');
      tt.className = 'tm-t cap';
      tt.textContent = (c.minimized ? '▁ ' : '') + c.title;
      tt.title = c.title;
      row.appendChild(tt);
      row.onclick = () => {
        setView('browser');
        window.api.toEngine(c.minimized ? { cmd: 'tab_restore', hwnd: c.hwnd } : { cmd: 'bring_top', hwnd: c.hwnd });
        hideTabMenu();
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        if (confirm('确定要释放窗口「' + c.title + '」吗？')) {
          window.api.toEngine({ cmd: 'release', hwnd: c.hwnd });
          hideTabMenu();
        }
      };
      menu.appendChild(row);
    });
  }
}

// ── Capture panel / status ──────────────────────────────

let capSelected = new Set();

function renderCapList() {
  const box = $('cap-list');
  box.innerHTML = '';
  const validHwnds = new Set(state.captures.map((c) => c.hwnd));
  for (const h of capSelected) { if (!validHwnds.has(h)) capSelected.delete(h); }
  state.captures.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'cap-item' + (capSelected.has(c.hwnd) ? ' selected' : '');
    d.textContent = c.title;
    d.title = c.title + (c.minimized ? ' (已最小化)' : '');
    d.onclick = (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (capSelected.has(c.hwnd)) capSelected.delete(c.hwnd);
        else capSelected.add(c.hwnd);
        renderCapList();
      } else {
        setView('browser');
        window.api.toEngine(c.minimized
          ? { cmd: 'tab_restore', hwnd: c.hwnd }
          : { cmd: 'bring_top', hwnd: c.hwnd });
      }
    };
    box.appendChild(d);
  });
  const btn = $('btn-release-sel');
  if (capSelected.size > 0) { btn.classList.remove('hidden'); btn.textContent = '释放选中(' + capSelected.size + ')'; }
  else btn.classList.add('hidden');
}

function updateStatus() {
  let base = '已捕获: ' + state.captures.length + ' 个窗口 | 浏览器: ✔ (' + state.tabs.length + ' 标签)';
  if (!isActivated()) {
    const left = trialRemainingDays();
    base += left > 0 ? (' | 试用剩余 ' + left + ' 天') : ' | 试用已结束，请激活';
  } else {
    base += ' | 已激活';
  }
  $('status').textContent = base;
}

// ── Browser-area screen rect (for maximized captures) ───

function sendBrowserArea() {
  const r = $('browser-area').getBoundingClientRect();
  const frameX = Math.round((window.outerWidth - window.innerWidth) / 2);
  const topChrome = window.outerHeight - window.innerHeight - frameX;
  const ox = window.screenX + frameX;
  const oy = window.screenY + topChrome;
  window.api.toEngine({
    cmd: 'set_browser_area',
    rect: [Math.round(ox + r.left), Math.round(oy + r.top), Math.round(r.width), Math.round(r.height)],
  });
}

// ── Favorites ───────────────────────────────────────────

function updateFavBtn() {
  const t = activeTab();
  const on = t && t.url && state.favorites.some((f) => f.url === t.url);
  $('nav-fav').classList.toggle('active', !!on);
}

function updateNavBtns() {
  const w = activeWebview();
  let back = false, fwd = false;
  try { back = !!(w && w.canGoBack && w.canGoBack()); } catch (e) { /* not ready */ }
  try { fwd = !!(w && w.canGoForward && w.canGoForward()); } catch (e) { /* not ready */ }
  $('nav-back').disabled = !back;
  $('nav-fwd').disabled = !fwd;
}

function toggleFav() {
  const t = activeTab();
  if (!t || !t.url || !/^https?:/i.test(t.url)) return;
  const exists = state.favorites.some((f) => f.url === t.url);
  const p = exists
    ? window.api.favorites.remove(t.url)
    : window.api.favorites.add({ title: t.title || t.url, url: t.url });
  p.then((list) => { state.favorites = list || []; updateFavBtn(); if (state.view === 'home') renderHome(); });
}

// ── Home view ───────────────────────────────────────────

function emptyHint(text) {
  const d = document.createElement('div');
  d.className = 'link-empty';
  d.textContent = text;
  return d;
}

function tile(title, url, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'tile';
  el.title = url;
  const av = document.createElement('div');
  av.className = 'av';
  av.textContent = (title || url || '?').trim().charAt(0);
  av.style.background = colorFor(url || title);
  const tx = document.createElement('div');
  tx.className = 'tx';
  const t1 = document.createElement('div');
  t1.className = 't1';
  t1.textContent = title || url;
  const t2 = document.createElement('div');
  t2.className = 't2';
  t2.textContent = domainOf(url);
  tx.appendChild(t1); tx.appendChild(t2);
  el.appendChild(av); el.appendChild(tx);
  el.onclick = () => openUrl(url);
  if (opts.onDel) {
    const d = document.createElement('span');
    d.className = 'del';
    d.textContent = '×';
    d.onclick = (e) => { e.stopPropagation(); opts.onDel(); };
    el.appendChild(d);
  }
  return el;
}

function sectionShell(title, count, hideCount) {
  const el = document.createElement('section');
  el.className = 'home-section';
  const head = document.createElement('div');
  head.className = 'hs-head';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const h = document.createElement('h3');
  h.textContent = title;
  head.appendChild(dot); head.appendChild(h);
  if (!hideCount && count != null) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = count;
    head.appendChild(c);
  }
  const grid = document.createElement('div');
  grid.className = 'tile-grid';
  el.appendChild(head); el.appendChild(grid);
  return { el, head, grid };
}

function linkSection(title, arr) {
  const s = sectionShell(title, arr.length);
  arr.forEach((it) => s.grid.appendChild(tile(it.title, it.url)));
  return s.el;
}

function renderHome() {
  const body = $('home-body');
  body.innerHTML = '';
  $('home-toggle-hist').classList.toggle('on', state.showHist);

  const hero = document.createElement('div');
  hero.className = 'home-hero';
  const h1 = document.createElement('span');
  h1.className = 'h1';
  h1.textContent = '开始浏览';
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = '搜索引擎 · AI 工具 · 电子书资源 · 我的收藏';
  hero.appendChild(h1); hero.appendChild(sub);
  body.appendChild(hero);

  body.appendChild(linkSection('经典搜索引擎', SEARCH));
  body.appendChild(linkSection('经典 AI 网页版', AI));
  body.appendChild(linkSection('电子书经典网站', SITES));

  const favSec = sectionShell('我的收藏', state.favorites.length);
  if (!state.favorites.length) {
    favSec.grid.appendChild(emptyHint('还没有收藏，浏览网页时点击地址栏的星标收藏。'));
  } else {
    state.favorites.forEach((f) => favSec.grid.appendChild(tile(f.title, f.url, {
      onDel: () => window.api.favorites.remove(f.url).then((l) => { state.favorites = l || []; updateFavBtn(); renderHome(); }),
    })));
  }
  body.appendChild(favSec.el);

  if (state.showHist) {
    const hSec = sectionShell('历史记录', null, true);
    const clear = document.createElement('button');
    clear.className = 'mini';
    clear.textContent = '清空';
    clear.onclick = () => {
      if (confirm('清空历史记录？')) window.api.history.clear().then(() => { state.history = []; renderHome(); });
    };
    hSec.head.appendChild(clear);
    if (!state.history.length) {
      hSec.grid.appendChild(emptyHint('暂无历史记录。'));
    } else {
      state.history.slice(0, 120).forEach((h) => hSec.grid.appendChild(tile(h.title, h.url)));
    }
    body.appendChild(hSec.el);
  }
}

// ── Bookshelf ───────────────────────────────────────────

function setManage(on) {
  state.manage = on;
  document.body.classList.toggle('manage', on);
  $('shelf-manage').classList.toggle('on', on);
  $('shelf-manage').textContent = on ? '完成整理' : '整理书架';
  if (state.view === 'ebook') renderShelf();
}

function collections() {
  const set = new Set();
  state.folders.forEach((f) => { if (f) set.add(f); });
  state.books.forEach((b) => { if (b.collection) set.add(b.collection); });
  return Array.from(set).sort();
}

function sortBooks(list) {
  const arr = list.slice();
  if (state.sort === 'recent') arr.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0) || (b.added || 0) - (a.added || 0));
  else if (state.sort === 'progress') arr.sort((a, b) => (b.progress || 0) - (a.progress || 0) || (b.lastOpened || 0) - (a.lastOpened || 0));
  else arr.sort((a, b) => (b.added || 0) - (a.added || 0));
  return arr;
}

function renderBookmarkResults() {
  const box = $('bm-results');
  if (!box) return;
  const q = state.query;
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const matches = state.bookmarks.filter((bm) =>
    ((bm.label || '') + ' ' + (bm.bookTitle || '')).toLowerCase().includes(q));
  box.innerHTML = '';
  if (!matches.length) { box.classList.add('hidden'); return; }
  const head = document.createElement('div');
  head.className = 'bm-head';
  head.textContent = '书签查询 · ' + matches.length + ' 条';
  box.appendChild(head);
  matches.slice(0, 200).forEach((bm) => {
    const card = document.createElement('div');
    card.className = 'bm-card';
    const main = document.createElement('div');
    main.className = 'bm-main';
    const label = document.createElement('div');
    label.className = 'bm-label';
    label.textContent = bm.label || '书签';
    const book = document.createElement('div');
    book.className = 'bm-book';
    const where = bmWhere(bm);
    book.textContent = (bm.bookTitle || '未命名') + (where ? ' · ' + where : '') + ' · ' + fmtDate(bm.at);
    main.appendChild(label); main.appendChild(book);
    if (bm.excerpt) {
      const ex = document.createElement('div');
      ex.className = 'bm-ex';
      ex.textContent = bm.excerpt;
      ex.title = bm.excerpt;
      main.appendChild(ex);
    }
    card.appendChild(main);
    const del = document.createElement('button');
    del.className = 'bm-del';
    del.textContent = '×';
    del.title = '删除书签';
    del.onclick = (e) => {
      e.stopPropagation();
      window.api.library.removeBookmark(bm.bookId, bm.id).then((l) => {
        state.books = l || [];
        state.bookmarks = flattenBookmarks(state.books);
        renderBookmarkResults();
      });
    };
    card.appendChild(del);
    card.onclick = () => {
      const b = state.books.find((x) => x.id === bm.bookId);
      if (!b) { alert('对应的书籍已不在书架中。'); return; }
      openBook(b, bm.loc || {});
    };
    box.appendChild(card);
  });
  box.classList.remove('hidden');
}

function flattenBookmarks(books) {
  const out = [];
  (books || []).forEach((b) => (b.bookmarks || []).forEach((bm) => out.push({
    id: bm.id, bookId: b.id, bookTitle: b.title, format: b.format,
    label: bm.label, loc: bm.loc, excerpt: bm.excerpt, progress: bm.progress,
    page: bm.page, total: bm.total, at: bm.at,
  })));
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out;
}

// "第X页" / "NN%" descriptor for a bookmark, used across all bookmark lists.
function bmWhere(bm) {
  if (bm && bm.page && bm.total) return '第 ' + bm.page + ' / ' + bm.total + ' 页';
  if (bm && bm.page) return '第 ' + bm.page + ' 页';
  if (bm && typeof bm.progress === 'number' && bm.progress > 0) return Math.round(bm.progress * 100) + '%';
  return '';
}

function openBookmarksDialog() {
  $('bm-dlg-search').value = '';
  renderBookmarksDialog();
  $('popup-bmarks').classList.remove('hidden');
}

function renderBookmarksDialog() {
  const list = $('bm-dlg-list');
  list.innerHTML = '';
  const q = ($('bm-dlg-search').value || '').trim().toLowerCase();
  const all = flattenBookmarks(state.books);
  const items = q
    ? all.filter((bm) => ((bm.label || '') + ' ' + (bm.bookTitle || '')).toLowerCase().includes(q))
    : all;
  if (!items.length) {
    list.appendChild(emptyHint(all.length ? '没有匹配的书签。' : '还没有任何书签，阅读时点击「添加书签」即可收藏位置。'));
    return;
  }
  items.forEach((bm) => {
    const card = document.createElement('div');
    card.className = 'bm-card';
    const main = document.createElement('div');
    main.className = 'bm-main';
    const label = document.createElement('div');
    label.className = 'bm-label';
    label.textContent = bm.label || '书签';
    const book = document.createElement('div');
    book.className = 'bm-book';
    const where = bmWhere(bm);
    book.textContent = (bm.bookTitle || '未命名') + (where ? ' · ' + where : '') + ' · ' + fmtDate(bm.at);
    main.appendChild(label); main.appendChild(book);
    if (bm.excerpt) {
      const ex = document.createElement('div');
      ex.className = 'bm-ex';
      ex.textContent = bm.excerpt;
      ex.title = bm.excerpt;
      main.appendChild(ex);
    }
    card.appendChild(main);
    const del = document.createElement('button');
    del.className = 'bm-del';
    del.textContent = '×';
    del.title = '删除书签';
    del.onclick = (e) => {
      e.stopPropagation();
      window.api.library.removeBookmark(bm.bookId, bm.id).then((l) => {
        state.books = l || [];
        state.bookmarks = flattenBookmarks(state.books);
        renderBookmarksDialog();
        if (state.view === 'ebook') renderShelf();
      });
    };
    card.appendChild(del);
    card.onclick = () => {
      const b = state.books.find((x) => x.id === bm.bookId);
      if (!b) { alert('对应的书籍已不在书架中。'); return; }
      $('popup-bmarks').classList.add('hidden');
      openBook(b, bm.loc || {});
    };
    list.appendChild(card);
  });
}

function renderShelf() {
  const filters = $('shelf-filters');
  filters.innerHTML = '';
  const cols = collections();
  if (state.filter !== 'all' && !cols.includes(state.filter)) state.filter = 'all';
  const chips = ['all'].concat(cols);
  chips.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'fchip' + (c === state.filter ? ' active' : '');
    const txt = document.createElement('span');
    txt.textContent = c === 'all' ? '全部' : c;
    b.appendChild(txt);
    if (c !== 'all' && state.manage) {
      const del = document.createElement('span');
      del.className = 'fdel';
      del.textContent = '×';
      del.title = '删除文件夹（不影响书籍文件）';
      del.onclick = (e) => {
        e.stopPropagation();
        if (!confirm('删除分类「' + c + '」？该分类下的书籍将变为未分类。')) return;
        window.api.folders.remove(c).then((folders) => {
          state.folders = folders || [];
          return window.api.library.list();
        }).then((l) => {
          state.books = l || [];
          state.bookmarks = flattenBookmarks(state.books);
          if (state.filter === c) state.filter = 'all';
          renderShelf();
        });
      };
      b.appendChild(del);
    }
    b.onclick = () => { state.filter = c; renderShelf(); };
    filters.appendChild(b);
  });

  const grid = $('shelf-grid');
  grid.innerHTML = '';
  const q = state.query;
  const books = sortBooks(state.books.filter((b) => {
    if (state.filter !== 'all' && b.collection !== state.filter) return false;
    if (!q) return true;
    return ((b.title || '') + ' ' + (b.author || '') + ' ' + (b.collection || '')).toLowerCase().includes(q);
  }));
  $('shelf-empty').style.display = books.length ? 'none' : 'block';
  $('shelf-empty').textContent = state.books.length
    ? '没有匹配的书籍。'
    : '书架空空如也，点击「上传书籍」导入 epub / pdf / txt 等常见格式。';
  books.forEach((b) => grid.appendChild(bookCard(b)));
  renderBookmarkResults();
}

function bookCard(b) {
  const wrap = document.createElement('div');
  wrap.className = 'book';
  const cover = document.createElement('div');
  cover.className = 'cover';
  cover.textContent = b.title || '未命名';
  const prog = Number(b.progress) || 0;
  if (prog > 0) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = Math.round(Math.max(0, Math.min(1, prog)) * 100) + '%';
    bar.appendChild(fill);
    cover.appendChild(bar);
  }
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = b.format || '?';

  const acts = document.createElement('div');
  acts.className = 'acts';
  const pv = document.createElement('button');
  pv.className = 'pv';
  pv.textContent = '预览';
  pv.title = '书签预览';
  pv.onclick = (e) => { e.stopPropagation(); openPreview(b); };
  const edit = document.createElement('button');
  edit.className = 'edit';
  edit.textContent = '✎';
  edit.title = '编辑信息';
  edit.onclick = (e) => { e.stopPropagation(); openBookEdit(b); };
  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '×';
  del.title = '删除';
  del.onclick = (e) => {
    e.stopPropagation();
    if (confirm('从书架删除「' + (b.title || '') + '」？文件也会被删除。')) {
      window.api.library.remove(b.id).then((l) => { state.books = l || []; renderShelf(); });
    }
  };
  acts.appendChild(pv); acts.appendChild(edit); acts.appendChild(del);

  const title = document.createElement('div');
  title.className = 'btitle';
  title.textContent = b.title || '未命名';
  const meta = document.createElement('div');
  meta.className = 'bmeta';
  meta.textContent = [b.author, b.collection].filter(Boolean).join(' · ') || (b.format || '').toUpperCase();

  wrap.appendChild(cover); wrap.appendChild(badge); wrap.appendChild(acts);
  wrap.appendChild(title); wrap.appendChild(meta);
  wrap.onclick = () => openBook(b);
  return wrap;
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + u[i];
}
function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ── Book preview (bookmarks / TOC / excerpt) ────────────

let previewBook = null;

function closePreview() {
  $('popup-preview').classList.add('hidden');
  previewBook = null;
}

function pvItem(label, isSub, onClick) {
  const d = document.createElement('div');
  d.className = 'pv-item' + (isSub ? ' lvl2' : '');
  d.textContent = label;
  d.title = label;
  if (onClick) d.onclick = onClick;
  else d.style.cursor = 'default';
  return d;
}

function openPreview(b) {
  previewBook = b;
  $('pv-title').textContent = b.title || '未命名';
  $('pv-meta').textContent = [b.author, b.collection, (b.format || '').toUpperCase(), fmtSize(b.size), fmtDate(b.added)].filter(Boolean).join(' · ');
  const list = $('pv-list');
  list.innerHTML = '';
  $('popup-preview').classList.remove('hidden');

  const mine = (b.bookmarks || []).slice();
  if (mine.length) {
    list.appendChild(pvItem('我的书签 (' + mine.length + ')', false, null));
    mine.forEach((bm) => {
      const row = document.createElement('div');
      row.className = 'pv-item lvl2 pv-bm';
      const span = document.createElement('span');
      span.className = 'pv-bm-t';
      span.textContent = (bm.label || '书签') + ' · ' + fmtDate(bm.at);
      span.title = span.textContent;
      row.appendChild(span);
      const del = document.createElement('span');
      del.className = 'pv-bm-x';
      del.textContent = '×';
      del.title = '删除书签';
      del.onclick = (e) => {
        e.stopPropagation();
        window.api.library.removeBookmark(b.id, bm.id).then((l) => {
          state.books = l || [];
          state.bookmarks = flattenBookmarks(state.books);
          const nb = state.books.find((x) => x.id === b.id);
          if (nb) openPreview(nb);
        });
      };
      row.appendChild(del);
      row.onclick = () => openBook(b, bm.loc || {});
      list.appendChild(row);
    });
  }

  const fmt = (b.format || '').toLowerCase();
  if (!READABLE.includes(fmt)) {
    if (!mine.length) list.appendChild(emptyHint('该格式无内置预览，可点击「开始阅读」用系统程序打开。'));
    else list.appendChild(pvItem('该格式无内置目录预览。', false, null));
    return;
  }
  if (!mine.length) list.appendChild(emptyHint('正在加载书签 / 目录…'));
  const mark = document.createElement('div');
  mark.className = 'pv-item pv-loading';
  mark.textContent = '正在加载目录…';
  list.appendChild(mark);
  window.api.library.url(b.id).then((url) => {
    if (!url || previewBook !== b) return;
    if (fmt === 'epub') previewEpub(url, list, mark);
    else if (fmt === 'pdf') previewPdf(url, list, mark);
    else previewTxt(url, list, mark);
  });
}

function clearMark(list, mark) {
  if (mark && mark.parentNode) mark.parentNode.removeChild(mark);
  const load = list.querySelector('.pv-loading');
  if (load) load.remove();
  const hint = list.querySelector('.link-empty');
  if (hint) hint.remove();
}

function previewEpub(url, list, mark) {
  let book;
  try { book = ePub(url); } catch (e) { clearMark(list, mark); list.appendChild(emptyHint('无法打开该 EPUB。')); return; }
  book.loaded.navigation.then((nav) => {
    if (!previewBook) return;
    clearMark(list, mark);
    const toc = (nav && nav.toc) || [];
    if (!toc.length) { list.appendChild(pvItem('无内置目录。', false, null)); return; }
    list.appendChild(pvItem('目录', false, null));
    const walk = (items, depth) => items.forEach((it) => {
      const href = it.href;
      list.appendChild(pvItem((it.label || '').trim(), depth > 0, () => openBook(previewBook, { href })));
      if (it.subitems && it.subitems.length) walk(it.subitems, depth + 1);
    });
    walk(toc, 0);
  }).catch(() => { clearMark(list, mark); list.appendChild(emptyHint('无法读取目录。')); })
    .then(() => { try { book.destroy(); } catch (e) { /* ignore */ } });
}

function flattenOutline(items, depth, out) {
  depth = depth || 0; out = out || [];
  items.forEach((it) => {
    out.push({ title: it.title || '', dest: it.dest, depth });
    if (it.items && it.items.length) flattenOutline(it.items, depth + 1, out);
  });
  return out;
}

function flattenToc(items, depth, out) {
  depth = depth || 0; out = out || [];
  (items || []).forEach((it) => {
    out.push({ label: (it.label || '').trim(), href: it.href, depth });
    if (it.subitems && it.subitems.length) flattenToc(it.subitems, depth + 1, out);
  });
  return out;
}

function previewPdf(url, list, mark) {
  if (!window.pdfjsLib) { clearMark(list, mark); list.appendChild(emptyHint('PDF 引擎未加载。')); return; }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'app://app/node_modules/pdfjs-dist/build/pdf.worker.min.js';
  window.pdfjsLib.getDocument(url).promise.then(async (pdf) => {
    if (!previewBook) { try { pdf.destroy(); } catch (e) {} return; }
    clearMark(list, mark);
    let outline = [];
    try { outline = (await pdf.getOutline()) || []; } catch (e) { outline = []; }
    if (!outline.length) {
      list.appendChild(pvItem('共 ' + pdf.numPages + ' 页（该 PDF 无书签）', false, null));
    } else {
      list.appendChild(pvItem('目录', false, null));
      const flat = flattenOutline(outline);
      for (const o of flat) {
        let page = 1;
        try {
          if (o.dest) {
            const dest = typeof o.dest === 'string' ? await pdf.getDestination(o.dest) : o.dest;
            if (dest && dest[0]) page = (await pdf.getPageIndex(dest[0])) + 1;
          }
        } catch (e) { /* keep page 1 */ }
        const pg = page;
        list.appendChild(pvItem(o.title + '  ·  第 ' + pg + ' 页', o.depth > 0, () => openBook(previewBook, { page: pg })));
      }
    }
    try { pdf.destroy(); } catch (e) { /* ignore */ }
  }).catch(() => { clearMark(list, mark); list.appendChild(emptyHint('无法打开该 PDF。')); });
}

function previewTxt(url, list, mark) {
  fetch(url).then((r) => r.arrayBuffer()).then((buf) => {
    if (!previewBook) return;
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.indexOf('\uFFFD') >= 0) { try { text = new TextDecoder('gbk').decode(buf); } catch (e) { /* keep */ } }
    clearMark(list, mark);
    list.appendChild(pvItem('正文预览', false, null));
    const pre = document.createElement('div');
    pre.className = 'pv-text';
    pre.textContent = text.slice(0, 1200) + (text.length > 1200 ? ' …' : '');
    list.appendChild(pre);
  }).catch(() => { clearMark(list, mark); list.appendChild(emptyHint('无法读取预览。')); });
}

let editingBook = null;
const NEW_FOLDER = '__new__';

let promptResolve = null;
function showPrompt(title, placeholder) {
  return new Promise((resolve) => {
    promptResolve = resolve;
    $('pr-title').textContent = title || '请输入';
    $('pr-input').value = '';
    $('pr-input').placeholder = placeholder || '';
    // Defer so the click that triggered this (e.g. selecting the dropdown
    // option) finishes bubbling before the modal becomes visible; otherwise
    // the document click handler would close it immediately.
    setTimeout(() => {
      $('popup-prompt').classList.remove('hidden');
      $('pr-input').focus();
    }, 0);
  });
}
function closePrompt(val) {
  $('popup-prompt').classList.add('hidden');
  if (promptResolve) { const r = promptResolve; promptResolve = null; r(val); }
}

function fillCollectionSelect(current) {
  const sel = $('bk-collection');
  sel.innerHTML = '';
  const opts = [''].concat(collections());
  if (current && !opts.includes(current)) opts.push(current);
  opts.forEach((c) => {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c === '' ? '（无分类）' : c;
    if (c === (current || '')) o.selected = true;
    sel.appendChild(o);
  });
  const nf = document.createElement('option');
  nf.value = NEW_FOLDER;
  nf.textContent = '＋ 新建分类…';
  sel.appendChild(nf);
}
async function onCollectionChange() {
  const sel = $('bk-collection');
  if (sel.value !== NEW_FOLDER) return;
  const prev = (editingBook && editingBook.collection) || '';
  const name = (await showPrompt('新建分类名称', '例如：技术 / 小说')).trim();
  if (!name) { sel.value = prev; return; }
  const folders = await window.api.folders.add(name);
  state.folders = folders || [];
  fillCollectionSelect(name);
  if (state.view === 'ebook') renderShelf();
}
function openBookEdit(b) {
  editingBook = b;
  $('bk-title').value = b.title || '';
  $('bk-author').value = b.author || '';
  fillCollectionSelect(b.collection || '');
  $('popup-book').classList.remove('hidden');
}

function openBook(b, start) {
  if (!ensureCanUse()) { closePreview(); return; }
  const fmt = (b.format || '').toLowerCase();
  if (!READABLE.includes(fmt)) {
    closePreview();
    if (confirm('「' + fmt.toUpperCase() + '」暂不支持内置阅读，用系统默认程序打开？')) {
      window.api.library.openExternal(b.id);
    }
    return;
  }
  // Already reading this book (returning from browser/home/shelf): restore the
  // preserved reader instantly instead of tearing it down and reloading.
  if (reader && currentBook && currentBook.id === b.id) {
    closePreview();
    setView('reader');
    if (start && reader.goTarget) reader.goTarget(start);
    return;
  }
  window.api.library.url(b.id).then((url) => {
    if (!url) return;
    closePreview();
    currentBook = b;
    state.anns = Array.isArray(b.anns) ? b.anns.slice() : [];
    window.api.library.update(b.id, { lastOpened: Date.now() }).then((l) => {
      state.books = l || [];
      currentBook = state.books.find((x) => x.id === b.id) || b;
      if (Array.isArray(currentBook.anns)) state.anns = currentBook.anns.slice();
      if (state.view === 'ebook') renderShelf();
    });
    setView('reader');
    logActivity('read', b.title || '', fmt.toUpperCase() + ' 电子书');
    $('reader-title').textContent = b.title || '';
    if (fmt === 'epub') openEpub(url, start);
    else if (fmt === 'pdf') openPdf(url, start && start.page);
    else openTxt(url, start);
  });
}

// ── Reader ──────────────────────────────────────────────

const READER_BG = {
  default: { bg: '#ffffff', fg: '#1a1a1a' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636' },
  green: { bg: '#cce8cf', fg: '#24331f' },
  dark: { bg: '#1b1c1f', fg: '#c9cbd1' },
};

let reader = null;
let progTimer = null;
let autoTimer = null;

function setPdfWorker() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'app://app/node_modules/pdfjs-dist/build/pdf.worker.min.js';
  }
}

function saveProgress(bookId, ratio) {
  if (!bookId) return;
  ratio = Math.max(0, Math.min(1, Number(ratio) || 0));
  clearTimeout(progTimer);
  progTimer = setTimeout(() => {
    const patch = { progress: ratio };
    if (reader && reader.loc) { try { patch.lastLocation = reader.loc(); } catch (e) { /* ignore */ } }
    window.api.library.update(bookId, patch).then((l) => {
      state.books = l || [];
      const nb = state.books.find((x) => x.id === bookId);
      if (nb) currentBook = nb;
    });
  }, 600);
}

function stopAutoTimer() { clearInterval(autoTimer); autoTimer = null; }

function setAuto(mode) {
  state.readerAuto = mode;
  stopAutoTimer();
  if (mode === 'off' || !reader) {
    $('reader-auto').classList.remove('on');
    syncReaderUI();
    return;
  }
  $('reader-auto').classList.add('on');
  const speed = state.readerSpeed;
  if (mode === 'scroll' && reader.scrollBy) {
    autoTimer = setInterval(() => { if (reader && reader.scrollBy) reader.scrollBy(speed); }, 60);
  } else {
    const interval = Math.max(700, 6500 - speed * 550);
    autoTimer = setInterval(() => { if (reader && reader.next) reader.next(); }, interval);
  }
  syncReaderUI();
}

function applyBg(key) {
  state.readerBg = READER_BG[key] ? key : 'default';
  const t = READER_BG[state.readerBg];
  $('reader-host').style.background = t.bg;
  if (reader && reader.setBg) reader.setBg(t);
  syncReaderUI();
}

function applyFlow(mode) {
  state.readerFlow = mode === 'scroll' ? 'scroll' : 'page';
  if (reader && reader.setFlow) reader.setFlow(state.readerFlow);
  if (state.readerAuto !== 'off') setAuto(state.readerAuto);
  syncReaderUI();
}

let typeTimer = null;
// Labels/sliders update instantly; the actual re-type (esp. PDF re-render) is
// debounced so dragging a slider stays smooth.
function applyReaderTypography() {
  syncReaderUI();
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => {
    if (reader && reader.applyType) { try { reader.applyType(); } catch (e) { /* ignore */ } }
  }, 80);
}

function changeReaderFont(delta) {
  state.readerFontPct = Math.max(60, Math.min(220, Math.round(state.readerFontPct + delta)));
  applyReaderTypography();
}

// Wheel page-turning. In paginated flow the wheel flips pages; in scroll flow we
// leave it alone so the content scrolls natively. Shared by the host-document
// readers (pdf/txt, attached on #reader-host) and the EPUB iframe (attached
// inside the iframe document via a content hook, since iframe wheels don't bubble).
let wheelLock = 0;
function handleReaderWheel(e) {
  if (state.view !== 'reader' || !reader) return;
  if (state.readerFlow !== 'page') return;
  const dy = e.deltaY;
  if (Math.abs(dy) < 4) return;
  e.preventDefault();
  const now = Date.now();
  if (now - wheelLock < 280) return;
  wheelLock = now;
  if (dy > 0) { if (reader.next) reader.next(); }
  else { if (reader.prev) reader.prev(); }
}

function doJump() {
  if (!reader || !reader.jump) return;
  const v = parseFloat($('reader-jump').value);
  if (isNaN(v)) return;
  reader.jump(v);
}

function closeReaderSettings() {
  $('popup-reader').classList.add('hidden');
  $('reader-settings').classList.remove('on');
}
function toggleReaderSettings() {
  const nowHidden = $('popup-reader').classList.toggle('hidden');
  $('reader-settings').classList.toggle('on', !nowHidden);
}

function syncReaderUI() {
  const bgBtns = document.querySelectorAll('#popup-reader .rd-bg');
  bgBtns.forEach((b) => b.classList.toggle('active', b.dataset.bg === state.readerBg));
  $('rd-flow-page').classList.toggle('active', state.readerFlow === 'page');
  $('rd-flow-scroll').classList.toggle('active', state.readerFlow === 'scroll');
  $('rd-auto-off').classList.toggle('active', state.readerAuto === 'off');
  $('rd-auto-page').classList.toggle('active', state.readerAuto === 'page');
  $('rd-auto-scroll').classList.toggle('active', state.readerAuto === 'scroll');
  $('rd-speed').value = state.readerSpeed;
  $('rd-face').value = state.readerFontFamily;
  $('rd-line').value = state.readerLineHeight;
  $('rd-line-val').textContent = (Number(state.readerLineHeight) || 0).toFixed(1);
  $('rd-para').value = state.readerParaSpacing;
  $('rd-para-val').textContent = (Number(state.readerParaSpacing) || 0).toFixed(1);
  $('reader-auto').classList.toggle('on', state.readerAuto !== 'off');
  const jump = $('reader-jump');
  if (reader) {
    jump.placeholder = reader.jumpUnit === 'page' ? '页码' : '％';
    jump.disabled = !reader.jump;
    $('reader-go').disabled = !reader.jump;
  }
  persistReaderPrefs();
}

// Reader settings survive restarts. Debounced because sliders fire on every tick.
let prefTimer = null;
function persistReaderPrefs() {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => {
    try {
      const prefs = readerPrefsObj();
      window.api.saveReaderPrefs(prefs);
      // Keep the logged-in account's profile in sync so settings follow the account.
      const acc = currentAccount();
      if (acc) { acc.reader = prefs; persistAccounts(); }
    } catch (e) { /* ignore */ }
  }, 300);
}

function destroyReader() {
  stopAutoTimer();
  closeReaderSettings();
  $('popup-rlist').classList.add('hidden');
  pendingSel = null;
  hideAnnBar(); hideAnnDel();
  if (!reader) return;
  try { reader.destroy && reader.destroy(); } catch (e) { /* ignore */ }
  reader = null;
  $('reader-host').innerHTML = '';
  $('reader-host').style.background = '';
  $('reader-pos').textContent = '';
}

function setPos(text) { $('reader-pos').textContent = text || ''; }

// Unified pager: every reader reports { page, total, hint } via pageInfo().
function updatePager() {
  if (!reader || !reader.pageInfo) { setPos(''); return; }
  const i = reader.pageInfo() || {};
  if (i.total > 0) {
    setPos('第 ' + (i.page || 1) + ' / ' + i.total + ' ' + (i.unit || '页'));
    $('reader-jump').max = i.total;
  } else {
    setPos(i.hint || '');
  }
}

// ── Reader annotations (highlight / underline) ──────────
// Quote-based: each annotation stores the exact selected text, so it can be
// re-found and re-wrapped whenever a chapter (EPUB) or the text (TXT) renders.
// PDF renders to canvas only and has no selectable text layer, so annotations
// are unavailable there.
let pendingSel = null;
let annsTimer = null;

function annCls(type) { return type === 'ul' ? 'ul' : 'hl'; }

// Default annotation appearance; the toolbar swatches/styles change these, and
// the 高亮 / 划线 buttons apply them so the user need not pick every time.
let annColor = '#ffd54f';
let annUlStyle = 'solid';

function hexToRgba(hex, a) {
  const h = String(hex || '#ffd54f').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

// Inline styles so colors/line-styles survive inside EPUB iframes too.
function applyAnnStyle(span, ann) {
  if (ann.type === 'ul') {
    span.style.textDecoration = 'underline';
    span.style.textDecorationStyle = ann.style || 'solid';
    span.style.textDecorationColor = ann.color || '#5b9dff';
    span.style.textUnderlineOffset = '2px';
  } else {
    span.style.background = hexToRgba(ann.color || '#ffd54f', 0.45);
    span.style.borderRadius = '2px';
  }
}

function annsSave() {
  if (!currentBook) return;
  const id = currentBook.id;
  const anns = (state.anns || []).slice();
  clearTimeout(annsTimer);
  annsTimer = setTimeout(() => {
    window.api.library.update(id, { anns }).then((l) => {
      state.books = l || [];
      const nb = state.books.find((x) => x.id === id);
      if (nb) currentBook = nb;
    });
  }, 400);
}

function wrapTextNode(node, s, e, ann) {
  const doc = node.ownerDocument;
  let target = node;
  if (e < target.nodeValue.length) target.splitText(e);
  if (s > 0) target = target.splitText(s);
  const span = doc.createElement('span');
  span.className = 'ann-mark ' + annCls(ann.type);
  span.setAttribute('data-ann-id', ann.id);
  applyAnnStyle(span, ann);
  target.parentNode.replaceChild(span, target);
  span.appendChild(target);
  return span;
}

// Wrap every text node covered by a live Range (instant feedback on selection).
function wrapRangeNodes(range, ann) {
  const doc = range.startContainer.ownerDocument || document;
  let root = range.commonAncestorContainer;
  if (root.nodeType !== 1) root = root.parentNode;
  if (!root) return;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) { if (range.intersectsNode(n)) nodes.push(n); }
  for (const node of nodes) {
    let s = 0, e = node.nodeValue.length;
    if (node === range.startContainer) s = range.startOffset;
    if (node === range.endContainer) e = range.endOffset;
    if (e > s) { try { wrapTextNode(node, s, e, ann); } catch (err) { /* ignore */ } }
  }
}

// Find the first exact occurrence of quote under root and wrap it.
function wrapQuote(root, quote, ann) {
  if (!root || !quote) return false;
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentNode;
      if (p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE')) return NodeFilter.FILTER_REJECT;
      if (p && p.classList && p.classList.contains('ann-mark')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const map = [];
  let full = '', n;
  while ((n = walker.nextNode())) { map.push({ node: n, start: full.length }); full += n.nodeValue; }
  const idx = full.indexOf(quote);
  if (idx < 0) return false;
  const end = idx + quote.length;
  for (const m of map) {
    const len = m.node.nodeValue.length;
    const nStart = m.start, nEnd = m.start + len;
    if (nEnd <= idx || nStart >= end) continue;
    const s = Math.max(idx, nStart) - nStart;
    const e = Math.min(end, nEnd) - nStart;
    if (e > s) { try { wrapTextNode(m.node, s, e, ann); } catch (err) { /* ignore */ } }
  }
  return true;
}

function applyAnnsIn(root) {
  if (!root || !state.anns || !state.anns.length) return;
  for (const ann of state.anns) {
    if (!ann || !ann.quote || !ann.id) continue;
    try {
      if (root.querySelector('[data-ann-id="' + ann.id + '"]')) continue;
    } catch (e) { /* ignore */ }
    wrapQuote(root, ann.quote, ann);
  }
}

function unwrapAnn(id) {
  const roots = (reader && reader.annRoots) ? reader.annRoots() : [];
  for (const root of roots) {
    if (!root || !root.querySelectorAll) continue;
    const marks = root.querySelectorAll('[data-ann-id="' + id + '"]');
    marks.forEach((m) => {
      const p = m.parentNode;
      if (!p) return;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      try { p.normalize(); } catch (e) { /* ignore */ }
    });
  }
}

function createAnn(type, color, style) {
  if (!currentBook || !pendingSel || !pendingSel.text) { hideAnnBar(); return; }
  const quote = pendingSel.text;
  const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ann = { id, type, quote };
  if (color) ann.color = color;
  if (type === 'ul') ann.style = style || 'solid';
  state.anns = state.anns || [];
  state.anns.push(ann);
  annsSave();
  try { wrapRangeNodes(pendingSel.range, ann); } catch (e) { /* ignore */ }
  try { pendingSel.doc.defaultView.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
  pendingSel = null;
  hideAnnBar();
  addAnnBookmark(quote);
}

// Every annotation also drops a bookmark at the current location, using the
// quoted text as the excerpt so it is findable in the bookmark list.
function addAnnBookmark(quote) {
  if (!reader || !currentBook) return;
  const loc = (reader.loc && reader.loc()) || {};
  const info = (reader.pageInfo && reader.pageInfo()) || {};
  let progress = 0;
  try { progress = (reader.progress && reader.progress()) || 0; } catch (e) { progress = 0; }
  const payload = {
    label: '标注 · ' + quote.slice(0, 12),
    loc, progress,
    page: info.page || 0,
    total: info.total || 0,
    excerpt: quote.slice(0, 140),
  };
  window.api.library.addBookmark(currentBook.id, payload).then((l) => {
    state.books = l || [];
    state.bookmarks = flattenBookmarks(state.books);
    const nb = state.books.find((x) => x.id === currentBook.id);
    if (nb) currentBook = nb;
    updateStatus();
    if (rlistMode === 'bm' && !$('popup-rlist').classList.contains('hidden')) renderReaderBookmarks();
  }).catch(() => { /* ignore */ });
}

function removeAnn(id) {
  state.anns = (state.anns || []).filter((a) => a.id !== id);
  annsSave();
  unwrapAnn(id);
  hideAnnDel();
}

function copySel() {
  const text = pendingSel ? pendingSel.text : '';
  hideAnnBar();
  if (!text) return;
  const done = () => { const p = $('reader-pos'); const old = p.textContent; p.textContent = '已复制 ✓'; setTimeout(() => { if (p.textContent === '已复制 ✓') p.textContent = old; }, 1000); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
  pendingSel = null;
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    done();
  } catch (e) { /* ignore */ }
}

function showAnnBar(cx, topY) {
  const bar = $('ann-bar');
  if (!bar) return;
  bar.classList.remove('hidden');
  const w = bar.offsetWidth, h = bar.offsetHeight;
  let x = Math.max(8, Math.min(window.innerWidth - w - 8, cx - w / 2));
  let y = topY - h - 8;
  if (y < 8) y = topY + 26;
  bar.style.left = x + 'px'; bar.style.top = y + 'px';
}
function hideAnnBar() { const b = $('ann-bar'); if (b) b.classList.add('hidden'); }
function showAnnDel(cx, topY) {
  const bar = $('ann-del');
  if (!bar) return;
  hideAnnBar();
  bar.classList.remove('hidden');
  const w = bar.offsetWidth, h = bar.offsetHeight;
  let x = Math.max(8, Math.min(window.innerWidth - w - 8, cx - w / 2));
  let y = topY - h - 8;
  if (y < 8) y = topY + 26;
  bar.style.left = x + 'px'; bar.style.top = y + 'px';
}
function hideAnnDel() { const b = $('ann-del'); if (b) b.classList.add('hidden'); }

// Selection ended inside reader content (host doc for TXT, iframe doc for EPUB).
function onReaderMouseUp(ev) {
  if (state.view !== 'reader' || !reader) return;
  if (reader.type !== 'epub' && reader.type !== 'txt') return;
  const doc = (ev.target && ev.target.ownerDocument) || document;
  const win = doc.defaultView || window;
  setTimeout(() => {
    let sel = null;
    try { sel = win.getSelection(); } catch (e) { return; }
    const text = sel ? String(sel).replace(/\s+/g, ' ').trim() : '';
    if (!text || !sel.rangeCount) { hideAnnBar(); return; }
    const range = sel.getRangeAt(0);
    const rr = range.getBoundingClientRect();
    const fe = win.frameElement ? win.frameElement.getBoundingClientRect() : { left: 0, top: 0 };
    pendingSel = { text, doc, range };
    showAnnBar(rr.left + fe.left + rr.width / 2, rr.top + fe.top);
  }, 0);
}

function onReaderContentClick(ev) {
  if (state.view !== 'reader' || !reader) return;
  const t = ev.target;
  const mark = t && t.closest ? t.closest('.ann-mark') : null;
  if (!mark) { hideAnnDel(); hideAnnBar(); return; }
  ev.preventDefault(); ev.stopPropagation();
  const id = mark.getAttribute('data-ann-id');
  if (!id) return;
  const r = mark.getBoundingClientRect();
  const win = mark.ownerDocument.defaultView;
  const fe = win && win.frameElement ? win.frameElement.getBoundingClientRect() : { left: 0, top: 0 };
  $('ann-del').dataset.annId = id;
  showAnnDel(r.left + fe.left + r.width / 2, r.bottom + fe.top + 4);
}

async function openEpub(url, startLoc) {
  destroyReader();
  const bookId = currentBook && currentBook.id;
  const host = document.createElement('div');
  host.className = 'epub-host';
  $('reader-host').appendChild(host);

  let book;
  try {
    // epubjs loads a string URL via XHR, which fails over the custom app:// scheme.
    // fetch() works there (pdf.js relies on it), so load the bytes and pass an
    // ArrayBuffer — epubjs then takes its BINARY path and never touches XHR.
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    book = ePub(await res.arrayBuffer());
  } catch (err) {
    console.error('[epub] open failed:', err);
    host.textContent = '无法打开该 EPUB。';
    return;
  }

  const last = (currentBook && currentBook.lastLocation) || {};
  const initial = (startLoc && (startLoc.cfi || startLoc.href)) || last.cfi || last.href || undefined;

  const rendition = book.renderTo(host, { width: '100%', height: '100%', spread: 'none' });
  // Wheel events inside the EPUB iframe don't bubble to the host document, so
  // bind the page-turn handler on each rendered section's own document.
  try {
    rendition.hooks.content.register((contents) => {
      try {
        if (contents && contents.document) {
          contents.document.addEventListener('wheel', handleReaderWheel, { passive: false });
          contents.document.addEventListener('mouseup', onReaderMouseUp);
          contents.document.addEventListener('click', onReaderContentClick);
        }
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
  const shown = initial ? rendition.display(initial) : rendition.display();
  if (shown && shown.then) {
    // The injected font-family CSS only lands once the section iframe exists,
    // so re-apply after each render (a font-size change later did this by hand).
    shown.then(() => { applyTheme(); applyAnnsEpub(); }).catch(() => { /* ignore */ });
  }
  rendition.on('rendered', () => { applyTheme(); applyAnnsEpub(); });

  function epubViews() {
    try {
      if (typeof rendition.getContents === 'function') {
        const c = rendition.getContents();
        return Array.isArray(c) ? c : (c ? [c] : []);
      }
    } catch (e) { /* ignore */ }
    return [];
  }
  function applyAnnsEpub() {
    for (const v of epubViews()) {
      const d = v && v.document;
      if (d && d.body) applyAnnsIn(d.body);
    }
  }

  let curHref = (startLoc && startLoc.href) || null;
  let curCfi = (startLoc && startLoc.cfi) || null;
  let curLabel = '';
  let curPage = (startLoc && startLoc.page) || 0;
  let locTotal = 0;
  let locDone = false;
  let chapIdx = 0;
  let chapCount = 0;
  let locationsReady = null;
  let lastChars = 0;
  let regenTimer = null;
  let regenBusy = false;

  function bg() { return READER_BG[state.readerBg]; }
  function applyTheme() {
    const t = bg();
    const lh = Number(state.readerLineHeight) || 1.8;
    const ps = Number(state.readerParaSpacing) || 0;
    const ff = state.readerFontFamily;
    // registerCss replaces the injected stylesheet (innerHTML), so it is safe
    // to call on every live slider tick; register(object) would accumulate.
    const css =
      'body{background:' + t.bg + '!important;color:' + t.fg + '!important;line-height:' + lh + '!important}' +
      (ff ? 'body{font-family:' + ff + '!important}body *{font-family:inherit!important}' : '') +
      'a{color:' + t.fg + '!important}' +
      'p{margin-top:0!important;margin-bottom:' + ps + 'em!important}';
    try {
      rendition.themes.registerCss('reader', css);
      rendition.themes.select('reader');
      rendition.themes.fontSize(state.readerFontPct + '%');
    } catch (e) { /* ignore */ }
    $('reader-host').style.background = t.bg;
  }
  function applyFlowMode() {
    try { rendition.flow(state.readerFlow === 'scroll' ? 'scrolled' : 'paginated'); } catch (e) { /* ignore */ }
  }
  function spineReady() {
    if (book.loaded && book.loaded.spine) return book.loaded.spine;
    return book.ready || Promise.resolve();
  }
  // EPUB has no fixed page count, so a "page" is one char-based location. Fewer
  // chars per location => more pages, which lets the count track font size and
  // line spacing (bigger text = fewer chars per screen = more pages).
  function charsPerLocation() {
    const f = Math.max(60, Math.min(220, state.readerFontPct)) / 100;
    const lh = Math.max(1.2, Math.min(2.6, Number(state.readerLineHeight) || 1.8)) / 1.8;
    return Math.max(150, Math.round(1000 / (f * lh)));
  }
  function runLocations(chars) {
    lastChars = chars;
    chapCount = (book.spine && book.spine.length) || 0;
    try { book.locations.pause = 1; } catch (e) { /* default 100ms/section is too slow */ }
    // generate() appends to _locations without clearing, so reset before re-running.
    try { book.locations._locations = []; book.locations.total = 0; } catch (e) { /* ignore */ }
    return book.locations.generate(chars).then(() => {
      locTotal = (book.locations.length && book.locations.length()) || 0;
      locDone = true;
      if (curCfi && locTotal) { try { curPage = book.locations.locationFromCfi(curCfi) + 1; } catch (e) { /* ignore */ } }
      updatePager();
      return locTotal > 0;
    });
  }
  function ensureLocations() {
    if (!locationsReady) {
      // generate() walks the spine, so it MUST wait until the spine is loaded;
      // called too early it processes zero sections and length() stays 0.
      locationsReady = Promise.resolve(spineReady())
        .then(() => runLocations(charsPerLocation()))
        .catch(() => { locDone = true; updatePager(); return false; });
    }
    return locationsReady;
  }
  function scheduleRegen() {
    clearTimeout(regenTimer);
    // Re-walking the spine is heavy, so debounce well past the slider tick and
    // skip it entirely when the char size (i.e. the page count) is unchanged.
    // The busy guard keeps two generate() runs from interleaving on one queue.
    regenTimer = setTimeout(() => {
      if (!book || !book.locations) return;
      const chars = charsPerLocation();
      if (chars === lastChars) return;
      if (regenBusy) { scheduleRegen(); return; }
      regenBusy = true;
      Promise.resolve(spineReady())
        .then(() => runLocations(chars))
        .catch(() => { locDone = true; updatePager(); })
        .then(() => { regenBusy = false; });
    }, 400);
  }
  function scrollEl() { return host.querySelector('.epub-container') || host.firstElementChild; }
  function visibleText() {
    try {
      let views = [];
      if (typeof rendition.getContents === 'function') {
        const c = rendition.getContents();
        views = Array.isArray(c) ? c : (c ? [c] : []);
      }
      if (!views.length && typeof rendition.currentView === 'function') {
        const v = rendition.currentView();
        if (v && v.contents) views = [v.contents];
      }
      let s = '';
      for (const v of views) {
        const d = v && v.document;
        if (d && d.body) s += (d.body.textContent || '') + ' ';
      }
      return s.replace(/\s+/g, ' ').trim().slice(0, 140);
    } catch (e) { return curLabel || ''; }
  }

  applyTheme();
  applyFlowMode();
  ensureLocations();

  rendition.on('relocated', (loc) => {
    if (loc && loc.start) {
      curHref = loc.start.href || curHref;
      curCfi = loc.start.cfi || curCfi;
      if (locTotal && curCfi) {
        try { curPage = book.locations.locationFromCfi(curCfi) + 1; } catch (e) { /* ignore */ }
      }
      const sp = book.spine && book.spine.get ? book.spine.get(curHref) : null;
      let idx = -1;
      if (book.spine && book.spine.length && sp) {
        idx = book.spine.items ? book.spine.items.indexOf(sp) : -1;
        if (idx >= 0) { chapIdx = idx; chapCount = book.spine.length; }
      }
      let prog = null;
      if (locTotal && curCfi) {
        try { const p = book.locations.percentageFromCfi(curCfi); if (!isNaN(p)) prog = p; } catch (e) { /* ignore */ }
      }
      if (prog == null && idx >= 0) prog = idx / (chapCount || 1);
      if (prog != null) saveProgress(bookId, prog);
    }
    try {
      const nav = book.navigation && book.navigation.get ? book.navigation.get(curHref) : null;
      curLabel = (nav && nav.label) ? nav.label.trim() : '';
    } catch (e) { curLabel = ''; }
    updatePager();
  });

  reader = {
    type: 'epub',
    jumpUnit: 'page',
    prev: () => { try { rendition.prev(); } catch (e) { /* not ready */ } },
    next: () => { try { rendition.next(); } catch (e) { /* not ready */ } },
    applyType: () => { applyTheme(); scheduleRegen(); },
    reflow: () => { try { rendition.resize(); } catch (e) { /* ignore */ } },
    setBg: () => applyTheme(),
    setFlow: () => applyFlowMode(),
    scrollBy: (px) => { const el = scrollEl(); if (el) el.scrollTop += px; },
    jump: (n) => {
      const num = Math.round(n);
      setPos('定位中…');
      ensureLocations().then((ok) => {
        if (ok && locTotal > 0) {
          const p = Math.max(1, Math.min(locTotal, num));
          try {
            const cfi = book.locations.cfiFromLocation(p - 1);
            if (cfi) { rendition.display(cfi); return; }
          } catch (e) { /* fall through to chapter jump */ }
        }
        if (chapCount > 0) {
          const ci = Math.max(0, Math.min(chapCount - 1, num - 1));
          const sec = book.spine && book.spine.items ? book.spine.items[ci] : null;
          if (sec && sec.href) { try { rendition.display(sec.href); } catch (e) { /* ignore */ } }
        }
        updatePager();
      });
    },
    pageInfo: () => {
      if (locTotal > 0) return { page: curPage || 1, total: locTotal, unit: '页' };
      if (locDone && chapCount > 0) return { page: chapIdx + 1, total: chapCount, unit: '章' };
      if (locDone) return { page: 0, total: 0, hint: '' };
      return { page: 0, total: 0, hint: '正在计算页码…' };
    },
    progress: () => {
      try {
        if (locTotal && curCfi) { const p = book.locations.percentageFromCfi(curCfi); if (!isNaN(p)) return p; }
      } catch (e) { /* ignore */ }
      if (chapCount > 0) return chapIdx / chapCount;
      return (currentBook && currentBook.progress) || 0;
    },
    excerpt: () => visibleText(),
    annRoots: () => epubViews().map((v) => v && v.document && v.document.body).filter(Boolean),
    loc: () => ({ href: curHref, cfi: curCfi, page: curPage }),
    label: () => curLabel
      || (locTotal ? '第 ' + (curPage || 1) + ' 页'
        : (chapCount ? '第 ' + (chapIdx + 1) + ' 章'
          : (currentBook && currentBook.title) || '书签')),
    toc: () => book.loaded.navigation.then((nav) => flattenToc((nav && nav.toc) || [])),
    goTarget: (t) => {
      if (!t) return;
      const target = t.cfi || t.href;
      if (target) { try { rendition.display(target); } catch (e) { /* ignore */ } }
    },
    destroy: () => { try { book.destroy(); } catch (e) { /* ignore */ } },
  };
  $('reader-pager').style.display = 'flex';
  applyBg(state.readerBg);
  syncReaderUI();
}

function openPdf(url, startPage) {
  destroyReader();
  const bookId = currentBook && currentBook.id;
  setPdfWorker();
  const wrap = document.createElement('div');
  wrap.className = 'pdf-wrap';
  $('reader-host').appendChild(wrap);

  let pdf = null, page = 1, scale = state.readerFontPct / 100, total = 0;
  let singleCanvas = null, singleCtx = null;
  let contDiv = null, contIO = null, pageEls = [];

  function fitScale(base) {
    const hostW = Math.max(1, $('reader-host').clientWidth - 24);
    const hostH = Math.max(1, $('reader-host').clientHeight - 24);
    // Scroll mode fits width and scrolls vertically; page mode fits the whole
    // page inside the view (contain) so it adapts to the display area.
    if (state.readerFlow === 'scroll') return (hostW / base.width) * scale;
    return Math.min(hostW / base.width, hostH / base.height) * scale;
  }

  function drawSingle() {
    if (!pdf) return;
    pdf.getPage(page).then((pg) => {
      const base = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: fitScale(base) });
      singleCanvas.width = vp.width; singleCanvas.height = vp.height;
      singleCanvas.style.width = vp.width + 'px'; singleCanvas.style.height = vp.height + 'px';
      pg.render({ canvasContext: singleCtx, viewport: vp }).promise.then(() => {
        updatePager();
        if (total) saveProgress(bookId, page / total);
      });
    });
  }

  function buildSingle() {
    if (contIO) { contIO.disconnect(); contIO = null; }
    wrap.removeEventListener('scroll', onContScroll);
    wrap.innerHTML = '';
    wrap.style.display = 'flex';
    singleCanvas = document.createElement('canvas');
    singleCanvas.style.margin = 'auto';
    wrap.appendChild(singleCanvas);
    singleCtx = singleCanvas.getContext('2d');
    drawSingle();
  }

  function renderPageInto(n, canvas) {
    pdf.getPage(n).then((pg) => {
      const base = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: fitScale(base) });
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
      pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    });
  }

  function onContScroll() {
    if (!pageEls.length) return;
    const top = wrap.scrollTop + 40;
    let cur = 1;
    for (let i = 0; i < pageEls.length; i++) {
      if (pageEls[i].offsetTop <= top) cur = i + 1; else break;
    }
    if (cur !== page) { page = cur; }
    updatePager();
    if (total) saveProgress(bookId, page / total);
  }

  function buildContinuous(targetPage) {
    if (contIO) { contIO.disconnect(); contIO = null; }
    wrap.style.display = 'block';
    wrap.innerHTML = '';
    contDiv = document.createElement('div');
    contDiv.className = 'pdf-scroll';
    wrap.appendChild(contDiv);
    pageEls = [];
    const job = async () => {
      for (let i = 1; i <= total; i++) {
        const pg = await pdf.getPage(i);
        const base = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: fitScale(base) });
        const c = document.createElement('canvas');
        c.className = 'pdf-page';
        c.dataset.page = i;
        c.style.width = vp.width + 'px';
        c.style.height = vp.height + 'px';
        contDiv.appendChild(c);
        pageEls.push(c);
      }
      contIO = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) { renderPageInto(+en.target.dataset.page, en.target); contIO.unobserve(en.target); }
        });
      }, { root: wrap, rootMargin: '800px 0px' });
      pageEls.forEach((c) => contIO.observe(c));
      wrap.addEventListener('scroll', onContScroll);
      if (targetPage > 1 && pageEls[targetPage - 1]) pageEls[targetPage - 1].scrollIntoView();
      updatePager();
    };
    job();
  }

  function applyFlowMode() {
    if (!pdf) return;
    if (state.readerFlow === 'scroll') buildContinuous(page);
    else buildSingle();
  }

  window.pdfjsLib.getDocument(url).promise.then((doc) => {
    pdf = doc; total = doc.numPages;
    let p = startPage;
    if (!p && currentBook && currentBook.lastLocation && currentBook.lastLocation.page) p = currentBook.lastLocation.page;
    page = (p && p >= 1 && p <= total) ? Math.round(p) : 1;
    $('reader-jump').max = total;
    applyFlowMode();
    updatePager();
  }).catch(() => { wrap.textContent = '无法打开该 PDF。'; });

  reader = {
    type: 'pdf',
    jumpUnit: 'page',
    prev: () => { if (pdf && page > 1) { page--; if (state.readerFlow === 'scroll') { pageEls[page - 1] && pageEls[page - 1].scrollIntoView(); onContScroll(); } else drawSingle(); } },
    next: () => { if (pdf && page < total) { page++; if (state.readerFlow === 'scroll') { pageEls[page - 1] && pageEls[page - 1].scrollIntoView(); onContScroll(); } else drawSingle(); } },
    applyType: () => { scale = Math.max(0.4, Math.min(4, state.readerFontPct / 100)); applyFlowMode(); },
    reflow: () => applyFlowMode(),
    setBg: (t) => { wrap.style.background = t.bg; },
    setFlow: () => applyFlowMode(),
    scrollBy: (px) => { wrap.scrollTop += px; },
    jump: (n) => {
      if (!pdf) return;
      const p = Math.max(1, Math.min(total, Math.round(n)));
      page = p;
      if (state.readerFlow === 'scroll') { pageEls[p - 1] && pageEls[p - 1].scrollIntoView(); onContScroll(); }
      else drawSingle();
    },
    loc: () => ({ page }),
    label: () => '第 ' + page + ' 页',
    pageInfo: () => ({ page, total }),
    progress: () => (total ? page / total : 0),
    excerpt: async () => {
      try {
        const pg = await pdf.getPage(page);
        const tc = await pg.getTextContent();
        return tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      } catch (e) { return ''; }
    },
    toc: async () => {
      if (!pdf) return [];
      let outline = [];
      try { outline = (await pdf.getOutline()) || []; } catch (e) { outline = []; }
      const flat = flattenOutline(outline);
      const out = [];
      for (const o of flat) {
        let pg = 1;
        try {
          if (o.dest) {
            const dest = typeof o.dest === 'string' ? await pdf.getDestination(o.dest) : o.dest;
            if (dest && dest[0]) pg = (await pdf.getPageIndex(dest[0])) + 1;
          }
        } catch (e) { /* keep page 1 */ }
        out.push({ label: (o.title || '(无标题)') + ' · 第 ' + pg + ' 页', depth: o.depth, page: pg });
      }
      return out;
    },
    goTarget: (t) => { if (t && t.page && reader) reader.jump(t.page); },
    destroy: () => { if (contIO) contIO.disconnect(); wrap.removeEventListener('scroll', onContScroll); try { pdf && pdf.destroy(); } catch (e) { /* ignore */ } },
  };
  $('reader-pager').style.display = 'flex';
  applyBg(state.readerBg);
  syncReaderUI();
}

function openTxt(url, startLoc) {
  destroyReader();
  const bookId = currentBook && currentBook.id;
  const pre = document.createElement('div');
  pre.className = 'txt';
  pre.style.fontSize = Math.round(16 * state.readerFontPct / 100) + 'px';
  pre.style.lineHeight = String(Number(state.readerLineHeight) || 1.8);
  pre.style.fontFamily = state.readerFontFamily || '';
  $('reader-host').appendChild(pre);
  pre.textContent = '加载中…';
  const last = (currentBook && currentBook.lastLocation) || {};
  let ratio = Number(startLoc && startLoc.ratio);
  if (!ratio && last.ratio) ratio = Number(last.ratio) || 0;

  fetch(url).then((r) => r.arrayBuffer()).then((buf) => {
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.indexOf('\uFFFD') >= 0) {
      try { text = new TextDecoder('gbk').decode(buf); } catch (e) { /* keep utf-8 */ }
    }
    pre.textContent = text;
    applyAnnsIn(pre);
    requestAnimationFrame(() => {
      if (ratio > 0) {
        const max = pre.scrollHeight - pre.clientHeight;
        if (max > 0) pre.scrollTop = max * Math.max(0, Math.min(1, ratio));
      }
      updatePager();
    });
  }).catch(() => { pre.textContent = '无法读取该文本文件。'; });

  const pctNow = () => { const max = pre.scrollHeight - pre.clientHeight; return max > 0 ? pre.scrollTop / max : 0; };
  // A "page" is one screenful; the count is live and depends on viewport + font.
  const pageInfo = () => {
    const ch = pre.clientHeight || 0;
    if (ch <= 0) return { page: 1, total: 0 };
    const total = Math.max(1, Math.ceil(pre.scrollHeight / ch));
    const page = Math.min(total, Math.floor(pre.scrollTop / ch) + 1);
    return { page, total };
  };
  const track = () => {
    const max = pre.scrollHeight - pre.clientHeight;
    if (max > 0) saveProgress(bookId, pre.scrollTop / max);
    updatePager();
  };
  pre.addEventListener('scroll', track);
  pre.addEventListener('mouseup', onReaderMouseUp);
  pre.addEventListener('click', onReaderContentClick);

  reader = {
    type: 'txt',
    jumpUnit: 'page',
    prev: () => { pre.scrollTop -= pre.clientHeight * 0.95; },
    next: () => { pre.scrollTop += pre.clientHeight * 0.95; },
    applyType: () => {
      pre.style.fontSize = Math.round(16 * state.readerFontPct / 100) + 'px';
      pre.style.lineHeight = String(Number(state.readerLineHeight) || 1.8);
      pre.style.fontFamily = state.readerFontFamily || '';
      requestAnimationFrame(updatePager);
    },
    reflow: () => updatePager(),
    setBg: (t) => { pre.style.background = t.bg; pre.style.color = t.fg; },
    setFlow: () => { /* txt is always scroll */ },
    scrollBy: (px) => { pre.scrollTop += px; },
    jump: (n) => {
      const ch = pre.clientHeight;
      if (!ch) return;
      const info = pageInfo();
      const p = Math.max(1, Math.min(info.total, Math.round(n)));
      pre.scrollTop = (p - 1) * ch;
      updatePager();
    },
    pageInfo,
    progress: () => pctNow(),
    excerpt: () => {
      try {
        const t = pre.textContent || '';
        const i = Math.max(0, Math.floor(pctNow() * t.length));
        return t.slice(i, i + 140).replace(/\s+/g, ' ').trim();
      } catch (e) { return ''; }
    },
    loc: () => ({ ratio: pctNow(), page: pageInfo().page }),
    label: () => '第 ' + pageInfo().page + ' 页',
    toc: () => Promise.resolve([]),
    annRoots: () => [pre],
    goTarget: (t) => {
      if (!t) return;
      if (typeof t.ratio === 'number') {
        const max = pre.scrollHeight - pre.clientHeight;
        if (max > 0) pre.scrollTop = max * Math.max(0, Math.min(1, t.ratio));
      } else if (typeof t.page === 'number' && t.page > 0) {
        reader.jump(t.page);
        return;
      }
      updatePager();
    },
    destroy: () => { pre.removeEventListener('scroll', track); },
  };
  $('reader-pager').style.display = 'flex';
  applyBg(state.readerBg);
  syncReaderUI();
}

function addReaderBookmark() {
  if (!reader || !currentBook) return;
  const label = (reader.label && reader.label()) || '书签';
  const loc = (reader.loc && reader.loc()) || {};
  const info = (reader.pageInfo && reader.pageInfo()) || {};
  let progress = 0;
  try { progress = (reader.progress && reader.progress()) || 0; } catch (e) { progress = 0; }
  const payload = {
    label, loc, progress,
    page: info.page || 0,
    total: info.total || 0,
  };
  const commit = (excerpt) => {
    payload.excerpt = excerpt || '';
    window.api.library.addBookmark(currentBook.id, payload).then((l) => {
      state.books = l || [];
      state.bookmarks = flattenBookmarks(state.books);
      const nb = state.books.find((x) => x.id === currentBook.id);
      if (nb) currentBook = nb;
      updateStatus();
      if (rlistMode === 'bm' && !$('popup-rlist').classList.contains('hidden')) renderReaderBookmarks();
      const pos = $('reader-pos');
      const old = pos.textContent;
      pos.textContent = '已添加书签 ✓';
      setTimeout(() => { if (pos.textContent === '已添加书签 ✓') pos.textContent = old; }, 1200);
    });
  };
  if (reader.excerpt) {
    const ex = reader.excerpt();
    if (ex && ex.then) ex.then(commit).catch(() => commit(''));
    else commit(ex);
  } else {
    commit('');
  }
}

let rlistMode = 'toc';

function openReaderToc() {
  rlistMode = 'toc';
  $('rl-title').textContent = '目录';
  $('rl-foot').classList.add('hidden');
  const list = $('rl-list');
  list.innerHTML = '';
  $('popup-rlist').classList.remove('hidden');
  if (!reader || !reader.toc) { list.appendChild(emptyHint('无目录')); return; }
  list.appendChild(emptyHint('正在加载目录…'));
  Promise.resolve(reader.toc()).then((items) => {
    if (rlistMode !== 'toc') return;
    list.innerHTML = '';
    if (!items || !items.length) { list.appendChild(emptyHint('本书无目录。')); return; }
    items.forEach((it) => {
      const d = document.createElement('div');
      d.className = 'pv-item' + (it.depth > 0 ? ' lvl2' : '');
      d.textContent = it.label || '(无标题)';
      d.title = d.textContent;
      d.onclick = () => { if (reader && reader.goTarget) reader.goTarget(it); $('popup-rlist').classList.add('hidden'); };
      list.appendChild(d);
    });
  }).catch(() => { list.innerHTML = ''; list.appendChild(emptyHint('无法读取目录。')); });
}

function openReaderBookmarks() {
  rlistMode = 'bm';
  $('rl-title').textContent = '书签';
  $('rl-foot').classList.remove('hidden');
  renderReaderBookmarks();
  $('popup-rlist').classList.remove('hidden');
}

function renderReaderBookmarks() {
  const list = $('rl-list');
  list.innerHTML = '';
  const bms = (currentBook && currentBook.bookmarks) || [];
  if (!bms.length) { list.appendChild(emptyHint('还没有书签，点击下方「添加当前页书签」。')); return; }
  bms.slice().reverse().forEach((bm) => {
    const row = document.createElement('div');
    row.className = 'pv-item lvl2 pv-bm';
    const main = document.createElement('div');
    main.className = 'pv-bm-main';
    const span = document.createElement('span');
    span.className = 'pv-bm-t';
    const where = bmWhere(bm);
    span.textContent = (bm.label || '书签') + (where ? ' · ' + where : '') + ' · ' + fmtDate(bm.at);
    span.title = span.textContent;
    main.appendChild(span);
    if (bm.excerpt) {
      const ex = document.createElement('div');
      ex.className = 'pv-bm-ex';
      ex.textContent = bm.excerpt;
      ex.title = bm.excerpt;
      main.appendChild(ex);
    }
    row.appendChild(main);
    const del = document.createElement('span');
    del.className = 'pv-bm-x';
    del.textContent = '×';
    del.title = '删除书签';
    del.onclick = (e) => {
      e.stopPropagation();
      window.api.library.removeBookmark(currentBook.id, bm.id).then((l) => {
        state.books = l || [];
        state.bookmarks = flattenBookmarks(state.books);
        const nb = state.books.find((x) => x.id === currentBook.id);
        if (nb) currentBook = nb;
        updateStatus();
        if (rlistMode === 'bm') renderReaderBookmarks();
      });
    };
    row.appendChild(del);
    row.onclick = () => { if (reader && reader.goTarget) reader.goTarget(bm.loc || {}); $('popup-rlist').classList.add('hidden'); };
    list.appendChild(row);
  });
}

// ── Wiring ──────────────────────────────────────────────

function bindUi() {
  $('nav-back').onclick = () => { const w = activeWebview(); if (w && w.canGoBack()) w.goBack(); };
  $('nav-fwd').onclick = () => { const w = activeWebview(); if (w && w.canGoForward()) w.goForward(); };
  $('nav-reload').onclick = () => { const w = activeWebview(); if (w) w.reload(); };
  $('nav-fav').onclick = toggleFav;
  $('nav-go').onclick = go;
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  $('btn-home').onclick = () => toggleView('home');
  $('btn-ebook').onclick = () => {
    // With a book preserved, the 书架 button jumps straight back to reading;
    // pressing it while already reading opens the shelf to pick another book.
    if (reader) setView(state.view === 'reader' ? 'ebook' : 'reader');
    else toggleView('ebook');
  };
  $('home-back').onclick = () => setView('browser');
  $('reader-back').onclick = () => setView('ebook');

  $('tab-add').onclick = () => { if (!ensureCanUse()) return; setView('browser'); newTab(HOME_URL); };
  $('tab-overflow').onclick = (e) => { e.stopPropagation(); toggleTabMenu(); };

  $('home-toggle-hist').onclick = () => {
    state.showHist = !state.showHist;
    $('home-toggle-hist').classList.toggle('on', state.showHist);
    if (state.view === 'home') renderHome();
  };

  $('shelf-import').onclick = () => {
    if (!ensureCanUse()) return;
    window.api.library.import().then((l) => { state.books = l || []; state.bookmarks = flattenBookmarks(state.books); renderShelf(); });
  };
  $('shelf-manage').onclick = () => setManage(!state.manage);
  $('shelf-bookmarks').onclick = () => openBookmarksDialog();
  $('shelf-sort').onchange = (e) => { state.sort = e.target.value; renderShelf(); };
  $('shelf-search').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); renderShelf(); });

  $('pv-close').onclick = () => closePreview();
  $('pv-read').onclick = () => { if (previewBook) openBook(previewBook); };

  $('bm-dlg-close').onclick = () => $('popup-bmarks').classList.add('hidden');
  $('bm-dlg-search').addEventListener('input', () => renderBookmarksDialog());

  $('reader-prev').onclick = () => { if (reader && reader.prev) reader.prev(); };
  $('reader-next').onclick = () => { if (reader && reader.next) reader.next(); };
  // Wheel page-turn for the host-document readers (pdf/txt). The EPUB iframe
  // binds its own copy via a content hook since iframe wheels don't bubble here.
  $('reader-host').addEventListener('wheel', handleReaderWheel, { passive: false });
  $('reader-font-up').onclick = () => changeReaderFont(10);
  $('reader-font-down').onclick = () => changeReaderFont(-10);
  $('reader-toc').onclick = (e) => { e.stopPropagation(); closeReaderSettings(); openReaderToc(); };
  $('reader-bmarks').onclick = (e) => { e.stopPropagation(); closeReaderSettings(); openReaderBookmarks(); };
  $('rl-close').onclick = () => $('popup-rlist').classList.add('hidden');
  $('rl-add').onclick = () => addReaderBookmark();
  $('reader-go').onclick = doJump;
  $('reader-jump').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doJump(); }
  });
  $('reader-auto').onclick = () => {
    if (state.readerAuto === 'off') setAuto(state.readerFlow === 'scroll' ? 'scroll' : 'page');
    else setAuto('off');
  };
  $('reader-settings').onclick = (e) => {
    e.stopPropagation();
    toggleReaderSettings();
  };
  $('rd-close').onclick = () => closeReaderSettings();
  document.querySelectorAll('#popup-reader .rd-bg').forEach((b) => {
    b.onclick = () => applyBg(b.dataset.bg);
  });
  $('rd-flow-page').onclick = () => applyFlow('page');
  $('rd-flow-scroll').onclick = () => applyFlow('scroll');
  $('rd-auto-off').onclick = () => setAuto('off');
  $('rd-auto-page').onclick = () => setAuto('page');
  $('rd-auto-scroll').onclick = () => setAuto('scroll');
  $('rd-speed').oninput = (e) => {
    state.readerSpeed = Number(e.target.value);
    persistReaderPrefs();
    if (state.readerAuto !== 'off') setAuto(state.readerAuto);
  };
  $('rd-face').onchange = (e) => { state.readerFontFamily = e.target.value; applyReaderTypography(); };
  $('rd-line').oninput = (e) => { state.readerLineHeight = Number(e.target.value); applyReaderTypography(); };
  $('rd-para').oninput = (e) => { state.readerParaSpacing = Number(e.target.value); applyReaderTypography(); };

  $('bk-save').onclick = () => {
    if (!editingBook) return;
    let col = $('bk-collection').value.trim();
    if (col === NEW_FOLDER) col = '';
    const patch = {
      title: $('bk-title').value,
      author: $('bk-author').value,
      collection: col,
    };
    window.api.library.update(editingBook.id, patch).then((l) => {
      state.books = l || [];
      $('popup-book').classList.add('hidden');
      editingBook = null;
      renderShelf();
    });
  };
  $('bk-cancel').onclick = () => { $('popup-book').classList.add('hidden'); editingBook = null; };
  $('bk-collection').onchange = onCollectionChange;

  $('pr-ok').onclick = () => closePrompt($('pr-input').value || '');
  $('pr-cancel').onclick = () => closePrompt(null);
  $('pr-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closePrompt($('pr-input').value || '');
    else if (e.key === 'Escape') closePrompt(null);
  });

  $('cb-hide').onchange = (e) => window.api.setAutoHide(e.target.checked);
  $('btn-top').onclick = () => {
    const on = !$('btn-top').classList.contains('active');
    $('btn-top').classList.toggle('active', on);
    window.api.setTopmost(on);
  };

  $('btn-opacity').onclick = (e) => {
    e.stopPropagation();
    $('popup-settings').classList.add('hidden');
    $('popup-zoom').classList.add('hidden');
    $('popup-opacity').classList.toggle('hidden');
  };
  $('op-range').oninput = (e) => {
    $('op-val').textContent = e.target.value + '%';
    window.api.setOpacity(Number(e.target.value) / 100);
    $('btn-opacity').classList.toggle('active', Number(e.target.value) < 100);
  };

  const applyZoom = (pct) => {
    pct = Math.max(50, Math.min(300, Math.round(pct)));
    $('zoom-range').value = pct;
    $('zoom-val').textContent = pct + '%';
    const wv = activeWebview();
    if (wv) wv.setZoomFactor(pct / 100);
    $('btn-zoom').classList.toggle('active', pct !== 100);
  };
  $('btn-zoom').onclick = (e) => {
    e.stopPropagation();
    $('popup-opacity').classList.add('hidden');
    $('popup-settings').classList.add('hidden');
    const wv = activeWebview();
    const cur = wv ? Math.round(wv.getZoomFactor() * 100) : 100;
    $('zoom-range').value = cur;
    $('zoom-val').textContent = cur + '%';
    $('popup-zoom').classList.toggle('hidden');
  };
  $('zoom-in').onclick = () => applyZoom(Number($('zoom-range').value) + 10);
  $('zoom-out').onclick = () => applyZoom(Number($('zoom-range').value) - 10);
  $('zoom-range').oninput = (e) => applyZoom(Number(e.target.value));
  $('zoom-reset').onclick = () => applyZoom(100);

  $('btn-settings').onclick = (e) => {
    e.stopPropagation();
    $('popup-opacity').classList.add('hidden');
    $('popup-zoom').classList.add('hidden');
    updateLoginUI();
    $('popup-settings').classList.toggle('hidden');
  };
  $('set-restart').onclick = () => {
    const url = $('url').value || state.settings.url;
    setView('browser');
    while (state.tabs.length) closeTabSilent(0);
    newTab(url);
    $('popup-settings').classList.add('hidden');
  };
  $('set-release').onclick = () => {
    window.api.toEngine({ cmd: 'release_all' });
    $('popup-settings').classList.add('hidden');
  };
  $('set-login').onclick = () => {
    if (isLoggedIn()) doLogout();
    else openLogin();
  };
  $('set-about').onclick = () => openAbout();
  $('set-help').onclick = () => openHelp();
  $('set-activate').onclick = () => openActivate();
  $('set-usage').onclick = () => openUsage();
  $('set-pass').onclick = () => openPass();
  $('ps-close').onclick = () => closePass();
  $('ps-submit').onclick = () => doChangePass();
  $('ps-new2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doChangePass(); });

  // Notes dialog (stays open until the icon or close button is pressed)
  $('btn-notes').onclick = (e) => {
    e.stopPropagation();
    if ($('popup-notes').classList.contains('hidden')) openNotes();
    else closeNotes();
  };
  $('nt-x').onclick = () => closeNotes();
  $('nt-tab').onclick = () => { closeNotes(); openNotesView(); };
  $('nt-save').onclick = () => {
    const text = $('nt-input').value.trim();
    if (!text) return;
    const c = noteContext();
    window.api.notes.add({ text, ctx: c.ctx, kind: c.kind }).then(() => {
      $('nt-input').value = '';
      refreshNotes();
      if (state.view === 'notes') openNotesView();
    });
  };
  $('nv-add').onclick = () => {
    nvFlush();
    const c = noteContext();
    (state.nvNotes = state.nvNotes || []).unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text: '', ctx: c.ctx, kind: c.kind, account: state.user ? state.user.account : '', at: Date.now(),
    });
    renderNotesView();
    const first = $('nv-list').querySelector('textarea');
    if (first) first.focus();
  };
  $('nv-save').onclick = () => {
    nvFlush();
    const b = $('nv-save');
    b.textContent = '已保存';
    setTimeout(() => { b.textContent = '保存全部'; }, 1200);
  };
  $('nv-back').onclick = () => { nvFlush(); setView(state.nvReturn || 'browser'); };

  // The notes dialog drags by its header; it may go anywhere as long as it
  // still overlaps the app window (a 40px strip on each axis is kept).
  {
    const box = $('popup-notes');
    const head = box.querySelector('.nt-head');
    head.style.cursor = 'move';
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = box.getBoundingClientRect();
      box.style.right = 'auto';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      dragging = true;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = box.offsetWidth, h = box.offsetHeight, M = 40;
      const nx = Math.min(Math.max(ox + e.clientX - sx, M - w), window.innerWidth - M);
      const ny = Math.min(Math.max(oy + e.clientY - sy, M - h), window.innerHeight - M);
      box.style.left = nx + 'px';
      box.style.top = ny + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }
  $('btn-release-all').onclick = () => window.api.toEngine({ cmd: 'release_all' });
  $('btn-release-sel').onclick = () => {
    for (const h of capSelected) window.api.toEngine({ cmd: 'release', hwnd: h });
    capSelected.clear();
    renderCapList();
  };

  // About dialog
  $('ab-close').onclick = () => closeAbout();
  $('hp-close').onclick = () => closeHelp();
  $('ab-update').onclick = () => {
    // Reserved: no update service yet.
    $('ab-up-tip').textContent = '当前已是最新版本 V1.1.2';
  };
  document.querySelectorAll('.cs-qr').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      $('popup-qrzoom').classList.remove('hidden');
    });
  });
  $('popup-qrzoom').addEventListener('click', (e) => {
    e.stopPropagation();
    $('popup-qrzoom').classList.add('hidden');
  });

  // Login dialog
  $('lg-close').onclick = () => closeLogin();
  $('lg-submit').onclick = () => doLogin();
  $('lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('lg-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lg-pass').focus(); });
  document.querySelectorAll('#popup-login .lg-tab').forEach((t) => {
    t.onclick = () => switchLoginTab(t.dataset.tab);
  });

  // Activation dialog
  $('ac-close').onclick = () => closeActivate();
  $('ac-submit').onclick = () => doActivate();
  $('ac-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doActivate(); });
  $('ac-copy').onclick = () => {
    const code = state.machineCode || $('ac-machine').textContent || '';
    const done = () => { const b = $('ac-copy'); b.textContent = '已复制'; setTimeout(() => { b.textContent = '复制'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done);
    else done();
  };
  $('ac-wx').onclick = () => { $('ac-err').textContent = '微信账户激活即将上线，敬请期待'; };

  // Usage dialog
  $('us-close').onclick = () => closeUsage();
  $('us-day').onchange = (e) => { usageDayOffset = parseInt(e.target.value, 10) || 0; renderUsage(); };

  // Close confirmation dialog
  const hideClose = () => $('popup-close').classList.add('hidden');
  $('cl-x').onclick = hideClose;
  $('cl-cancel').onclick = hideClose;
  $('cl-min').onclick = () => { hideClose(); window.api.closeMinimize(); };
  $('cl-ok').onclick = () => { hideClose(); window.api.closeConfirm(); };
  window.api.onAskClose(() => {
    closeToolbarPopups();
    $('popup-close').classList.remove('hidden');
  });

  // Frameless window controls
  $('win-min').onclick = () => window.api.winMin();
  $('win-close').onclick = () => window.api.winClose();

  // Whole-toolbar custom drag: mousedown anywhere on the toolbar (including
  // tabs and icon buttons) moves the window. A >4px move hands off to the
  // engine, which tracks the cursor until the left button is released; the
  // click that would follow a drag is suppressed so buttons still work.
  (function () {
    const bar = $('toolbar');
    if (!bar) return;
    let sx = 0, sy = 0, tracking = false, started = false, dragged = false;
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      tracking = true; started = false; dragged = false;
      sx = e.screenX; sy = e.screenY;
    });
    document.addEventListener('mousemove', (e) => {
      if (!tracking || started) return;
      if (Math.abs(e.screenX - sx) > 4 || Math.abs(e.screenY - sy) > 4) {
        started = true; dragged = true;
        window.api.toEngine({ cmd: 'win_drag_begin' });
      }
    });
    document.addEventListener('mouseup', () => { tracking = false; });
    document.addEventListener('click', (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopPropagation(); e.preventDefault();
    }, true);
  })();

  // Reader annotation toolbar wiring
  const annBar = $('ann-bar');
  annBar.addEventListener('mousedown', (e) => e.stopPropagation());
  annBar.addEventListener('click', (e) => {
    const st = e.target.closest('.ann-style');
    if (st) {
      annUlStyle = st.dataset.s;
      annBar.querySelectorAll('.ann-style').forEach((b) => b.classList.toggle('active', b === st));
      e.stopPropagation();
      return;
    }
    const sw = e.target.closest('.ann-sw');
    if (sw) {
      annColor = sw.dataset.c;
      annBar.querySelectorAll('.ann-sw').forEach((b) => b.classList.toggle('sel', b === sw));
      e.stopPropagation();
      return;
    }
    if (e.target.id === 'ann-hl') { e.stopPropagation(); createAnn('hl', annColor); return; }
    if (e.target.id === 'ann-ul') { e.stopPropagation(); createAnn('ul', annColor, annUlStyle); return; }
    if (e.target.id === 'ann-copy') { e.stopPropagation(); copySel(); }
  });
  $('ann-del-btn').onclick = (e) => {
    e.stopPropagation();
    const id = $('ann-del').dataset.annId;
    if (id) removeAnn(id);
  };
  $('ann-del').addEventListener('mousedown', (e) => e.stopPropagation());
  document.addEventListener('mousedown', (e) => {
    if (!$('ann-bar').contains(e.target)) hideAnnBar();
    if (!$('ann-del').contains(e.target)) hideAnnDel();
  }, true);
  $('reader-host').addEventListener('scroll', () => { hideAnnBar(); hideAnnDel(); }, true);

  window.api.onBossDefaultTab(() => {
    // Emergency (SSS) mode: guarantee the visible tab is a clean Baidu home
    // page so no private content shows when the app is restored. Reuse an
    // existing Baidu home tab if present, otherwise open a fresh one.
    setView('browser');
    const idx = state.tabs.findIndex((t) => isBaiduHome(t.url));
    if (idx >= 0) activate(idx);
    else newTab(HOME_URL);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#popup-opacity') && !e.target.closest('#btn-opacity')) {
      $('popup-opacity').classList.add('hidden');
    }
    if (!e.target.closest('#popup-zoom') && !e.target.closest('#btn-zoom')) {
      $('popup-zoom').classList.add('hidden');
    }
    if (!e.target.closest('#popup-settings') && !e.target.closest('#btn-settings')) {
      $('popup-settings').classList.add('hidden');
    }
    if (!e.target.closest('#popup-about') && !e.target.closest('#set-about')) {
      closeAbout();
    }
    if (!e.target.closest('#popup-help') && !e.target.closest('#set-help')) {
      closeHelp();
    }
    if (!e.target.closest('#popup-login') && !e.target.closest('#set-login')) {
      closeLogin();
    }
    if (!e.target.closest('#popup-activate') && !e.target.closest('#set-activate')) {
      closeActivate();
    }
    if (!e.target.closest('#popup-usage') && !e.target.closest('#set-usage')) {
      closeUsage();
    }
    if (!e.target.closest('#popup-pass') && !e.target.closest('#set-pass')) {
      closePass();
    }
    if (!e.target.closest('#tab-menu') && !e.target.closest('#tab-overflow')) {
      hideTabMenu();
    }
    if (!e.target.closest('#popup-bmarks') && !e.target.closest('#shelf-bookmarks')) {
      $('popup-bmarks').classList.add('hidden');
    }
    if (!e.target.closest('#popup-reader') && !e.target.closest('#reader-settings')) {
      closeReaderSettings();
    }
    if (!e.target.closest('#popup-rlist') && !e.target.closest('#reader-toc') && !e.target.closest('#reader-bmarks')) {
      $('popup-rlist').classList.add('hidden');
    }
    if (!$('popup-prompt').classList.contains('hidden') && !e.target.closest('#popup-prompt')) {
      closePrompt(null);
    }
  });

  // Clicks that land inside the <webview> never reach the host document, so also
  // dismiss toolbar popups when the host window loses focus to the guest page.
  window.addEventListener('blur', closeToolbarPopups);

  let rt = null;
  const onResize = () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (state.view === 'browser') sendBrowserArea();
      updateOverflow();
      if (reader && reader.type === 'pdf' && reader.applyType) reader.applyType();
      else if (reader && reader.type === 'txt') updatePager();
      window.api.saveBounds();
    }, 200);
  };
  window.addEventListener('resize', onResize);

  document.addEventListener('keydown', (e) => {
    if (state.view !== 'reader' || !reader) return;
    if (e.key === 'ArrowLeft' && reader.prev) reader.prev();
    else if (e.key === 'ArrowRight' && reader.next) reader.next();
    else if (e.key === 'Escape') setView('ebook');
  });
}

function closeTabSilent(i) {
  const t = state.tabs.splice(i, 1)[0];
  if (t && t.el) t.el.remove();
  state.active = -1;
}

function go() {
  if (!ensureCanUse()) return;
  setView('browser');
  const w = activeWebview();
  const url = normalizeUrl($('url').value);
  if (w) w.loadURL(url);
  else newTab(url);
  window.api.saveUrl(url);
}

function init() {
  window.api.getSettings().then((s) => {
    state.settings = s || {};
    state.favorites = s.favorites || [];
    state.history = s.history || [];
    if (s.reader) {
      const r = s.reader;
      if (r.readerBg) state.readerBg = r.readerBg;
      if (r.readerFlow) state.readerFlow = r.readerFlow;
      if (typeof r.readerSpeed === 'number') state.readerSpeed = r.readerSpeed;
      if (typeof r.readerFontPct === 'number') state.readerFontPct = r.readerFontPct;
      if (typeof r.readerLineHeight === 'number') state.readerLineHeight = r.readerLineHeight;
      if (typeof r.readerParaSpacing === 'number') state.readerParaSpacing = r.readerParaSpacing;
      if (typeof r.readerFontFamily === 'string') state.readerFontFamily = r.readerFontFamily;
    }
    state.user = s.user || null;
    state.accounts = s.accounts || {};
    state.firstRun = s.firstRun || 0;
    state.activation = s.activation || null;
    // Resume the persisted session so usage tracking continues across restarts.
    if (state.user && state.accounts[state.user.account]) {
      state.session = { account: state.user.account, start: Date.now() };
      loadAccountReader();
    }
    $('cb-hide').checked = !!s.auto_hide;
    $('btn-top').classList.toggle('active', !!s.topmost);
    if (typeof s.opacity === 'number') {
      $('op-range').value = Math.round(s.opacity * 100);
      $('op-val').textContent = Math.round(s.opacity * 100) + '%';
      $('btn-opacity').classList.toggle('active', s.opacity < 1);
    }
    bindUi();
    updateLoginUI();
    newTab(s.url || 'https://www.baidu.com');
    window.api.toEngine({ cmd: 'set_paused', value: false });
    setTimeout(sendBrowserArea, 500);
    // Trial expired → require activation on startup; otherwise prompt to log in.
    if (isLocked()) setTimeout(openActivate, 400);
    else if (!isLoggedIn()) setTimeout(openLogin, 400);
  });

  window.api.library.list().then((l) => { state.books = l || []; state.bookmarks = flattenBookmarks(state.books); });
  window.api.folders.list().then((f) => { state.folders = f || []; });
  window.api.library.bookmarks().then((b) => { if (b && b.length) state.bookmarks = b; });
  window.api.favorites.list().then((l) => { state.favorites = l || []; updateFavBtn(); });
  window.api.history.list().then((l) => { state.history = l || []; });
  window.api.activity.list().then((a) => { state.activity = a || []; });

  window.api.onEngine((msg) => {
    if (msg.ev === 'captures') {
      state.captures = msg.items || [];
      for (const c of state.captures) {
        const key = String(c.hwnd || c.title || '');
        if (!key || state.seenHwnds.has(key)) continue;
        state.seenHwnds.add(key);
        logActivity('capture', c.title || '窗口', '绑定窗口');
      }
      renderTabs();
      renderCapList();
      updateStatus();
    } else if (msg.ev === 'app_hidden') {
      $('status').textContent = msg.value ? '已隐藏' : '就绪';
    }
  });

  window.api.onOpenUrl((url) => openUrl(url));

  // Persist the in-progress session's duration when the app closes.
  window.addEventListener('beforeunload', () => { try { saveReaderToAccount(); flushUsage(); } catch (e) { /* ignore */ } });
}

init();
