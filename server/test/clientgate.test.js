import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVersion, versionLessThan, parseClientInfo, clientGateDecision } from '../src/clientgate.js';

test('version parsing and comparison', () => {
  assert.deepEqual(parseVersion('0.14.2'), [0, 14, 2]);
  assert.equal(parseVersion('0.14'), null);
  assert.equal(parseVersion('1.2.x'), null);
  assert.deepEqual(parseVersion(' 1.2.3 '), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.equal(versionLessThan([0, 14, 1], [0, 14, 2]), true);
  assert.equal(versionLessThan([0, 14, 2], [0, 14, 2]), false);
  assert.equal(versionLessThan([1, 0, 0], [0, 99, 99]), false);
});

test('client header parsing is lenient and bounded', () => {
  assert.deepEqual(parseClientInfo('invizent; v=0.14.2; p=ios'), { product: 'invizent', version: '0.14.2', platform: 'ios', raw: 'invizent; v=0.14.2; p=ios' });
  assert.equal(parseClientInfo('invizent; v=not-a-version; p=ios').version, null);
  assert.equal(parseClientInfo(undefined).raw, null);
  assert.equal(parseClientInfo('x'.repeat(200)).raw, null);
  assert.equal(parseClientInfo('invizent; p=<script>').platform, null);
});

test('gate allows everything when no minimum is set', () => {
  assert.equal(clientGateDecision(parseClientInfo('invizent; v=0.1.0; p=ios'), {}), null);
  assert.equal(clientGateDecision(parseClientInfo(undefined), {}), null);
});

test('gate refuses builds below the minimum, lets current and newer through', () => {
  const opts = { minVersion: '0.14.2' };
  assert.equal(clientGateDecision(parseClientInfo('invizent; v=0.14.1; p=android'), opts).code, 'CLIENT_TOO_OLD');
  assert.equal(clientGateDecision(parseClientInfo('invizent; v=0.14.2; p=android'), opts), null);
  assert.equal(clientGateDecision(parseClientInfo('invizent; v=0.15.0; p=android'), opts), null);
  // A client that sends no parseable version is NOT refused unless requireHeader is on.
  assert.equal(clientGateDecision(parseClientInfo(undefined), opts), null);
});

test('requireHeader refuses header-less and garbled clients', () => {
  const opts = { minVersion: '0.14.2', requireHeader: true };
  assert.equal(clientGateDecision(parseClientInfo(undefined), opts).code, 'CLIENT_UNKNOWN');
  assert.equal(clientGateDecision(parseClientInfo('invizent; p=ios'), opts).code, 'CLIENT_UNKNOWN');
  assert.equal(clientGateDecision(parseClientInfo('invizent; v=0.14.2; p=ios'), opts), null);
});

test('browsers may send the version and signature headers (CORS)', async t => {
  const os = await import('node:os'), path = await import('node:path'), { mkdtemp, rm } = await import('node:fs/promises');
  const { buildApp } = await import('../src/app.js');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-cors-'));
  const app = await buildApp({ dataDir, logger: false, allowedOrigins: ['https://web.example'] });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const pre = await app.inject({ method: 'OPTIONS', url: '/auth/login', headers: { origin: 'https://web.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-linea-client,x-linea-attest' } });
  const allowed = pre.headers['access-control-allow-headers'].toLowerCase();
  for (const h of ['x-linea-client', 'x-linea-attest', 'authorization', 'content-type']) assert.ok(allowed.includes(h), h);
  for (const m of ['PUT', 'DELETE']) assert.ok(pre.headers['access-control-allow-methods'].includes(m), m);
});
