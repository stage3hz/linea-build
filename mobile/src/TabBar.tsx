// The phone tab bar: small, two icons — «Чаты» and «Настройки».
// • a tap opens the tab; its icon plays its own little animation (the gear turns, the chat bubble bounces);
// • the other sections: put a finger on «Чаты» and move it up — they appear above the bar as one plain list
//   (nothing rolls, nothing to play with); the row under the finger is lit and its page shows behind the bar;
//   let go on a row and that section opens, let go anywhere else and nothing changes. A plain hold on «Чаты»
//   (no move) opens the same list and leaves it open: a tap on a row opens the section.
// • no captions: the names are read out by screen readers and shown in the list.
import React, { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { View, Platform, Pressable } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, makeMutable, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { Text } from './typography';
import { type IconName, HIDDEN_ICON } from './components';
import { Ionicons } from '@expo/vector-icons';
// Every tab icon sits in the same 22×22 box with a 22-pt line: an icon-font glyph otherwise gets a
// taller line on iOS and is drawn lower than its box, so the drawn gear looked higher than the rest.
import { useTheme } from './theme';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { badgeText } from './unreadBadge';
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

// The settings gear in Telegram's manner, drawn here: a ring with 15 broad teeth and, inside, a disk split by
// a Y (three spokes). A tap turns it one full turn, so it always comes to rest exactly as drawn, centred
// (a 120° turn left it measurably off-centre on screen). Outlined when not selected, filled when selected — like the Ionicons next to it.
const GEAR = (() => {
  const c = 12; const pt = (r: number, deg: number) => { const a = (deg - 90) * Math.PI / 180; return `${(c + r * Math.cos(a)).toFixed(3)} ${(c + r * Math.sin(a)).toFixed(3)}`; };
  const teeth = (n: number, outer: number, root: number) => { const step = 360 / n; const points: string[] = [];
    for (let i = 0; i < n; i++) { const a = i * step; points.push(pt(root, a - step * 0.3), pt(outer, a - step * 0.17), pt(outer, a + step * 0.17), pt(root, a + step * 0.3)); }
    return `M${points.join(' L')} Z`; };
  const circle = (r: number) => `M${c + r} ${c} A${r} ${r} 0 1 0 ${c - r} ${c} A${r} ${r} 0 1 0 ${c + r} ${c} Z`;
  const Y = [60, 180, 300];
  // The disk as three wedges with parallel gaps `gap` wide along the Y.
  const wedges = (r: number, gap: number) => { const d = (gap / 2) / Math.sin(Math.PI / 3); const da = Math.asin(gap / 2 / r) * 180 / Math.PI;
    return Y.map((g, i) => { const g2 = Y[(i + 1) % 3] + (i === 2 ? 360 : 0); const mid = (g + g2) / 2;
      return `M${pt(d, mid)} L${pt(r, g + da)} A${r} ${r} 0 0 1 ${pt(r, g2 - da)} Z`; }).join(' '); };
  const outer = teeth(15, 11.6, 9.7);
  return { body: `${outer} ${circle(7.3)}`, disk: wedges(5.9, 1.5), outline: outer, innerCircle: 6.2, spokes: Y.map(g => `M${pt(0, g)} L${pt(6.2, g)}`).join(' ') };
})();
// Ionicons glyphs fill their box differently: at one size the sparkles stand taller and the people lower
// than the chat bubbles and headset. Sized so each looks as big as the others (measured on screen).
// Telegram's proportions, measured on its iPhone tab bar (3x screenshots): bar 62 pt, a capsule; the selected
// capsule 50 pt, 6 pt from the bar's top and bottom and 4 pt from its ends; chat icon 23.3 pt tall, gear 25.3 pt;
// 6 pt from icon to caption; caption capitals 7 pt.
const BOX = 27.5;
const OPTICAL: Partial<Record<string, { size: number; dy: number }>> = { 'sparkles-outline': { size: 23.3, dy: 0.3 }, 'people-outline': { size: 31.7, dy: 0.6 } };
const iconSize = (name: string) => OPTICAL[name]?.size ?? BOX;
const iconShift = (name: string) => OPTICAL[name]?.dy ?? 0;
// 24.5 pt: the drawn gear (teeth to teeth) is then 24 pt like the chat bubble and the headset; at 25.5 it measured
// 25 pt on the simulator and looked bigger than its neighbours.
const GEAR_SIZE = 24.5;
function GearIcon({ size, active, accent, muted }: { size: number; active: boolean; accent: string; muted: string }) {
  // The line is a little thinner than the Ionicons outlines next to it (32/512 of their box): 15 teeth, a ring
  // and three spokes at the same weight drew 56 % more ink than the headset of the same size and read as bold
  // (simulator screenshot). At 0.78 the gear carries about as much ink as its neighbours.
  const color = active ? accent : muted; const line = (32 / 512) * BOX * 24 / size * 0.78;
  if (active) return <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d={GEAR.body} fill={color} fillRule="evenodd" />
    <Path d={GEAR.disk} fill={color} />
  </Svg>;
  return <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d={GEAR.outline} fill="none" stroke={color} strokeWidth={line} strokeLinejoin="round" />
    <Circle cx={12} cy={12} r={GEAR.innerCircle} fill="none" stroke={color} strokeWidth={line} />
    <Path d={GEAR.spokes} fill="none" stroke={color} strokeWidth={line} strokeLinecap="round" />
  </Svg>;
}

export type TabId = 'ai' | 'people' | 'channels' | 'chats' | 'music' | 'profile';
export type TabItem = { id: TabId; label: string; icon: IconName; activeIcon: IconName; badge: number; /** A quiet coloured dot when there is no number (somebody is in one of your rooms). */ dot?: string; onPress: () => void };

// The bar shows two of six sections, so the gesture is told in words above it until it has been used once
// (at most on the first few starts of the app).
const HINT_KEY = 'linea.hint.bar-scrub.v1', HINT_STARTS = 6;
let hint = false;
const listeners = new Set<() => void>();
void AsyncStorage.getItem(HINT_KEY).then(value => { const seen = Number(value) || 0; if (value !== 'used' && seen < HINT_STARTS) { hint = true; listeners.forEach(l => l()); void AsyncStorage.setItem(HINT_KEY, String(seen + 1)).catch(() => {}); } }).catch(() => {});
function gestureUsed() { if (!hint) return; hint = false; listeners.forEach(l => l()); void AsyncStorage.setItem(HINT_KEY, 'used').catch(() => {}); }
/** Whether to show the words about the gesture above the bar. */
export const useBarHint = () => useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => hint, () => hint);

