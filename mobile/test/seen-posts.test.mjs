import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

// AsyncStorage and React are stubbed: the store is exercised in memory, the pure helpers as they are.
const storage = new Map();
const AsyncStorage = { getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); } };
const m = loadTs(new URL('../src/stories/seenPosts.ts', import.meta.url), { '@react-native-async-storage/async-storage': { __esModule: true, default: AsyncStorage }, react: { useSyncExternalStore: (_s, get) => get() } });

test('parseSeenPosts keeps unique string ids and drops anything broken', () => {
  assert.deepEqual(m.parseSeenPosts(null), []);
  assert.deepEqual(m.parseSeenPosts('not json'), []);
  assert.deepEqual(m.parseSeenPosts('{"a":1}'), []);
  assert.deepEqual(m.parseSeenPosts(JSON.stringify(['a', 'b', 'a', 3, null, '', 'c'])), ['a', 'b', 'c']);
});

test('withSeenPosts adds new ids once, returns the same list when nothing is new and keeps the newest past the limit', () => {
  const list = ['a'];
  assert.equal(m.withSeenPosts(list, ['a']), list);
  assert.equal(m.withSeenPosts(list, []), list);
  assert.deepEqual(m.withSeenPosts(list, ['b', 'b', 'a', 'c']), ['a', 'b', 'c']);
  const full = Array.from({ length: m.SEEN_POSTS_LIMIT }, (_, i) => `p${i}`);
  const next = m.withSeenPosts(full, ['new']);
  assert.equal(next.length, m.SEEN_POSTS_LIMIT); assert.equal(next.at(-1), 'new'); assert.equal(next.includes('p0'), false);
});

test('the strip order: unseen stories and unopened posts first, then the rest, newest first inside each group', () => {
  const story = (id, unseen, latest) => ({ id, stories: [{}], unseen, latest });
  const post = (id, postId, latest) => ({ id, stories: [], unseen: 0, posts: [{ id: postId }], latest });
  const items = [story('seenStory', 0, '2026-11-07T12:00:00.000Z'), post('openedPost', 'p1', '2026-11-07T13:00:00.000Z'), post('newPost', 'p2', '2026-11-07T09:00:00.000Z'), story('newStory', 2, '2026-11-07T08:00:00.000Z')];
  const seen = new Set(['p1']);
  assert.equal(m.hasUnseen(items[1], seen), false); assert.equal(m.hasUnseen(items[2], seen), true);
  assert.deepEqual(m.stripOrder(items, seen).map(item => item.id), ['newPost', 'newStory', 'openedPost', 'seenStory']);
  // Opened once, the post moves to the seen group.
  assert.deepEqual(m.stripOrder(items, new Set(['p1', 'p2'])).map(item => item.id), ['newStory', 'openedPost', 'seenStory', 'newPost']);
  // A person with a live story is judged by the story even if the server also sent posts.
  assert.equal(m.hasUnseen({ stories: [{}], unseen: 0, posts: [{ id: 'x' }] }, new Set()), false);
});

test('the store remembers opened posts per account and writes them to storage', async () => {
  storage.set('linea.seen-posts.v1:u1', JSON.stringify(['old']));
  assert.equal(m.useSeenPosts('u1').has('fresh'), false);
  m.markPostsSeen('u1', ['fresh']);
  assert.equal(m.useSeenPosts('u1').has('fresh'), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  // The stored list that arrived after the mark is merged with it, not lost.
  assert.deepEqual([...m.useSeenPosts('u1')].sort(), ['fresh', 'old']);
  assert.deepEqual(JSON.parse(storage.get('linea.seen-posts.v1:u1')), ['fresh']);
  m.markPostsSeen('u1', ['again']);
  assert.deepEqual(JSON.parse(storage.get('linea.seen-posts.v1:u1')).sort(), ['again', 'fresh', 'old']);
  assert.equal(m.useSeenPosts('u2').size, 0);
});
