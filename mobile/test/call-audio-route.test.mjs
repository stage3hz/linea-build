import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// A call with Bluetooth headphones connected came out of the phone itself.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const calls = read('../src/calls/CallProvider.tsx');
const speakerRoute = new Function(`return ${/export const speakerRoute = ([^\n]+);/.exec(calls)[1].replace(/: boolean \| null/g, '').replace(/: boolean/g, '')}`)();

test('a call starts on the system\'s own route; only «Динамик» forces the speaker', () => {
  // true = force the speaker, false = force the earpiece, null = the system's route (headphones when connected).
  assert.equal(speakerRoute(null, false), null, 'an audio call starts on the system\'s route');
  assert.equal(speakerRoute(null, true), null, 'a video call too (its system route is the speaker unless headphones are in)');
  assert.equal(speakerRoute(true, false), true);
  assert.equal(speakerRoute(true, true), true);
  assert.equal(speakerRoute(false, false), null, 'speaker off in an audio call: back to headphones / the earpiece');
  assert.equal(speakerRoute(false, true), false, 'speaker off in a video call: its own route is the speaker, so the earpiece is forced');
  assert.equal(calls.match(/setForceSpeakerphoneOn\?\.\(speakerRoute\(null, /g)?.length, 2, 'both ways a call starts');
  assert.ok(!/setForceSpeakerphoneOn\?\.\((video|current\.video)\)/.test(calls), 'never forced by the kind of call');
  assert.ok(calls.includes('setForceSpeakerphoneOn?.(speakerRoute(!c.speaker, c.video))'));
});

test('iPhone: the call\'s audio session allows Bluetooth; Android 12+: the permission that shows headsets is asked first', () => {
  const patch = read('../scripts/patch-incall-manager.cjs');
  assert.ok(patch.includes('AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionAllowBluetoothA2DP'));
  assert.ok(patch.includes("if (version !== '4.3.0') throw new Error"), 'a new library version is reviewed, not patched blindly');
  assert.match(JSON.parse(read('../package.json')).scripts.postinstall, /patch-incall-manager\.cjs/);
  const library = read('../node_modules/react-native-incall-manager/ios/RNInCallManager/RNInCallManager.m');
  assert.ok(library.includes('options |= AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionAllowBluetoothA2DP;'), 'the installed library is patched');
  assert.equal(calls.match(/await allowBluetoothAudio\(\);\n\s+try \{ inCall\.current\?\.start\?\./g)?.length, 2, 'before the call\'s audio starts');
  assert.ok(calls.includes('PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT'));
  assert.ok(read('../plugins/withLineNearby.js').includes("android.permission.BLUETOOTH_CONNECT"), 'declared in the manifest');
});
