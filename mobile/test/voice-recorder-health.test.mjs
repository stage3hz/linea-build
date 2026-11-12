import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { voiceRecorderStalled, diagnoseVoiceTake } from '../src/voice/voice.ts';

test('a take whose timer runs while AVAudioRecorder is not capturing counts as stalled', () => {
  assert.equal(voiceRecorderStalled({ nativeRecording: true, nativeMs: 440, statusMs: 450, metering: -38 }), false);
  assert.equal(voiceRecorderStalled({ nativeRecording: true, nativeMs: 420, statusMs: 450, metering: -58 }), false); // a quiet room is not a fault
  assert.equal(voiceRecorderStalled({ nativeRecording: true, nativeMs: 430, statusMs: 450 }), false); // no metering at all: not enough to restart
  assert.equal(voiceRecorderStalled({ nativeRecording: false, nativeMs: 0, statusMs: 450, metering: -160 }), true);
  assert.equal(voiceRecorderStalled({ nativeRecording: true, nativeMs: 90, statusMs: 450, metering: -40 }), true);
  assert.equal(voiceRecorderStalled({ nativeRecording: true, nativeMs: 440, statusMs: 450, metering: -160 }), true); // digital zero
  assert.equal(voiceRecorderStalled({ nativeRecording: true, nativeMs: 0, statusMs: 120 }), false); // too early to judge the clock
});

const good = { durationMs: 6000, bytes: 90_000, nativeMs: 5990, nativeRecording: true, metering: -30, meteringSeen: true, maxLevel: .7, restarts: 0, mediaReset: false, platform: 'ios' };

test('a normal take has no diagnosis; short takes are never judged', () => {
  assert.equal(diagnoseVoiceTake(good), null);
  assert.equal(diagnoseVoiceTake({ ...good, durationMs: 800, nativeRecording: false, bytes: 10, maxLevel: 0 }), null);
  assert.equal(diagnoseVoiceTake({ ...good, nativeMs: null, nativeRecording: null, bytes: null }), null); // after a pause / unknown size
});

test('the reported failure (timer 0:06, deaf microphone, ~0.1 s file) is broken and silent, with a compact code', () => {
  const diagnosis = diagnoseVoiceTake({ ...good, bytes: 2100, nativeMs: 0, nativeRecording: false, metering: -160, maxLevel: 0, restarts: 1 });
  assert.equal(diagnosis.broken, true);
  assert.equal(diagnosis.silent, true);
  assert.equal(diagnosis.code, 'VR1 ios dur=6000 nat=0 rec=0 size=2100 met=-160 max=0.00 rst=1 msr=0');
  assert.doesNotMatch(diagnosis.code, /[А-Яа-яЁё]|file:|\//); // no paths, nothing to translate
});

test('a tiny file alone is broken; a quiet but real take is only silent; no metering is reported as such', () => {
  assert.equal(diagnoseVoiceTake({ ...good, nativeMs: null, nativeRecording: null, bytes: 6000 }).broken, true);
  const quiet = diagnoseVoiceTake({ ...good, metering: -59, maxLevel: .01 });
  assert.deepEqual([quiet.broken, quiet.silent], [false, true]);
  const unmetered = diagnoseVoiceTake({ ...good, metering: undefined, meteringSeen: false, maxLevel: 0, nativeMs: null, nativeRecording: null, mediaReset: undefined, platform: 'android' });
  assert.equal(unmetered.code, 'VR1 android dur=6000 nat=- rec=- size=90000 met=none max=0.00 rst=0 msr=-');
});

test('expo-audio never deactivates the iOS audio session under a recording (postinstall patch)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.postinstall, /patch-expo-audio\.cjs/);
  const swift = readFileSync(new URL('../node_modules/expo-audio/ios/AudioModule.swift', import.meta.url), 'utf8');
  const body = swift.slice(swift.indexOf('private func deactivateSession()'));
  assert.match(body, /if category == \.playAndRecord \|\| category == \.record \{ return \}\n[\s\S]{0,260}?if AVAudioSession\.sharedInstance\(\)\.mode == \.moviePlayback \{ return \}\n\s+do \{\n\s+try AVAudioSession\.sharedInstance\(\)\.setActive\(false/);
});

test('the voice recorder stops the music before arming the microphone, never between prepare and record()', () => {
  const source = readFileSync(new URL('../src/voice/VoiceMessage.tsx', import.meta.url), 'utf8');
  const arm = source.slice(source.indexOf('const arm = useCallback'), source.indexOf('const verify = useCallback'));
  assert.ok(arm.indexOf('musicRef.current.stop()') < arm.indexOf('prepareToRecordAsync()'));
  assert.ok(arm.indexOf('prepareToRecordAsync()') < arm.indexOf('recorder.record()'));
  assert.doesNotMatch(source.slice(source.indexOf('const start = useCallback')), /music\.stop\(\);\s*recorder\.record\(\)/);
});