const SPRING = { damping: 20, stiffness: 320, mass: 0.7 };
// The unread badge keeps one colour that reads both on the glass and on the light capsule under an active tab.
const BADGE = '#FF4D5E';
// The chat list draws its own bar and the other pages share another, so a tap that moves from «Чаты» to another
// tab (or back) mounts a new bar: its icon animation and the pill's slide were lost (the gear turned only on a
// second tap). The tap is remembered for a moment and the new bar plays it; the pill starts where it was.
let pendingKick: { id: TabId; at: number } | null = null;
let lastPill: number | null = null;
// The capsule's place is one value for every tab bar in the app (each page draws its own bar). It used to be a
// value of the bar that was mounting: on the way to «Чаты» that bar appears only after the heavy chat list has
// rendered, so the capsule stood still and then caught up in a jerk. Now the tap starts the move on the UI
// thread at once, and the next page's bar picks the same move up wherever it is.
const PILL = makeMutable(-1);
// The selection is a capsule with a tail: its front edge goes to the tapped tab at once and its back edge follows
// a little late, so for a moment the capsule is stretched between the two tabs — a trail — and then gathers itself.
const TAIL = makeMutable(-1);
/** 1 while the open section has an icon in the bar (the capsule is shown), 0 otherwise. */
const SHOWN = makeMutable(1);
const LIFT = makeMutable(0);
const TRAIL = { damping: 22, stiffness: 130, mass: 0.9 };
/** Sends the capsule to a tab: the front now, the tail after it. */
function sendPill(to: number) { 'worklet'; PILL.value = withSpring(to, SPRING); TAIL.value = withSpring(to, TRAIL); }
const SYSTEM_GLASS = (() => { try { return Platform.OS === 'ios' && isGlassEffectAPIAvailable() && isLiquidGlassAvailable(); } catch { return false; } })();
let pillTarget = -1;
const kickTiming = (id: TabId) => id === 'profile' ? { duration: 760, easing: Easing.out(Easing.back(1.7)) } : { duration: 650, easing: Easing.out(Easing.quad) };

