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
