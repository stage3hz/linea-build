import assert from 'node:assert/strict';
import test from 'node:test';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';

// SecureStore stand-in: what the native app keeps on the device.
const secure = new Map();
let readFails = false;
const mocks = {
  react: { useSyncExternalStore: (_subscribe, get) => get() },
  'react-native': { Platform: { OS: 'ios' } },
  'expo-secure-store': { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock', getItemAsync: async key => { if (readFails) throw new Error('keychain unavailable'); return secure.get(key) ?? null; }, setItemAsync: async (key, value, options) => { assert.equal(options.keychainAccessible, 'after-first-unlock', 'readable for a background wake after the first unlock since boot'); secure.set(key, value); }, deleteItemAsync: async key => { secure.delete(key); } },
  'expo-crypto': { getRandomBytesAsync: async n => new Uint8Array(randomBytes(n)) },
};
const storage = loadTs(new URL('../src/lock/storage.ts', import.meta.url), mocks);

test('the app KDF is PBKDF2-HMAC-SHA256', async () => {
  const out = await storage.pbkdf2Kdf(Buffer.from('1234'), Buffer.from('salt'), 1200, 32);
  assert.equal(Buffer.from(out).toString('hex'), pbkdf2Sync('1234', 'salt', 1200, 32, 'sha256').toString('hex'));
});

test('enabling keeps a hash in SecureStore, never the code; disabling removes it; settings survive a reload', async () => {
  await storage.loadLockSettings();
  assert.equal(storage.getLockSettings().record, null);
  await storage.enableLock('2580');
  const raw = [...secure.values()][0];
  assert.ok(raw && !raw.includes('2580'));
  const saved = JSON.parse(raw);
  assert.equal(saved.record.kind, 'digits');
  assert.ok(saved.record.iterations >= 8_000);
  assert.equal(await storage.checkCode('2580', storage.getLockSettings().record), true);
  assert.equal(await storage.checkCode('2581', storage.getLockSettings().record), false);
  await storage.setLockSettings({ autolock: '5m', biometrics: true, failures: 2 });
  assert.equal(JSON.parse([...secure.values()][0]).autolock, '5m');
  await storage.disableLock();
  assert.equal(secure.size, 0);
  assert.equal(storage.getLockSettings().biometrics, false, 'biometrics never stay on without a code');
});

test('wrong codes are counted and stamped in the saved settings; a right one clears both and marks the app open', async () => {
  await storage.enableLock('1357');
  await storage.recordFailure(1_000);
  await storage.recordFailure(2_000);
  let saved = JSON.parse([...secure.values()][0]);
  assert.equal(saved.failures, 2);
  assert.equal(saved.lastFailureAt, 2_000, 'the wait survives a restart because its start is saved');
  assert.equal(storage.getLockSettings().lastFailureAt, 2_000);
  await storage.recordSuccess(5_000);
  saved = JSON.parse([...secure.values()][0]);
  assert.equal(saved.failures, 0);
  assert.equal(saved.lastFailureAt, null);
  assert.equal(saved.backgroundAt, 5_000);
  await storage.disableLock();
});

test('a store that cannot be read is an error, not «no code»: nothing is cached and the next read tries again', async () => {
  const secure2 = new Map();
  const fresh = loadTs(new URL('../src/lock/storage.ts', import.meta.url), { ...mocks, 'expo-secure-store': { ...mocks['expo-secure-store'], getItemAsync: async key => { if (readFails) throw new Error('keychain unavailable'); return secure2.get(key) ?? null; } } }, new Map());
  secure2.set('linea.passcode.v1', JSON.stringify({ record: { kind: 'digits', salt: 'ab'.repeat(16), hash: 'cd'.repeat(32), iterations: 8000 }, autolock: '1m', failures: 0, backgroundAt: 1, lastFailureAt: null }));
  readFails = true;
  await assert.rejects(fresh.loadLockSettings(), /keychain/);
  assert.equal(fresh.lockSettingsLoaded(), false);
  assert.equal(fresh.getLockSettings().record, null, 'defaults until a real read — the gate covers the app meanwhile');
  readFails = false;
  const loaded = await fresh.loadLockSettings();
  assert.equal(fresh.lockSettingsLoaded(), true);
  assert.equal(loaded.record.kind, 'digits', 'the retry really reads the store instead of a cached failure');
});
