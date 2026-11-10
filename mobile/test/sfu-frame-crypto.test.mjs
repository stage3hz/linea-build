import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';
const fc = loadTs(new URL('../src/communities/sfu/frameCrypto.ts', import.meta.url));
const rnd = n => new Uint8Array(randomBytes(n));

test('frames round-trip; VP8/Opus headers stay readable for the SFU; tampering and wrong keys are dropped', async () => {
  const key = await fc.importKey(rnd(16)), other = await fc.importKey(rnd(16));
  const keyFrame = new Uint8Array([0x10, ...rnd(200)]); keyFrame[0] &= 0xfe;
  const sealed = await fc.sealFrame(key, 7, 'video', keyFrame, rnd);
  assert.deepEqual(sealed.subarray(0, 10), keyFrame.subarray(0, 10), 'key-frame header readable');
  assert.notDeepEqual(sealed.subarray(10, 60), keyFrame.subarray(10, 60), 'rest encrypted');
  assert.deepEqual(await fc.openFrame(id => (id === 7 ? key : undefined), 'video', sealed), keyFrame);
  assert.equal(await fc.openFrame(id => (id === 7 ? other : undefined), 'video', sealed), null, 'wrong key');
  assert.equal(await fc.openFrame(() => undefined, 'video', sealed), null, 'unknown key id');
  const bad = sealed.slice(); bad[20] ^= 1; assert.equal(await fc.openFrame(() => key, 'video', bad), null, 'tampered');
  const head = sealed.slice(); head[2] ^= 1; assert.equal(await fc.openFrame(() => key, 'video', head), null, 'clear header is authenticated too');
  const delta = new Uint8Array([0x01, ...rnd(50)]);
  assert.equal(fc.clearBytes('video', delta), 3); assert.equal(fc.clearBytes('audio', delta), 1);
  const opus = rnd(80); assert.deepEqual(await fc.openFrame(() => key, 'audio', await fc.sealFrame(key, 1, 'audio', opus, rnd)), opus);
});

// «lk» layout = webrtc-sdk FrameCryptor (api/crypto/frame_crypto_transformer.cc, used by
// @livekit/react-native-webrtc): checked against an independent node:crypto implementation of that spec.
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
const nativeKey = raw => Buffer.from(hkdfSync('sha256', raw, Buffer.from(fc.LK_SALT, 'utf8'), Buffer.alloc(128), 16));
function nativeSeal(raw, keyIndex, head, frame) {
  const iv = randomBytes(12), c = createCipheriv('aes-128-gcm', nativeKey(raw), iv);
  c.setAAD(frame.subarray(0, head));
  const body = Buffer.concat([c.update(frame.subarray(head)), c.final(), c.getAuthTag()]);
  return new Uint8Array(Buffer.concat([frame.subarray(0, head), body, iv, Buffer.from([12, keyIndex])]));
}
function nativeOpen(raw, head, data) {
  const buf = Buffer.from(data), n = buf.length;
  assert.equal(buf[n - 2], 12, 'IV length byte');
  const iv = buf.subarray(n - 14, n - 2), body = buf.subarray(head, n - 14);
  const d = createDecipheriv('aes-128-gcm', nativeKey(raw), iv);
  d.setAAD(buf.subarray(0, head)); d.setAuthTag(body.subarray(body.length - 16));
  return new Uint8Array(Buffer.concat([buf.subarray(0, head), d.update(body.subarray(0, body.length - 16)), d.final()]));
}

test('«lk» frames: what a PC seals opens with the native FrameCryptor spec, and the other way round', async () => {
  const raw = rnd(16), key = await fc.deriveLkKey(raw);
  const keyFrame = new Uint8Array([0x10, ...rnd(300)]); keyFrame[0] &= 0xfe;
  const sealed = await fc.sealFrameLk(key, 5, 'video', keyFrame, rnd);
  assert.equal(sealed.length, keyFrame.length + 16 + 12 + 2);
  assert.deepEqual([...sealed.subarray(-2)], [12, 5], 'trailer: IV length, key index');
  assert.deepEqual(sealed.subarray(0, 10), keyFrame.subarray(0, 10), 'VP8 key-frame header stays readable');
  assert.deepEqual(nativeOpen(raw, 10, sealed), keyFrame, 'a phone opens what a PC sealed');
  const delta = new Uint8Array([0x01, ...rnd(120)]), opus = rnd(90);
  assert.deepEqual(await fc.openFrameLk(i => (i === 3 ? key : undefined), 'video', nativeSeal(raw, 3, 3, delta)), delta, 'a PC opens what a phone sealed (delta frame)');
  assert.deepEqual(await fc.openFrameLk(() => key, 'audio', nativeSeal(raw, 0, 1, opus)), opus, 'Opus: 1 clear byte');
  assert.deepEqual(nativeOpen(raw, 1, await fc.sealFrameLk(key, 0, 'audio', opus, rnd)), opus);
  // Wrong key, unknown index, tampered body or head: dropped.
  const other = await fc.deriveLkKey(rnd(16));
  assert.equal(await fc.openFrameLk(() => other, 'video', sealed), null);
  assert.equal(await fc.openFrameLk(() => undefined, 'video', sealed), null);
  const bad = sealed.slice(); bad[40] ^= 1; assert.equal(await fc.openFrameLk(() => key, 'video', bad), null);
  const head = sealed.slice(); head[1] ^= 1; assert.equal(await fc.openFrameLk(() => key, 'video', head), null);
  await assert.rejects(fc.sealFrameLk(key, 16, 'video', keyFrame, rnd), /key index/);
});

test('a PC opens both layouts with the keys one person sent (apps up to 0.14.13 seal the legacy one)', async () => {
  const raw = rnd(16);
  const keys = { lk: new Map([[2, await fc.deriveLkKey(raw)]]), legacy: new Map([[2, await fc.importKey(raw)]]) };
  const frame = new Uint8Array([0x01, ...rnd(64)]);
  assert.deepEqual(await fc.openAnyFrame(keys, 'video', await fc.sealFrameLk(keys.lk.get(2), 2, 'video', frame, rnd)), frame);
  assert.deepEqual(await fc.openAnyFrame(keys, 'video', await fc.sealFrame(keys.legacy.get(2), 2, 'video', frame, rnd)), frame);
  assert.equal(await fc.openAnyFrame(undefined, 'video', await fc.sealFrame(keys.legacy.get(2), 2, 'video', frame, rnd)), null);
});
