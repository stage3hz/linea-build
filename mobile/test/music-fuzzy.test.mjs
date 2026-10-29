import assert from 'node:assert/strict';
import test from 'node:test';
import { spellingVariants, mergeRanked, similarity } from '../src/music/fuzzy.ts';

test('a one-letter typo produces the right spelling among few variants', () => {
  const variants = spellingVariants('medk1d');
  assert.ok(variants.includes('madk1d'));
  assert.ok(variants.length <= 8);
  assert.deepEqual(spellingVariants('мэдкид'), ['medkid']);
  assert.ok(spellingVariants('скрип тонит').includes('скриптонит'));
  assert.deepEqual(spellingVariants(''), []);
});

test('variant results are ranked by closeness and unrelated ones are dropped', () => {
  const exact = [];
  const variant = [{ id: '1', title: 'Madk1d - Ты че обиделась', artist: 'ponj' }, { id: '2', title: 'Random', artist: 'Rashed Ahmed' }];
  const merged = mergeRanked('medk1d', [exact, variant]);
  assert.deepEqual(merged.map(t => t.id), ['1']);
  assert.ok(similarity('medk1d', 'Madk1d') > similarity('medk1d', 'Ahmed'));
});
