import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepeatGuard, REPEAT_RESET_MS } from '../src/repeatguard.js';

// Communities: the same text over and over — five in a row, then 10 s, 15 s, 20 s… between copies; after that the
// next messages are held from their second copy; four hours later everything is as at the start.

test('five copies in a row pass; the sixth waits 10 s after the fifth, the seventh 15 s, the eighth 20 s', () => {
  let time = 0;
  const guard = createRepeatGuard(() => time);
  for (let i = 0; i < 5; i++) { time += 50; assert.equal(guard.wait('u', 'c', 'Привет'), 0); }
  time += 4_000; assert.equal(guard.wait('u', 'c', 'привет '), 6_000);
  time += 5_999; assert.equal(guard.wait('u', 'c', 'ПРИВЕТ'), 1);
  time += 1; assert.equal(guard.wait('u', 'c', 'привет'), 0);
  time += 14_999; assert.equal(guard.wait('u', 'c', 'привет'), 1);
  time += 1; assert.equal(guard.wait('u', 'c', 'привет'), 0);
  time += 19_999; assert.equal(guard.wait('u', 'c', 'привет'), 1);
});

test('before the limit another text starts the count again; another channel or person is not held', () => {
  let time = 0;
  const guard = createRepeatGuard(() => time);
  for (let i = 0; i < 4; i++) { time += 10; assert.equal(guard.wait('u', 'c', 'спам'), 0); }
  time += 10; assert.equal(guard.wait('u', 'c', 'не спам'), 0);
  for (let i = 0; i < 5; i++) { time += 10; assert.equal(guard.wait('u', 'c', 'спам'), 0); }
  time += 10; assert.ok(guard.wait('u', 'c', 'спам') > 0);
  assert.equal(guard.wait('u', 'other-channel', 'спам'), 0);
  assert.equal(guard.wait('someone-else', 'c', 'спам'), 0);
});

test('after the limit the next message is held from its second copy and the wait goes on growing; four hours after the first held copy reset it', () => {
  let time = 0;
  const guard = createRepeatGuard(() => time);
  for (let i = 0; i < 5; i++) { time += 10; assert.equal(guard.wait('u', 'c', 'спам'), 0); }
  time += 10_000; assert.equal(guard.wait('u', 'c', 'спам'), 0);
  const heldAt = time;
  time += 10; assert.equal(guard.wait('u', 'c', 'другое'), 0);
  time += 1_000; assert.equal(guard.wait('u', 'c', 'другое'), 14_000, 'the second copy: 15 s, the wait continues');
  time += 10; assert.equal(guard.wait('u', 'c', ''), 0, 'a file without a caption');
  time += 10; assert.equal(guard.wait('u', 'c', 'другое'), 0, 'a first copy again');
  time += 1_000; assert.equal(guard.wait('u', 'c', 'другое'), 14_000, 'still strict');
  for (const text of ['раз', 'два', 'три']) { time += 10; assert.equal(guard.wait('u', 'c', text), 0); }
  // Three hours in, a held copy goes out: the four hours still run from the first one.
  time = heldAt + 3 * 3_600_000; assert.equal(guard.wait('u', 'c', 'три'), 0);
  time = heldAt + REPEAT_RESET_MS - 1; assert.equal(guard.wait('u', 'c', 'четыре'), 0); assert.ok(guard.wait('u', 'c', 'четыре') > 0, 'still strict');
  time = heldAt + REPEAT_RESET_MS;
  for (let i = 0; i < 5; i++) { time += 10; assert.equal(guard.wait('u', 'c', 'три'), 0, 'five in a row again'); }
  time += 1_000; assert.equal(guard.wait('u', 'c', 'три'), 9_000, 'and the wait starts from 10 s');
});
