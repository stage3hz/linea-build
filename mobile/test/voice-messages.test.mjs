import assert from 'node:assert/strict';
import test from 'node:test';
import { isVoice, voiceFileName, formatVoiceTime, attachmentLabel, levelFromMetering, VOICE_MIME, formatVoiceTimeFine, encodeWaveform, decodeWaveform, fitWaveform, WAVEFORM_BARS } from '../src/voice/voice.ts';
import { replyPreview } from '../src/messageMeta.ts';

test('voice messages are recognised only by the exact name and AAC container', () => {
  const name = voiceFileName(1793291367528);
  assert.equal(name, 'voice-1793291367528.m4a');
  assert.equal(isVoice({ name, mimeType: VOICE_MIME }), true);
  assert.equal(isVoice({ name, mimeType: 'audio/mpeg' }), false);
  assert.equal(isVoice({ name: 'voice-1.m4a.exe', mimeType: VOICE_MIME }), false);
  assert.equal(isVoice({ name: 'песня.m4a', mimeType: VOICE_MIME }), false);
  assert.equal(isVoice(null), false);
});

test('durations, previews and meter levels', () => {
  assert.equal(formatVoiceTime(0), '0:00');
  assert.equal(formatVoiceTime(65_400), '1:05');
  assert.equal(formatVoiceTime(Number.NaN), '0:00');
  const voice = { name: voiceFileName(5), mimeType: VOICE_MIME, media: { durationMs: 12_000 } };
  assert.equal(attachmentLabel(voice), '🎤 Голосовое сообщение · 0:12');
  assert.equal(attachmentLabel({ name: 'a.jpg', mimeType: 'image/jpeg' }), '🖼 Фотография');
  assert.equal(attachmentLabel({ name: 'doc.pdf', mimeType: 'application/pdf' }), '📎 doc.pdf');
  assert.equal(replyPreview({ text: '', attachment: { id: 'x', size: 1, ...voice } }), '🎤 Голосовое сообщение · 0:12');
  assert.equal(levelFromMetering(-60), 0);
  assert.equal(levelFromMetering(0), 1);
  assert.equal(levelFromMetering(-30), .5);
  assert.equal(levelFromMetering(undefined), 0);
});

test('video notes are recognised by name and labelled', async () => {
  const { isVideoNote, videoNoteFileName, attachmentLabel } = await import('../src/voice/voice.ts');
  const name = videoNoteFileName(42);
  assert.equal(name, 'circle-42.mp4');
  assert.equal(isVideoNote({ name, mimeType: 'video/mp4' }), true);
  assert.equal(isVideoNote({ name: 'video.mp4', mimeType: 'video/mp4' }), false);
  assert.equal(attachmentLabel({ name, mimeType: 'video/mp4', media: { durationMs: 9000 } }), 'Видеосообщение');
});

test('recording timer shows hundredths like Telegram', () => {
  assert.equal(formatVoiceTimeFine(4630), '0:04,63');
  assert.equal(formatVoiceTimeFine(61005), '1:01,00');
  assert.equal(formatVoiceTimeFine(-5), '0:00,00');
  assert.equal(formatVoiceTimeFine(NaN), '0:00,00');
});

test('waveform: 48 bars relative to the loudest moment, no fake bars for silence', () => {
  assert.equal(encodeWaveform([]), undefined);
  assert.equal(encodeWaveform([0, 0, 0, 0, 0]), undefined);
  const levels = Array.from({ length: 300 }, (_, i) => i < 150 ? 0.1 : 0.8);
  const wave = encodeWaveform(levels);
  assert.equal(wave.length, WAVEFORM_BARS);
  assert.match(wave, /^[A-Za-f]+$/);
  assert.equal(wave.at(-1), 'f'); // loudest = 31
  const bars = decodeWaveform(wave);
  assert.equal(bars.length, WAVEFORM_BARS);
  assert.ok(bars[0] < bars.at(-1));
  assert.equal(decodeWaveform('xyz12345'), null);
  assert.equal(decodeWaveform('AB'), null);
  assert.equal(decodeWaveform(undefined), null);
});

test('waveform: room noise stays low next to speech (amplitude, not decibels)', () => {
  // −40 dB noise (level 0.33) and −10 dB speech (level 0.83), as the recorder reports them.
  const levels = [...Array(100).fill(20 / 60), ...Array(100).fill(50 / 60)];
  const bars = decodeWaveform(encodeWaveform(levels));
  assert.ok(bars[0] < 0.25, `noise bar ${bars[0]}`);
  assert.equal(bars.at(-1), 1);
});

test('waveform: 100 stored bars are fitted to the bubble width by peak', () => {
  assert.equal(WAVEFORM_BARS, 100);
  const bars = Array.from({ length: 100 }, (_, i) => i === 37 ? 1 : 0.1);
  const fitted = fitWaveform(bars, 45);
  assert.equal(fitted.length, 45);
  assert.equal(Math.max(...fitted), 1); // a single loud moment is not lost
  assert.deepEqual(fitWaveform([0.5, 0.2], 45), [0.5, 0.2]);
});

test('voice: one take stays under 1 GB at 128 kbit/s, like Telegram there is no short duration cap', async () => {
  const { VOICE_MAX_MS } = await import('../src/voice/voice.ts');
  const bytes = VOICE_MAX_MS / 1000 * 128000 / 8;
  assert.ok(bytes < 1024 ** 3, `${bytes} bytes`);
  assert.ok(VOICE_MAX_MS >= 60 * 60 * 1000, 'at least an hour');
});

test('voice: the recording waveform is compacted and still spans the whole take', async () => {
  const { pushVoiceSample, voiceSamples } = await import('../src/voice/voice.ts');
  const state = { samples: [], stride: 1, pending: 0, count: 0 };
  const total = 100_000;
  for (let i = 0; i < total; i++) pushVoiceSample(state, i === total - 10 ? 1 : 0.1, 1000);
  const wave = voiceSamples(state);
  assert.ok(wave.length <= 1001 && wave.length >= 250, String(wave.length));
  assert.ok(wave.slice(-5).includes(1), 'a loud moment at the very end is still in the waveform');
  const short = { samples: [], stride: 1, pending: 0, count: 0 };
  [0.2, 0.5, 0.3].forEach(level => pushVoiceSample(short, level, 1000));
  assert.deepEqual(short.samples, [0.2, 0.5, 0.3], 'short takes are kept sample by sample');
});
