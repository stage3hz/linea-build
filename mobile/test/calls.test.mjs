import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const model = loadTs(new URL('../src/calls/callModel.ts', import.meta.url), {});
const meta = loadTs(new URL('../src/messageMeta.ts', import.meta.url), {});
const id = '0b6f1b9a-1f0e-4c43-9a35-0e6f0c1d2e3f';
const sdpA = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB:CC\r\n';
const sdpB = 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 11:22:33\r\n';

test('call signalling is a valid encrypted action with strict fields', () => {
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'offer', video: true, sdp: sdpA } }), true);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'end', reason: 'declined' } }), true);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'offer' } }), false, 'offer needs SDP');
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'end', sdp: sdpA } }), false, 'end carries no SDP');
  assert.equal(meta.validMeta({ action: { type: 'call', call: 'nope', step: 'end' } }), false);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'answer', sdp: 'x'.repeat(10) } }), false);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'end', reason: 'weird' } }), false);
});

test('call actions never become visible messages', () => {
  const messages = [{ id: 1, chatId: 'c', senderId: 'u', clientId: id, text: '📞 Звонок', attachment: null, createdAt: '2026-10-30T10:00:00Z', cryptoState: 'decrypted', meta: { action: { type: 'call', call: id, step: 'offer', sdp: sdpA } } }];
  assert.equal(meta.foldChat(messages, 'u').messages.length, 0);
});

test('only fresh, unseen offers ring', () => {
  const now = Date.parse('2026-10-30T10:00:30Z');
  assert.equal(model.offerIsFresh('2026-10-30T10:00:00Z', now, new Set(), id), true);
  assert.equal(model.offerIsFresh('2026-10-30T09:59:00Z', now, new Set(), id), false);
  assert.equal(model.offerIsFresh('2026-10-30T10:00:00Z', now, new Set([id]), id), false);
});

test('both sides derive the same key emoji from the two DTLS fingerprints', () => {
  assert.equal(model.keyMaterial(sdpA, sdpB), model.keyMaterial(sdpB, sdpA));
  assert.equal(model.keyMaterial(sdpA, 'v=0\r\n'), null);
  const emoji = model.keyEmoji('0123456789abcdef0123');
  assert.equal(emoji.length, 4);
  assert.deepEqual(model.keyEmoji('0123456789abcdef0123'), emoji);
  assert.equal(model.callClock(65_400), '1:05');
});

// F9 review: every `end` this phone sends is built by one function and carries the same fields as a hang-up.
const source = (over = {}) => ({ id, video: false, incoming: false, startedAt: null, ...over });

test('the `end` builder: outcome, video, caller, and the duration only once the media connected', () => {
  const t0 = Date.UTC(2026, 10, 7, 10, 0, 0);
  assert.deepEqual(model.callEndMeta(source({ video: true, startedAt: t0 }), 'hangup', t0 + 192_400), { type: 'call', call: id, step: 'end', reason: 'hangup', video: true, caller: true, duration: 192 });
  assert.deepEqual(model.callEndMeta(source({ incoming: true }), 'busy'), { type: 'call', call: id, step: 'end', reason: 'busy', video: false, caller: false }, 'busy / privacy ends: no duration key at all, but video and caller are there');
  assert.deepEqual(model.callEndMeta(source({ incoming: true, video: true }), 'declined'), { type: 'call', call: id, step: 'end', reason: 'declined', video: true, caller: false });
  assert.equal(model.callEndMeta(source({ startedAt: t0 }), 'hangup', t0 - 5000).duration, 0, 'a clock that went backwards never yields a negative duration');
  assert.equal(model.callEndMeta(source({ startedAt: t0 }), 'hangup', t0 + 30 * 86400_000).duration, 7 * 86400, 'capped at the week validMeta accepts');
  for (const reason of ['hangup', 'declined', 'busy', 'missed', 'failed']) {
    assert.equal(meta.validMeta({ action: model.callEndMeta(source({ startedAt: t0 }), reason, t0 + 1000) }), true, `${reason} passes validMeta`);
    assert.equal(meta.validMeta({ action: model.callEndMeta(source({ incoming: true }), reason) }), true, `${reason} without duration passes validMeta`);
  }
});

test('hanging up by status: a call that never connected is never an answered call', () => {
  assert.deepEqual(model.hangupOutcome('incoming', true), { text: 'Звонок отклонён', reason: 'declined' });
  assert.deepEqual(model.hangupOutcome('requesting', false), { text: 'Звонок отменён', reason: null }, 'nothing was sent yet: no trace in either chat');
  assert.deepEqual(model.hangupOutcome('ringing', false), { text: 'Звонок отменён', reason: 'missed' });
  assert.deepEqual(model.hangupOutcome('connecting', false), { text: 'Звонок отменён', reason: 'missed' }, 'the answer arrived but the media did not: the other person missed it, not «Исходящий звонок»');
  assert.deepEqual(model.hangupOutcome('connecting', true), { text: 'Звонок отклонён', reason: 'declined' });
  assert.deepEqual(model.hangupOutcome('active', false), { text: 'Звонок завершён', reason: 'hangup' });
  assert.deepEqual(model.hangupOutcome('active', true), { text: 'Звонок завершён', reason: 'hangup' });
});

test('the incoming alert follows Настройки › Звонки: «Без мелодии» rings silently, vibration can be off', () => {
  assert.deepEqual(model.incomingAlert({ ringtone: 'neon', vibration: true }), { sound: true, vibrate: true });
  assert.deepEqual(model.incomingAlert({ ringtone: 'pulse', vibration: false }), { sound: true, vibrate: false });
  assert.deepEqual(model.incomingAlert({ ringtone: 'none', vibration: true }), { sound: false, vibrate: true });
  assert.deepEqual(model.incomingAlert({ ringtone: 'none', vibration: false }), { sound: false, vibrate: false });
});
