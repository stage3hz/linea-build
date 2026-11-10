import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { syntheticEnvelope, syntheticPublicBundle } from './support/relay-fixtures.js';
import { grantPermanentPlatina } from '../src/platina-admin.js';

// Audit group S2: sliding sessions (B18), public pages behind the client gate (B34), capped push
// counters (B36), typing and presence/receipts/avatar hidden by a block (B51, B35), last_seen_at
// written at sign-in, periodically and at shutdown (B69).

const PASSWORD = 'correct-horse-42';
const RECOVERY_WORD = 'SilverHarborLantern';
const CONFIRMATION_WORD = 'AmberGardenPrism';
const MINUTE = 60_000;

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-s2-test-'));
  const instances = [];
  const open = async (overrides = {}) => {
    const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, ...options, ...overrides });
    await app.ready();
    instances.push(app);
    return app;
  };
  t.after(async () => {
    for (const instance of instances.reverse()) await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app: await open(), open, dataDir };
}

function readDatabase(dataDir, read) {
  const database = new DatabaseSync(path.join(dataDir, 'linea.sqlite'));
  try { return read(database); } finally { database.close(); }
}

async function request(app, method, url, account, payload) {
  return app.inject({ method, url, headers: account ? { authorization: `Bearer ${account.token}` } : {}, ...(payload === undefined ? {} : { payload }) });
}

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

const envelopeFor = (from, chat) => syntheticEnvelope(from.device, chat.relayDevices.filter(device => device.id !== from.device.id), []);

async function send(app, from, chat, clientId) {
  const response = await request(app, 'POST', `/chats/${chat.id}/messages`, from, { clientId, encrypted: envelopeFor(from, chat) });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().message;
}

