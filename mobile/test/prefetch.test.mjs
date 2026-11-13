import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PREFETCH_CHATS, PREFETCH_FRESH_MS, cursorAfter, keptAnswers, parseKept, parsePlan, planWith, prefetchTargets, validPage } from '../src/prefetch/model.ts';

// Фоновое обновление: encrypted messages are downloaded while the app is closed and used when it opens.
const page = (ids, more = {}) => ({ messages: ids.map(id => ({ id, chatId: 'chat-a' })), nextCursor: ids.at(-1) ?? 0, hasMore: false, ...more });

test('the plan: each chat\'s cursor only moves forward; another device starts it anew', () => {
  let plan = planWith(null, 'dev-1', 'chat-a', 120);
  assert.deepEqual(plan, { deviceId: 'dev-1', cursors: { 'chat-a': 120 } });
  assert.equal(planWith(plan, 'dev-1', 'chat-a', 119), plan, 'never back');
  assert.equal(planWith(plan, 'dev-1', 'chat-a', 120), plan, 'unchanged: nothing to write');
  plan = planWith(plan, 'dev-1', 'chat-b', 7);
  assert.deepEqual(plan.cursors, { 'chat-a': 120, 'chat-b': 7 });
  assert.deepEqual(planWith(plan, 'dev-2', 'chat-a', 5), { deviceId: 'dev-2', cursors: { 'chat-a': 5 } });
  assert.equal(planWith(plan, 'dev-1', '../x', 9), plan, 'not a chat id');
  assert.deepEqual(parsePlan(JSON.stringify(plan)), plan);
  assert.deepEqual(parsePlan('{"deviceId":"d","cursors":{"ok":3,"bad":-1,"../x":4,"frac":1.5}}'), { deviceId: 'd', cursors: { ok: 3 } });
  for (const bad of [null, '', 'x', '{}', '{"deviceId":"","cursors":{}}', '{"deviceId":"d"}']) assert.equal(parsePlan(bad), null);
});

test('a background run asks only for chats with unread messages newer than the cursor, the most recent first', () => {
  const plan = { deviceId: 'd', cursors: { a: 100, b: 50, c: 10, e: 1 } };
  const chats = [
    { id: 'a', unreadCount: 2, lastMessage: { id: 105 }, updatedAt: '2026-11-13T10:00:00Z' },
    { id: 'b', unreadCount: 0, lastMessage: { id: 60 }, updatedAt: '2026-11-13T11:00:00Z' },   // nothing unread
    { id: 'c', unreadCount: 3, lastMessage: { id: 10 }, updatedAt: '2026-11-13T12:00:00Z' },   // already read up to it
    { id: 'd', unreadCount: 5, lastMessage: { id: 9 }, updatedAt: '2026-11-13T13:00:00Z' },    // never opened here: no cursor
    { id: 'e', unreadCount: 1, lastMessage: { id: 4 }, updatedAt: '2026-11-13T14:00:00Z' },
  ];
  assert.deepEqual(prefetchTargets(chats, plan), [{ chatId: 'e', after: 1 }, { chatId: 'a', after: 100 }]);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, unreadCount: 1, lastMessage: { id: 9 }, updatedAt: `2026-11-13T10:${String(i).padStart(2, '0')}:00Z` }));
  assert.equal(prefetchTargets(many, { deviceId: 'd', cursors: Object.fromEntries(many.map(c => [c.id, 0])) }).length, PREFETCH_CHATS);
});

test('only a well-formed page is kept: this chat\'s messages in rising order after the cursor', () => {
  assert.equal(validPage(page([121, 122]), 'chat-a', 120), true);
  assert.equal(validPage(page([]), 'chat-a', 120), true);
  assert.equal(validPage(page([120]), 'chat-a', 120), false, 'not after the cursor');
  assert.equal(validPage(page([122, 121]), 'chat-a', 120), false);
  assert.equal(validPage({ ...page([121]), messages: [{ id: 121, chatId: 'other' }] }, 'chat-a', 120), false, 'another chat\'s message');
  assert.equal(validPage({ messages: [], nextCursor: 'x', hasMore: false }, 'chat-a', 0), false);
  assert.equal(validPage(null, 'chat-a', 0), false);
  assert.equal(cursorAfter(page([121, 125]), 120), 125);
  assert.equal(cursorAfter(page([]), 120), 120);
});

