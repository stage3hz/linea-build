import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

// Generated AI media in the cache: naming, orphan cleanup and the size cap (pure planning logic).
const files = new Map();
const FileSystem = {
  cacheDirectory: 'file:///cache/',
  readDirectoryAsync: async () => [...files.keys()],
  getInfoAsync: async uri => { const name = uri.slice(uri.lastIndexOf('/') + 1); const file = files.get(name); return file ? { exists: true, isDirectory: false, size: file.size, modificationTime: file.modifiedAt / 1000 } : { exists: false }; },
  deleteAsync: async uri => { files.delete(uri.slice(uri.lastIndexOf('/') + 1)); },
  writeAsStringAsync: async (uri, base64) => { files.set(uri.slice(uri.lastIndexOf('/') + 1), { size: base64.length, modifiedAt: Date.now() }); },
  EncodingType: { Base64: 'base64' },
};
const cache = loadTs(new URL('../src/ai/mediaCache.ts', import.meta.url), { 'react-native': { Platform: { OS: 'ios' } }, 'expo-file-system/legacy': FileSystem, 'expo-crypto': { randomUUID: () => 'uuid-1' } });
const file = (name, size, modifiedAt) => ({ name, size, modifiedAt });
const MB = 1024 * 1024;

test('file names carry the conversation id and only AI cache files count as stored media', async () => {
  assert.equal(cache.aiMediaFileName('conv-0001', 'image/png', 'u'), 'linea-ai-conv-0001-u.png');
  assert.equal(cache.aiMediaFileName('../x/y', 'video/mp4', 'u'), 'linea-ai-___x_y-u.mp4');
  assert.equal(cache.aiMediaFileName('c', 'application/octet', 'u'), 'linea-ai-c-u.bin');
  assert.equal(cache.isAIMediaUri('file:///cache/linea-ai-c-u.png'), true);
  assert.equal(cache.isAIMediaUri('file:///cache/linea-view-x/photo.jpg'), false);
  assert.equal(cache.isAIMediaUri('data:image/png;base64,AAAA'), false);
  assert.equal(await cache.writeAIMedia('conv-0001', 'AAAA', 'image/png'), 'file:///cache/linea-ai-conv-0001-uuid-1.png');
  assert.ok(files.has('linea-ai-conv-0001-uuid-1.png')); files.clear();
});

test('orphans are removed, fresh files get a grace period and other prefixes are never touched', () => {
  const now = 1_000_000_000;
  const plan = cache.planAIMediaCleanup([
    file('linea-ai-a-1.png', MB, now - 60 * 60_000), file('linea-ai-b-2.mp4', MB, now - 60 * 60_000),
    file('linea-ai-c-3.png', MB, now - 10_000), file('linea-view-x', MB, 0), file('other.bin', MB, 0),
  ], new Set(['linea-ai-a-1.png']), new Set(), 150 * MB, now);
  assert.deepEqual(plan, ['linea-ai-b-2.mp4']);
});

test('over the limit the oldest referenced files go first, but never those of the conversation on screen', () => {
  const now = 1_000_000_000;
  const list = [file('linea-ai-a-old.mp4', 30 * MB, now - 5 * 3600_000), file('linea-ai-b-mid.mp4', 30 * MB, now - 4 * 3600_000), file('linea-ai-c-cur.mp4', 30 * MB, now - 3 * 3600_000), file('linea-ai-d-new.png', 30 * MB, now - 3600_000)];
  const keep = new Set(list.map(item => item.name));
  assert.deepEqual(cache.planAIMediaCleanup(list, keep, new Set(['linea-ai-a-old.mp4']), 70 * MB, now), ['linea-ai-b-mid.mp4', 'linea-ai-c-cur.mp4']);
  assert.deepEqual(cache.planAIMediaCleanup(list, keep, new Set(), 200 * MB, now), []);
});

test('pruneAIMedia deletes exactly the planned files and missingAIMedia reports lost ones', async () => {
  const old = Date.now() - 3600_000;
  files.set('linea-ai-a-1.png', { size: MB, modifiedAt: old }); files.set('linea-ai-b-2.mp3', { size: MB, modifiedAt: old }); files.set('linea-view-keep', { size: MB, modifiedAt: old });
  const removed = await cache.pruneAIMedia(['file:///cache/linea-ai-a-1.png'], []);
  assert.deepEqual(removed, ['file:///cache/linea-ai-b-2.mp3']);
  assert.deepEqual([...files.keys()].sort(), ['linea-ai-a-1.png', 'linea-view-keep']);
  const turns = [{ id: 1, question: 'q', status: 'complete', media: { uri: 'file:///cache/linea-ai-a-1.png', mimeType: 'image/png' } }, { id: 2, question: 'q', status: 'complete', media: { uri: 'file:///cache/linea-ai-b-2.mp3', mimeType: 'audio/mpeg' } }];
  assert.deepEqual(await cache.missingAIMedia(turns), ['file:///cache/linea-ai-b-2.mp3']);
  await cache.deleteAIMedia(['file:///cache/linea-ai-a-1.png', 'file:///cache/linea-view-keep']);
  assert.deepEqual([...files.keys()], ['linea-view-keep']);
});

