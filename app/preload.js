const { contextBridge, ipcRenderer } = require('electron');

const TO_ENGINE = ['release', 'release_all', 'tab_minimize', 'tab_restore',
  'bring_top', 'set_browser_area', 'set_paused', 'set_capture_enabled', 'win_drag_begin'];

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  toEngine: (msg) => {
    if (msg && TO_ENGINE.includes(msg.cmd)) ipcRenderer.send('to-engine', msg);
  },
  setTopmost: (v) => ipcRenderer.send('set-topmost', v),
  setOpacity: (v) => ipcRenderer.send('set-opacity', v),
  setAutoHide: (v) => ipcRenderer.send('set-auto-hide', v),
  saveUrl: (url) => ipcRenderer.send('save-url', url),
  saveReaderPrefs: (prefs) => ipcRenderer.send('save-reader-prefs', prefs),
  saveUser: (user) => ipcRenderer.send('save-user', user),
  saveAccounts: (accounts) => ipcRenderer.send('save-accounts', accounts),
  getMachineCode: () => ipcRenderer.invoke('get-machine-code'),
  activate: (code) => ipcRenderer.invoke('activate', code),
  saveBounds: () => ipcRenderer.send('save-bounds'),
  onEngine: (cb) => ipcRenderer.on('engine', (e, msg) => cb(msg)),
  onOpenUrl: (cb) => ipcRenderer.on('open-url', (e, url) => cb(url)),
  onAskClose: (cb) => ipcRenderer.on('ask-close', () => cb()),
  onBossDefaultTab: (cb) => ipcRenderer.on('boss-default-tab', () => cb()),
  winMin: () => ipcRenderer.send('win-min'),
  winClose: () => ipcRenderer.send('win-close'),
  closeConfirm: () => ipcRenderer.send('close-confirm'),
  closeMinimize: () => ipcRenderer.send('close-minimize'),

  library: {
    list: () => ipcRenderer.invoke('lib:list'),
    import: () => ipcRenderer.invoke('lib:import'),
    remove: (id) => ipcRenderer.invoke('lib:remove', id),
    update: (id, patch) => ipcRenderer.invoke('lib:update', id, patch),
    openExternal: (id) => ipcRenderer.invoke('lib:open-external', id),
    url: (id) => ipcRenderer.invoke('lib:url', id),
    addBookmark: (id, bm) => ipcRenderer.invoke('bm:add', id, bm),
    removeBookmark: (id, bmId) => ipcRenderer.invoke('bm:remove', id, bmId),
    bookmarks: () => ipcRenderer.invoke('bm:list'),
  },
  folders: {
    list: () => ipcRenderer.invoke('folders:list'),
    add: (name) => ipcRenderer.invoke('folders:add', name),
    remove: (name) => ipcRenderer.invoke('folders:remove', name),
  },
  favorites: {
    list: () => ipcRenderer.invoke('fav:list'),
    add: (item) => ipcRenderer.invoke('fav:add', item),
    remove: (url) => ipcRenderer.invoke('fav:remove', url),
  },
  history: {
    list: () => ipcRenderer.invoke('hist:list'),
    add: (item) => ipcRenderer.invoke('hist:add', item),
    clear: () => ipcRenderer.invoke('hist:clear'),
  },
  activity: {
    list: () => ipcRenderer.invoke('activity:list'),
    add: (item) => ipcRenderer.invoke('activity:add', item),
  },
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    add: (item) => ipcRenderer.invoke('notes:add', item),
    del: (id) => ipcRenderer.invoke('notes:del', id),
    setAll: (list) => ipcRenderer.invoke('notes:setall', list),
  },
});
