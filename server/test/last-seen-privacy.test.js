import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { openDatabase, sharesLastSeen, presenceVisible, presenceView, lastSeenBucket, readTimeVisible, privacyOf } from '../src/database.js';
import { MODERATION_SCHEMA } from '../src/moderation.js';
import { grantPermanentPlatina } from '../src/platina-admin.js';
import { syntheticEnvelope, syntheticPublicBundle } from './support/relay-fixtures.js';

// «Время захода» as in Telegram: everyone / contacts (friends) / nobody for everyone (no Platina gate),
// «Всегда показывать» / «Никогда не показывать» exceptions, reciprocity (Platina = Telegram Premium sees
// anyway), approximate buckets instead of the time, and «Скрывать время прочтения».

const DAY = 86_400_000;

async function directory(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-lastseen-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

// ---------------------------------------------------------------- the rules, straight on the database

async function rulesFixture(t) {
  const dataDir = await directory(t);
  const db = openDatabase(dataDir);
  db.exec(MODERATION_SCHEMA);
  t.after(() => db.close());
  const user = name => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,username,login_name,display_name,password_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, name, name, name, 'synthetic-hash', new Date().toISOString(), new Date().toISOString());
    return id;
  };
  const mode = (id, lastSeen, hideReadTime = false, readReceipts = true) => db.prepare(`INSERT INTO user_privacy(user_id,read_receipts,show_last_seen,last_seen,hide_read_time,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET read_receipts=excluded.read_receipts,show_last_seen=excluded.show_last_seen,last_seen=excluded.last_seen,hide_read_time=excluded.hide_read_time`)
    .run(id, readReceipts ? 1 : 0, lastSeen === 'nobody' ? 0 : 1, lastSeen, hideReadTime ? 1 : 0, new Date().toISOString());
  const rule = (owner, other, value) => value
    ? db.prepare('INSERT INTO last_seen_rules(owner_id,user_id,rule,created_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,user_id) DO UPDATE SET rule=excluded.rule').run(owner, other, value, new Date().toISOString())
    : db.prepare('DELETE FROM last_seen_rules WHERE owner_id=? AND user_id=?').run(owner, other);
  const friends = (a, b) => { for (const [x, y] of [[a, b], [b, a]]) db.prepare('INSERT OR IGNORE INTO contacts(owner_id,contact_id,created_at) VALUES(?,?,?)').run(x, y, new Date().toISOString()); };
  const block = (a, b) => db.prepare('INSERT INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(a, b, new Date().toISOString());
  const unblock = (a, b) => db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(a, b);
  const platina = id => grantPermanentPlatina(db, { userId: id, reason: 'Synthetic local test grant' });
  const seen = (id, ms) => db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(new Date(Date.now() - ms).toISOString(), id);
  return { db, user, mode, rule, friends, block, unblock, platina, seen };
}

test('sharesLastSeen: every mode × exception × friendship combination follows Telegram', async t => {
  const f = await rulesFixture(t);
  const owner = f.user('owner'), viewer = f.user('viewer');
  // [mode, friends, rule, expected]
  const table = [
    ['everyone', false, null, true], ['everyone', true, null, true],
    ['everyone', false, 'deny', false], ['everyone', true, 'deny', false],
    ['everyone', false, 'allow', true], // «Всегда» is ignored (and not shown) under «Все»
    ['contacts', false, null, false], ['contacts', true, null, true],
    ['contacts', false, 'allow', true], ['contacts', true, 'deny', false], ['contacts', true, 'allow', true], ['contacts', false, 'deny', false],
    ['nobody', false, null, false], ['nobody', true, null, false],
    ['nobody', false, 'allow', true], ['nobody', true, 'allow', true],
    ['nobody', true, 'deny', false], // «Никогда» is ignored under «Никто» (it is already nobody)
  ];
  for (const [mode, friends, rule, expected] of table) {
    f.db.exec('DELETE FROM contacts');
    if (friends) f.friends(owner, viewer);
    f.mode(owner, mode); f.rule(owner, viewer, rule);
    assert.equal(sharesLastSeen(f.db, owner, viewer), expected, JSON.stringify({ mode, friends, rule }));
  }
  assert.equal(sharesLastSeen(f.db, owner, owner), true, 'one always sees oneself');
  // Only the owner's friend list counts («мои контакты»): a one-way old row from the viewer's side does not.
  f.db.exec('DELETE FROM contacts'); f.rule(owner, viewer, null); f.mode(owner, 'contacts');
  f.db.prepare('INSERT INTO contacts(owner_id,contact_id,created_at) VALUES(?,?,?)').run(viewer, owner, new Date().toISOString());
  assert.equal(sharesLastSeen(f.db, owner, viewer), false);
});