test('files are found by name in the current cache folder, even when the folder moved (iOS app update)', async () => {
  const old = Date.now() - 3600_000;
  FileSystem.cacheDirectory = 'file:///Containers/NEW-UUID/cache/';
  try {
    files.set('linea-ai-a-1.png', { size: MB, modifiedAt: old });
    assert.equal(cache.resolveAIMediaUri('linea-ai-a-1.png'), 'file:///Containers/NEW-UUID/cache/linea-ai-a-1.png');
    assert.equal(cache.resolveAIMediaUri('file:///Containers/OLD-UUID/cache/linea-ai-a-1.png'), 'file:///Containers/NEW-UUID/cache/linea-ai-a-1.png');
    assert.equal(cache.resolveAIMediaUri('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    const turns = [{ id: 1, question: 'q', status: 'complete', media: { uri: 'file:///Containers/OLD-UUID/cache/linea-ai-a-1.png', mimeType: 'image/png' } }, { id: 2, question: 'q', status: 'complete', media: { uri: 'linea-ai-b-2.mp3', mimeType: 'audio/mpeg' } }];
    assert.deepEqual(cache.mediaUris(turns), ['linea-ai-a-1.png', 'linea-ai-b-2.mp3']);
    assert.deepEqual(await cache.missingAIMedia(turns), ['linea-ai-b-2.mp3'], 'the old absolute URI still resolves to the present file; the missing one is reported as stored');
    // Prune with an old-style absolute keep URI keeps the file; nothing else is touched.
    assert.deepEqual(await cache.pruneAIMedia(['file:///Containers/OLD-UUID/cache/linea-ai-a-1.png']), []);
    assert.ok(files.has('linea-ai-a-1.png'));
  } finally { FileSystem.cacheDirectory = 'file:///cache/'; files.clear(); }
});

test('deleteAIMedia only ever deletes AI files inside the current cache folder', async () => {
  const deleted = [];
  const original = FileSystem.deleteAsync;
  FileSystem.deleteAsync = async uri => { deleted.push(uri); files.delete(uri.slice(uri.lastIndexOf('/') + 1)); };
  try {
    files.set('linea-ai-a-1.png', { size: MB, modifiedAt: 0 }); files.set('linea-ai-b-2.png', { size: MB, modifiedAt: 0 });
    await cache.deleteAIMedia(['file:///elsewhere/linea-ai-a-1.png', 'linea-ai-b-2.png', 'file:///cache/../x/linea-ai-c-3.png', 'linea-ai-d-4.png?x=1', 'linea-ai-e-5.png#f', 'file:///cache/linea-view-x', 'data:image/png;base64,AAAA', '/etc/passwd']);
    assert.deepEqual(deleted.sort(), ['file:///cache/linea-ai-a-1.png', 'file:///cache/linea-ai-b-2.png']);
    assert.deepEqual([...files.keys()], []);
  } finally { FileSystem.deleteAsync = original; files.clear(); }
});

test('files held by a mounted screen (quick dialog) survive the main screen prune — as orphans and over the limit', async () => {
  const old = Date.now() - 3600_000;
  files.set('linea-ai-quick-x-1.png', { size: MB, modifiedAt: old }); files.set('linea-ai-main-y-1.png', { size: MB, modifiedAt: old }); files.set('linea-ai-gone-z-1.png', { size: MB, modifiedAt: old });
  const release = cache.holdAIMedia(['file:///cache/linea-ai-quick-x-1.png']);
  const releaseAgain = cache.holdAIMedia(['linea-ai-quick-x-1.png']);
  assert.deepEqual([...cache.heldAIMedia()], ['linea-ai-quick-x-1.png']);
  assert.deepEqual(await cache.pruneAIMedia(['linea-ai-main-y-1.png']), ['file:///cache/linea-ai-gone-z-1.png']);
  release(); release();
  assert.deepEqual([...cache.heldAIMedia()], ['linea-ai-quick-x-1.png'], 'still held by the other screen; a double release does not count twice');
  // Over the limit the held file is protected like the conversation on screen.
  assert.deepEqual(cache.planAIMediaCleanup([file('linea-ai-quick-x-1.png', 2 * MB, old), file('linea-ai-main-y-1.png', 2 * MB, old + 1)], new Set(['linea-ai-quick-x-1.png', 'linea-ai-main-y-1.png']), cache.heldAIMedia(), 3 * MB, Date.now()), ['linea-ai-main-y-1.png']);
  releaseAgain();
  assert.deepEqual([...cache.heldAIMedia()], []);
  assert.deepEqual(await cache.pruneAIMedia(['linea-ai-main-y-1.png']), ['file:///cache/linea-ai-quick-x-1.png']);
  files.clear();
});
