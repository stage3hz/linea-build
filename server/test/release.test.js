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
  assert.deepEqual((await empty.inject({ method: 'GET', url: '/app/update' })).json(), { version: null, minVersion: null, android: null, windows: null, page: null, notes: '' });
  const broken = await server(t, {}, '{not json');
  assert.equal((await broken.inject({ method: 'GET', url: '/app/update' })).json().version, null, 'a broken file offers nothing instead of failing');
});
