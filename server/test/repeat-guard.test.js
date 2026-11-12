import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepeatGuard, REPEAT_FORGET_MS } from '../src/repeatguard.js';

// Communities: the same text over and over — five in a row, then 10 s, 15 s, 20 s… between copies.

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

test('another text, another channel, another person, a file without text and a long pause are not held', () => {
  let time = 0;
  const guard = createRepeatGuard(() => time);
  const flood = (who, where) => { for (let i = 0; i < 5; i++) { time += 10; assert.equal(guard.wait(who, where, 'спам'), 0); } time += 10; };
  flood('u', 'c');
  assert.ok(guard.wait('u', 'c', 'спам') > 0);
  assert.equal(guard.wait('u', 'other-channel', 'спам'), 0);
  assert.equal(guard.wait('someone-else', 'c', 'спам'), 0);
  assert.equal(guard.wait('u', 'c', 'не спам'), 0, 'a different message');
  flood('u', 'c');
  assert.ok(guard.wait('u', 'c', 'спам') > 0);
  assert.equal(guard.wait('u', 'c', ''), 0, 'a file without a caption');
  assert.equal(guard.wait('u', 'c', 'спам'), 0, 'the run was broken');
  flood('u', 'x'); assert.ok(guard.wait('u', 'x', 'спам') > 0);
  time += REPEAT_FORGET_MS; assert.equal(guard.wait('u', 'x', 'спам'), 0);
});
