import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { harness, canonicalEncrypted } from './support/crypto-harness.mjs';
import { loadTs } from './support/load-ts.mjs';
import { jpegFixture } from './support/jpeg-fixture.mjs';

test('CryptoService persists local identity before publication and refuses an incomplete local store', async t => {
  const { alice, relay, make } = await harness(t, { initialize: false });
  alice.vault.failNext = true;
  await assert.rejects(alice.service.initialize(), /commit failure/);
  assert.equal(relay.registrations.length, 0);
  await alice.service.initialize();
  assert.equal(relay.registrations.length, 1);
  assert.ok(await alice.vault.get('protocol'));
  const partial = await make(randomUUID(), new Map([['device', await alice.vault.get('device')]]));
  await assert.rejects(partial.service.initialize(), /ключи недоступны/i);
  assert.equal(relay.registrations.length, 1, 'broken persistence cannot silently publish another identity');
});

test('embedded media preview and technical values travel only inside the authenticated Signal message',async t=>{
  const {alice,bob,relay,chatId,approve}=await harness(t);await approve(alice,bob);await approve(bob,alice);
  const {createPreview}=loadTs(new URL('../src/media/previewModel.ts',import.meta.url));
  const attachment={id:randomUUID(),name:'photo.jpg',mimeType:'image/jpeg',size:300,encryption:{scheme:'aes-256-gcm-siv',key:Buffer.alloc(32,1).toString('base64'),nonce:Buffer.alloc(12,2).toString('base64'),fileKeyId:randomUUID()},media:{width:2,height:2,hdr:'sdr'},preview:createPreview(jpegFixture())};
  const id=randomUUID(),encrypted=await alice.service.encrypt(chatId,bob.userId,id,'Фото с миниатюрой',attachment);
  assert.equal(JSON.stringify(encrypted).includes(attachment.preview.base64),false);
  const message=relay.deliver(alice.userId,chatId,id,encrypted);await bob.service.syncChat(chatId);
  assert.deepEqual((await bob.service.preview(message)).attachment,attachment);
  for(const bad of [{...attachment,preview:{...attachment.preview,width:9999}},{...attachment,media:{gps:'private'}},{...attachment,preview:{...attachment.preview,url:'https://outside.example'}},{...attachment,extra:'unexpected payload'},{...attachment,encryption:{...attachment.encryption,extra:'unexpected payload'}}])await assert.rejects(alice.service.encrypt(chatId,bob.userId,randomUUID(),'bad',bad),/Некорректное/);
});

test('sending and receiving remain blocked until each side approves the same safety code', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  const id = randomUUID();
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, id, 'Trust gate', null), { name: 'UntrustedDeviceError' });
  assert.equal(relay.claims.length, 0);
  const a = await alice.service.trustSnapshot(bob.userId), b = await bob.service.trustSnapshot(alice.userId);
  assert.equal(a.devices[0].code, b.devices[0].code);
  await approve(alice, bob);
  const encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'Trust gate', null);
  const message = relay.deliver(alice.userId, chatId, id, encrypted);
  await assert.rejects(bob.service.syncChat(chatId), { name: 'UntrustedDeviceError' });
  assert.equal(await bob.vault.get(`cursor:${chatId}`), null);
  assert.equal((await bob.service.preview(message)).cryptoState, 'unverified');
  await approve(bob, alice);
  await bob.service.syncChat(chatId);
  assert.equal((await bob.service.preview(message)).text, 'Trust gate');
  assert.equal((await bob.service.preview(message)).cryptoState, 'decrypted');
});

