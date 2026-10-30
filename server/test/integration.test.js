import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { syntheticEnvelope, syntheticFileBytes, syntheticPublicBundle } from './support/relay-fixtures.js';

const PASSWORD = 'correct-horse-42';
const RECOVERY_WORD = 'SilverHarborLantern';
const CONFIRMATION_WORD = 'AmberGardenPrism';
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=',
  'base64',
);

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-api-test-'));
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

async function request(app, method, url, account, payload) {
  return app.inject({
    method,
    url,
    headers: account ? { authorization: `Bearer ${account.token}` } : {},
    ...(payload === undefined ? {} : { payload }),
  });
}

async function register(app, username, displayName = username) {
  const response = await request(app, 'POST', '/auth/register', null, {
    username, displayName, password: PASSWORD, recoveryWord: RECOVERY_WORD, confirmationWord: CONFIRMATION_WORD,
  });
  assert.equal(response.statusCode, 201, response.body);
  const result = response.json();
  assert.equal(typeof result.token, 'string');
  assert.ok(result.token.length >= 32, 'session token has sufficient random material');
  assert.equal(result.user.username, username);
  assert.equal(result.user.displayName, displayName);
  assert.ok(Number.isFinite(Date.parse(result.user.createdAt)));
  assert.equal(result.user.password, undefined);
  assert.equal(result.user.passwordHash, undefined);
  const registered = await request(app, 'POST', '/e2ee/devices', result, syntheticPublicBundle());
  assert.equal(registered.statusCode, 200, registered.body);
  result.device = registered.json().device;
  return result;
}

async function newChat(app, from, to) {
  const response = await request(app, 'POST', '/chats', from, { userId: to.user.id });
  assert.ok([200, 201].includes(response.statusCode), response.body);
  const { chat } = response.json();
  assert.equal(chat.peer.id, to.user.id);
  // Keep public routing metadata in the fixture, never account tokens. The
  // sender may be either participant even if the chat was opened by the other.
  return { ...chat, relayDevices: [from.device, to.device] };
}

function envelopeFor(from, chat, attachmentIds = []) {
  return syntheticEnvelope(from.device, chat.relayDevices.filter(device => device.id !== from.device.id), attachmentIds);
}

