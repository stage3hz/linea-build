// Where the code-lock settings live and the one store the screens read them from.
// Native: SecureStore (this device only, like the session token). Web: sessionStorage, as the token
// (src/storage.ts) — the lock lives as long as the signed-in tab does.
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { DEFAULT_LOCK_SETTINGS, SALT_BYTES, createRecord, parseLockSettings, unlockedPatch, verifyCode, type Kdf, type LockRecord, type LockSettings } from './model';

const KEY = 'linea.passcode.v1';

/** PBKDF2-HMAC-SHA256 (pure JS, the same library the E2EE layer builds on). */
export const pbkdf2Kdf: Kdf = (code, salt, iterations, length) => pbkdf2Async(sha256, code, salt, { c: iterations, dkLen: length });

/** Throws when the store cannot be read: the caller must not take that for «no code set». */
async function readRaw(): Promise<string | null> {
  if (Platform.OS === 'web') return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY);
  return SecureStore.getItemAsync(KEY);
}
async function writeRaw(raw: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof sessionStorage === 'undefined') return;
    if (raw) sessionStorage.setItem(KEY, raw); else sessionStorage.removeItem(KEY);
    return;
  }
  // Readable after the first unlock since boot even while the phone is locked again: the app may be
  // woken in the background (a push, a call) and must still find the lock, or it would start open.
  if (raw) await SecureStore.setItemAsync(KEY, raw, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(KEY);
}

let current: LockSettings = DEFAULT_LOCK_SETTINGS;
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;

/** The saved settings; before `loadLockSettings` resolves they are the defaults (no lock). */
export const getLockSettings = () => current;
export const lockSettingsLoaded = () => loaded;
export const useLockSettings = () => useSyncExternalStore(subscribe, snapshot, snapshot);

let loading: Promise<LockSettings> | null = null;
/** Reads the saved settings once. Rejects when the store could not be read (the keychain is not available
 * yet, a broken SecureStore): nothing is cached then, the next call reads again, and the gate stays
 * locked meanwhile — never open on a read error. */
export function loadLockSettings(): Promise<LockSettings> {
  if (!loading) {
    loading = readRaw().then(raw => { current = parseLockSettings(raw); loaded = true; emit(); return current; }, error => { loading = null; throw error; });
  }
  return loading;
}

// Writes are serialized so a quick pair of changes cannot land out of order.
let pending: Promise<void> = Promise.resolve();
export function setLockSettings(change: Partial<LockSettings>): Promise<void> {
  current = { ...current, ...change };
  if (!current.record) current = { ...current, biometrics: false, failures: 0, lastFailureAt: null };
  emit();
  const raw = current.record ? JSON.stringify(current) : null;
  const write = pending.catch(() => {}).then(() => writeRaw(raw));
  pending = write;
  return write;
}

/** A wrong code anywhere (the lock screen, the settings' check): one shared counter and wait. */
export const recordFailure = (now = Date.now()) => setLockSettings({ failures: current.failures + 1, lastFailureAt: now });
/** A right code anywhere: the wait is over, the app counts as open from now. */
export const recordSuccess = (now = Date.now()) => setLockSettings(unlockedPatch(now));

/** A fresh salted hash of `code`. */
export async function hashCode(code: string): Promise<LockRecord> {
  const salt = await Crypto.getRandomBytesAsync(SALT_BYTES);
  return createRecord(code, salt, pbkdf2Kdf);
}
export const checkCode = (code: string, record: LockRecord) => verifyCode(code, record, pbkdf2Kdf);

/** Turns the lock on with `code` (or replaces the code, keeping the other choices). */
export async function enableLock(code: string): Promise<void> {
  const record = await hashCode(code);
  await setLockSettings({ record, ...unlockedPatch(Date.now()) });
}
export const disableLock = () => setLockSettings({ record: null, biometrics: false, failures: 0, lastFailureAt: null, backgroundAt: null });
