// The phone tab bar, Telegram-style:
// • every tab has its own little icon animation on tap (the gear turns, the chat bubble bounces, the
//   sparkles twinkle…) and the tab presses in under the finger;
// • the selection is a pill; put a finger on the bar and slide (no need to lift or wait) — it becomes a
//   larger lens that follows the finger, letting go opens the tab under it;
// • one slot holds «Люди» or «Каналы»: swipe up on it to switch; the choice is remembered and stays
//   in the bar until switched back. It rolls like a carousel — the same quick roll however hard you swipe. (Tablets and PC show both in their rail.)
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { Text } from './typography';
import { type IconName, HIDDEN_ICON } from './components';
import { Ionicons } from '@expo/vector-icons';
// Every tab icon sits in the same 22×22 box with a 22-pt line: an icon-font glyph otherwise gets a
// taller line on iOS and is drawn lower than its box, so the drawn gear looked higher than the rest.
import { useTheme } from './theme';
import { badgeText } from './unreadBadge';
import Svg, { Circle, Path } from 'react-native-svg';

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
export type TabItem = { id: TabId; label: string; icon: IconName; activeIcon: IconName; badge: number; onPress: () => void };

// Which of «Люди» / «Каналы» the slot shows: remembered on this device.
const SLOT_KEY = 'linea.tabs.slot';
let slot: 'people' | 'channels' = 'people';
const listeners = new Set<() => void>();
void AsyncStorage.getItem(SLOT_KEY).then(value => { if (value === 'channels') { slot = 'channels'; listeners.forEach(l => l()); } }).catch(() => {});
function setSlot(next: 'people' | 'channels') { slot = next; listeners.forEach(l => l()); void AsyncStorage.setItem(SLOT_KEY, next).catch(() => {}); }
const useSlot = () => useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => slot, () => slot);

const SPRING = { damping: 20, stiffness: 320, mass: 0.7 };
// The chat list draws its own bar and the other pages share another, so a tap that moves from «Чаты» to another
// tab (or back) mounts a new bar: its icon animation and the pill's slide were lost (the gear turned only on a
// second tap). The tap is remembered for a moment and the new bar plays it; the pill starts where it was.
let pendingKick: { id: TabId; at: number } | null = null;
let lastPill: number | null = null;
const kickTiming = (id: TabId) => id === 'profile' ? { duration: 760, easing: Easing.out(Easing.back(1.7)) } : { duration: 650, easing: Easing.out(Easing.quad) };

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
    {item.id === 'profile' ? <View style={{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' }}><GearIcon size={GEAR_SIZE} active={active} accent={t.accent} muted={t.muted} /></View> : <View style={{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center', overflow: 'visible' }}><Ionicons name={active ? item.activeIcon : item.icon} size={iconSize(item.icon)} color={active ? t.accent : t.muted} style={{ width: iconSize(item.icon), height: iconSize(item.icon), lineHeight: iconSize(item.icon), textAlign: 'center', transform: [{ translateY: iconShift(item.icon) }] }} {...HIDDEN_ICON} /></View>}
    {item.badge ? <View style={{ position: 'absolute', top: -6, left: 16, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, borderWidth: 2, borderColor: t.dark ? '#15171D' : '#FFF', backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 10, fontWeight: '800' }}>{badgeText(item.badge)}</Text></View> : null}
  </Animated.View>;
}

// The bar is a capsule: at caption height its ends curve in by ~6.5 pt, so the long caption of the last tab
// («Настройки») touched the glass edge. The first and last tabs sit this much closer to the middle.
const EDGE_SHIFT = 5;
// Captions: 9 pt, slightly tightened, and never wider than this — a longer one shrinks instead of sticking out.
const CAPTION_MAX = 46;
const REEL = 40.5; // one carousel row: icon (27.5) + gap (1) + label (12)

