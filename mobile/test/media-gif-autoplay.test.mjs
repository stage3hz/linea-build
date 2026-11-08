import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const { isGif, mediaPreviewKind } = loadTs(new URL('../src/media/formats.ts', import.meta.url));

test('GIFs are photos for layout but recognised for the «Автозапуск GIF» switch', () => {
  for (const file of [{ name: 'animation.gif', mimeType: 'image/gif' }, { name: 'payload.bin', mimeType: 'IMAGE/GIF' }, { name: 'clip.GIF', mimeType: '' }]) {
    assert.equal(isGif(file), true, file.name); assert.equal(mediaPreviewKind(file), 'photo', file.name);
  }
  for (const file of [{ name: 'photo.jpg', mimeType: 'image/jpeg' }, { name: 'gif-guide.png', mimeType: 'image/png' }, { name: 'clip.mp4', mimeType: 'video/mp4' }, { name: 'notes.txt', mimeType: 'text/plain' }]) assert.equal(isGif(file), false, file.name);
});
