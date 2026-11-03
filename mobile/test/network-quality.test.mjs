import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
const { addSample, classify, timeoutFor, autoload } = loadTs(new URL('../src/network/quality.ts', import.meta.url));
const start = { rttMs: null, kbps: null, tier: 'fast' };
const feed = samples => samples.reduce(addSample, start);

test('EDGE-like, 3G-like and LTE-like links are told apart', () => {
  // EDGE: ~600 ms round trips, 40 KB in ~6 s (≈ 55 kbit/s).
  assert.equal(feed([{ ms: 600, bytes: 900 }, { ms: 650, bytes: 1200 }, { ms: 6500, bytes: 40000 }]).tier, 'slow');
  // 3G: ~250 ms, 100 KB in ~1 s (≈ 0.8 Mbit/s).
  assert.equal(feed([{ ms: 250, bytes: 900 }, { ms: 1250, bytes: 100000 }]).tier, 'medium');
  // LTE: ~60 ms, 200 KB in 0.2 s.
  assert.equal(feed([{ ms: 60, bytes: 900 }, { ms: 260, bytes: 200000 }]).tier, 'fast');
});

test('one odd sample does not flip the tier; bad samples are ignored', () => {
  const lte = feed([{ ms: 60, bytes: 500 }, { ms: 70, bytes: 500 }, { ms: 65, bytes: 500 }]);
  assert.equal(addSample(lte, { ms: 1200, bytes: 500 }).tier, 'fast');
  assert.deepEqual(addSample(lte, { ms: -1, bytes: 10 }), lte);
  assert.deepEqual(addSample(lte, { ms: NaN, bytes: 10 }), lte);
  assert.equal(classify(null, null), 'fast', 'no data yet: behave normally');
});

test('limits and autoload follow the tier', () => {
  assert.equal(timeoutFor('send', 'slow'), 60000);
  assert.equal(timeoutFor('send', 'fast'), 20000);
  assert.equal(autoload('video', 'slow'), false);
  assert.equal(autoload('photo', 'slow'), false);
  assert.equal(autoload('photo', 'medium'), true);
  assert.equal(autoload('animatedAvatar', 'medium'), false);
  assert.equal(autoload('video', 'fast'), true);
});
