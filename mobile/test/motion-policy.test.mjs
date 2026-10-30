import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { motionAllowed, LOW_BATTERY } = loadTs(new URL('../src/motionPolicy.ts', import.meta.url), {});
const power = (change = {}) => ({ level: 0.8, charging: false, lowPower: false, reduceMotion: false, ...change });

test('automatic mode turns animations off at 27% battery and below, unless charging', () => {
  assert.equal(LOW_BATTERY, 0.27);
  assert.equal(motionAllowed('auto', power({ level: 0.28 })), true);
  assert.equal(motionAllowed('auto', power({ level: 0.27 })), false);
  assert.equal(motionAllowed('auto', power({ level: 0.05 })), false);
  assert.equal(motionAllowed('auto', power({ level: 0.2, charging: true })), true);
  assert.equal(motionAllowed('auto', power({ level: null })), true);
});

test('low power mode and system reduce motion also switch animations off; manual choice wins', () => {
  assert.equal(motionAllowed('auto', power({ lowPower: true })), false);
  assert.equal(motionAllowed('auto', power({ reduceMotion: true })), false);
  assert.equal(motionAllowed('on', power({ level: 0.1, lowPower: true })), true);
  assert.equal(motionAllowed('off', power()), false);
});
