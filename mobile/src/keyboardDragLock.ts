// Telegram iOS: with the keyboard open, a drag down on the chat only takes the keyboard down (interactive
// dismiss) — the messages do not scroll back through history while it happens. The list keeps its scroll
// offset; it grows as the keyboard goes down (the screen above the keyboard gets taller) and the newest
// message stays right above the composer, which follows the keyboard. Once the keyboard is fully down, the
// same drag scrolls the list as usual.
//
// The chat list is INVERTED: offset 0 is the newest message, a drag down (finger moving down, towards older
// messages) makes the offset grow. Only that direction is held; a drag up (towards newer messages) scrolls
// as always, and the held offset follows it so a drag back down stops there.
//
// Everything here runs as Reanimated worklets inside the list's scroll handler (UI thread, every frame), so
// these are plain functions over plain values. The scroll handler stores the returned state.

/** No drag held / finger down, held / finger lifted, waiting to see if momentum follows / momentum, held. */
export type DragLockPhase = 'idle' | 'drag' | 'lifted' | 'momentum';
export type DragLock = { phase: DragLockPhase; y: number; at: number };

/** Keyboard progress (0 hidden … 1 open) under which it counts as down. */
export const KEYBOARD_DOWN = 0.01;
/** After the finger lifts with no momentum, the hold ends this long after (ms): scrolls past it are the app's own. */
export const LIFT_SETTLE_MS = 120;

export const DRAG_UNLOCKED: DragLock = { phase: 'idle', y: 0, at: 0 };

/** Finger down on the list: hold the offset if the keyboard is (even partly) up. */
export function dragLockBegin(keyboardProgress: number, y: number): DragLock {
  'worklet';
  return keyboardProgress > KEYBOARD_DOWN ? { phase: 'drag', y: Math.max(0, y), at: 0 } : DRAG_UNLOCKED;
}

/** Finger up. While held, wait a moment for momentum; otherwise nothing to do. */
export function dragLockEnd(lock: DragLock, now: number): DragLock {
  'worklet';
  return lock.phase === 'drag' ? { phase: 'lifted', y: lock.y, at: now } : lock;
}

/** Momentum after a held drag (a fling that dismissed the keyboard) is held too, until it ends. */
export function dragLockMomentumBegin(lock: DragLock): DragLock {
  'worklet';
  return lock.phase === 'lifted' || lock.phase === 'drag' ? { phase: 'momentum', y: lock.y, at: lock.at } : lock;
}

export function dragLockMomentumEnd(lock: DragLock): DragLock {
  'worklet';
  return lock.phase === 'momentum' ? DRAG_UNLOCKED : lock;
}

/**
 * A scroll event. `restore` is the offset to put the list back to (null: leave the scroll alone).
 * `maxY` is the furthest offset the list can rest at now (content minus viewport); the held offset never
 * goes past it, so a list that got taller than its content does not stay overscrolled.
 */
export function dragLockScroll(lock: DragLock, y: number, keyboardProgress: number, now: number, maxY: number): { lock: DragLock; restore: number | null } {
  'worklet';
  if (lock.phase === 'idle') return { lock, restore: null };
  // The keyboard is fully down while the finger is still on the list: from here on the drag scrolls.
  if (lock.phase === 'drag' && keyboardProgress <= KEYBOARD_DOWN) return { lock: DRAG_UNLOCKED, restore: null };
  // Finger lifted and no momentum came: whatever scrolls now (scroll to the bottom, a reply jump) is not ours.
  if (lock.phase === 'lifted' && now - lock.at > LIFT_SETTLE_MS) return { lock: DRAG_UNLOCKED, restore: null };
  const held = Math.min(lock.y, Math.max(0, maxY));
  // Towards newer messages: scroll as usual, and hold from there.
  if (y <= held) return { lock: { phase: lock.phase, y, at: lock.at }, restore: null };
  return { lock: held === lock.y ? lock : { phase: lock.phase, y: held, at: lock.at }, restore: held };
}

export type KeyboardDismissSetup = {
  /** ScrollView keyboardDismissMode. */
  mode: 'interactive' | 'on-drag' | 'none';
  /** Wrap the list in keyboard-controller's KeyboardGestureArea (Android 11+: the keyboard follows the finger). */
  gestureArea: boolean;
};

/**
 * iOS: the system interactive dismiss (the keyboard follows the finger once it reaches the composer, see
 * keyboardGestureOffset). Android 11+: keyboard-controller's KeyboardGestureArea does the same; the list
 * must not also dismiss on drag. Older Android: dismiss on drag (the offset hold keeps the messages still).
 */
export function keyboardDismissSetup(os: string, version: number | string): KeyboardDismissSetup {
  if (os === 'ios') return { mode: 'interactive', gestureArea: true };
  if (os === 'android') return Number(version) >= 30 ? { mode: 'none', gestureArea: true } : { mode: 'on-drag', gestureArea: false };
  return { mode: 'none', gestureArea: false };
}

/** Composer taller than this (a big reply bar + many lines) still lets the keyboard follow from here. */
export const MAX_GESTURE_OFFSET = 260;

/**
 * How far above the keyboard the finger starts dragging it (Telegram: from the top of the input panel).
 * The emoji panel is part of the composer block but is not above the keyboard: no offset while it is open.
 */
export function keyboardGestureOffset(composer: number, stickers: boolean): number {
  if (stickers || !Number.isFinite(composer) || composer <= 0) return 0;
  return Math.min(Math.ceil(composer), MAX_GESTURE_OFFSET);
}
