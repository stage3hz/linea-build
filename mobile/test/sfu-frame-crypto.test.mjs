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
