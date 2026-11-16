// Private, human-operated Yandex sign-in on a separately authorized EMPTY stand.
// This helper neither provisions a display nor exposes a browser/debugging port.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { accessSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const START_URL = 'https://telemost.yandex.ru/';
const MAX_SESSION_MS = 15 * 60_000;
const MAX_CDP_BYTES = 1_048_576;
const MAX_PENDING = 16;
const PROTECTED_IPS = new Set(['194.87.254.249', '141.133.194.51']);
const COOKIE_DOMAINS = ['yandex.ru', 'yandex.net', 'ya.ru'];
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

export class BrowserSessionError extends Error {
  constructor(code = 'browser_session_failed') {
    super(code);
    this.name = 'BrowserSessionError';
    this.code = code;
  }
}
const failure = code => new BrowserSessionError(code);

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(failure('session_cancelled'));
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(failure('session_cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, () => {
      cleanup(); reject(failure('browser_session_failed'));
    });
  });
}

function pause(ms, signal) {
  if (signal?.aborted) return Promise.reject(failure('session_cancelled'));
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(failure('session_cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Chrome CDP uses anonymous pipes, not a TCP debugging listener. No raw error is logged. */
export class CDPBrowser {
  #child; #input; #output; #pending = new Map(); #buffer = Buffer.alloc(0); #serial = 0;
  #closed = false; #exited = false; #exitPromise; #resolveExit;

  constructor(child) {
    this.#child = child;
    this.#input = child?.stdio?.[3];
    const output = child?.stdio?.[4];
    this.#output = output;
    if (!this.#input?.write || !output?.on) throw failure('browser_pipe_unavailable');
    this.#exitPromise = new Promise(resolve => { this.#resolveExit = resolve; });
    output.on('data', chunk => this.#receive(chunk));
    output.on('end', () => this.#fail());
    output.on('error', () => this.#fail());
    this.#input.on?.('error', () => this.#fail());
    child.on('error', () => { this.#exited = true; this.#resolveExit(); this.#fail(); });
    child.on('exit', () => { this.#exited = true; this.#resolveExit(); this.#fail(); });
  }

  #fail(code = 'browser_closed') {
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(failure(code)); }
    this.#pending.clear();
    this.#buffer = Buffer.alloc(0);
  }

  #receive(chunk) {
    if (this.#closed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length + this.#buffer.length > MAX_CDP_BYTES) { this.#fail('browser_protocol_failed'); return; }
    this.#buffer = Buffer.concat([this.#buffer, incoming]);
    let end;
    while ((end = this.#buffer.indexOf(0)) >= 0) {
      const raw = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      if (!raw.length) continue;
      let reply;
      try { reply = JSON.parse(raw.toString('utf8')); } catch { this.#fail('browser_protocol_failed'); return; }
      if (!reply || typeof reply !== 'object' || !Number.isSafeInteger(reply.id)) continue;
      const pending = this.#pending.get(reply.id);
      if (!pending) continue;
      this.#pending.delete(reply.id); clearTimeout(pending.timer);
      if (reply.error) pending.reject(failure('browser_command_failed'));
      else pending.resolve(reply.result ?? {});
    }
  }

  request(method, params = {}, { timeoutMs = 5000 } = {}) {
    if (this.#closed || this.#pending.size >= MAX_PENDING || typeof method !== 'string' || /^[A-Za-z]+\.[A-Za-z]+$/.exec(method)?.[0] !== method ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return Promise.reject(failure('browser_command_failed'));
    const id = ++this.#serial;
    let message;
    try { message = Buffer.from(JSON.stringify({ id, method, params }) + '\0'); }
    catch { return Promise.reject(failure('browser_command_failed')); }
    if (message.length > 65_536) return Promise.reject(failure('browser_command_failed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(failure('browser_command_timeout')); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#input.write(message); }
      catch { this.#fail('browser_pipe_unavailable'); }
    });
  }

  async stop() {
    const waitForExit = async ms => {
      if (this.#exited) return;
      let timer;
      try { await Promise.race([this.#exitPromise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      if (!this.#exited && !this.#closed) {
        try { await this.request('Browser.close', {}, { timeoutMs: 1000 }); } catch { /* sanitized shutdown */ }
        // Browser.close can acknowledge before Chrome flushes its private profile.
        await waitForExit(1000);
      }
      this.#fail();
      if (!this.#exited) {
        try { this.#child.kill('SIGTERM'); } catch { /* already exited */ }
        await waitForExit(1000);
      }
      if (!this.#exited) {
        try { this.#child.kill('SIGKILL'); } catch { /* already exited */ }
        await waitForExit(500);
      }
    } finally {
      this.#fail();
      this.#input.destroy?.();
      this.#output.destroy?.();
    }
  }
}

function allowedDomain(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()) return false;
  const domain = value.startsWith('.') ? value.slice(1) : value;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.exec(domain)?.[0] !== domain) return false;
  return COOKIE_DOMAINS.some(base => domain === base || domain.endsWith('.' + base));
}

function validPair(cookie) {
  return cookie && typeof cookie.name === 'string' && TOKEN.exec(cookie.name)?.[0] === cookie.name &&
    typeof cookie.value === 'string' && cookie.value.length <= 8192 && !/[\x00-\x20\x7f;]/.test(cookie.value);
}

/** Only this private projection leaves CDP memory. Missing/expired sessions keep polling. */
export function selectYandexCookies(cookies, now = Date.now()) {
  if (!Array.isArray(cookies) || cookies.length > 2000 || !Number.isFinite(now)) throw failure('browser_cookies_invalid');
  const selected = [];
  let session = false, bytes = 0;
  for (const cookie of cookies) {
    if (!cookie || !allowedDomain(cookie.domain) || !validPair(cookie) ||
        typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires) ||
        cookie.expires !== -1 && cookie.expires <= now / 1000) continue;
    if (cookie.name === 'Session_id') {
      if (!cookie.value || cookie.secure !== true || cookie.httpOnly !== true) continue;
      session = true;
    }
    bytes += Buffer.byteLength(cookie.name) + Buffer.byteLength(cookie.value);
    if (bytes > 512 * 1024) throw failure('browser_cookies_invalid');
    selected.push({ name: cookie.name, value: cookie.value });
  }
  return session ? selected : null;
}

function noRepository(path) {
  let current = path;
  for (;;) {
    if (existsSync(join(current, '.git'))) throw failure('private_path_required');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function newPrivateDirectory(path, uid) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || existsSync(path)) throw failure('new_private_path_required');
  const parent = realpathSync(dirname(path));
  noRepository(parent);
  const metadata = statSync(parent);
  if ((metadata.uid !== uid && metadata.uid !== 0) ||
      (metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0) throw failure('private_path_required');
  const target = join(parent, basename(path));
  mkdirSync(target, { mode: 0o700 });
  const created = lstatSync(target);
  if (!created.isDirectory() || created.uid !== uid || (created.mode & 0o077) !== 0) throw failure('private_path_required');
  return target;
}

/** Exclusive hard-link publication never overwrites an existing cookie file or symlink. */
export function writeSessionFile(output, cookies, uid = process.getuid?.()) {
  if (typeof output !== 'string' || !isAbsolute(output) || resolve(output) !== output) throw failure('private_path_required');
  const parent = realpathSync(dirname(output));
  noRepository(parent);
  const metadata = lstatSync(parent);
  if (!metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) throw failure('private_path_required');
  const target = join(parent, basename(output));
  let temporary, descriptor;
  try {
    if (!Array.isArray(cookies) || !cookies.length || cookies.length > 2000 ||
        cookies.some(cookie => !validPair(cookie) || Object.keys(cookie).length !== 2 ||
          !Object.hasOwn(cookie, 'name') || !Object.hasOwn(cookie, 'value')) ||
        !cookies.some(cookie => cookie.name === 'Session_id' && cookie.value)) throw failure('private_session_write_failed');
    const contents = JSON.stringify(cookies) + '\n';
    if (Buffer.byteLength(contents) > MAX_CDP_BYTES) throw failure('private_session_write_failed');
    temporary = join(parent, '.session-' + randomBytes(16).toString('hex'));
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, contents); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    linkSync(temporary, target);
  } catch { throw failure('private_session_write_failed'); }
  finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* no raw diagnostics */ }
    if (temporary) try { unlinkSync(temporary); } catch { /* no unrelated file is removed */ }
  }
}

/** Useful separately in the isolated Chrome fixture; it does not navigate or authorize an account. */
export async function collectSession(cdp, { output, signal, now = Date.now, pollMs = 1000 } = {}) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5000) throw failure('browser_parameters_invalid');
  const lifetime = new AbortController(), cancel = () => lifetime.abort();
  const timer = setTimeout(cancel, MAX_SESSION_MS);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      if (lifetime.signal.aborted) throw failure('session_cancelled');
      const reply = await abortable(cdp.request('Storage.getCookies'), lifetime.signal);
      const selected = selectYandexCookies(reply.cookies, now());
      if (selected) { writeSessionFile(output, selected); return; }
      await pause(pollMs, lifetime.signal);
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
  }
}

function normalizedIP(value) {
  if (typeof value !== 'string') return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  try {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped) return canonical;
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
  } catch { return null; }
}

export async function assertNotProductionHost({ interfaces = networkInterfaces, resolveAPI = () => lookup('api.invizent.com', { all: true }) } = {}) {
  let local;
  try {
    const inventory = interfaces();
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) ||
        Object.values(inventory).some(rows => !Array.isArray(rows))) throw failure('host_check_failed');
    const entries = Object.values(inventory).flat();
    const addresses = entries.map(row => normalizedIP(row?.address));
    if (!addresses.length || addresses.some(address => !address) ||
        !addresses.some((address, index) => entries[index].internal !== true && address !== '::1' && address !== '::' && address !== '0.0.0.0' && !address.startsWith('127.'))) throw failure('host_check_failed');
    local = new Set(addresses);
  } catch { throw failure('host_check_failed'); }
  if ([...PROTECTED_IPS].some(address => local.has(address))) throw failure('production_host_refused');
  let timer, rows;
  try {
    rows = await Promise.race([resolveAPI(), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('host_check_failed')), 8000); })]);
  } catch { throw failure('host_check_failed'); }
  finally { clearTimeout(timer); }
  if (!Array.isArray(rows) || !rows.length || rows.length > 32 || rows.some(row => !normalizedIP(row?.address))) throw failure('host_check_failed');
  if (rows.some(row => local.has(normalizedIP(row.address)))) throw failure('production_host_refused');
}

/** CLI always uses a visible local display and the official fixed Telemost origin. */
export async function runBrowserSession({ chrome, profile, output, signal } = {}, {
  getuid = () => process.getuid?.(), hostCheck = assertNotProductionHost, spawnProcess = nodeSpawn,
  environment = process.env,
} = {}) {
  const uid = getuid();
  if (!Number.isInteger(uid) || uid <= 0) throw failure('unprivileged_user_required');
  try {
    if (typeof chrome !== 'string' || !isAbsolute(chrome)) throw failure('browser_parameters_invalid');
    const executable = realpathSync(chrome), executableInfo = statSync(executable);
    if (!executableInfo.isFile() || executableInfo.uid !== 0 || (executableInfo.mode & 0o022) !== 0) throw failure('trusted_browser_required');
    accessSync(executable, constants.X_OK);
    if (typeof environment.DISPLAY !== 'string' || /^:[0-9]{1,3}(?:\.[0-9]{1,2})?$/.exec(environment.DISPLAY)?.[0] !== environment.DISPLAY || !isAbsolute(environment.XAUTHORITY ?? '')) throw failure('authenticated_local_display_required');
    const xauth = lstatSync(environment.XAUTHORITY);
    if (!xauth.isFile() || xauth.uid !== uid || (xauth.mode & 0o077) !== 0) throw failure('authenticated_local_display_required');
    if (typeof output !== 'string' || !isAbsolute(output) || resolve(output) !== output) throw failure('new_private_path_required');
    if (typeof profile !== 'string' || !isAbsolute(profile) || resolve(profile) !== profile ||
        profile === dirname(output) || profile.startsWith(dirname(output) + '/') || dirname(output).startsWith(profile + '/')) throw failure('new_private_path_required');
    await hostCheck();
    if (signal?.aborted) throw failure('session_cancelled');
    const privateProfile = newPrivateDirectory(profile, uid);
    newPrivateDirectory(dirname(output), uid);
    const env = {};
    for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'])
      if (typeof environment[key] === 'string') env[key] = environment[key];
    let child, cdp;
    const deadline = new AbortController();
    const cancel = () => deadline.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, MAX_SESSION_MS);
    try {
      child = spawnProcess(executable, [
        '--user-data-dir=' + privateProfile, '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--no-startup-window', '--remote-debugging-pipe',
      ], { shell: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env });
      cdp = new CDPBrowser(child);
      await abortable(cdp.request('Target.createTarget', { url: START_URL }), deadline.signal);
      await collectSession(cdp, { output, signal: deadline.signal });
      return { saved: true };
    } catch { throw failure(deadline.signal.aborted ? 'session_cancelled' : 'browser_session_failed'); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (cdp) await cdp.stop();
      else if (child) try { child.kill('SIGTERM'); } catch { /* process already exited */ }
    }
  } catch (error) {
    if (error instanceof BrowserSessionError) throw error;
    throw failure('browser_session_failed');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node browser-session.mjs --chrome /absolute/chrome --profile /absolute/NEW/profile --output /absolute/NEW/private-directory/cookies-yandex.json');
    return;
  }
  if (args.length !== 6 || args[0] !== '--chrome' || args[2] !== '--profile' || args[4] !== '--output') throw failure('browser_parameters_invalid');
  const abort = new AbortController(), cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    await runBrowserSession({ chrome: args[1], profile: args[3], output: args[5], signal: abort.signal });
    console.log('Private browser session saved. No account credentials were printed.');
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Private browser session unavailable. Check the authorized stand and local display.'); process.exitCode = 1; });
}
