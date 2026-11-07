import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const { autoNight, inNightWindow, themeFor, effectiveNightMode } = loadTs(new URL('../src/themePreference.ts', import.meta.url));

const at = (h, m = 0) => new Date(2026, 10, 7, h, m);
const night = (mode, extra = {}) => ({ mode, from: '22:00', to: '07:00', brightness: 0.25, ...extra });

test('schedule window crosses midnight', () => {
  assert.equal(inNightWindow('22:00', '07:00', at(23)), true);
  assert.equal(inNightWindow('22:00', '07:00', at(6, 59)), true);
  assert.equal(inNightWindow('22:00', '07:00', at(7)), false);
  assert.equal(inNightWindow('22:00', '07:00', at(12)), false);
  assert.equal(inNightWindow('19:00', '20:00', at(19, 30)), true);
  assert.equal(inNightWindow('19:00', '19:00', at(19, 30)), false);
});

test('night modes: system, off, schedule, brightness; old «Как в системе» keeps following the system', () => {
  assert.equal(effectiveNightMode(night(null), 'system'), 'system');
  assert.equal(effectiveNightMode(night(null), 'black'), 'off');
  assert.equal(autoNight(night(null), 'system', 'dark', at(12), null), true);
  assert.equal(autoNight(night('off'), 'light', 'dark', at(23), 0.01), false);
  assert.equal(autoNight(night('schedule'), 'light', 'light', at(23), null), true);
  assert.equal(autoNight(night('auto'), 'light', 'light', at(12), 0.2), true);
  assert.equal(autoNight(night('auto'), 'light', 'light', at(12), 0.6), false);
  assert.equal(autoNight(night('auto'), 'light', 'light', at(12), null), false);
});

test('theme: night theme at night, the chosen day theme otherwise', () => {
  assert.equal(themeFor('system', 'graphite', true), 'graphite');
  assert.equal(themeFor('system', 'graphite', false), 'light');
  assert.equal(themeFor('black', 'dark', false), 'black');
});
