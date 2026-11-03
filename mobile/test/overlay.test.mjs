import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { overlayView, overlayPrefs } = loadTs(new URL('../src/overlay/prefs.ts', import.meta.url));
const voice = { channelName: 'Голосовой', people: [{ name: 'Я', speaking: true, muted: false, me: true }, { name: 'Друг', speaking: false, muted: true }] };

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
