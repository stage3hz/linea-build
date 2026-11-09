import test from 'node:test';
import assert from 'node:assert/strict';
import { sameValue, reuse, stabilizeById } from '../src/stable.ts';

test('sameValue compares structurally with a depth limit', () => {
  assert.equal(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), false);
  assert.equal(sameValue({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(sameValue({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }, 2), false);
});
test('reuse keeps the previous identity for equal values', () => {
  const prev = { id: 1, reactions: [{ e: 'x', n: 1 }] };
  assert.equal(reuse(prev, { id: 1, reactions: [{ e: 'x', n: 1 }] }), prev);
  const next = { id: 1, reactions: [{ e: 'x', n: 2 }] };
  assert.equal(reuse(prev, next), next);
});
test('stabilizeById reuses equal items and forgets gone ones', () => {
  const cache = new Map();
  const first = stabilizeById(cache, [{ k: 'a', v: 1 }, { k: 'b', v: 1 }], i => i.k);
  const second = stabilizeById(cache, [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'c', v: 1 }], i => i.k);
  assert.equal(second[0], first[0]);
  assert.notEqual(second[1], first[1]);
  assert.equal(cache.size, 3);
  stabilizeById(cache, [], i => i.k);
  assert.equal(cache.size, 0);
});
