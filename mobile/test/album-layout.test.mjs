import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { albumLayout } = loadTs(new URL('../src/media/albumLayout.ts', import.meta.url));

test('album rows fill the width exactly and keep every item once, in order', () => {
  for (const aspects of [[0.56, 0.56], [1.5, 0.56, 0.75], [1.33, 1.33, 0.75, 0.56, 1.5, 1.33, 0.75], Array(10).fill(0.75), [2, 2, 2]]) {
    const { tiles, height } = albumLayout(aspects, 300, 435);
    assert.deepEqual(tiles.map(tile => tile.index), aspects.map((_, i) => i));
    const rows = new Map();
    for (const tile of tiles) rows.set(tile.y, [...(rows.get(tile.y) || []), tile]);
    for (const row of rows.values()) {
      const last = row[row.length - 1];
      assert.equal(last.x + last.width, 300, 'row reaches the right edge');
      assert.ok(row.every(tile => tile.width > 20));
    }
    assert.ok(height <= 436, `height ${height}`);
  }
});

test('two vertical photos sit side by side, a wide one may take a whole row', () => {
  const pair = albumLayout([0.56, 0.56], 300, 435).tiles;
  assert.equal(pair[0].y, pair[1].y);
  const mixed = albumLayout([2.2, 0.7, 0.7], 300, 435).tiles;
  assert.equal(mixed[0].width, 300);
});