test('ratchet, local history and outbox commit atomically before an encrypted payload is released', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const before = new Map(alice.vault.data), id = randomUUID();
  alice.vault.failNext = true;
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, id, 'Atomic send', null), /commit failure/);
  assert.deepEqual(alice.vault.data, before);
  assert.equal(relay.messages.length, 0);
  const encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'Atomic send', null);
  assert.ok(await alice.vault.get(`outbox:${chatId}:${id}`));
  assert.notEqual(await alice.vault.get('protocol'), before.get('protocol'));
  const message = relay.deliver(alice.userId, chatId, id, encrypted);
  await bob.service.syncChat(chatId);
  assert.equal((await bob.service.preview(message)).text, 'Atomic send');
});

test('retries reuse committed ciphertext, including a failed cleanup after delivery', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const id = randomUUID(), encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'Retry once', null);
  const protocol = await alice.vault.get('protocol'), claims = relay.claims.length;
  assert.deepEqual(await alice.service.encrypt(chatId, bob.userId, id, 'Retry once', null), encrypted);
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, id, 'Different text', null), /уже использован/i);
  const message = relay.deliver(alice.userId, chatId, id, encrypted);
  alice.vault.failNext = true;
  await assert.rejects(alice.service.delivered(chatId, id), /commit failure/);
  assert.deepEqual(await alice.service.encrypt(chatId, bob.userId, id, 'Retry once', null), encrypted);
  assert.equal(await alice.vault.get('protocol'), protocol);
  assert.equal(relay.claims.length, claims);
  await alice.service.delivered(chatId, id);
  assert.equal(await alice.vault.get(`outbox:${chatId}:${id}`), null);
  await bob.service.syncChat(chatId);
  assert.equal((await bob.service.preview(message)).text, 'Retry once');
});

test('new devices and substituted claim identities require a fresh approval before encryption', async t => {
  const { alice, bob, make, chatId, relay, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const oldSnapshot = await alice.service.trustSnapshot(bob.userId);
  const extra = await make(bob.userId);
  await assert.rejects(alice.service.approveDevices(oldSnapshot), /изменился/i);
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, randomUUID(), 'New device', null), { name: 'UntrustedDeviceError' });
  await approve(alice, bob);
  const honest = relay.devices.get(`${bob.userId}:${bob.service.deviceId}`);
  relay.swapClaim = result => ({ ...result, bundle: { ...result.bundle, identityKey: relay.devices.get(`${bob.userId}:${extra.service.deviceId}`).bundle.identityKey } });
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, randomUUID(), 'Swapped key', null), { name: 'UntrustedDeviceError' });
  assert.equal(honest.device.identityKey, honest.bundle.identityKey);
});

test('multi-device fanout and canonical envelope order preserve the authenticated local preview', async t => {
  const { alice, bob, make, chatId, relay, approve } = await harness(t);
  const secondBob = await make(bob.userId);
  await approve(alice, bob); await approve(bob, alice); await approve(secondBob, alice);
  const id = randomUUID(), encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'Two recipient devices', null);
  assert.equal(encrypted.envelopes.length, 2);
  const reordered = { ...encrypted, envelopes: [...encrypted.envelopes].reverse() };
  assert.equal(canonicalEncrypted(encrypted), canonicalEncrypted(reordered));
  const message = relay.deliver(alice.userId, chatId, id, reordered);
  assert.equal((await alice.service.preview(message)).text, 'Two recipient devices');
  for (const client of [bob, secondBob]) {
    await client.service.syncChat(chatId);
    assert.equal((await client.service.preview(message)).text, 'Two recipient devices');
  }
});

