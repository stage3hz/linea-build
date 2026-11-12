// «Сохранить для просмотра без сети»: a kept file is outside the cache's size limit and survives restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cache = readFileSync(new URL('../src/media/mediaCache.ts', import.meta.url), 'utf8');

test('kept media is not counted in the limit and is never evicted', () => {
  assert.match(cache, /entry\.status === 'ready' && !entry\.kept \? entry\.size : 0/);
  assert.match(cache, /filter\(\(\[, entry\]\) => entry\.status === 'ready' && !entry\.kept\)/);
});

test('the keep mark lives beside the file in the private cache folder (not in a backed-up folder) and is read back after a restart', () => {
  assert.match(cache, /marker: `\$\{folder\}\.keep`/);
  assert.match(cache, /const folder = `\$\{FileSystem\.cacheDirectory\}linea-view-cache-/, 'the folder that sign-out wipes');
  assert.doesNotMatch(cache, /documentDirectory/);
  assert.match(cache, /const kept = await FileSystem\.getInfoAsync\(marker\)/);
});

test('picture in picture: the viewer keeps playing only inside the small window', () => {
  const viewer = readFileSync(new URL('../src/media/AttachmentViewer.tsx', import.meta.url), 'utf8');
  assert.match(viewer, /allowsPictureInPicture=\{pipSupported\} startsPictureInPictureAutomatically=\{pipSupported\}/);
  assert.match(viewer, /if\(!inPip\.current\)pause\(\);/, 'no sound left playing unseen when the window did not open');
  const config = readFileSync(new URL('../app.config.js', import.meta.url), 'utf8');
  assert.match(config, /\['expo-video', \{ supportsPictureInPicture: true \}\]/);
});