/**
 * Two looks of one thing in the same place: `far` while the capsule is elsewhere, `near` while it is on this tab.
 * The cross-fade follows the capsule's own position on the UI thread, so an icon turns dark exactly as the light
 * capsule arrives under it — also while React is still busy building the next page (Telegram does the same).
 */
function Under({ index, far, near }: { index: number; far: React.ReactNode; near: React.ReactNode }) {
  const away = useAnimatedStyle(() => ({ opacity: 1 - Math.max(0, 1 - 2 * Math.abs(PILL.value - index)) }));
  const here = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - 2 * Math.abs(PILL.value - index)) }));
  return <View>
    <Animated.View style={away}>{far}</Animated.View>
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }, here]}>{near}</Animated.View>
  </View>;
}
/**
 * The capsule under the chosen tab. On an iPhone with Liquid Glass it is the system's own glass (clear, it bends
 * what is under it); elsewhere — Android, the computer, older iPhones — it is drawn: a light fill, a bright upper
 * rim and a soft inner shade, the same shape and the same motion.
 */
function Capsule({ dark }: { dark: boolean }) {
  if (SYSTEM_GLASS) return <GlassView pointerEvents="none" colorScheme={dark ? 'dark' : 'light'} glassEffectStyle="clear" isInteractive style={{ flex: 1, borderRadius: 27 }} />;
  return <View pointerEvents="none" style={{ flex: 1, borderRadius: 27, overflow: 'hidden', backgroundColor: dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.06)', borderWidth: 1, borderColor: dark ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)' }}>
    <View style={{ position: 'absolute', left: 10, right: 10, top: 0, height: 1.5, borderRadius: 1, backgroundColor: dark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.95)' }} />
  </View>;
}

