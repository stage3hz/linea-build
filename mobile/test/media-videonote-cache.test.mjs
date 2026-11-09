import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';

function harness() {
  const files = new Map(), deletes = [];
  const fs = { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' },
    async getInfoAsync(uri) { return files.has(uri) ? { exists: true, isDirectory: false, size: 1 } : { exists: false }; },
    async readAsStringAsync() { return ''; }, async writeAsStringAsync(uri) { files.set(uri, Buffer.alloc(0)); },
    async deleteAsync(uri) { deletes.push(uri); files.delete(uri); },
    async readDirectoryAsync() { return [...files.keys()].filter(uri => uri.startsWith('file:///cache/')).map(uri => uri.slice('file:///cache/'.length)); } };
  const pipeline = loadTs(new URL('../src/media/pipeline.ts', import.meta.url), {
    'expo-file-system/legacy': fs, 'expo-crypto': { randomUUID }, 'base64-js': { fromByteArray: b => Buffer.from(b).toString('base64'), toByteArray: b => new Uint8Array(Buffer.from(b, 'base64')) },
    './videoBridge': { getVideoBridge: () => ({ async clearCache() {} }) },
    '../photo/pipeline': { preparePhotoForUpload: async file => ({ file, photo: false, dispose: async () => {} }) },
  });
  return { pipeline, files, deletes };
}

test('«Очистить кэш» removes round-video takes an interrupted recorder left behind, and nothing else', async () => {
  const h = harness();
  for (const name of ['videonote-1730000000000.mp4', 'videonote-1.mp4', `linea-video-export-${randomUUID()}.mp4`, 'linea-view-cache-x/photo.jpg', 'videonote-evil.mp4', 'my-videonote-1.mp4', 'other.mp4']) h.files.set(`file:///cache/${name}`, Buffer.alloc(0));
  await h.pipeline.clearVideoCache();
  assert.deepEqual(h.deletes.filter(uri => uri.includes('videonote')).sort(), ['file:///cache/videonote-1.mp4', 'file:///cache/videonote-1730000000000.mp4']);
  assert.equal(h.files.has('file:///cache/other.mp4'), true); assert.equal(h.files.has('file:///cache/my-videonote-1.mp4'), true); assert.equal(h.files.has('file:///cache/linea-view-cache-x/photo.jpg'), true);
  assert.equal(h.pipeline.VIDEO_NOTE_NAME.test('videonote-1730000000000.mp4'), true); assert.equal(h.pipeline.VIDEO_NOTE_NAME.test('videonote-1730000000000.mp4.bak'), false);
});

test('«Очистить кэш» keeps a circle that is still uploading or waits for «Повторить отправку»', async () => {
  const outbox = loadTs(new URL('../src/videonote/noteOutbox.ts', import.meta.url));
  const files = new Map(), deletes = [];
  const fs = { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' },
    async getInfoAsync() { return { exists: false }; }, async deleteAsync(uri) { deletes.push(uri); files.delete(uri); },
    async readDirectoryAsync() { return [...files.keys()].map(uri => uri.slice('file:///cache/'.length)); } };
  const pipeline = loadTs(new URL('../src/media/pipeline.ts', import.meta.url), {
    'expo-file-system/legacy': fs, 'expo-crypto': { randomUUID }, 'base64-js': { fromByteArray: () => '', toByteArray: () => new Uint8Array() },
    './videoBridge': { getVideoBridge: () => ({ async clearCache() {} }) },
    '../photo/pipeline': { preparePhotoForUpload: async () => { throw new Error('unused'); } },
    '../videonote/noteOutbox': outbox,
  });
  for (const name of ['videonote-1.mp4', 'videonote-2.mp4', 'videonote-3.mp4']) files.set(`file:///cache/${name}`, true);
  const note = (id, uri, state) => ({ id, chatId: 'c', uri, durationMs: 2000, createdAt: 1, progress: 0, state });
  outbox.dispatchNote({ type: 'add', note: note('a', 'file:///cache/videonote-1.mp4', 'sending') });
  outbox.dispatchNote({ type: 'add', note: note('b', 'file:///data/user/0/app/cache/videonote-2.mp4', 'sending') });
  outbox.dispatchNote({ type: 'fail', id: 'b', error: 'x' });
  await pipeline.clearVideoCache();
  assert.deepEqual(deletes, ['file:///cache/videonote-3.mp4']);
});