async function send(app, from, chat, clientId, attachmentId) {
  const response = await request(app, 'POST', `/chats/${chat.id}/messages`, from, {
    clientId, encrypted: envelopeFor(from, chat, attachmentId ? [attachmentId] : []),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().message;
}

function multipart(bytes, name = 'sample.txt', mimeType = 'text/plain') {
  const boundary = 'linea-test-boundary-2026';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function uploadAvatar(app, account, bytes, name, mimeType) {
  const form = multipart(bytes, name, mimeType);
  const response = await app.inject({
    method: 'POST', url: '/uploads', payload: form.payload,
    headers: { ...form.headers, authorization: `Bearer ${account.token}` },
  });
  assert.equal(response.statusCode, 201, response.body);
  const attachment = response.json().attachment;
  assert.equal(attachment.size, Buffer.byteLength(bytes));
  return attachment;
}

async function uploadEncrypted(app, account, bytes) {
  const form = multipart(bytes, 'encrypted.bin', 'application/octet-stream');
  const response = await app.inject({
    method: 'POST', url: '/e2ee/files', payload: form.payload,
    headers: { ...form.headers, authorization: `Bearer ${account.token}` },
  });
  assert.equal(response.statusCode, 201, response.body);
  const file = response.json();
  assert.deepEqual(Object.keys(file).sort(), ['id', 'size']);
  assert.equal(file.size, bytes.length);
  return file;
}

function forbidden(response) {
  assert.ok([403, 404].includes(response.statusCode), `Expected inaccessible resource, got ${response.statusCode}: ${response.body}`);
  assert.equal(typeof response.json().error, 'string');
}

async function socketFor(t, app, account, options = {}) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, options);
  const packets = [];
  const listeners = new Set();
  socket.on('message', raw => {
    const packet = JSON.parse(raw.toString());
    packets.push(packet);
    for (const listener of [...listeners]) listener(packet);
  });
  // Assertions below inspect closure; prevent an unhandled event during cleanup.
  socket.on('error', () => {});
  t.after(() => { socket.terminate(); });
  const next = (predicate, { from = 0, timeout = 3000 } = {}) => {
    const existing = packets.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Timed out waiting for WebSocket packet; received ${JSON.stringify(packets)}`));
      }, timeout);
      const listener = packet => {
        if (!predicate(packet)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(packet);
      };
      listeners.add(listener);
    });
  };
  await once(socket, 'open');
  const result = { socket, packets, next };
  if (account) {
    socket.send(JSON.stringify({ type: 'auth', token: account.token }));
    assert.equal((await next(packet => packet.type === 'ready')).userId, account.user.id);
  }
  return result;
}

test('registration, search and login use private sessions and validate input', async t => {
  const { app } = await fixture(t);
  assert.equal((await request(app, 'GET', '/health')).json().status, 'ok');
  assert.equal((await request(app, 'GET', '/me')).statusCode, 401);
  const alice = await register(app, 'alice', 'Алиса');
  const bob = await register(app, 'bob', 'Борис');

  const duplicate = await request(app, 'POST', '/auth/register', null, {
    username: 'alice', displayName: 'Другая Алиса', password: PASSWORD, recoveryWord: RECOVERY_WORD, confirmationWord: CONFIRMATION_WORD,
  });
  assert.equal(duplicate.statusCode, 409);
  for (const invalid of [
    { username: 'a', displayName: 'Имя', password: PASSWORD },
    { username: 'valid_name', displayName: 'Имя', password: 'short' },
    { username: 'invalid/user', displayName: 'Имя', password: PASSWORD },
    { username: 'valid_name', displayName: ' ', password: PASSWORD },
  ]) assert.equal((await request(app, 'POST', '/auth/register', null, { ...invalid, recoveryWord: RECOVERY_WORD, confirmationWord: CONFIRMATION_WORD })).statusCode, 400);

  assert.equal((await request(app, 'POST', '/auth/login', null, { username: 'alice', password: 'wrong-password', confirmationWord: CONFIRMATION_WORD })).statusCode, 401);
  const login = await request(app, 'POST', '/auth/login', null, { username: 'alice', password: PASSWORD, confirmationWord: CONFIRMATION_WORD });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().user.id, alice.user.id);
  assert.notEqual(login.json().token, alice.token);
  const profile = await request(app, 'GET', '/me', alice);
  assert.equal(profile.json().user.username, 'alice');

  const search = await request(app, 'GET', '/users?q=al', bob);
  assert.equal(search.statusCode, 200, search.body);
  assert.deepEqual(search.json().users.map(user => user.id), [alice.user.id]);
  assert.equal(search.json().users[0].passwordHash, undefined);
  const ownSearch = await request(app, 'GET', '/users?q=al', alice);
  assert.equal(ownSearch.json().users.length, 0);
});

test('one private chat per pair, opaque relay messages and unread counts', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const chat = await newChat(app, alice, bob);
  assert.equal((await newChat(app, bob, alice)).id, chat.id);
  assert.equal((await newChat(app, alice, bob)).id, chat.id);
  const message = await send(app, alice, chat, 'alice-message-001');
  assert.equal(message.chatId, chat.id);
  assert.equal(message.senderId, alice.user.id);
  assert.equal(message.text, '');
  assert.equal(message.attachment, null);
  assert.equal(message.encrypted.scheme, 'signal-v1');
  assert.equal(message.encrypted.senderDeviceId, alice.device.id);
  assert.deepEqual(message.encrypted.envelopes.map(({ userId, deviceId }) => ({ userId, deviceId })), [{ userId: bob.user.id, deviceId: bob.device.id }]);
  assert.ok(Number.isInteger(message.id));
  const history = await request(app, 'GET', `/chats/${chat.id}/messages`, bob);
  assert.equal(history.statusCode, 200, history.body);
  assert.deepEqual(history.json().messages.map(item => item.id), [message.id]);
  assert.deepEqual(history.json().messages[0].encrypted, message.encrypted);
  const chats = (await request(app, 'GET', '/chats', bob)).json().chats;
  assert.equal(chats.length, 1);
  assert.equal(chats[0].unreadCount, 1);
  assert.equal(chats[0].lastMessage.id, message.id);
  assert.equal(chats[0].peer.id, alice.user.id);
});

test('a third user cannot read, write or mark another pair’s messages as read', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const eve = await register(app, 'eve');
  const chat = await newChat(app, alice, bob);
  const message = await send(app, alice, chat, 'private-message-001');
  forbidden(await request(app, 'GET', `/chats/${chat.id}/messages`, eve));
  forbidden(await request(app, 'POST', `/chats/${chat.id}/messages`, eve, { encrypted: envelopeFor(eve, chat), clientId: 'forbidden-message-001' }));
  forbidden(await request(app, 'POST', `/chats/${chat.id}/read`, eve, { messageId: message.id }));
  assert.deepEqual((await request(app, 'GET', '/chats', eve)).json().chats, []);
  assert.equal((await request(app, 'GET', `/chats/${chat.id}/messages`)).statusCode, 401);
});

test('retrying a send is idempotent and pagination does not lose messages', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const chat = await newChat(app, alice, bob);
  const messages = [];
  for (let index = 1; index <= 5; index++) {
    messages.push(await send(app, alice, chat, `paginate-message-${index}`));
  }
  const duplicate = await request(app, 'POST', `/chats/${chat.id}/messages`, alice, {
    encrypted: messages[2].encrypted, clientId: 'paginate-message-3',
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.json().message.id, messages[2].id);
  assert.deepEqual(duplicate.json().message.encrypted, messages[2].encrypted);
  // The same clientId cannot replace stored ciphertext. Change one byte so the
  // assertion does not rely on two random fixtures merely being different.
  const different = structuredClone(messages[2].encrypted);
  const body = Buffer.from(different.envelopes[0].body, 'base64'); body[0] ^= 1;
  different.envelopes[0].body = body.toString('base64');
  const conflict = await request(app, 'POST', `/chats/${chat.id}/messages`, alice, { encrypted: different, clientId: 'paginate-message-3' });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const latest = (await request(app, 'GET', `/chats/${chat.id}/messages?limit=2`, bob)).json();
  assert.deepEqual(latest.messages.map(message => message.id), messages.slice(3).map(message => message.id));
  assert.equal(latest.hasMore, true);
  const previous = (await request(app, 'GET', `/chats/${chat.id}/messages?limit=2&before=${latest.messages[0].id}`, bob)).json();
  assert.deepEqual(previous.messages.map(message => message.id), messages.slice(1, 3).map(message => message.id));
  assert.deepEqual(previous.messages[1].encrypted, messages[2].encrypted);
  assert.equal(previous.hasMore, true);
  const first = (await request(app, 'GET', `/chats/${chat.id}/messages?limit=2&before=${previous.messages[0].id}`, bob)).json();
  assert.deepEqual(first.messages.map(message => message.id), [messages[0].id]);
  assert.equal(first.hasMore, false);
  assert.equal((await request(app, 'GET', '/chats', bob)).json().chats[0].unreadCount, 5);
});

test('read receipts are monotonic and reject messages belonging to a different chat', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const carol = await register(app, 'carol');
  const chat = await newChat(app, alice, bob);
  const first = await send(app, alice, chat, 'read-message-first');
  const second = await send(app, alice, chat, 'read-message-second');
  const read = await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: second.id });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().lastReadMessageId, second.id);
  const older = await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: first.id });
  assert.equal(older.json().lastReadMessageId, second.id);
  assert.equal((await request(app, 'GET', '/chats', bob)).json().chats[0].unreadCount, 0);
  assert.equal((await request(app, 'GET', '/chats', alice)).json().chats[0].peerLastReadMessageId, second.id);
  const otherChat = await newChat(app, bob, carol);
  const foreignMessage = await send(app, carol, otherChat, 'different-chat-read');
  const foreignRead = await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: foreignMessage.id });
  assert.ok([400, 403, 404].includes(foreignRead.statusCode), foreignRead.body);
  const futureRead = await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: 999999999 });
  assert.ok([400, 404].includes(futureRead.statusCode), futureRead.body);
});

test('opaque attachments stay private until linked and then are readable only by chat participants', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const eve = await register(app, 'eve');
  const chat = await newChat(app, alice, bob);
  const bytes = syntheticFileBytes();
  const attachment = await uploadEncrypted(app, alice, bytes);
  const mine = await request(app, 'GET', `/files/${attachment.id}`, alice);
  assert.equal(mine.statusCode, 200);
  assert.deepEqual(mine.rawPayload, bytes);
  assert.equal(mine.headers['content-type'], 'application/octet-stream');
  assert.match(mine.headers['content-disposition'], /encrypted\.bin/);
  forbidden(await request(app, 'GET', `/files/${attachment.id}`, bob));
  forbidden(await request(app, 'GET', `/files/${attachment.id}`, eve));
  forbidden(await request(app, 'POST', `/chats/${chat.id}/messages`, bob, {
    encrypted: envelopeFor(bob, chat, [attachment.id]), clientId: 'steal-attachment-001',
  }));
  const message = await send(app, alice, chat, 'attachment-message-001', attachment.id);
  assert.equal(message.attachment, null);
  assert.deepEqual(message.encrypted.attachmentIds, [attachment.id]);
  const peerDownload = await request(app, 'GET', `/files/${attachment.id}`, bob);
  assert.equal(peerDownload.statusCode, 200);
  assert.deepEqual(peerDownload.rawPayload, bytes);
  assert.equal(peerDownload.headers['x-content-type-options'], 'nosniff');
  forbidden(await request(app, 'GET', `/files/${attachment.id}`, eve));
  assert.equal((await request(app, 'GET', `/files/${attachment.id}`)).statusCode, 401);
  const queryToken = await app.inject({ url: `/files/${attachment.id}?token=${alice.token}` });
  assert.ok([400, 401].includes(queryToken.statusCode), 'URL tokens never grant file access');
  const reuse = await request(app, 'POST', `/chats/${chat.id}/messages`, alice, {
    encrypted: envelopeFor(alice, chat, [attachment.id]), clientId: 'attachment-message-002',
  });
  assert.equal(reuse.statusCode, 409, reuse.body);
});

test('avatar signatures override untrusted MIME labels, non-images are rejected, and upload size is enforced', async t => {
  const { app } = await fixture(t, { maxUploadBytes: 1024 });
  const alice = await register(app, 'alice');
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const disguisedForm = multipart(html, 'photo.png', 'image/png');
  const disguised = await app.inject({ method: 'POST', url: '/uploads', payload: disguisedForm.payload, headers: { ...disguisedForm.headers, authorization: `Bearer ${alice.token}` } });
  assert.equal(disguised.statusCode, 400, disguised.body);
  const image = await uploadAvatar(app, alice, VALID_PNG, 'pixel.bin', 'application/octet-stream');
  assert.equal(image.mimeType, 'image/png');
  const download = await request(app, 'GET', `/files/${image.id}`, alice);
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, VALID_PNG);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(download.headers['content-disposition'], /^inline;/);
  assert.match(download.headers['content-security-policy'], /sandbox/);
  const tooBig = multipart(Buffer.alloc(1025), 'too-big.bin', 'application/octet-stream');
  const response = await app.inject({
    method: 'POST', url: '/uploads', payload: tooBig.payload,
    headers: { ...tooBig.headers, authorization: `Bearer ${alice.token}` },
  });
  assert.equal(response.statusCode, 413, response.body);
});

test('profile edits expose only the selected avatar, never arbitrary private attachments', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const image = await uploadAvatar(app, alice, VALID_PNG, 'avatar.png', 'image/png');
  const changed = await request(app, 'PATCH', '/me', alice, {
    displayName: 'Алиса Новая', bio: 'На связи', avatarColor: '#12ABCD', avatarId: image.id,
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().user.displayName, 'Алиса Новая');
  assert.equal(changed.json().user.avatarId, image.id);
  assert.equal((await request(app, 'GET', `/files/${image.id}`, bob)).statusCode, 200);
  const ownImage = await uploadAvatar(app, bob, VALID_PNG, 'bob.png', 'image/png');
  const stolen = await request(app, 'PATCH', '/me', alice, { avatarId: ownImage.id });
  assert.ok([400, 403, 404].includes(stolen.statusCode), stolen.body);
  const privateFile = await uploadEncrypted(app, alice, syntheticFileBytes());
  assert.equal((await request(app, 'PATCH', '/me', alice, { avatarId: privateFile.id })).statusCode, 400);
  forbidden(await request(app, 'GET', `/files/${privateFile.id}`, bob));
  assert.equal((await request(app, 'PATCH', '/me', alice, { avatarId: null })).statusCode, 200);
  forbidden(await request(app, 'GET', `/files/${image.id}`, bob));
});

test('users, sessions, messages and file bytes survive a server restart', async t => {
  const { app, open } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const chat = await newChat(app, alice, bob);
  const bytes = syntheticFileBytes();
  const attachment = await uploadEncrypted(app, alice, bytes);
  const message = await send(app, alice, chat, 'restart-message-001', attachment.id);
  await app.close();
  const restarted = await open();
  const history = await request(restarted, 'GET', `/chats/${chat.id}/messages`, bob);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().messages[0].id, message.id);
  assert.equal(history.json().messages[0].text, message.text);
  assert.equal(history.json().messages[0].text, '');
  assert.equal(history.json().messages[0].attachment, null);
  assert.deepEqual(history.json().messages[0].encrypted, message.encrypted);
  const devices = await request(restarted, 'GET', '/e2ee/devices', alice);
  assert.equal(devices.statusCode, 200, devices.body);
  assert.equal(devices.json().devices[0].id, alice.device.id);
  assert.equal(devices.json().devices[0].identityKey, alice.device.identityKey);
  const file = await request(restarted, 'GET', `/files/${attachment.id}`, bob);
  assert.equal(file.statusCode, 200);
  assert.deepEqual(file.rawPayload, bytes);
  const login = await request(restarted, 'POST', '/auth/login', null, { username: 'alice', password: PASSWORD, confirmationWord: CONFIRMATION_WORD });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().user.id, alice.user.id);
});

test('WebSocket authenticates, relays opaque messages, read receipts and typing privately', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const eve = await register(app, 'eve');
  const chat = await newChat(app, alice, bob);
  const aliceSocket = await socketFor(t, app, alice);
  const bobSocket = await socketFor(t, app, bob);
  const eveSocket = await socketFor(t, app, eve);
  const unauthenticated = await socketFor(t, app);
  const message = await send(app, alice, chat, 'ws-message-private');
  const received = await bobSocket.next(packet => packet.type === 'message' && packet.message?.id === message.id);
  assert.equal(received.chatId, chat.id);
  assert.equal(received.message.text, message.text);
  assert.equal(received.message.text, '');
  assert.equal(received.message.attachment, null);
  assert.deepEqual(received.message.encrypted, message.encrypted);
  await aliceSocket.next(packet => packet.type === 'message' && packet.message?.id === message.id);

  aliceSocket.socket.send(JSON.stringify({ type: 'typing', chatId: chat.id, isTyping: true }));
  const typing = await bobSocket.next(packet => packet.type === 'typing' && packet.chatId === chat.id);
  assert.equal(typing.userId, alice.user.id);
  assert.equal(typing.isTyping, true);
  const read = await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: message.id });
  assert.equal(read.statusCode, 200);
  const receipt = await aliceSocket.next(packet => packet.type === 'read' && packet.messageId === message.id);
  assert.equal(receipt.userId, bob.user.id);

  eveSocket.socket.send(JSON.stringify({ type: 'typing', chatId: chat.id, isTyping: true }));
  await eveSocket.next(packet => packet.type === 'error');
  const marker = bobSocket.packets.length;
  bobSocket.socket.send(JSON.stringify({ type: 'ping' }));
  await bobSocket.next(packet => packet.type === 'pong', { from: marker });
  assert.equal(bobSocket.packets.some(packet => packet.type === 'typing' && packet.userId === eve.user.id), false);
  assert.equal(eveSocket.packets.some(packet => ['message', 'chat', 'read', 'typing'].includes(packet.type)), false);
  // The ready frame is an ordering barrier after any earlier leaked frames.
  unauthenticated.socket.send(JSON.stringify({ type: 'auth', token: eve.token }));
  await unauthenticated.next(packet => packet.type === 'ready');
  assert.equal(unauthenticated.packets.some(packet => ['message', 'chat', 'read', 'typing'].includes(packet.type)), false);
});

test('logout revokes only that session and closes its authenticated WebSocket', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const otherLogin = (await request(app, 'POST', '/auth/login', null, { username: 'alice', password: PASSWORD, confirmationWord: CONFIRMATION_WORD })).json();
  const connection = await socketFor(t, app, alice);
  const closed = once(connection.socket, 'close');
  const logout = await request(app, 'POST', '/auth/logout', alice);
  assert.equal(logout.statusCode, 200, logout.body);
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket stayed open after logout')), 3000);
      timer.unref();
    }),
  ]);
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 401);
  assert.equal((await request(app, 'GET', '/me', otherLogin)).statusCode, 200);
  const rejectedSocket = await socketFor(t, app);
  const rejected = once(rejectedSocket.socket, 'close');
  rejectedSocket.socket.send(JSON.stringify({ type: 'auth', token: alice.token }));
  await Promise.race([
    rejected,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Revoked token accepted by WebSocket')), 3000);
      timer.unref();
    }),
  ]);
  assert.equal(rejectedSocket.packets.some(packet => packet.type === 'ready'), false);
});

test('expired sessions cannot access HTTP endpoints', async t => {
  let timestamp = Date.now();
  const { app } = await fixture(t, { now: () => timestamp, sessionTtlMs: 1000 });
  const alice = await register(app, 'alice');
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 200);
  timestamp += 1001;
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 401);
});

test('server rejects plaintext, empty or excessive envelopes and invalid IDs without storing messages', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const chat = await newChat(app, alice, bob);
  const encrypted = envelopeFor(alice, chat);
  for (const payload of [
    { text: '   ', clientId: 'invalid-empty-message' },
    { text: 'x'.repeat(8001), clientId: 'invalid-long-message' },
    { encrypted, clientId: 'short' },
    { encrypted: { ...encrypted, envelopes: [] }, clientId: 'invalid-no-envelopes' },
    { encrypted: { ...encrypted, envelopes: [{ ...encrypted.envelopes[0], body: '' }] }, clientId: 'invalid-empty-envelope' },
    { encrypted: { ...encrypted, envelopes: [{ ...encrypted.envelopes[0], body: Buffer.alloc(65537).toString('base64') }] }, clientId: 'invalid-large-envelope' },
  ]) {
    const response = await request(app, 'POST', `/chats/${chat.id}/messages`, alice, payload);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual((await request(app, 'GET', `/chats/${chat.id}/messages`, bob)).json().messages, []);
});

test('repeated authentication attempts are throttled', async t => {
  const { app } = await fixture(t, { authRateLimit: 2 });
  const statuses = [];
  for (let index = 0; index < 5; index++) {
    statuses.push((await request(app, 'POST', '/auth/login', null, {
      username: 'unknown', password: 'not-the-password', confirmationWord: CONFIRMATION_WORD,
    })).statusCode);
  }
  assert.ok(statuses.includes(401), 'credential failure remains distinguishable from server failure');
  assert.equal(statuses.at(-1), 429, `Expected throttling, got ${statuses.join(', ')}`);
});

test('only explicitly allowed browser origins can use authenticated HTTP requests', async t => {
  const { app } = await fixture(t, { allowedOrigins: ['https://messenger.example'] });
  const alice = await register(app, 'alice');
  const allowed = await app.inject({
    method: 'GET', url: '/me',
    headers: { authorization: `Bearer ${alice.token}`, origin: 'https://messenger.example' },
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://messenger.example');
  const rejected = await app.inject({
    method: 'GET', url: '/me',
    headers: { authorization: `Bearer ${alice.token}`, origin: 'https://untrusted.example' },
  });
  assert.equal(rejected.statusCode, 403, rejected.body);
  assert.notEqual(rejected.headers['access-control-allow-origin'], '*');
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 200, 'native requests have no Origin header');
});

test('React Native endpoint Origin is accepted only for WS upgrades and still requires authentication', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const host = `127.0.0.1:${app.server.address().port}`;
  const origin = `http://${host}`;

  const native = await socketFor(t, app, alice, { headers: { origin } });
  native.socket.send(JSON.stringify({ type: 'ping' }));
  await native.next(packet => packet.type === 'pong');
  // Simulate HTTPS terminated upstream: matching raw Host is sufficient, and
  // no trusted X-Forwarded-* configuration is needed to allow the Origin.
  await socketFor(t, app, alice, { headers: { origin: `https://${host}` } });

  const unauthenticated = await socketFor(t, app, null, { headers: { origin } });
  const closed = once(unauthenticated.socket, 'close');
  unauthenticated.socket.send(JSON.stringify({ type: 'ping' }));
  const [closeCode] = await closed;
  assert.equal(closeCode, 4401);
  assert.equal(unauthenticated.packets.some(packet => packet.type === 'ready'), false);

  const http = await app.inject({ method: 'GET', url: '/me', headers: {
    host, origin, authorization: `Bearer ${alice.token}`,
  } });
  assert.equal(http.statusCode, 403, 'same endpoint Origin must not open HTTP CORS');
  assert.equal(http.headers['access-control-allow-origin'], undefined);
  const ordinaryGet = await app.inject({ method: 'GET', url: '/ws', headers: { host, origin } });
  assert.equal(ordinaryGet.statusCode, 403, 'the exception requires a WebSocket upgrade');

  for (const rejectedOrigin of ['https://untrusted.example', `${origin}/path`, `${origin}/`, 'null', `ftp://${host}`]) {
    const rejected = await app.inject({ method: 'GET', url: '/ws', headers: {
      host, origin: rejectedOrigin, upgrade: 'websocket', connection: 'Upgrade',
      'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'https',
    } });
    assert.equal(rejected.statusCode, 403, `${rejectedOrigin} must not match raw endpoint Host`);
  }
});

test('privacy: new chats, avatar visibility and mutual read receipts are enforced by the server', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice_priv'), bob = await register(app, 'bob_priv'), carol = await register(app, 'carol_priv');
  const defaults = await request(app, 'GET', '/me/privacy', alice);
  assert.equal(defaults.statusCode, 200);
  assert.deepEqual(defaults.json().privacy, { allowNewChats: true, showAvatar: true, readReceipts: true });
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { allowNewChats: 'no' })).statusCode, 400);
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { unknown: true })).statusCode, 400);

  // Existing conversations keep working after new chats are disabled.
  const chat = await newChat(app, bob, alice);
  const closed = await request(app, 'PATCH', '/me/privacy', alice, { allowNewChats: false });
  assert.equal(closed.statusCode, 200);
  assert.equal(closed.json().privacy.allowNewChats, false);
  assert.equal((await request(app, 'POST', '/chats', bob, { userId: alice.user.id })).statusCode, 200);
  const refused = await request(app, 'POST', '/chats', carol, { userId: alice.user.id });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'NEW_CHATS_DISABLED');

  // Hidden avatar: owner still sees it; peers, search and the file route do not.
  const image = await uploadAvatar(app, alice, VALID_PNG, 'avatar.png', 'image/png');
  assert.equal((await request(app, 'PATCH', '/me', alice, { avatarId: image.id })).statusCode, 200);
  const peerView = () => request(app, 'GET', '/chats', bob).then(response => response.json().chats.find(item => item.id === chat.id).peer.avatarId);
  assert.equal(await peerView(), image.id);
  assert.equal((await request(app, 'GET', `/files/${image.id}`, bob)).statusCode, 200);
  assert.equal((await request(app, 'PATCH', '/me/privacy', alice, { showAvatar: false })).statusCode, 200);
  assert.equal(await peerView(), null);
  const search = await request(app, 'GET', '/users?q=alice_priv', bob);
  assert.equal(search.json().users[0].avatarId, null);
  assert.equal((await request(app, 'GET', `/files/${image.id}`, bob)).statusCode, 404);
  assert.equal((await request(app, 'GET', `/files/${image.id}`, alice)).statusCode, 200);
  assert.equal((await request(app, 'GET', '/me', alice)).json().user.avatarId, image.id);

  // Read receipts are mutual: when Bob hides his, neither side sees the other's.
  const message = await send(app, alice, chat, '11111111-1111-4111-8111-111111111111');
  assert.equal((await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: message.id })).statusCode, 200);
  const aliceSees = () => request(app, 'GET', '/chats', alice).then(response => response.json().chats.find(item => item.id === chat.id).peerLastReadMessageId);
  assert.equal(await aliceSees(), message.id);
  assert.equal((await request(app, 'PATCH', '/me/privacy', bob, { readReceipts: false })).statusCode, 200);
  assert.equal(await aliceSees(), 0);
  assert.equal((await request(app, 'PATCH', '/me/privacy', bob, { readReceipts: true })).statusCode, 200);
  assert.equal(await aliceSees(), message.id);
});

