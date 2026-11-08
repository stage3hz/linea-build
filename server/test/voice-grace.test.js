import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';

async function request(app, method, url, account, payload) {
  return app.inject({ method, url, headers: account ? { authorization: `Bearer ${account.token}` } : {}, ...(payload === undefined ? {} : { payload }) });
}
async function register(app, username) {
  const response = await request(app, 'POST', '/auth/register', null, { username, displayName: username, password: 'correct-horse-42', recoveryWord: 'SilverHarborLantern', confirmationWord: 'AmberGardenPrism' });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
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
  return { socket, packets, next };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, voiceGraceMs) {
  const dataDir = await mkdtemp(joinPath(tmpdir(), 'linea-voice-grace-'));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, voiceGraceMs });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = await register(app, 'owner_v'), bob = await register(app, 'bob_v');
  const community = (await request(app, 'POST', '/communities', owner, { kind: 'server', name: 'Клан' })).json().community;
  const channel = community.channels.find(c => c.kind === 'voice');
  const code = (await request(app, 'POST', `/communities/${community.id}/invites`, owner, {})).json().invite.code;
  const joined = await request(app, 'POST', `/invites/${code}/accept`, bob);
  assert.equal(joined.statusCode, 200, joined.body);
  const join = s => s.socket.send(JSON.stringify({ type: 'voice.join', communityId: community.id, channelId: channel.id }));
  return { app, owner, bob, community, channel, join };
}

test('B12: a voice member whose socket dropped stays in the room for the grace period, then leaves', async t => {
  const { app, owner, bob, channel, join } = await fixture(t, 400);
  const ownerSocket = await socketFor(t, app, owner), bobSocket = await socketFor(t, app, bob);
  join(ownerSocket); await ownerSocket.next(p => p.type === 'voice.joined');
  join(bobSocket); const bobJoined = await bobSocket.next(p => p.type === 'voice.joined');
  await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 2);
  bobSocket.socket.terminate();
  await sleep(150);
  assert.equal(ownerSocket.packets.some(p => p.type === 'voice.left'), false, 'the room is not told within the grace period');
  const left = await ownerSocket.next(p => p.type === 'voice.left');
  assert.equal(left.channelId, channel.id);
  const state = await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 1);
  assert.deepEqual(state.members.map(m => m.userId), [owner.user.id]);
  assert.equal(left.peer, bobJoined.self);
});

test('B12: the same user re-joining within the grace period takes the place of the dropped socket at once', async t => {
  const { app, owner, bob, join } = await fixture(t, 2000);
  const ownerSocket = await socketFor(t, app, owner), bobSocket = await socketFor(t, app, bob);
  join(ownerSocket); await ownerSocket.next(p => p.type === 'voice.joined');
  join(bobSocket); const first = await bobSocket.next(p => p.type === 'voice.joined');
  await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 2);
  bobSocket.socket.terminate();
  await sleep(100);
  const bobAgain = await socketFor(t, app, bob);
  join(bobAgain);
  const second = await bobAgain.next(p => p.type === 'voice.joined');
  assert.notEqual(second.self, first.self);
  assert.deepEqual(second.peers.map(p => p.userId), [owner.user.id], 'the ghost of the old socket is not offered as a peer');
  // The room sees the old socket leave and the new one in its place; it never dropped to the owner alone in between.
  const left = await ownerSocket.next(p => p.type === 'voice.left');
  assert.equal(left.peer, first.self);
  const states = ownerSocket.packets.filter(p => p.type === 'voice.state');
  assert.equal(states.some(p => p.members.length === 1 && states.indexOf(p) > 0), false, 'members never fell to one');
  await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 2 && p.members.some(m => m.userId === bob.user.id));
});

test('review: who is in a role-gated voice channel is told only to members who can see it', async t => {
  const { app, owner, bob, community, channel, join } = await fixture(t, 400);
  const carl = await register(app, 'carl_v');
  const code = (await request(app, 'POST', `/communities/${community.id}/invites`, owner, {})).json().invite.code;
  assert.equal((await request(app, 'POST', `/invites/${code}/accept`, carl)).statusCode, 200);
  const moderator = community.roles.find(r => r.name === 'Модератор');
  assert.equal((await request(app, 'PUT', `/communities/${community.id}/members/${bob.user.id}/roles`, owner, { roleIds: [moderator.id] })).statusCode, 200);
  assert.equal((await request(app, 'PATCH', `/communities/${community.id}/channels/${channel.id}`, owner, { roleIds: [moderator.id] })).statusCode, 200);
  const ownerSocket = await socketFor(t, app, owner), bobSocket = await socketFor(t, app, bob), carlSocket = await socketFor(t, app, carl);
  join(ownerSocket); await ownerSocket.next(p => p.type === 'voice.joined');
  join(bobSocket); await bobSocket.next(p => p.type === 'voice.joined');
  await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 2);
  // Bob leaves by closing the socket: after the grace period the room shrinks and only those who see it hear of it.
  bobSocket.socket.terminate();
  await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 1);
  // Mute from the owner: another voice.state, again only for those who see the channel.
  ownerSocket.socket.send(JSON.stringify({ type: 'voice.mute', muted: true }));
  await ownerSocket.next(p => p.type === 'voice.state' && p.members[0]?.muted === true);
  await sleep(100);
  assert.equal(carlSocket.packets.some(p => p.type === 'voice.state'), false, `Carl never learns who sits in the gated room: ${JSON.stringify(carlSocket.packets)}`);
});

test('review: a kick during the grace period removes the ghost at once; a deleted community leaves no timer that throws', async t => {
  const { app, owner, bob, community, channel, join } = await fixture(t, 600);
  const ownerSocket = await socketFor(t, app, owner), bobSocket = await socketFor(t, app, bob);
  join(ownerSocket); await ownerSocket.next(p => p.type === 'voice.joined');
  join(bobSocket); await bobSocket.next(p => p.type === 'voice.joined');
  await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 2);
  bobSocket.socket.terminate();
  await sleep(100);
  assert.equal((await request(app, 'DELETE', `/communities/${community.id}/members/${bob.user.id}`, owner)).statusCode, 200);
  const state = await ownerSocket.next(p => p.type === 'voice.state' && p.members.length === 1, 300);
  assert.deepEqual(state.members.map(m => m.userId), [owner.user.id], 'the kicked ghost is gone before its grace period ends');
  assert.equal(state.channelId, channel.id);
  // The owner's socket drops, then the community is deleted while the owner is still in grace: the
  // timer fires against a community that no longer exists and must not take the process down.
  const ownerAgain = await socketFor(t, app, owner);
  join(ownerAgain); await ownerAgain.next(p => p.type === 'voice.joined');
  ownerAgain.socket.terminate();
  await sleep(100);
  const deleted = await request(app, 'DELETE', `/communities/${community.id}`, owner, {});
  assert.equal(deleted.statusCode, 200, deleted.body);
  const crashed = new Promise(resolve => { const handler = error => { process.off('uncaughtException', handler); resolve(error); }; process.once('uncaughtException', handler); setTimeout(() => { process.off('uncaughtException', handler); resolve(null); }, 900); });
  assert.equal(await crashed, null, 'no uncaught exception from the grace timer');
  assert.equal((await request(app, 'GET', '/communities', owner)).statusCode, 200, 'the server is still alive');
});
