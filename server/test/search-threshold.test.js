import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

test('global user search does not list everyone from a few letters (Telegram-like)', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-search-threshold-')), app = await buildApp({ dataDir, authRateLimit: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async (username, displayName = username) => {
    const response = await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName, password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } });
    assert.equal(response.statusCode, 201, response.body); return response.json();
  };
  const me = await register('watcher'), anna = await register('annabelle', 'Анна'), ann = await register('ann');
  const find = async q => (await app.inject({ method: 'GET', url: `/users?q=${encodeURIComponent(q)}`, headers: { authorization: `Bearer ${me.token}` } })).json().users.map(user => user.id);
  assert.deepEqual(await find('an'), []);
  assert.deepEqual(await find('nab'), []);
  assert.deepEqual(await find('anna'), []);
  assert.deepEqual(await find('ann'), [ann.user.id]);
  assert.deepEqual(await find('@ANN'), [ann.user.id]);
  assert.deepEqual(await find('annab'), [anna.user.id]);
  assert.deepEqual(await find('annabelle'), [anna.user.id]);
  assert.deepEqual(await find('анна'), [anna.user.id]);
  assert.deepEqual(await find('@анна'), []);
  assert.deepEqual(await find('a_%'), []);
});
