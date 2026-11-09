import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const s = loadTs(new URL('../src/listSwipes.ts', import.meta.url), {});
const ALL = { markUnread: false, pin: true, archive: true };

test('axis lock: sideways twice as far as vertical, vertical wins ties, direction filter', () => {
  assert.equal(s.axisLock(5, 1), null);
  assert.equal(s.axisLock(20, 5), 'horizontal');
  assert.equal(s.axisLock(-20, 5), 'horizontal');
  assert.equal(s.axisLock(20, 12), null); // still undecided
  assert.equal(s.axisLock(20, 25), 'vertical');
  assert.equal(s.axisLock(15, 15), 'vertical');
  assert.equal(s.axisLock(20, 9), 'horizontal');
  assert.equal(s.axisLock(-20, 2, 1), 'wrong-way');
  assert.equal(s.axisLock(20, 2, 1), 'horizontal');
  assert.equal(s.axisLock(12, 0, 0, 14), null);
});

test('row actions follow Telegram: read/pin on the right swipe, archive · delete · mute on the left', () => {
  assert.deepEqual(s.rowActions({ unread: true, pinned: false, muted: false, archived: false }, ALL), { right: ['read', 'pin'], left: ['archive', 'delete', 'mute'] });
  assert.deepEqual(s.rowActions({ unread: false, pinned: true, muted: true, archived: true }, ALL), { right: ['unpin'], left: ['unarchive', 'delete', 'unmute'] });
  // With a server that can mark a chat unread, a read chat offers it as the leading action.
  assert.deepEqual(s.rowActions({ unread: false, pinned: false, muted: false, archived: false }, { ...ALL, markUnread: true }).right, ['unread', 'pin']);
  // Without pin/archive support those buttons are not offered.
  assert.deepEqual(s.rowActions({ unread: false, pinned: false, muted: false, archived: false }, { markUnread: false, pin: false, archive: false }), { right: [], left: ['delete', 'mute'] });
});

test('open width and the full-swipe distance stay apart', () => {
  assert.equal(s.openWidth(0), 0);
  assert.equal(s.openWidth(3), 3 * s.ROW_BUTTON + 4 * s.ROW_GAP);
  assert.equal(s.fullSwipeDistance(400, 100), 240);
  // On a narrow phone three buttons nearly fill 60%: the full swipe is pushed past them.
  const open = s.openWidth(3);
  assert.ok(s.fullSwipeDistance(320, open) >= open + 48);
});

test('row drag: no movement towards a side without buttons, resistance past 90%', () => {
  assert.equal(s.rowDrag(-50, 0, 100, 400), 0);
  assert.equal(s.rowDrag(50, 100, 0, 400), 0);
  assert.equal(s.rowDrag(-50, 100, 100, 400), -50);
  assert.equal(s.rowDrag(400, 100, 100, 400), 360 + 40 * 0.25);
});

test('row release: full swipe, open, flick, close', () => {
  const L = 224, R = 152, FL = 260, FR = 240;
  assert.equal(s.rowRelease(-270, 0, L, R, FL, FR), 'full-left');
  assert.equal(s.rowRelease(250, 0, L, R, FL, FR), 'full-right');
  assert.equal(s.rowRelease(-100, 0, L, R, FL, FR), 'open-left');
  assert.equal(s.rowRelease(-100, 600, L, R, FL, FR), 'close'); // flicked back
  assert.equal(s.rowRelease(-30, -800, L, R, FL, FR), 'open-left'); // flick towards the buttons
  assert.equal(s.rowRelease(-30, 0, L, R, FL, FR), 'close');
  assert.equal(s.rowRelease(70, 0, L, R, FL, FR), 'open-right');
  assert.equal(s.rowRelease(70, -600, L, R, FL, FR), 'close');
  assert.equal(s.rowRelease(-100, 0, 0, R, FL, FR), 'close');
});

test('pages: a quarter of the width or a flick turns one page, never past the ends', () => {
  assert.equal(s.pageRelease(0, 3, -120, 0, 400), 1);
  assert.equal(s.pageRelease(1, 3, 120, 0, 400), 0);
  assert.equal(s.pageRelease(1, 3, -50, 0, 400), 1);
  assert.equal(s.pageRelease(1, 3, -30, -900, 400), 2);
  assert.equal(s.pageRelease(1, 3, -200, 500, 400), 1); // flicked back
  assert.equal(s.pageRelease(2, 3, -300, -900, 400), 2);
  assert.equal(s.pageRelease(0, 3, 300, 900, 400), 0);
  assert.equal(s.pageRelease(0, 1, -300, 0, 400), 0);
});

test('page position follows the finger and resists past the ends', () => {
  assert.equal(s.pagePosition(1, 3, -200, 400), 1.5);
  assert.equal(s.pagePosition(1, 3, 200, 400), 0.5);
  assert.ok(Math.abs(s.pagePosition(0, 3, 200, 400) - -0.1) < 1e-9);
  assert.equal(s.pagePosition(1, 3, -2000, 400), 2);
});

test('search swipe-back closes past a third or on a flick, not when flicked back', () => {
  assert.equal(s.shouldClose(140, 0, 400), true);
  assert.equal(s.shouldClose(100, 0, 400), false);
  assert.equal(s.shouldClose(30, 900, 400), true);
  assert.equal(s.shouldClose(200, -400, 400), false);
});

test('archive row settles shown or hidden when a drag ends half way', () => {
  assert.equal(s.archiveSnap(0, 80), null);
  assert.equal(s.archiveSnap(80, 80), null);
  assert.equal(s.archiveSnap(200, 80), null);
  assert.equal(s.archiveSnap(-30, 80), null);
  assert.equal(s.archiveSnap(30, 80), 0);
  assert.equal(s.archiveSnap(50, 80), 80);
  assert.equal(s.archiveSnap(60, 80, -1), 0);
  assert.equal(s.archiveSnap(20, 80, 1), 80);
  assert.equal(s.archiveSnap(30, 0), null);
});
