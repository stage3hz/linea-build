import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageIndex, normalize, queryTerms, snippet } from '../src/search/messageIndex.ts';

const entry = (clientId, text, extra = {}) => ({ chatId: 'chat-a', senderId: 'peer', clientId, text, sentAt: '2026-11-0' + ((clientId.charCodeAt(0) % 9) + 1) + 'T10:00:00.000Z', ...extra });

test('G029: normalize is case-, ё- and й-insensitive and folds diacritics', () => {
  assert.equal(normalize('Ёлка  ЁЖ'), 'елка еж');
  assert.equal(normalize('Йогурт'), 'иогурт');
  assert.equal(normalize('Café'), 'cafe');
  assert.deepEqual(queryTerms('  Привет,   мир '), ['привет,', 'мир']);
  assert.deepEqual(queryTerms('   '), []);
});

test('G029: prefix and substring matches in text, every word of the query must match', () => {
  const index = new MessageIndex();
  index.add(entry('a', 'Встретимся завтра у метро'));
  index.add(entry('b', 'Ёлку купили, ежа нет'));
  index.add(entry('c', 'Unrelated text'));
  assert.deepEqual(index.search('завт').flatMap(g => g.hits.map(h => h.clientId)), ['a'], 'prefix');
  assert.deepEqual(index.search('метр').flatMap(g => g.hits.map(h => h.clientId)), ['a'], 'substring of a later word');
  assert.deepEqual(index.search('ЕЛКУ ЕЖА').flatMap(g => g.hits.map(h => h.clientId)), ['b'], 'ё → е, case');
  assert.deepEqual(index.search('елку метро'), [], 'words from different messages do not combine');
  assert.deepEqual(index.search(''), []);
});

test('G029: the sender name counts, results are grouped by chat with the newest first', () => {
  const index = new MessageIndex();
  index.add({ chatId: 'chat-a', senderId: 'peer-a', clientId: '1', text: 'Привет', sentAt: '2026-11-01T10:00:00Z' });
  index.add({ chatId: 'chat-b', senderId: 'peer-b', clientId: '2', text: 'Привет', sentAt: '2026-11-03T10:00:00Z' });
  index.add({ chatId: 'chat-a', senderId: 'me', clientId: '3', text: 'Привет снова', sentAt: '2026-11-02T10:00:00Z' });
  const names = (senderId, chatId) => senderId === 'me' ? 'Иван' : chatId === 'chat-a' ? 'Алёна' : 'Борис';
  const groups = index.search('привет', { names });
  assert.deepEqual(groups.map(g => g.chatId), ['chat-b', 'chat-a'], 'the chat with the newest hit comes first');
  assert.deepEqual(groups[1].hits.map(h => h.clientId), ['3', '1'], 'hits newest first');
  assert.equal(groups[1].latest, '2026-11-02T10:00:00Z');
  assert.deepEqual(index.search('алена', { names }).flatMap(g => g.hits.map(h => h.clientId)), ['1'], 'sender name, ё-insensitive');
  assert.deepEqual(index.search('иван снова', { names }).flatMap(g => g.hits.map(h => h.clientId)), ['3'], 'name and text words mixed');
  assert.deepEqual(index.search('привет', { names, chats: new Set(['chat-a']) }).map(g => g.chatId), ['chat-a'], 'limited to known chats');
  assert.equal(index.search('привет', { limit: 2 }).flatMap(g => g.hits).length, 2);
  assert.equal(index.search('привет', { perChat: 1 }).find(g => g.chatId === 'chat-a').hits.length, 1);
});

test('G029: duplicates, edits, attachment names, removal and hidden-key shape', () => {
  const index = new MessageIndex();
  assert.equal(index.add(entry('a', 'Один')), true);
  assert.equal(index.add(entry('a', 'Один')), false, 'same message twice is one entry');
  assert.equal(index.add(entry('a', 'Один исправленный')), true, 'an edit replaces the text under the same key');
  assert.equal(index.size, 1);
  assert.equal(index.add(entry('b', '   ')), false, 'nothing to search in');
  assert.equal(index.add(entry('c', '', { attachmentName: 'Отчёт.pdf' })), true, 'a file name is searchable');
  assert.deepEqual(index.search('отчет').flatMap(g => g.hits.map(h => h.clientId)), ['c']);
  assert.equal(index.search('отчет')[0].hits[0].key, 'chat-a:peer:c');
  assert.equal(index.remove({ chatId: 'chat-a', senderId: 'peer', clientId: 'c' }), true);
  assert.deepEqual(index.search('отчет'), []);
  index.add({ ...entry('d', 'В другом чате'), chatId: 'chat-z' });
  assert.equal(index.removeChat('chat-z'), 1);
  assert.equal(index.size, 1);
});

