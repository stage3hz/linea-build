import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { createPush } from '../src/push.js';
import { autoRoomName } from '../src/rooms.js';

const ANDROID_TOKEN = 'fcm-registration-token:APA91bExample_1234567890';

async function request(app, method, url, account, payload) {
  return app.inject({ method, url, headers: account ? { authorization: `Bearer ${account.token}` } : {}, ...(payload === undefined ? {} : { payload }) });
}
async function register(app, username, displayName = username) {
  const response = await request(app, 'POST', '/auth/register', null, { username, displayName, password: 'correct-horse-42', recoveryWord: 'SilverHarborLantern', confirmationWord: 'AmberGardenPrism' });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
// A friend request and its acceptance: both rows in `contacts`.
async function befriend(app, a, b) {
  assert.equal((await request(app, 'PUT', `/contacts/${b.user.id}`, a)).json().status, 'requested');
  assert.equal((await request(app, 'PUT', `/contacts/${a.user.id}`, b)).json().status, 'friends');
}
async function socketFor(t, app, account) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const packets = [];
  const listeners = new Set();
  socket.on('message', raw => { const packet = JSON.parse(raw.toString()); packets.push(packet); for (const listener of [...listeners]) listener(packet); });
  socket.on('error', () => {});
  t.after(() => { socket.terminate(); });
  const next = (predicate, timeout = 3000) => {
    const existing = packets.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Timed out; received ${JSON.stringify(packets)}`)); }, timeout);
      const listener = packet => { if (!predicate(packet)) return; clearTimeout(timer); listeners.delete(listener); resolve(packet); };
      listeners.add(listener);
    });
  };
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: account.token }));
  assert.equal((await next(packet => packet.type === 'ready')).userId, account.user.id);
  const send = payload => socket.send(JSON.stringify(payload));
  return { socket, packets, next, send };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** An app with `names.length` accounts, every two of them friends. */
async function fixture(t, names, options = {}) {
  const dataDir = await mkdtemp(joinPath(tmpdir(), 'linea-rooms-'));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: false, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const people = [];
  for (const [username, displayName] of names) people.push(await register(app, username, displayName));
  for (let i = 0; i < people.length; i++) for (const other of people.slice(i + 1)) await befriend(app, people[i], other);
  return { app, people, dataDir };
}
const createRoom = (app, who, others, name) => request(app, 'POST', '/rooms', who, { memberIds: others.map(p => p.user.id), ...(name === undefined ? {} : { name }) });

test('rooms: the automatic name', () => {
  assert.equal(autoRoomName(['Лариса']), 'Лариса');
  assert.equal(autoRoomName(['Лариса', 'Тимур', 'Анна']), 'Лариса, Тимур, Анна');
  assert.equal(autoRoomName(['Лариса', 'Тимур', 'Анна', 'Олег']), 'Лариса, Тимур и ещё 2');
});

test('rooms: create, the same set returns the same room, friends only, no blocks, at most 12', async t => {
  const names = [['room_owner', 'Вера'], ['room_lara', 'Лариса'], ['room_timur', 'Тимур'], ['room_anna', 'Анна']];
  for (let i = 0; i < 10; i++) names.push([`room_extra_${i}`, `Гость ${i}`]);
  const { app, people } = await fixture(t, names);
  const [owner, lara, timur, anna] = people;
  const extras = people.slice(4);
  const befriendAgain = async (blocker, other) => {
    assert.equal((await request(app, 'DELETE', `/blocks/${other.user.id}`, blocker)).statusCode, 200);
    await befriend(app, blocker, other);
  };

  assert.equal((await request(app, 'POST', '/rooms', null, { memberIds: [lara.user.id] })).statusCode, 401);
  const created = await createRoom(app, owner, [lara, timur]);
  assert.equal(created.statusCode, 201, created.body);
  const { room } = created.json();
  assert.equal(created.json().created, true);
  assert.deepEqual(Object.keys(room).sort(), ['auto', 'awake', 'createdAt', 'id', 'inside', 'lastActiveAt', 'members', 'name'].sort());
  assert.equal(room.auto, true);
  assert.equal(room.name, 'Лариса, Тимур');
  assert.deepEqual(room.members.map(m => m.id), [owner.user.id, lara.user.id, timur.user.id]);
  assert.deepEqual(Object.keys(room.members[0]).sort(), ['avatarColor', 'avatarId', 'displayName', 'id', 'username']);
  assert.deepEqual(room.inside, []);
  assert.equal(room.awake, false);
  assert.equal(room.lastActiveAt, null);
  assert.equal(typeof room.createdAt, 'string');

  // The same people in another order, with a duplicate and the caller's own id: the same room.
  const again = await request(app, 'POST', '/rooms', owner, { memberIds: [timur.user.id, lara.user.id, timur.user.id, owner.user.id] });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().created, false);
  assert.equal(again.json().room.id, room.id);
  // A subset is a different room.
  const pair = await createRoom(app, owner, [lara]);
  assert.equal(pair.json().created, true);
  assert.notEqual(pair.json().room.id, room.id);

  // Соло is a friend of Вера only: Лариса cannot make a room with him…
  const solo = await register(app, 'room_solo', 'Соло');
  await befriend(app, owner, solo);
  const stranger = await createRoom(app, lara, [solo]);
  assert.equal(stranger.statusCode, 403);
  assert.equal(stranger.json().error, 'В комнату можно позвать только друзей.');
  // …and Вера cannot put the two in one room either: every two members must be friends.
  const pairless = await createRoom(app, owner, [lara, solo]);
  assert.equal(pairless.statusCode, 403);
  assert.equal(pairless.json().error, stranger.json().error, 'the same answer whichever pair it is');
  assert.equal((await createRoom(app, owner, [solo])).statusCode, 201);
  // A block between two guests refuses the room as well.
  assert.equal((await request(app, 'PUT', `/blocks/${extras[0].user.id}`, extras[1])).statusCode, 200);
  assert.equal((await createRoom(app, owner, [extras[0], extras[1]])).statusCode, 403);
  await befriendAgain(extras[1], extras[0]);
  // A one-sided contact is not enough, and an unknown account reads the same.
  assert.equal((await request(app, 'POST', '/rooms', owner, { memberIds: [randomUUID()] })).statusCode, 403);

  // A block in either direction refuses the room, even between friends.
  assert.equal((await request(app, 'PUT', `/blocks/${owner.user.id}`, anna)).statusCode, 200);
  const blocked = await createRoom(app, owner, [anna]);
  assert.equal(blocked.statusCode, 403);
  const blockedBack = await createRoom(app, anna, [owner]);
  assert.equal(blockedBack.statusCode, 403);

  // Nobody else, only myself, junk: 400.
  assert.equal((await request(app, 'POST', '/rooms', owner, { memberIds: [] })).statusCode, 400);
  assert.equal((await request(app, 'POST', '/rooms', owner, { memberIds: [owner.user.id] })).statusCode, 400);
  assert.equal((await request(app, 'POST', '/rooms', owner, { memberIds: ['nope'] })).statusCode, 400);
  assert.equal((await request(app, 'POST', '/rooms', owner, { memberIds: 'x' })).statusCode, 400);

  // 11 others is the most (12 with the caller); 12 others is refused.
  const full = await createRoom(app, owner, [lara, ...extras]);
  assert.equal(full.statusCode, 201, full.body);
  assert.equal(full.json().room.members.length, 12);
  assert.equal(full.json().room.name, 'Лариса, Гость 0 и ещё 9');
  const tooMany = await createRoom(app, owner, [lara, timur, ...extras]);
  assert.equal(tooMany.statusCode, 400);
  assert.match(tooMany.json().error, /12/);
});

test('rooms: the list and the automatic name are made for each viewer; rename and reset', async t => {
  const { app, people } = await fixture(t, [['list_owner', 'Вера'], ['list_lara', 'Лариса'], ['list_timur', 'Тимур'], ['list_other', 'Чужой']]);
  const [owner, lara, timur, outsider] = people;
  const ownerSocket = await socketFor(t, app, owner), laraSocket = await socketFor(t, app, lara);
  const room = (await createRoom(app, owner, [lara, timur])).json().room;
  const event = await laraSocket.next(p => p.type === 'room.created');
  assert.equal(event.room.id, room.id);
  assert.equal(event.room.name, 'Вера, Тимур', 'the event carries the name as its receiver sees it');

  const list = async who => (await request(app, 'GET', '/rooms', who)).json().rooms;
  assert.deepEqual((await list(owner)).map(r => r.name), ['Лариса, Тимур']);
  assert.deepEqual((await list(lara)).map(r => r.name), ['Вера, Тимур']);
  assert.deepEqual((await list(timur)).map(r => r.name), ['Вера, Лариса']);
  assert.deepEqual(await list(outsider), []);
  assert.equal((await request(app, 'GET', '/rooms')).statusCode, 401);

  // Any member renames; the name is trimmed; everyone is told.
  const renamed = await request(app, 'PATCH', `/rooms/${room.id}`, lara, { name: '  Кухня  ' });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().room.name, 'Кухня');
  assert.equal(renamed.json().room.auto, false);
  const updated = await ownerSocket.next(p => p.type === 'room.updated' && p.room.name === 'Кухня');
  assert.equal(updated.room.id, room.id);
  assert.deepEqual((await list(timur)).map(r => [r.name, r.auto]), [['Кухня', false]]);
  assert.equal((await request(app, 'PATCH', `/rooms/${room.id}`, lara, { name: 'я'.repeat(49) })).statusCode, 400);
  assert.equal((await request(app, 'PATCH', `/rooms/${room.id}`, lara, { name: 5 })).statusCode, 400);
  assert.equal((await request(app, 'PATCH', `/rooms/${room.id}`, outsider, { name: 'Моя' })).statusCode, 404);
  assert.equal((await request(app, 'PATCH', `/rooms/${randomUUID()}`, lara, { name: 'Моя' })).statusCode, 404);
  // An empty name brings the automatic one back.
  const reset = await request(app, 'PATCH', `/rooms/${room.id}`, owner, { name: '' });
  assert.equal(reset.json().room.auto, true);
  assert.equal(reset.json().room.name, 'Лариса, Тимур');
  // A name given at creation.
  const named = (await createRoom(app, owner, [lara], ' Вдвоём ')).json().room;
  assert.deepEqual([named.name, named.auto], ['Вдвоём', false]);
});

test('rooms: leaving, and the room goes when fewer than two remain', async t => {
  const { app, people } = await fixture(t, [['leave_owner', 'Вера'], ['leave_lara', 'Лариса'], ['leave_timur', 'Тимур']]);
  const [owner, lara, timur] = people;
  const room = (await createRoom(app, owner, [lara, timur])).json().room;
  const ownerSocket = await socketFor(t, app, owner), laraSocket = await socketFor(t, app, lara), timurSocket = await socketFor(t, app, timur);

  // Тимур is inside when he leaves the room: his voice seat goes with the membership.
  timurSocket.send({ type: 'voice.join', roomId: room.id });
  await timurSocket.next(p => p.type === 'voice.joined');
  const left = await request(app, 'POST', `/rooms/${room.id}/leave`, timur);
  assert.equal(left.statusCode, 200, left.body);
  assert.deepEqual(left.json(), { ok: true });
  assert.deepEqual(await timurSocket.next(p => p.type === 'voice.kicked'), { type: 'voice.kicked', channelId: room.id, roomId: room.id });
  assert.equal((await timurSocket.next(p => p.type === 'room.removed')).roomId, room.id);
  const updated = await ownerSocket.next(p => p.type === 'room.updated' && p.room.members.length === 2);
  assert.equal(updated.room.name, 'Лариса');
  assert.deepEqual(updated.room.inside, []);
  assert.deepEqual((await request(app, 'GET', '/rooms', timur)).json().rooms, []);
  assert.equal((await request(app, 'POST', `/rooms/${room.id}/leave`, timur)).statusCode, 404);
  // No longer a member: the voice is closed to him.
  timurSocket.send({ type: 'voice.join', roomId: room.id });
  assert.match((await timurSocket.next(p => p.type === 'error')).error, /комнате/);

  // Лариса leaves: Вера would be alone, so the room is deleted for her as well.
  assert.equal((await request(app, 'POST', `/rooms/${room.id}/leave`, lara)).statusCode, 200);
  assert.equal((await ownerSocket.next(p => p.type === 'room.removed')).roomId, room.id);
  assert.equal((await laraSocket.next(p => p.type === 'room.removed')).roomId, room.id);
  assert.deepEqual((await request(app, 'GET', '/rooms', owner)).json().rooms, []);
  assert.equal((await request(app, 'PATCH', `/rooms/${room.id}`, owner, { name: 'Пусто' })).statusCode, 404);
  // The same two people can start again: a new room, not the deleted one.
  const fresh = (await createRoom(app, owner, [lara])).json();
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.room.id, room.id);
});

test('rooms: voice — members only, peers see each other, signalling and state are relayed', async t => {
  const { app, people } = await fixture(t, [['voice_owner', 'Вера'], ['voice_lara', 'Лариса'], ['voice_timur', 'Тимур'], ['voice_other', 'Чужой']]);
  const [owner, lara, timur, outsider] = people;
  const room = (await createRoom(app, owner, [lara, timur])).json().room;
  const ownerSocket = await socketFor(t, app, owner), laraSocket = await socketFor(t, app, lara), timurSocket = await socketFor(t, app, timur), outsiderSocket = await socketFor(t, app, outsider);

  outsiderSocket.send({ type: 'voice.join', roomId: room.id });
  assert.equal((await outsiderSocket.next(p => p.type === 'error')).error, 'Нет доступа к комнате.');
  // A room is not reachable as a community channel either.
  outsiderSocket.send({ type: 'voice.join', communityId: room.id, channelId: room.id });
  await outsiderSocket.next(p => p.type === 'error' && /каналу/.test(p.error));

  const ownerDevice = randomUUID(), laraDevice = randomUUID();
  ownerSocket.send({ type: 'voice.join', roomId: room.id, muted: true, device: ownerDevice });
  const ownerJoined = await ownerSocket.next(p => p.type === 'voice.joined');
  assert.deepEqual(ownerJoined, { type: 'voice.joined', channelId: room.id, roomId: room.id, self: ownerJoined.self, peers: [], sfu: false });
  // Everyone in the room's list is told, inside or not: `room.state` for the list, `voice.state` for the voice screen.
  const entered = await timurSocket.next(p => p.type === 'room.state' && p.inside.length === 1);
  assert.deepEqual(Object.keys(entered).sort(), ['awake', 'inside', 'lastActiveAt', 'roomId', 'type']);
  assert.equal(entered.roomId, room.id);
  assert.equal(entered.awake, true);
  assert.equal(typeof entered.lastActiveAt, 'string');
  assert.deepEqual(entered.inside, [{ userId: owner.user.id, muted: true, serverMuted: false, serverDeafened: false }]);
  assert.deepEqual(await timurSocket.next(p => p.type === 'voice.state'), { type: 'voice.state', channelId: room.id, roomId: room.id, members: entered.inside });

  laraSocket.send({ type: 'voice.join', roomId: room.id, device: laraDevice });
  const laraJoined = await laraSocket.next(p => p.type === 'voice.joined');
  assert.deepEqual(laraJoined.peers, [{ peer: ownerJoined.self, userId: owner.user.id, muted: true, device: ownerDevice }]);
  const both = await ownerSocket.next(p => p.type === 'room.state' && p.inside.length === 2);
  assert.deepEqual(both.inside.map(m => m.userId), [owner.user.id, lara.user.id]);
  await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 2);
  // The list over HTTP agrees with the events.
  const listed = (await request(app, 'GET', '/rooms', timur)).json().rooms[0];
  assert.deepEqual(listed.inside, both.inside);
  assert.equal(listed.awake, true);
  assert.equal(listed.lastActiveAt, both.lastActiveAt);

  // SDP goes between the two sockets, marked as the room's.
  laraSocket.send({ type: 'voice.signal', to: ownerJoined.self, data: { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' } });
  assert.deepEqual(await ownerSocket.next(p => p.type === 'voice.signal'), {
    type: 'voice.signal', channelId: room.id, roomId: room.id, from: laraJoined.self, userId: lara.user.id, device: laraDevice, data: { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' },
  });
  ownerSocket.send({ type: 'voice.signal', to: laraJoined.self, data: { kind: 'answer', sdp: 'v=0\r\nanswer' } });
  assert.equal((await laraSocket.next(p => p.type === 'voice.signal')).data.kind, 'answer');
  // The sealed connection check is passed on as well.
  laraSocket.send({ type: 'voice.auth', to: ownerJoined.self, note: { senderDeviceId: laraDevice, type: 3, body: 'c2VhbGVk' } });
  assert.deepEqual(await ownerSocket.next(p => p.type === 'voice.auth'), {
    type: 'voice.auth', channelId: room.id, roomId: room.id, from: laraJoined.self, userId: lara.user.id, note: { senderDeviceId: laraDevice, type: 3, body: 'c2VhbGVk' },
  });
  // Nothing is relayed to a member who is not inside.
  assert.equal(timurSocket.packets.some(p => p.type === 'voice.signal' || p.type === 'voice.auth'), false);
  timurSocket.send({ type: 'voice.signal', to: ownerJoined.self, data: { kind: 'offer', sdp: 'v=0' } });
  await timurSocket.next(p => p.type === 'error');

  // Unmuting reaches the members as a new state.
  ownerSocket.send({ type: 'voice.mute', muted: false });
  const roomStates = () => timurSocket.packets.filter(p => p.type === 'room.state').length;
  const statesBefore = roomStates();
  const activeBefore = (await request(app, 'GET', '/rooms', timur)).json().rooms[0].lastActiveAt;
  await sleep(20);
  ownerSocket.send({ type: 'voice.mute', muted: false });
  const unmuted = await timurSocket.next(p => p.type === 'voice.state' && p.members.length === 2 && p.members[0].muted === false);
  assert.deepEqual(unmuted, { type: 'voice.state', channelId: room.id, roomId: room.id, members: [{ userId: owner.user.id, muted: false, serverMuted: false, serverDeafened: false }, { userId: lara.user.id, muted: false, serverMuted: false, serverDeafened: false }] });
  await sleep(80);
  // …and only that: nobody entered or left, so no `room.state` and no new time of activity.
  assert.equal(roomStates(), statesBefore, 'a microphone toggle sends no room.state');
  const afterMute = (await request(app, 'GET', '/rooms', timur)).json().rooms[0];
  assert.equal(afterMute.lastActiveAt, activeBefore);
  assert.equal(afterMute.inside[0].muted, false, 'the list over HTTP still shows the microphone as it is');
  // Screen sharing through the server is refused in a room.
  laraSocket.send({ type: 'sfu', id: 1, op: 'caps' });
  await laraSocket.next(p => p.type === 'error' && /Демонстрация/.test(p.error));

  // Лариса leaves: her peer is told, and the members get the new state; the room stays awake.
  laraSocket.send({ type: 'voice.leave' });
  assert.deepEqual(await ownerSocket.next(p => p.type === 'voice.left'), { type: 'voice.left', channelId: room.id, roomId: room.id, peer: laraJoined.self });
  const after = await timurSocket.next(p => p.type === 'room.state' && p.inside.length === 1 && p.inside[0].muted === false);
  assert.deepEqual(after.inside.map(m => m.userId), [owner.user.id]);
  assert.equal(after.awake, true);
});

test('rooms: a dropped socket keeps its seat for the grace period', async t => {
  const { app, people } = await fixture(t, [['grace_owner', 'Вера'], ['grace_lara', 'Лариса']], { voiceGraceMs: 300 });
  const [owner, lara] = people;
  const room = (await createRoom(app, owner, [lara])).json().room;
  const ownerSocket = await socketFor(t, app, owner), laraSocket = await socketFor(t, app, lara);
  ownerSocket.send({ type: 'voice.join', roomId: room.id }); await ownerSocket.next(p => p.type === 'voice.joined');
  laraSocket.send({ type: 'voice.join', roomId: room.id }); const joined = await laraSocket.next(p => p.type === 'voice.joined');
  await ownerSocket.next(p => p.type === 'room.state' && p.inside.length === 2);
  laraSocket.socket.terminate();
  await sleep(100);
  assert.equal(ownerSocket.packets.some(p => p.type === 'voice.left'), false, 'not told within the grace period');
  assert.equal((await ownerSocket.next(p => p.type === 'voice.left')).peer, joined.self);
  const state = ownerSocket.packets.filter(p => p.type === 'room.state').at(-1) ?? null;
  assert.ok(state);
  await ownerSocket.next(p => p.type === 'room.state' && p.inside.length === 1 && ownerSocket.packets.indexOf(p) > ownerSocket.packets.findIndex(q => q.type === 'voice.left'));
});

test('rooms: the room falls asleep roomSleepMs after the last person left, and wakes on a join', async t => {
  const { app, people } = await fixture(t, [['sleep_owner', 'Вера'], ['sleep_lara', 'Лариса']], { roomSleepMs: 300 });
  const [owner, lara] = people;
  const room = (await createRoom(app, owner, [lara])).json().room;
  const ownerSocket = await socketFor(t, app, owner), laraSocket = await socketFor(t, app, lara);
  const listed = async () => (await request(app, 'GET', '/rooms', lara)).json().rooms[0];
  assert.equal((await listed()).awake, false, 'a room nobody has entered is asleep');

  ownerSocket.send({ type: 'voice.join', roomId: room.id });
  await laraSocket.next(p => p.type === 'room.state' && p.awake && p.inside.length === 1);
  await sleep(450);
  assert.equal((await listed()).awake, true, 'no sleep while someone is inside');

  ownerSocket.send({ type: 'voice.leave' });
  const empty = await laraSocket.next(p => p.type === 'room.state' && p.inside.length === 0);
  assert.equal(empty.awake, true, 'awake for a while after the last person left');
  assert.equal((await listed()).awake, true);
  const from = laraSocket.packets.length;
  const asleep = await laraSocket.next(p => p.type === 'room.state' && p.awake === false);
  assert.deepEqual(asleep, { type: 'room.state', roomId: room.id, inside: [], awake: false, lastActiveAt: empty.lastActiveAt });
  assert.ok(laraSocket.packets.indexOf(asleep) >= from);
  const now = await listed();
  assert.equal(now.awake, false);
  assert.equal(now.lastActiveAt, empty.lastActiveAt, 'the time of the last activity is kept in the database');

  // Coming back within the period cancels the sleep.
  laraSocket.send({ type: 'voice.join', roomId: room.id });
  await ownerSocket.next(p => p.type === 'room.state' && p.awake && p.inside.length === 1 && p.inside[0].userId === lara.user.id);
  laraSocket.send({ type: 'voice.leave' });
  await sleep(120);
  ownerSocket.send({ type: 'voice.join', roomId: room.id });
  await ownerSocket.next(p => p.type === 'voice.joined' && ownerSocket.packets.filter(q => q.type === 'voice.joined').length === 2);
  const count = ownerSocket.packets.filter(p => p.type === 'room.state' && p.awake === false).length;
  await sleep(450);
  assert.equal(ownerSocket.packets.filter(p => p.type === 'room.state' && p.awake === false).length, count, 'the earlier timer does not put an occupied room to sleep');
  assert.equal((await listed()).awake, true);
});

test('rooms: a ring reaches only those outside, with a push, and is limited to one per 30 s', async t => {
  const sent = [];
  const push = createPush({ android: async (token, message) => { sent.push({ token, message }); return 'ok'; } });
  let clock = Date.now();
  const { app, people } = await fixture(t, [['ring_owner', 'Вера'], ['ring_lara', 'Лариса'], ['ring_timur', 'Тимур'], ['ring_other', 'Чужой']], { push, now: () => clock });
  const [owner, lara, timur, outsider] = people;
  const room = (await createRoom(app, owner, [lara, timur])).json().room;
  for (const [who, token] of [[lara, `${ANDROID_TOKEN}_lara`], [timur, `${ANDROID_TOKEN}_timur`], [owner, `${ANDROID_TOKEN}_owner`]]) {
    assert.equal((await request(app, 'PUT', '/me/push', who, { token, platform: 'android' })).statusCode, 200);
  }
  const ownerSocket = await socketFor(t, app, owner), laraSocket = await socketFor(t, app, lara), timurSocket = await socketFor(t, app, timur);
  ownerSocket.send({ type: 'voice.join', roomId: room.id }); await ownerSocket.next(p => p.type === 'voice.joined');
  laraSocket.send({ type: 'voice.join', roomId: room.id }); await laraSocket.next(p => p.type === 'voice.joined');

  assert.equal((await request(app, 'POST', `/rooms/${room.id}/ring`, outsider)).statusCode, 404);
  const rung = await request(app, 'POST', `/rooms/${room.id}/ring`, owner);
  assert.equal(rung.statusCode, 200, rung.body);
  assert.deepEqual(rung.json(), { ok: true, rang: 1 });
  assert.deepEqual(await timurSocket.next(p => p.type === 'room.ring'), { type: 'room.ring', roomId: room.id, name: 'Вера, Лариса', fromId: owner.user.id, fromName: 'Вера' });
  await sleep(50);
  assert.equal(laraSocket.packets.some(p => p.type === 'room.ring'), false, 'someone already inside is not called');
  assert.equal(ownerSocket.packets.some(p => p.type === 'room.ring'), false);
  assert.deepEqual(sent.map(item => item.token), [`${ANDROID_TOKEN}_timur`]);
  const { message } = sent[0];
  assert.deepEqual(message.data, { roomId: room.id, kind: 'room' });
  assert.equal(message.android.notification.title, 'Вера, Лариса');
  assert.equal(message.android.notification.body, 'Вера зовёт в комнату');
  assert.equal(message.android.notification.channel_id, 'messages', 'an ordinary notification, not a ringing call');
  assert.equal(message.apns.payload.aps.alert.body, 'Вера зовёт в комнату');

  // Again at once: refused. Another member has their own allowance; the first is free again 30 s later.
  const second = await request(app, 'POST', `/rooms/${room.id}/ring`, owner);
  assert.equal(second.statusCode, 429);
  assert.equal(typeof second.json().error, 'string');
  assert.deepEqual((await request(app, 'POST', `/rooms/${room.id}/ring`, lara)).json(), { ok: true, rang: 1 });
  clock += 30_001;
  assert.deepEqual((await request(app, 'POST', `/rooms/${room.id}/ring`, owner)).json(), { ok: true, rang: 1 });
  await timurSocket.next(() => timurSocket.packets.filter(p => p.type === 'room.ring').length === 3);
  assert.deepEqual(sent.map(item => item.token), Array(3).fill(`${ANDROID_TOKEN}_timur`));
});

test('rooms: a deleted account leaves its rooms', async t => {
  const { app, people } = await fixture(t, [['gone_owner', 'Вера'], ['gone_lara', 'Лариса'], ['gone_timur', 'Тимур']]);
  const [owner, lara, timur] = people;
  const trio = (await createRoom(app, owner, [lara, timur])).json().room;
  const pair = (await createRoom(app, owner, [timur])).json().room;
  const removed = await request(app, 'POST', '/auth/delete-account', timur, { currentPassword: 'correct-horse-42', currentConfirmationWord: 'AmberGardenPrism' });
  assert.equal(removed.statusCode, 200, removed.body);
  const rooms = (await request(app, 'GET', '/rooms', owner)).json().rooms;
  assert.deepEqual(rooms.map(r => r.id), [trio.id]);
  assert.deepEqual(rooms[0].members.map(m => m.id), [owner.user.id, lara.user.id]);
  assert.equal(rooms.some(r => r.id === pair.id), false);
});

test('rooms: a block after creation takes the blocker out of the shared rooms, voice seat included', async t => {
  const { app, people } = await fixture(t, [['blk_vera', 'Вера'], ['blk_boris', 'Борис'], ['blk_clara', 'Клара']]);
  const [vera, boris, clara] = people;
  const trio = (await createRoom(app, vera, [boris, clara])).json().room;
  const pair = (await createRoom(app, boris, [clara])).json().room;
  const apart = (await createRoom(app, vera, [boris])).json().room;
  const veraSocket = await socketFor(t, app, vera), borisSocket = await socketFor(t, app, boris), claraSocket = await socketFor(t, app, clara);
  borisSocket.send({ type: 'voice.join', roomId: trio.id }); await borisSocket.next(p => p.type === 'voice.joined');
  claraSocket.send({ type: 'voice.join', roomId: trio.id }); await claraSocket.next(p => p.type === 'voice.joined');
  await veraSocket.next(p => p.type === 'room.state' && p.inside.length === 2);

  assert.equal((await request(app, 'PUT', `/blocks/${clara.user.id}`, boris)).statusCode, 200);
  // Борис is out of the room's voice and out of the room; Вера and Клара keep it.
  assert.deepEqual(await borisSocket.next(p => p.type === 'voice.kicked'), { type: 'voice.kicked', channelId: trio.id, roomId: trio.id });
  await borisSocket.next(p => p.type === 'room.removed' && p.roomId === trio.id);
  await claraSocket.next(p => p.type === 'voice.left');
  const updated = await veraSocket.next(p => p.type === 'room.updated' && p.room.id === trio.id && p.room.members.length === 2);
  assert.deepEqual(updated.room.members.map(m => m.id), [vera.user.id, clara.user.id]);
  const state = await veraSocket.next(p => p.type === 'room.state' && p.roomId === trio.id && p.inside.length === 1 && p.inside[0].userId === clara.user.id);
  assert.deepEqual(state.inside.map(m => m.userId), [clara.user.id]);
  // The room of the two alone is closed for both.
  await claraSocket.next(p => p.type === 'room.removed' && p.roomId === pair.id);
  await borisSocket.next(p => p.type === 'room.removed' && p.roomId === pair.id);
  const ids = async who => (await request(app, 'GET', '/rooms', who)).json().rooms.map(r => r.id).sort();
  assert.deepEqual(await ids(clara), [trio.id]);
  assert.deepEqual(await ids(vera), [trio.id, apart.id].sort());
  assert.deepEqual(await ids(boris), [apart.id], 'a room without the blocked person is untouched');
  borisSocket.send({ type: 'voice.join', roomId: trio.id });
  assert.equal((await borisSocket.next(p => p.type === 'error')).error, 'Нет доступа к комнате.');
});

test('rooms: voice.join is refused while a block stands between the joiner and another member', async t => {
  const { app, people, dataDir } = await fixture(t, [['lock_vera', 'Вера'], ['lock_boris', 'Борис'], ['lock_clara', 'Клара']]);
  const [vera, boris, clara] = people;
  const room = (await createRoom(app, vera, [boris, clara])).json().room;
  // A block that reached the table without the route's hook (an older row, another code path): both stay
  // members, yet neither of the two may enter; the third still may.
  const side = new DatabaseSync(joinPath(dataDir, 'linea.sqlite'));
  side.exec('PRAGMA busy_timeout=2000');
  side.prepare('INSERT INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(boris.user.id, clara.user.id, new Date().toISOString());
  side.close();
  assert.equal((await request(app, 'GET', '/rooms', boris)).json().rooms.length, 1, 'still a member');
  const veraSocket = await socketFor(t, app, vera), borisSocket = await socketFor(t, app, boris), claraSocket = await socketFor(t, app, clara);
  borisSocket.send({ type: 'voice.join', roomId: room.id });
  assert.equal((await borisSocket.next(p => p.type === 'error')).error, 'Нет доступа к комнате.');
  claraSocket.send({ type: 'voice.join', roomId: room.id });
  assert.equal((await claraSocket.next(p => p.type === 'error')).error, 'Нет доступа к комнате.');
  veraSocket.send({ type: 'voice.join', roomId: room.id });
  await veraSocket.next(p => p.type === 'voice.joined');
});

test('rooms: removing a friend takes the one who did it out of the shared rooms', async t => {
  const { app, people } = await fixture(t, [['unf_vera', 'Вера'], ['unf_boris', 'Борис'], ['unf_clara', 'Клара']]);
  const [vera, boris, clara] = people;
  const trio = (await createRoom(app, vera, [boris, clara])).json().room;
  const veraSocket = await socketFor(t, app, vera), borisSocket = await socketFor(t, app, boris);
  borisSocket.send({ type: 'voice.join', roomId: trio.id }); await borisSocket.next(p => p.type === 'voice.joined');
  await veraSocket.next(p => p.type === 'room.state' && p.inside.length === 1);

  assert.equal((await request(app, 'DELETE', `/contacts/${clara.user.id}`, boris)).statusCode, 200);
  assert.deepEqual(await borisSocket.next(p => p.type === 'voice.kicked'), { type: 'voice.kicked', channelId: trio.id, roomId: trio.id });
  await borisSocket.next(p => p.type === 'room.removed' && p.roomId === trio.id);
  const updated = await veraSocket.next(p => p.type === 'room.updated' && p.room.members.length === 2);
  assert.deepEqual(updated.room.members.map(m => m.id), [vera.user.id, clara.user.id]);
  await veraSocket.next(p => p.type === 'room.state' && p.inside.length === 0);
  assert.deepEqual((await request(app, 'GET', '/rooms', boris)).json().rooms, []);
  assert.deepEqual((await request(app, 'GET', '/rooms', clara)).json().rooms.map(r => r.id), [trio.id]);
  // Removing someone who is no longer a friend changes nothing more.
  assert.equal((await request(app, 'DELETE', `/contacts/${clara.user.id}`, boris)).statusCode, 200);
  assert.equal((await request(app, 'GET', '/rooms', vera)).json().rooms[0].members.length, 2);
});

test('rooms: a ring skips a member whose call privacy leaves the caller out', async t => {
  const { app, people } = await fixture(t, [['priv_vera', 'Вера'], ['priv_boris', 'Борис'], ['priv_clara', 'Клара']]);
  const [vera, boris, clara] = people;
  const room = (await createRoom(app, vera, [boris, clara])).json().room;
  const borisSocket = await socketFor(t, app, boris), claraSocket = await socketFor(t, app, clara);
  assert.equal((await request(app, 'PUT', `/me/call-rules/${vera.user.id}`, clara, { rule: 'deny' })).statusCode, 200);
  assert.deepEqual((await request(app, 'POST', `/rooms/${room.id}/ring`, vera)).json(), { ok: true, rang: 1 });
  await borisSocket.next(p => p.type === 'room.ring');
  await sleep(60);
  assert.equal(claraSocket.packets.some(p => p.type === 'room.ring'), false);
  // Борис is not on her list: his ring reaches her.
  assert.deepEqual((await request(app, 'POST', `/rooms/${room.id}/ring`, boris)).json(), { ok: true, rang: 2 });
  assert.equal((await claraSocket.next(p => p.type === 'room.ring')).fromId, boris.user.id);
});
