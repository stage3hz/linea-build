import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const load = () => loadTs(new URL('../src/videonote/noteOutbox.ts', import.meta.url));
const { reduceNotes, notesFor, noteError, NOTE_SEND_FALLBACK } = load();
const note = (id, extra = {}) => ({ id, chatId: 'c1', uri: `file:///cache/videonote-${id}.mp4`, durationMs: 3000, createdAt: 10, progress: 0, state: 'sending', ...extra });

test('a failed upload keeps the circle (and its file) with a readable error instead of removing it', () => {
  let list = reduceNotes([], { type: 'add', note: note('1') });
  list = reduceNotes(list, { type: 'progress', id: '1', sent: 50, total: 100 });
  assert.equal(list[0].progress, 0.5);
  list = reduceNotes(list, { type: 'fail', id: '1', error: 'Сервер недоступен.' });
  assert.equal(list.length, 1);
  assert.deepEqual({ state: list[0].state, error: list[0].error, uri: list[0].uri, progress: list[0].progress }, { state: 'failed', error: 'Сервер недоступен.', uri: 'file:///cache/videonote-1.mp4', progress: 0 });
  assert.equal(reduceNotes(list, { type: 'fail', id: '1', error: '' })[0].error, NOTE_SEND_FALLBACK);
});

test('«Повторить отправку» puts a failed circle back to sending; only a failed one', () => {
  const failed = reduceNotes([note('1')], { type: 'fail', id: '1', error: 'x' });
  const retried = reduceNotes(failed, { type: 'retry', id: '1' });
  assert.equal(retried[0].state, 'sending'); assert.equal(retried[0].error, undefined); assert.equal(retried[0].progress, 0);
  const sending = [note('2', { progress: 0.4 })];
  assert.equal(reduceNotes(sending, { type: 'retry', id: '2' })[0].progress, 0.4);
});

test('progress only grows while sending; late or bogus callbacks change nothing', () => {
  const list = [note('1', { progress: 0.6 })];
  assert.equal(reduceNotes(list, { type: 'progress', id: '1', sent: 10, total: 100 }), list);
  assert.equal(reduceNotes(list, { type: 'progress', id: '1', sent: 10, total: 0 }), list);
  assert.equal(reduceNotes(list, { type: 'progress', id: '1', sent: 500, total: 100 })[0].progress, 1);
  const failed = reduceNotes(list, { type: 'fail', id: '1', error: 'x' });
  assert.equal(reduceNotes(failed, { type: 'progress', id: '1', sent: 90, total: 100 })[0].progress, 0);
  assert.equal(reduceNotes(list, { type: 'progress', id: 'missing', sent: 1, total: 2 }), list);
});

test('remove, thumb and per-chat order (oldest on top, the newest right above the composer)', () => {
  let list = [note('1', { createdAt: 1 }), note('2', { createdAt: 3, chatId: 'c2' }), note('3', { createdAt: 2 })];
  list = reduceNotes(list, { type: 'thumb', id: '3', thumb: 'file:///t.jpg' });
  assert.equal(list[2].thumb, 'file:///t.jpg');
  assert.deepEqual(notesFor(list, 'c1').map(n => n.id), ['1', '3']);
  assert.deepEqual(reduceNotes(list, { type: 'remove', id: '1' }).map(n => n.id), ['2', '3']);
  assert.equal(reduceNotes([note('1')], { type: 'add', note: note('1', { durationMs: 9 }) }).length, 1);
});

test('errors read like sentences: native wrappers, codes and locations are dropped', () => {
  assert.equal(noteError(new Error('UnexpectedException: Этот файл или его кодек не удалось безопасно обработать. [ERR_LINEA_VIDEO_PROCESSING_FAILED] (at LineVideoModule.swift:30)')), 'Этот файл или его кодек не удалось безопасно обработать.');
  assert.equal(noteError(new TypeError('Network request failed')).startsWith('Нет связи с сервером.'), true);
  assert.equal(noteError(undefined), NOTE_SEND_FALLBACK);
  assert.equal(noteError({}), NOTE_SEND_FALLBACK);
  assert.equal(noteError(new Error('x'.repeat(400))).length, 238);
});

test('the store notifies listeners and tracks which recordings are still needed', () => {
  const store = load();
  let calls = 0; const off = store.subscribeNotes(() => { calls++; });
  store.dispatchNote({ type: 'add', note: note('9') });
  assert.equal(store.noteFileInUse('file:///cache/videonote-9.mp4'), true);
  store.dispatchNote({ type: 'progress', id: 'nope', sent: 1, total: 2 });
  assert.equal(calls, 1);
  store.dispatchNote({ type: 'remove', id: '9' });
  assert.equal(store.noteFileInUse('file:///cache/videonote-9.mp4'), false);
  assert.equal(calls, 2); off();
  store.dispatchNote({ type: 'add', note: note('10') });
  assert.equal(calls, 2);
});

