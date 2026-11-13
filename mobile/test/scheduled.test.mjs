import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { harness } from './support/crypto-harness.mjs';
import { validMeta, foldChat } from '../src/messageMeta.ts';
import { canResend, countScheduled, failureText, formatDeliverAt, dayLabel, pushKind, schedulePresets, validateDeliverAt, withDayTime, withSendOptions } from '../src/scheduled/model.ts';

// F4 «Отправить без звука» / «Отправить позже» — the client side: the picker's arithmetic, the labels, the
// `silent` flag inside the ciphertext, and a message dated at its delivery time by the real Signal path.
const at = (iso) => new Date(iso);
const target = '11111111-1111-4111-8111-111111111111';

test('the `silent` flag travels inside the meta: true only, never together with an action', () => {
  assert.equal(validMeta({ silent: true }), true);
  assert.equal(validMeta({ silent: true, entities: [{ type: 'bold', offset: 0, length: 2 }] }), true);
  assert.equal(validMeta({ silent: false }), false, 'absent or true');
  assert.equal(validMeta({ silent: 1 }), false);
  assert.equal(validMeta({ silent: true, action: { type: 'react', target, emoji: '👍' } }), false, 'an action is alone');
  assert.deepEqual(withSendOptions(undefined, { silent: true }), { silent: true });
  assert.deepEqual(withSendOptions({ reply: { clientId: target, senderId: target, preview: 'x' } }, { silent: true }), { reply: { clientId: target, senderId: target, preview: 'x' }, silent: true });
  assert.deepEqual(withSendOptions({ action: { type: 'pin', target } }, { silent: true }), { action: { type: 'pin', target } }, 'actions are never «без звука»');
  assert.equal(withSendOptions(undefined, { deliverAt: '2026-11-09T09:00:00.000Z' }), undefined, 'a time alone adds nothing to the ciphertext');
  assert.equal(pushKind({ silent: true }), 'silent');
  assert.equal(pushKind(undefined), undefined);
  // A call nobody answered: the caller's «end» carries a notification of its own (the ringing one lives 45 s).
  const end = (reason, caller) => ({ action: { type: 'call', call: target, step: 'end', reason, caller } });
  assert.equal(pushKind(end('missed', true)), 'missed');
  assert.equal(pushKind(end('missed', false)), 'none', 'only the caller\'s side announces it');
  assert.equal(pushKind(end('declined', false)), 'none');
  assert.equal(pushKind(end('hangup', true)), 'none', 'a call that took place is not a missed one');
  assert.equal(pushKind({ action: { type: 'call', call: target, step: 'offer' } }), 'call');
  assert.equal(pushKind({ action: { type: 'react', target, emoji: '👍' } }), 'none');
  assert.equal(pushKind({ action: { type: 'call', call: target, step: 'offer', sdp: 'v=0 x' } }), 'call');
  assert.equal(pushKind({ action: { type: 'call', call: target, step: 'end', reason: 'hangup' } }), 'none');
});

test('a silent message is an ordinary message for the chat: it folds, counts and shows like any other', () => {
  const me = 'me', peer = 'peer';
  const msg = (id, senderId, meta) => ({ id, chatId: 'c', senderId, clientId: `k${id}`, text: `t${id}`, attachment: null, createdAt: '2026-11-08T10:00:00.000Z', cryptoState: 'decrypted', ...(meta ? { meta } : {}) });
  const view = foldChat([msg(1, peer), msg(2, me, { silent: true }), msg(3, peer, { silent: true })], me);
  assert.deepEqual(view.messages.map(m => m.id), [1, 2, 3]);
  assert.equal(view.messages[1].meta.silent, true, 'the UI can still tell it was sent quietly');
});

test('the picker: presets lie ahead, custom times are bounded to a minute … a year', () => {
  const morning = at('2026-11-08T10:00:00');
  const presets = schedulePresets(morning);
  assert.deepEqual(presets.map(p => p.label), ['Через час', 'Сегодня в 20:00', 'Завтра в 09:00']);
  assert.equal(presets[0].at.getTime(), at('2026-11-08T11:00:00').getTime());
  assert.equal(presets[1].at.getTime(), at('2026-11-08T20:00:00').getTime());
  assert.equal(presets[2].at.getTime(), at('2026-11-09T09:00:00').getTime());
  for (const preset of presets) assert.equal(validateDeliverAt(preset.at, morning), null, preset.label);
  const late = at('2026-11-08T19:45:00');
  assert.deepEqual(schedulePresets(late).map(p => p.label), ['Через час', 'Завтра в 09:00', 'Завтра в 20:00'], 'tonight is too close: tomorrow evening stands in');
  assert.equal(schedulePresets(at('2026-11-08T10:07:00'))[0].at.getMinutes(), 10, 'rounded up to five minutes');
  assert.match(validateDeliverAt(at('2026-11-08T10:00:30'), morning), /уже прошло/);
  assert.match(validateDeliverAt(at('2026-11-08T09:00:00'), morning), /уже прошло/);
  assert.equal(validateDeliverAt(at('2026-11-08T10:01:00'), morning), null);
  assert.match(validateDeliverAt(at('2027-12-01T10:00:00'), morning), /не больше чем на год/);
  assert.match(validateDeliverAt(new Date(NaN), morning), /Выбери/);
  assert.equal(withDayTime(at('2026-11-08T10:00:00'), 7, 5).getTime(), at('2026-11-08T07:05:00').getTime());
});

