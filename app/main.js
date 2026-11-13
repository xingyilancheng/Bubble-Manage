const { app, BrowserWindow, ipcMain, protocol, dialog, shell, net: enet } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const IS_PACKAGED = app.isPackaged;
// Settings live beside the code in dev, but in a writable userData dir when
// packaged (the asar archive is read-only).
const DATA_DIR = IS_PACKAGED ? app.getPath('userData') : __dirname;
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
// Dev runs the .py via system python; packaged runs the bundled frozen exe.
const ENGINE_PY = path.join(__dirname, '..', 'capture_engine.py');
const ENGINE_EXE = path.join(process.resourcesPath, 'capture_engine.exe');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

function booksDir() {
  const d = path.join(app.getPath('userData'), 'books');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
  return d;
}
function libFile() { return path.join(app.getPath('userData'), 'library.json'); }
function readLib() {
  try {
    const j = JSON.parse(fs.readFileSync(libFile(), 'utf-8'));
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}
function writeLib(list) {
  try { fs.writeFileSync(libFile(), JSON.stringify(list)); } catch (e) { /* ignore */ }
}
function isInside(p, dir) {
  const r = path.resolve(p);
  return r === dir || r.startsWith(dir + path.sep);
}

let win = null;
let pyProc = null;
let sock = null;
let sockReady = false;
let pending = [];
let allowQuit = false;

// "SSS" boss key: the engine polls the physical S key globally (so it fires even
// when the app is hidden/minimized) and has already minimized every bound window
// before sending ev:sss. Here we return the UI to the default tab, then minimize.
function bossFromEngine() {
  if (win) {
    win.webContents.send('boss-default-tab');
    win.minimize();
  }
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveSettings(patch) {
  const s = Object.assign(loadSettings(), patch);
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s));
  } catch (e) { /* ignore */ }
  return s;
}

// Stable per-machine identifier derived from the first non-internal MAC + hostname.
function getMachineCode() {
  let mac = '';
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const it of (ifaces[name] || [])) {
        if (!it.internal && it.mac && it.mac !== '00:00:00:00:00:00') { mac = it.mac; break; }
      }
      if (mac) break;
    }
  } catch (e) { /* ignore */ }
  const seed = (mac || 'no-mac') + '|' + (os.hostname() || 'no-host');
  const h = crypto.createHash('sha256').update(seed).digest('hex').toUpperCase().slice(0, 16);
  return h.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

// Activation codes are HMAC(secret, machineCode) truncated to 8 bytes, hex,
// dashed every 4 chars. The standalone generator tool mirrors this exactly.
const ACTIVATION_SECRET = 'MAOPAO-GUANJIA-ACT-2026';
function normCode(s) { return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
function genActivationCode(machineCode) {
  const digest = crypto.createHmac('sha256', ACTIVATION_SECRET).update(normCode(machineCode)).digest();
  const hex = digest.slice(0, 8).toString('hex').toUpperCase();
  return hex.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

function pySend(obj) {
  const line = JSON.stringify(obj) + '\n';
  if (sockReady && sock) {
    try { sock.write(line); return; } catch (e) { /* fallthrough */ }
  }
  pending.push(obj);
}

function connectEngine(port) {
  sock = net.connect({ host: '127.0.0.1', port }, () => {
    sockReady = true;
    const handle = win.getNativeWindowHandle();
    const hwnd = Number(handle.readBigUInt64LE(0));
    pySend({ cmd: 'hello', app_hwnd: hwnd });
    const s = loadSettings();
    pySend({ cmd: 'set_auto_hide', value: !!s.auto_hide });
    for (const p of pending) {
      try { sock.write(JSON.stringify(p) + '\n'); } catch (e) { /* ignore */ }
    }
    pending = [];
  });
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf-8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.ev === 'sss') { bossFromEngine(); continue; }
      if (win && msg.ev) win.webContents.send('engine', msg);
    }
  });
  sock.on('close', () => { sockReady = false; });
  sock.on('error', () => { sockReady = false; });
}