async function socketFor(t, app, account) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const packets = [];
  const listeners = new Set();
  socket.on('message', raw => { const packet = JSON.parse(raw.toString()); packets.push(packet); for (const listener of [...listeners]) listener(packet); });
  socket.on('error', () => {});
  t.after(() => { socket.terminate(); });
  const next = (predicate, { from = 0, timeout = 3000 } = {}) => {
    const existing = packets.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Timed out waiting for WebSocket packet; received ${JSON.stringify(packets)}`)); }, timeout);
      const listener = packet => { if (!predicate(packet)) return; clearTimeout(timer); listeners.delete(listener); resolve(packet); };
      listeners.add(listener);
    });
  };
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: account.token }));
  assert.equal((await next(packet => packet.type === 'ready')).userId, account.user.id);
  return { socket, packets, next };
}

// A ping/pong round trip is an ordering barrier: anything sent to the socket before it has arrived.
async function settle(socket) {
  const marker = socket.packets.length;
  socket.socket.send(JSON.stringify({ type: 'ping' }));
  await socket.next(packet => packet.type === 'pong', { from: marker });
}

test('B18: a session in use slides past the TTL; an idle one still expires', async t => {
  let clock = Date.now();
  const { app } = await fixture(t, { now: () => clock, sessionTtlMs: 2 * MINUTE });
  const alice = await register(app, 'alice_slide'), bob = await register(app, 'bob_idle');
  const before = (await request(app, 'GET', '/auth/sessions', alice)).json();
  clock += 1.5 * MINUTE;
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 200);
  clock += 1.5 * MINUTE;
  // 3 minutes after sign-in: without the sliding window this would be a 401.
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 200, 'an active session is renewed');
  const after = (await request(app, 'GET', '/auth/sessions', alice)).json();
  assert.ok(JSON.stringify(after) !== JSON.stringify(before), 'the expiry shown on the security screen moved');
  assert.equal((await request(app, 'GET', '/me', bob)).statusCode, 401, 'an idle session still expires after the TTL');
});

test('B34: public browser pages pass the client gate with REQUIRE_CLIENT_HEADER', async t => {
  const { app } = await fixture(t, { minClientVersion: '0.14.2', requireClientHeader: true });
  for (const url of ['/privacy', '/support', '/i/AbCdEf123', '/i/AbCdEf123?utm=x']) {
    const page = await app.inject({ method: 'GET', url });
    assert.equal(page.statusCode, 200, `${url}: ${page.body}`);
    assert.match(page.headers['content-type'], /text\/html/);
  }
  const api = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
  assert.equal(api.statusCode, 426, 'the API itself is still gated');
  assert.equal(api.json().code, 'CLIENT_UNKNOWN');
  // A prefix match must not open unrelated routes.
  assert.equal((await app.inject({ method: 'GET', url: '/invites' })).statusCode, 426);
});

test('B36: push unread counters are capped at 9 999 per chat instead of counting the whole pile', async t => {
  const sent = [];
  const { app, dataDir } = await fixture(t, { push: async (token, message) => { sent.push({ token, message }); return 'ok'; } });
  const alice = await register(app, 'alice_pile'), bob = await register(app, 'bob_pile');
  const chat = await newChat(app, alice, bob);
  assert.equal((await request(app, 'PUT', '/me/push', bob, { token: 'fcm-token-bob-000000000000', platform: 'android' })).statusCode, 200);
  readDatabase(dataDir, db => {
    const insert = db.prepare("INSERT INTO messages(chat_id,sender_id,client_id,encrypted_json,created_at) VALUES(?,?,?,'{}',?)");
    db.exec('BEGIN');
    for (let i = 0; i < 12_000; i++) insert.run(chat.id, alice.user.id, `pile-${i}`, new Date().toISOString());
    db.exec('COMMIT');
  });
  await send(app, alice, chat, 'pile-last-000001');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.android.notification.body, '9999 новых сообщений');
  assert.equal(sent[0].message.apns.payload.aps.badge, 9999, 'the icon badge is capped like the chat list');
});

test('B51 + B35: a block hides typing, presence, read receipts and the avatar from the blocked person', async t => {
  const { app, dataDir } = await fixture(t);
  const alice = await register(app, 'alice_block'), bob = await register(app, 'bob_block');
  const chat = await newChat(app, alice, bob);
  const message = await send(app, alice, chat, 'block-msg-000001');
  readDatabase(dataDir, db => db.prepare('UPDATE users SET avatar_id=? WHERE id=?').run('11111111-1111-4111-8111-111111111111', alice.user.id));
  const bobSocket = await socketFor(t, app, bob), aliceSocket = await socketFor(t, app, alice);
  await bobSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id && packet.presence.online);

  assert.equal((await request(app, 'PUT', `/blocks/${bob.user.id}`, alice)).statusCode, 200);
  // Typing: neither direction.
  aliceSocket.socket.send(JSON.stringify({ type: 'typing', chatId: chat.id, isTyping: true }));
  bobSocket.socket.send(JSON.stringify({ type: 'typing', chatId: chat.id, isTyping: true }));
  await settle(aliceSocket); await settle(bobSocket);
  assert.equal(bobSocket.packets.some(packet => packet.type === 'typing'), false, 'the blocked person does not see the blocker typing');
  assert.equal(aliceSocket.packets.some(packet => packet.type === 'typing'), false, 'the blocker does not see the blocked person typing');
  // Presence: hidden both ways, no last seen; the avatar is gone for the blocked one only.
  const bobView = (await request(app, 'GET', `/users/${alice.user.id}`, bob)).json();
  assert.equal(bobView.user.avatarId, null, 'the blocker\'s avatar is hidden from the blocked person');
  assert.equal((await request(app, 'GET', `/chats`, bob)).json().chats[0].peer.avatarId, null);
  const aliceView = (await request(app, 'GET', `/users/${bob.user.id}`, alice)).json();
  assert.equal(aliceView.blocked, true);
  const freshBob = await socketFor(t, app, bob);
  const snapshot = await freshBob.next(packet => packet.type === 'presence.snapshot');
  assert.deepEqual(snapshot.items.map(item => [item.userId, item.online, item.hidden, item.lastSeenAt]), [[alice.user.id, false, true, null]]);
  // Read receipts: Bob reading does not reach Alice; the chat list hides the pointer.
  const marker = aliceSocket.packets.length;
  assert.equal((await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: message.id })).statusCode, 200);
  await settle(aliceSocket);
  assert.equal(aliceSocket.packets.slice(marker).some(packet => packet.type === 'read'), false);
  assert.equal((await request(app, 'GET', `/chats`, alice)).json().chats[0].peerLastReadMessageId, 0);
  assert.equal((await request(app, 'GET', `/chats/${chat.id}/messages/${message.id}/read-date`, alice)).json().reason, 'hidden');

  // Unblocking restores everything.
  assert.equal((await request(app, 'DELETE', `/blocks/${bob.user.id}`, alice)).statusCode, 200);
  aliceSocket.socket.send(JSON.stringify({ type: 'typing', chatId: chat.id, isTyping: true }));
  await bobSocket.next(packet => packet.type === 'typing' && packet.userId === alice.user.id);
  assert.equal((await request(app, 'GET', `/users/${alice.user.id}`, bob)).json().user.avatarId, '11111111-1111-4111-8111-111111111111');
  assert.equal((await request(app, 'GET', `/chats`, alice)).json().chats[0].peerLastReadMessageId, message.id);
});

test('B69: last_seen_at is written at sign-in and at shutdown, not only when a socket closes', async t => {
  const { app, dataDir } = await fixture(t);
  const alice = await register(app, 'alice_seen');
  const lastSeen = () => readDatabase(dataDir, db => db.prepare('SELECT last_seen_at FROM users WHERE id=?').get(alice.user.id).last_seen_at);
  assert.equal(lastSeen(), null);
  await socketFor(t, app, alice);
  const atSignIn = lastSeen();
  assert.ok(Number.isFinite(Date.parse(atSignIn)), 'written when the socket authenticates');
  await new Promise(resolve => setTimeout(resolve, 20));
  // app.close() terminates sockets before the database closes: the close events would be lost.
  await app.close();
  const atShutdown = lastSeen();
  assert.ok(Number.isFinite(Date.parse(atShutdown)));
  assert.ok(Date.parse(atShutdown) >= Date.parse(atSignIn), 'refreshed at shutdown');
});

test('review S2: no presence packet reaches a blocked peer when the blocker connects or disconnects', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice_quiet'), bob = await register(app, 'bob_quiet'), carol = await register(app, 'carol_quiet');
  await newChat(app, alice, bob); await newChat(app, alice, carol);
  const bobSocket = await socketFor(t, app, bob), carolSocket = await socketFor(t, app, carol);
  assert.equal((await request(app, 'PUT', `/blocks/${bob.user.id}`, alice)).statusCode, 200);
  // The block itself is announced once, as hidden, so Bob's cached «в сети» goes away.
  const onBlock = await bobSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id);
  assert.deepEqual([onBlock.presence.hidden, onBlock.presence.online, onBlock.presence.lastSeenAt], [true, false, null]);
  await bobSocket.next(packet => packet.type === 'chat' && packet.chat.peer.id === alice.user.id, { from: 0 });
  const marker = bobSocket.packets.length;
  const aliceSocket = await socketFor(t, app, alice);
  await carolSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id && packet.presence.online);
  aliceSocket.socket.close();
  await carolSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id && !packet.presence.online);
  await settle(bobSocket);
  assert.deepEqual(bobSocket.packets.slice(marker).filter(packet => packet.type === 'presence'), [], 'Bob is told nothing about Alice coming and going');
  // Unblocking announces the real state again, to both.
  assert.equal((await request(app, 'DELETE', `/blocks/${bob.user.id}`, alice)).statusCode, 200);
  const restored = await bobSocket.next(packet => packet.type === 'presence' && packet.presence.userId === alice.user.id, { from: marker });
  assert.equal(restored.presence.hidden, false);
  assert.ok(Number.isFinite(Date.parse(restored.presence.lastSeenAt)));
  // A repeated DELETE changes nothing and sends nothing.
  const quiet = bobSocket.packets.length;
  assert.equal((await request(app, 'DELETE', `/blocks/${bob.user.id}`, alice)).statusCode, 200);
  await settle(bobSocket);
  assert.equal(bobSocket.packets.slice(quiet).some(packet => packet.type === 'presence' || packet.type === 'chat'), false);
});

test('review S2: a block pushes the hidden presence and a chat refresh to the blocker too', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice_push'), bob = await register(app, 'bob_push');
  const chat = await newChat(app, alice, bob);
  const aliceSocket = await socketFor(t, app, alice), bobSocket = await socketFor(t, app, bob);
  await aliceSocket.next(packet => packet.type === 'presence' && packet.presence.userId === bob.user.id && packet.presence.online);
  const marker = aliceSocket.packets.length;
  assert.equal((await request(app, 'PUT', `/blocks/${bob.user.id}`, alice)).statusCode, 200);
  const hidden = await aliceSocket.next(packet => packet.type === 'presence' && packet.presence.userId === bob.user.id, { from: marker });
  assert.deepEqual([hidden.presence.hidden, hidden.presence.online], [true, false]);
  const refreshed = await aliceSocket.next(packet => packet.type === 'chat' && packet.chat.id === chat.id, { from: marker });
  assert.equal(refreshed.chat.peer.id, bob.user.id);
  await bobSocket.next(packet => packet.type === 'chat' && packet.chat.id === chat.id);
});

test('review S2: hiding «last seen» is announced to peers (as hidden) and re-sent to the account itself', async t => {
  const { app, dataDir } = await fixture(t);
  const alice = await register(app, 'alice_hide'), bob = await register(app, 'bob_hide');
  await newChat(app, alice, bob);
  const aliceSocket = await socketFor(t, app, alice), bobSocket = await socketFor(t, app, bob);
  await aliceSocket.next(packet => packet.type === 'presence' && packet.presence.userId === bob.user.id && packet.presence.online);
  // «Время захода» is free now (Telegram); the old on/off switch still works and means «Никто».
  const marker = aliceSocket.packets.length, own = bobSocket.packets.length;
  assert.equal((await request(app, 'PATCH', '/me/privacy', bob, { showLastSeen: false })).statusCode, 200);
  const hidden = await aliceSocket.next(packet => packet.type === 'presence' && packet.presence.userId === bob.user.id, { from: marker });
  assert.deepEqual([hidden.presence.hidden, hidden.presence.online, hidden.presence.lastSeenAt, hidden.presence.approx], [true, false, null, 'recently']);
  const snapshot = await bobSocket.next(packet => packet.type === 'presence.snapshot', { from: own });
  assert.deepEqual(snapshot.items.map(item => [item.userId, item.hidden]), [[alice.user.id, true]], 'reciprocal: Bob (no Platina) no longer sees Alice either');
  // Showing it again is announced too, with the real state.
  assert.equal((await request(app, 'PATCH', '/me/privacy', bob, { showLastSeen: true })).statusCode, 200);
  const shown = await aliceSocket.next(packet => packet.type === 'presence' && packet.presence.userId === bob.user.id && !packet.presence.hidden, { from: marker + 1 });
  assert.equal(shown.presence.online, true);
});

test('review S2: the maintenance tick records last seen for everyone online in one write and slides their sessions', async t => {
  let clock = Date.now();
  const { app, dataDir } = await fixture(t, { now: () => clock, sessionTtlMs: 3 * MINUTE, maintenanceIntervalMs: 200 });
  const accounts = [await register(app, 'alice_tick'), await register(app, 'bob_tick'), await register(app, 'carol_tick')];
  const sockets = [];
  for (const account of accounts) sockets.push(await socketFor(t, app, account));
  const rows = () => readDatabase(dataDir, db => accounts.map(account => ({
    seen: db.prepare('SELECT last_seen_at FROM users WHERE id=?').get(account.user.id).last_seen_at,
    expires: db.prepare('SELECT expires_at FROM sessions WHERE user_id=?').get(account.user.id).expires_at,
  })));
  const before = rows();
  clock += 2 * MINUTE;
  await new Promise(resolve => setTimeout(resolve, 600));
  const after = rows();
  for (let i = 0; i < accounts.length; i++) {
    assert.equal(after[i].seen, new Date(clock).toISOString(), `${accounts[i].user.username}: last seen written by the tick`);
    assert.equal(after[i].expires, clock + 3 * MINUTE, 'the WebSocket-only session slid');
    assert.ok(after[i].expires > before[i].expires);
  }
  // The same statement wrote all three: one timestamp for the batch.
  assert.equal(new Set(after.map(row => row.seen)).size, 1);
  // 4 minutes after sign-in the sessions are still alive without a single HTTP request in between.
  clock += 1.5 * MINUTE;
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await request(app, 'GET', '/me', accounts[0])).statusCode, 200);
  for (const socket of sockets) assert.equal(socket.socket.readyState, 1, 'the sockets were not closed as expired');
});

test('review S2: the database file is switched to WAL mode', async t => {
  const { dataDir } = await fixture(t);
  readDatabase(dataDir, db => {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal', 'persisted in the file: a fresh connection sees it');
  });
});
