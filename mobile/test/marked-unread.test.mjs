import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

// AsyncStorage and React are stubbed: the store is exercised in memory, the pure helpers as they are.
const storage = new Map();
const AsyncStorage = { getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); } };
const m = loadTs(new URL('../src/markedUnread.ts', import.meta.url), { '@react-native-async-storage/async-storage': { __esModule: true, default: AsyncStorage }, react: { useSyncExternalStore: (_s, get) => get() } });
const chat = (id, unreadCount = 0) => ({ id, unreadCount });

test('parseMarked keeps unique string ids and drops anything broken', () => {
  assert.deepEqual(m.parseMarked(null), []);
  assert.deepEqual(m.parseMarked('not json'), []);
  assert.deepEqual(m.parseMarked('{"a":1}'), []);
  assert.deepEqual(m.parseMarked(JSON.stringify(['a', 'b', 'a', 3, null, '', 'c'])), ['a', 'b', 'c']);
  const many = Array.from({ length: m.MARKED_LIMIT + 10 }, (_, i) => `c${i}`);
  const kept = m.parseMarked(JSON.stringify(many));
  assert.equal(kept.length, m.MARKED_LIMIT);
  assert.equal(kept.at(-1), `c${m.MARKED_LIMIT + 9}`, 'the newest marks are kept');
});

test('withMarked adds and removes once, and returns the same list when nothing changes', () => {
  const empty = [];
  const one = m.withMarked(empty, 'a', true);
  assert.deepEqual(one, ['a']);
  assert.equal(m.withMarked(one, 'a', true), one);
  assert.equal(m.withMarked(one, 'b', false), one);
  assert.deepEqual(m.withMarked(one, 'a', false), []);
});

test('pruneMarked forgets chats that are gone', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(m.pruneMarked(list, ['a', 'b', 'c', 'd']), list);
  assert.deepEqual(m.pruneMarked(list, new Set(['c', 'a'])), ['a', 'c']);
});

test('a marked chat shows as unread; unread messages do too', () => {
  const marked = new Set(['a']);
  assert.equal(m.showsUnread(chat('a'), marked), true);
  assert.equal(m.showsUnread(chat('b', 2), marked), true);
  assert.equal(m.showsUnread(chat('b'), marked), false);
});

test('markedExtra: one per marked chat without unread messages that the badge counts', () => {
  const marked = new Set(['a', 'b', 'c', 'gone']);
  const chats = [chat('a'), chat('b', 5), chat('c'), chat('d')];
  assert.equal(m.markedExtra(chats, marked, () => true), 2, 'b already counts with its 5 messages');
  assert.equal(m.markedExtra(chats, marked, c => c.id !== 'c'), 1, 'a muted or archived chat is not counted');
  assert.equal(m.markedExtra(chats, new Set(), () => true), 0);
});

test('the store marks, clears, persists per account and prunes', async () => {
  assert.equal(m.getMarkedUnread('u1').size, 0);
  m.setMarkedUnread('u1', 'a', true);
  m.setMarkedUnread('u1', 'b', true);
  assert.deepEqual([...m.getMarkedUnread('u1')], ['a', 'b']);
  assert.equal(m.getMarkedUnread('u2').size, 0, 'another account has its own marks');
  assert.deepEqual(JSON.parse(storage.get('linea.marked-unread.v1:u1')), ['a', 'b']);
  m.setMarkedUnread('u1', 'a', false);
  assert.deepEqual([...m.getMarkedUnread('u1')], ['b']);
  m.pruneMarkedUnread('u1', ['x']);
  assert.equal(m.getMarkedUnread('u1').size, 0);
  // A list saved earlier is read back for an account opened later.
  storage.set('linea.marked-unread.v1:u3', JSON.stringify(['z']));
  m.getMarkedUnread('u3');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([...m.getMarkedUnread('u3')], ['z']);
});

test('the marks published for the tab badge', () => {
  m.setMarkedExtra(3);
  assert.equal(m.useMarkedExtra(), 3);
  m.setMarkedExtra(0);
  assert.equal(m.useMarkedExtra(), 0);
});
