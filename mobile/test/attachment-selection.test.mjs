import assert from 'node:assert/strict';
import test from 'node:test';
import { addSelections, toggleSelection, mergeGalleryPage, durationLabel } from '../src/attachments/selection.ts';

const item = id => ({ id, kind: 'photo', file: { uri: `file://${id}.png`, name: `${id}.png`, mimeType: 'image/png' } });

test('corner multi-selection keeps tap order, removes on second tap, and can add again at the end', () => {
  let selection = toggleSelection([], item('a'), 10);
  selection = toggleSelection(selection, item('b'), 10);
  selection = toggleSelection(selection, item('c'), 10);
  selection = toggleSelection(selection, item('b'), 10);
  selection = toggleSelection(selection, item('b'), 10);
  assert.deepEqual(selection.map(value => value.id), ['a', 'c', 'b']);
});

test('file picker merges without duplicate selection or changing previous tap order', () => {
  const a = item('a'), b = item('b'), c = item('c');
  assert.deepEqual(addSelections([a, b], [b, c, a], 10), [a, b, c]);
});

test('selection cap fails before dropping any previous or newly picked file', () => {
  const selected = Array.from({ length: 10 }, (_, i) => item(String(i)));
  assert.throws(() => toggleSelection(selected, item('overflow'), 10), /10/);
  assert.equal(selected.length, 10);
  assert.equal(toggleSelection(selected, item('0'), 10).length, 9);
  assert.throws(() => addSelections([item('a')], selected, 10), /10/);
});

test('existing drafts reduce available selection capacity, while removing a selected item is always possible', () => {
  assert.throws(() => addSelections([item('a')], [item('b'), item('c')], 2), /2/);
  assert.throws(() => addSelections([], [item('a')], 0), /максимальное/);
  assert.deepEqual(toggleSelection([item('a')], item('a'), 0), []);
});

test('adjacent pages merge unique asset ids while refreshing metadata in place', () => {
  const a = { id: 'a', name: 'old' }, b = { id: 'b', name: 'b' }, updated = { id: 'a', name: 'new' };
  assert.deepEqual(mergeGalleryPage([a, b], [updated, { id: 'c', name: 'c' }]), [updated, b, { id: 'c', name: 'c' }]);
});

test('video duration uses milliseconds from SDK57 and formats long clips correctly', () => {
  assert.equal(durationLabel(61500), '1:01');
  assert.equal(durationLabel(3605000), '1:00:05');
  assert.equal(durationLabel(null), 'Видео');
  assert.equal(durationLabel(NaN), 'Видео');
});
