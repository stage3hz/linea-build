// F2 «Mute на время»: chat_settings.muted_until — pushes stop while the mute runs and come back by
// themselves once the clock passes it (compared on read, no sweep); the old boolean migrates to «forever».
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { chatSettings, mutedAt, openDatabase } from '../src/database.js';
import { syntheticEnvelope, syntheticPublicBundle } from './support/relay-fixtures.js';

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-03-10T12:00:00.000Z');

async function request(app, method, url, account, payload) {
  return app.inject({ method, url, headers: account ? { authorization: `Bearer ${account.token}` } : {}, ...(payload === undefined ? {} : { payload }) });
}
async function register(app, username) {
  const response = await request(app, 'POST', '/auth/register', null, { username, displayName: username, password: 'correct-horse-42', recoveryWord: 'SilverHarborLantern', confirmationWord: 'AmberGardenPrism' });
  assert.equal(response.statusCode, 201, response.body);
  const account = response.json();
  const registered = await request(app, 'POST', '/e2ee/devices', account, syntheticPublicBundle());
  assert.equal(registered.statusCode, 200, registered.body);
  account.device = registered.json().device;
  return account;
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-mute-'));
  const clock = { now: T0 };
  const sent = [];
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, now: () => clock.now, push: async (token, message) => { sent.push({ token, message }); return 'ok'; } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const alice = await register(app, 'alice_m'), bob = await register(app, 'bob_m');
  const chat = (await request(app, 'POST', '/chats', alice, { userId: bob.user.id })).json().chat;
  const saved = await request(app, 'PUT', '/me/push', bob, { token: 'fcm-token-bob-mute-000000000', platform: 'android' });
  assert.equal(saved.statusCode, 200, saved.body);
  let counter = 0;
  const send = async (push) => {
    const response = await request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, alice, { clientId: `client-mute-${String(++counter).padStart(6, '0')}`, encrypted: syntheticEnvelope(alice.device, [bob.device]), ...(push ? { push } : {}) });
    assert.equal(response.statusCode, 201, response.body);
    await new Promise(resolve => setImmediate(resolve));
    return response.json().message;
  };
  const settings = async () => (await request(app, 'GET', '/chats', bob)).json().chats[0].settings;
  const patch = payload => request(app, 'PATCH', `/chats/${chat.id}/settings`, bob, payload);
  return { app, dataDir, alice, bob, chat, clock, sent, send, settings, patch };
}

test('a mute until a moment stops pushes and the icon badge, then ends by itself when the clock passes it', async t => {
  const { clock, sent, send, settings, patch } = await fixture(t);
  await send();
  assert.equal(sent.length, 1, 'rings before the mute');
  assert.equal(sent[0].message.apns.payload.aps.badge, 1);
  const until = new Date(T0 + 8 * HOUR).toISOString();
  const muted = await patch({ mutedUntil: until });
  assert.equal(muted.statusCode, 200, muted.body);
  assert.deepEqual(muted.json().chat.settings, { pinnedAt: null, archived: false, muted: true, mutedUntil: until });
  await send();
  assert.equal(sent.length, 1, 'no push while the mute runs');
  await send('call');
  assert.equal(sent.length, 2, 'a call still rings');
  assert.equal(sent[1].message.data.kind, 'call');
  // Seven hours later the mute is still on; after the eighth it is gone without anybody touching it.
  clock.now = T0 + 7 * HOUR;
  assert.equal((await settings()).muted, true);
  await send();
  assert.equal(sent.length, 2);
  clock.now = T0 + 8 * HOUR + 1;
  assert.deepEqual(await settings(), { pinnedAt: null, archived: false, muted: false }, 'an expired mute reads as sound on, with no end');
  await send();
  assert.equal(sent.length, 3, 'rings again after the mute ran out');
  assert.equal(sent[2].message.apns.payload.aps.badge, 5, 'the icon badge counts this chat again (all five unread rows, the call row included)');
  // Muting again after the expiry starts a fresh mute, it does not revive the old end.
  const again = await patch({ mutedUntil: new Date(clock.now + HOUR).toISOString() });
  assert.equal(again.json().chat.settings.mutedUntil, new Date(clock.now + HOUR).toISOString());
});