test('G029: memory stays bounded — the oldest messages give way and text is capped', () => {
  const index = new MessageIndex(100);
  for (let i = 0; i < 130; i++) index.add({ chatId: 'c', senderId: 's', clientId: `k${i}`, text: `сообщение ${i}`, sentAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
  assert.ok(index.size <= 100, `size ${index.size}`);
  assert.equal(index.search('сообщение 0').flatMap(g => g.hits).some(h => h.clientId === 'k0'), false, 'the oldest left');
  assert.ok(index.search('сообщение 129').flatMap(g => g.hits).some(h => h.clientId === 'k129'), 'the newest stayed');
  assert.equal(index.add({ chatId: 'c', senderId: 's', clientId: 'ancient', text: 'сообщение древнее', sentAt: '2000-01-01T00:00:00Z' }), false, 'older than everything kept: not worth a slot');
  const long = new MessageIndex();
  long.add({ chatId: 'c', senderId: 's', clientId: 'l', text: 'a'.repeat(5000) + ' хвост', sentAt: '2026-01-01T00:00:00Z' });
  assert.equal(long.search('aaaa')[0].hits[0].text.length, 300);
  assert.deepEqual(long.search('хвост'), [], 'what is past the cap is not indexed');
  assert.equal(new MessageIndex().maxEntries, 10000);
});

test('G029: a message deleted for everyone leaves the index and stays out, whichever order the page arrives in', () => {
  const index = new MessageIndex();
  const ref = { chatId: 'chat-a', senderId: 'peer', clientId: 'gone' };
  // Deletion first (Promise.all hydration), the original after it.
  assert.equal(index.tombstone(ref), true);
  assert.equal(index.add(entry('gone', 'Секретный текст')), false, 'a tombstoned key is refused');
  assert.deepEqual(index.search('секретный'), []);
  assert.equal(index.tombstone(ref), false, 'nothing new the second time');
  // The original first, the deletion after it.
  index.add(entry('late', 'Ещё один секрет'));
  assert.deepEqual(index.search('секрет').flatMap(g => g.hits.map(h => h.clientId)), ['late']);
  assert.equal(index.tombstone({ chatId: 'chat-a', senderId: 'peer', clientId: 'late' }), true);
  assert.deepEqual(index.search('секрет'), []);
  assert.equal(index.add(entry('late', 'Ещё один секрет')), false);
  assert.equal(index.size, 0);
  // Someone else's message with the same clientId is a different key: not affected.
  assert.equal(index.add({ ...entry('gone', 'Не моё'), senderId: 'me' }), true);
  // removeChat / clear forget the tombstones of that chat too.
  index.removeChat('chat-a');
  assert.equal(index.add(entry('gone', 'Снова можно')), true);
  index.tombstone(ref); index.clear();
  assert.equal(index.add(entry('gone', 'И после clear')), true);
});

test('G029: an edit replaces the text under the same key, keeps the original time, and wins over the original in any order', () => {
  const index = new MessageIndex();
  index.add({ chatId: 'chat-a', senderId: 'peer', clientId: 'e', text: 'Первый вариант', sentAt: '2026-11-01T10:00:00Z' });
  assert.equal(index.edit({ chatId: 'chat-a', senderId: 'peer', clientId: 'e' }, 'Второй вариант', '2026-11-02T10:00:00Z'), true);
  const hit = index.search('вариант').flatMap(g => g.hits);
  assert.equal(hit.length, 1); assert.equal(hit[0].text, 'Второй вариант'); assert.equal(hit[0].sentAt, '2026-11-01T10:00:00Z', 'the message keeps its own time');
  assert.deepEqual(index.search('первый'), [], 'the old text is gone');
  // The edit arrives before the original (parallel hydration): the edited text still wins.
  assert.equal(index.edit({ chatId: 'chat-a', senderId: 'peer', clientId: 'f' }, 'Исправлено', '2026-11-03T10:00:00Z'), true);
  assert.equal(index.add({ chatId: 'chat-a', senderId: 'peer', clientId: 'f', text: 'Исходный', sentAt: '2026-11-02T09:00:00Z', attachmentName: 'файл.txt' }), true, 'the time and the file name are taken from the original');
  const f = index.search('исправлено').flatMap(g => g.hits);
  assert.equal(f[0].text, 'Исправлено'); assert.equal(f[0].sentAt, '2026-11-02T09:00:00Z'); assert.equal(f[0].attachmentName, 'файл.txt');
  assert.deepEqual(index.search('исходный'), []);
  // Two edits out of order: the newer one stays.
  index.edit({ chatId: 'chat-a', senderId: 'peer', clientId: 'f' }, 'Третье', '2026-11-05T10:00:00Z');
  assert.equal(index.edit({ chatId: 'chat-a', senderId: 'peer', clientId: 'f' }, 'Второе', '2026-11-04T10:00:00Z'), false);
  assert.equal(index.search('третье').flatMap(g => g.hits).length, 1);
  // An edit of a deleted message changes nothing.
  index.tombstone({ chatId: 'chat-a', senderId: 'peer', clientId: 'f' });
  assert.equal(index.edit({ chatId: 'chat-a', senderId: 'peer', clientId: 'f' }, 'Воскресло', '2026-11-06T10:00:00Z'), false);
  assert.deepEqual(index.search('воскресло'), []);
});

test('G029: snippet shows the text around the first match', () => {
  assert.equal(snippet('Короткое сообщение', 'сообщ'), 'Короткое сообщение');
  const long = 'Начало длинного сообщения, которое продолжается и продолжается, а вот и ключевое слово Ёжик в самом конце';
  const out = snippet(long, 'ежик');
  assert.ok(out.startsWith('…'));
  assert.ok(out.includes('Ёжик'), out);
  assert.ok(out.length <= 91);
  assert.equal(snippet('  много   пробелов   тут ', 'нет'), 'много пробелов тут');
});