test('presenceVisible: reciprocity, Platina and blocks', async t => {
  const f = await rulesFixture(t);
  const a = f.user('a_vis'), b = f.user('b_vis');
  assert.equal(presenceVisible(f.db, b, a), true, 'defaults: everyone sees everyone');
  // B hides from everyone: A does not see B; B does not see A either (reciprocity).
  f.mode(b, 'nobody');
  assert.equal(presenceVisible(f.db, b, a), false);
  assert.equal(presenceVisible(f.db, a, b), false, 'whoever hides does not see others');
  // …unless B has Platina: then he sees A, whose own settings allow him.
  f.platina(b);
  assert.equal(presenceVisible(f.db, a, b), true, 'Platina sees others although his own is hidden');
  assert.equal(presenceVisible(f.db, b, a), false, 'Platina does not reveal the Platina holder');
  // A's own settings still win over B's Platina.
  f.mode(a, 'nobody');
  assert.equal(presenceVisible(f.db, a, b), false);
  f.rule(a, b, 'allow');
  assert.equal(presenceVisible(f.db, a, b), true, '«Всегда показывать» lets B in');
  // Per-person reciprocity: A shares only with B («Никто» + «Всегда: B»), so A sees B only if B shares with A.
  f.mode(b, 'everyone');
  assert.equal(presenceVisible(f.db, b, a), true, 'A shares with B, so A sees B');
  const c = f.user('c_vis');
  assert.equal(presenceVisible(f.db, c, a), false, 'A hides from C, so A (no Platina) does not see C');
  assert.equal(presenceVisible(f.db, a, c), false);
  f.platina(a);
  assert.equal(presenceVisible(f.db, c, a), true, 'with Platina A sees C');
  // A block hides both ways, Platina or not.
  f.block(a, b);
  assert.equal(presenceVisible(f.db, a, b), false); assert.equal(presenceVisible(f.db, b, a), false);
  f.unblock(a, b); f.block(b, a);
  assert.equal(presenceVisible(f.db, a, b), false); assert.equal(presenceVisible(f.db, b, a), false);
});

test('presence buckets: never the exact time, online hidden too', async t => {
  const f = await rulesFixture(t);
  const now = Date.now();
  assert.equal(lastSeenBucket(null, now, true), 'recently');
  assert.equal(lastSeenBucket(new Date(now - 5 * 60_000).toISOString(), now), 'recently');
  assert.equal(lastSeenBucket(new Date(now - 3 * DAY).toISOString(), now), 'recently');
  assert.equal(lastSeenBucket(new Date(now - 3 * DAY - 1).toISOString(), now), 'week');
  assert.equal(lastSeenBucket(new Date(now - 7 * DAY).toISOString(), now), 'week');
  assert.equal(lastSeenBucket(new Date(now - 8 * DAY).toISOString(), now), 'month');
  assert.equal(lastSeenBucket(new Date(now - 30 * DAY).toISOString(), now), 'month');
  assert.equal(lastSeenBucket(new Date(now - 31 * DAY).toISOString(), now), 'long');
  assert.equal(lastSeenBucket(null, now), 'long');

  const a = f.user('a_bucket'), b = f.user('b_bucket');
  f.seen(b, 2 * 3_600_000);
  const shown = presenceView(f.db, b, a, { online: false, time: Date.now() });
  assert.equal(shown.hidden, false); assert.ok(Date.parse(shown.lastSeenAt) > 0);
  assert.equal('approx' in shown, false);
  f.mode(b, 'nobody');
  for (const [age, bucket] of [[2 * 3_600_000, 'recently'], [5 * DAY, 'week'], [20 * DAY, 'month'], [90 * DAY, 'long']]) {
    f.seen(b, age);
    assert.deepEqual(presenceView(f.db, b, a, { online: false, time: Date.now() }), { userId: b, online: false, lastSeenAt: null, hidden: true, approx: bucket });
  }
  assert.deepEqual(presenceView(f.db, b, a, { online: true, time: Date.now() }), { userId: b, online: false, lastSeenAt: null, hidden: true, approx: 'recently' }, 'online is hidden too');
  // Reciprocity gives buckets as well: B (no Platina) sees A only approximately.
  f.seen(a, 10 * DAY);
  assert.deepEqual(presenceView(f.db, a, b, { online: false, time: Date.now() }), { userId: a, online: false, lastSeenAt: null, hidden: true, approx: 'month' });
  f.platina(b);
  assert.equal(presenceView(f.db, a, b, { online: false, time: Date.now() }).hidden, false, 'Platina: exact time');
  // A block reads as «давно» whatever the real time.
  f.mode(b, 'everyone'); f.seen(b, 60_000); f.block(a, b);
  assert.deepEqual(presenceView(f.db, b, a, { online: true, time: Date.now() }), { userId: b, online: false, lastSeenAt: null, hidden: true, approx: 'long' });
  assert.deepEqual(presenceView(f.db, a, b, { online: true, time: Date.now() }), { userId: a, online: false, lastSeenAt: null, hidden: true, approx: 'long' });
});

