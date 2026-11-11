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

test('the floating tab bar stands clear of the home gesture and has a bottom scroll-edge effect on every tab', async () => {
  const layout = await import('../src/chatLayout.ts');
  // iPhone with a home indicator (34 pt): the pill's lower edge is 30 pt above the screen bottom (was 21).
  assert.equal(34 + layout.tabBarMarginBottom(true, 34), 30);
  assert.ok(layout.TAB_BAR_HOME_GAP - 21 >= 8 && layout.TAB_BAR_HOME_GAP - 21 <= 10);
  // No inset (iPhone SE), Android (3-button or gesture navigation), web: 10 pt above the safe area, as before.
  assert.equal(layout.tabBarMarginBottom(true, 0), 10);
  assert.equal(layout.tabBarMarginBottom(false, 0), 10);
  assert.equal(layout.tabBarMarginBottom(false, 48), 10);
  assert.equal(layout.tabBarMarginBottom(true, 21), 9, 'a small inset never pushes the pill further than the usual gap');
  assert.equal(layout.tabBarMarginBottom(true, NaN), 10);

  // bar = 5 (top margin) + 63 (pill) − 4 (margin into the inset) above the safe area.
  const edge = layout.tabBarEdge(64, 34, 30);
  assert.equal(edge.total, 98 + 8, 'from the screen bottom to 8 pt above the bar');
  assert.equal(edge.locations.length, edge.alphas.length);
  for (let i = 1; i < edge.locations.length; i++) { assert.ok(edge.locations[i] >= edge.locations[i - 1]); assert.ok(edge.alphas[i] <= edge.alphas[i - 1]); }
  assert.ok(edge.alphas[0] >= .9 && edge.alphas[1] >= .9, 'under the pill and beside its lower edge rows are covered');
  assert.ok(edge.locations[1] * edge.total > 30, 'the full cover reaches past the pill\'s lower edge');
  assert.equal(edge.alphas.at(-1), 0); assert.equal(edge.locations.at(-1), 1);
  assert.ok(Math.abs(edge.blurSolid * edge.total - 93) < 1e-9, 'blurred up to the pill\'s top edge');
  // With the mini-player above the pill the effect still ends above the whole block; junk input is safe.
  assert.equal(layout.tabBarEdge(130, 34, 30).total, 172);
  const junk = layout.tabBarEdge(NaN, -1, NaN);
  assert.ok(junk.total > 0 && junk.locations.every(x => x >= 0 && x <= 1));

  const inset = src('tabInset.tsx'), list = src('ChatListScreen.tsx');
  assert.match(inset, /function TabsFade[\s\S]*?<TabBarEdge bar=\{bar\} \/>/, 'tabs rendered by TabsOverlay');
  assert.match(list, /\{editing\|\|rail\?null:<TabBarEdge bar=\{tabsHeight\}\/>\}/, 'the chat list renders its own tab bar: it needs the effect too');
  assert.match(list, /marginBottom:tabBarMarginBottom\(Platform\.OS==='ios',insets\.bottom\)/);
  assert.doesNotMatch(list, /21-insets\.bottom/);
});

test('full player: the veil over the blurred cover keeps the theme text readable on any cover', () => {
  const player = src('music/PlayerControls.tsx');
  const veil = /COVER_VEIL = \{ dark: 'rgba\(0,0,0,([\d.]+)\)', light: 'rgba\(255,255,255,([\d.]+)\)' \}/.exec(player);
  assert.ok(veil);
  assert.match(player, /backgroundColor: t\.dark \? COVER_VEIL\.dark : COVER_VEIL\.light/);
  const lum = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = ([r, g, b]) => 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
  const contrast = (a, b) => { const [hi, lo] = [L(a), L(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const theme = src('theme.tsx');
  const colour = (name, index) => hex([...theme.matchAll(new RegExp(`${name}:'(#[0-9A-Fa-f]{6})'`, 'g'))][index][1]);
  // Worst covers: black under the light veil, white under the dark one.
  const light = Array(3).fill(Math.round(255 * Number(veil[2]))), dark = Array(3).fill(Math.round(255 * (1 - Number(veil[1]))));
  assert.ok(contrast(colour('text', 0), light) >= 7, 'light theme: title and controls');
  assert.ok(contrast(colour('muted', 0), light) >= 3, 'light theme: artist, times, queue badge');
  assert.ok(contrast([255, 255, 255], dark) >= 7, 'dark theme: title and controls');
  assert.ok(contrast(colour('muted', 1), dark) >= 3, 'dark theme: artist, times');
});