function startEngine() {
  const opts = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
  pyProc = IS_PACKAGED
    ? spawn(ENGINE_EXE, [], opts)
    : spawn('python', [ENGINE_PY], opts);
  let out = '';
  const onOut = (d) => {
    out += d.toString('utf-8');
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg && msg.ev === 'ready' && msg.port) connectEngine(msg.port);
    }
  };
  pyProc.stdout.on('data', onOut);
  pyProc.stderr.on('data', (d) => { process.stderr.write('[engine] ' + d); });
  pyProc.on('exit', () => { pyProc = null; });
}

function createWindow() {
  const s = loadSettings();
  win = new BrowserWindow({
    width: s.width || 985,
    height: s.height || 1006,
    x: s.x,
    y: s.y,
    title: '冒泡管家',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#1f2023',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadURL('app://app/index.html');
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) process.stderr.write('[renderer] ' + message + '\n');
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    process.stderr.write('[load-fail] ' + code + ' ' + desc + ' ' + url + '\n');
  });
  if (s.topmost) win.setAlwaysOnTop(true);
  if (typeof s.opacity === 'number' && s.opacity < 1) win.setOpacity(s.opacity);
  // Intercept close so the renderer can show a 取消/最小化/确认 dialog.
  win.on('close', (e) => {
    if (!allowQuit) {
      e.preventDefault();
      win.webContents.send('ask-close');
    }
  });
  win.on('closed', () => { win = null; });
}

ipcMain.on('to-engine', (e, msg) => { pySend(msg); });

ipcMain.on('win-min', () => { if (win) win.minimize(); });
ipcMain.on('win-close', () => { if (win) win.close(); });

ipcMain.on('close-confirm', () => { allowQuit = true; app.quit(); });
ipcMain.on('close-minimize', () => { if (win) win.minimize(); });

ipcMain.on('set-topmost', (e, v) => {
  if (win) win.setAlwaysOnTop(!!v);
  saveSettings({ topmost: !!v });
});

ipcMain.on('set-opacity', (e, v) => {
  const o = Math.min(1, Math.max(0.3, Number(v) || 1));
  if (win) win.setOpacity(o);
  saveSettings({ opacity: o });
});

ipcMain.on('set-auto-hide', (e, v) => {
  saveSettings({ auto_hide: !!v });
  pySend({ cmd: 'set_auto_hide', value: !!v });
});

ipcMain.on('set-browser-area', (e, rect) => {
  pySend({ cmd: 'set_browser_area', rect });
});

ipcMain.on('save-url', (e, url) => { saveSettings({ url }); });

ipcMain.on('save-reader-prefs', (e, prefs) => { saveSettings({ reader: prefs || {} }); });

ipcMain.on('save-user', (e, user) => { saveSettings({ user: user || null }); });

ipcMain.on('save-accounts', (e, accounts) => { saveSettings({ accounts: accounts || {} }); });

ipcMain.handle('get-machine-code', () => getMachineCode());

// Verify an activation code against this machine and persist activation.
ipcMain.handle('activate', (e, code) => {
  const mc = getMachineCode();
  const expected = genActivationCode(mc);
  if (normCode(code) === normCode(expected)) {
    const activation = { code: expected, at: Date.now(), machine: mc };
    saveSettings({ activation });
    return { ok: true, activation };
  }
  return { ok: false };
});

// Activity log (reading + window-binding records), separate from browser history.
function pushActivity(type, title, detail) {
  const s = loadSettings();
  const a = s.activity || [];
  const acct = (s.user && s.user.account) || '';
  a.unshift({ type, title: title || '', detail: detail || '', account: acct, at: Date.now() });
  saveSettings({ activity: a.slice(0, 1000) });
}
ipcMain.handle('activity:list', () => loadSettings().activity || []);
ipcMain.handle('activity:add', (e, item) => {
  if (!item || !item.type) return false;
  const a = loadSettings().activity || [];
  a.unshift({
    type: item.type, title: item.title || '', detail: item.detail || '',
    account: item.account || '', at: item.at || Date.now(),
  });
  saveSettings({ activity: a.slice(0, 1000) });
  return true;
});

