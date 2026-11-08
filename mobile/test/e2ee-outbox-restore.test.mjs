import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { harness } from './support/crypto-harness.mjs';

const texts = items => items.map(item => item.text);

test('G001: the outbox survives a restart, resends the very same ciphertext and empties once delivered', async t => {
  const { alice, bob, relay, chatId, approve, make } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  assert.deepEqual(await alice.service.pendingOutbox(), []);
  const first = randomUUID(), second = randomUUID();
  const encryptedFirst = await alice.service.encrypt(chatId, bob.userId, first, 'Первое, не ушло', null);
  await alice.service.encrypt(chatId, bob.userId, second, 'Второе, не ушло', { id: randomUUID(), name: 'файл.pdf', mimeType: 'application/pdf', size: 10, encryption: { scheme: 'aes-256-gcm-siv', key: Buffer.alloc(32, 1).toString('base64'), nonce: Buffer.alloc(12, 2).toString('base64'), fileKeyId: randomUUID() } }, { forward: { from: 'Кто-то' } });
  // «The app died here»: the vault is all that is left. No internet either — the list still opens.
  const saved = alice.vault.data; await alice.service.close();
  relay.offline = true;
  const reopened = await make(alice.userId, saved);
  const pending = await reopened.service.pendingOutbox();
  assert.deepEqual(pending.map(item => [item.chatId, item.clientId, item.peerId]), [[chatId, first, bob.userId], [chatId, second, bob.userId]], 'oldest first, with the peer to send to');
  assert.deepEqual(texts(pending), ['Первое, не ушло', 'Второе, не ушло']);
  assert.equal(pending[1].attachment.name, 'файл.pdf');
  assert.deepEqual(pending[1].meta, { forward: { from: 'Кто-то' } });
  assert.ok(Number.isFinite(Date.parse(pending[0].sentAt)));
  relay.offline = false;
  // The live send path: encrypt() with the same clientId hands back the committed ciphertext, so the server sees one message.
  const again = await reopened.service.encrypt(chatId, bob.userId, first, 'Первое, не ушло', null);
  assert.deepEqual(again, encryptedFirst);
  await assert.rejects(reopened.service.encrypt(chatId, bob.userId, first, 'Другой текст', null), /уже использован/);
  const message = relay.deliver(alice.userId, chatId, first, again);
  await reopened.service.delivered(chatId, first);
  assert.deepEqual((await reopened.service.pendingOutbox()).map(item => item.clientId), [second]);
  assert.equal(await reopened.vault.get(`outbox:${chatId}:${first}`), null);
  await reopened.service.rejectedDeviceSet(chatId, second);
  assert.deepEqual(await reopened.service.pendingOutbox(), []);
  assert.equal(await reopened.vault.get('outbox:index'), null, 'an empty list is not kept');
  await bob.service.syncChat(chatId);
  assert.equal((await bob.service.preview(message)).text, 'Первое, не ушло');
});

test('G001: a failed commit leaves the outbox list untouched, and a stale name is pruned', async t => {
  const { alice, bob, chatId, approve } = await harness(t);
  await approve(alice, bob);
  const before = new Map(alice.vault.data), id = randomUUID();
  alice.vault.failNext = true;
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, id, 'Атомарно', null), /commit failure/);
  assert.deepEqual(alice.vault.data, before);
  assert.deepEqual(await alice.service.pendingOutbox(), []);
  await alice.service.encrypt(chatId, bob.userId, id, 'Атомарно', null);
  assert.equal(JSON.parse(await alice.vault.get('outbox:index')).length, 1);
  // The entry vanished but its name stayed (an interrupted cleanup): the name is dropped on read.
  await alice.vault.commit({ [`outbox:${chatId}:${id}`]: null });
  assert.deepEqual(await alice.service.pendingOutbox(), []);
  assert.equal(await alice.vault.get('outbox:index'), null);
});

