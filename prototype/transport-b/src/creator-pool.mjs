/**
 * Experimental one-creator-per-device allocator for the upstream WB Stream headless creator.
 * NO HTTP ROUTES ARE REGISTERED. This is not enabled by production INVIZENT.
 *
 * Upstream reference: https://github.com/kulikov0/whitelist-bypass
 * The creator is a general-purpose egress tunnel: it MUST run in a restricted sandbox
 * with egress limited to an owned, authenticated INVIZENT service. The upstream proxy
 * argument alone is not a security boundary; enforce network policy outside this code.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const ROOM_RE = /^\s*join_link:\s*(wbstream:\/\/[A-Za-z0-9_-]{6,160})\s*$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,96}$/;
const LOOPBACK_PROXY_RE = /^127\.0\.0\.1:(?:[1-9][0-9]{0,4})$/;
const MIN_STARTUP_MS = 5;

export function validateCreatorConfig(config) {
  if (!config || typeof config !== 'object') throw new TypeError('configuration is required');
  if (typeof config.binary !== 'string' || !isAbsolute(config.binary)) throw new TypeError('binary must be an absolute path');
  if (typeof config.cookiesFile !== 'string' || !isAbsolute(config.cookiesFile)) throw new TypeError('cookiesFile must be an absolute path');
  if (typeof config.egressSocks !== 'string' || !LOOPBACK_PROXY_RE.test(config.egressSocks) || Number(config.egressSocks.split(':')[1]) > 65535)
    throw new TypeError('egressSocks must be a loopback proxy (127.0.0.1:port)');
  const max = config.maxSessions ?? 2;
  if (!Number.isSafeInteger(max) || max < 1 || max > 128) throw new RangeError('invalid maxSessions');
  const startupMs = config.startupMs ?? 45_000;
  if (!Number.isSafeInteger(startupMs) || startupMs < MIN_STARTUP_MS || startupMs > 300_000) throw new RangeError('invalid startupMs');
  const leaseMs = config.leaseMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 10 || leaseMs > 24 * 60 * 60_000) throw new RangeError('invalid leaseMs');
  return { max, startupMs, leaseMs };
}

export class CreatorPool {
  #config;
  #spawn;
  #clock;
  #entries = new Map();
  #closed = false;

  constructor(config, { spawnProcess = nodeSpawn, now = Date.now } = {}) {
    this.#config = { ...config, ...validateCreatorConfig(config) };
    this.#spawn = spawnProcess;
    this.#clock = now;
  }

  /** Device IDs are opaque; never accept arbitrary shell arguments or account tokens here. */
  acquire(deviceId) {
    if (this.#closed) return Promise.reject(new Error('pool closed'));
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return Promise.reject(new TypeError('invalid device ID'));
    const existing = this.#entries.get(deviceId);
    if (existing) return existing.promise;
    if (this.#entries.size >= this.#config.max) return Promise.reject(new Error('creator capacity exceeded'));

    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const entry = { promise, reject, child: null, timer: null, resolved: false, done: false, text: '' };
    this.#entries.set(deviceId, entry);

    const finish = (reason, terminate) => {
      if (entry.done) return;
      entry.done = true;
      if (entry.timer) clearTimeout(entry.timer);
      if (this.#entries.get(deviceId) === entry) this.#entries.delete(deviceId);
      if (!entry.resolved) reject(new Error(reason));
      if (terminate) try { entry.child?.kill('SIGTERM'); } catch { /* already exited */ }
    };

    try {
      const args = ['--cookies', this.#config.cookiesFile, '--resources', 'moderate',
        '--upstream-socks', this.#config.egressSocks, '--name', 'INVIZENT relay'];
      const env = {};
      // Do not propagate DB credentials or other application secrets to a child executable.
      for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'SSL_CERT_FILE'])
        if (typeof process.env[key] === 'string') env[key] = process.env[key];
      const child = this.#spawn(this.#config.binary, args, {
        shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env,
      });
      entry.child = child;
      entry.timer = setTimeout(() => finish('creator startup timeout', true), this.#config.startupMs);
      entry.timer.unref?.();

      child.stdout?.on('data', chunk => {
        if (entry.done || entry.resolved) return;
        // Bounded parser, no logging. A join link is a bearer secret.
        entry.text = (entry.text + String(chunk)).slice(-4096);
        let newline;
        while ((newline = entry.text.indexOf('\n')) >= 0) {
          const line = entry.text.slice(0, newline);
          entry.text = entry.text.slice(newline + 1);
          const link = ROOM_RE.exec(line)?.[1];
          if (!link) continue;
          entry.resolved = true;
          if (entry.timer) clearTimeout(entry.timer);
          const expiresAt = this.#clock() + this.#config.leaseMs;
          entry.timer = setTimeout(() => finish('creator lease expired', true), this.#config.leaseMs);
          entry.timer.unref?.();
          resolve({ joinLink: link, expiresAt });
          return;
        }
      });
      // Upstream logs can contain URLs and tokens. Never print/copy them to application logs.
      child.stderr?.on('data', () => {});
      child.on('error', () => finish('creator process failed', true));
      child.on('exit', () => finish('creator process exited', false));
    } catch {
      finish('creator launch failed', true);
    }
    return promise;
  }

  release(deviceId) {
    const entry = this.#entries.get(deviceId);
    if (!entry || entry.done) return false;
    entry.done = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.#entries.delete(deviceId);
    if (!entry.resolved) {
      // The outstanding caller must be notified that no session was created.
      // This is deliberately a generic message: never include subprocess stderr.
      entry.reject?.(new Error('creator stopped'));
    }
    try { entry.child?.kill('SIGTERM'); } catch { /* already exited */ }
    return true;
  }

  stats() { return { activeSessions: this.#entries.size, maxSessions: this.#config.max }; }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of [...this.#entries.keys()]) this.release(id);
  }
}
