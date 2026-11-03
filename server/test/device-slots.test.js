import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { syntheticPublicBundle } from './support/relay-fixtures.js';

const creds = { password: 'correct horse battery', confirmationWord: 'ласточкин' };
test('a sixth installation takes the slot of one idle for 14+ days; with all five in use it is refused clearly', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-slots-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000 }); await app.ready(); t.after(() => app.close());
  const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'olga', displayName: 'Ольга', recoveryWord: 'гранитный', ...creds } });
  assert.equal(reg.statusCode, 201, reg.body);
  const tokens = [reg.json().token];
  for (let i = 0; i < 5; i++) { const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'olga', ...creds } }); assert.equal(r.statusCode, 200, r.body); tokens.push(r.json().token); }
  const device = token => app.inject({ method: 'POST', url: '/e2ee/devices', headers: { authorization: `Bearer ${token}` }, payload: syntheticPublicBundle() });
  for (const token of tokens.slice(0, 5)) assert.equal((await device(token)).statusCode, 200);
  const refused = await device(tokens[5]);
  assert.equal(refused.statusCode, 409); assert.equal(refused.json().code, 'E2EE_DEVICE_LIMIT');
  assert.match(refused.json().error || refused.json().message || '', /Безопасность и устройства/);
  // The first installation has not been used for 20 days.
  const db = new DatabaseSync(path.join(dataDir, 'linea.sqlite'));
  db.prepare("UPDATE sessions SET last_active_at=? WHERE id=(SELECT session_id FROM e2ee_devices ORDER BY created_at LIMIT 1)").run(new Date(Date.now() - 20 * 86_400_000).toISOString());
  db.close();
  assert.equal((await device(tokens[5])).statusCode, 200, 'the idle slot is reused');
  const list = await app.inject({ method: 'GET', url: '/e2ee/devices', headers: { authorization: `Bearer ${tokens[5]}` } });
  assert.equal(list.json().devices.filter(d => d.active).length, 5);
});
