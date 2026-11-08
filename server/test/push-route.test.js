import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createPush } from '../src/push.js';

const IOS_TOKEN = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
const ANDROID_TOKEN = 'fcm-registration-token:APA91bExample_1234567890';

async function account(app, username) {
  const registration = await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: 'Push test', password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } });
  assert.equal(registration.statusCode, 201, registration.body);
  const body = registration.json();
  return { headers: { authorization: `Bearer ${body.token}` }, userId: body.user.id };
}
const key33 = () => Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString('base64');
async function device(app, who) {
  const response = await app.inject({ method: 'POST', url: '/e2ee/devices', headers: who.headers, payload: {
    deviceId: randomUUID(), deviceName: 'Synthetic test device', registrationId: 1234, identityKey: key33(),
    signedPreKey: { id: 100, publicKey: key33(), signature: randomBytes(64).toString('base64') },
    kyberPreKey: { id: 200, publicKey: randomBytes(1569).toString('base64'), signature: randomBytes(64).toString('base64') },
    preKeys: [1, 2].map(id => ({ id, publicKey: key33() })),
  } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().device;
}

test('PUT /me/push accepts an iPhone (APNs hex) token and reports whether the server can send to it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-push-route-'));
  const sent = [];
  const push = createPush({ ios: async (token, message) => { sent.push({ token, message }); return 'ok'; } });
  const app = await buildApp({ dataDir, authRateLimit: false, push });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { headers } = await account(app, 'iphone_user');

  const ios = await app.inject({ method: 'PUT', url: '/me/push', headers, payload: { token: IOS_TOKEN, platform: 'ios' } });
  assert.equal(ios.statusCode, 200);
  assert.deepEqual(ios.json(), { ok: true, enabled: true });

  // Android tokens are stored too, but this server has no Firebase key: the app shows «server-off».
  const android = await app.inject({ method: 'PUT', url: '/me/push', headers, payload: { token: ANDROID_TOKEN, platform: 'android' } });
  assert.equal(android.statusCode, 200);
  assert.deepEqual(android.json(), { ok: true, enabled: false });

  // An APNs token is hex only; anything else on ios is refused before it reaches the table.
  const bad = await app.inject({ method: 'PUT', url: '/me/push', headers, payload: { token: ANDROID_TOKEN, platform: 'ios' } });
  assert.equal(bad.statusCode, 400);
  const unknown = await app.inject({ method: 'PUT', url: '/me/push', headers, payload: { token: IOS_TOKEN, platform: 'web' } });
  assert.equal(unknown.statusCode, 400);

  const gone = await app.inject({ method: 'DELETE', url: '/me/push', headers });
  assert.equal(gone.statusCode, 200);
  assert.equal(sent.length, 0, 'registering a token sends nothing by itself');
});

test('a message to an iPhone user goes through Apple with the sender name only', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-push-route-'));
  const sent = [];
  const push = createPush({ ios: async (token, message) => { sent.push({ token, message }); return 'ok'; } });
  const app = await buildApp({ dataDir, authRateLimit: false, push });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const receiver = await account(app, 'receiver_ios');
  const sender = await account(app, 'sender_any');
  assert.equal((await app.inject({ method: 'PUT', url: '/me/push', headers: receiver.headers, payload: { token: IOS_TOKEN, platform: 'ios' } })).statusCode, 200);

  // Synthetic Signal-shaped envelopes: the relay only checks their shape, never their content.
  const receiverDevice = await device(app, receiver);
  const senderDevice = await device(app, sender);
  const chat = await app.inject({ method: 'POST', url: '/chats', headers: sender.headers, payload: { userId: receiver.userId } });
  assert.ok([200, 201].includes(chat.statusCode), chat.body);
  const chatId = chat.json().chat.id;
  const ciphertext = randomBytes(96).toString('base64');
  const message = await app.inject({ method: 'POST', url: `/chats/${encodeURIComponent(chatId)}/messages`, headers: sender.headers, payload: {
    clientId: randomUUID(),
    encrypted: { scheme: 'signal-v1', senderDeviceId: senderDevice.id, envelopes: [{ userId: receiver.userId, deviceId: receiverDevice.id, type: 3, body: ciphertext }], attachmentIds: [] },
  } });
  assert.equal(message.statusCode, 201, message.body);

  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1, 'exactly one push to the registered iPhone');
  assert.equal(sent[0].token, IOS_TOKEN);
  const payload = sent[0].message.apns.payload;
  assert.equal(payload.chatId, chatId);
  assert.equal(payload.kind, 'message');
  assert.equal(payload.aps.alert.title, 'Push test');
  assert.equal(payload.aps.alert.body, 'Новое сообщение');
  assert.ok(!JSON.stringify(sent[0].message).includes(ciphertext), 'push carries no ciphertext either');
});
