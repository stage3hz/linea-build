import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { parseEncryptedMessage } from '../src/e2ee.js';
import { publicMessage } from '../src/database.js';

// These fixtures exercise a ciphertext relay, not Signal cryptography. The
// bytes are intentionally synthetic; native-client cryptographic tests are separate.
const PASSWORD = 'Synthetic!Orchid.87.Wind';
const NEXT_PASSWORD = 'Synthetic!Harbor.42.Maple';
const CONFIRMATION = 'корабль';
const RECOVERY = 'астра';
const key33 = () => Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString('base64');
const freshPreKey = id => ({ id, publicKey: key33() });
const bundle = (ids = [1, 2]) => ({
  deviceId: randomUUID(), deviceName: 'Synthetic test device', registrationId: 1234,
  identityKey: key33(),
  signedPreKey: { id: 100, publicKey: key33(), signature: randomBytes(64).toString('base64') },
  kyberPreKey: { id: 200, publicKey: randomBytes(1569).toString('base64'), signature: randomBytes(64).toString('base64') },
  preKeys: ids.map(freshPreKey),
});

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-e2ee-test-'));
  let time = Date.now();
  const instances = [];
  const open = async overrides => {
    const app = await buildApp({ dataDir, now: () => time, authRateLimit: false, ...options, ...overrides });
    instances.push(app);
    return app;
  };
  t.after(async () => {
    for (const app of instances.reverse()) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app: await open(), open, dataDir, advance: milliseconds => { time += milliseconds; }, advanceTo: date => { time = Date.parse(date); } };
}
function sql(dataDir, operation) {
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  try { return operation(db); } finally { db.close(); }
}
async function request(app, method, url, account, payload) {
  return app.inject({ method, url, ...(account ? { headers: { authorization: `Bearer ${account.token}` } } : {}), ...(payload === undefined ? {} : { payload }) });
}
async function register(app, username) {
  const result = await request(app, 'POST', '/auth/register', null, { username, displayName: username, password: PASSWORD, confirmationWord: CONFIRMATION, recoveryWord: RECOVERY });
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}
async function login(app, username, password = PASSWORD) {
  const result = await request(app, 'POST', '/auth/login', null, { username, password, confirmationWord: CONFIRMATION });
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}
async function chat(app, sender, peer) {
  const result = await request(app, 'POST', '/chats', sender, { userId: peer.user.id });
  assert.ok([200, 201].includes(result.statusCode), result.body);
  return result.json().chat;
}
async function device(app, account, keys = bundle()) {
  const response = await request(app, 'POST', '/e2ee/devices', account, keys);
  assert.equal(response.statusCode, 200, response.body);
  return { ...response.json().device, keys };
}
const encrypted = (sender, targets, attachmentIds = []) => ({
  scheme: 'signal-v1', senderDeviceId: sender.id,
  envelopes: targets.map(target => ({ userId: target.userId, deviceId: target.id, type: 3, body: randomBytes(96).toString('base64') })),
  attachmentIds,
});
const send = (app, account, thread, ciphertext, clientId = randomUUID()) => request(app, 'POST', `/chats/${thread.id}/messages`, account, { clientId, encrypted: ciphertext });
const inbox = (app, account, currentDevice, thread, after = 0, limit = 100) => request(app, 'GET', `/e2ee/inbox?deviceId=${currentDevice.id}&chatId=${thread.id}&after=${after}&limit=${limit}`, account);

