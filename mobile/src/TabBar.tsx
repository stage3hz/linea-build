// The phone tab bar, Telegram-style:
// • every tab has its own little icon animation on tap (the gear turns, the chat bubble bounces, the
//   sparkles twinkle…) and the tab presses in under the finger;
// • the selection is a pill; put a finger on the bar and slide (no need to lift or wait) — it becomes a
//   larger lens that follows the finger, letting go opens the tab under it;
// • no captions: the icons speak, the names stay for screen readers;
// • one slot holds «Люди» or «Каналы»: swipe up on it to switch (two dots beside it show which of the two is
//   up, like a stack of widgets); the choice is remembered and stays in the bar until switched back. It rolls like a carousel — the same quick roll however hard you swipe. (Tablets and PC show both in their rail.)
import React, { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { View, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, makeMutable, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { Text } from './typography';
import { type IconName, HIDDEN_ICON } from './components';
import { Ionicons } from '@expo/vector-icons';
// Every tab icon sits in the same 22×22 box with a 22-pt line: an icon-font glyph otherwise gets a
// taller line on iOS and is drawn lower than its box, so the drawn gear looked higher than the rest.
import { useTheme } from './theme';
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

// Which of «Люди» / «Каналы» the slot shows: remembered on this device.
const SLOT_KEY = 'linea.tabs.slot';
let slot: 'people' | 'channels' = 'people';
const listeners = new Set<() => void>();
void AsyncStorage.getItem(SLOT_KEY).then(value => { if (value === 'channels') { slot = 'channels'; listeners.forEach(l => l()); } }).catch(() => {});
function setSlot(next: 'people' | 'channels') { slot = next; listeners.forEach(l => l()); void AsyncStorage.setItem(SLOT_KEY, next).catch(() => {}); }
const useSlot = () => useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => slot, () => slot);

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
let pillTarget = -1;
const kickTiming = (id: TabId) => id === 'profile' ? { duration: 760, easing: Easing.out(Easing.back(1.7)) } : { duration: 650, easing: Easing.out(Easing.quad) };

/**
 * Two looks of one thing in the same place: `far` while the capsule is elsewhere, `near` while it is on this tab.
 * The cross-fade follows the capsule's own position on the UI thread, so an icon turns dark exactly as the light
 * capsule arrives under it — also while React is still busy building the next page (Telegram does the same).
 */
function Under({ index, far, near }: { index: number; far: React.ReactNode; near: React.ReactNode }) {
  const away = useAnimatedStyle(() => ({ opacity: 1 - Math.max(0, 1 - Math.abs(PILL.value - index)) }));
  const here = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - Math.abs(PILL.value - index)) }));
  return <View>
    <Animated.View style={away}>{far}</Animated.View>
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }, here]}>{near}</Animated.View>
  </View>;
}
/** The mark of the active tab: a short bright line at the bar's top edge and a faint spot of light under the icon. */
function TabLight({ color, width }: { color: string; width: number }) {
  const wide = Math.max(60, width * 1.5), tall = 64;
  return <View pointerEvents="none" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
    <View style={{ position: 'absolute', width: wide, height: tall, top: -8 }}>
      <Svg width={wide} height={tall}>
        <Defs><RadialGradient id="tablight" cx="50%" cy="58%" rx="50%" ry="50%" gradientUnits="objectBoundingBox">
          <Stop offset="0" stopColor={color} stopOpacity={0.16} /><Stop offset="0.5" stopColor={color} stopOpacity={0.05} /><Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient></Defs>
        <Rect x="0" y="0" width={wide} height={tall} fill="url(#tablight)" />
      </Svg>
    </View>
    <View style={{ position: 'absolute', top: -2, width: 22, height: 3, borderRadius: 2, backgroundColor: color, shadowColor: color, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }} />
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

// The first and last tabs sit a little closer to the middle: the bar is a capsule and its ends curve in.
const EDGE_SHIFT = 5;
const REEL = 31.5; // one carousel row: the icon (27.5) and a little air

/** «Люди» / «Каналы» as a vertical carousel: rows [Люди, Каналы, Люди] rolled by `reel` (0 → 1 → 2). */
function SlotReel({ reel, people, channels, active, kick, pressed, index }: { reel: SharedValue<number>; people: TabItem; channels: TabItem; active: boolean; kick: SharedValue<number>; pressed: SharedValue<number>; index: number }) {
  const roll = useAnimatedStyle(() => ({ transform: [{ translateY: -reel.value * REEL }] }));
  const row = (item: TabItem, key: string) => <View key={key} style={{ height: REEL, alignItems: 'center', justifyContent: 'center' }}>
    <TabIcon item={item} active={active} kick={kick} pressed={pressed} index={index} />
  </View>;
  return <View style={{ height: REEL, overflow: 'hidden', alignSelf: 'stretch', paddingTop: 0 }}>
    <Animated.View style={roll}>{row(people, 'a')}{row(channels, 'b')}{row(people, 'c')}</Animated.View>
  </View>;
}

/** `items`: AI, people, channels, chats, music, profile — people and channels share one slot. */
export function TabBar({ items, active }: { items: TabItem[]; active: TabId }) {
  const t = useTheme(); const current = useSlot();
  // Opening «Каналы» or «Люди» from elsewhere also turns the slot to it.
  useEffect(() => { if ((active === 'people' || active === 'channels') && active !== slot) setSlot(active); }, [active]);
  const shown = items.filter(item => item.id !== (current === 'people' ? 'channels' : 'people'));
  const other = items.find(item => item.id === (current === 'people' ? 'channels' : 'people'));
  const [width, setWidth] = useState(0);
  const n = shown.length; const cell = width / Math.max(1, n);
  const slotIndex = shown.findIndex(item => item.id === 'people' || item.id === 'channels');
  const activeIndex = Math.max(0, shown.findIndex(item => item.id === (active === 'people' || active === 'channels' ? current : active)));
  const pill = PILL; const lens = useSharedValue(0); const pressed = useSharedValue(-1);
  useState(() => { if (PILL.value < 0) { PILL.value = lastPill ?? activeIndex; pillTarget = lastPill ?? activeIndex; } return 0; });
  // The slot is a vertical carousel [Люди, Каналы, Люди]: a swipe always plays the same quick roll up.
  const reel = useSharedValue(current === 'channels' ? 1 : 0);
  useEffect(() => { reel.value = current === 'channels' ? 1 : 0; }, [current]);
  const k0 = useSharedValue(0), k1 = useSharedValue(0), k2 = useSharedValue(0), k3 = useSharedValue(0), k4 = useSharedValue(0), k5 = useSharedValue(0);
  const kicks = [k0, k1, k2, k3, k4, k5];
  // Only when the page changed by something other than a tap on this bar (a tap has started the move itself).
  useEffect(() => { lastPill = activeIndex; if (!lens.value && pillTarget !== activeIndex) { pillTarget = activeIndex; pill.value = withSpring(activeIndex, SPRING); } }, [activeIndex]);
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
    // Longer and smoother: the gear turns with a soft overshoot (~0.75 s), the others play over ~0.65 s.
    kick.value = withTiming(Math.floor(kick.value) + 1, kickTiming(item.id));
    pendingKick = { id: item.id, at: Date.now() };
    // Also for an opening that did not come from the tap gesture (VoiceOver, the slide).
    pillTarget = index; pill.value = withSpring(index, SPRING);
    item.onPress();
  };
  // Swipe up on the slot: «Люди» ⇄ «Каналы» (remembered), the icon flips like a slot machine.
  // Switched while its own section is open, the slot takes the screen along: seen in the simulator, «Люди» was
  // lit in the bar over the still open «Каналы».
  const slotSwitched = (next: 'people' | 'channels') => {
    setSlot(next);
    if (active === 'people' || active === 'channels') items.find(item => item.id === next)?.onPress();
  };
  const switchSlot = () => {
    const next = slot === 'people' ? 'channels' : 'people';
    const from = slot === 'people' ? 0 : 1;
    reel.value = from;
    reel.value = withTiming(from + 1, { duration: 230, easing: Easing.out(Easing.cubic) }, done => { if (done) runOnJS(slotSwitched)(next); });

  };
  const at = (x: number) => { 'worklet'; return Math.max(0, Math.min(n - 1, Math.floor(x / Math.max(1, width / n)))); };

  const tap = Gesture.Tap().maxDuration(500)
    .onBegin(e => { pressed.value = at(e.x); })
    .onEnd(e => { const index = at(e.x); pill.value = withSpring(index, SPRING); runOnJS(open)(index); })
    .onFinalize(() => { pressed.value = -1; });
  // Telegram: put a finger down and slide — no waiting; the pill turns into a bigger lens under the finger.
  const slide = Gesture.Pan().activeOffsetX([-8, 8]).failOffsetY([-24, 24])
    .onStart(() => { lens.value = withSpring(1, SPRING); pressed.value = -1; })
    .onUpdate(e => { pill.value = Math.max(0, Math.min(n - 1, e.x / Math.max(1, width / n) - 0.5)); })
    .onEnd(e => { const index = at(e.x); pill.value = withSpring(index, SPRING); runOnJS(open)(index); })
    .onFinalize(() => { lens.value = withSpring(0, SPRING); });
  const swipeUp = Gesture.Pan().activeOffsetY([-14, 1000]).failOffsetX([-20, 20])
    .onEnd(e => { if (e.translationY < -14 && at(e.x - e.translationX) === slotIndex) runOnJS(switchSlot)(); })
    .onFinalize(() => { pressed.value = -1; });
  const gesture = Gesture.Exclusive(swipeUp, slide, tap);

  const pillStyle = useAnimatedStyle(() => ({ top: 1 - lens.value * 9, bottom: 1 - lens.value * 9, transform: [{ translateX: pill.value * cell + EDGE_SHIFT * (Math.max(0, 1 - pill.value) - Math.max(0, pill.value - (n - 2))) }, { scale: 1 + lens.value * 0.12 }] }));
  // No capsule: a spot of light under the active tab, seen through the glass, and a thin bright line at the bar's
  // lower edge. It grows a little while the finger drags it.
  const pillInner = useAnimatedStyle(() => ({ opacity: 0.86 + lens.value * 0.14, transform: [{ scale: 1 + lens.value * 0.18 }] }));

  return <GestureDetector gesture={gesture}>
    <View collapsable={false} onLayout={e => setWidth(e.nativeEvent.layout.width)} accessibilityRole="tablist" style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48 }}>
      {width ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, width: cell, padding: 2 }, pillStyle]}>
        <Animated.View style={[{ flex: 1 }, pillInner]}><TabLight color={t.dark ? '#FFFFFF' : t.accent} width={cell} /></Animated.View>
      </Animated.View> : null}
      {shown.map((item, index) => { const on = index === activeIndex; const slotted = index === slotIndex; return <View key={slotted ? 'slot' : item.id} accessible accessibilityRole="tab"
        accessibilityLabel={`${item.label}${item.badge ? `, ${item.badge}` : ''}${slotted && other ? `. Смахни вверх — ${other.label}` : ''}`} accessibilityState={{ selected: on }}
        accessibilityActions={slotted ? [{ name: 'activate' }, { name: 'magicTap', label: other?.label }] : undefined}
        onAccessibilityAction={slotted ? event => { if (event.nativeEvent.actionName === 'magicTap') switchSlot(); else open(index); } : undefined}
        onAccessibilityTap={() => open(index)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, transform: [{ translateX: index === 0 ? EDGE_SHIFT : index === n - 1 ? -EDGE_SHIFT : 0 }] }}>
        {slotted && other ? <SlotReel reel={reel} people={item.id === 'people' ? item : other} channels={item.id === 'channels' ? item : other} active={on} kick={kicks[index]} pressed={pressed} index={index} /> : <>
          <TabIcon item={item} active={on} kick={kicks[index]} pressed={pressed} index={index} />
        </>}
        {/* The slot holds two sections: two dots beside it, the bright one is the section that is up (as on a stack of widgets). */}
        {slotted && other ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', left: '50%', marginLeft: 20, top: '50%', marginTop: -7, gap: 4 }}>
          {(['people', 'channels'] as const).map(id => <View key={id} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.text, opacity: current === id ? 1 : 0.32 }} />)}
        </View> : null}
        {slotted && other?.badge ? <View pointerEvents="none" accessibilityElementsHidden style={{ position: 'absolute', top: -1, minWidth: 18, height: 14, paddingHorizontal: 4, borderRadius: 7, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 9, fontWeight: '800' }}>{badgeText(other.badge)}</Text></View> : null}
      </View>; })}
    </View>
  </GestureDetector>;
}

export type GlowColors = [string, string, string];
const TABS_IN_BAR = 5;
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
export const BarGlow = memo(function BarGlow({ colors, radius, inset = 0, strength = 1 }: { colors: GlowColors; radius: number; inset?: number; strength?: number }) {
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
  const { width, height } = size, cell = (width - inset * 2) / TABS_IN_BAR, spot = Math.max(120, width * 0.46);
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
