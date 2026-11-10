// In-game overlay inside fullscreen games (Windows only; Настройки → Оверлей → «Показывать в
// полноэкранных играх»). Discord / Steam style: a helper (native/overlay, built in CI) loads our
// overlay DLL into the fullscreen game, which draws the voice overlay on the game's own frames —
// so it is visible in exclusive fullscreen too. Exclusive and borderless fullscreen are treated
// the same. Nothing here tries to get past anti-cheat or antivirus: if the game, Windows or an
// anti-cheat refuses, we log it once and keep the ordinary window overlay.
//
// Pieces (pure parts exported for tests):
//   encodeFrame()      64-byte header + BGRA pixels, the stdin protocol of `injector --host`
//                      (layout = native/overlay/src/shared.h FrameHeader)
//   parseHostLine()    validates the helper's JSON lines
//   injectDecision()   whether the foreground window's process is a game we may inject into
//   createGameOverlay  the controller main.cjs drives: runs the helper while the option is on,
//                      injects once per game process, feeds it frames, and says whether the game
//                      is drawing the overlay (then the window overlay hides, never both at once).
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');

const MAGIC = 0x4f564e49; // "INVO"
const VERSION = 1;
const HEADER_SIZE = 64;
const MAX_WIDTH = 400;
const MAX_HEIGHT = 600;
const MARGIN = 16;
const CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
const STABLE_MS = 2000;     // the game must stay fullscreen in front this long before we inject
const DRAWING_MS = 2500;    // "drawing" older than this counts as not drawing
const MAX_HOST_FAILURES = 3; // per app run: a crashing helper is not restarted in a loop
const ALREADY_LOADED_RETRY_MS = 5000;

// Never injected into, whatever their window looks like: Windows itself, Инвиз/Electron, and
// programs that are not games or have their own overlay policies (browsers, players, launchers).
const EXCLUDED = new Set([
  'explorer.exe', 'dwm.exe', 'csrss.exe', 'winlogon.exe', 'logonui.exe', 'lockapp.exe', 'consent.exe',
  'searchhost.exe', 'searchapp.exe', 'searchui.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe',
  'applicationframehost.exe', 'textinputhost.exe', 'systemsettings.exe', 'taskmgr.exe', 'svchost.exe',
  'sihost.exe', 'ctfmon.exe', 'smartscreen.exe', 'magnify.exe', 'snippingtool.exe', 'screenclippinghost.exe',
  'invizent.exe', 'инвиз.exe', 'electron.exe',
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'brave.exe', 'browser.exe', 'vivaldi.exe', 'yandex.exe',
  'vlc.exe', 'mpc-hc64.exe', 'mpc-be64.exe', 'potplayermini64.exe', 'wmplayer.exe', 'video.ui.exe', 'microsoft.media.player.exe',
  'discord.exe', 'steam.exe', 'steamwebhelper.exe', 'obs64.exe', 'mstsc.exe', 'vmware.exe', 'virtualboxvm.exe',
]);

// What the helper's --inject exit codes mean (InjectCode in native/overlay/src/injector.cpp).
const INJECT_CODES = {
  0: 'ok', 1: 'usage', 2: 'bad-pid', 3: 'dll-missing', 4: '32-bit game', 5: 'game runs as administrator',
  6: 'access denied (protected process or anti-cheat)', 7: 'open failed', 8: 'memory write refused',
  9: 'remote thread refused', 10: 'timeout', 11: 'load refused or failed', 12: 'already loaded',
};

/** 64-byte header + pixels. `pixels`: BGRA premultiplied, exactly width*height*4 bytes. */
function encodeFrame({ width = 0, height = 0, corner = 'topLeft', opacity = 1, visible = false, margin = MARGIN, frame = 0, pixels = null }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 || width > MAX_WIDTH || height > MAX_HEIGHT) throw new RangeError('Overlay frame size out of range');
  const bytes = width * height * 4;
  if (bytes && (!pixels || pixels.length !== bytes)) throw new RangeError('Overlay pixels do not match the size');
  const out = Buffer.alloc(HEADER_SIZE + bytes);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(VERSION, 4);
  out.writeUInt32LE(width, 8);
  out.writeUInt32LE(height, 12);
  out.writeUInt32LE(width * 4, 16);
  out.writeUInt32LE(frame >>> 0, 20);
  out.writeUInt32LE(Math.max(0, CORNERS.indexOf(corner)), 24);
  out.writeUInt32LE(Math.round(Math.min(1, Math.max(0, Number(opacity) || 0)) * 255), 28);
  out.writeUInt32LE(visible ? 1 : 0, 32);
  out.writeUInt32LE(Math.min(200, Math.max(0, margin | 0)), 36);
  // 40..63: consumer pid/tick (written by the DLL, not by us) and reserved — left zero.
  if (bytes) Buffer.from(pixels.buffer, pixels.byteOffset, bytes).copy(out, HEADER_SIZE);
  return out;
}

