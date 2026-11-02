import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { verifyAttest, attestMode, signRequest } from '../src/attest.js';
// The app's own implementation (pure TypeScript, run directly by Node).
import { hmacSha256Hex } from '../../mobile/src/attest/hmac.ts';

const KEY = 'test-build-key-ключ';
const clientHeader = (ts, method, url) => `${ts}.${hmacSha256Hex(KEY, `${ts}\n${method}\n${url}`)}`;

test('a signature made by the app passes the server check (interop)', () => {
  const now = 1_800_000_000;
  for (const [method, url] of [['POST', '/auth/login'], ['PUT', '/e2ee/uploads/abc?offset=4194304'], ['DELETE', '/contacts/x'], ['PATCH', '/me/privacy']]) {
    assert.equal(verifyAttest(clientHeader(now, method, url), { key: KEY, method, url, nowSeconds: now }), null, `${method} ${url}`);
    assert.equal(signRequest(KEY, now, method, url), clientHeader(now, method, url).split('.')[1]);
  }
});

test('tampering, wrong key, wrong path and stale time are all rejected', () => {
  const now = 1_800_000_000, h = clientHeader(now, 'POST', '/auth/login');
  assert.equal(verifyAttest(h, { key: KEY, method: 'POST', url: '/auth/register', nowSeconds: now }), 'bad-signature');
  assert.equal(verifyAttest(h, { key: 'other', method: 'POST', url: '/auth/login', nowSeconds: now }), 'bad-signature');
  assert.equal(verifyAttest(h, { key: KEY, method: 'PUT', url: '/auth/login', nowSeconds: now }), 'bad-signature');
  assert.equal(verifyAttest(h, { key: KEY, method: 'POST', url: '/auth/login', nowSeconds: now + 601 }), 'stale');
  assert.equal(verifyAttest(undefined, { key: KEY, method: 'POST', url: '/', nowSeconds: now }), 'missing');
  assert.equal(verifyAttest('123.xyz', { key: KEY, method: 'POST', url: '/', nowSeconds: now }), 'malformed');
  assert.equal(attestMode('enforce', ''), 'off', 'no key → off, whatever the mode says');
  assert.equal(attestMode('nonsense', KEY), 'off');
});

async function server(t, options) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-attest-'));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, ...options });
  await app.ready();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}

test('enforce: unsigned writes get 403, signed writes and all reads pass', async t => {
  const fixedNow = 1_800_000_000_000;
  const app = await server(t, { attestKey: KEY, attestModeSetting: 'enforce', now: () => fixedNow });
  const ts = Math.floor(fixedNow / 1000);
  const unsigned = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
  assert.equal(unsigned.statusCode, 403);
  assert.equal(unsigned.json().code, 'ATTEST_FAILED');
  const signed = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'x-linea-attest': clientHeader(ts, 'POST', '/auth/login') }, payload: {} });
  assert.notEqual(signed.statusCode, 403, 'signed request passes the gate (and then fails validation normally)');
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  const read = await app.inject({ method: 'GET', url: '/me' });
  assert.equal(read.statusCode, 401, 'reads are not signed; they still need a session');
});

test('warn: bad signatures are only logged, nothing is blocked', async t => {
  const app = await server(t, { attestKey: KEY, attestModeSetting: 'warn' });
  const unsigned = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
  assert.notEqual(unsigned.statusCode, 403);
});

test('off by default: no key configured means nothing changes', async t => {
  const app = await server(t, {});
  const unsigned = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
  assert.notEqual(unsigned.statusCode, 403);
});