test('labels: «Сегодня в», «Завтра в», the date, the year when it differs; the count declines', () => {
  const now = at('2026-11-08T10:00:00');
  assert.equal(formatDeliverAt(at('2026-11-08T20:00:00').toISOString(), now), 'Сегодня в 20:00');
  assert.equal(formatDeliverAt(at('2026-11-09T09:05:00').toISOString(), now), 'Завтра в 09:05');
  assert.equal(formatDeliverAt(at('2026-11-15T09:00:00').toISOString(), now), '15 ноября в 09:00');
  assert.equal(formatDeliverAt(at('2027-01-03T10:00:00').toISOString(), now), '3 января 2027 в 10:00');
  assert.equal(formatDeliverAt('nope', now), '');
  assert.equal(dayLabel(now, now), 'Сегодня');
  assert.equal(dayLabel(at('2026-11-09T00:00:00'), now), 'Завтра');
  assert.equal(dayLabel(at('2026-12-31T00:00:00'), now), '31 декабря');
  assert.equal(countScheduled(1), '1 отложенное сообщение');
  assert.equal(countScheduled(3), '3 отложенных сообщения');
  assert.equal(countScheduled(11), '11 отложенных сообщений');
  assert.equal(countScheduled(21), '21 отложенное сообщение');
});

test('a failed item is retried by itself only when this device holds the text and the peer\'s devices changed', () => {
  const base = { status: 'failed', failure: 'E2EE_DEVICES_CHANGED', cryptoState: 'decrypted' };
  assert.equal(canResend(base), true);
  assert.equal(canResend({ ...base, cryptoState: 'no-key' }), false, 'scheduled from another device: nothing to re-encrypt here');
  assert.equal(canResend({ ...base, status: 'scheduled' }), false);
  assert.equal(canResend({ ...base, failure: 'BLOCKED' }), false);
  assert.match(failureText('E2EE_DEVICES_CHANGED'), /когда вы будете в сети/);
  assert.match(failureText('BLOCKED'), /недоступна/);
  assert.match(failureText('CHAT_GONE'), /удалён/);
  assert.equal(failureText('WHATEVER'), 'Не удалось отправить.');
});

test('encrypt(..., sentAt) dates the message at its delivery time inside the ciphertext; the peer sees that time', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const deliverAt = '2026-11-09T09:00:00.000Z';
  const id = randomUUID();
  const encrypted = await alice.service.encrypt(chatId, bob.userId, id, 'Доброе утро!', null, { silent: true }, deliverAt);
  assert.equal(JSON.stringify(encrypted).includes('Доброе утро'), false, 'no plaintext for the server');
  assert.equal(JSON.stringify(encrypted).includes('silent'), false, 'the quiet flag is inside the ciphertext too');
  assert.equal(JSON.stringify(encrypted).includes(deliverAt), false, 'the server learns the time only from the deliverAt field it is given');
  // Our own copy (the list of «Отложенные» opens it from the vault) is dated at the delivery time.
  const own = await alice.service.preview({ id: 0, chatId, senderId: alice.userId, clientId: id, text: '', attachment: null, createdAt: new Date().toISOString(), encrypted });
  assert.equal(own.cryptoState, 'decrypted'); assert.equal(own.text, 'Доброе утро!'); assert.equal(own.createdAt, deliverAt); assert.equal(own.meta.silent, true);
  // The server releases the very same envelopes at that time; Bob reads the delivery time, not when it was typed.
  const message = relay.deliver(alice.userId, chatId, id, encrypted);
  await bob.service.syncChat(chatId);
  const shown = await bob.service.preview(message);
  assert.equal(shown.cryptoState, 'decrypted'); assert.equal(shown.text, 'Доброе утро!'); assert.equal(shown.createdAt, deliverAt); assert.equal(shown.meta.silent, true);
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, randomUUID(), 'x', null, undefined, 'tomorrow'), /Некорректное содержимое/);
  // Without a time the message is dated now, as before.
  const plainId = randomUUID();
  const plain = await alice.service.encrypt(chatId, bob.userId, plainId, 'сейчас', null);
  const now = await alice.service.preview({ id: 0, chatId, senderId: alice.userId, clientId: plainId, text: '', attachment: null, createdAt: '', encrypted: plain });
  assert.equal(now.cryptoState, 'decrypted'); assert.ok(Date.now() - Date.parse(now.createdAt) < 60_000);
});
