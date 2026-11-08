// Код-пароль (Telegram «Код-пароль»): the pure rules — what a code looks like, how it is hashed and
// checked, when the app locks by itself and how long a wrong guess costs. No React, no platform here.

export type CodeKind = 'digits' | 'password';
/** When the app locks after it was last in the foreground. `immediate` = at once on leaving (Telegram «Сразу»). */
export type AutolockMode = 'off' | 'immediate' | '1m' | '5m' | '1h' | '5h';
export const AUTOLOCK_MODES: readonly AutolockMode[] = ['off', 'immediate', '1m', '5m', '1h', '5h'];
export const AUTOLOCK_LABELS: Record<AutolockMode, string> = { off: 'Выключена', immediate: 'Сразу', '1m': 'Через 1 мин', '5m': 'Через 5 мин', '1h': 'Через 1 ч', '5h': 'Через 5 ч' };
const AUTOLOCK_MS: Record<AutolockMode, number | null> = { off: null, immediate: 0, '1m': 60_000, '5m': 5 * 60_000, '1h': 3_600_000, '5h': 5 * 3_600_000 };
/** Milliseconds in the background before the lock, `null` = never by itself. */
export const autolockMs = (mode: AutolockMode) => AUTOLOCK_MS[mode];

export const DIGITS_LENGTH = 4;
/** PBKDF2-HMAC-SHA256 rounds for a new code. Old records keep their own count (`record.iterations`).
 * Budget: the KDF runs in pure JS (@noble/hashes) on Hermes, where 60 000 rounds measured ≈ 1.5–5 s on
 * mid-range phones — a visible freeze on every unlock. 8 000 rounds ≈ 0.2–0.7 s there (and ≈ 0.1 s on
 * desktop web); a 4-digit code has only 10 000 values anyway, so the real protection is the retry delay. */
export const KDF_ITERATIONS = 8_000;
export const SALT_BYTES = 16;
export const HASH_BYTES = 32;

/** What is kept on the device. The code itself never is: only its salted PBKDF2 hash. */
export type LockRecord = {
  kind: CodeKind;
  /** hex */
  salt: string;
  /** hex, PBKDF2-HMAC-SHA256(code, salt, iterations) */
  hash: string;
  iterations: number;
};
export type LockSettings = {
  record: LockRecord | null;
  biometrics: boolean;
  autolock: AutolockMode;
  /** Wrong guesses in a row (reset by a right one). */
  failures: number;
  /** When the app was last in the foreground with the lock open (Date.now()); null = never — or locked
   * when it was last seen, so a kill-and-relaunch starts locked too. */
  backgroundAt: number | null;
  /** When the last wrong code was typed (Date.now()); null = none since the last right one. Saved, so the
   * retry wait survives a restart. */
  lastFailureAt: number | null;
};
export const DEFAULT_LOCK_SETTINGS: LockSettings = { record: null, biometrics: false, autolock: '1m', failures: 0, backgroundAt: null, lastFailureAt: null };

/** Key derivation: bytes of the code and the salt → `length` bytes. The app injects PBKDF2; tests inject their own. */
export type Kdf = (code: Uint8Array, salt: Uint8Array, iterations: number, length: number) => Promise<Uint8Array> | Uint8Array;

export const isLockEnabled = (settings: LockSettings) => settings.record !== null;

/** Only exactly four digits are a «4-значный код»; anything else is a password. */
export const codeKind = (code: string): CodeKind => /^\d{4}$/.test(code) ? 'digits' : 'password';
/** A code the user may set: digits or a password of 1–64 characters, no surrounding spaces lost on the way. */
export function codeProblem(code: string, kind: CodeKind): string | null {
  if (kind === 'digits') return /^\d{4}$/.test(code) ? null : 'Введи четыре цифры.';
  if (!code.length) return 'Пароль не может быть пустым.';
  if (code.length > 64) return 'Пароль слишком длинный.';
  return null;
}

export const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const utf8 = (text: string) => new TextEncoder().encode(text.normalize('NFC'));

/** Same length and bytes, in time that does not depend on where they differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function createRecord(code: string, salt: Uint8Array, kdf: Kdf, iterations = KDF_ITERATIONS): Promise<LockRecord> {
  if (salt.length < SALT_BYTES) throw new Error('salt too short');
  if (iterations < 1000) throw new Error('too few iterations');
  const hash = await kdf(utf8(code), salt, iterations, HASH_BYTES);
  return { kind: codeKind(code), salt: bytesToHex(salt), hash: bytesToHex(hash), iterations };
}
export async function verifyCode(code: string, record: LockRecord, kdf: Kdf): Promise<boolean> {
  const expected = hexToBytes(record.hash);
  const actual = await kdf(utf8(code), hexToBytes(record.salt), record.iterations, expected.length);
  return constantTimeEqual(actual, expected);
}

export const RETRY_FREE_ATTEMPTS = 5;
export const RETRY_BASE_MS = 10_000;
export const RETRY_MAX_MS = 3_600_000;
/** After five wrong codes the next try waits 10 s, then 20, 40, 80… up to an hour. */
export function retryDelayMs(failures: number): number {
  if (failures < RETRY_FREE_ATTEMPTS) return 0;
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(30, failures - RETRY_FREE_ATTEMPTS));
}
/** Milliseconds still to wait since the last wrong code (0 = may try). */
export function retryWaitMs(failures: number, lastFailureAt: number | null, now: number): number {
  if (lastFailureAt === null) return 0;
  const elapsed = now - lastFailureAt;
  // A clock that jumped back cannot shorten the wait past the full delay.
  if (elapsed < 0) return retryDelayMs(failures);
  return Math.max(0, retryDelayMs(failures) - elapsed);
}
export function retryHint(waitMs: number): string {
  const seconds = Math.ceil(waitMs / 1000);
  if (seconds <= 0) return '';
  if (seconds < 60) return `Попробуй через ${seconds} с`;
  if (seconds < 3600) return `Попробуй через ${Math.ceil(seconds / 60)} мин`;
  return 'Попробуй через 1 ч';
}

