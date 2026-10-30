import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { TURN_TTL_SECONDS } from '../src/calls.js';

async function setup(t, turn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-calls-'));
  const app = await buildApp({ dataDir, now: () => 1_800_000_000_000, authRateLimit: 1000, logger: false, turn });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'caller', displayName: 'caller', password: 'Synthetic!Harbor.42.Maple', confirmationWord: 'AmberGardenPrism', recoveryWord: 'SilverHarborLantern' } });
  assert.equal(reg.statusCode, 201, reg.body);
  return { app, account: reg.json() };
}

test('ICE servers require sign-in and give short-lived TURN credentials bound to the user', async t => {
  const { app, account } = await setup(t, { secret: 'turn-secret', host: 'api.example.com' });
  assert.equal((await app.inject({ method: 'GET', url: '/calls/ice' })).statusCode, 401);
  const res = await app.inject({ method: 'GET', url: '/calls/ice', headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(res.statusCode, 200, res.body);
  const turn = res.json().iceServers.find(server => server.username);
  assert.ok(turn.urls.includes('turn:api.example.com:3478?transport=udp'));
  const [expiry, userId] = turn.username.split(':');
  assert.equal(Number(expiry), 1_800_000_000 + TURN_TTL_SECONDS);
  assert.equal(userId, account.user.id);
  assert.equal(turn.credential, createHmac('sha1', 'turn-secret').update(turn.username).digest('base64'));
});

test('without a TURN secret only public STUN is offered', async t => {
  const { app, account } = await setup(t, null);
  const res = await app.inject({ method: 'GET', url: '/calls/ice', headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().iceServers.every(server => !server.username));
});
