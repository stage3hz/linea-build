import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';

const react = { useEffect: () => {}, useState: value => [value, () => {}] };
const store = loadTs(new URL('../src/update/store.ts', import.meta.url), { react, '../serverConfig': { APP_VERSION: '0.14.2', SERVER_URL: 'https://api.invizent.com' } });
const { Sha256 } = loadTs(new URL('../src/update/sha256.ts', import.meta.url));
const SHA = 'c'.repeat(64);
const asset = name => ({ url: `https://github.com/stage3hz/linea-build/releases/download/v0.15.0/${name}`, sha256: SHA, size: 100 });

test('version comparison', () => {
  assert.equal(store.versionLess('0.14.2', '0.15.0'), true);
  assert.equal(store.versionLess('0.15.0', '0.15.0'), false);
  assert.equal(store.versionLess('1.0.0', '0.99.99'), false);
  assert.equal(store.versionLess('garbage', '1.0.0'), false);
});

test('required vs available', () => {
  const info = v => ({ version: '0.15.0', minVersion: v, page: null, notes: '', android: null, windows: null, releasedAt: null, requiredAt: null, clockOffset: 0 });
  assert.deepEqual(store.decide(info('0.15.0'), '0.14.2'), { required: true, available: true });
  assert.deepEqual(store.decide(info(null), '0.14.2'), { required: false, available: true });
  assert.deepEqual(store.decide(info(null), '0.15.0'), { required: false, available: false });
  assert.deepEqual(store.decide(info('0.14.0'), '0.14.2'), { required: false, available: true });
});

test('server answer is checked: foreign download links are dropped', async () => {
  const answer = { version: '0.15.0', minVersion: '0.15.0', android: asset('INVIZENT-0.15.0-Android-arm64.apk'), windows: { ...asset('x.exe'), url: 'https://evil.example/x.exe' } };
  const fakeFetch = async () => ({ ok: true, json: async () => answer });
  const state = await store.checkForUpdate(fakeFetch);
  assert.equal(state.required, true);
  assert.equal(state.info.android.url.startsWith('https://github.com/stage3hz/'), true);
  assert.equal(state.info.windows, null, 'a link outside this project is never offered');
});

test('offline keeps the previous answer instead of failing', async () => {
  const before = await store.checkForUpdate(async () => { throw new Error('offline'); });
  assert.equal(before.required, true);
});

test('streaming SHA-256 used to verify the APK matches Node', () => {
  const data = randomBytes(5 * 1024 * 1024 + 3), hash = new Sha256();
  for (let i = 0; i < data.length; i += 2 * 1024 * 1024) hash.update(new Uint8Array(data.subarray(i, i + 2 * 1024 * 1024)));
  assert.equal(hash.hex(), createHash('sha256').update(data).digest('hex'));
});

test('grace period ends by the server clock, even if the phone clock is wrong', () => {
  const T = Date.parse('2026-11-02T10:00:00Z');
  const info = { version: '0.15.0', minVersion: null, page: null, notes: '', android: null, windows: null, releasedAt: T, requiredAt: T + 72 * 3_600_000, clockOffset: 0 };
  assert.deepEqual(store.decide(info, '0.14.2', T + 71 * 3_600_000), { required: false, available: true }, 'day 3: still optional');
  assert.deepEqual(store.decide(info, '0.14.2', T + 72 * 3_600_000), { required: true, available: true }, 'deadline: mandatory');
  // Phone clock set 5 days back; the offset learned from the server corrects it.
  const skewed = { ...info, clockOffset: 5 * 86_400_000 };
  assert.equal(store.decide(skewed, '0.14.2', T + 72 * 3_600_000 - 5 * 86_400_000).required, true);
  assert.deepEqual(store.decide(info, '0.15.0', T + 100 * 3_600_000), { required: false, available: false }, 'already updated');
});

test('countdown wording', () => {
  assert.equal(store.formatSpan((2 * 24 + 14) * 3_600_000 + 5 * 60_000), '2 д 14 ч 05 мин');
  assert.equal(store.formatSpan(3 * 3_600_000 + 7 * 60_000), '3 ч 07 мин');
  assert.equal(store.formatSpan(20_000), '1 мин');
});

test('a dismissed prompt returns after the app was away 5+ minutes, not after a quick switch', async () => {
  const offline = async () => { throw new Error('offline'); };
  await store.checkForUpdate(async () => ({ ok: true, json: async () => ({ version: '0.15.0', minVersion: null, serverTime: new Date().toISOString(), releasedAt: new Date().toISOString(), requiredAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }) }));
  store.dismissUpdate();
  const read = () => new Promise(resolve => { const s = store.checkForUpdate(offline); s.then(resolve); });
  store.appBecameActive(30_000);
  assert.equal((await read()).dismissed, true, 'quick switch: stays dismissed');
  store.appBecameActive(store.REPROMPT_AFTER_MS);
  assert.equal((await read()).dismissed, false, 'back after 5 min: prompt again');
});
