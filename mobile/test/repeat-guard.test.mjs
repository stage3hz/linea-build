import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { REPEAT_FORGET_MS, checkRepeat, repeatBroken, repeatKey, repeatNotice, repeatWait } from '../src/repeatGuard.ts';

// The same message over and over: five in a row, then 10 s, 15 s, 20 s… between copies.

test('the same text goes five times in a row; the sixth waits 10 s, and each copy after it 5 s longer', () => {
  let now = 1_000_000;
  for (let i = 1; i <= 5; i++) assert.equal(repeatWait('a', 'привет', now += 100), 0, `copy ${i}`);
  assert.equal(repeatWait('a', 'привет', now += 1_000), 9, 'the sixth, one second later');
  assert.equal(repeatWait('a', 'привет', now += 8_999), 1, 'a refused attempt does not restart the wait');
  assert.equal(repeatWait('a', 'привет', now += 1), 0, 'exactly 10 s after the fifth');
  assert.equal(repeatWait('a', 'привет', now += 10_000), 5, 'the seventh needs 15 s');
  assert.equal(repeatWait('a', 'привет', now += 5_000), 0);
  assert.equal(repeatWait('a', 'привет', now += 19_999), 1, 'the eighth needs 20 s');
  assert.equal(repeatWait('a', 'привет', now += 1), 0);
  assert.equal(repeatWait('a', 'привет', now += 24_000), 1, 'the ninth needs 25 s');
});

test('«the same» ignores case and spacing; a different message starts the count again', () => {
  assert.equal(repeatKey('  ПриВет,\n  как   дела? '), 'привет, как дела?');
  let now = 5_000_000;
  for (const text of ['Купи слона', 'купи  слона', 'КУПИ СЛОНА', ' купи слона ', 'Купи\nслона']) assert.equal(repeatWait('b', text, now += 10), 0);
  assert.ok(repeatWait('b', 'купи слона', now += 10) > 0);
  assert.equal(repeatWait('b', 'ладно, не надо', now += 10), 0, 'another text is not held');
  for (let i = 0; i < 5; i++) assert.equal(repeatWait('b', 'купи слона', now += 10), 0, 'and the old one counts from one again');
  assert.ok(repeatWait('b', 'купи слона', now += 10) > 0);
});

test('each chat has its own count; a photo or a long pause ends the run', () => {
  let now = 9_000_000;
  for (let i = 0; i < 5; i++) { assert.equal(repeatWait('c', 'да', now += 10), 0); assert.equal(repeatWait('d', 'да', now += 10), 0); }
  assert.ok(repeatWait('c', 'да', now += 10) > 0);
  assert.ok(repeatWait('d', 'да', now += 10) > 0);
  repeatBroken('c');
  assert.equal(repeatWait('c', 'да', now += 10), 0, 'after something else was sent');
  assert.ok(repeatWait('d', 'да', now += 10) > 0, 'the other chat is still held');
  assert.equal(repeatWait('d', 'да', now += REPEAT_FORGET_MS), 0, 'ten minutes later it is a new message');
});

test('the rule itself: nothing is counted when a copy is refused, and an empty text is never held', () => {
  const start = checkRepeat(null, 'x', 0);
  assert.deepEqual(start, { allowed: true, state: { key: 'x', count: 1, lastAt: 0 } });
  const held = checkRepeat({ key: 'x', count: 5, lastAt: 0 }, 'x', 4_000);
  assert.deepEqual(held, { allowed: false, waitMs: 6_000 });
  assert.equal(checkRepeat({ key: 'x', count: 9, lastAt: 0 }, 'X ', 29_999).allowed, false, 'the tenth copy: 10 + 4·5 = 30 s');
  assert.equal(checkRepeat({ key: 'x', count: 9, lastAt: 0 }, 'X ', 30_000).allowed, true);
  assert.equal(checkRepeat({ key: '', count: 50, lastAt: 0 }, '   ', 1).allowed, true);
  assert.equal(repeatNotice(7), 'Одинаковое сообщение. Подожди 7 с.');
});

test('both senders ask before sending, and the text stays in the field', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const chat = read('../src/ChatScreen.tsx');
  assert.ok(chat.includes('if(out.text){const wait=repeatWait(chat.id,out.text);if(wait){toast(repeatNotice(wait));return;}}'));
  assert.ok(chat.indexOf('repeatWait(chat.id,out.text)') < chat.indexOf('if(replyTo){\n      const reply='), 'before any of the ways a text is sent');
  assert.ok(read('../src/communities/ChannelChat.tsx').includes('if (!editing) { const wait = repeatWait(`channel:${channel.id}`, value); if (wait) { setError(repeatNotice(wait)); return; } }'));
});
