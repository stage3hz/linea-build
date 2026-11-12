const { app, BrowserWindow, ipcMain, protocol, net, session, safeStorage, desktopCapturer, dialog, shell, globalShortcut, screen, nativeImage, Tray, Menu, Notification } = require('electron');
// Our servers only (same rule as mobile/src/servers/list.ts): any number of them, all under our domains.
const TRUSTED_HOST = /^(?:[a-z0-9-]+\.)*invizent\.(?:com|ru)$|^141-133-194-51\.nip\.io$|^invizent-api\.invizent-8165e2\.workers\.dev$/;
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createUpdater } = require('./update.cjs');
const { notificationPayload, applyTrayBadge } = require('./notify.cjs');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'invizent', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }, { scheme: 'invizent-cache', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
let window, cacheRoot, picker = null, capture = null;
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
const cachePath = uri => { const url = new URL(uri); if (url.protocol !== 'invizent-cache:' || url.hostname !== 'local') throw new Error('Invalid cache URI'); const target=path.resolve(cacheRoot,'.'+decodeURIComponent(url.pathname)); if (target !== cacheRoot && !target.startsWith(cacheRoot+path.sep)) throw new Error('Invalid cache path'); return target; };
const vaults = new Map(), scopes = new Map(), requests = new Map();
const update = createUpdater({ tempDir: () => app.getPath('temp') });
const ready = Promise.all([import('./signal.mjs'), import('./vault.mjs')]);
const trusted = event => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith('invizent://app/');
async function vault(scope) {
  if (typeof scope !== 'string' || scope.length > 2048) throw new Error('Invalid scope');
  if (!scopes.has(scope)) scopes.set(scope, ready.then(([,v]) => v.openDesktopVault(path.join(app.getPath('userData'),'private'), scope, safeStorage)).catch(e => { scopes.delete(scope); throw e; }));
  return scopes.get(scope);
}
ipcMain.handle('window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender); if (!win || win !== window) return null;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused(), platform: process.platform };
});
ipcMain.handle('capture-sources',event=>{
  if(event.sender!==picker?.webContents)throw new Error('Untrusted capture picker');
  return [...capture.sources.values()].map(source=>({id:source.id,name:source.name,image:source.thumbnail.toDataURL()}));
});
ipcMain.handle('capture-choose',(event,id)=>{
  if(event.sender!==picker?.webContents)throw new Error('Untrusted capture picker');
  const source=capture.sources.get(id),callback=capture.callback;capture=null;picker.close();picker=null;
  // The sound of the whole computer goes with any choice (a screen, a window or a game), not only
  // when one app is picked. Windows: system loopback; macOS 14.2+: CoreAudio tap (needs
  // NSAudioCaptureUsageDescription). The renderer asks restrictOwnAudio so Инвиз's own sound
  // (the people in the channel) is left out — no echo.
  const sound=process.platform==='win32'||process.platform==='darwin'?{audio:'loopback'}:{};
  // null = cancelled (an empty object makes Electron throw «Video was requested…» and crash).
  callback(source?{video:source,...sound}:null);
});
// ---- in-game overlay (Настройки → Оверлей; off by default) ----
// A tiny transparent window that never takes focus or clicks, above other windows. Shown only
// while you are in a voice channel and Инвиз itself is not the active window. Works over games in
// windowed / borderless mode. For fullscreen games (exclusive or borderless) on Windows there is
// also the in-game overlay (game-overlay.cjs, option «Показывать в полноэкранных играх»): drawn by
// the game itself, like Discord's; while the game reports drawing it, this window hides.
let overlayWin = null, overlayPrefs = { enabled: false, inject: true, corner: 'topLeft', opacity: 0.9 }, overlayView = null;
const ROW = 32, HEAD = 22, WIDTH = 260;
function overlayHeight() { return overlayView ? HEAD + 12 + overlayView.people.length * (ROW + 4) : 40; }
function placeOverlay() {
  if (!overlayWin) return;
  const area = screen.getPrimaryDisplay().workArea, h = overlayHeight(), m = 16;
  const x = overlayPrefs.corner.endsWith('Right') ? area.x + area.width - WIDTH - m : area.x + m;
  const y = overlayPrefs.corner.startsWith('bottom') ? area.y + area.height - h - m : area.y + m;
  overlayWin.setBounds({ x, y, width: WIDTH, height: h });
}
function refreshOverlay() {
  refreshGameOverlay();
  const wanted = overlayPrefs.enabled && overlayView && overlayView.people.length && window && !window.isDestroyed() && !window.isFocused() && !gameOverlay?.drawingInGame();
  if (!wanted) { if (overlayWin && overlayWin.isVisible()) overlayWin.hide(); if (overlayWin && overlayView) overlayWin.webContents.send('overlay-view', overlayView, overlayPrefs.opacity); return; }
  if (!overlayWin) {
    overlayWin = new BrowserWindow({ width: WIDTH, height: overlayHeight(), show: false, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.setIgnoreMouseEvents(true);
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlayWin.webContents.on('will-navigate', e => e.preventDefault());
    overlayWin.on('closed', () => { overlayWin = null; });
    void overlayWin.loadFile(path.join(__dirname, 'overlay.html')).then(() => refreshOverlay());
    return;
  }
  placeOverlay();
  overlayWin.webContents.send('overlay-view', overlayView, overlayPrefs.opacity);
  if (!overlayWin.isVisible()) overlayWin.showInactive();
}

// ---- «Снег»: a drift on the top edge of the window ----
// A thin transparent strip owned by the main window, sitting just above its top edge (it moves, hides and
// minimises with the window and never goes above other apps' windows on its own). It takes no focus and no
// clicks; the cursor position over it is read here and passed to the page so the snow can be swept off.
const SNOW_CAP = 30;
let snowWin = null, snowOn = false, snowTimer = null, snowCursorOver = false;
function placeSnowCap() {
  if (!snowWin || snowWin.isDestroyed() || !window || window.isDestroyed()) return;
  const hidden = !snowOn || !window.isVisible() || window.isMinimized() || window.isMaximized() || window.isFullScreen();
  if (hidden) { if (snowWin.isVisible()) snowWin.hide(); return; }
  const b = window.getBounds();
  // The full width of the window, 3 px over it so the drift sits on its edge with no gap.
  snowWin.setBounds({ x: b.x, y: b.y - SNOW_CAP + 3, width: Math.max(40, b.width), height: SNOW_CAP });
  if (!snowWin.isVisible()) snowWin.showInactive();
}
function snowCap(on) {
  snowOn = on === true;
  if (!snowOn) { clearInterval(snowTimer); snowTimer = null; if (snowWin && !snowWin.isDestroyed()) snowWin.destroy(); snowWin = null; return; }
  if (!window || window.isDestroyed()) return;
  if (!snowWin || snowWin.isDestroyed()) {
    snowWin = new BrowserWindow({ parent: window, width: 400, height: SNOW_CAP, show: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false, minimizable: false, maximizable: false, focusable: false, skipTaskbar: true, hasShadow: false, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, 'snow-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
    const win = snowWin;
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.on('closed', () => { if (snowWin === win) snowWin = null; });
    void win.loadFile(path.join(__dirname, 'snow.html')).then(() => placeSnowCap()).catch(() => {});
  }
  if (!snowTimer) snowTimer = setInterval(() => {
    if (!snowWin || snowWin.isDestroyed() || !snowWin.isVisible()) return;
    const p = screen.getCursorScreenPoint(), b = snowWin.getBounds();
    const over = p.x >= b.x - 30 && p.x <= b.x + b.width + 30 && p.y >= b.y - 30 && p.y <= b.y + b.height + 30;
    if (over) snowWin.webContents.send('snow-cursor', p.x - b.x, p.y - b.y);
    else if (snowCursorOver) snowWin.webContents.send('snow-cursor', null, null);
    snowCursorOver = over;
  }, 33);
  placeSnowCap();
}

// In-game overlay for fullscreen games (Windows only). The overlay page is rendered offscreen at
// 15 fps at most (Chromium paints only when something changed) and handed to the helper, which
// shares it with the game; see game-overlay.cjs and native/overlay/README.md.
const gameOverlay = process.platform === 'win32' ? require('./game-overlay.cjs').createGameOverlay({
  binDir: app.isPackaged ? path.join(process.resourcesPath, 'overlay') : path.join(__dirname, 'native', 'overlay', 'out'),
  spawn: (...args) => require('node:child_process').spawn(...args),
  log: message => console.log(message),
  ownPids: () => { try { return new Set([process.pid, ...app.getAppMetrics().map(m => m.pid)]); } catch { return new Set([process.pid]); } },
  ownExe: path.basename(process.execPath),
  systemRoot: process.env.SystemRoot || 'C:\\Windows',
  onDrawingChange: () => refreshOverlay(),
}) : null;
let gameOverlayWin = null;
function refreshGameOverlay() {
  if (!gameOverlay) return;
  const inVoice = !!(overlayPrefs.enabled && overlayView && overlayView.people.length);
  gameOverlay.update({ enabled: overlayPrefs.enabled, inject: overlayPrefs.inject, corner: overlayPrefs.corner, opacity: overlayPrefs.opacity, inVoice, appFocused: !!window && !window.isDestroyed() && window.isFocused() });
  if (!gameOverlay.rendererWanted()) { if (gameOverlayWin && !gameOverlayWin.isDestroyed()) gameOverlayWin.destroy(); gameOverlayWin = null; return; }
  if (!gameOverlayWin) {
    gameOverlayWin = new BrowserWindow({ width: WIDTH, height: overlayHeight(), show: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, focusable: false, skipTaskbar: true,
      webPreferences: { offscreen: true, preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
    const win = gameOverlayWin;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setFrameRate(15);
    win.webContents.on('paint', (_event, _dirty, image) => {
      if (win.isDestroyed() || image.isEmpty()) return;
      const size = image.getSize(), fit = require('./game-overlay.cjs').fitSize(size.width, size.height);
      const picture = fit.width === size.width && fit.height === size.height ? image : image.resize({ ...fit, quality: 'good' });
      gameOverlay.frame({ ...picture.getSize(), pixels: picture.toBitmap() }); // BGRA on Windows
    });
    win.on('closed', () => { if (gameOverlayWin === win) gameOverlayWin = null; });
    void win.loadFile(path.join(__dirname, 'overlay.html')).then(() => refreshOverlay()).catch(() => {});
    return;
  }
  // Opacity 1 in the page: the game applies the chosen opacity itself (header field).
  gameOverlayWin.setContentSize(WIDTH, overlayHeight());
  gameOverlayWin.webContents.send('overlay-view', overlayView, 1);
}

// ---- system keyboard hook for hold binds (see 'setHold') ----
let hook = null, hookRunning = false, holdBinds = [], holdChanges = [];
function parseHold(combo) {
  if (typeof combo !== 'string' || !/^((Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z0-9]{1,20}$/.test(combo)) return null;
  const parts = combo.split('+'); const code = parts.pop();
  if (!hook) { try { hook = require('uiohook-napi'); } catch { return null; } }
  const name = code.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, '');
  const keycode = hook.UiohookKey[name];
  if (typeof keycode !== 'number') return null;
  return { keycode, ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), meta: parts.includes('Meta') };
}
function onHookKey(event, down) {
  for (const bind of holdBinds) {
    if (event.keycode !== bind.keycode) continue;
    // Pressing needs the bind's modifiers; releasing the main key always ends the hold.
    if (down && ((bind.ctrl && !event.ctrlKey) || (bind.alt && !event.altKey) || (bind.shift && !event.shiftKey) || (bind.meta && !event.metaKey))) continue;
    if (bind.down === down) continue;
    bind.down = down;
    window?.webContents.send('invizent-hold', bind.action, down);
  }
}
function startHook() {
  if (hookRunning || !hook) return;
  try {
    hook.uIOhook.removeAllListeners();
    hook.uIOhook.on('keydown', e => onHookKey(e, true));
    hook.uIOhook.on('keyup', e => onHookKey(e, false));
    hook.uIOhook.start(); hookRunning = true;
  } catch { hookRunning = false; }
}
function stopHook() {
  if (!hookRunning) return;
  try { hook.uIOhook.stop(); } catch { /* already stopped */ }
  hookRunning = false;
  for (const bind of holdBinds) if (bind.down) { bind.down = false; window?.webContents.send('invizent-hold', bind.action, false); }
}
app.on('will-quit', () => stopHook());

// "Ctrl+Shift+KeyM" (KeyboardEvent.code) → "Control+Shift+M" (Electron accelerator).
function toAccelerator(combo) {
  if (typeof combo !== 'string' || !/^((Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z0-9]{1,20}$/.test(combo)) return null;
  const parts = combo.split('+'); const key = parts.pop();
  const name = /^Key[A-Z]$/.test(key) ? key.slice(3) : /^Digit\d$/.test(key) ? key.slice(5) : /^F\d{1,2}$/.test(key) ? key : key === 'Space' ? 'Space' : key === 'Backquote' ? '`' : /^Numpad\d$/.test(key) ? 'num' + key.slice(6) : null;
  if (!name) return null;
  return [...parts.map(p => (p === 'Ctrl' ? 'Control' : p === 'Meta' ? 'Super' : p)), name].join('+');
}
app.on('will-quit', () => globalShortcut.unregisterAll());
ipcMain.handle('invizent', async (event, method, ...args) => {
  if (!trusted(event)) throw new Error('Untrusted IPC sender');
  if (method === 'saveFile') {
    const file=cachePath(args[0]), name=path.basename(String(args[1])).replace(/[<>:"|?*\x00-\x1f]/g,'_');
    const result=await dialog.showSaveDialog(window,{defaultPath:name});if(!result.canceled&&result.filePath)await fs.copyFile(file,result.filePath);return;
  }
  if (method === 'openFile') {
    const file=cachePath(args[0]); if(!['.pdf','.txt','.md','.csv','.rtf','.docx','.xlsx','.pptx'].includes(path.extname(file).toLowerCase()))return false;
    const answer=await dialog.showMessageBox(window,{type:'warning',message:'Открыть документ в системном приложении?',detail:`${path.basename(file)}\n\nФайл получен в переписке. Открывай его, только если доверяешь отправителю.`,buttons:['Отмена','Открыть'],defaultId:0,cancelId:0});
    if(answer.response!==1)return false;
    // Windows: the file is marked as coming from the internet, so Office and other viewers open it in their protected mode.
    if(process.platform==='win32')await fs.writeFile(`${file}:Zone.Identifier`,'[ZoneTransfer]\r\nZoneId=3\r\n').catch(()=>{});
    return (await shell.openPath(file)) === '';
  }
  if (method === 'files') {
    const [operation, parameters] = args; if (!Array.isArray(parameters)) throw new Error('Invalid file operation');
    const file = cachePath(parameters[0]);
    if (operation === 'info') { try { const info=await fs.stat(file); return {exists:true,isDirectory:info.isDirectory(),size:info.size,uri:parameters[0]}; } catch(e) {if(e.code==='ENOENT')return {exists:false};throw e;} }
    if (operation === 'read') { if((await fs.stat(file)).size>32*1024*1024)throw new Error('Read file in chunks'); const bytes=await fs.readFile(file); return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength); }
    if (operation === 'write') { if (!(parameters[1] instanceof Uint8Array) || parameters[1].length>32*1024*1024) throw new Error('Invalid cache write'); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,parameters[1],{mode:0o600}); return; }
    if (operation === 'append') { if (!(parameters[1] instanceof Uint8Array) || parameters[1].length>8*1024*1024) throw new Error('Invalid cache append'); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.appendFile(file,parameters[1],{mode:0o600}); return; }
    if (operation === 'mkdir') return fs.mkdir(file,{recursive:true});
    if (operation === 'delete') { if(file===cacheRoot)throw new Error('Cannot delete cache root'); return fs.rm(file,{recursive:true,force:true}); }
    if (operation === 'list') return fs.readdir(file);
    throw new Error('Invalid cache operation');
  }
  // Unread counter on the taskbar button (Windows: a small overlay picture drawn by the page) or
  // on the dock / launcher icon (macOS, Linux).
  if (method === 'badge') {
    const count = Number.isSafeInteger(args[0]) ? Math.min(Math.max(args[0], 0), 99999) : 0;
    const picture = typeof args[1] === 'string' && args[1].length < 65536 && args[1].startsWith('data:image/png;base64,') ? args[1] : null;
    const drawn = count && picture ? nativeImage.createFromDataURL(picture) : null;
    const image = drawn && !drawn.isEmpty() ? drawn : null;
    if (process.platform === 'win32') window?.setOverlayIcon(image, count ? `Непрочитанных: ${count}` : '');
    else app.setBadgeCount(count); // macOS dock; Linux launchers that support counters
    lastBadge = { count, image }; refreshTray();
    return;
  }
  // System notifications (see notifications/desktopNotify.ts): the page already decided whether to
  // show one and what it says, so this only bounds the strings and shows them. Nothing is logged.
  if (method === 'notifyShow') {
    const payload = notificationPayload(args[0]);
    if (!payload || !Notification.isSupported()) return false;
    notices.get(payload.tag)?.close();
    if (notices.size >= 20) { const oldest = notices.keys().next().value; notices.get(oldest)?.close(); notices.delete(oldest); }
    const notice = new Notification({ title: payload.title, body: payload.body, silent: payload.silent, timeoutType: payload.kind === 'call' ? 'never' : 'default', urgency: payload.kind === 'call' ? 'critical' : 'normal',
      // Buttons on a notification exist on macOS only (Electron); elsewhere the click answers from the call screen.
      ...(payload.answer && process.platform === 'darwin' ? { actions: [{ type: 'button', text: 'Ответить' }] } : {}) });
    const report = kind => { showWindow(); if (window && !window.isDestroyed()) window.webContents.send('invizent-notify', { kind, chatId: payload.chatId }); };
    notice.on('click', () => report('open'));
    notice.on('action', () => report(payload.answer ? 'answer' : 'open'));
    notice.on('close', () => { if (notices.get(payload.tag) === notice) notices.delete(payload.tag); });
    notices.set(payload.tag, notice);
    try { notice.show(); } catch { notices.delete(payload.tag); return false; }
    return true;
  }
  if (method === 'notifyClose') {
    if (typeof args[0] !== 'string') return;
    const notice = notices.get(args[0]); notices.delete(args[0]);
    try { notice?.close(); } catch { /* already gone */ }
    return;
  }
  if (method === 'overlayConfigure') {
    const p = args[0] || {};
    overlayPrefs = { enabled: p.enabled === true, inject: p.inject !== false, corner: ['topLeft','topRight','bottomLeft','bottomRight'].includes(p.corner) ? p.corner : 'topLeft', opacity: Math.min(1, Math.max(0.3, Number(p.opacity) || 0.9)) };
    if (!overlayPrefs.enabled) { overlayView = null; overlayWin?.destroy(); overlayWin = null; } else placeOverlay();
    refreshOverlay();
    return;
  }
  if (method === 'snowCap') { try { snowCap(args[0] === true); } catch { /* decorative */ } return; }
  if (method === 'overlayUpdate') {
    const v = args[0];
    overlayView = v && typeof v === 'object' && Array.isArray(v.people) ? { channel: String(v.channel || '').slice(0, 60), people: v.people.slice(0, 12).map(p => ({ name: String(p?.name || '').slice(0, 32), speaking: p?.speaking === true, muted: p?.muted === true, deafened: p?.deafened === true, me: p?.me === true })) } : null;
    refreshOverlay();
    return;
  }
  if (method === 'setHold') {
    // Рация / «молчать» while a game is in front: a system keyboard hook (uiohook) that runs only
    // while the person is in a voice channel or call AND has such a bind switched on. It compares
    // each key with those binds and nothing else — keys are never stored, logged or sent anywhere.
    const config = args[0] && typeof args[0] === 'object' ? args[0] : {};
    // The binds change when the person edits them in the settings — a few times, not in a stream. A page that kept
    // re-binding could otherwise learn which keys are pressed in other apps, one key at a time.
    const stamp = Date.now(); holdChanges = holdChanges.filter(at => stamp - at < 60_000);
    if (holdChanges.length >= 12) throw new Error('Too many bind changes');
    holdChanges.push(stamp);
    holdBinds = [];
    for (const action of ['ptt', 'pushToMute']) {
      const parsed = parseHold(config[action]);
      if (parsed) holdBinds.push({ action, ...parsed, down: false });
    }
    if (config.active === true && holdBinds.length) startHook(); else stopHook();
    return { hooked: hookRunning };
  }
  if (method === 'setShortcuts') {
    // Press binds that work while another app (a game) is in front. Hold binds (рация) need the
    // key release too, which globalShortcut cannot report, so they work inside Инвиз only.
    const binds = args[0] && typeof args[0] === 'object' ? args[0] : {}; const result = {};
    globalShortcut.unregisterAll();
    for (const [id, combo] of Object.entries(binds).slice(0, 50)) {
      if (!/^[a-z0-9]{1,16}$/.test(id)) continue;
      const accelerator = toAccelerator(combo);
      if (!accelerator) { result[id] = false; continue; }
      try { result[id] = globalShortcut.register(accelerator, () => window?.webContents.send('invizent-shortcut', id)); } catch { result[id] = false; }
    }
    return result;
  }
  if (method === 'cancelRequest') { requests.get(args[0])?.abort(); return; }
  if (method === 'request') {
    const [id, request] = args, url = new URL(request.url);
    if (url.protocol !== 'https:' || !TRUSTED_HOST.test(url.host) || url.username || url.password || typeof id !== 'string' || requests.has(id)) throw new Error('Invalid API request');
    if (request.body && (!(request.body instanceof ArrayBuffer) || request.body.byteLength > 32*1024*1024)) throw new Error('Request too large');
    const controller = new AbortController(); requests.set(id, controller);
    try {
      const headers = new Headers(request.headers); headers.delete('origin'); headers.delete('host');
      const response = await fetch(url, { method: request.method, headers, body: request.body ? new Uint8Array(request.body) : undefined, signal: controller.signal, redirect: 'error' });
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > 32*1024*1024) { controller.abort(); throw new Error('Response too large; use ranged download'); } chunks.push(chunk); }
      const body = Buffer.concat(chunks); return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: body.buffer.slice(body.byteOffset, body.byteOffset+body.byteLength) };
    } finally { requests.delete(id); }
  }
  if (method === 'signal') {
    const [name, parameters] = args, [{ desktopSignalBridge }] = await ready;
    if (!['createState','replenish','trustIdentity','encrypt','decrypt','seal','open'].includes(name) || !Array.isArray(parameters) || parameters.length > 7) throw new Error('Invalid Signal operation');
    if (parameters.some(v => typeof v === 'string' && v.length > 40 * 1024 * 1024)) throw new Error('Signal input too large');
    return desktopSignalBridge[name](...parameters);
  }
  if (method === 'vaultOpen') { const id = randomUUID(); vaults.set(id, await vault(args[0])); return id; }
  if (method === 'vaultGet' || method === 'vaultCommit' || method === 'vaultClose') {
    const [id, value] = args, store = vaults.get(id); if (!store) throw new Error('Vault closed');
    if (method === 'vaultGet') { if (typeof value !== 'string') throw new Error('Invalid key'); return store.get(value); }
    if (method === 'vaultCommit') { if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid commit'); return store.commit(value); }
    // Vault instances are shared across account services; a renderer handle closes independently.
    vaults.delete(id); return;
  }
  if (method === 'updateDownload') return update.download(args[0], args[1], args[2]);
  if (method === 'updateProgress') return update.progress();
  if (method === 'updateCancel') { update.cancel(); return; }
  if (method === 'updateInstall') {
    const file = await update.fileForLaunch();
    if (!file) throw new Error('No verified update to install');
    const problem = await shell.openPath(file);
    if (problem) throw new Error(problem);
    setTimeout(() => { quitting = true; app.quit(); }, 1500); // the installer replaces the running app
    return true;
  }
  if (method === 'tokenRead') return (await vault('invizent:desktop:session')).get('token');
  if (method === 'tokenWrite') { if (args[0] !== null && typeof args[0] !== 'string') throw new Error('Invalid token'); return (await vault('invizent:desktop:session')).commit({ token: args[0] }); }
  throw new Error('Unknown desktop operation');
});
app.whenReady().then(async () => {
  const dist = path.join(__dirname,'dist');
  cacheRoot=path.join(app.getPath('userData'),'media-cache'); await fs.mkdir(cacheRoot,{recursive:true});
  protocol.handle('invizent-cache',async request => { try {const response=await net.fetch(pathToFileURL(cachePath(request.url)).href,{headers:request.headers});const headers=new Headers(response.headers);headers.set('Access-Control-Allow-Origin','invizent://app');return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}catch{return new Response('',{status:404});} });
  protocol.handle('invizent', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('', { status: 403 });
    let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('', { status: 400 }); }
    const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist + path.sep)) return new Response('', { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(file).href);
      const headers=new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' invizent-cache: https: data: blob:; media-src 'self' invizent-cache: https: blob: data:; connect-src 'self' invizent-cache: https: wss: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'");
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    } catch { return new Response('', { status: 404 }); }
  });
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['wss://invizent.com/*','wss://*.invizent.com/*','wss://invizent.ru/*','wss://*.invizent.ru/*','wss://141-133-194-51.nip.io/*','wss://invizent-api.invizent-8165e2.workers.dev/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (details.webContentsId === window?.webContents.id) { delete headers.Origin; delete headers.origin; }
    callback({ requestHeaders: headers });
  });
  session.defaultSession.setPermissionCheckHandler((contents,permission,origin) => contents===window?.webContents && origin.replace(/\/$/,'')==='invizent://app' && ['display-capture','fullscreen','clipboard-sanitized-write','media'].includes(permission));
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== window?.webContents || !details.requestingUrl?.startsWith('invizent://app/')) return callback(false);
    if (['display-capture','fullscreen','clipboard-sanitized-write'].includes(permission)) return callback(true);
    // Microphone and camera for our own page only: no extra question from Инвиз (Windows' own
    // privacy settings still decide; the page asks only when the user starts a call or a recording).
    callback(permission === 'media');
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== window?.webContents.mainFrame || !request.securityOrigin.startsWith('invizent://app')) return callback(null);
    try {
      if(capture)return callback(null);
      const sources = await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:320,height:180}});
      capture={sources:new Map(sources.map(source=>[source.id,source])),callback};
      picker=new BrowserWindow({parent:window,modal:true,width:780,height:650,title:'Демонстрация экрана',webPreferences:{preload:path.join(__dirname,'capture-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
      picker.on('closed',()=>{if(capture){const done=capture.callback;capture=null;done(null);}picker=null;});
      picker.removeMenu();picker.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      picker.webContents.on('will-navigate',event=>event.preventDefault());
      await picker.loadURL('invizent://app/capture.html');
    } catch { callback(null); }
  }, { useSystemPicker: process.platform === 'darwin' });
  // Own title bar in the app's colours (macOS style): frameless on Windows/Linux with our traffic
  // lights drawn by the page; on macOS the native lights stay, inset into the page.
  window = new BrowserWindow({ width: 1280, height: 850, minWidth: 850, minHeight: 600, title: 'Инвиз', backgroundColor: '#0B0F17',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 9 } } : { frame: false, thickFrame: true }),
    webPreferences: { preload: path.join(__dirname,'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  // No File/Edit/View/Window bar on Windows and Linux (copy, paste and undo still work in text fields).
  if (process.platform !== 'darwin') window.removeMenu();
  window.on('close', event => {
    if (quitting || !tray) return;
    event.preventDefault(); window.hide(); refreshOverlay();
    if (!trayHintShown && process.platform === 'win32') { trayHintShown = true; try { tray.displayBalloon({ title: 'Инвиз работает в фоне', content: 'Окно свёрнуто в трей. Чтобы выйти, нажми правой кнопкой на значок → «Выйти».', iconType: 'info' }); } catch { /* balloons can be off */ } }
  });
  void setupTray();
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('invizent://app/')) event.preventDefault(); });
  window.on('focus', () => refreshOverlay()); window.on('blur', () => refreshOverlay()); window.on('minimize', () => refreshOverlay());
  window.on('closed', () => { clearInterval(snowTimer); snowTimer = null; if (snowWin && !snowWin.isDestroyed()) snowWin.destroy(); snowWin = null; overlayWin?.destroy(); overlayWin = null; gameOverlay?.stop(); if (gameOverlayWin && !gameOverlayWin.isDestroyed()) gameOverlayWin.destroy(); gameOverlayWin = null; });
  const sendState = () => { if (!window || window.isDestroyed()) return; window.webContents.send('window-state', { maximized: window.isMaximized(), fullscreen: window.isFullScreen(), focused: window.isFocused() }); };
  for (const name of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) window.on(name, sendState);
  for (const name of ['move', 'resize', 'show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) window.on(name, () => { try { placeSnowCap(); } catch { /* decorative */ } });
  window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) void shell.openExternal(url); return { action: 'deny' }; });
  await window.loadURL('invizent://app/index.html');
});
app.on('window-all-closed', () => app.quit());

// Closing the window keeps Инвиз running in the tray (messages and calls still arrive), as in
// Telegram / Discord on Windows. «Выйти» in the tray menu (or the updater) really quits.
let tray = null, quitting = false, trayHintShown = false, trayIcon = null, lastBadge = { count: 0, image: null };
const notices = new Map();
// Tray: the tooltip carries the count (the only badge Linux trays have); on Windows/Linux the counter is
// drawn over the app icon while something is unread, like Telegram Desktop's tray counter (notify.cjs).
const refreshTray = () => applyTrayBadge({ tray, icon: trayIcon, badge: lastBadge, nativeImage });
app.on('before-quit', () => { quitting = true; gameOverlay?.stop(); });
function showWindow() { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
async function setupTray() {
  if (tray || process.platform === 'darwin') return;
  try {
    let icon = await app.getFileIcon(process.execPath, { size: 'small' }).catch(() => null);
    if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();
    tray = new Tray(icon); trayIcon = icon;
    refreshTray();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть Инвиз', click: showWindow },
      { type: 'separator' },
      { label: 'Выйти', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow); tray.on('double-click', showWindow);
  } catch { tray = null; }
}


}
