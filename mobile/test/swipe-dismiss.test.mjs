import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const S = loadTs(new URL('../src/swipeDismissModel.ts', import.meta.url));

test('release past a quarter of the height closes; short of it springs back', () => {
  assert.equal(S.shouldDismiss(130, 0, 500), true);
  assert.equal(S.shouldDismiss(120, 0, 500), false);
  assert.equal(S.shouldDismiss(124, 200, 500), false);
});
test('a fast downward flick closes from a short distance; a flick back up keeps it open', () => {
  assert.equal(S.shouldDismiss(20, 1200, 600), true);
  assert.equal(S.shouldDismiss(20, 900, 600), false);
  assert.equal(S.shouldDismiss(400, -600, 600), false);
  assert.equal(S.shouldDismiss(4, 3000, 600), false); // a tap with a jitter is not a flick
});
test('never closes when not pulled down or on bad input', () => {
  assert.equal(S.shouldDismiss(0, 5000, 500), false);
  assert.equal(S.shouldDismiss(-30, 5000, 500), false);
  assert.equal(S.shouldDismiss(Number.NaN, 0, 500), false);
  assert.equal(S.shouldDismiss(300, Number.NaN, 500), true);
});
test('distance threshold is bounded for tiny popovers and tall full-screen views', () => {
  assert.equal(S.dismissDistance(100), S.MIN_DISMISS_DISTANCE);
  assert.equal(S.dismissDistance(2000), S.MAX_DISMISS_DISTANCE);
  assert.equal(S.dismissDistance(0), S.FALLBACK_HEIGHT * S.DISMISS_DISTANCE_RATIO); // not measured yet
  assert.equal(S.shouldDismiss(60, 0, 100), true);
  assert.equal(S.shouldDismiss(230, 0, 2000), false);
});
test('follows the finger down 1:1 and only a little up', () => {
  assert.equal(S.followFinger(80), 80);
  assert.equal(S.followFinger(0), 0);
  const up = S.followFinger(-500);
  assert.ok(up < 0 && up >= -S.RUBBER_LIMIT);
  assert.ok(S.followFinger(-10) > S.followFinger(-40));
  assert.equal(S.followFinger(Number.NaN), 0);
});
test('backdrop fades with the panel', () => {
  assert.equal(S.backdropOpacity(0, 400), 1);
  assert.equal(S.backdropOpacity(-10, 400), 1);
  assert.equal(S.backdropOpacity(200, 400), 0.5);
  assert.equal(S.backdropOpacity(900, 400), 0);
});
test('slides fully off screen, faster when flicked', () => {
  assert.ok(S.offscreenOffset(300, 800) > 800);
  assert.ok(S.offscreenOffset(0, 0) > 0);
  const slow = S.dismissDuration(100, 0, 900), fast = S.dismissDuration(100, 5000, 900);
  assert.ok(fast < slow && fast >= 120 && slow <= 280);
});
