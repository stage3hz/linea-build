import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';

const { nearbyNeeded, nearbyOffer, OFFLINE_AFTER_MS } = loadTs(new URL('../src/nearby/logic.ts', import.meta.url));
const T = 1_000_000;

test('offer only when neither Wi-Fi nor mobile internet works, and servers are silent, for 10 s', () => {
  const base = { internet: false, offlineSince: T - OFFLINE_AFTER_MS, lastServerOkAt: T - OFFLINE_AFTER_MS, now: T };
  assert.equal(nearbyNeeded(base), true);
  assert.equal(nearbyNeeded({ ...base, internet: true }), false, 'Wi-Fi or mobile works');
  assert.equal(nearbyNeeded({ ...base, internet: null }), false, 'unknown (PC) never');
  assert.equal(nearbyNeeded({ ...base, offlineSince: T - 3000 }), false, 'short drop');
  assert.equal(nearbyNeeded({ ...base, lastServerOkAt: T - 2000 }), false, 'a server answered recently');
  assert.equal(nearbyNeeded({ ...base, offlineSince: null }), false);
});

test('one-button intro once, afterwards only the «Включить» banner', () => {
  const s = (permission, bluetooth = 'unknown', supported = true) => ({ supported, permission, bluetooth, internet: false });
  assert.deepEqual(nearbyOffer(s('undetermined'), false), { kind: 'intro' });
  assert.deepEqual(nearbyOffer(s('undetermined'), true), { kind: 'banner', action: 'permission' });
  assert.deepEqual(nearbyOffer(s('denied'), true), { kind: 'banner', action: 'permission' });
  assert.deepEqual(nearbyOffer(s('blocked'), true), { kind: 'banner', action: 'settings' });
  assert.deepEqual(nearbyOffer(s('granted', 'off'), true), { kind: 'banner', action: 'bluetooth' });
  assert.deepEqual(nearbyOffer(s('granted', 'on'), true), { kind: 'none' });
  assert.deepEqual(nearbyOffer(s('granted', 'off', false), true), { kind: 'none' }, 'old Android: off, no location asked');
  assert.deepEqual(nearbyOffer(null, true), { kind: 'none' });
});
