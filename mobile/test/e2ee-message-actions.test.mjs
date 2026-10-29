import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { harness } from './support/crypto-harness.mjs';
import { foldChat, validMeta, actionFallback, REACTIONS } from '../src/messageMeta.ts';

test('replies, edits, reactions and pins travel only inside the Signal ciphertext and fold correctly', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const sent = [];
  const send = async (from, to, text, meta) => {
    const id = randomUUID();
    const encrypted = await from.service.encrypt(chatId, to.userId, id, text, null, meta);
    // Long texts only: a one-character string can occur inside base64 by chance.
    if (text.length >= 6) assert.equal(JSON.stringify(encrypted).includes(text), false, 'no plaintext in the relayed envelope');
    if (meta) assert.equal(JSON.stringify(encrypted).includes('"action"'), false, 'action type is not visible to the server');
    const message = relay.deliver(from.userId, chatId, id, encrypted); sent.push(message); return { id, message };
  };
  const original = await send(alice, bob, 'Встречаемся в 7?');
  const reply = await send(bob, alice, 'Да, в 7', { reply: { clientId: original.id, senderId: alice.userId, preview: 'Встречаемся в 7?' } });
  const edit = { type: 'edit', target: original.id, text: 'Встречаемся в 8?' };
  await send(alice, bob, actionFallback(edit), { action: edit });
  await send(bob, alice, actionFallback({ type: 'react', target: original.id, emoji: '👍' }), { action: { type: 'react', target: original.id, emoji: '👍' } });
  await send(alice, bob, '📌', { action: { type: 'pin', target: reply.id } });
  // Bob may not edit or delete Alice's message.
  await send(bob, alice, 'x', { action: { type: 'edit', target: original.id, text: 'подделка' } });
  await send(bob, alice, 'x', { action: { type: 'delete', target: original.id } });

  await bob.service.syncChat(chatId);
  const decrypted = await Promise.all(sent.map(message => bob.service.preview(message)));
  assert.ok(decrypted.every(message => message.cryptoState === 'decrypted'));
  assert.deepEqual(decrypted[1].meta.reply, { clientId: original.id, senderId: alice.userId, preview: 'Встречаемся в 7?' });
  const view = foldChat(decrypted, bob.userId);
  assert.equal(view.messages.length, 2, 'action messages are not shown as bubbles');
  const first = view.byClientId.get(original.id);
  assert.equal(first.text, 'Встречаемся в 8?');
  assert.equal(first.edited, true);
  assert.deepEqual(first.reactions, [{ emoji: '👍', count: 1, mine: true }]);
  assert.equal(view.pinned.clientId, reply.id);

  // Delete by the author removes it for everyone; reaction toggle-off clears it.
  await send(alice, bob, '🗑', { action: { type: 'delete', target: original.id } });
  await send(bob, alice, 'x', { action: { type: 'react', target: original.id, emoji: null } });
  await bob.service.syncChat(chatId);
  const after = foldChat(await Promise.all(sent.map(message => bob.service.preview(message))), bob.userId);
  assert.equal(after.byClientId.has(original.id), false);
  assert.equal(after.messages.length, 1);
});

test('meta validation rejects unknown fields, foreign emoji and mixed action payloads', () => {
  const id = randomUUID();
  assert.equal(validMeta(undefined), true);
  assert.equal(validMeta({}), false);
  assert.equal(validMeta({ action: { type: 'react', target: id, emoji: REACTIONS[0] } }), true);
  assert.equal(validMeta({ action: { type: 'react', target: id, emoji: '<script>' } }), false);
  assert.equal(validMeta({ action: { type: 'edit', target: id, text: '' } }), false);
  assert.equal(validMeta({ action: { type: 'pin', target: null } }), true);
  assert.equal(validMeta({ action: { type: 'pin', target: id }, reply: { clientId: id, senderId: id, preview: '' } }), false);
  assert.equal(validMeta({ reply: { clientId: id, senderId: id, preview: 'x'.repeat(201) } }), false);
  assert.equal(validMeta({ forward: { from: 'Алиса' } }), true);
  assert.equal(validMeta({ forward: { from: 'Алиса', url: 'x' } }), false);
  assert.equal(validMeta({ gps: '1,2' }), false);
});

test('encrypt refuses malformed meta before any ciphertext is produced', async t => {
  const { alice, bob, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, randomUUID(), 'x', null, { action: { type: 'nuke' } }), /Некорректное/);
});

test('hidden-for-me messages disappear only from the local view', () => {
  const a = randomUUID(), b = randomUUID(), alice = randomUUID();
  const base = { chatId: 'c', attachment: null, createdAt: '2026-10-29T00:00:00Z', cryptoState: 'decrypted' };
  const messages = [{ ...base, id: 1, senderId: alice, clientId: a, text: 'one' }, { ...base, id: 2, senderId: alice, clientId: b, text: 'two' }];
  const view = foldChat(messages, alice, new Set([`${alice}:${a}`]));
  assert.deepEqual(view.messages.map(message => message.text), ['two']);
});