test('friends list and per-user chat settings (pin, archive, mute) stay private to their owner', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice_social'), bob = await register(app, 'bob_social');
  const chat = await newChat(app, alice, bob);
  let profile = await request(app, 'GET', `/users/${bob.user.id}`, alice);
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().isContact, false);
  assert.equal(profile.json().chatId, chat.id);
  assert.equal((await request(app, 'PUT', `/contacts/${bob.user.id}`, alice)).statusCode, 200);
  assert.equal((await request(app, 'PUT', `/contacts/${alice.user.id}`, alice)).statusCode, 400);
  profile = await request(app, 'GET', `/users/${bob.user.id}`, alice);
  assert.equal(profile.json().isContact, true);
  assert.deepEqual((await request(app, 'GET', '/contacts', alice)).json().users.map(u => u.id), [bob.user.id]);
  assert.deepEqual((await request(app, 'GET', '/contacts', bob)).json().users, []);
  assert.equal((await request(app, 'DELETE', `/contacts/${bob.user.id}`, alice)).statusCode, 200);
  assert.deepEqual((await request(app, 'GET', '/contacts', alice)).json().users, []);

  const pinned = await request(app, 'PATCH', `/chats/${chat.id}/settings`, alice, { pinned: true, muted: true });
  assert.equal(pinned.statusCode, 200, pinned.body);
  assert.ok(pinned.json().chat.settings.pinnedAt);
  assert.equal(pinned.json().chat.settings.muted, true);
  const bobView = (await request(app, 'GET', '/chats', bob)).json().chats[0];
  assert.deepEqual(bobView.settings, { pinnedAt: null, archived: false, muted: false });
  const archived = await request(app, 'PATCH', `/chats/${chat.id}/settings`, alice, { archived: true });
  assert.equal(archived.json().chat.settings.archived, true);
  assert.equal(archived.json().chat.settings.pinnedAt, null);
  assert.equal((await request(app, 'PATCH', `/chats/${chat.id}/settings`, bob, { pinned: 'yes' })).statusCode, 400);
  const stranger = await register(app, 'carol_social');
  assert.equal((await request(app, 'PATCH', `/chats/${chat.id}/settings`, stranger, { pinned: true })).statusCode, 404);
});
