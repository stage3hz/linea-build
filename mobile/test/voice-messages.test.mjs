import assert from 'node:assert/strict';
import test from 'node:test';
import { isVoice, voiceFileName, formatVoiceTime, attachmentLabel, levelFromMetering, VOICE_MIME } from '../src/voice/voice.ts';
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
  assert.equal(attachmentLabel({ name, mimeType: 'video/mp4', media: { durationMs: 9000 } }), '⏺ Видеосообщение · 0:09');
});
