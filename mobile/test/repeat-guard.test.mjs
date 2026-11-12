import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { REPEAT_RESET_MS, checkRepeat, repeatBroken, repeatKey, repeatNotice, repeatWait } from '../src/repeatGuard.ts';

// The same message over and over: five in a row, then 10 s, 15 s, 20 s… between copies; after that the next
// messages are held from their second copy; four hours later everything is as at the start.

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

test('before the limit is reached, another message simply starts the count again', () => {
  assert.equal(repeatKey('  ПриВет,\n  как   дела? '), 'привет, как дела?');
  let now = 5_000_000;
  for (const text of ['Купи слона', 'купи  слона', 'КУПИ СЛОНА', ' купи слона ']) assert.equal(repeatWait('b', text, now += 10), 0);
  assert.equal(repeatWait('b', 'ладно, не надо', now += 10), 0);
  for (let i = 0; i < 5; i++) assert.equal(repeatWait('b', 'Купи\nслона', now += 10), 0, 'five again: the limit was never reached');
  assert.ok(repeatWait('b', 'купи слона', now += 10) > 0);
});

test('after the limit the next message is held from its second copy, and the wait goes on growing', () => {
  let now = 20_000_000;
  for (let i = 0; i < 5; i++) assert.equal(repeatWait('s', 'спам', now += 10), 0);
  assert.equal(repeatWait('s', 'спам', now += 10_000), 0, 'the sixth, after its 10 s: the limit is reached');
  // Another text: once is free, the second copy already waits — 15 s, not 10 (the wait continues).
  assert.equal(repeatWait('s', 'другое', now += 10), 0);
  assert.equal(repeatWait('s', 'другое', now += 1_000), 14);
  assert.equal(repeatWait('s', 'другое', now += 14_000), 0);
  assert.equal(repeatWait('s', 'другое', now += 1_000), 19, 'its third copy: 20 s');
  // A third text, and a photo in between: still strict.
  assert.equal(repeatWait('s', 'третье', now += 10), 0);
  repeatBroken('s', now += 10);
  assert.equal(repeatWait('s', 'третье', now += 10), 0, 'after the photo it is a first copy again');
  assert.equal(repeatWait('s', 'третье', now += 1_000), 19, 'but the second one waits the same 20 s');
  // Different messages one after another are never held.
  for (const text of ['раз', 'два', 'три', 'четыре']) assert.equal(repeatWait('s', text, now += 10), 0);
});

test('four hours after the limit was first reached everything is back to the start, whatever was sent since', () => {
  let now = 40_000_000;
  for (let i = 0; i < 5; i++) assert.equal(repeatWait('r', 'спам', now += 10), 0);
  assert.equal(repeatWait('r', 'спам', now += 10_000), 0, 'the first held copy: the four hours start here');
  const first = now;
  // Three hours later the spam goes on: still strict, the wait still grows — and the four hours are NOT extended.
  now = first + 3 * 3_600_000;
  assert.equal(repeatWait('r', 'иное', now += 10), 0);
  assert.equal(repeatWait('r', 'иное', now += 1_000), 14);
  assert.equal(repeatWait('r', 'иное', now += 14_000), 0, 'a held copy three hours in');
  now = first + REPEAT_RESET_MS - 1;
  assert.equal(repeatWait('r', 'ещё', now), 0);
  assert.ok(repeatWait('r', 'ещё', now) > 0, 'one millisecond short of four hours: still strict');
  now = first + REPEAT_RESET_MS;
  for (let i = 0; i < 4; i++) assert.equal(repeatWait('r', 'ещё', now += 10), 0, 'five in a row again (one was sent a moment ago… as a new run)');
  assert.equal(repeatWait('r', 'ещё', now += 10), 0);
  assert.equal(repeatWait('r', 'ещё', now += 1_000), 9, 'and the wait starts from 10 s');
  assert.deepEqual(checkRepeat({ key: 'x', count: 1, lastAt: 500, level: 2, heldAt: 100 }, 'x', 30_000), { allowed: true, state: { key: 'x', count: 2, lastAt: 30_000, level: 3, heldAt: 100 } }, 'a later held copy keeps the first one\'s time');
});

test('each chat has its own count', () => {
  let now = 60_000_000;
  for (let i = 0; i < 5; i++) { assert.equal(repeatWait('c', 'да', now += 10), 0); assert.equal(repeatWait('d', 'да', now += 10), 0); }
  assert.ok(repeatWait('c', 'да', now += 10) > 0);
  assert.equal(repeatWait('e', 'да', now += 10), 0);
});

test('the rule itself: nothing is counted when a copy is refused, and an empty text is never held', () => {
  assert.deepEqual(checkRepeat(null, 'x', 0), { allowed: true, state: { key: 'x', count: 1, lastAt: 0, level: 0, heldAt: 0 } });
  assert.deepEqual(checkRepeat({ key: 'x', count: 5, lastAt: 0, level: 0, heldAt: 0 }, 'x', 4_000), { allowed: false, waitMs: 6_000 });
  assert.deepEqual(checkRepeat({ key: 'x', count: 5, lastAt: 0, level: 0, heldAt: 0 }, 'X ', 10_000), { allowed: true, state: { key: 'x', count: 6, lastAt: 10_000, level: 1, heldAt: 10_000 } });
  assert.deepEqual(checkRepeat({ key: 'x', count: 1, lastAt: 0, level: 4, heldAt: 0 }, 'x', 29_999), { allowed: false, waitMs: 1 }, 'strict, level 4: 10 + 4·5 = 30 s');
  assert.equal(checkRepeat({ key: '', count: 0, lastAt: 0, level: 3, heldAt: 0 }, '   ', 1).allowed, true);
  assert.equal(repeatNotice(7), 'Одинаковое сообщение. Подожди 7 с.');
});

test('both senders ask before sending, and the text stays in the field', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const chat = read('../src/ChatScreen.tsx');
  assert.ok(chat.includes('if(out.text){const wait=repeatWait(chat.id,out.text);if(wait){toast(repeatNotice(wait));return;}}'));
  assert.ok(chat.indexOf('repeatWait(chat.id,out.text)') < chat.indexOf('if(replyTo){\n      const reply='), 'before any of the ways a text is sent');
  assert.ok(read('../src/communities/ChannelChat.tsx').includes('if (!editing) { const wait = repeatWait(`channel:${channel.id}`, value); if (wait) { setError(repeatNotice(wait)); return; } }'));
});
