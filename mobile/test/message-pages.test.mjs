import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPage, mergeMessages } from '../src/messagePages.ts';

const msg = (id, extra = {}) => ({ id, chatId: 'c', senderId: 'u', clientId: `k${id}`, text: 't', createdAt: '', ...extra });
const ids = list => list.map(m => m.id);

test('mergeMessages: by id, sorted, the Mesh copy goes once the server copy is here', () => {
  const mesh = msg(9e15 + 1, { mesh: true, clientId: 'k3' });
  assert.deepEqual(ids(mergeMessages([msg(3), msg(1)], [msg(2), mesh])), [1, 2, 3]);
  assert.deepEqual(ids(mergeMessages([msg(1)], [mesh])), [1, 9e15 + 1]);
});

test('B16: the latest page after a reconnect keeps the history scrolled up earlier', () => {
  const prev = [msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)]; // 1–3 came through «Более ранние сообщения»
  const page = [msg(4), msg(5), msg(6)];
  const result = applyPage(prev, page, { older: false, hasMore: true, prevHasMore: false });
  assert.deepEqual(ids(result.messages), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.hasMore, false, 'the start of the chat was reached before; the server flag speaks only of its own page');
  const fresh = applyPage([], page, { older: false, hasMore: true });
  assert.deepEqual(ids(fresh.messages), [4, 5, 6]);
  assert.equal(fresh.hasMore, true);
});

test('B16: within the page range a message gone from the server disappears; newer ones from the socket stay', () => {
  const prev = [msg(1), msg(4), msg(5), msg(6), msg(7)];
  const page = [msg(4), msg(6)]; // 5 was deleted on the server; 7 arrived over the socket while the page was in flight
  const result = applyPage(prev, page, { older: false, hasMore: true, prevHasMore: true });
  assert.deepEqual(ids(result.messages), [1, 4, 6, 7]);
  assert.equal(result.hasMore, true);
});

test('B16: a page disjoint from the loaded history replaces it (no gap of unseen messages)', () => {
  // Loaded 100..150 before the background; 30 messages arrived while away, the page holds only 166..180.
  const prev = Array.from({ length: 51 }, (_, i) => msg(100 + i));
  const page = Array.from({ length: 15 }, (_, i) => msg(166 + i));
  const mesh = msg(9e15 + 1, { mesh: true, clientId: 'm' });
  const result = applyPage([...prev, mesh], page, { older: false, hasMore: true, prevHasMore: false });
  assert.deepEqual(ids(result.messages), [...page.map(m => m.id), 9e15 + 1], 'keeping 100..150 would hide 151..165 behind a gap');
  assert.equal(result.hasMore, true, 'the server flag speaks: «Более ранние сообщения» brings 151..165 back');
  // Overlapping by a single message is enough to keep the history.
  const touching = applyPage(prev, [msg(150), ...page], { older: false, hasMore: true, prevHasMore: false });
  assert.deepEqual(ids(touching.messages), [...prev.map(m => m.id), ...page.map(m => m.id)]);
  assert.equal(touching.hasMore, false);
});

test('B16: a page that is the whole chat drops older leftovers, keeps Mesh copies; an empty chat keeps only Mesh', () => {
  const mesh = msg(9e15 + 1, { mesh: true, clientId: 'm' });
  const result = applyPage([msg(1), msg(2), mesh], [msg(2)], { older: false, hasMore: false, prevHasMore: true });
  assert.deepEqual(ids(result.messages), [2, 9e15 + 1]);
  assert.equal(result.hasMore, false);
  const empty = applyPage([msg(1), mesh], [], { older: false, hasMore: false });
  assert.deepEqual(ids(empty.messages), [9e15 + 1]);
  assert.equal(empty.hasMore, false);
});

test('B16: an older page is only added, with the server flag', () => {
  const result = applyPage([msg(4), msg(5)], [msg(2), msg(3)], { older: true, hasMore: false });
  assert.deepEqual(ids(result.messages), [2, 3, 4, 5]);
  assert.equal(result.hasMore, false);
});
