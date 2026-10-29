import assert from 'node:assert/strict';
import test from 'node:test';
import { ThumbnailSession } from '../src/attachments/ThumbnailSession.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('visible video requests share one thumbnail and dispose only generated cache files', async () => {
  const made = [], removed = [];
  const session = new ThumbnailSession(async uri => { made.push(uri); return `cache:${uri}`; }, async uri => { removed.push(uri); });
  const first = session.get('a', 'original:a'), second = session.get('a', 'original:a');
  assert.equal(await first, 'cache:original:a');
  assert.equal(await second, 'cache:original:a');
  assert.deepEqual(made, ['original:a']);
  session.close(); session.close();
  await session.drain();
  assert.deepEqual(removed, ['cache:original:a']);
});

test('closing a panel during decoding deletes the late thumbnail and skips queued videos', async () => {
  const calls = [], removed = [], first = deferred(), second = deferred();
  const session = new ThumbnailSession(uri => { calls.push(uri); return uri === 'a' ? first.promise : second.promise; }, async uri => { removed.push(uri); });
  const pending = Promise.allSettled([session.get('a', 'a'), session.get('b', 'b'), session.get('c', 'c')]);
  await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b']);
  session.close();
  first.resolve('cache:a'); second.resolve('cache:b');
  const results = await pending;
  await session.drain();
  assert.ok(results.every(value => value.status === 'rejected'));
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(removed.sort(), ['cache:a', 'cache:b']);
});

test('a thumbnail generator returning the original URI cannot cause deletion of the original', async () => {
  const removed = [];
  const session = new ThumbnailSession(async uri => uri, async uri => { removed.push(uri); });
  await assert.rejects(session.get('a', 'original:a'));
  session.close(); await session.drain();
  assert.deepEqual(removed, []);
});
