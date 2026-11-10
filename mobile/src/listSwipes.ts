// Telegram-style swipe decisions for the chat list, folder tabs, shared media tabs and the search
// screen (pure, covered by test/list-swipes.test.mjs). Every function is a worklet so the gesture
// handlers can call it on the UI thread; nothing here imports React Native.

/** Movement (pt) before a direction is decided. */
export const SLOP = 10;

/**
 * Direction lock as in Telegram-iOS: a pan becomes horizontal once the finger has moved sideways
 * past the slop and at least twice as far as up/down; a clearly vertical move is a scroll.
 * `direction` limits which way counts (1 = right only, -1 = left only, 0 = both).
 */
// No default parameter may name a module constant in a worklet: the worklets Babel plugin moves the
// constant into `const {…} = this.__closure` inside the body, which a default (evaluated in the
// parameter scope, before the body) cannot see. On the UI thread that is a ReferenceError, and in a
// release build a worklet error is fatal (the app closed on the first finger move in the profile).
export function axisLock(dx: number, dy: number, direction: -1 | 0 | 1 = 0, slopOverride?: number): 'horizontal' | 'vertical' | 'wrong-way' | null {
  'worklet';
  const slop = slopOverride === undefined ? SLOP : slopOverride;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ay > slop && ay >= ax) return 'vertical';
  if (ax > slop && ax > ay * 2) return direction !== 0 && Math.sign(dx) !== direction ? 'wrong-way' : 'horizontal';
  return null;
}

// ─── Chat row actions ────────────────────────────────────────────────────────────────────────────

export type RowAction = 'read' | 'unread' | 'pin' | 'unpin' | 'mute' | 'unmute' | 'delete' | 'archive' | 'unarchive';
export type RowState = { unread: boolean; pinned: boolean; muted: boolean; archived: boolean };
export type RowSupport = { markUnread: boolean; pin: boolean; archive: boolean };

/**
 * The buttons behind a chat row, leading (outermost, performed by a full swipe) first.
 * Right swipe (buttons on the left): read/unread, pin. Left swipe (buttons on the right): archive,
 * delete, mute — Telegram shows them as «Mute · Delete · Archive» with Archive at the edge.
 */
export function rowActions(state: RowState, support: RowSupport): { right: RowAction[]; left: RowAction[] } {
  'worklet';
  const right: RowAction[] = [];
  if (state.unread) right.push('read');
  else if (support.markUnread) right.push('unread');
  if (support.pin) right.push(state.pinned ? 'unpin' : 'pin');
  const left: RowAction[] = [];
  if (support.archive) left.push(state.archived ? 'unarchive' : 'archive');
  left.push('delete', state.muted ? 'unmute' : 'mute');
  return { right, left };
}

export const ROW_BUTTON = 64;
export const ROW_GAP = 8;
/** How far the row slides to show `count` buttons. */
export function openWidth(count: number): number {
  'worklet';
  return count > 0 ? count * ROW_BUTTON + (count + 1) * ROW_GAP : 0;
}
/** A full swipe: 60% of the row, but always clearly past the open position. */
export function fullSwipeDistance(width: number, open: number): number {
  'worklet';
  return Math.max(width * 0.6, open + 48);
}

/**
 * Row offset while dragging (negative = slid left). A side without buttons does not move; with
 * buttons the row follows the finger up to a full swipe and then resists.
 */
export function rowDrag(raw: number, leftOpen: number, rightOpen: number, width: number): number {
  'worklet';
  if (raw < 0 && leftOpen === 0) return 0;
  if (raw > 0 && rightOpen === 0) return 0;
  const limit = Math.max(width * 0.9, 1);
  const a = Math.abs(raw);
  const v = a <= limit ? a : limit + (a - limit) * 0.25;
  return Math.sign(raw) * v;
}

export type RowRelease = 'full-left' | 'full-right' | 'open-left' | 'open-right' | 'close';
/**
 * Where a released row goes. `x` is the row offset, `velocity` the finger's (pt/s), `fullLeft` /
 * `fullRight` the full-swipe distances (0 = that side has no buttons).
 */