async function upload(app, account, content, mime = 'application/octet-stream') {
  const boundary = `synthetic-${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private-original-name.jpg"\r\nContent-Type: ${mime}\r\n\r\n`),
    content, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: 'POST', url: '/e2ee/files', headers: { authorization: `Bearer ${account.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
}
async function socketFor(t, app, account) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const packets = [];
  socket.on('error', () => {});
  socket.on('message', raw => packets.push(JSON.parse(raw.toString())));
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'auth', token: account.token }));
  assert.equal(JSON.parse((await ready)[0]).type, 'ready');
  return { socket, packets };
}

test('pure envelope boundary accepts exact limits, normalizes identifiers and rejects malformed transport data', () => {
  const sender = { id: randomUUID() };
  const target = { id: randomUUID(), userId: randomUUID() };
  const valid = encrypted(sender, [target]);
  const original = JSON.stringify(valid);
  assert.deepEqual(parseEncryptedMessage(valid), valid);
  assert.equal(JSON.stringify(valid), original, 'normalization must not mutate caller-owned input');
  assert.equal(parseEncryptedMessage({ ...valid, senderDeviceId: sender.id.toUpperCase() }).senderDeviceId, sender.id);
  const minimal = { ...valid, envelopes: [{ ...valid.envelopes[0], type: 2, body: 'AA==' }] };
  assert.equal(parseEncryptedMessage(minimal).envelopes[0].body, 'AA==');
  const maximum = { ...valid, envelopes: Array.from({ length: 10 }, () => ({ userId: target.userId, deviceId: randomUUID(), type: 3, body: Buffer.alloc(65536).toString('base64') })), attachmentIds: Array.from({ length: 10 }, () => randomUUID()) };
  assert.equal(parseEncryptedMessage(maximum).envelopes.length, 10);
  assert.equal(parseEncryptedMessage(maximum).attachmentIds.length, 10);
  const lowUser = '00000000-0000-4000-8000-000000000000', highUser = '10000000-0000-4000-8000-000000000000';
  const lowDevice = '00000000-0000-4000-8000-000000000001', highDevice = '00000000-0000-4000-8000-000000000002';
  const unordered = { ...minimal, envelopes: [
    { ...minimal.envelopes[0], userId: highUser, deviceId: randomUUID() },
    { ...minimal.envelopes[0], userId: lowUser, deviceId: highDevice },
    { ...minimal.envelopes[0], userId: lowUser, deviceId: lowDevice },
  ], attachmentIds: [highDevice, lowDevice] };
  const ordered = parseEncryptedMessage(unordered);
  assert.deepEqual(ordered.envelopes.map(item => item.userId), [lowUser, lowUser, highUser]);
  assert.deepEqual(ordered.envelopes.slice(0, 2).map(item => item.deviceId), [lowDevice, highDevice]);
  assert.deepEqual(ordered.attachmentIds, [lowDevice, highDevice]);
  const omitted = { ...valid };
  delete omitted.attachmentIds;
  assert.deepEqual(parseEncryptedMessage(omitted).attachmentIds, []);
  const malformed = [
    { ...valid, scheme: 'plaintext' }, { ...valid, senderDeviceId: '' },
    { ...valid, envelopes: null }, { ...valid, envelopes: {} }, { ...valid, envelopes: [] },
    { ...valid, envelopes: [...maximum.envelopes, maximum.envelopes[0]] },
    { ...valid, envelopes: [valid.envelopes[0], { ...valid.envelopes[0], userId: randomUUID() }] },
    { ...valid, privateKey: 'never accepted' },
    ...[null, false, 0, '', {}, [...maximum.attachmentIds, randomUUID()], [target.id, target.id]].map(attachmentIds => ({ ...valid, attachmentIds })),
    ...[null, false, 0, '', 'wrong', 'AB==', '__8=', Buffer.alloc(65537).toString('base64')].map(body => ({ ...valid, envelopes: [{ ...valid.envelopes[0], body }] })),
    ...[0, 1, 4, '3'].map(type => ({ ...valid, envelopes: [{ ...valid.envelopes[0], type }] })),
    ...[{ userId: 7 }, { deviceId: 'invalid' }, { text: 'plaintext' }].map(fields => ({ ...valid, envelopes: [{ ...valid.envelopes[0], ...fields }] })),
  ];
  for (const [index, value] of malformed.entries()) assert.throws(() => parseEncryptedMessage(value), error => error.statusCode === 400, `Malformed fixture ${index}`);
});

test('no obsolete constructor option can enable plaintext messages, previews or legacy attachment downloads', async t => {
  const { app, open, dataDir } = await fixture(t, { allowLegacyPlaintext: true });
  const alice = await register(app, 'alice'), bob = await register(app, 'bob');
  const thread = await chat(app, alice, bob);
  for (const payload of [
    { clientId: randomUUID(), text: 'private text' },
    { clientId: randomUUID(), attachmentId: randomUUID() },
    { clientId: randomUUID() },
  ]) {
    const response = await request(app, 'POST', `/chats/${thread.id}/messages`, alice, payload);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, 'E2EE_PLAINTEXT_REJECTED');
  }
  const legacyText = 'Synthetic legacy plaintext must not leave the production relay';
  const legacyFilename = 'Synthetic-private-legacy-name.txt';
  const fileId = randomUUID();
  sql(dataDir, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
    const date = new Date().toISOString();
    db.prepare('INSERT INTO uploads(id,owner_id,name,mime_type,size,created_at) VALUES(?,?,?,?,?,?)').run(fileId, alice.user.id, legacyFilename, 'text/plain', 1, date);
    const inserted = db.prepare('INSERT INTO messages(chat_id,sender_id,client_id,text,attachment_id,created_at) VALUES(?,?,?,?,?,?)').run(thread.id, alice.user.id, randomUUID(), legacyText, fileId, date);
    db.prepare('UPDATE uploads SET attached_message_id=? WHERE id=?').run(Number(inserted.lastInsertRowid), fileId);
  });
  await writeFile(join(dataDir, 'uploads', fileId), 'x');
  await app.close();
  const restarted = await open();
  for (const response of [
    await request(restarted, 'GET', `/chats/${thread.id}/messages`, bob),
    await request(restarted, 'GET', '/chats', bob),
  ]) {
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes(legacyText), false);
    assert.equal(response.body.includes(legacyFilename), false);
  }
  const message = (await request(restarted, 'GET', `/chats/${thread.id}/messages`, bob)).json().messages[0];
  assert.equal(message.text, '');
  assert.equal(message.attachment, null);
  assert.equal(message.legacy, true);
  assert.equal(sql(dataDir, db => db.prepare('SELECT text FROM messages').get().text), legacyText);
  for (const account of [alice, bob]) {
    const download = await request(restarted, 'GET', `/files/${fileId}`, account);
    assert.equal(download.statusCode, 404, 'legacy conversation files must not be delivered without E2EE, even to their uploader');
    assert.equal(download.body.includes(legacyFilename), false);
  }
});

test('legacy serialization never reveals message text, names or attachments through caller options', () => {
  const secret = 'Synthetic hidden legacy content';
  const row = { id: 1, chat_id: 'chat', sender_id: 'sender', client_id: 'message', text: secret, attachment_id: 'private-file', created_at: '2026-10-28T00:00:00.000Z' };
  const db = { prepare: () => { throw new Error('Legacy attachments must not be queried'); } };
  const message = publicMessage(db, row, { allowLegacyPlaintext: true });
  assert.equal(message.text, '');
  assert.equal(message.attachment, null);
  assert.equal(message.legacy, true);
  assert.equal(JSON.stringify(message).includes(secret), false);
});

test('device registration validates public key boundaries, is immutable, and scopes discovery to chat peers', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice'), bob = await register(app, 'bob'), carol = await register(app, 'carol');
  const lowerBoundKeys = bundle([0, 0x7fffffff]);
  lowerBoundKeys.registrationId = 1;
  lowerBoundKeys.signedPreKey.id = 0;
  lowerBoundKeys.kyberPreKey.id = 0x7fffffff;
  const a = await device(app, alice, lowerBoundKeys), b = await device(app, bob, { ...bundle(), registrationId: 16383 });
  assert.equal((await request(app, 'GET', `/e2ee/devices?userId=${bob.user.id}`, alice)).statusCode, 404);
  assert.equal((await request(app, 'POST', '/e2ee/prekeys/claim', alice, { userId: bob.user.id, deviceId: b.id })).statusCode, 404);
  await chat(app, alice, bob);
  const peers = await request(app, 'GET', `/e2ee/devices?userId=${bob.user.id}`, alice);
  assert.equal(peers.statusCode, 200, peers.body);
  assert.equal(peers.json().devices[0].id, b.id);
  assert.equal('sessionId' in peers.json().devices[0], false);
  assert.equal('preKeyCount' in peers.json().devices[0], false);
  assert.equal((await request(app, 'GET', `/e2ee/devices?userId=${bob.user.id}`, carol)).statusCode, 404);
  assert.equal((await request(app, 'POST', '/e2ee/devices', alice, b.keys)).statusCode, 409);
  assert.equal((await request(app, 'POST', '/e2ee/devices', alice, { ...a.keys, identityKey: key33() })).statusCode, 409);
  assert.equal((await request(app, 'POST', '/e2ee/devices', alice, { ...a.keys, registrationId: 1235 })).statusCode, 409);
  for (const invalid of [
    { deviceId: 'not-a-uuid' }, { registrationId: 0 }, { registrationId: 16384 },
    { identityKey: randomBytes(32).toString('base64') },
    { identityKey: Buffer.alloc(33).toString('base64') },
    { signedPreKey: { ...a.keys.signedPreKey, signature: 'not base64' } },
    { kyberPreKey: { ...a.keys.kyberPreKey, publicKey: randomBytes(1568).toString('base64') } },
    { preKeys: Array.from({ length: 33 }, (_, index) => freshPreKey(index)) },
    { preKeys: [freshPreKey(99), freshPreKey(99)] },
    { privateKey: 'must-not-be-accepted' },
  ]) assert.equal((await request(app, 'POST', '/e2ee/devices', alice, { ...a.keys, ...invalid })).statusCode, 400);
  const own = await request(app, 'GET', '/e2ee/devices/self', alice);
  assert.equal(own.json().devices[0].preKeyCount, 2);
  assert.equal((await request(app, 'POST', '/e2ee/devices/revoke', carol, { deviceId: a.id })).statusCode, 404);
  for (let i = 0; i < 4; i++) await device(app, alice);
  const sixth = bundle();
  assert.equal((await request(app, 'POST', '/e2ee/devices', alice, sixth)).statusCode, 409);
  assert.equal((await request(app, 'POST', '/e2ee/devices/revoke', alice, { deviceId: a.id })).statusCode, 200);
  const renewed = await login(app, 'alice');
  await device(app, renewed, sixth);
  assert.equal((await request(app, 'GET', '/e2ee/devices', renewed)).json().devices.length, 1);
  const all = (await request(app, 'GET', '/e2ee/devices/self', renewed)).json().devices;
  assert.equal(all.length, 6);
  assert.equal(all.find(item => item.id === a.id).active, false);
});

test('concurrent claims consume EC prekeys once and registration retries never restore consumed keys', async t => {
  const { app, dataDir } = await fixture(t);
  const alice = await register(app, 'alice'), bob = await register(app, 'bob');
  await chat(app, alice, bob);
  const b = await device(app, bob);
  const claim = () => request(app, 'POST', '/e2ee/prekeys/claim', alice, { userId: bob.user.id, deviceId: b.id });
  const responses = await Promise.all([claim(), claim(), claim()]);
  assert.ok(responses.every(response => response.statusCode === 200));
  const claimed = responses.map(response => response.json().bundle.preKey?.id).filter(id => id !== undefined);
  assert.deepEqual(claimed.sort(), [1, 2]);
  assert.ok(responses.every(response => response.json().bundle.kyberPreKey.publicKey === b.keys.kyberPreKey.publicKey));
  const replay = await request(app, 'POST', '/e2ee/devices', bob, b.keys);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().preKeyCount, 0);
  assert.equal((await claim()).json().bundle.preKey, undefined);
  const changed = await request(app, 'POST', '/e2ee/devices', bob, { ...b.keys, preKeys: [freshPreKey(1)] });
  assert.equal(changed.statusCode, 409);
  assert.equal(sql(dataDir, db => db.prepare('SELECT COUNT(*) AS count FROM e2ee_prekeys WHERE consumed_at IS NOT NULL').get().count), 2);
  for (const [start, count] of [[3, 32], [35, 32], [67, 32], [99, 4]]) {
    const replenished = await request(app, 'POST', '/e2ee/devices', bob, { ...b.keys, preKeys: Array.from({ length: count }, (_, i) => freshPreKey(start + i)) });
    assert.equal(replenished.statusCode, 200, replenished.body);
  }
  assert.equal((await request(app, 'GET', '/e2ee/devices/self', bob)).json().devices[0].preKeyCount, 100);
  assert.equal((await request(app, 'POST', '/e2ee/devices', bob, { ...b.keys, preKeys: [freshPreKey(103)] })).statusCode, 409);
});

test('encrypted sends require exact active recipients, keep idempotency across device changes, and deliver opaque WS events', async t => {
  const { app, dataDir } = await fixture(t);
  const alice = await register(app, 'alice'), bob = await register(app, 'bob'), carol = await register(app, 'carol');
  const aliceOther = await login(app, 'alice');
  const thread = await chat(app, alice, bob);
  const a = await device(app, alice), a2 = await device(app, aliceOther), b = await device(app, bob), c = await device(app, carol);
  const bobSocket = await socketFor(t, app, bob);
  for (const targets of [[b], [b, a2, c], [b, a2, a]]) {
    const mismatch = await send(app, alice, thread, encrypted(a, targets));
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    assert.equal(mismatch.json().code, 'E2EE_DEVICES_CHANGED');
  }
  assert.equal((await send(app, alice, thread, encrypted(a, [b, b]))).statusCode, 400);
  assert.equal((await send(app, alice, thread, encrypted(b, [a2]))).statusCode, 403);
  const ciphertext = encrypted(a, [b, a2]), clientId = randomUUID();
  const frame = once(bobSocket.socket, 'message');
  const sent = await send(app, alice, thread, ciphertext, clientId);
  assert.equal(sent.statusCode, 201, sent.body);
  const message = sent.json().message;
  assert.equal(message.text, '');
  assert.equal(message.attachment, null);
  assert.equal(message.encrypted.envelopes.length, 2);
  assert.equal(JSON.parse((await frame)[0]).type, 'message');
  assert.ok(bobSocket.packets.some(packet => packet.type === 'message' && packet.message.encrypted.scheme === 'signal-v1'));
  const stored = sql(dataDir, db => db.prepare('SELECT * FROM messages WHERE id=?').get(message.id));
  assert.equal(stored.text, '');
  assert.equal(stored.attachment_id, null);
  assert.deepEqual(JSON.parse(stored.encrypted_json), message.encrypted);
  const replay = await send(app, alice, thread, { ...ciphertext, envelopes: [...ciphertext.envelopes].reverse() }, clientId);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().message.id, message.id);
  assert.equal((await send(app, alice, thread, encrypted(a, [b, a2]), clientId)).statusCode, 409);
  const b2 = await device(app, bob);
  assert.equal((await send(app, alice, thread, ciphertext, clientId)).statusCode, 200, 'a safe retry returns the original message before checking newly added devices');
  assert.equal((await send(app, alice, thread, ciphertext)).statusCode, 409);
  assert.equal((await send(app, alice, thread, encrypted(a, [b, b2, a2]))).statusCode, 201);
  assert.equal((await request(app, 'GET', `/chats/${thread.id}/messages`, carol)).statusCode, 404);
  assert.equal((await request(app, 'POST', '/e2ee/devices/revoke', alice, { deviceId: a.id })).statusCode, 200);
  assert.equal((await send(app, alice, thread, encrypted(a, [b, b2, a2]))).statusCode, 401, 'revoked encryption device also loses its bound HTTP session');
});

test('opaque file uploads hide names and types, enforce byte bounds, and grant access only after attachment', async t => {
  const { app, dataDir } = await fixture(t, { maxUploadBytes: 64, maxStoredBytesPerUser: 1024 });
  const alice = await register(app, 'alice'), bob = await register(app, 'bob'), carol = await register(app, 'carol');
  const thread = await chat(app, alice, bob), a = await device(app, alice), b = await device(app, bob);
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), randomBytes(56)]);
  const uploaded = await upload(app, alice, bytes);
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const file = uploaded.json();
  assert.deepEqual(Object.keys(file).sort(), ['id', 'size']);
  assert.equal(file.size, bytes.length);
  assert.equal((await request(app, 'GET', `/files/${file.id}`, bob)).statusCode, 404);
  assert.equal((await request(app, 'GET', `/files/${file.id}`, carol)).statusCode, 404);
  const ownerFile = await request(app, 'GET', `/files/${file.id}`, alice);
  assert.equal(ownerFile.statusCode, 200);
  assert.equal(ownerFile.headers['content-type'], 'application/octet-stream');
  assert.match(ownerFile.headers['content-disposition'], /encrypted\.bin/);
  assert.equal(ownerFile.headers['content-disposition'].includes('private-original-name'), false);
  assert.deepEqual(ownerFile.rawPayload, bytes);
  const posted = await send(app, alice, thread, encrypted(a, [b], [file.id]));
  assert.equal(posted.statusCode, 201, posted.body);
  assert.equal(posted.json().message.attachment, null);
  const received = await request(app, 'GET', `/files/${file.id}`, bob);
  assert.equal(received.statusCode, 200, received.body);
  assert.deepEqual(received.rawPayload, bytes);
  assert.equal((await request(app, 'GET', `/files/${file.id}`, carol)).statusCode, 404);
  assert.equal((await send(app, alice, thread, encrypted(a, [b], [file.id]))).statusCode, 409, 'an attachment already assigned to one message is not silently reassigned');
  assert.equal((await upload(app, alice, Buffer.alloc(129))).statusCode, 413);
  assert.equal((await upload(app, alice, bytes, 'image/jpeg')).statusCode, 400);
  assert.equal((await upload(app, alice, Buffer.alloc(0))).statusCode, 400);
  const records = sql(dataDir, db => db.prepare('SELECT name,mime_type,is_image,is_encrypted FROM uploads').all());
  assert.equal(records.length, 1, 'failed uploads leave no metadata behind');
  assert.deepEqual({ ...records[0] }, { name: 'encrypted.bin', mime_type: 'application/octet-stream', is_image: 0, is_encrypted: 1 });
});

test('session revocation, password change and recovery deactivate the correct encryption devices', async t => {
  const { app, advanceTo } = await fixture(t);
  const alice = await register(app, 'alice'), bob = await register(app, 'bob'), other = await login(app, 'alice');
  await chat(app, alice, bob);
  const a = await device(app, alice), a2 = await device(app, other), b = await device(app, bob);
  const peerSocket = await socketFor(t, app, bob);
  const remoteSession = (await request(app, 'GET', '/auth/sessions', alice)).json().sessions.find(session => !session.isCurrent);
  const event = once(peerSocket.socket, 'message');
  assert.equal((await request(app, 'POST', '/auth/sessions/revoke', alice, { sessionId: remoteSession.id })).statusCode, 200);
  assert.deepEqual(JSON.parse((await event)[0]), { type: 'e2ee.devices', userId: alice.user.id });
  let own = (await request(app, 'GET', '/e2ee/devices/self', alice)).json().devices;
  assert.equal(own.find(item => item.id === a.id).active, true);
  assert.equal(own.find(item => item.id === a2.id).active, false);
  const renewed = await login(app, 'alice');
  await device(app, renewed, a2.keys);
  assert.equal((await request(app, 'POST', '/auth/password', alice, { currentPassword: PASSWORD, currentConfirmationWord: CONFIRMATION, newPassword: NEXT_PASSWORD })).statusCode, 200);
  assert.equal((await request(app, 'GET', `/e2ee/devices?userId=${alice.user.id}`, bob)).json().devices.length, 0);
  const current = await login(app, 'alice', NEXT_PASSWORD);
  own = (await request(app, 'GET', '/e2ee/devices/self', current)).json().devices;
  assert.ok(own.every(item => !item.active));
  await device(app, current, a.keys);
  const verification = await request(app, 'POST', '/auth/recovery/verify', null, { username: 'alice', recoveryWord: RECOVERY });
  assert.equal(verification.statusCode, 200);
  advanceTo(verification.json().readyAt);
  assert.equal((await request(app, 'POST', '/auth/recovery/reset', null, { resetToken: verification.json().resetToken, newPassword: PASSWORD })).statusCode, 200);
  assert.deepEqual((await request(app, 'GET', `/e2ee/devices?userId=${alice.user.id}`, bob)).json().devices, []);
  assert.equal((await request(app, 'GET', '/e2ee/devices', bob)).json().devices[0].id, b.id);
});

test('inbox pages messages oldest first per chat, filters device recipients, and requires the bound session', async t => {
  const { app } = await fixture(t);
  const alice = await register(app, 'alice'), bob = await register(app, 'bob'), carol = await register(app, 'carol');
  const other = await login(app, 'alice');
  const ab = await chat(app, alice, bob), ac = await chat(app, alice, carol);
  const a = await device(app, alice), a2 = await device(app, other), b = await device(app, bob), c = await device(app, carol);
  const first = await send(app, alice, ab, encrypted(a, [b, a2]));
  assert.equal(first.statusCode, 201, first.body);
  const bOther = await login(app, 'bob'), b2 = await device(app, bOther);
  const elsewhere = await send(app, alice, ac, encrypted(a, [c, a2]));
  assert.equal(elsewhere.statusCode, 201, elsewhere.body);
  const sentIds = [first.json().message.id];
  for (let index = 0; index < 100; index++) {
    const result = await send(app, alice, ab, encrypted(a, [b, b2, a2]));
    assert.equal(result.statusCode, 201, result.body);
    sentIds.push(result.json().message.id);
  }
  const firstPage = await inbox(app, bob, b, ab);
  assert.equal(firstPage.statusCode, 200, firstPage.body);
  assert.equal(firstPage.json().messages.length, 100);
  assert.equal(firstPage.json().hasMore, true);
  assert.deepEqual(firstPage.json().messages.map(message => message.id), sentIds.slice(0, 100));
  const second = (await inbox(app, bob, b, ab, firstPage.json().nextCursor)).json();
  assert.deepEqual(second.messages.map(message => message.id), sentIds.slice(100));
  assert.equal(second.hasMore, false);
  const empty = (await inbox(app, bob, b, ab, second.nextCursor)).json();
  assert.deepEqual(empty, { messages: [], nextCursor: second.nextCursor, hasMore: false });
  const newDeviceMessages = (await inbox(app, bOther, b2, ab)).json().messages;
  assert.equal(newDeviceMessages.length, 100);
  assert.equal(newDeviceMessages.some(message => message.id === first.json().message.id), false);
  assert.equal((await inbox(app, alice, a, ac)).json().messages[0].id, elsewhere.json().message.id, 'sender messages are included for reconciliation even without a self-envelope');
  assert.equal((await inbox(app, alice, a2, ab)).statusCode, 403, 'same account but wrong bound session cannot drain another device');
  assert.equal((await inbox(app, alice, b, ab)).statusCode, 403);
  assert.equal((await inbox(app, bob, b, ac)).statusCode, 404);
  assert.equal((await inbox(app, bob, b, ab, -1)).statusCode, 400);
  assert.equal((await inbox(app, bob, b, ab, 0, 101)).statusCode, 400);
  assert.equal((await inbox(app, bob, b, ab, 0, 0)).statusCode, 400);
});

test('expired sessions stop device discovery and sending until the same identity registers again', async t => {
  const { app, advance } = await fixture(t, { sessionTtlMs: 1000 });
  const alice = await register(app, 'alice');
  const a = await device(app, alice);
  advance(1000);
  assert.equal((await request(app, 'GET', '/e2ee/devices', alice)).statusCode, 401);
  const renewed = await login(app, 'alice');
  const inactive = (await request(app, 'GET', '/e2ee/devices/self', renewed)).json().devices;
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].active, false);
  assert.deepEqual((await request(app, 'GET', '/e2ee/devices', renewed)).json().devices, []);
  const restored = await device(app, renewed, a.keys);
  assert.equal(restored.id, a.id);
  assert.equal(restored.identityKey, a.identityKey);
  assert.equal(restored.createdAt, a.createdAt);
  assert.equal(restored.active, true);
});

test('revoking a device also revokes its bound login so the same token cannot re-register around revocation', async t => {
  const { app } = await fixture(t);
  const manager = await register(app, 'alice'), target = await login(app, 'alice');
  const first = await device(app, target), second = await device(app, target);
  const remote = await socketFor(t, app, target);
  const closed = once(remote.socket, 'close');
  const revoked = await request(app, 'POST', '/e2ee/devices/revoke', manager, { deviceId: first.id });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await request(app, 'GET', '/me', target)).statusCode, 401, 'revoked installation must lose the credential that could register another key');
  assert.equal((await request(app, 'POST', '/e2ee/devices', target, first.keys)).statusCode, 401);
  assert.equal((await request(app, 'POST', '/e2ee/devices', target, bundle())).statusCode, 401);
  await closed;
  const devices = (await request(app, 'GET', '/e2ee/devices/self', manager)).json().devices;
  assert.equal(devices.find(item => item.id === first.id).active, false);
  assert.equal(devices.find(item => item.id === second.id).active, false);
  assert.equal((await request(app, 'GET', '/me', manager)).statusCode, 200);
  const reauthenticated = await login(app, 'alice');
  assert.equal((await device(app, reauthenticated, first.keys)).active, true, 'fresh password plus confirmation-word login can deliberately reauthorize the identity');
});
