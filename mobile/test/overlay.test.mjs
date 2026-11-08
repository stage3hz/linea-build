import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
// prefs.ts reads localStorage lazily (globalThis.localStorage?.getItem), so the
// module can load without a stub; the stub is installed per test and restored
// afterwards so that other files in the same process (--test-isolation=none,
// e.g. audio-gate.test.mjs) keep their own storage.
const { overlayView, overlayPrefs } = loadTs(new URL('../src/overlay/prefs.ts', import.meta.url));
const voice = { channelName: 'Голосовой', people: [{ name: 'Я', speaking: true, muted: false, me: true }, { name: 'Друг', speaking: false, muted: true }] };

describe('overlay prefs', () => {
  let previous, hadPrevious;
  beforeEach(() => {
    hadPrevious = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    previous = globalThis.localStorage;
    const store = new Map();
    globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  });
  afterEach(() => {
    if (hadPrevious) globalThis.localStorage = previous; else delete globalThis.localStorage;
  });

test('overlay is off until switched on', () => {
  assert.equal(overlayPrefs().enabled, false);
  assert.equal(overlayView(overlayPrefs(), voice), null);
});
test('on: everyone, or only those speaking; nothing outside a voice channel; bounded', () => {
  const on = { ...overlayPrefs(), enabled: true };
  assert.equal(overlayView(on, voice).people.length, 2);
  assert.deepEqual(overlayView({ ...on, onlySpeaking: true }, voice).people.map(p => p.name), ['Я']);
  assert.equal(overlayView(on, null), null);
  const many = { channelName: 'x'.repeat(200), people: Array.from({ length: 30 }, (_, i) => ({ name: 'n'.repeat(80) + i, speaking: false, muted: false })) };
  const v = overlayView(on, many); assert.equal(v.people.length, 12); assert.equal(v.channel.length, 60); assert.equal(v.people[0].name.length, 32);
});
});