test('G029: decrypted history is named per chat for the local search index, once per message, on both sides', async t => {
  const { alice, bob, relay, chatId, approve, make } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  assert.deepEqual(await alice.service.historyChats(), []);
  const ids = [];
  for (const text of ['Первое', 'Второе', 'Третье']) { const id = randomUUID(); ids.push(id); relay.deliver(alice.userId, chatId, id, await alice.service.encrypt(chatId, bob.userId, id, text, null)); }
  const reply = randomUUID(); relay.deliver(bob.userId, chatId, reply, await bob.service.encrypt(chatId, alice.userId, reply, 'Ответ', null));
  await bob.service.syncChat(chatId); await alice.service.syncChat(chatId);
  assert.deepEqual(await alice.service.historyChats(), [chatId]);
  const mine = await alice.service.history(chatId);
  assert.deepEqual(texts(mine), ['Ответ', 'Третье', 'Второе', 'Первое'], 'newest first; own messages at send time, the peer’s when decrypted');
  assert.deepEqual(mine.map(item => item.senderId), [bob.userId, alice.userId, alice.userId, alice.userId]);
  // Bob named his reply when he sent it, before the sync brought Alice's three: order is «when cached here» (the index sorts by sentAt itself).
  assert.deepEqual(texts(await bob.service.history(chatId)), ['Третье', 'Второе', 'Первое', 'Ответ']);
  assert.deepEqual(texts(await bob.service.history(chatId, 2)), ['Третье', 'Второе'], 'limit');
  // A second sync of the same inbox does not name anything twice.
  await bob.service.syncChat(chatId);
  assert.equal(JSON.parse(await bob.vault.get(`history:${chatId}:0`)).length, 4);
  // The names survive a restart and the cache behind them stays decrypted only inside the vault.
  const saved = bob.vault.data; await bob.service.close();
  const reopened = await make(bob.userId, saved);
  assert.deepEqual(texts(await reopened.service.history(chatId)), ['Третье', 'Второе', 'Первое', 'Ответ']);
  // A fresh device without the keys has no history at all: nothing to search in, nothing leaked.
  const fresh = await make(bob.userId);
  await fresh.service.syncChat(chatId);
  assert.deepEqual(await fresh.service.history(chatId), []);
  assert.deepEqual(await fresh.service.historyChats(), []);
  assert.deepEqual(await alice.service.history(randomUUID()), [], 'an unknown chat');
});

test('G029: a message received over Mesh is named once; the later server copy is not a second entry', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const id = randomUUID(), encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'По Mesh', null);
  assert.equal((await bob.service.receiveMesh({ chatId, clientId: id, senderId: alice.userId, encrypted })).text, 'По Mesh');
  assert.deepEqual(texts(await bob.service.history(chatId)), ['По Mesh']);
  relay.deliver(alice.userId, chatId, id, encrypted);
  await bob.service.syncChat(chatId);
  assert.deepEqual(texts(await bob.service.history(chatId)), ['По Mesh']);
  assert.equal(JSON.parse(await bob.vault.get(`history:${chatId}:0`)).length, 1);
});

test('G029: history pages roll over and the oldest pages are dropped so the vault stays bounded', async t => {
  const { alice, bob, chatId, approve } = await harness(t);
  await approve(alice, bob);
  // Pages hold 50 names (small, since every cached message rewrites the last page) and at most 40 pages
  // are kept: simulate full pages by hand, then add one real message.
  const full = Array.from({ length: 50 }, (_, i) => ['s', `k${i}`]);
  await alice.vault.commit({ [`history:${chatId}`]: JSON.stringify({ first: 3, last: 42 }), ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`history:${chatId}:${3 + i}`, JSON.stringify(full)])), 'history:chats': JSON.stringify([chatId]) });
  const id = randomUUID();
  await alice.service.encrypt(chatId, bob.userId, id, 'Новая страница', null);
  assert.deepEqual(JSON.parse(await alice.vault.get(`history:${chatId}`)), { first: 4, last: 43 });
  assert.equal(await alice.vault.get(`history:${chatId}:3`), null, 'the oldest page went');
  assert.deepEqual(JSON.parse(await alice.vault.get(`history:${chatId}:43`)), [[alice.userId, id]]);
  // Names whose cached message is gone are skipped on read.
  assert.deepEqual(texts(await alice.service.history(chatId)), ['Новая страница']);
  // Page by page: each page is one turn of the crypto queue, `previous` leads to the older page.
  const newest = await alice.service.historyPage(chatId);
  assert.equal(newest.page, 43); assert.equal(newest.previous, 42); assert.deepEqual(texts(newest.items), ['Новая страница']);
  const older = await alice.service.historyPage(chatId, newest.previous);
  assert.deepEqual(older, { items: [], page: 42, previous: 41 }, 'hand-made names without a cached message');
  assert.equal((await alice.service.historyPage(chatId, 4)).previous, null, 'the oldest kept page');
  assert.deepEqual(await alice.service.historyPage(randomUUID()), { items: [], page: 0, previous: null });
});

