import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from './support/crypto-harness.mjs';

// Alice and Bob have written to each other before (sessions exist), then the internet is gone.
async function talked(t) {
  const h = await harness(t, { autoTrust: true });
  const { alice, bob, chatId, relay } = h;
  const a = randomUUID(); relay.deliver(alice.userId, chatId, a, await alice.service.encrypt(chatId, bob.userId, a, 'привет', null));
  await bob.service.syncChat(chatId);
  const b = randomUUID(); relay.deliver(bob.userId, chatId, b, await bob.service.encrypt(chatId, alice.userId, b, 'привет-привет', null));
  await alice.service.syncChat(chatId);
  return h;
}

test('without internet: encrypt from saved keys, deliver over Mesh, then the server copy is matched, not shown twice', async t => {
  const { alice, bob, chatId, relay } = await talked(t);
  relay.offline = true;
  const id = randomUUID();
  const encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'по Mesh', null);
  const plain = await bob.service.receiveMesh({ chatId, clientId: id, senderId: alice.userId, encrypted });
  assert.equal(plain.text, 'по Mesh');
  assert.equal(await bob.service.receiveMesh({ chatId, clientId: id, senderId: alice.userId, encrypted }), null, 'a second copy over Mesh is ignored');
  // Internet is back: Alice's app re-sends the same committed ciphertext to the server.
  relay.offline = false;
  const again = await alice.service.encrypt(chatId, bob.userId, id, 'по Mesh', null);
  assert.deepEqual(again, encrypted, 'retry reuses the exact ciphertext');
  const message = relay.deliver(alice.userId, chatId, id, again);
  await bob.service.syncChat(chatId);
  assert.equal((await bob.service.preview(message)).text, 'по Mesh');
});

test('server copy re-encrypted after a device change still matches; a changed text is refused', async t => {
  const { alice, bob, chatId, relay } = await talked(t);
  relay.offline = true;
  const id = randomUUID();
  const encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'то же самое', null);
  await bob.service.receiveMesh({ chatId, clientId: id, senderId: alice.userId, encrypted });
  relay.offline = false;
  await alice.service.rejectedDeviceSet(chatId, id);
  const fresh = await alice.service.encrypt(chatId, bob.userId, id, 'то же самое', null);
  assert.notDeepEqual(fresh, encrypted);
  const message = relay.deliver(alice.userId, chatId, id, fresh);
  await bob.service.syncChat(chatId);
  assert.equal((await bob.service.preview(message)).text, 'то же самое');

  relay.offline = true;
  const other = randomUUID();
  const first = await alice.service.encrypt(chatId, bob.userId, other, 'оригинал', null);
  await bob.service.receiveMesh({ chatId, clientId: other, senderId: alice.userId, encrypted: first });
  relay.offline = false;
  await alice.service.rejectedDeviceSet(chatId, other);
  relay.deliver(alice.userId, chatId, other, await alice.service.encrypt(chatId, bob.userId, other, 'подменено', null));
  await assert.rejects(bob.service.syncChat(chatId), /не совпадают/);
});

test('without internet: no first message to a stranger, no new keys accepted, forged sender rejected', async t => {
  const { alice, bob, chatId, relay, make } = await talked(t);
  const carol = await make();
  relay.offline = true;
  await assert.rejects(alice.service.encrypt(chatId, carol.userId, randomUUID(), 'кто ты', null), /уже переписывались/);
  // A packet claiming to be from Carol but encrypted by Alice is not accepted by Bob.
  const id = randomUUID();
  const encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'подделка', null);
  await assert.rejects(bob.service.receiveMesh({ chatId, clientId: id, senderId: carol.userId, encrypted }).then(v => { if (v === null) throw new Error('dropped'); return v; }));
  assert.equal(await bob.service.receiveMesh({ chatId, clientId: id, senderId: alice.userId, encrypted: { ...encrypted, envelopes: [] } }), null);
});

test('lean lists: text comes only from this device\'s decrypted copy', async t => {
  const { alice, bob, chatId, relay } = await talked(t);
  const id = randomUUID();
  const message = relay.deliver(alice.userId, chatId, id, await alice.service.encrypt(chatId, bob.userId, id, 'лёгкий список', null));
  const lean = { ...message, encrypted: undefined, lean: true };
  assert.equal((await bob.service.preview(lean)).cryptoState, 'no-key', 'not opened yet: nothing invented');
  await bob.service.syncChat(chatId);
  const shown = await bob.service.preview({ ...lean, text: 'подмена от сервера' });
  assert.equal(shown.text, 'лёгкий список'); assert.equal(shown.cryptoState, 'decrypted');
  assert.equal((await alice.service.preview(lean)).text, 'лёгкий список', 'own sent message from the local copy');
  assert.equal((await bob.service.preview({ ...message, encrypted: undefined })).cryptoState, 'legacy', 'no lean flag: old behaviour');
});

test('lean inbox: own messages without ciphertext only move the cursor; others still need it', async t => {
  const { alice, bob, chatId, relay } = await talked(t);
  const id = randomUUID();
  relay.deliver(alice.userId, chatId, id, await alice.service.encrypt(chatId, bob.userId, id, 'своё', null));
  const original = relay.inboxTransform;
  relay.inboxTransform = page => ({ ...page, messages: page.messages.map(m => m.senderId === alice.userId ? { ...m, encrypted: undefined, lean: true } : m) });
  await alice.service.syncChat(chatId);
  await assert.rejects(bob.service.syncChat(chatId), 'a lean message from someone else is refused');
  relay.inboxTransform = original;
});
