import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { rateLimitIp } from '../src/auth.js';

const PASSWORD = 'Synthetic!Harbor.42.Maple', CONFIRMATION_WORD = 'AmberGardenPrism';

test('rateLimitIp: IPv4 as is, mapped IPv6 unwrapped, IPv6 by its /64, junk verbatim', () => {
  assert.equal(rateLimitIp('203.0.113.9'), '203.0.113.9');
  assert.equal(rateLimitIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(rateLimitIp('2001:db8:abcd:12::1'), '2001:db8:abcd:12::/64');
  assert.equal(rateLimitIp('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff'), '2001:db8:abcd:12::/64', 'the whole /64 is one key');
  assert.equal(rateLimitIp('2001:db8:abcd:13::1'), '2001:db8:abcd:13::/64', 'the next /64 is another');
  assert.equal(rateLimitIp('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(rateLimitIp('::1'), '0:0:0:0::/64');
  assert.equal(rateLimitIp('not-an-ip'), 'not-an-ip');
  assert.equal(rateLimitIp(undefined), '');
});

async function fixture(t, options) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-ratelimit-ip-'));
  const app = await buildApp({ dataDir, logger: false, ...options });
  await app.ready();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (url, payload, remoteAddress) => app.inject({ method: 'POST', url, payload, remoteAddress });
  const registered = await post('/auth/register', { username: 'alice', displayName: 'alice', password: PASSWORD, confirmationWord: CONFIRMATION_WORD, recoveryWord: 'SilverHarborLantern' }, '198.51.100.1');
  assert.equal(registered.statusCode, 201, registered.body);
  const login = (password, remoteAddress) => post('/auth/login', { username: 'alice', password, confirmationWord: CONFIRMATION_WORD }, remoteAddress);
  return { login };
}

test('every failed login spends the account budget, so an attacker rotating addresses runs it down', async t => {
  // Per address: 3 tries per 15 minutes; per account: twice that, 6.
  const { login } = await fixture(t, { authRateLimit: 3 });
  for (let i = 1; i <= 6; i++) {
    const failed = await login('wrong-password-00', `203.0.113.${i}`);
    assert.equal(failed.statusCode, 401, `attempt ${i}: ${failed.body}`);
  }
  // Address 1 failed recently and the account budget is spent: even the right password waits.
  const blocked = await login(PASSWORD, '203.0.113.1');
  assert.equal(blocked.statusCode, 429, blocked.body);
  assert.match(blocked.json().error, /в этот аккаунт/);
  // A clean address never touched by the fails still signs in.
  const ok = await login(PASSWORD, '203.0.113.200');
  assert.equal(ok.statusCode, 200, ok.body);
});

test('IPv6 addresses of one /64 share the per-address login limits', async t => {
  const { login } = await fixture(t, { authRateLimit: 2 });
  assert.equal((await login('wrong-password-00', '2001:db8:1:2::10')).statusCode, 401);
  assert.equal((await login('wrong-password-00', '2001:db8:1:2::20')).statusCode, 401);
  const third = await login(PASSWORD, '2001:db8:1:2:dead:beef::1');
  assert.equal(third.statusCode, 429, 'the third address of the same /64 hits the per-address limit');
  assert.match(third.json().error, /15 минут/);
  const other = await login(PASSWORD, '2001:db8:1:3::1');
  assert.equal(other.statusCode, 200, `a neighbouring /64 is a different client: ${other.body}`);
});
