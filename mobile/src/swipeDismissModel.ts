/**
 * Swipe-down-to-dismiss, Telegram-style: the decisions only (no React Native here, so it runs in
 * Node tests). Every function is a worklet too: the gesture calls them on the UI thread.
 */

/** Past this share of the panel's height the release closes it. */
export const DISMISS_DISTANCE_RATIO = 0.25;
/** A downward flick this fast (px/s, as Gesture Handler reports it) closes from any distance. */
export const DISMISS_FLICK_VELOCITY = 1000;
/** A flick back up this fast keeps the panel open even past the distance threshold. */
export const KEEP_VELOCITY = -400;
/** The distance threshold never drops below this (a tiny popover would close on a twitch). */
export const MIN_DISMISS_DISTANCE = 56;
/** …and never asks for more than this on a tall full-screen view. */
export const MAX_DISMISS_DISTANCE = 240;
/** Height assumed before the panel has been measured. */
export const FALLBACK_HEIGHT = 400;
/** How far the panel may be pulled up (rubber band) before it stops. */
export const RUBBER_LIMIT = 14;

const known = (height: number) => { 'worklet'; return height > 0 ? height : FALLBACK_HEIGHT; };

/** The distance a release must reach to close a panel of this height. */
export function dismissDistance(height: number): number {
  'worklet';
  return Math.min(MAX_DISMISS_DISTANCE, Math.max(MIN_DISMISS_DISTANCE, known(height) * DISMISS_DISTANCE_RATIO));
}

/** On release: close (true) or spring back (false). `dy` is how far the panel is down, `vy` the finger's speed (px/s, down is positive). */
export function shouldDismiss(dy: number, vy: number, height: number): boolean {
  'worklet';
  if (!(dy > 0) || !Number.isFinite(dy)) return false;
  const speed = Number.isFinite(vy) ? vy : 0;
  if (speed <= KEEP_VELOCITY) return false;
  if (speed >= DISMISS_FLICK_VELOCITY && dy >= 8) return true;
  return dy >= dismissDistance(height);
}

/** Where the panel sits for a finger travel `dy`: follows it down 1:1, up only a little, with resistance. */
export function followFinger(dy: number): number {
  'worklet';
  if (!Number.isFinite(dy)) return 0;
  if (dy >= 0) return dy;
  return -RUBBER_LIMIT * (1 - Math.exp(dy / (RUBBER_LIMIT * 3)));
}

/** Backdrop opacity (0…1) while the panel is `dy` down: fades out as it leaves. */
export function backdropOpacity(dy: number, height: number): number {
  'worklet';
  if (!(dy > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - dy / known(height)));
}

/** Where the panel goes when it closes: fully below its own bottom edge. */
export function offscreenOffset(height: number, screenHeight: number): number {
  'worklet';
  return Math.max(known(height), screenHeight > 0 ? screenHeight : 0) + 24;
}

/** Duration (ms) of the slide out from `dy` to `target`, faster when flicked. */
export function dismissDuration(dy: number, vy: number, target: number): number {
  'worklet';
  const left = Math.max(0, target - Math.max(0, dy));
  const speed = Math.max(1200, Number.isFinite(vy) ? vy : 0);
  return Math.round(Math.max(120, Math.min(280, (left / speed) * 1000)));
}