function TabIcon({ item, active, kick, pressed, index }: { item: TabItem; active: boolean; kick: SharedValue<number>; pressed: SharedValue<number>; index: number }) {
  const t = useTheme();
  // `kick` grows by 1 on every tap of this tab; each icon plays its own motion from it.
  const style = useAnimatedStyle(() => {
    const k = kick.value % 1; const bump = Math.sin(k * Math.PI);
    const press = pressed.value === index ? 0.84 : 1;
    if (item.id === 'profile') return { transform: [{ scale: press }, { rotate: `${kick.value * 360}deg` }] };
    if (item.id === 'people' || item.id === 'channels') return { transform: [{ scale: press * (1 + bump * 0.2) }, { rotate: `${Math.sin(k * Math.PI * 2) * 10}deg` }] };
    if (item.id === 'chats') return { transform: [{ translateY: -bump * 4 }, { scale: press * (1 + bump * 0.22) }] };
    if (item.id === 'music') return { transform: [{ scale: press }, { rotate: `${Math.sin(k * Math.PI * 3) * 14 * (1 - k)}deg` }] };
    return { transform: [{ scale: press * (1 + bump * 0.3) }, { rotate: `${Math.sin(k * Math.PI * 2) * 18}deg` }] };
  });
  return <Animated.View style={style}>
    {item.id === 'profile' ? <View style={{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' }}><Under index={index} far={<GearIcon size={GEAR_SIZE} active={false} accent={t.accent} muted={t.muted} />} near={<GearIcon size={GEAR_SIZE} active accent={t.dark ? t.text : t.accent} muted={t.dark ? t.text : t.accent} />} /></View> : <View style={{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center', overflow: 'visible' }}><Under index={index} far={<Ionicons name={item.icon} size={iconSize(item.icon)} color={t.muted} style={{ width: iconSize(item.icon), height: iconSize(item.icon), lineHeight: iconSize(item.icon), textAlign: 'center', transform: [{ translateY: iconShift(item.icon) }] }} {...HIDDEN_ICON} />} near={<Ionicons name={item.activeIcon} size={iconSize(item.icon)} color={t.dark ? t.text : t.accent} style={{ width: iconSize(item.icon), height: iconSize(item.icon), lineHeight: iconSize(item.icon), textAlign: 'center', transform: [{ translateY: iconShift(item.icon) }] }} {...HIDDEN_ICON} />} /></View>}
    {!item.badge && item.dot ? <View style={{ position: 'absolute', top: -3, left: 21, width: 11, height: 11, borderRadius: 6, borderWidth: 2, borderColor: t.dark ? '#15171D' : '#FFF', backgroundColor: item.dot }} /> : null}
    {item.badge ? <View style={{ position: 'absolute', top: -6, left: 16, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: BADGE, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: '#FFFFFF', fontSize: 10, fontWeight: '800' }}>{badgeText(item.badge)}</Text></View> : null}
  </Animated.View>;
}

/** The sections that have their own icon in the bar; the others are reached with the gesture. */
const BAR_TABS: TabId[] = ['chats', 'profile'];
/** One row of the list, and how far above the finger's start the list's lowest row begins (the finger then lies on the row it picks). */
const ROW = 44, FIRST = 49;