test('a kept page answers only the very same request, and only while fresh', () => {
  const kept = { deviceId: 'dev-1', chatId: 'chat-a', after: 120, at: 1_000_000, result: page([121, 122]) };
  const now = 1_000_000 + 60_000;
  assert.equal(keptAnswers(kept, 'dev-1', 'chat-a', 120, now), true);
  assert.equal(keptAnswers(kept, 'dev-1', 'chat-a', 121, now), false, 'the app has read further since: ask the server');
  assert.equal(keptAnswers(kept, 'dev-1', 'chat-a', 119, now), false);
  assert.equal(keptAnswers(kept, 'dev-2', 'chat-a', 120, now), false, 'another device');
  assert.equal(keptAnswers(kept, 'dev-1', 'chat-b', 120, now), false);
  assert.equal(keptAnswers(kept, 'dev-1', 'chat-a', 120, 1_000_000 + PREFETCH_FRESH_MS), false, 'too old');
  assert.equal(keptAnswers(kept, 'dev-1', 'chat-a', 120, 999_999), false, 'a clock that went back');
  assert.equal(keptAnswers({ ...kept, result: page([]) }, 'dev-1', 'chat-a', 120, now), false, 'an empty page tells nothing');
  assert.equal(keptAnswers(null, 'dev-1', 'chat-a', 120, now), false);
  assert.deepEqual(parseKept(JSON.stringify(kept)), kept);
  assert.equal(parseKept(JSON.stringify({ ...kept, result: page([120]) })), null, 'a damaged file is not used');
  assert.equal(parseKept('not json'), null);
});

test('the background run downloads, never decrypts; the app asks the kept copy first; signing out clears it', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const task = read('../src/prefetch/task.ts');
  assert.ok(!/from '[^']*e2ee|cryptoRuntime|LineaSignal/.test(task), 'no keys in the background: nothing of the encryption is even loaded');
  assert.ok(task.includes("if (Platform.OS === 'android')") && task.includes('TaskManager.defineTask(PREFETCH_TASK'));
  assert.ok(task.includes('await api.inboxPage(plan.deviceId, target.chatId, target.after)'), 'the server\'s page, not the kept one');
  const store = read('../src/prefetch/store.ts');
  assert.ok(!/from '[^']*e2ee|cryptoRuntime|LineaSignal/.test(store));
  assert.ok(store.includes('await FileSystem.deleteAsync(path, { idempotent: true })'), 'a kept page is used once');
  const api = read('../src/api.ts');
  assert.ok(api.includes('const kept = inboxPrefetch ? await inboxPrefetch.take(deviceId, chatId, after).catch(() => null) : null;'));
  assert.ok(api.includes('?? await this.inboxPage(deviceId, chatId, after);'), 'no kept page: the server, as before');
  assert.ok(read('../index.ts').includes("import './src/prefetch/task';"), 'defined at start-up, as the system requires');
  const app = read('../App.tsx');
  assert.equal(app.split('resetChannelOutbox({purge:true});void clearPrefetch();').length - 1, app.split('resetChannelOutbox({purge:true});').length - 1, 'every way out of the account');
  assert.ok(read('../app.config.js').includes("'expo-background-task',"));
  // The PC has neither the task nor the store.
  assert.ok(read('../src/prefetch/task.web.ts').includes('export async function enablePrefetch() {}'));
  assert.ok(read('../src/prefetch/store.web.ts').includes('export async function clearPrefetch() {}'));
});