// ── Notes (browser + reader) ────────────────────────────
ipcMain.handle('notes:list', () => loadSettings().notes || []);
ipcMain.handle('notes:add', (e, item) => {
  const text = String((item && item.text) || '').trim();
  if (!text) return false;
  const s = loadSettings();
  const n = s.notes || [];
  n.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    text,
    ctx: String((item && item.ctx) || ''),
    kind: (item && item.kind) || 'browser',
    account: (s.user && s.user.account) || '',
    at: Date.now(),
  });
  saveSettings({ notes: n.slice(0, 500) });
  return true;
});
ipcMain.handle('notes:del', (e, id) => {
  const s = loadSettings();
  saveSettings({ notes: (s.notes || []).filter((x) => x.id !== id) });
  return true;
});
// Full replace used by the notes editor tab (edit + reorder in one push).
ipcMain.handle('notes:setall', (e, list) => {
  if (!Array.isArray(list)) return false;
  const clean = list.slice(0, 500).map((n) => ({
    id: String(n.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7))),
    text: String(n.text || ''),
    ctx: String(n.ctx || ''),
    kind: n.kind || 'browser',
    account: String(n.account || ''),
    at: Number(n.at) || Date.now(),
  })).filter((n) => n.text.trim());
  saveSettings({ notes: clean });
  return true;
});

ipcMain.handle('get-settings', () => {
  const s = loadSettings();
  if (!s.firstRun) { s.firstRun = Date.now(); saveSettings({ firstRun: s.firstRun }); }
  return s;
});

ipcMain.on('save-bounds', () => {
  if (!win) return;
  const b = win.getBounds();
  saveSettings({ x: b.x, y: b.y, width: b.width, height: b.height });
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  // Serve the UI and the book files over a same-origin app:// scheme so that
  // pdf.js workers, fetch() and ES modules all work (file:// blocks workers).
  protocol.handle('app', (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname);
      const bd = booksDir();
      let fp;
      if (p.startsWith('/books/')) {
        fp = path.join(bd, p.slice(7));
        if (!isInside(fp, bd)) return new Response('forbidden', { status: 403 });
      } else {
        if (p === '/' || p === '') p = '/index.html';
        fp = path.join(__dirname, p);
        if (!isInside(fp, __dirname)) return new Response('forbidden', { status: 403 });
      }
      return enet.fetch(pathToFileURL(fp).toString());
    } catch (e) {
      return new Response('error', { status: 500 });
    }
  });

  // Never let links open a separate OS window; route popups/new-tab links
  // back into the embedded browser as a new tab.
  app.on('web-contents-created', (e, contents) => {
    contents.setWindowOpenHandler(({ url, disposition }) => {
      console.log('[DIAG window-open]', disposition, url);
      if (win && url && /^https?:/i.test(url)) {
        win.webContents.send('open-url', url);
      }
      return { action: 'deny' };
    });
    // Guest pages (webview tabs) swallow key events, so wire Ctrl +/=/-/0 zoom
    // here — the host renderer never sees them while a tab is focused.
    if (contents.getType() === 'webview') {
      contents.on('will-navigate', (ev, url) => { console.log('[DIAG will-navigate]', url); });
      contents.on('did-navigate', (ev, url, code) => { console.log('[DIAG did-navigate]', code, url); });
      contents.on('did-navigate-in-page', (ev, url, isMain) => { if (isMain) console.log('[DIAG did-navigate-in-page]', url); });
      contents.on('did-fail-load', (ev, code, desc, url) => { console.log('[DIAG did-fail-load]', code, desc, url); });
      contents.on('console-message', (ev, a, b) => {
        const m = (a && typeof a === 'object') ? a.message : b;
        if (typeof m === 'string') console.log('[DIAG guest-console]', m.slice(0, 200));
      });
      contents.on('before-input-event', (ev, input) => {
        if (!input.control || input.type !== 'keyDown') return;
        const c = input.code;
        let f = contents.getZoomFactor();
        if (c === 'Equal' || c === 'NumpadAdd') f = Math.min(3, Math.round(f * 1.2 * 100) / 100);
        else if (c === 'Minus' || c === 'NumpadSubtract') f = Math.max(0.5, Math.round(f / 1.2 * 100) / 100);
        else if (c === 'Digit0' || c === 'Numpad0') f = 1;
        else return;
        ev.preventDefault();
        contents.setZoomFactor(f);
      });

      // Ctrl + wheel zoom. The guest swallows wheel events too, and Electron
      // exposes no wheel hook on WebContents, so inject a listener that reports
      // the direction back through console.info and adjust the zoom here.
      const WHEEL_ZOOM_JS =
        "(function(){if(window.__cz)return;window.__cz=1;var t=0;" +
        "window.addEventListener('wheel',function(e){if(!e.ctrlKey)return;e.preventDefault();" +
        "var n=Date.now();if(n-t<50)return;t=n;console.info('__CZ__'+(e.deltaY<0?'in':'out'));}," +
        "{passive:false,capture:true});})();";
      contents.on('dom-ready', () => {
        contents.executeJavaScript(WHEEL_ZOOM_JS).catch(() => {});
      });
      contents.on('console-message', (ev, a, b) => {
        // Electron 33 may pass (level, message, ...) or a single details object.
        const msg = (a && typeof a === 'object') ? a.message : b;
        if (typeof msg !== 'string' || msg.indexOf('__CZ__') !== 0) return;
        const r = (x) => Math.round(x * 100) / 100;
        let f = contents.getZoomFactor();
        f = msg.slice(6) === 'in' ? Math.min(3, r(f * 1.1)) : Math.max(0.5, r(f / 1.1));
        contents.setZoomFactor(f);
      });
    }
  });
  createWindow();
  pushActivity('open', '启动应用', '');
  startEngine();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ── Library / favorites / history ────────────────────────