/** `items`: every section; the bar itself shows «Чаты» and «Настройки», the rest are in the list (top to bottom in the order given). */
export function TabBar({ items, active, onScrub, onMenu }: { items: TabItem[]; active: TabId; onScrub?: (index: number | null) => void; /** A plain hold on «Чаты»: the list opens and stays. */ onMenu?: () => void }) {
  const t = useTheme();
  const shown = BAR_TABS.map(id => items.find(item => item.id === id)).filter((item): item is TabItem => !!item);
  const [width, setWidth] = useState(0);
  const n = shown.length; const cell = width / Math.max(1, n);
  const found = shown.findIndex(item => item.id === active);
  // A section without an icon of its own: the light stands between the two icons and neither is lit.
  const target = found < 0 ? (n - 1) / 2 : found;
  const pill = PILL; const pressed = useSharedValue(-1); const hold = useSharedValue(0); const step = useSharedValue(-1); const armed = useSharedValue(0);
  useState(() => { if (PILL.value < 0) { PILL.value = lastPill ?? target; TAIL.value = PILL.value; pillTarget = lastPill ?? target; SHOWN.value = found < 0 ? 0 : 1; } return 0; });
  const k0 = useSharedValue(0), k1 = useSharedValue(0);
  const kicks = [k0, k1];
  // Only when the page changed by something other than a tap on this bar (a tap has started the move itself).
  useEffect(() => { lastPill = target; SHOWN.value = withTiming(found < 0 ? 0 : 1, { duration: 180 }); if (pillTarget !== target) { pillTarget = target; sendPill(target); } }, [target, found]);
  // A bar mounted by the tap that opened its page plays that tap's icon animation.
  useEffect(() => {
    const pending = pendingKick; pendingKick = null;
    if (!pending || Date.now() - pending.at > 800) return;
    const index = shown.findIndex(item => item.id === pending.id);
    if (index >= 0) kicks[index].value = withTiming(Math.floor(kicks[index].value) + 1, kickTiming(pending.id));
  }, []);

  const open = (index: number) => {
    const item = shown[index]; if (!item) return;
    const kick = kicks[index];
    kick.value = withTiming(Math.floor(kick.value) + 1, kickTiming(item.id));
    pendingKick = { id: item.id, at: Date.now() };
    pillTarget = index; sendPill(index);
    item.onPress();
  };
  // The gesture: the list of the other sections; the row under the finger opens its real page behind the bar,
  // off the list the page it began on comes back. `pick` counts rows from the bottom, -1 is none.
  const live = useRef({ items, active, onScrub, onMenu }); live.current = { items, active, onScrub, onMenu };
  const menu = () => { gestureUsed(); live.current.onMenu?.(); };
  const run = useRef<{ from: number; pick: number } | null>(null);
  const rest = () => live.current.items.filter(item => !BAR_TABS.includes(item.id));
  const at = (from: number, steps: number, count: number) => (((from + steps) % count) + count) % count;
  const scrubStart = () => {
    const from = Math.max(0, live.current.items.findIndex(item => item.id === live.current.active));
    run.current = { from, pick: -1 }; live.current.onScrub?.(-1); gestureUsed();
  };
  const scrubTo = (pick: number) => {
    const now = run.current; if (!now) return;
    const list = rest(); const next = pick >= 0 && pick < list.length ? pick : -1;
    if (next === now.pick) return;
    now.pick = next; live.current.onScrub?.(next);
    (next < 0 ? live.current.items[now.from] : list[list.length - 1 - next])?.onPress();
  };
  const scrubEnd = (cancelled: boolean) => {
    const now = run.current; if (!now) return;
    run.current = null; live.current.onScrub?.(null);
    if (cancelled && now.pick >= 0) live.current.items[now.from]?.onPress();
  };
  const move = (by: number) => { const list = live.current.items; const from = Math.max(0, list.findIndex(item => item.id === live.current.active)); list[at(from, by, list.length)]?.onPress(); };
  const tabAt = (x: number) => { 'worklet'; return Math.max(0, Math.min(n - 1, Math.floor(x / Math.max(1, width / n)))); };

  const tap = Gesture.Tap().maxDuration(500)
    .onBegin(e => { pressed.value = tabAt(e.x); LIFT.value = withSpring(1, SPRING); })
    .onEnd(e => { const index = tabAt(e.x); sendPill(index); runOnJS(open)(index); })
    .onFinalize(() => { pressed.value = -1; LIFT.value = withSpring(0, SPRING); });
  const chats = Math.max(0, shown.findIndex(item => item.id === 'chats'));
  // Only from «Чаты»: the gear keeps a plain tap.
  const scrub = Gesture.Pan().activeOffsetY([-1000, -8]).failOffsetX([-48, 48])
    .onStart(e => { armed.value = tabAt(e.x - e.translationX) === chats ? 1 : 0; if (!armed.value) return; hold.value = withSpring(1, SPRING); pressed.value = -1; step.value = -1; runOnJS(scrubStart)(); })
    .onUpdate(e => { if (!armed.value) return; const next = Math.floor((-e.translationY - FIRST) / ROW); if (next !== step.value) { step.value = next; runOnJS(scrubTo)(next); } })
    .onEnd(() => { if (armed.value) runOnJS(scrubEnd)(false); })
    .onFinalize(() => { hold.value = withSpring(0, SPRING); if (armed.value) runOnJS(scrubEnd)(true); armed.value = 0; });
  const press = Gesture.LongPress().minDuration(350).maxDistance(10)
    .onStart(e => { if (tabAt(e.x) === chats) { pressed.value = -1; runOnJS(menu)(); } });
  // A race, not a queue: in a queue the hold waited for the move to give up, which it does only when the finger lifts.
  const gesture = Gesture.Race(scrub, press, tap);

  // The capsule spans from its tail to its front: equal at rest, stretched on the way. It rises a little under the finger.
  const pillStyle = useAnimatedStyle(() => { const front = pill.value, back = TAIL.value; return { opacity: SHOWN.value, left: Math.min(front, back) * cell, width: cell * (1 + Math.abs(front - back)), transform: [{ scale: 1 + LIFT.value * 0.05 }] }; });
  const grow = useAnimatedStyle(() => ({ transform: [{ scale: 1 + hold.value * 0.06 }] }));
  const others = items.filter(item => !BAR_TABS.includes(item.id)); const waiting = others.reduce((sum, item) => sum + (item.badge || 0), 0); const awake = others.find(item => item.dot)?.dot;

  return <GestureDetector gesture={gesture}>
    <Animated.View collapsable={false} onLayout={e => setWidth(e.nativeEvent.layout.width)} accessibilityRole="tablist" style={[{ flexDirection: 'row', alignItems: 'center', minHeight: 56 }, grow]}>
      {width ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 1, bottom: 1, padding: 1 }, pillStyle]}>
        <Capsule dark={t.dark} />
      </Animated.View> : null}
      {shown.map((item, index) => { const on = index === found; return <View key={item.id} accessible accessibilityRole="tab"
        accessibilityLabel={`${item.label}${item.badge ? `, ${item.badge}` : ''}`} accessibilityHint={item.id === 'chats' ? 'Удержи — остальные разделы' : undefined} accessibilityState={{ selected: on }}
        accessibilityActions={[{ name: 'activate' }, { name: 'increment', label: 'Следующий раздел' }, { name: 'decrement', label: 'Прошлый раздел' }]}
        onAccessibilityAction={event => { const name = event.nativeEvent.actionName; if (name === 'increment') move(1); else if (name === 'decrement') move(-1); else open(index); }}
        onAccessibilityTap={() => open(index)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 }}>
        <TabIcon item={item} active={on} kick={kicks[index]} pressed={pressed} index={index} />
      </View>; })}
      {/* Something waits in a section that has no icon here: its count (or a quiet dot) at the bar's top edge. */}
      {waiting ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', top: -5, alignSelf: 'center', left: '50%', marginLeft: -11, minWidth: 22, height: 16, paddingHorizontal: 5, borderRadius: 8, backgroundColor: BADGE, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: '#FFFFFF', fontSize: 9.5, fontWeight: '800' }}>{badgeText(waiting)}</Text></View>
        : awake ? <View pointerEvents="none" style={{ position: 'absolute', top: -3, left: '50%', marginLeft: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: awake }} /> : null}
    </Animated.View>
  </GestureDetector>;
}