test('readTimeVisible: «Скрывать время прочтения» × last seen × Platina × read receipts × blocks', async t => {
  const f = await rulesFixture(t);
  const reader = f.user('reader'), sender = f.user('sender');
  assert.equal(readTimeVisible(f.db, reader, sender), true, 'default: shown');
  // Hiding last seen alone does not hide the read time (Telegram: only with the switch).
  f.mode(reader, 'nobody');
  assert.equal(readTimeVisible(f.db, reader, sender), true);
  f.mode(reader, 'nobody', true);
  assert.equal(readTimeVisible(f.db, reader, sender), false, 'reader hides it from people he hides last seen from');
  f.rule(reader, sender, 'allow');
  assert.equal(readTimeVisible(f.db, reader, sender), true, 'the sender is an exception: shares last seen, so read time too');
  f.rule(reader, sender, null);
  f.mode(reader, 'everyone', true);
  assert.equal(readTimeVisible(f.db, reader, sender), true, 'switch on but last seen shared with the sender: shown');
  f.mode(reader, 'contacts', true);
  assert.equal(readTimeVisible(f.db, reader, sender), false);
  f.friends(reader, sender);
  assert.equal(readTimeVisible(f.db, reader, sender), true, 'friends see it under «Мои контакты»');
  f.db.exec('DELETE FROM contacts');
  f.mode(reader, 'everyone');
  // Reciprocity: the sender turned it on and hides last seen from the reader — he does not see the reader's read time…
  f.mode(sender, 'nobody', true);
  assert.equal(readTimeVisible(f.db, reader, sender), false, 'whoever hides read time does not see others\'');
  f.mode(sender, 'nobody', false);
  assert.equal(readTimeVisible(f.db, reader, sender), true, 'without the switch hiding last seen does not cost read times');
  f.mode(sender, 'nobody', true);
  f.platina(sender);
  assert.equal(readTimeVisible(f.db, reader, sender), true, '…unless he has Platina');
  // Platina does not override the reader's own switch.
  f.mode(reader, 'nobody', true);
  assert.equal(readTimeVisible(f.db, reader, sender), false);
  f.mode(reader, 'everyone', false);
  // Read receipts off (a Platina option) hide the time as before; so does a block.
  f.platina(reader); f.mode(reader, 'everyone', false, false);
  assert.equal(readTimeVisible(f.db, reader, sender), false);
  f.mode(reader, 'everyone', false, true);
  assert.equal(readTimeVisible(f.db, reader, sender), true);
  f.block(sender, reader);
  assert.equal(readTimeVisible(f.db, reader, sender), false);
});

