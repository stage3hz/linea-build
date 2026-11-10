import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const s = loadTs(new URL('../src/audio/studioPreset.ts', import.meta.url), {});
const devices = loadTs(new URL('../src/audio/devices.ts', import.meta.url));
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual.toFixed(2)} ≈ ${expected}`);

test('the preset is the three Equalizer APO peaking filters', () => {
  assert.deepEqual(s.STUDIO_FILTERS.map(f => [f.frequency, f.gain, f.q]), [[77, 8, 2], [777, -6, 1.5], [6000, 12, 2]]);
});

test('each filter hits its gain at its centre and leaves far frequencies alone', () => {
  for (const sampleRate of [44_100, 48_000]) for (const f of s.STUDIO_FILTERS) {
    near(s.peakingResponseDb(f, f.frequency, sampleRate), f.gain, 0.01, `${f.frequency} Hz @ ${sampleRate}`);
    near(s.peakingResponseDb(f, f.frequency * 8 > 20000 ? f.frequency / 8 : f.frequency * 8, sampleRate), 0, 0.6, `far from ${f.frequency} Hz`);
  }
});

test('the chain: body, less box, presence; a 1 kHz tone is barely touched', () => {
  near(s.chainResponseDb(77), 8, 0.3, '77 Hz'); near(s.chainResponseDb(777), -6, 0.3, '777 Hz'); near(s.chainResponseDb(6000), 12, 0.3, '6 kHz');
  assert.ok(Math.abs(s.chainResponseDb(1500)) < 3);
});

test('the limiter and trim keep the +12 dB boost from clipping', () => {
  near(s.peakBoostDb(), 12, 0.3, 'peak boost');
  const trim = s.studioTrim();
  near(20 * Math.log10(trim), -6, 0.2, 'trim dB'); assert.ok(trim <= 1);
  // Full scale at 6 kHz: +12 dB EQ, then at most ratio-limited over −6 dBFS, then the trim → under 0 dBFS.
  const { threshold, ratio } = s.STUDIO_LIMITER;
  const afterLimiter = threshold + (12 - threshold) / ratio;
  assert.ok(afterLimiter + 20 * Math.log10(trim) < 0, `${afterLimiter + 20 * Math.log10(trim)} dBFS`);
  assert.equal(s.STUDIO_LIMITER.knee, 6); assert.ok(s.STUDIO_LIMITER.attack <= 0.005);
});

test('studio sound is off by default and part of the live-switch key on the PC only', () => {
  assert.equal(devices.audioPrefs().studioSound, false);
  const pc = devices.callAudioKey(false), phone = devices.callAudioKey(true);
  devices.setAudioPrefs({ studioSound: true });
  assert.notEqual(devices.callAudioKey(false), pc, 'switching it re-acquires the PC microphone');
  assert.equal(devices.callAudioKey(true), phone, 'phones: no change (PC only for now)');
  devices.setAudioPrefs({ studioSound: false });
  assert.deepEqual(devices.callAudio(true), { noiseSuppression: true, echoCancellation: true, autoGainControl: true });
  devices.setAudioPrefs({ noiseSuppression: false });
  assert.equal(devices.callAudio(false).noiseSuppression, false); assert.equal(devices.callAudio(false).autoGainControl, true);
  // A call's explicit processing wins over the PC defaults in micConstraint (rtc.web.tsx wraps every request).
  assert.equal(devices.micConstraint({ autoGainControl: true, echoCancellation: true }).autoGainControl, true);
  devices.setAudioPrefs({ noiseSuppression: true });
});
