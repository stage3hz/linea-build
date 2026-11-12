import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { androidRouteLabel, androidRoutes, microphoneChoices, portHint, portLabel } from '../src/calls/audioRouteModel.ts';

// Звонок › «Звук»: the microphone and the output are the system's by default; the user may choose others.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('microphones and outputs are named for people', () => {
  assert.equal(portLabel({ kind: 'MicrophoneBuiltIn', name: 'iPhone Microphone' }), 'Микрофон телефона');
  assert.equal(portLabel({ kind: 'BluetoothHFP', name: 'AirPods Pro' }), 'AirPods Pro');
  assert.equal(portLabel({ kind: 'BluetoothA2DPOutput', name: 'JBL Tune' }), 'JBL Tune');
  assert.equal(portLabel({ kind: 'Receiver', name: 'Receiver' }), 'Телефон');
  assert.equal(portLabel({ kind: 'Speaker', name: 'Speaker' }), 'Громкий динамик');
  assert.equal(portLabel({ kind: 'HeadsetMic', name: 'Headset Microphone' }), 'Проводные наушники');
  assert.equal(portLabel({ kind: 'USBAudio', name: '' }), 'Устройство');
  assert.equal(portHint('BluetoothHFP'), 'Bluetooth');
  assert.equal(portHint('MicrophoneBuiltIn'), '');
  assert.equal(portHint('USBAudio'), 'USB');
});

test('the phone\'s own microphone is offered first, each microphone once', () => {
  const inputs = [{ id: 'bt', name: 'AirPods', kind: 'BluetoothHFP' }, { id: 'built', name: 'iPhone Microphone', kind: 'MicrophoneBuiltIn' }, { id: 'bt', name: 'AirPods', kind: 'BluetoothHFP' }, { id: '', name: 'x', kind: 'y' }, null];
  assert.deepEqual(microphoneChoices(inputs).map(port => port.id), ['built', 'bt']);
  assert.deepEqual(microphoneChoices(undefined), []);
});

test('Android: the devices the call library reports, as a JSON string or a list, in a fixed order', () => {
  assert.deepEqual(androidRoutes('["SPEAKER_PHONE","EARPIECE","BLUETOOTH"]'), ['BLUETOOTH', 'EARPIECE', 'SPEAKER_PHONE']);
  assert.deepEqual(androidRoutes(['WIRED_HEADSET', 'SPEAKER_PHONE', 'NONE', 42]), ['WIRED_HEADSET', 'SPEAKER_PHONE']);
  assert.deepEqual(androidRoutes('not json'), []);
  assert.deepEqual(androidRoutes(null), []);
  assert.equal(androidRouteLabel('BLUETOOTH'), 'Bluetooth-наушники');
  assert.equal(androidRouteLabel('EARPIECE'), 'Телефон');
});

test('the call screen offers «Звук»; the system\'s choice is the default and comes back with the next call', () => {
  const calls = read('../src/calls/CallProvider.tsx');
  assert.ok(calls.includes("label={audioChoice ? 'Звук' : 'Динамик'} onPress={audioChoice ? () => setAudioOpen(true) : speaker}"));
  assert.ok(calls.includes('resetCallAudio(); // the next call starts on the system\'s own microphone again'));
  const panel = read('../src/calls/CallAudioPanel.tsx');
  for (const text of ['Динамики', 'Микрофон', 'Как в системе', 'Громкий динамик', 'Другое устройство…', 'Устройство звука']) assert.ok(panel.includes(text), text);
  assert.ok(panel.includes('selected={!route?.chosen} onPress={() => chooseInput(null)}'), 'the system\'s microphone is the selected one until another is chosen');
  const swift = read('../modules/linea-call/ios/LineCallModule.swift');
  assert.ok(swift.includes('try? session.setPreferredInput(nil)') && swift.includes('session.setPreferredInput(port)'));
  assert.ok(swift.includes('AVRoutePickerView'), 'outputs are chosen in the system\'s own list');
  assert.ok(swift.includes('Events("end", "mute", "audio", "open", "route")'));
});
