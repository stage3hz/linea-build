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

test('a manual night switch holds while the brightness is still unknown and expires only when the rule itself changes', () => {
  const { manualNightExpired } = loadTs(new URL('../src/themePreference.ts', import.meta.url));
  // Night turned off by hand while the rule said «on» (dark screen); the first frame has no reading yet.
  assert.equal(manualNightExpired(false, true, null), false);
  assert.equal(manualNightExpired(false, true, true), false);
  assert.equal(manualNightExpired(false, true, false), true);
  assert.equal(manualNightExpired(true, false, true), true);
  assert.equal(manualNightExpired(null, null, false), false);
  assert.equal(manualNightExpired(true, null, false), false);
});

test('«Автоматически» is offered only where the screen brightness can be read; on the PC a saved «auto» follows the system', () => {
  const { nightModesFor, brightnessAvailable } = loadTs(new URL('../src/themePreference.ts', import.meta.url));
  assert.deepEqual(nightModesFor('ios'), ['system', 'off', 'schedule', 'auto']);
  assert.deepEqual(nightModesFor('android'), ['system', 'off', 'schedule', 'auto']);
  assert.deepEqual(nightModesFor('web'), ['system', 'off', 'schedule']);
  assert.equal(brightnessAvailable('web'), false);
  assert.equal(effectiveNightMode(night('auto'), 'light', 'ios'), 'auto');
  assert.equal(effectiveNightMode(night('auto'), 'light', 'web'), 'system');
  assert.equal(effectiveNightMode(night('schedule'), 'light', 'web'), 'schedule');
  assert.equal(autoNight(night('auto'), 'light', 'dark', at(12), null, 'web'), true);
  assert.equal(autoNight(night('auto'), 'light', 'light', at(12), null, 'web'), false);
  assert.equal(autoNight(night('auto'), 'light', 'light', at(12), 0.1, 'ios'), true);
});

test('a tap on a theme card always shows the tapped theme (Telegram): night theme at night, day theme by day, «Светлая» ends the night by hand', () => {
  const { themeTapPlan, isDarkTheme } = loadTs(new URL('../src/themePreference.ts', import.meta.url));
  assert.deepEqual(themeTapPlan('black', true), { darkTheme: 'black', nightOff: false });
  assert.deepEqual(themeTapPlan('graphite', true), { darkTheme: 'graphite', nightOff: false });
  assert.deepEqual(themeTapPlan('amethyst', true), { darkTheme: 'amethyst', nightOff: false });
  assert.deepEqual(themeTapPlan('light', true), { mode: 'light', nightOff: true });
  assert.deepEqual(themeTapPlan('black', false), { mode: 'black', nightOff: false });
  assert.deepEqual(themeTapPlan('light', false), { mode: 'light', nightOff: false });
  assert.equal(isDarkTheme('light'), false); assert.equal(isDarkTheme('system'), false); assert.equal(isDarkTheme('dark'), true);
  // After the plan is applied the shown theme is the tapped one.
  assert.equal(themeFor('light', 'black', true), 'black');
  assert.equal(themeFor('light', 'dark', false), 'light');
});

test('«Светлая» tapped before the brightness is read: stamping «the rule said night» never snaps back to night', () => {
  const { manualNightExpired, themeFor } = loadTs(new URL('../src/themePreference.ts', import.meta.url));
  // The rule turns out to say night: the manual day holds.
  assert.equal(manualNightExpired(false, true, true), false);
  assert.equal(themeFor('light', 'dark', false), 'light');
  // The rule turns out to say day: the switch expires, and the rule gives the same day the person asked for.
  assert.equal(manualNightExpired(false, true, false), true);
  assert.equal(themeFor('light', 'dark', false), 'light');
  // Had the premature stamp been «day» and the rule said night, the switch would expire into night — the wrong plan.
  assert.equal(manualNightExpired(false, false, true), true);
});
