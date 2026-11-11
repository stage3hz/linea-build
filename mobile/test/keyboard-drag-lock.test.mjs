import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { navInsetShown } from '../src/chatLayout.ts';
import { DRAG_UNLOCKED, KEYBOARD_DOWN, LIFT_SETTLE_MS, MAX_GESTURE_OFFSET, dragLockBegin, dragLockEnd, dragLockMomentumBegin, dragLockMomentumEnd, dragLockScroll, keyboardDismissSetup, keyboardGestureOffset } from '../src/keyboardDragLock.ts';

const src = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const BIG = 1e6; // plenty of history above

test('keyboard down: a drag is never held, the list scrolls as before', () => {
  const lock = dragLockBegin(0, 500);
  assert.deepEqual(lock, DRAG_UNLOCKED);
  assert.equal(dragLockScroll(lock, 900, 0, 0, BIG).restore, null);
  assert.deepEqual(dragLockBegin(KEYBOARD_DOWN / 2, 500), DRAG_UNLOCKED);
});

test('keyboard up + drag down (towards older messages): the offset is put back every frame', () => {
  let lock = dragLockBegin(1, 120);
  assert.equal(lock.phase, 'drag');
  for (const y of [130, 180, 400, 2000]) {
    const step = dragLockScroll(lock, y, 0.6, 0, BIG);
    assert.equal(step.restore, 120, `scroll to ${y} is undone`);
    lock = step.lock;
  }
  // Bounce / offset already where it was: nothing to do.
  assert.equal(dragLockScroll(lock, 120, 0.5, 0, BIG).restore, null);
});

test('a drag up (towards newer messages) scrolls as usual and the hold follows it', () => {
  let lock = dragLockBegin(1, 300);
  let step = dragLockScroll(lock, 250, 1, 0, BIG);
  assert.equal(step.restore, null);
  lock = step.lock;
  assert.equal(lock.y, 250);
  step = dragLockScroll(lock, 280, 1, 0, BIG);
  assert.equal(step.restore, 250, 'back down: held where the drag up ended');
});

test('once the keyboard is fully down under the finger, further dragging scrolls normally', () => {
  let lock = dragLockBegin(1, 0);
  let step = dragLockScroll(lock, 40, 0.3, 0, BIG);
  assert.equal(step.restore, 0);
  lock = step.lock;
  step = dragLockScroll(lock, 60, 0, 0, BIG);
  assert.equal(step.restore, null);
  assert.deepEqual(step.lock, DRAG_UNLOCKED);
  assert.equal(dragLockScroll(step.lock, 500, 0, 0, BIG).restore, null);
});

test('a fling that dismisses the keyboard does not coast through history; the hold ends with the momentum', () => {
  let lock = dragLockBegin(1, 50);
  lock = dragLockEnd(lock, 1000);
  assert.equal(lock.phase, 'lifted');
  lock = dragLockMomentumBegin(lock);
  assert.equal(lock.phase, 'momentum');
  // The keyboard reaches the bottom during the momentum: still held (it is the dismissing fling).
  assert.equal(dragLockScroll(lock, 900, 0, 5000, BIG).restore, 50);
  lock = dragLockMomentumEnd(lock);
  assert.deepEqual(lock, DRAG_UNLOCKED);
  assert.equal(dragLockScroll(lock, 900, 0, 6000, BIG).restore, null);
});

test('finger lifted with no momentum: held briefly, then app scrolls (scroll to bottom, reply jump) are free', () => {
  let lock = dragLockEnd(dragLockBegin(1, 200), 1000);
  assert.equal(dragLockScroll(lock, 260, 0.5, 1000 + LIFT_SETTLE_MS - 1, BIG).restore, 200);
  const later = dragLockScroll(lock, 0, 0, 1000 + LIFT_SETTLE_MS + 1, BIG);
  assert.equal(later.restore, null);
  assert.deepEqual(later.lock, DRAG_UNLOCKED);
  const jump = dragLockScroll(lock, 4000, 1, 1000 + 5000, BIG);
  assert.equal(jump.restore, null, 'a reply jump into history long after the drag is not undone');
});

