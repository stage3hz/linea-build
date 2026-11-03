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
  assert.deepEqual(devices.audioPrefs().binds, [], 'no binds until the person adds them');
  assert.equal(devices.audioPrefs().inputMode, 'activity');
});

test('user binds: off by default, only enabled ones with keys fire; broken saved data is dropped', () => {
  const binds = loadTs(new URL('../src/audio/binds.ts', import.meta.url), { './devices': devices, './gate': { setPushToTalk() {}, setPushToMute() {} }, '../desktop': { desktopBridge: () => undefined }, 'react-native': { Platform: { OS: 'web' } } });
  const list = [
    { id: 'a1', action: 'mute', combo: 'Ctrl+KeyM', enabled: true },
    { id: 'a2', action: 'deafen', combo: 'Ctrl+KeyM', enabled: false },
    { id: 'a3', action: 'ptt', combo: '', enabled: true },
  ];
  assert.deepEqual(binds.bindsFor(list, 'Ctrl+KeyM').map(b => b.id), ['a1']);
  assert.deepEqual(binds.bindsFor(list, 'KeyV'), []);
  store.set('invizent.audio.v1', JSON.stringify({ binds: [list[0], { id: '../x', action: 'mute', combo: 'Ctrl+KeyM', enabled: true }, { id: 'b', action: 'rm -rf', combo: 'KeyQ', enabled: true }, { id: 'c', action: 'ptt', combo: '<script>', enabled: true }] }));
  const fresh = loadTs(new URL('../src/audio/devices.ts', import.meta.url));
  assert.deepEqual(fresh.audioPrefs().binds.map(b => b.id), ['a1']);
  assert.ok(Object.keys(fresh.BIND_ACTIONS).includes('pushToMute'));
});
