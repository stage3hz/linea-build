import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
const { badgeText } = loadTs(new URL('../src/unreadBadge.ts', import.meta.url), { react: { useSyncExternalStore: () => 0 } });
test('unread counts like Telegram', () => {
  assert.equal(badgeText(0), ''); assert.equal(badgeText(1), '1'); assert.equal(badgeText(999), '999');
  assert.equal(badgeText(1000), '1K'); assert.equal(badgeText(4321), '4,3K'); assert.equal(badgeText(1750), '1,7K');
  assert.equal(badgeText(12_400), '12K'); assert.equal(badgeText(1_250_000), '1,2M');
});
