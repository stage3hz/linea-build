import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildApp } from '../../server/src/app.js';
import { loadTs } from './support/load-ts.mjs';
import { CryptoService, MemoryVault, sha256 } from './support/crypto-harness.mjs';
import { nodeSignalBridge as bridge } from './support/signal-node.mjs';

const { Api } = loadTs(new URL('../src/api.ts', import.meta.url), {
  'react-native': { Platform: { OS: 'android' } }, 'expo-file-system/legacy': {}, 'expo-sharing': {},
});
const PASSWORD = 'Synthetic!Integration.42.Password';
const NEW_PASSWORD = 'Synthetic!Restored.77.Password';
const CONFIRMATION = 'AmberGardenPrism';
const RECOVERY = 'SilverHarborLantern';
const b64 = bytes => Buffer.from(bytes).toString('base64');

test('real Api, CryptoService and Fastify relay exchange private messages/files and retain local keys across password recovery', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-e2ee-integration-'));
  let serverTime = Date.now();
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, now: () => serverTime });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`, guest = new Api(base), clients = [];
  t.after(async () => {
    for (const client of clients) await client.service.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const attach = async (session, data) => {
    const api = new Api(base, session.token), vault = new MemoryVault(data);
    const service = new CryptoService(session.user.id, api, bridge, vault, randomUUID, sha256);
    const client = { api, vault, service, session };
    clients.push(client);
    await service.initialize();
    return client;
  };
  const aliceSession = await guest.register('alice', PASSWORD, 'Synthetic Alice', CONFIRMATION, RECOVERY);
  const bobSession = await guest.register('bob', PASSWORD, 'Synthetic Bob', CONFIRMATION, RECOVERY);
  const aliceApi = new Api(base, aliceSession.token);
  const chat = (await aliceApi.createChat(bobSession.user.id)).chat;
  const alice = await attach(aliceSession), bob = await attach(bobSession);
  const approve = async (a, b) => a.service.approveDevices(await a.service.trustSnapshot(b.session.user.id));
  await approve(alice, bob); await approve(bob, alice);

  const secret = 'Private integration payload: archive-owl-7429';
  const firstId = randomUUID();
  const firstEncrypted = await alice.service.encrypt(chat.id, bobSession.user.id, firstId, secret, null);
  const first = (await alice.api.sendEncrypted(chat.id, firstId, firstEncrypted)).message;
  assert.equal(first.text, '');
  assert.equal(first.encrypted.scheme, 'signal-v1');
  await alice.service.delivered(chat.id, firstId);
  await bob.service.syncChat(chat.id);
  assert.equal((await bob.service.preview(first)).text, secret);
  const retried = await alice.api.sendEncrypted(chat.id, firstId, { ...firstEncrypted, envelopes: [...firstEncrypted.envelopes].reverse() });
  assert.equal(retried.message.id, first.id, 'the HTTP relay must canonicalize idempotent encrypted retries');

  const replyId = randomUUID();
  const replyEncrypted = await bob.service.encrypt(chat.id, aliceSession.user.id, replyId, 'Real reverse Signal reply', null);
  assert.equal(replyEncrypted.envelopes[0].type, 2);
  const reply = (await bob.api.sendEncrypted(chat.id, replyId, replyEncrypted)).message;
  await bob.service.delivered(chat.id, replyId);
  await alice.service.syncChat(chat.id);
  assert.equal((await alice.service.preview(reply)).text, 'Real reverse Signal reply');

  const filePlain = Buffer.from('Actual confidential file bytes: meadow-9813');
  const filename = 'private-original-name-9813.txt', key = b64(randomBytes(32)), nonce = b64(randomBytes(12)), fileKeyId = randomUUID();
  const ad = b64(`linea-attachment-v1:${fileKeyId}`);
  const cipher = Buffer.from(await bridge.seal(b64(filePlain), key, nonce, ad), 'base64');
  const form = new FormData();
  form.append('file', new Blob([cipher], { type: 'application/octet-stream' }), 'encrypted.bin');
  const uploaded = await alice.api.request('/e2ee/files', { method: 'POST', body: form });
  assert.deepEqual(Object.keys(uploaded).sort(), ['id', 'size']);
  assert.equal(uploaded.size, filePlain.length + 16);
  const inaccessible = await fetch(bob.api.fileUrl(uploaded.id), { headers: { Authorization: `Bearer ${bobSession.token}` } });
  assert.ok([403, 404].includes(inaccessible.status));
  const attachment = { id: uploaded.id, name: filename, mimeType: 'text/plain', size: filePlain.length, encryption: { scheme: 'aes-256-gcm-siv', key, nonce, fileKeyId } };
  const fileClientId = randomUUID();
  const fileMessage = (await alice.api.sendEncrypted(chat.id, fileClientId, await alice.service.encrypt(chat.id, bobSession.user.id, fileClientId, 'Encrypted attachment', attachment))).message;
  await bob.service.syncChat(chat.id);
  const opened = await bob.service.preview(fileMessage);
  assert.equal(opened.attachment.name, filename);
  const downloaded = await fetch(bob.api.fileUrl(uploaded.id), { headers: { Authorization: `Bearer ${bobSession.token}` } });
  assert.equal(downloaded.status, 200);
  const downloadedCipher = Buffer.from(await downloaded.arrayBuffer());
  assert.deepEqual(downloadedCipher, cipher);
  assert.equal(await bridge.open(b64(downloadedCipher), opened.attachment.encryption.key, opened.attachment.encryption.nonce, ad), b64(filePlain));
  assert.deepEqual(await readFile(path.join(dataDir, 'uploads', uploaded.id)), cipher);

  const secondBobSession = await guest.login('bob', PASSWORD, CONFIRMATION);
  const secondBob = await attach(secondBobSession);
  await assert.rejects(bob.api.cryptoInbox(secondBob.service.deviceId, chat.id, 0), error => error.status === 403, 'a device inbox is bound to the session that registered it');
  await secondBob.service.syncChat(chat.id);
  assert.equal((await secondBob.service.preview(first)).cryptoState, 'no-key');
  await assert.rejects(alice.service.encrypt(chat.id, bobSession.user.id, randomUUID(), 'New device requires approval', null), { name: 'UntrustedDeviceError' });
  await approve(alice, bob); await approve(secondBob, alice);
  const fanoutId = randomUUID(), fanout = await alice.service.encrypt(chat.id, bobSession.user.id, fanoutId, 'Approved new device fanout', null);
  assert.equal(fanout.envelopes.length, 2);
  const fanoutMessage = (await alice.api.sendEncrypted(chat.id, fanoutId, fanout)).message;
  for (const client of [bob, secondBob]) {
    await client.service.syncChat(chat.id);
    assert.equal((await client.service.preview(fanoutMessage)).text, 'Approved new device fanout');
  }

  const database = new DatabaseSync(path.join(dataDir, 'linea.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare('SELECT text,encrypted_json FROM messages').all();
    assert.ok(rows.length >= 4);
    assert.equal(rows.every(row => row.text === '' && typeof row.encrypted_json === 'string'), true);
    const uploads = database.prepare('SELECT * FROM uploads').all();
    assert.equal(uploads[0].name, 'encrypted.bin');
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const dump = JSON.stringify(tables.map(table => database.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all()));
    for (const plaintext of [secret, filename, filePlain.toString(), key, nonce]) assert.equal(dump.includes(plaintext), false, 'server rows must not contain client plaintext or file encryption keys');
    for (const client of [alice, bob, secondBob]) {
      const privateKey = JSON.parse(await client.vault.get('protocol')).identityPrivate;
      assert.equal(dump.includes(privateKey), false);
    }
  } finally { database.close(); }

  const savedBob = bob.vault.data, originalDeviceId = bob.service.deviceId;
  const recovery = await guest.verifyRecovery('bob', RECOVERY);
  serverTime = Date.parse(recovery.readyAt);
  await guest.resetPassword(recovery.resetToken, NEW_PASSWORD);
  await assert.rejects(bob.api.me(), error => error.status === 401);
  await bob.service.close(); await secondBob.service.close();
  const restoredSession = await guest.login('bob', NEW_PASSWORD, CONFIRMATION);
  const restored = await attach(restoredSession, savedBob);
  assert.equal(restored.service.deviceId, originalDeviceId, 'account password reset does not silently replace intact local identity keys');
  await restored.service.syncChat(chat.id);
  assert.equal((await restored.service.preview(first)).text, secret, 'the same physical key store retains its existing local history');
});
