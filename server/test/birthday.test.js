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

test('birthday and gender are visible to friends only (and always to the owner)', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-birthday-friends-')), app = await buildApp({ dataDir, authRateLimit: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async username => (await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: username, password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } })).json();
  const ivan = await register('ivan_b'), friend = await register('friend_b'), stranger = await register('stranger_b');
  const as = u => ({ authorization: `Bearer ${u.token}` });
  const own = (await app.inject({ method: 'PATCH', url: '/me', headers: as(ivan), payload: { birthday: '03-02', gender: 'male' } })).json().user;
  assert.equal(own.birthday, '03-02'); assert.equal(own.gender, 'male');
  assert.equal((await app.inject({ method: 'GET', url: '/me', headers: as(ivan) })).json().user.birthday, '03-02');
  const view = async viewer => (await app.inject({ method: 'GET', url: `/users/${ivan.user.id}`, headers: as(viewer) })).json().user;
  assert.equal((await view(stranger)).birthday, undefined);
  assert.equal((await view(stranger)).gender, undefined);
  await app.inject({ method: 'PUT', url: `/contacts/${ivan.user.id}`, headers: as(friend) });
  await app.inject({ method: 'PUT', url: `/contacts/${friend.user.id}`, headers: as(ivan) });
  const seen = await view(friend);
  assert.equal(seen.birthday, '03-02'); assert.equal(seen.gender, 'male');
});
