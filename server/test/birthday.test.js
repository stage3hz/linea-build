import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

test('birthday: day and month or a full date, real calendar days only, cleared with null, visible on the profile', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-birthday-')), app = await buildApp({ dataDir, authRateLimit: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'bday', displayName: 'Bday', password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } });
  const headers = { authorization: `Bearer ${reg.json().token}` };
  const patch = birthday => app.inject({ method: 'PATCH', url: '/me', headers, payload: { birthday } });
  assert.equal((await patch('03-02')).json().user.birthday, '03-02');
  assert.equal((await patch('1999-03-02')).json().user.birthday, '1999-03-02');
  assert.equal((await patch('02-29')).statusCode, 200);
  assert.equal((await patch('2001-02-29')).statusCode, 400);
  assert.equal((await patch('13-01')).statusCode, 400);
  assert.equal((await patch('1850-01-01')).statusCode, 400);
  assert.equal((await patch('3 мар')).statusCode, 400);
  assert.equal((await patch(null)).json().user.birthday, null);
  const gender = value => app.inject({ method: 'PATCH', url: '/me', headers, payload: { gender: value } });
  assert.equal((await gender('female')).json().user.gender, 'female');
  assert.equal((await gender('robot')).statusCode, 400);
  assert.equal((await gender(null)).json().user.gender, null);
});