ipcMain.handle('lib:list', () => readLib());

ipcMain.handle('lib:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入电子书',
    buttonLabel: '导入',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '电子书', extensions: ['epub', 'pdf', 'txt', 'mobi', 'azw', 'azw3', 'fb2', 'cbz', 'cbr', 'djvu'] }],
  });
  if (res.canceled) return readLib();
  const list = readLib();
  const dir = booksDir();
  for (const src of res.filePaths) {
    try {
      const ext = path.extname(src).toLowerCase();
      const base = path.basename(src, path.extname(src));
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const file = id + ext;
      fs.copyFileSync(src, path.join(dir, file));
      const size = fs.statSync(path.join(dir, file)).size;
      list.push({ id, title: base, author: '', format: ext.replace('.', ''), file, added: Date.now(), size, collection: '' });
    } catch (e) { /* skip unreadable file */ }
  }
  writeLib(list);
  return list;
});

ipcMain.handle('lib:remove', (e, id) => {
  let list = readLib();
  const b = list.find((x) => x.id === id);
  if (b) {
    try { fs.unlinkSync(path.join(booksDir(), b.file)); } catch (_) { /* ignore */ }
    list = list.filter((x) => x.id !== id);
    writeLib(list);
  }
  return list;
});

ipcMain.handle('lib:update', (e, id, patch) => {
  const list = readLib();
  const b = list.find((x) => x.id === id);
  if (b) {
    if (patch.title != null) b.title = String(patch.title);
    if (patch.author != null) b.author = String(patch.author);
    if (patch.collection != null) b.collection = String(patch.collection);
    if (typeof patch.lastOpened === 'number') b.lastOpened = patch.lastOpened;
    if (typeof patch.progress === 'number') b.progress = Math.max(0, Math.min(1, patch.progress));
    if (patch.lastLocation && typeof patch.lastLocation === 'object') b.lastLocation = patch.lastLocation;
    if (Array.isArray(patch.anns)) b.anns = patch.anns;
    writeLib(list);
  }
  return list;
});

ipcMain.handle('lib:open-external', (e, id) => {
  const b = readLib().find((x) => x.id === id);
  if (b) shell.openPath(path.join(booksDir(), b.file));
});