/** «Люди» / «Каналы» as a vertical carousel: rows [Люди, Каналы, Люди] rolled by `reel` (0 → 1 → 2). */
function SlotReel({ reel, people, channels, active, kick, pressed, index }: { reel: SharedValue<number>; people: TabItem; channels: TabItem; active: boolean; kick: SharedValue<number>; pressed: SharedValue<number>; index: number }) {
  const t = useTheme();
  const roll = useAnimatedStyle(() => ({ transform: [{ translateY: -reel.value * REEL }] }));
  const row = (item: TabItem, key: string) => <View key={key} style={{ height: REEL, alignItems: 'center', justifyContent: 'center', gap: 1 }}>
    <TabIcon item={item} active={active} kick={kick} pressed={pressed} index={index} />
    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.8} maxFontSizeMultiplier={1} style={{ maxWidth: CAPTION_MAX, fontSize: 9, lineHeight: 12, letterSpacing: -.25, color: active ? t.accent : t.muted, fontWeight: '600' }}>{item.label}</Text>
  </View>;
  return <View style={{ height: REEL, overflow: 'hidden', alignSelf: 'stretch' }}>
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
  const pill = useSharedValue(lastPill ?? activeIndex); const lens = useSharedValue(0); const pressed = useSharedValue(-1);
  // The slot is a vertical carousel [Люди, Каналы, Люди]: a swipe always plays the same quick roll up.
  const reel = useSharedValue(current === 'channels' ? 1 : 0);
  useEffect(() => { reel.value = current === 'channels' ? 1 : 0; }, [current]);
  const k0 = useSharedValue(0), k1 = useSharedValue(0), k2 = useSharedValue(0), k3 = useSharedValue(0), k4 = useSharedValue(0), k5 = useSharedValue(0);
  const kicks = [k0, k1, k2, k3, k4, k5];
  useEffect(() => { lastPill = activeIndex; if (!lens.value) pill.value = withSpring(activeIndex, SPRING); }, [activeIndex]);
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
    item.onPress();
  };
  // Swipe up on the slot: «Люди» ⇄ «Каналы» (remembered), the icon flips like a slot machine.
  const switchSlot = () => {
    const next = slot === 'people' ? 'channels' : 'people';
    const from = slot === 'people' ? 0 : 1;
    reel.value = from;
    reel.value = withTiming(from + 1, { duration: 230, easing: Easing.out(Easing.cubic) }, done => { if (done) runOnJS(setSlot)(next); });

  };
  const at = (x: number) => { 'worklet'; return Math.max(0, Math.min(n - 1, Math.floor(x / Math.max(1, width / n)))); };

  const tap = Gesture.Tap().maxDuration(500)
    .onBegin(e => { pressed.value = at(e.x); })
    .onEnd(e => { runOnJS(open)(at(e.x)); })
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
  const pillInner = useAnimatedStyle(() => ({ backgroundColor: lens.value > 0.5 ? (t.dark ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.75)') : t.accentSoft, borderRadius: 25 + lens.value * 10 /* a capsule, concentric with the bar: 31 − 6 */ }));

  return <GestureDetector gesture={gesture}>
    <View collapsable={false} onLayout={e => setWidth(e.nativeEvent.layout.width)} accessibilityRole="tablist" style={{ flexDirection: 'row', alignItems: 'center', minHeight: 57 }}>
      {width ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, width: cell, padding: 2 }, pillStyle]}>
        <Animated.View style={[{ flex: 1, borderWidth: 0.5, borderColor: t.glassBorder }, pillInner]} />
      </Animated.View> : null}
      {shown.map((item, index) => { const on = index === activeIndex; const slotted = index === slotIndex; return <View key={slotted ? 'slot' : item.id} accessible accessibilityRole="tab"
        accessibilityLabel={`${item.label}${item.badge ? `, ${item.badge}` : ''}${slotted && other ? `. Смахни вверх — ${other.label}` : ''}`} accessibilityState={{ selected: on }}
        accessibilityActions={slotted ? [{ name: 'activate' }, { name: 'magicTap', label: other?.label }] : undefined}
        onAccessibilityAction={slotted ? event => { if (event.nativeEvent.actionName === 'magicTap') switchSlot(); else open(index); } : undefined}
        onAccessibilityTap={() => open(index)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 1, paddingVertical: 7, transform: [{ translateX: index === 0 ? EDGE_SHIFT : index === n - 1 ? -EDGE_SHIFT : 0 }] }}>
        {slotted && other ? <SlotReel reel={reel} people={item.id === 'people' ? item : other} channels={item.id === 'channels' ? item : other} active={on} kick={kicks[index]} pressed={pressed} index={index} /> : <>
          <TabIcon item={item} active={on} kick={kicks[index]} pressed={pressed} index={index} />
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.8} maxFontSizeMultiplier={1} style={{ maxWidth: CAPTION_MAX, fontSize: 9, lineHeight: 12, letterSpacing: -.25, color: on ? t.accent : t.muted, fontWeight: '600' }}>{item.label}</Text>
        </>}
        {/* A small hint that the slot switches: a dot (with the other section's unread count) above it. */}
        {slotted && other ? other.badge ? <View pointerEvents="none" accessibilityElementsHidden style={{ position: 'absolute', top: -2, minWidth: 18, height: 14, paddingHorizontal: 4, borderRadius: 7, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 9, fontWeight: '800' }}>{badgeText(other.badge)}</Text></View>
          : <View pointerEvents="none" style={{ position: 'absolute', top: 1, width: 14, height: 3, borderRadius: 2, backgroundColor: t.muted, opacity: .35 }} /> : null}
      </View>; })}
    </View>
  </GestureDetector>;
}
