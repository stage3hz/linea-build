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
  const info = v => ({ version: '0.15.0', minVersion: v, page: null, notes: '', android: null, windows: null });
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