test('the held offset never stays past the end of the content (the list grew as the keyboard went down)', () => {
  const lock = dragLockBegin(1, 300);
  const step = dragLockScroll(lock, 320, 0.4, 0, 180);
  assert.equal(step.restore, 180);
  assert.equal(step.lock.y, 180);
  assert.equal(dragLockScroll(lock, 320, 0.4, 0, -40).restore, 0, 'content shorter than the list: rest at 0');
});

test('end / momentum events without a hold change nothing; a negative start offset (bounce) holds at 0', () => {
  assert.deepEqual(dragLockEnd(DRAG_UNLOCKED, 10), DRAG_UNLOCKED);
  assert.deepEqual(dragLockMomentumBegin(DRAG_UNLOCKED), DRAG_UNLOCKED);
  assert.deepEqual(dragLockMomentumEnd(DRAG_UNLOCKED), DRAG_UNLOCKED);
  assert.equal(dragLockBegin(1, -30).y, 0);
});

test('dismiss setup per platform: iOS interactive, Android 11+ gesture area, older Android on-drag', () => {
  assert.deepEqual(keyboardDismissSetup('ios', '18.0'), { mode: 'interactive', gestureArea: true });
  assert.deepEqual(keyboardDismissSetup('android', 34), { mode: 'none', gestureArea: true });
  assert.deepEqual(keyboardDismissSetup('android', 30), { mode: 'none', gestureArea: true });
  assert.deepEqual(keyboardDismissSetup('android', 29), { mode: 'on-drag', gestureArea: false });
  assert.deepEqual(keyboardDismissSetup('web', ''), { mode: 'none', gestureArea: false });
});

test('the keyboard follows the finger from the composer top; not with the emoji panel; capped', () => {
  assert.equal(keyboardGestureOffset(56.2, false), 57);
  assert.equal(keyboardGestureOffset(56, true), 0);
  assert.equal(keyboardGestureOffset(900, false), MAX_GESTURE_OFFSET);
  assert.equal(keyboardGestureOffset(NaN, false), 0);
  assert.equal(keyboardGestureOffset(-3, false), 0);
});

test('home-indicator inset under the composer follows the keyboard progress', () => {
  assert.equal(navInsetShown(34, 0), 34);
  assert.equal(navInsetShown(34, 1), 0);
  assert.equal(navInsetShown(34, 0.5), 17);
  assert.equal(navInsetShown(34, 1.3), 0);
  assert.equal(navInsetShown(34, -1), 34);
  assert.equal(navInsetShown(NaN, 0), 0);
  assert.equal(navInsetShown(34, NaN), 34);
});

test('the chat list is wired to the hold: worklet scroll handler, put-back with scrollTo, composer linked by nativeID', () => {
  const chat = src('ChatScreen.tsx'), lock = src('keyboardDragLock.ts');
  assert.match(chat, /<Animated\.FlatList ref=\{listRef\} inverted/);
  assert.match(chat, /keyboardDismissMode=\{dismissSetup\.mode\}/);
  assert.match(chat, /onScroll=\{onListScroll\}/);
  assert.match(chat, /scrollTo\(listRef,0,next\.restore,false\)/);
  assert.match(chat, /textInputNativeID=\{COMPOSER_NATIVE_ID\}/);
  assert.match(chat, /<ComposerInput nativeID=\{COMPOSER_NATIVE_ID\}/);
  assert.doesNotMatch(chat, /onScrollBeginDrag=/, 'drag start goes through the worklet handler');
  // Every function the scroll handler calls on the UI thread is a worklet.
  for (const name of ['dragLockBegin', 'dragLockEnd', 'dragLockMomentumBegin', 'dragLockMomentumEnd', 'dragLockScroll']) {
    assert.match(lock, new RegExp(`export function ${name}\\([^)]*\\)[^\\n]*\\{\\n  'worklet';`), name);
  }
  assert.match(src('chatLayout.ts'), /export function navInsetShown\([^)]*\): number \{\n  'worklet';/);
  // The emoji panel takes keyboard-controller's height (without the composer's invisible accessory view).
  assert.match(src('keyboard.tsx'), /KeyboardEvents\.addListener\('keyboardDidShow'/);
});