test('G001: a message the server refused for good is forgotten and starts afresh under the same clientId', async t => {
  const { alice, bob, relay, chatId, approve, make } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const id = randomUUID(), other = randomUUID();
  const first = await alice.service.encrypt(chatId, bob.userId, id, 'Отклонено', null);
  await alice.service.encrypt(chatId, bob.userId, other, 'Остаётся', null);
  // The app got a 4xx for `id` (not 429, not a device-list change): nothing of it may come back after a restart.
  await alice.service.forget(chatId, id);
  assert.deepEqual((await alice.service.pendingOutbox()).map(item => item.clientId), [other]);
  assert.equal(await alice.vault.get(`outbox:${chatId}:${id}`), null);
  assert.equal(await alice.vault.get(`message:${chatId}:${alice.userId}:${id}`), null, 'our cached copy went too');
  assert.deepEqual(texts(await alice.service.history(chatId)), ['Остаётся'], 'its history name is skipped');
  const saved = alice.vault.data; await alice.service.close();
  const reopened = await make(alice.userId, saved);
  assert.deepEqual((await reopened.service.pendingOutbox()).map(item => item.clientId), [other]);
  // The same clientId is free again: a different text is no longer «уже использован», and the ciphertext is new.
  const again = await reopened.service.encrypt(chatId, bob.userId, id, 'Другой текст', null);
  assert.notDeepEqual(again, first);
  relay.deliver(alice.userId, chatId, id, again); await bob.service.syncChat(chatId);
  assert.equal((await bob.service.preview(relay.messages.at(-1))).text, 'Другой текст');
  // Forgetting what is not there is harmless.
  await reopened.service.forget(chatId, randomUUID());
});

test('G001: after E2EE_DEVICES_CHANGED a restored message is encrypted again for the current device list', async t => {
  const { alice, bob, relay, chatId, approve, make } = await harness(t, { autoTrust: true });
  await approve(alice, bob); await approve(bob, alice);
  const id = randomUUID();
  const stale = await alice.service.encrypt(chatId, bob.userId, id, 'Для старого списка', null);
  assert.equal(stale.envelopes.filter(e => e.userId === bob.userId).length, 1);
  // The app died before the send; meanwhile Bob signed in on a second phone.
  const saved = alice.vault.data; await alice.service.close();
  const second = await make(bob.userId);
  const reopened = await make(alice.userId, saved);
  const [restored] = await reopened.service.pendingOutbox();
  assert.equal(restored.clientId, id);
  // The restored send hands back the committed (stale) ciphertext; the server answers E2EE_DEVICES_CHANGED.
  assert.deepEqual(await reopened.service.encrypt(chatId, bob.userId, id, restored.text, restored.attachment, restored.meta), stale);
  await reopened.service.rejectedDeviceSet(chatId, id);
  assert.deepEqual(await reopened.service.pendingOutbox(), [], 'the stale ciphertext is not resent after another restart');
  // The one automatic retry (useMessenger) encrypts afresh: both of Bob's devices are addressed now.
  const fresh = await reopened.service.encrypt(chatId, bob.userId, id, restored.text, restored.attachment, restored.meta);
  assert.notDeepEqual(fresh, stale);
  assert.deepEqual(fresh.envelopes.filter(e => e.userId === bob.userId).map(e => e.deviceId).sort(), [bob.service.deviceId, second.service.deviceId].sort());
  relay.deliver(alice.userId, chatId, id, fresh);
  await bob.service.syncChat(chatId); await second.service.syncChat(chatId);
  assert.equal((await second.service.preview(relay.messages.at(-1))).text, 'Для старого списка');
  await reopened.service.delivered(chatId, id);
  assert.deepEqual(await reopened.service.pendingOutbox(), []);
});

test('G029/G001: a chat deleted on this device leaves no history names and no unsent messages in the vault', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const otherChat = randomUUID();
  const sent = randomUUID(); relay.deliver(alice.userId, chatId, sent, await alice.service.encrypt(chatId, bob.userId, sent, 'Ушло', null));
  await alice.service.delivered(chatId, sent);
  await alice.service.encrypt(chatId, bob.userId, randomUUID(), 'Не ушло', null);
  const keep = randomUUID(); await alice.service.encrypt(otherChat, bob.userId, keep, 'Другой чат', null);
  assert.deepEqual((await alice.service.historyChats()).sort(), [chatId, otherChat].sort());
  await alice.service.forgetChat(chatId);
  assert.deepEqual(await alice.service.historyChats(), [otherChat]);
  assert.equal(await alice.vault.get(`history:${chatId}`), null); assert.equal(await alice.vault.get(`history:${chatId}:0`), null);
  assert.deepEqual(await alice.service.history(chatId), []);
  assert.deepEqual((await alice.service.pendingOutbox()).map(item => item.clientId), [keep], 'the other chat keeps its unsent message');
  assert.deepEqual(texts(await alice.service.history(otherChat)), ['Другой чат']);
  // A chat with nothing cached: nothing to do, nothing written.
  const commits = alice.vault.commits.length;
  await alice.service.forgetChat(randomUUID());
  assert.equal(alice.vault.commits.length, commits);
});
