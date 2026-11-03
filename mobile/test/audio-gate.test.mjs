import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
const devices = loadTs(new URL('../src/audio/devices.ts', import.meta.url));
const { gateOpen, dbfs, HOLD_MS } = loadTs(new URL('../src/audio/gate.ts', import.meta.url), { './devices': devices });

test('voice activation opens above the threshold and holds briefly after', () => {
  assert.deepEqual(gateOpen(-30, -50, 0, 1000), { open: true, lastLoudAt: 1000 });
  assert.equal(gateOpen(-70, -50, 1000, 1000 + HOLD_MS - 1).open, true, 'word ending not cut');
  assert.equal(gateOpen(-70, -50, 1000, 1000 + HOLD_MS + 1).open, false);
  assert.equal(Math.round(dbfs(0.1)), -20); assert.equal(dbfs(0), -100);
});

test('microphone goes as the PC gives it: no auto gain; only the switched-on processing', () => {
  assert.deepEqual(devices.micConstraint(true), { noiseSuppression: true, echoCancellation: false, autoGainControl: false });
  devices.setAudioPrefs({ input: 'usb-mic', noiseSuppression: false });
  assert.deepEqual(devices.micConstraint(true), { deviceId: { ideal: 'usb-mic' }, noiseSuppression: false, echoCancellation: false, autoGainControl: false });
  assert.equal(devices.micConstraint(false), false);
  assert.equal(JSON.parse(store.get('invizent.audio.v1')).input, 'usb-mic', 'remembered');
});

test('рация: open while held, a short tail after release; binds are read and labelled', async () => {
  const gate = loadTs(new URL('../src/audio/gate.ts', import.meta.url), { './devices': devices });
  const now = Date.now();
  assert.equal(gate.pushToTalkActive(now), false);
  gate.setPushToTalk(true); assert.equal(gate.pushToTalkActive(), true);
  gate.setPushToTalk(false); assert.equal(gate.pushToTalkActive(), true, 'release tail');
  assert.equal(gate.pushToTalkActive(Date.now() + devices.PTT_RELEASE_MS + 5), false);
  assert.equal(devices.comboOf({ code: 'KeyV', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }), 'KeyV');
  assert.equal(devices.comboOf({ code: 'KeyM', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }), 'Ctrl+Shift+KeyM');
  assert.equal(devices.comboOf({ code: 'ShiftLeft', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }), null, 'a modifier alone is not a bind');
  assert.equal(devices.comboLabel('Ctrl+Shift+KeyM'), 'Ctrl+Shift+M'); assert.equal(devices.comboLabel('Space'), 'Пробел'); assert.equal(devices.comboLabel(''), 'Не назначено');
  assert.deepEqual(devices.audioPrefs().binds, { mute: 'Ctrl+Shift+KeyM', deafen: 'Ctrl+Shift+KeyD', ptt: '' });
  assert.equal(devices.audioPrefs().inputMode, 'activity');
});