ipcMain.handle('lib:url', (e, id) => {
  const b = readLib().find((x) => x.id === id);
  return b ? 'app://app/books/' + encodeURIComponent(b.file) : null;
});

// ── Bookmarks ────────────────────────────────────────────

ipcMain.handle('bm:add', (e, id, bm) => {
  const list = readLib();
  const b = list.find((x) => x.id === id);
  if (b) {
    if (!Array.isArray(b.bookmarks)) b.bookmarks = [];
    b.bookmarks.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: String((bm && bm.label) || '书签'),
      loc: (bm && bm.loc) || {},
      excerpt: String((bm && bm.excerpt) || '').slice(0, 200),
      progress: typeof (bm && bm.progress) === 'number' ? Math.max(0, Math.min(1, bm.progress)) : 0,
      page: (bm && bm.page) || 0,
      total: (bm && bm.total) || 0,
      at: Date.now(),
    });
    writeLib(list);
  }
  return list;
});

ipcMain.handle('bm:remove', (e, id, bmId) => {
  const list = readLib();
  const b = list.find((x) => x.id === id);
  if (b && Array.isArray(b.bookmarks)) {
    b.bookmarks = b.bookmarks.filter((x) => x.id !== bmId);
    writeLib(list);
  }
  return list;
});

ipcMain.handle('bm:list', () => {
  const out = [];
  readLib().forEach((b) => (b.bookmarks || []).forEach((bm) => out.push({
    id: bm.id, bookId: b.id, bookTitle: b.title, format: b.format,
    label: bm.label, loc: bm.loc, excerpt: bm.excerpt, progress: bm.progress,
    page: bm.page, total: bm.total, at: bm.at,
  })));
  return out;
});

// ── Folders (collections) ────────────────────────────────

ipcMain.handle('folders:list', () => loadSettings().folders || []);
ipcMain.handle('folders:add', (e, name) => {
  name = String(name || '').trim();
  const f = loadSettings().folders || [];
  if (name && !f.includes(name)) { f.push(name); saveSettings({ folders: f }); }
  return loadSettings().folders || [];
});
ipcMain.handle('folders:remove', (e, name) => {
  const f = (loadSettings().folders || []).filter((x) => x !== name);
  saveSettings({ folders: f });
  const list = readLib();
  let changed = false;
  list.forEach((b) => { if (b.collection === name) { b.collection = ''; changed = true; } });
  if (changed) writeLib(list);
  return f;
});

ipcMain.handle('fav:list', () => loadSettings().favorites || []);
ipcMain.handle('fav:add', (e, item) => {
  const favs = loadSettings().favorites || [];
  if (item && item.url && !favs.some((f) => f.url === item.url)) {
    favs.unshift({ title: item.title || item.url, url: item.url });
    saveSettings({ favorites: favs.slice(0, 200) });
  }
  return loadSettings().favorites || [];
});
ipcMain.handle('fav:remove', (e, url) => {
  const favs = (loadSettings().favorites || []).filter((f) => f.url !== url);
  saveSettings({ favorites: favs });
  return favs;
});

ipcMain.handle('hist:list', () => loadSettings().history || []);
ipcMain.handle('hist:add', (e, item) => {
  if (!item || !item.url || !/^https?:/i.test(item.url)) return false;
  let h = (loadSettings().history || []).filter((x) => x.url !== item.url);
  h.unshift({ title: item.title || item.url, url: item.url, account: item.account || '', at: Date.now() });
  saveSettings({ history: h.slice(0, 500) });
  return true;
});
ipcMain.handle('hist:clear', () => { saveSettings({ history: [] }); return []; });

app.on('before-quit', () => {
  pushActivity('close', '关闭应用', '');
  pySend({ cmd: 'shutdown' });
  if (pyProc) {
    try { pyProc.kill(); } catch (e) { /* ignore */ }
  }
});

app.on('window-all-closed', () => {
  if (pyProc) {
    try { pyProc.kill(); } catch (e) { /* ignore */ }
  }
  app.quit();
});
