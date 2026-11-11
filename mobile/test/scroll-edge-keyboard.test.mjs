import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { retryFocus, stopFocusRetries } from '../src/focusRetry.ts';

const src = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const fakeTimers = () => {
  const pending = new Map(); let next = 1;
  return { pending, set: fn => { const id = next++; pending.set(id, fn); return id; }, clear: id => { pending.delete(id); }, runAll: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } } };
};

test('leaving a screen stops every pending composer focus retry: the keyboard is not raised over the list', () => {
  const timers = fakeTimers(); let focusCalls = 0;
  const retry = retryFocus({ isFocused: () => false, focus: () => { focusCalls++; } }, [60, 320, 650], timers);
  assert.equal(timers.pending.size, 3);
  stopFocusRetries();
  assert.equal(timers.pending.size, 0, 'all timers cleared');
  timers.runAll();
  assert.equal(focusCalls, 0);
  retry.stop(); // idempotent
});

test('a retry that already finished is forgotten; a new one after leaving still works', () => {
  const timers = fakeTimers(); let focused = false, focusCalls = 0;
  retryFocus({ isFocused: () => focused, focus: () => { focusCalls++; focused = true; } }, [60, 320], timers);
  timers.runAll();
  assert.equal(focusCalls, 1);
  stopFocusRetries();
  const again = fakeTimers(); let calls = 0;
  retryFocus({ isFocused: () => false, focus: () => { calls++; } }, [60], again);
  again.runAll();
  assert.equal(calls, 1, 'stopFocusRetries only affects retries in flight at that moment');
});

test('the stack dismisses the keyboard as soon as leaving is decided (button and released swipe), not on a spring-back', () => {
  const stack = src('stack.tsx');
  assert.match(stack, /export function dismissForLeave\(\) \{ stopFocusRetries\(\); Keyboard\.dismiss\(\); \}/);
  assert.match(stack, /closing\.current = true;\s*dismissForLeave\(\);/);
  assert.match(stack, /if \(leave\) \{\s*runOnJS\(dismissForLeave\)\(\);/);
  const springBack = stack.slice(stack.indexOf('} else progress.value = withTiming(0'));
  assert.doesNotMatch(springBack.slice(0, 120), /dismissForLeave/);
});

test('chat header, composer and chat list header use the shared scroll-edge effect (blur + colour, solid behind the bar)', () => {
  const chat = src('ChatScreen.tsx'), inset = src('tabInset.tsx');
  assert.match(chat, /<ScrollEdgeEffect edge="top" size=\{headerHeight\}/);
  // Telegram: no edge effect at the bottom of a chat — messages pass under the floating composer as they are.
  assert.doesNotMatch(chat, /<ScrollEdgeEffect edge="bottom"/);
  assert.doesNotMatch(chat, /<LinearGradient/, 'no bare colour ramp left over the header');
  // The first message must still clear the header and the composer.
  // The composer side pads without the home-indicator inset; a spacer at the list's composer side adds it
  // frame by frame with the composer's own padding (navInsetShown), so nothing jumps when the keyboard moves.
  assert.match(chat, /paddingTop:listComposerSide,paddingBottom:listEdges\.headerSide/);
  assert.match(chat, /listComposerSide=chatListPadding\(\{composer:composerHeight,header:headerHeight,navInset,keyboardOpen:true\}\)\.composerSide/);
  assert.match(chat, /chatListPadding\(\{composer:composerHeight,header:headerHeight,navInset,keyboardOpen\}\)/);
  assert.match(chat, /paddingBottom:navInsetShown\(navInset,keyboardProgress\.value\)/);
  assert.match(chat, /height:navInsetShown\(navInset,keyboardProgress\.value\)/);
  assert.match(chat, /<Animated\.View style=\{listNavSpacer\}\/><\/View>\}/, 'the spacer is the last thing at the composer side');
  const floating = inset.slice(inset.indexOf('export function FloatingHeader'), inset.indexOf('export function ScrollEdgeEffect'));
  assert.match(floating, /<ScrollEdgeEffect edge="top" size=\{height\}/);
  assert.doesNotMatch(floating, /ScrollEdgeBlurView/, 'not the linear-fading blur that was nearly gone behind «Поиск»');
  const effect = inset.slice(inset.indexOf('export function ScrollEdgeEffect'));
  assert.match(effect, /pointerEvents="none"/);
  assert.match(effect, /Platform\.OS === 'ios' && !reduced/, 'live blur on iOS only, not with Reduce Transparency');
});
