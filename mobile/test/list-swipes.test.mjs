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

test('the chat list offers «Непрочитано» on a read chat (a device-local mark) and «Прочитано» on an unread one', () => {
  const LIST = { markUnread: true, pin: true, archive: true };
  assert.deepEqual(s.rowActions({ unread: false, pinned: false, muted: false, archived: false }, LIST).right, ['unread', 'pin']);
  assert.deepEqual(s.rowActions({ unread: true, pinned: true, muted: false, archived: false }, LIST).right, ['read', 'unpin']);
});

test('back swipe over a strip: a scrolled strip keeps a rightward drag, its start or the edge does not', () => {
  assert.equal(s.stripBlocksBack(true, 120, 200), true, 'scrolled strip, finger in the middle');
  assert.equal(s.stripBlocksBack(true, 0, 200), false, 'the strip at its start: nothing to scroll back');
  assert.equal(s.stripBlocksBack(true, 0.5, 200), false, 'sub-point offsets count as the start');
  assert.equal(s.stripBlocksBack(true, 120, 10), false, 'from the edge the back swipe always wins');
  assert.equal(s.stripBlocksBack(true, 120, s.BACK_EDGE), false);
  assert.equal(s.stripBlocksBack(false, 120, 200), false, 'the finger is not on the strip');
});

// Regression: after one chat row's swipe buttons had been opened, every later tap on a chat only
// «closed» that row (the slot was never released) and no 1:1 chat opened until the app was restarted.
test('open row slot: a closed or removed row frees the slot, so the next tap opens the chat', () => {
  const slot = s.openRowSlot();
  const row = () => { const r = { closed: 0, close: () => { r.closed++; slot.release(r.close); } }; return r; };
  assert.equal(slot.closeOpen(), false); // nothing open: the tap goes to the chat
  const a = row(), b = row();
  slot.open(a.close);
  assert.equal(slot.closeOpen(), true); // the tap only closes the open row
  assert.equal(a.closed, 1);
  assert.equal(slot.closeOpen(), false); // and the next tap opens the chat
  // The row closes itself (a button, a swipe back, a tap on it).
  slot.open(a.close); a.close();
  assert.equal(slot.closeOpen(), false);
  // The row leaves the screen with its buttons open (another tab, scrolled away).
  slot.open(a.close); slot.release(a.close);
  assert.equal(slot.closeOpen(), false);
  // One at a time: opening or dragging another row closes the open one; a row never closes itself by that.
  slot.open(a.close); slot.open(b.close);
  assert.equal(a.closed, 3);
  slot.closeOthers(b.close); assert.equal(b.closed, 0);
  slot.closeOthers(a.close); assert.equal(b.closed, 1);
  assert.equal(slot.closeOpen(), false);
  // Another row's function does not release the slot.
  slot.open(a.close); slot.release(b.close);
  assert.equal(slot.closeOpen(), true);
  // Even a row that never releases takes one tap at most.
  let stale = 0; slot.open(() => { stale++; });
  assert.equal(slot.closeOpen(), true); assert.equal(slot.closeOpen(), false); assert.equal(stale, 1);
});

test('chat list rows take and release the open-row slot with one stable function', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/ChatListScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /const closeHandle=useRef\(\(\)=>closeSelf\.current\(\)\)\.current;/);
  assert.match(source, /openRows\.open\(closeHandle\)/);
  assert.equal(source.match(/openRows\.release\(closeHandle\)/g)?.length, 2); // on close and on unmount
  assert.doesNotMatch(source, /openRows\.(open|release|closeOthers)\((?!closeHandle\))/);
});

// The user's steps: swipe a chat right (buttons open), close, swipe again — the second time the row
// sprang shut at once (opening it «closed the other open row», which was itself), and after a few
// rounds taps on chats did nothing.
test('open row slot: the same row opens again and again, then a tap opens the chat', () => {
  const slot = s.openRowSlot();
  let closed = 0; const close = () => { closed++; slot.release(close); };
  for (let round = 0; round < 5; round++) {
    slot.closeOthers(close); // the drag starts on this row
    slot.open(close);        // released past the open point
    assert.equal(closed, round, 'opening a row does not close that same row');
    slot.closeOthers(close); slot.open(close); // dragged again while open: still open
    assert.equal(closed, round);
    close();                 // tapped shut / a button pressed
  }
  assert.equal(slot.closeOpen(), false); // the next tap on a chat opens it
  assert.equal(closed, 5);
});

test('a chat row gives a drag from its middle to the folder pager and keeps a drag from its edge', () => {
  const W = 393, edge = Math.max(s.ROW_EDGE_MIN, W * s.ROW_EDGE);
  // Folders both ways: the buttons are pulled out from the edge they hide behind.
  assert.equal(s.rowClaimsSwipe(W - 10, W, -30, false, true, true), true, 'leftward from the right edge: the row');
  assert.equal(s.rowClaimsSwipe(W / 2, W, -30, false, true, true), false, 'leftward from the middle: next folder');
  assert.equal(s.rowClaimsSwipe(20, W, -30, false, true, true), false, 'leftward from the left edge: next folder');
  assert.equal(s.rowClaimsSwipe(20, W, 30, false, true, true), true, 'rightward from the left edge: the row');
  assert.equal(s.rowClaimsSwipe(W / 2, W, 30, false, true, true), false, 'rightward from the middle: previous folder');
  assert.equal(s.rowClaimsSwipe(W - 10, W, 30, false, true, true), false);
  assert.equal(s.rowClaimsSwipe(W - edge, W, -30, false, true, true), true, 'the zone includes its border');
  assert.equal(s.rowClaimsSwipe(W - edge - 1, W, -30, false, true, true), false);
  // An open row always follows the finger, wherever it is touched.
  assert.equal(s.rowClaimsSwipe(W / 2, W, 30, true, true, true), true);
  assert.equal(s.rowClaimsSwipe(W / 2, W, -30, true, true, true), true);
  // No folder that way (first / last folder, or no folders at all): the whole row is the row's, as before.
  assert.equal(s.rowClaimsSwipe(W / 2, W, 30, false, false, true), true);
  assert.equal(s.rowClaimsSwipe(W / 2, W, -30, false, true, false), true);
  assert.equal(s.rowClaimsSwipe(W / 2, W, -30, false, false, false), true);
  assert.equal(s.rowClaimsSwipe(W / 2, W, 0, false, true, true), false, 'no direction yet');
  assert.ok(edge >= 72 && edge <= W / 3, 'an edge zone a thumb can hit, the middle stays the larger part');
});