/** Largest size within the cap with the same aspect ratio (Hi-DPI screens paint bigger). */
function fitSize(width, height) {
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

const tri = v => v === true || v === false || v === null;
/** A helper stdout line → a checked object, or null for anything unexpected. */
function parseHostLine(line) {
  if (typeof line !== 'string' || line.length > 4096) return null;
  let v;
  try { v = JSON.parse(line); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const pid = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
  if (v.type === 'fg') {
    if (!pid(v.pid) || typeof v.fullscreen !== 'boolean' || typeof v.exclusive !== 'boolean' || typeof v.drawing !== 'boolean' || !tri(v.wow64) || !tri(v.elevated) || typeof v.path !== 'string' || v.path.length > 1024) return null;
    return { type: 'fg', pid: v.pid, path: v.path, fullscreen: v.fullscreen, exclusive: v.exclusive, wow64: v.wow64, elevated: v.elevated, drawing: v.drawing };
  }
  if (v.type === 'inject' && pid(v.pid) && Number.isInteger(v.code)) return { type: 'inject', pid: v.pid, code: v.code, win32: Number.isInteger(v.win32) ? v.win32 : 0 };
  if (v.type === 'ready' || v.type === 'version') return { type: v.type };
  if (v.type === 'error' && typeof v.code === 'string') return { type: 'error', code: v.code.slice(0, 40) };
  return null;
}

const attemptKey = fg => `${fg.pid}:${fg.path.toLowerCase()}`;

/**
 * Whether to inject into the foreground process now. ctx: { inVoice, ownPids:Set, ownExe,
 * systemRoot, stableMs, attempts:Map, now }. Returns { inject, reason }.
 */
function injectDecision(fg, ctx) {
  const no = reason => ({ inject: false, reason });
  if (!ctx.inVoice) return no('not-in-voice');
  if (!fg || !fg.pid) return no('no-window');
  if (!fg.fullscreen) return no('not-fullscreen');
  if (ctx.ownPids?.has(fg.pid)) return no('own-process');
  if (!fg.path) return no('unknown-process');
  if (fg.wow64 !== false) return no('32-bit-or-unknown');
  if (fg.elevated !== false) return no('elevated-or-unknown');
  const exe = path.win32.basename(fg.path).toLowerCase();
  if (EXCLUDED.has(exe) || (ctx.ownExe && exe === String(ctx.ownExe).toLowerCase())) return no('excluded');
  const root = String(ctx.systemRoot || 'C:\\Windows').toLowerCase().replace(/\\+$/, '');
  if (fg.path.toLowerCase().startsWith(root + '\\')) return no('system');
  const tried = ctx.attempts?.get(attemptKey(fg));
  if (tried) {
    // One retry only for "already loaded" (a previous session's copy that was unloading).
    const retry = tried.code === 12 && !tried.retried && ctx.now - tried.at >= ALREADY_LOADED_RETRY_MS;
    if (!retry) return no('already-tried');
  }
  if ((ctx.stableMs || 0) < STABLE_MS) return no('settling');
  return { inject: true, reason: tried ? 'retry' : 'fullscreen-game' };
}

/**
 * deps: { binDir, spawn, log, now, ownPids():Set, ownExe, systemRoot, onDrawingChange() }.
 * main.cjs calls update() on any change, frame() from the offscreen renderer, stop() on quit.
 */
function createGameOverlay(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const exe = path.join(deps.binDir, 'invizent-overlay-injector.exe');
  const dll = path.join(deps.binDir, 'invizent-overlay-hook.dll');
  const exists = deps.exists || (p => fs.existsSync(p));
  let state = { enabled: false, inject: false, corner: 'topLeft', opacity: 0.9, inVoice: false, appFocused: true };
  let host = null, hostFailures = 0, missingLogged = false, buffered = false, pending = null;
  let lastFg = null, fgSince = 0, stablePid = 0, drawing = false, frameNo = 0;
  let picture = null; // { width, height, pixels }
  let lastSent = null;
  const attempts = new Map();
  const injecting = new Set();

  const available = () => {
    if (exists(exe) && exists(dll)) return true;
    if (!missingLogged) { missingLogged = true; log('[overlay] in-game overlay files are missing; window overlay only'); }
    return false;
  };
  const hostWanted = () => state.enabled && state.inject && hostFailures < MAX_HOST_FAILURES && available();

  function startHost() {
    if (host) return;
    const suffix = randomBytes(8).toString('hex');
    let child;
    try { child = deps.spawn(exe, ['--host', suffix], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { hostFailures++; log('[overlay] helper did not start: ' + e.message); return; }
    host = child; buffered = false; pending = null; lastSent = null;
    let rest = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => {
      rest += chunk;
      if (rest.length > 65536) rest = rest.slice(-4096);
      let i;
      while ((i = rest.indexOf('\n')) >= 0) { const line = rest.slice(0, i).trim(); rest = rest.slice(i + 1); if (line) onLine(child, line); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.on('drain', () => { if (host !== child) return; buffered = false; if (pending) { const p = pending; pending = null; write(p); } });
    child.on('error', e => log('[overlay] helper error: ' + e.message));
    child.on('exit', code => {
      if (host !== child) return;
      host = null; lastFg = null; hostFailures++; // stopHost() clears `host` first, so this is unexpected
      log(`[overlay] helper exited unexpectedly (${code})`);
      setDrawing(false);
    });
    sendState(true);
  }

  function stopHost() {
    if (!host) return;
    const child = host; host = null; lastFg = null;
    try { child.stdin?.end(); } catch { /* gone */ }
    setTimeout(() => { try { if (child.exitCode === null) child.kill(); } catch { /* gone */ } }, 3000).unref?.();
    setDrawing(false);
  }

  function setDrawing(v) {
    if (drawing === v) return;
    drawing = v;
    deps.onDrawingChange?.(v);
  }

  function onLine(child, line) {
    if (child !== host) return;
    const msg = parseHostLine(line);
    if (!msg) return;
    if (msg.type === 'error') { log('[overlay] helper: ' + msg.code); return; }
    if (msg.type !== 'fg') return;
    const t = now();
    if (!msg.fullscreen || msg.pid !== stablePid) { stablePid = msg.fullscreen ? msg.pid : 0; fgSince = t; }
    lastFg = { ...msg, at: t };
    setDrawing(msg.drawing);
    const decision = injectDecision(msg, { inVoice: state.inVoice, ownPids: deps.ownPids?.(), ownExe: deps.ownExe, systemRoot: deps.systemRoot, stableMs: t - fgSince, attempts, now: t });
    if (decision.inject && !injecting.has(msg.pid)) inject(msg);
  }

  function inject(fg) {
    const key = attemptKey(fg);
    const before = attempts.get(key);
    injecting.add(fg.pid);
    attempts.set(key, { code: -1, at: now(), retried: !!before });
    log(`[overlay] loading the in-game overlay into ${path.win32.basename(fg.path)} (pid ${fg.pid}${fg.exclusive ? ', exclusive fullscreen' : ''})`);
    let child;
    try { child = deps.spawn(exe, ['--inject', String(fg.pid)], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); } catch (e) { injecting.delete(fg.pid); log('[overlay] injector did not start: ' + e.message); return; }
    const done = code => {
      if (!injecting.delete(fg.pid)) return;
      attempts.set(key, { code, at: now(), retried: !!before });
      if (code === 0) log(`[overlay] in-game overlay loaded into pid ${fg.pid}`);
      else log(`[overlay] in-game overlay not loaded into pid ${fg.pid}: ${INJECT_CODES[code] || 'code ' + code}; keeping the window overlay`);
    };
    child.on('exit', code => done(code ?? -1));
    child.on('error', () => done(-1));
  }

  function write(buf) {
    if (!host?.stdin || host.stdin.destroyed) return;
    if (buffered) { pending = buf; return; } // only the newest picture matters
    try { buffered = !host.stdin.write(buf); } catch { /* helper gone */ }
  }

  // Header + the current picture, whenever the picture or the settings change.
  function sendState(force = false) {
    if (!host) return;
    const visible = state.inVoice && !state.appFocused && !!picture;
    const key = `${visible}|${state.corner}|${state.opacity}`;
    if (!force && lastSent && lastSent.key === key && lastSent.picture === picture) return;
    lastSent = { key, picture };
    const p = visible ? picture : null;
    write(encodeFrame({ width: p ? p.width : 0, height: p ? p.height : 0, pixels: p ? p.pixels : null, corner: state.corner, opacity: state.opacity, visible, frame: ++frameNo }));
  }

  return {
    /** Any change of prefs, voice channel or Инвиз window focus. */
    update(next) {
      state = { ...state, ...next };
      if (!state.inVoice) picture = null;
      if (hostWanted()) startHost(); else stopHost();
      sendState();
    },
    /** A painted overlay picture from the offscreen renderer (BGRA, already within the cap). */
    frame({ width, height, pixels }) {
      if (!host || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_WIDTH || height > MAX_HEIGHT || pixels?.length !== width * height * 4) return;
      if (picture && picture.width === width && picture.height === height && Buffer.compare(picture.pixels, pixels) === 0) return;
      picture = { width, height, pixels: Buffer.from(pixels) };
      sendState();
    },
    /** The offscreen renderer runs only while the helper runs and you are in a voice channel. */
    rendererWanted: () => !!host && state.inVoice,
    /** True while the foreground game reports drawing our overlay (then the window overlay hides). */
    drawingInGame: () => !!(host && lastFg && lastFg.drawing && now() - lastFg.at < DRAWING_MS),
    running: () => !!host,
    stop() { stopHost(); },
  };
}

module.exports = { encodeFrame, fitSize, parseHostLine, injectDecision, createGameOverlay, MAGIC, VERSION, HEADER_SIZE, MAX_WIDTH, MAX_HEIGHT, EXCLUDED, INJECT_CODES, STABLE_MS };