function sender() {
  const cache = new Map();
  const outbox = loadTs(new URL('../src/videonote/noteOutbox.ts', import.meta.url), {}, cache);
  const { queueNote, runNote, discardNote } = loadTs(new URL('../src/videonote/noteSender.ts', import.meta.url), {}, cache);
  const log = { sent: [], deleted: [], uploads: 0 };
  let next = [];
  const deps = {
    upload: async (file, progress) => { log.uploads++; assert.equal(file.mimeType, 'video/mp4'); progress(5, 10); const step = next.shift(); if (step instanceof Error) throw step; if (typeof step === 'function') return step(); return { id: 'f', name: 'video.mp4', mimeType: 'video/mp4', size: 10, media: { width: 480, height: 640 } }; },
    send: (chatId, attachment, reply) => log.sent.push({ chatId, attachment, reply }),
    deleteFile: async uri => { log.deleted.push(uri); },
    fileName: () => 'circle-1.mp4',
  };
  return { outbox, queueNote, runNote, discardNote, deps, log, fail: step => next.push(step) };
}
const take = { id: 'n1', chatId: 'c1', uri: 'file:///cache/videonote-1.mp4', durationMs: 4321, createdAt: 1 };

test('a sent circle goes to the message outbox as circle-*.mp4 with its length; the take is deleted', async () => {
  const s = sender();
  assert.equal(await s.queueNote(s.deps, { ...take, reply: { clientId: 'm', senderId: 'u', preview: 'hi' } }), 'sent');
  assert.equal(s.log.sent.length, 1);
  assert.deepEqual(s.log.sent[0].attachment, { id: 'f', name: 'circle-1.mp4', mimeType: 'video/mp4', size: 10, media: { width: 480, height: 640, durationMs: 4321 } });
  assert.deepEqual(s.log.sent[0].reply, { clientId: 'm', senderId: 'u', preview: 'hi' });
  assert.deepEqual(s.outbox.getNotes(), []);
  assert.deepEqual(s.log.deleted, [take.uri]);
});

test('a failed upload stays in the chat with the reason and its file; «Повторить» sends the same take', async () => {
  const s = sender();
  s.fail(new Error('UnexpectedException: Обработка видео не завершилась вовремя. Исходник не отправлен. [ERR_LINEA_VIDEO_CODEC_TIMEOUT]'));
  assert.equal(await s.queueNote(s.deps, take), 'failed');
  const [failed] = s.outbox.getNotes();
  assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'Обработка видео не завершилась вовремя. Исходник не отправлен.');
  assert.deepEqual(s.log.deleted, []); assert.equal(s.log.sent.length, 0);
  assert.equal(await s.runNote(s.deps, 'n1'), 'sent');
  assert.equal(s.log.uploads, 2); assert.equal(s.log.sent.length, 1); assert.deepEqual(s.log.deleted, [take.uri]);
  assert.deepEqual(s.outbox.getNotes(), []);
});

test('if handing over to the message outbox throws, the circle is kept as failed (not lost)', async () => {
  const s = sender();
  s.deps.send = () => { throw new Error('Сначала открой разговор.'); };
  assert.equal(await s.queueNote(s.deps, take), 'failed');
  assert.equal(s.outbox.getNotes()[0].error, 'Сначала открой разговор.');
  assert.deepEqual(s.log.deleted, []);
});

test('✕ while uploading: the finished upload is not sent and the take is deleted; a second retry while running is ignored', async () => {
  const s = sender();
  let release; s.fail(() => new Promise(resolve => { release = () => resolve({ id: 'f', name: 'video.mp4', mimeType: 'video/mp4', size: 1 }); }));
  const running = s.queueNote(s.deps, take);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await s.runNote(s.deps, 'n1'), 'busy');
  s.discardNote(s.deps, 'n1');
  assert.deepEqual(s.outbox.getNotes(), []); assert.deepEqual(s.log.deleted, []);
  release();
  assert.equal(await running, 'cancelled');
  assert.equal(s.log.sent.length, 0); assert.deepEqual(s.log.deleted, [take.uri]);
});

test('«Удалить» on a failed circle deletes its recording at once', async () => {
  const s = sender();
  s.fail(new Error('x'));
  await s.queueNote(s.deps, take);
  s.discardNote(s.deps, 'n1');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(s.outbox.getNotes(), []); assert.deepEqual(s.log.deleted, [take.uri]);
  assert.equal(await s.runNote(s.deps, 'n1'), 'cancelled');
});