test('«Навсегда» is the old boolean; mutedUntil validation; unmute by either field', async t => {
  const { clock, sent, send, patch, settings } = await fixture(t);
  assert.deepEqual((await patch({ muted: true })).json().chat.settings, { pinnedAt: null, archived: false, muted: true }, 'forever has no end date');
  clock.now = T0 + 20 * 24 * HOUR;
  assert.equal((await settings()).muted, true, 'forever outlives the clock');
  await send();
  assert.equal(sent.length, 0);
  for (const bad of [new Date(clock.now - 1).toISOString(), new Date(clock.now + 400 * 24 * HOUR).toISOString(), 'tomorrow', 42, true]) {
    const response = await patch({ mutedUntil: bad });
    assert.equal(response.statusCode, 400, `rejected: ${JSON.stringify(bad)}`);
    assert.match(response.json().message || response.body, /срок/);
  }
  assert.equal((await settings()).muted, true, 'a rejected change leaves the mute alone');
  assert.deepEqual((await patch({ mutedUntil: null })).json().chat.settings, { pinnedAt: null, archived: false, muted: false });
  await send();
  assert.equal(sent.length, 1, 'rings after mutedUntil: null');
  const until = new Date(clock.now + 2 * 24 * HOUR).toISOString();
  assert.equal((await patch({ mutedUntil: until })).json().chat.settings.mutedUntil, until);
  assert.deepEqual((await patch({ muted: false })).json().chat.settings, { pinnedAt: null, archived: false, muted: false }, 'muted: false ends a timed mute too');
  // Pinning while muted keeps the end date: the row is rewritten whole.
  assert.equal((await patch({ mutedUntil: until })).statusCode, 200);
  const pinned = (await patch({ pinned: true })).json().chat.settings;
  assert.equal(pinned.mutedUntil, until);
  assert.ok(pinned.pinnedAt);
  // The peer never sees the setting.
});

test('database: the old boolean `muted` migrates to a forever mute; chatSettings compares with the clock', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-mute-migrate-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  legacy.exec(`CREATE TABLE chat_settings (
    user_id TEXT NOT NULL, chat_id TEXT NOT NULL, pinned_at TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1)),
    PRIMARY KEY(user_id, chat_id))`);
  legacy.prepare('INSERT INTO chat_settings(user_id,chat_id,pinned_at,archived,muted) VALUES(?,?,?,?,?)').run('u1', 'c-quiet', null, 0, 1);
  legacy.prepare('INSERT INTO chat_settings(user_id,chat_id,pinned_at,archived,muted) VALUES(?,?,?,?,?)').run('u1', 'c-loud', '2026-01-01T00:00:00.000Z', 0, 0);
  legacy.close();
  const db = openDatabase(dataDir);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5, 'user_version is untouched');
    const rows = Object.fromEntries(db.prepare('SELECT chat_id, muted_until FROM chat_settings').all().map(row => [row.chat_id, row.muted_until]));
    assert.deepEqual(rows, { 'c-quiet': 0, 'c-loud': null });
    assert.deepEqual(chatSettings(db, 'u1', 'c-quiet', T0), { pinnedAt: null, archived: false, muted: true });
    assert.deepEqual(chatSettings(db, 'u1', 'c-loud', T0), { pinnedAt: '2026-01-01T00:00:00.000Z', archived: false, muted: false });
    assert.deepEqual(chatSettings(db, 'u1', 'c-none', T0), { pinnedAt: null, archived: false, muted: false }, 'no row: defaults');
    db.prepare('UPDATE chat_settings SET muted_until=? WHERE chat_id=?').run(T0 + HOUR, 'c-loud');
    assert.equal(chatSettings(db, 'u1', 'c-loud', T0).mutedUntil, new Date(T0 + HOUR).toISOString());
    assert.equal(chatSettings(db, 'u1', 'c-loud', T0 + HOUR).muted, false, 'the very moment it ends, the sound is on');
    // Opening again is idempotent.
    db.close();
    const reopened = openDatabase(dataDir);
    assert.deepEqual(Object.fromEntries(reopened.prepare('SELECT chat_id, muted_until FROM chat_settings').all().map(row => [row.chat_id, row.muted_until])), { 'c-quiet': 0, 'c-loud': T0 + HOUR });
    reopened.close();
  } catch (error) { try { db.close(); } catch { /* closed above */ } throw error; }
  assert.equal(mutedAt(null, T0), false); assert.equal(mutedAt(0, T0), true); assert.equal(mutedAt(T0 + 1, T0), true); assert.equal(mutedAt(T0, T0), false);
});