test('oldest-first inbox pages and durable cursors survive reopening the same vault', async t => {
  const { alice, bob, make, chatId, relay, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  for (let index = 0; index < 5; index++) {
    const id = randomUUID(), encrypted = await alice.service.encrypt(chatId, bob.userId, id, `history-${index}`, null);
    relay.deliver(alice.userId, chatId, id, encrypted);
  }
  await bob.service.syncChat(chatId);
  assert.equal(await bob.vault.get(`cursor:${chatId}`), '5');
  const saved = bob.vault.data, oldDevice = bob.service.deviceId;
  await bob.service.close();
  const reopened = await make(bob.userId, saved);
  assert.equal(reopened.service.deviceId, oldDevice);
  await reopened.service.syncChat(chatId);
  for (let index = 0; index < 5; index++) assert.equal((await reopened.service.preview(relay.messages[index])).text, `history-${index}`);
});

test('authenticated routing metadata and tampered ciphertext stop inbox advancement', async t => {
  const { alice, bob, chatId, relay, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const id = randomUUID(), encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'Bound to this client id', null);
  const message = relay.deliver(alice.userId, chatId, id, encrypted);
  relay.inboxTransform = result => ({ ...result, messages: result.messages.map(value => ({ ...value, clientId: randomUUID() })) });
  await assert.rejects(bob.service.syncChat(chatId), /не соответствует/i);
  assert.equal(await bob.vault.get(`cursor:${chatId}`), null);
  relay.inboxTransform = result => {
    const damaged = structuredClone(result); const envelope = damaged.messages[0].encrypted.envelopes[0];
    const bytes = Buffer.from(envelope.body, 'base64'); bytes[bytes.length - 1] ^= 1; envelope.body = bytes.toString('base64'); return damaged;
  };
  await assert.rejects(bob.service.syncChat(chatId));
  assert.equal(await bob.vault.get(`cursor:${chatId}`), null);
  relay.inboxTransform = null;
  await bob.service.syncChat(chatId);
  assert.equal((await bob.service.preview(message)).text, 'Bound to this client id');
});

test('losing the local key store does not reveal old history after account access returns', async t => {
  const { alice, bob, make, chatId, relay, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const id = randomUUID(), encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'Old private history', null);
  const message = relay.deliver(alice.userId, chatId, id, encrypted);
  const fresh = await make(bob.userId);
  await fresh.service.syncChat(chatId);
  const preview = await fresh.service.preview(message);
  assert.equal(preview.cryptoState, 'no-key');
  assert.equal(preview.text.includes('Old private history'), false);
  assert.equal([...fresh.vault.data.values()].some(value => value.includes('Old private history')), false);
});

test('malformed encrypted transport data produces an invalid preview rather than crashing the chat', async t => {
  const { bob, chatId, alice, relay } = await harness(t);
  const envelope = { userId: bob.userId, deviceId: bob.service.deviceId, type: 3, body: 'AA==' };
  const basic = { scheme: 'signal-v1', senderDeviceId: randomUUID(), envelopes: [envelope] };
  for (const encrypted of [
    { ...basic, envelopes: null }, { ...basic, envelopes: [null] },
    { ...basic, scheme: 'plaintext' }, { ...basic, senderDeviceId: 'invalid' },
    { ...basic, envelopes: [{ ...envelope, type: 8 }] },
    { ...basic, envelopes: [{ ...envelope, userId: 'not-a-uuid' }] },
    { ...basic, envelopes: [{ ...envelope, body: 'AB==' }] },
    { ...basic, envelopes: [{ ...envelope, body: Buffer.alloc(64 * 1024 + 1).toString('base64') }] },
    { ...basic, envelopes: [envelope, envelope] },
    { ...basic, attachmentIds: ['invalid'] }, { ...basic, extra: 'unrecognized' },
  ]) {
    const malformed = { id: 1, chatId, clientId: randomUUID(), senderId: alice.userId, text: 'server supplied plaintext', attachment: null, createdAt: new Date().toISOString(), encrypted };
    const preview = await bob.service.preview(malformed);
    assert.equal(preview.cryptoState, 'invalid');
    assert.equal(preview.text.includes('server supplied plaintext'), false);
    assert.equal(preview.attachment, null);
    relay.messages = [malformed];
    await assert.rejects(bob.service.syncChat(chatId), /Некорректный зашифрованный пакет/i);
    assert.equal(await bob.vault.get(`cursor:${chatId}`), null);
  }
});
