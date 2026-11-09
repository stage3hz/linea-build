import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const { DISMISS_DISTANCE, DISMISS_VELOCITY, shouldDismiss, dismissProgress, backSwipeIntent, shouldGoBack, storyAxis, storySwipe, rubberBand } = loadTs(new URL('../src/media/swipeMath.ts', import.meta.url));

test('a viewer closes when pulled far enough up or down, or flicked, but not on a flick back', () => {
  assert.equal(shouldDismiss(DISMISS_DISTANCE + 1, 0), true);
  assert.equal(shouldDismiss(-(DISMISS_DISTANCE + 1), 0), true);
  assert.equal(shouldDismiss(40, 0), false);
  assert.equal(shouldDismiss(30, DISMISS_VELOCITY + 1), true);
  assert.equal(shouldDismiss(-30, -(DISMISS_VELOCITY + 1)), true);
  // Pulled down then flicked back up: the person changed their mind.
  assert.equal(shouldDismiss(DISMISS_DISTANCE + 40, -DISMISS_VELOCITY), false);
  assert.equal(shouldDismiss(30, -(DISMISS_VELOCITY + 1)), false);
  assert.equal(shouldDismiss(NaN, 0), false);
});

test('the drag progress grows to 1 at half the screen either way and survives a zero size', () => {
  assert.equal(dismissProgress(0, 800), 0);
  assert.equal(dismissProgress(200, 800), 0.5);
  assert.equal(dismissProgress(-400, 800), 1);
  assert.equal(dismissProgress(2000, 800), 1);
  assert.equal(dismissProgress(100, 0), 0);
});

test('a full-width back swipe takes a mostly sideways move to the right and leaves vertical scrolling alone', () => {
  assert.equal(backSwipeIntent(4, 1), 'wait');
  assert.equal(backSwipeIntent(24, 6), 'activate');
  assert.equal(backSwipeIntent(24, 14), 'wait'); // not 2:1 yet, not clearly vertical either
  assert.equal(backSwipeIntent(8, 30), 'fail');
  assert.equal(backSwipeIntent(-12, 0), 'fail');
  assert.equal(backSwipeIntent(11, -40), 'fail');
});

test('a released back swipe leaves past a third of the width or on a flick, not on a flick back', () => {
  assert.equal(shouldGoBack(150, 0, 390), true);
  assert.equal(shouldGoBack(60, 900, 390), true);
  assert.equal(shouldGoBack(60, 100, 390), false);
  assert.equal(shouldGoBack(200, -400, 390), false);
});

test('stories: left / right turn the page, down closes, up replies, short drags spring back', () => {
  const width = 400;
  assert.equal(storyAxis(30, 10), 'x'); assert.equal(storyAxis(5, -20), 'y');
  assert.equal(storySwipe({ axis: 'x', tx: -150, ty: 0, vx: 0, vy: 0, width }), 'next');
  assert.equal(storySwipe({ axis: 'x', tx: 150, ty: 0, vx: 0, vy: 0, width }), 'previous');
  assert.equal(storySwipe({ axis: 'x', tx: -30, ty: 0, vx: -800, vy: 0, width }), 'next');
  assert.equal(storySwipe({ axis: 'x', tx: -40, ty: 0, vx: 0, vy: 0, width }), 'cancel');
  assert.equal(storySwipe({ axis: 'x', tx: -150, ty: 0, vx: 500, vy: 0, width }), 'cancel'); // flicked back
  assert.equal(storySwipe({ axis: 'y', tx: 0, ty: 200, vx: 0, vy: 0, width }), 'close');
  assert.equal(storySwipe({ axis: 'y', tx: 0, ty: 40, vx: 0, vy: 1200, width }), 'close');
  assert.equal(storySwipe({ axis: 'y', tx: 0, ty: 40, vx: 0, vy: 0, width }), 'cancel');
  assert.equal(storySwipe({ axis: 'y', tx: 0, ty: -80, vx: 0, vy: 0, width }), 'up');
  assert.equal(storySwipe({ axis: 'y', tx: 0, ty: -20, vx: 0, vy: -600, width }), 'up');
  assert.equal(storySwipe({ axis: 'y', tx: 0, ty: -20, vx: 0, vy: 0, width }), 'cancel');
});

test('past an edge with nothing beyond, the page moves a third as far', () => {
  assert.equal(rubberBand(-90, true), -90);
  assert.equal(rubberBand(-90, false), -30);
});
