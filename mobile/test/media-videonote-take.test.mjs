import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const { resolveTake, VIDEO_NOTE_MIN_MS } = loadTs(new URL('../src/videonote/take.ts', import.meta.url));
const uri = 'file:///cache/videonote-1.mp4';
const base = { uri, durationMs: 4000, cancelled: false, hold: false, locked: false };

test('a good take is sent and its file kept for the upload', () => {
  assert.deepEqual(resolveTake(base), { action: 'send', uri });
  assert.deepEqual(resolveTake({ ...base, hold: true }), { action: 'send', uri });
  assert.deepEqual(resolveTake({ ...base, durationMs: VIDEO_NOTE_MIN_MS }), { action: 'send', uri });
});
test('a cancelled take deletes its file and does not close again (cancel already did)', () => {
  assert.deepEqual(resolveTake({ ...base, cancelled: true }), { action: 'discard', close: false, deleteUri: uri });
  assert.deepEqual(resolveTake({ ...base, cancelled: true, hold: true, failed: 'E_EMPTY' }), { action: 'discard', close: false, deleteUri: uri });
  assert.deepEqual(resolveTake({ ...base, cancelled: true, uri: undefined }), { action: 'discard', close: false, deleteUri: null });
});
test('too short: hold mode closes the circle silently, the full-screen recorder explains; the file goes either way', () => {
  assert.deepEqual(resolveTake({ ...base, durationMs: 300, hold: true }), { action: 'discard', close: true, deleteUri: uri });
  assert.deepEqual(resolveTake({ ...base, durationMs: 300, hold: true, locked: true }), { action: 'discard', close: true, deleteUri: uri });
  const shown = resolveTake({ ...base, durationMs: 300 });
  assert.equal(shown.action, 'error'); assert.equal(shown.deleteUri, uri); assert.match(shown.message, /Слишком короткое/);
});
test('a failed stop while the finger holds the button is a too-short take: close, never a stuck blur', () => {
  // The native recorder rejects a stop before the first frame (iOS E_EMPTY, Android ERROR_NO_VALID_DATA).
  assert.deepEqual(resolveTake({ ...base, durationMs: 200, hold: true, failed: 'Видео не успело записаться.' }), { action: 'discard', close: true, deleteUri: uri });
  // A failed start in hold mode has no file yet and still closes.
  assert.deepEqual(resolveTake({ ...base, uri: null, durationMs: 50, hold: true, failed: 'Не удалось начать запись.' }), { action: 'discard', close: true, deleteUri: null });
  // After a lock the controls are on screen, so a long take that failed shows its error (and drops the file).
  assert.deepEqual(resolveTake({ ...base, hold: true, locked: true, failed: 'boom' }), { action: 'error', message: 'boom', deleteUri: uri });
  // The full-screen recorder always shows the error.
  assert.deepEqual(resolveTake({ ...base, durationMs: 200, failed: 'boom' }), { action: 'error', message: 'boom', deleteUri: uri });
});
test('no file from the recorder: hold mode closes, the full-screen recorder reports it', () => {
  assert.deepEqual(resolveTake({ ...base, uri: undefined, hold: true }), { action: 'discard', close: true, deleteUri: null });
  const shown = resolveTake({ ...base, uri: '' });
  assert.equal(shown.action, 'error'); assert.equal(shown.deleteUri, null);
});
