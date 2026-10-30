import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { emojiClusters, isEmojiCluster } = loadTs(new URL('../src/platina/emojiText.ts', import.meta.url));

test('emoji clusters keep variation selectors, ZWJ sequences and skin tones together', () => {
  assert.deepEqual(emojiClusters('❤️🔥'), ['❤️', '🔥']);
  assert.deepEqual(emojiClusters('👍🏽 👋'), ['👍🏽', '👋']);
  assert.deepEqual(emojiClusters('👨‍👩‍👧'), ['👨‍👩‍👧']);
  assert.equal(emojiClusters('🔥🔥🔥').length, 3);
});

test('only emoji count as emoji clusters', () => {
  assert.equal(isEmojiCluster('🔥'), true);
  assert.equal(isEmojiCluster('❤️'), true);
  assert.equal(isEmojiCluster('a'), false);
  assert.equal(isEmojiCluster('1'), false);
  assert.equal(isEmojiCluster('Я'), false);
});
