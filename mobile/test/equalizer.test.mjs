import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { parseEq, effectiveGains, DEFAULT_EQ } = loadTs(new URL('../src/music/equalizerModel.ts', import.meta.url));

test('equalizer settings are clamped to ±12 dB in half-dB steps and default to recommended', () => {
  assert.deepEqual(parseEq(null), DEFAULT_EQ);
  assert.deepEqual(parseEq('{bad'), DEFAULT_EQ);
  const parsed = parseEq(JSON.stringify({ headphones: { mode: 'custom', low: 30, mid: -3.26, high: 'x' } }));
  assert.deepEqual(parsed.headphones, { mode: 'custom', low: 12, mid: -3.5, high: 0 });
  assert.equal(parsed.speaker.mode, 'recommended');
});

test('recommended bypasses the filters; custom applies them', () => {
  assert.equal(effectiveGains({ mode: 'recommended', low: 5, mid: 0, high: 0 }).enabled, false);
  assert.deepEqual(effectiveGains({ mode: 'custom', low: 4, mid: -2, high: 3 }), { low: 4, mid: -2, high: 3, enabled: true });
  assert.equal(effectiveGains({ mode: 'custom', low: 0, mid: 0, high: 0 }).enabled, false);
});
