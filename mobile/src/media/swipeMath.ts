// Telegram-style swipe decisions for the full-screen viewers (pure, covered by test/viewer-swipes.test.mjs).
// Every function is a worklet so the gesture handlers can call it on the UI thread.

/** Pulled this far (pt) up or down, a viewer closes when the finger lifts. */
export const DISMISS_DISTANCE = 120;
/** A flick this fast (pt/s) closes it from any distance. */
export const DISMISS_VELOCITY = 900;
/** Sideways: a quarter of the screen, or a flick, turns to the next / previous page. */
export const PAGE_FRACTION = 0.25;
export const PAGE_VELOCITY = 600;
/** Movement (pt) before a direction is decided. */
export const SLOP = 10;

/**
 * Swipe up or down to close (photo/video viewers). A flick back towards the middle does not close
 * even past the distance: the person changed their mind, as in Telegram.
 */
export function shouldDismiss(translation: number, velocity: number): boolean {
  'worklet';
  if (!Number.isFinite(translation) || !Number.isFinite(velocity)) return false;
  const flickBack = translation !== 0 && Math.sign(velocity) !== Math.sign(translation) && Math.abs(velocity) > DISMISS_VELOCITY / 2;
  if (Math.abs(translation) > DISMISS_DISTANCE && !flickBack) return true;
  return Math.abs(velocity) > DISMISS_VELOCITY && (translation === 0 || Math.sign(velocity) === Math.sign(translation));
}

/** 0 … 1: how far the drag has gone towards closing (drives the backdrop fade and the shrink). */
export function dismissProgress(translation: number, size: number): number {
  'worklet';
  if (!Number.isFinite(translation) || !(size > 0)) return 0;
  return Math.min(1, Math.abs(translation) / (size / 2));
}

/**
 * Direction lock for a back swipe started anywhere on the screen (the same rule as src/stack.tsx):
 * take over once the finger moved right and mostly sideways (2:1); give up on a move to the left or
 * a clearly vertical one (scrolling) so the content keeps it.
 */
export function backSwipeIntent(dx: number, dy: number): 'activate' | 'fail' | 'wait' {
  'worklet';
  const ady = Math.abs(dy);
  if (dx > SLOP && dx > ady * 2) return 'activate';
  if (dx < -SLOP || (ady > SLOP && ady >= dx)) return 'fail';
  return 'wait';
}

/** Whether a released back swipe leaves the screen (a third of the width, or a flick). */
export function shouldGoBack(translationX: number, velocityX: number, width: number): boolean {
  'worklet';
  if (velocityX < -200) return false;
  return translationX > width * 0.33 || velocityX > 700;
}

export type StoryAxis = 'x' | 'y';
/** The axis a story drag locks to once it has moved past the slop: the larger component wins. */
export function storyAxis(dx: number, dy: number): StoryAxis {
  'worklet';
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

export type StoryAction = 'next' | 'previous' | 'close' | 'up' | 'cancel';
/**
 * Telegram stories: drag left for the next story (or post), right for the previous one, down to close,
 * up for the reply / the viewers list. A short or reversed drag springs back.
 */
export function storySwipe({ axis, tx, ty, vx, vy, width }: { axis: StoryAxis; tx: number; ty: number; vx: number; vy: number; width: number }): StoryAction {
  'worklet';
  if (axis === 'x') {
    const far = Math.abs(tx) > width * PAGE_FRACTION, fast = Math.abs(vx) > PAGE_VELOCITY;
    if (tx === 0 || !(far || fast)) return 'cancel';
    // A flick back against the drag cancels it.
    if (Math.abs(vx) > PAGE_VELOCITY / 2 && Math.sign(vx) !== Math.sign(tx)) return 'cancel';
    return tx < 0 ? 'next' : 'previous';
  }
  if (ty > 0 && shouldDismiss(ty, vy)) return 'close';
  if (ty < -60 || (ty < 0 && vy < -DISMISS_VELOCITY / 2)) return 'up';
  return 'cancel';
}

/** Following the finger past an edge with nothing beyond it: the page moves a third as far (rubber band). */
export function rubberBand(translation: number, open: boolean): number {
  'worklet';
  return open ? translation : translation / 3;
}