/** On return to the foreground: lock when the time away reached the autolock delay (a clock that went
 * backwards counts as a long absence — safer to lock). The first launch with a code is always locked. */
export function shouldLock(settings: LockSettings, now: number): boolean {
  if (!settings.record) return false;
  if (settings.backgroundAt === null) return true;
  const limit = autolockMs(settings.autolock);
  if (limit === null) return false;
  const away = now - settings.backgroundAt;
  return away < 0 || away >= limit;
}
/** A cold start with a code set: always locked when autolock is off (there is no other moment it could ask), otherwise by the time away.
 * On the web (Telegram Web) a start with a code is always locked: the tab has no app switcher to come back from. */
export const shouldLockOnLaunch = (settings: LockSettings, now: number, platform: 'native' | 'web' = 'native') => !!settings.record && (platform === 'web' || settings.autolock === 'off' || shouldLock(settings, now));
/** Leaving the foreground: «Сразу» locks now, so the app switcher never shows a chat. */
export const locksOnBackground = (settings: LockSettings) => !!settings.record && settings.autolock === 'immediate';

/** What is saved the moment the app locks: no «last seen open» stamp, so after a kill-and-relaunch
 * `shouldLock` is true again (the stamp alone would let a relaunch inside the autolock delay skip the code). */
export const LOCKED_PATCH: Partial<LockSettings> = { backgroundAt: null };
/** What is saved on a right code (or Face ID): the wait is over, the app counts as open from now. */
export const unlockedPatch = (now: number): Partial<LockSettings> => ({ failures: 0, lastFailureAt: null, backgroundAt: now });

/** iPhone goes «inactive» for a moment for the Face ID sheet, Control Centre, a call banner or a system
 * picker; «Сразу» waits this long before locking on inactive alone, so those do not relock what the
 * owner just opened. A real «background» locks at once. */
export const INACTIVE_LOCK_GRACE_MS = 1500;
export type LeaveState = 'inactive' | 'background';
export type LeaveAction = {
  /** Remember «open until now» — only while the lock is open (a locked app writing it would unlock a relaunch). */
  recordBackgroundAt: boolean;
  /** `now`: lock this instant; `soon`: after INACTIVE_LOCK_GRACE_MS unless the app is active again; `no`. */
  lock: 'now' | 'soon' | 'no';
  /** Hide the content behind an opaque cover (iPhone app switcher shows a snapshot of the app as it is). */
  cover: boolean;
};
/** The pure half of LockGate's AppState handling when the app leaves the foreground. */
export function onLeave(settings: LockSettings, locked: boolean, state: LeaveState, ios: boolean): LeaveAction {
  if (!settings.record) return { recordBackgroundAt: false, lock: 'no', cover: false };
  const recordBackgroundAt = !locked && state === 'background';
  const cover = ios && !locked;
  if (locked || !locksOnBackground(settings)) return { recordBackgroundAt, lock: 'no', cover };
  return { recordBackgroundAt, lock: state === 'background' ? 'now' : ios ? 'soon' : 'no', cover };
}
/** Back in the foreground: only a real stay in the background counts (not a Face ID sheet), and only
 * when the time away reached the autolock delay. «Сразу» never locks on return — it locked on leaving;
 * on return the stamp written by the unlock a moment ago (Android's fingerprint dialog is a «background»)
 * must not relock what the owner just opened. */
export const shouldLockOnReturn = (settings: LockSettings, wasBackground: boolean, now: number) => wasBackground && settings.autolock !== 'immediate' && shouldLock(settings, now);

const AUTOLOCK_SET = new Set<string>(AUTOLOCK_MODES);
export function parseLockSettings(raw: string | null): LockSettings {
  if (!raw) return DEFAULT_LOCK_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<LockSettings> & { record?: Partial<LockRecord> | null };
    const r = value?.record;
    const record: LockRecord | null = r && (r.kind === 'digits' || r.kind === 'password') && typeof r.salt === 'string' && typeof r.hash === 'string' && /^[0-9a-f]+$/i.test(r.salt) && /^[0-9a-f]+$/i.test(r.hash) && r.hash.length === HASH_BYTES * 2 && typeof r.iterations === 'number' && r.iterations >= 1000
      ? { kind: r.kind, salt: r.salt, hash: r.hash, iterations: r.iterations } : null;
    return {
      record,
      biometrics: record ? value.biometrics === true : false,
      autolock: typeof value.autolock === 'string' && AUTOLOCK_SET.has(value.autolock) ? value.autolock as AutolockMode : DEFAULT_LOCK_SETTINGS.autolock,
      failures: typeof value.failures === 'number' && value.failures >= 0 ? Math.floor(value.failures) : 0,
      backgroundAt: typeof value.backgroundAt === 'number' ? value.backgroundAt : null,
      lastFailureAt: typeof value.lastFailureAt === 'number' ? value.lastFailureAt : null,
    };
  } catch { return DEFAULT_LOCK_SETTINGS; }
}
