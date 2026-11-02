import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { validateManifest } from '../src/release.js';

const SHA = 'a'.repeat(64);
const good = {
  version: '0.15.0', minVersion: '0.15.0', page: 'https://github.com/stage3hz/linea-build/releases/tag/v0.15.0', notes: 'n',
  android: { url: 'https://github.com/stage3hz/linea-build/releases/download/v0.15.0/INVIZENT-0.15.0-Android-arm64.apk', sha256: SHA, size: 1000 },
  windows: { url: 'https://github.com/stage3hz/linea-build/releases/download/v0.15.0/INVIZENT-0.15.0-Windows-x64.exe', sha256: SHA, size: 2000 },
};

test('manifest accepts only this project\'s GitHub releases with real checksums', () => {
  assert.equal(validateManifest(good).android.size, 1000);
  assert.throws(() => validateManifest({ ...good, android: { ...good.android, url: 'https://evil.example/x.apk' } }), /release of this project/);
  assert.throws(() => validateManifest({ ...good, android: { ...good.android, url: 'https://github.com/other/repo/releases/download/v1/x.apk' } }));
  assert.throws(() => validateManifest({ ...good, windows: { ...good.windows, sha256: 'xyz' } }), /sha256/);
  assert.throws(() => validateManifest({ ...good, version: '1.0' }), /x\.y\.z/);
  assert.equal(validateManifest({ ...good, windows: null }).windows, null);
});

async function server(t, options, manifest) {
  options = { ...options };
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-release-'));
  let manifestPath = null;
  if (manifest !== undefined) { manifestPath = path.join(dataDir, 'release.json'); await writeFile(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest)); }
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, releaseManifest: manifestPath, ...options });
  await app.ready();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}

test('/app/update serves the manifest, even to a client the gate turns away', async t => {
  const app = await server(t, { minClientVersion: '0.15.0' }, good);
  const old = { 'x-linea-client': 'invizent; v=0.14.2; p=android' };
  const update = await app.inject({ method: 'GET', url: '/app/update', headers: old });
  assert.equal(update.statusCode, 200, 'an old build must be able to learn about the update');
  assert.equal(update.json().version, '0.15.0');
  assert.equal(update.json().android.sha256, SHA);
  const blocked = await app.inject({ method: 'POST', url: '/auth/login', headers: old, payload: {} });
  assert.equal(blocked.statusCode, 426);
});

test('server minimum wins over a lower manifest minimum; no manifest = nothing offered', async t => {
  const app = await server(t, { minClientVersion: '0.16.0' }, { ...good, minVersion: null });
  assert.equal((await app.inject({ method: 'GET', url: '/app/update' })).json().minVersion, '0.16.0');
  const empty = await server(t, {}, undefined);
  const none = (await empty.inject({ method: 'GET', url: '/app/update' })).json();
  assert.deepEqual({ ...none, serverTime: undefined }, { version: null, minVersion: null, releasedAt: null, requiredAt: null, serverTime: undefined, android: null, windows: null, page: null, notes: '' });
  assert.ok(Number.isFinite(Date.parse(none.serverTime)));
  const broken = await server(t, {}, '{not json');
  assert.equal((await broken.inject({ method: 'GET', url: '/app/update' })).json().version, null, 'a broken file offers nothing instead of failing');
});

test('grace period: optional for 72 h by the server clock, then mandatory on its own', async t => {
  const T = Date.parse('2026-11-02T10:00:00Z');
  let clock = T + 3_600_000; // one hour after release
  const app = await server(t, { now: () => clock }, { ...good, minVersion: null, releasedAt: new Date(T).toISOString(), graceHours: 72 });
  const old = { 'x-linea-client': 'invizent; v=0.14.2; p=android' };
  let info = (await app.inject({ method: 'GET', url: '/app/update' })).json();
  assert.equal(info.minVersion, null, 'still optional');
  assert.equal(info.requiredAt, '2026-11-05T10:00:00.000Z');
  assert.equal(info.serverTime, new Date(clock).toISOString());
  assert.notEqual((await app.inject({ method: 'POST', url: '/auth/login', headers: old, payload: {} })).statusCode, 426);
  clock = T + 72 * 3_600_000; // deadline reached
  info = (await app.inject({ method: 'GET', url: '/app/update' })).json();
  assert.equal(info.minVersion, '0.15.0', 'now mandatory without any new command');
  assert.equal((await app.inject({ method: 'POST', url: '/auth/login', headers: old, payload: {} })).statusCode, 426);
  assert.equal((await app.inject({ method: 'GET', url: '/app/update', headers: old })).statusCode, 200, 'old builds can still find the update');
  const current = { 'x-linea-client': 'invizent; v=0.15.0; p=android' };
  assert.notEqual((await app.inject({ method: 'POST', url: '/auth/login', headers: current, payload: {} })).statusCode, 426);
});

test('graceHours 0 makes the version mandatory at once', async t => {
  const T = Date.parse('2026-11-02T10:00:00Z');
  const app = await server(t, { now: () => T }, { ...good, minVersion: null, releasedAt: new Date(T).toISOString(), graceHours: 0 });
  assert.equal((await app.inject({ method: 'GET', url: '/app/update' })).json().minVersion, '0.15.0');
});