test('migration: the old on/off switch becomes «Все» / «Никто», read-time hiding starts off', async t => {
  const dataDir = await directory(t);
  const ids = {};
  {
    const db = openDatabase(dataDir);
    for (const name of ['shown', 'hidden', 'none']) {
      ids[name] = randomUUID();
      db.prepare('INSERT INTO users(id,username,login_name,display_name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(ids[name], name + '_mig', name + '_mig', name, 'synthetic-hash', new Date().toISOString());
    }
    db.close();
  }
  // Rewind to the previous layout: no last_seen / hide_read_time columns.
  {
    const legacy = new DatabaseSync(path.join(dataDir, 'linea.sqlite'));
    legacy.exec('ALTER TABLE user_privacy DROP COLUMN last_seen; ALTER TABLE user_privacy DROP COLUMN hide_read_time');
    legacy.prepare('INSERT INTO user_privacy(user_id,read_receipts,show_last_seen,updated_at) VALUES(?,?,?,?)').run(ids.shown, 1, 1, new Date().toISOString());
    legacy.prepare('INSERT INTO user_privacy(user_id,read_receipts,show_last_seen,updated_at) VALUES(?,?,?,?)').run(ids.hidden, 0, 0, new Date().toISOString());
    legacy.close();
  }
  const db = openDatabase(dataDir);
  assert.equal(privacyOf(db, ids.shown).lastSeen, 'everyone');
  assert.equal(privacyOf(db, ids.hidden).lastSeen, 'nobody');
  assert.equal(privacyOf(db, ids.hidden).showLastSeen, false);
  assert.equal(privacyOf(db, ids.hidden).readReceipts, false, 'other settings are kept');
  assert.equal(privacyOf(db, ids.none).lastSeen, 'everyone', 'no row: the default');
  for (const id of Object.values(ids)) assert.equal(privacyOf(db, id).hideReadTime, false);
  // Opening again does not re-run the conversion (a later choice is kept).
  db.prepare("UPDATE user_privacy SET last_seen='contacts' WHERE user_id=?").run(ids.hidden);
  db.close();
  const again = openDatabase(dataDir);
  assert.equal(privacyOf(again, ids.hidden).lastSeen, 'contacts');
  again.close();
});

// ---------------------------------------------------------------- the HTTP API and live pushes

const PASSWORD = 'correct-horse-42';
const RECOVERY_WORD = 'SilverHarborLantern';
const CONFIRMATION_WORD = 'AmberGardenPrism';

async function appFixture(t) {
  const dataDir = await directory(t);
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000 });
  await app.ready();
  t.after(() => app.close());
  return { app, dataDir };
}
const request = (app, method, url, account, payload) => app.inject({ method, url, headers: account ? { authorization: `Bearer ${account.token}` } : {}, ...(payload === undefined ? {} : { payload }) });
async function register(app, username) {
  const response = await request(app, 'POST', '/auth/register', null, { username, displayName: username, password: PASSWORD, recoveryWord: RECOVERY_WORD, confirmationWord: CONFIRMATION_WORD });
  assert.equal(response.statusCode, 201, response.body);
  const result = response.json();
  const registered = await request(app, 'POST', '/e2ee/devices', result, syntheticPublicBundle());
  assert.equal(registered.statusCode, 200, registered.body);
  result.device = registered.json().device;
  return result;
}
async function newChat(app, from, to) {
  const response = await request(app, 'POST', '/chats', from, { userId: to.user.id });
  assert.ok([200, 201].includes(response.statusCode), response.body);
  return { ...response.json().chat, relayDevices: [from.device, to.device] };
}
async function send(app, from, chat) {
  const response = await request(app, 'POST', `/chats/${chat.id}/messages`, from, { clientId: randomUUID(), encrypted: syntheticEnvelope(from.device, chat.relayDevices.filter(device => device.id !== from.device.id), []) });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().message;
}
function withDb(dataDir, work) { const db = new DatabaseSync(path.join(dataDir, 'linea.sqlite')); try { return work(db); } finally { db.close(); } }
async function socketFor(t, app, account) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const packets = [], listeners = new Set();
  socket.on('message', raw => { const packet = JSON.parse(raw.toString()); packets.push(packet); for (const listener of [...listeners]) listener(packet); });
  socket.on('error', () => {});
  t.after(() => socket.terminate());
  const next = (predicate, { from = 0, timeout = 3000 } = {}) => {
    const existing = packets.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Timed out; received ${JSON.stringify(packets)}`)); }, timeout);
      const listener = packet => { if (!predicate(packet)) return; clearTimeout(timer); listeners.delete(listener); resolve(packet); };
      listeners.add(listener);
    });
  };
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: account.token }));
  await next(packet => packet.type === 'ready');
  return { socket, packets, next };
}

test('API: modes are free, validated, and the old switch still maps; exceptions are private lists', async t => {
  const { app } = await appFixture(t);
  const alice = await register(app, 'alice_ls'), bob = await register(app, 'bob_ls'), carol = await register(app, 'carol_ls');
  for (const lastSeen of ['contacts', 'nobody', 'everyone']) {
    const response = await request(app, 'PATCH', '/me/privacy', alice, { lastSeen });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().privacy.lastSeen, lastSeen, 'no Platina needed');
    assert.equal(response.json().privacy.showLastSeen, lastSeen !== 'nobody');
  }
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { lastSeen: 'friends' })).statusCode, 400);
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { hideReadTime: 'yes' })).statusCode, 400);
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { hideReadTime: true })).json().privacy.hideReadTime, true, 'hiding read time is free too');
  assert.deepEqual((await request(app, 'GET', '/me/privacy', alice)).json().platinaOnly, ['readReceipts']);
  // Older apps: off → «Никто»; on → back to «Все», but «Мои контакты» stays.
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { showLastSeen: false })).json().privacy.lastSeen, 'nobody');
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { showLastSeen: true })).json().privacy.lastSeen, 'everyone');
  await request(app, 'PATCH', '/me/privacy', alice, { lastSeen: 'contacts' });
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { showLastSeen: true })).json().privacy.lastSeen, 'contacts');

  assert.deepEqual((await request(app, 'GET', '/me/last-seen-rules', alice)).json(), { allow: [], deny: [] });
  let rules = (await request(app, 'PUT', `/me/last-seen-rules/${bob.user.id}`, alice, { rule: 'allow' })).json();
  assert.deepEqual(rules.allow.map(user => user.id), [bob.user.id]);
  rules = (await request(app, 'PUT', `/me/last-seen-rules/${carol.user.id}`, alice, { rule: 'deny' })).json();
  assert.deepEqual([rules.allow.map(user => user.id), rules.deny.map(user => user.id)], [[bob.user.id], [carol.user.id]]);
  rules = (await request(app, 'PUT', `/me/last-seen-rules/${bob.user.id}`, alice, { rule: 'deny' })).json();
  assert.deepEqual([rules.allow.length, rules.deny.length], [0, 2], 'moving someone takes him out of the other list');
  assert.equal(rules.deny[0].birthday, undefined, 'only public profile fields');
  rules = (await request(app, 'DELETE', `/me/last-seen-rules/${bob.user.id}`, alice)).json();
  assert.deepEqual(rules.deny.map(user => user.id), [carol.user.id]);
  assert.equal((await request(app, 'PUT', `/me/last-seen-rules/${alice.user.id}`, alice, { rule: 'allow' })).statusCode, 400, 'not oneself');
  assert.equal((await request(app, 'PUT', `/me/last-seen-rules/${randomUUID()}`, alice, { rule: 'allow' })).statusCode, 404);
  assert.equal((await request(app, 'PUT', `/me/last-seen-rules/${bob.user.id}`, alice, { rule: 'maybe' })).statusCode, 400);
  assert.equal((await request(app, 'PUT', '/me/last-seen-rules/not-a-user', alice, { rule: 'allow' })).statusCode, 400);
  assert.equal((await request(app, 'GET', '/me/last-seen-rules', null)).statusCode, 401);
  assert.deepEqual((await request(app, 'GET', '/me/last-seen-rules', carol)).json(), { allow: [], deny: [] }, 'each list is private to its owner');
});

test('live: an exception and a friendship re-send presence to chat peers only; buckets, not times', async t => {
  const { app, dataDir } = await appFixture(t);
  const alice = await register(app, 'alice_live'), bob = await register(app, 'bob_live'), eve = await register(app, 'eve_live');
  await newChat(app, alice, bob);
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { lastSeen: 'nobody' })).statusCode, 200);
  withDb(dataDir, db => db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(new Date(Date.now() - 10 * DAY).toISOString(), alice.user.id));
  const bobSocket = await socketFor(t, app, bob);
  const first = (await bobSocket.next(packet => packet.type === 'presence.snapshot')).items.find(item => item.userId === alice.user.id);
  assert.deepEqual(first, { userId: alice.user.id, online: false, lastSeenAt: null, hidden: true, approx: 'month' });
  const eveSocket = await socketFor(t, app, eve);
  // «Всегда показывать: Bob» — Bob gets Alice's real state at once.
  let marker = bobSocket.packets.length;
  assert.equal((await request(app, 'PUT', `/me/last-seen-rules/${bob.user.id}`, alice, { rule: 'allow' })).statusCode, 200);
  const shown = await bobSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id, { from: marker });
  assert.equal(shown.presence.hidden, false);
  assert.ok(Date.parse(shown.presence.lastSeenAt) < Date.now() - 9 * DAY);
  // «Мои контакты»: becoming friends shows it, ending the friendship hides it again.
  assert.equal((await request(app, 'DELETE', `/me/last-seen-rules/${bob.user.id}`, alice)).statusCode, 200);
  await bobSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id && packet.presence.hidden, { from: marker + 1 });
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { lastSeen: 'contacts' })).statusCode, 200);
  marker = bobSocket.packets.length;
  await request(app, 'PUT', `/contacts/${alice.user.id}`, bob);
  assert.equal((await request(app, 'POST', `/friends/requests/${bob.user.id}/accept`, alice)).statusCode, 200);
  await bobSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id && !packet.presence.hidden, { from: marker });
  marker = bobSocket.packets.length;
  assert.equal((await request(app, 'DELETE', `/contacts/${bob.user.id}`, alice)).statusCode, 200);
  const gone = await bobSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id, { from: marker });
  assert.deepEqual([gone.presence.hidden, gone.presence.approx], [true, 'month']);
  // Eve shares no chat: an exception for her pushes nothing.
  assert.equal((await request(app, 'PUT', `/me/last-seen-rules/${eve.user.id}`, alice, { rule: 'allow' })).statusCode, 200);
  eveSocket.socket.send(JSON.stringify({ type: 'ping' })); await eveSocket.next(packet => packet.type === 'pong');
  assert.equal(eveSocket.packets.some(packet => packet.type === 'presence'), false);
});

test('read-date: «Скрывать время прочтения» hides «прочитано в …» but not the checkmarks', async t => {
  const { app, dataDir } = await appFixture(t);
  const alice = await register(app, 'alice_rt'), bob = await register(app, 'bob_rt');
  const chat = await newChat(app, alice, bob);
  const toBob = await send(app, alice, chat), toAlice = await send(app, bob, chat);
  assert.equal((await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: toBob.id })).statusCode, 200);
  assert.equal((await request(app, 'POST', `/chats/${chat.id}/read`, alice, { messageId: toAlice.id })).statusCode, 200);
  const readDate = (who, message) => request(app, 'GET', `/chats/${chat.id}/messages/${message.id}/read-date`, who).then(response => response.json());
  const checks = who => request(app, 'GET', '/chats', who).then(response => response.json().chats[0].peerLastReadMessageId);
  assert.ok((await readDate(alice, toBob)).readAt);
  // Bob hides his last seen from everyone and turns the switch on.
  await request(app, 'PATCH', '/me/privacy', bob, { lastSeen: 'nobody', hideReadTime: true });
  assert.deepEqual(await readDate(alice, toBob), { readAt: null, reason: 'hidden' }, 'Alice does not see when Bob read');
  assert.deepEqual(await readDate(bob, toAlice), { readAt: null, reason: 'hidden' }, 'and Bob does not see when Alice read');
  assert.equal(await checks(alice), toBob.id, 'the checkmarks still work');
  assert.equal(await checks(bob), toAlice.id);
  // Platina: Bob sees Alice's read time although he hides his own.
  withDb(dataDir, db => grantPermanentPlatina(db, { userId: bob.user.id, reason: 'Synthetic local test grant' }));
  assert.ok((await readDate(bob, toAlice)).readAt);
  assert.deepEqual(await readDate(alice, toBob), { readAt: null, reason: 'hidden' });
  // An exception for Alice brings Bob's read time back for her.
  await request(app, 'PUT', `/me/last-seen-rules/${alice.user.id}`, bob, { rule: 'allow' });
  assert.ok((await readDate(alice, toBob)).readAt);
});