export function rowRelease(x: number, velocity: number, leftOpen: number, rightOpen: number, fullLeft: number, fullRight: number): RowRelease {
  'worklet';
  if (x < 0 && leftOpen > 0) {
    if (-x >= fullLeft) return 'full-left';
    // Open when dragged far enough and not flicked back, or flicked towards the buttons.
    if ((-x > leftOpen * 0.4 && velocity < 400) || velocity < -500) return 'open-left';
    return 'close';
  }
  if (x > 0 && rightOpen > 0) {
    if (x >= fullRight) return 'full-right';
    if ((x > rightOpen * 0.4 && velocity > -400) || velocity > 500) return 'open-right';
    return 'close';
  }
  return 'close';
}

// ─── Pages (chat folders, shared media tabs) ─────────────────────────────────────────────────────

export const PAGE_FRACTION = 0.25;
export const PAGE_VELOCITY = 600;

/** Fractional page index while dragging; past the first/last page it moves with resistance. */
export function pagePosition(index: number, count: number, translation: number, width: number): number {
  'worklet';
  if (!(width > 0) || count <= 0) return index;
  let p = index - translation / width;
  const last = count - 1;
  if (p < 0) p = p * 0.2;
  else if (p > last) p = last + (p - last) * 0.2;
  return Math.max(index - 1, Math.min(index + 1, p));
}

/** The page after release: a quarter of the width or a flick turns one page, never past the ends. */
export function pageRelease(index: number, count: number, translation: number, velocity: number, width: number): number {
  'worklet';
  if (count <= 1 || !(width > 0)) return index;
  const flickBack = translation !== 0 && Math.sign(velocity) !== Math.sign(translation) && Math.abs(velocity) > PAGE_VELOCITY / 2;
  let step = 0;
  if (!flickBack && (Math.abs(translation) > width * PAGE_FRACTION || Math.abs(velocity) > PAGE_VELOCITY)) step = translation < 0 || (translation === 0 && velocity < 0) ? 1 : -1;
  return Math.max(0, Math.min(count - 1, index + step));
}

// ─── Swipe right to close (search) ───────────────────────────────────────────────────────────────

/** Same thresholds as the stack's swipe-back (src/stack.tsx): a third of the width or a flick. */
export function shouldClose(translation: number, velocity: number, width: number): boolean {
  'worklet';
  if (velocity < -300) return false;
  return translation > width * 0.33 || velocity > 700;
}

// ─── Back swipe over a horizontal strip ──────────────────────────────────────────────────────────

/** Touches this close to the left edge always start the back swipe, as the system edge gesture does. */
export const BACK_EDGE = 28;

/**
 * A full-width back swipe (profile, search) must not take a rightward drag that starts on a
 * horizontal strip (shared media tabs, search scopes) still scrolled away from its start: that drag
 * scrolls the strip back. At the strip's start, or from the screen edge, the back swipe goes ahead
 * (Telegram). `touching`: the finger went down on the strip; `offset`: its scroll position;
 * `startX`: where the finger went down, from the screen's left edge.
 */
export function stripBlocksBack(touching: boolean, offset: number, startX: number, edgeOverride?: number): boolean {
  'worklet';
  const edge = edgeOverride === undefined ? BACK_EDGE : edgeOverride; // not a default parameter: see axisLock
  return touching && offset > 1 && startX > edge;
}

// ─── Archive row hidden above the list ───────────────────────────────────────────────────────────

/**
 * Telegram keeps «Архив» above the first chat, out of sight until the list is pulled down. When a
 * drag ends with the row half visible it settles: shown if most of it is out or the finger pulled
 * down, hidden otherwise. Returns the offset to scroll to, or null to leave the list alone.
 */
export function archiveSnap(offset: number, rowHeight: number, velocityY = 0): number | null {
  if (!(rowHeight > 0) || offset <= 0 || offset >= rowHeight) return null;
  // velocityY < 0: the finger moved down (content pulled down, revealing the row).
  if (velocityY < -0.3) return 0;
  if (velocityY > 0.3) return rowHeight;
  return offset < rowHeight / 2 ? 0 : rowHeight;
}