/** The list shown above the bar while the finger is held on «Чаты»: every section without an icon of its own; `pick` counts from the bottom, -1 is none. */
export function TabList({ items, pick, onPick }: { items: TabItem[]; pick: number; /** Given when the list stays open: a row is then a button. */ onPick?: (item: TabItem) => void }) {
  const t = useTheme(); const list = items.filter(item => !BAR_TABS.includes(item.id));
  return <View style={{ width: 216, padding: 6 }}>
    {list.map((item, place) => { const on = list.length - 1 - place === pick; const style = (lit: boolean) => ({ height: ROW, borderRadius: 16, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: on || lit ? (t.dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.07)') : 'transparent' } as const);
      const inside = <>
      <Ionicons name={on ? item.activeIcon : item.icon} size={20} color={on ? t.text : t.muted} {...HIDDEN_ICON} />
      <Text numberOfLines={1} maxFontSizeMultiplier={1.2} style={{ flex: 1, color: on ? t.text : t.muted, fontSize: 15.5, fontWeight: '600' }}>{item.label}</Text>
      {item.badge ? <View style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: BADGE, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: '#FFFFFF', fontSize: 10.5, fontWeight: '800' }}>{badgeText(item.badge)}</Text></View>
        : item.dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: item.dot }} /> : null}
      </>;
      return onPick ? <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.label}${item.badge ? `, ${item.badge}` : ''}`} onPress={() => onPick(item)} style={({ pressed }) => style(pressed)}>{inside}</Pressable> : <View key={item.id} style={style(false)}>{inside}</View>; })}
  </View>;
}

export type GlowColors = [string, string, string];
function GlowSides({ colors, width, height, id }: { colors: GlowColors; width: number; height: number; id: string }) {
  return <Svg width={width} height={height}>
    <Defs>
      <RadialGradient id={id + 'l'} cx="20%" cy="100%" rx="36%" ry="95%" gradientUnits="objectBoundingBox"><Stop offset="0" stopColor={colors[1]} stopOpacity={0.62} /><Stop offset="1" stopColor={colors[1]} stopOpacity={0} /></RadialGradient>
      <RadialGradient id={id + 'r'} cx="82%" cy="100%" rx="36%" ry="95%" gradientUnits="objectBoundingBox"><Stop offset="0" stopColor={colors[2]} stopOpacity={0.62} /><Stop offset="1" stopColor={colors[2]} stopOpacity={0} /></RadialGradient>
    </Defs>
    <Rect x="0" y="0" width={width} height={height} fill={`url(#${id}l)`} /><Rect x="0" y="0" width={width} height={height} fill={`url(#${id}r)`} />
  </Svg>;
}
function GlowSpot({ color, width, height, id }: { color: string; width: number; height: number; id: string }) {
  return <Svg width={width} height={height}>
    <Defs><RadialGradient id={id} cx="50%" cy="100%" rx="50%" ry="100%" gradientUnits="objectBoundingBox"><Stop offset="0" stopColor={color} stopOpacity={0.8} /><Stop offset="1" stopColor={color} stopOpacity={0} /></RadialGradient></Defs>
    <Rect x="0" y="0" width={width} height={height} fill={`url(#${id})`} />
  </Svg>;
}
/**
 * The light that lives under the bar's glass: two quiet colours at the sides and a brighter one that stands under
 * the active tab and travels with it. When the colours change (another track, music stopped) the old light
 * fades into the new one. `inset` is the glass's own side padding, so the spot stands exactly under the tab.
 */
export const BarGlow = memo(function BarGlow({ colors, radius, inset = 0, strength = 1, tabs = 2 }: { colors: GlowColors; radius: number; inset?: number; strength?: number; tabs?: number }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const key = colors.join();
  const [pair, setPair] = useState<{ from: GlowColors; to: GlowColors }>({ from: colors, to: colors });
  const mix = useSharedValue(1);
  useEffect(() => {
    if (pair.to.join() === key) return;
    setPair(now => ({ from: now.to, to: colors })); mix.value = 0; mix.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.quad) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const old = useAnimatedStyle(() => ({ opacity: 1 - mix.value })), fresh = useAnimatedStyle(() => ({ opacity: mix.value }));
  const { width, height } = size, cell = (width - inset * 2) / tabs, spot = Math.max(110, width * 0.7);
  const travel = useAnimatedStyle(() => ({ transform: [{ translateX: inset + (Math.max(0, PILL.value) + 0.5) * cell - spot / 2 }] }));
  const fill = { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 } as const;
  return <View pointerEvents="none" onLayout={e => { const { width: w, height: h } = e.nativeEvent.layout; if (Math.abs(w - size.width) > 0.5 || Math.abs(h - size.height) > 0.5) setSize({ width: w, height: h }); }} style={[fill, { borderRadius: radius, overflow: 'hidden', opacity: strength }]}>
    {width ? <>
      <Animated.View style={[fill, old]}><GlowSides colors={pair.from} width={width} height={height} id="glowa" /></Animated.View>
      <Animated.View style={[fill, fresh]}><GlowSides colors={pair.to} width={width} height={height} id="glowb" /></Animated.View>
      <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: spot, height }, travel]}>
        <Animated.View style={[fill, old]}><GlowSpot color={pair.from[0]} width={spot} height={height} id="glowc" /></Animated.View>
        <Animated.View style={[fill, fresh]}><GlowSpot color={pair.to[0]} width={spot} height={height} id="glowd" /></Animated.View>
      </Animated.View>
    </> : null}
  </View>;
});
