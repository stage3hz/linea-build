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
import { type IconName } from './components';
import { Ionicons } from '@expo/vector-icons';
// Every tab icon sits in the same 22×22 box with a 22-pt line: an icon-font glyph otherwise gets a
// taller line on iOS and is drawn lower than its box, so the drawn gear looked higher than the rest.
import { useTheme } from './theme';
import { badgeText } from './unreadBadge';
import Svg, { Circle, Defs, LinearGradient as SvgGradient, Path, Stop } from 'react-native-svg';

// The settings gear in the manner of the iPhone «Settings» icon, drawn here: a ring with fine teeth, a
// darker gear inside it and three curved spokes to the hub. In the theme colours (see GearIcon).
//
const GEAR = (() => {
  const c = 12; const at = (r: number, deg: number) => { const a = (deg - 90) * Math.PI / 180; return `${(c + r * Math.cos(a)).toFixed(3)} ${(c + r * Math.sin(a)).toFixed(3)}`; };
  const teeth = (n: number, outer: number, root: number) => { const step = 360 / n; const points: string[] = [];
    for (let i = 0; i < n; i++) { const a = i * step; points.push(at(root, a - step / 4), at(outer, a - step * 0.16), at(outer, a + step * 0.16), at(root, a + step / 4)); }
    return `M${points.join(' L')} Z`; };
  const circle = (r: number) => `M${c + r} ${c} A${r} ${r} 0 1 0 ${c - r} ${c} A${r} ${r} 0 1 0 ${c + r} ${c} Z`;
  const spokes = [0, 120, 240].map(a => `M${at(1.4, a + 20)} Q${at(5.2, a + 35)} ${at(9.2, a + 18)}`).join(' ');
  return { ring: `${teeth(32, 11.6, 10.5)} ${circle(8.7)}`, inner: `${teeth(22, 7.6, 6.8)} ${circle(5.4)}`, spokes };
})();
function GearIcon({ size, active, accent, muted }: { size: number; active: boolean; accent: string; muted: string }) {
  // In the theme's own colours like the other tab icons: the muted tone when not selected (it was a fixed
  // silver that clashed with the coloured palettes), the accent when selected; the inner gear is fainter.
  const id = active ? 'gearOn' : 'gearOff'; const color = active ? accent : muted;
  return <Svg width={size} height={size} viewBox="0 0 24 24">
    <Defs><SvgGradient id={id} x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={color} stopOpacity={1} /><Stop offset="1" stopColor={color} stopOpacity={0.78} /></SvgGradient></Defs>
    <Path d={GEAR.inner} fill={color} fillOpacity={0.45} fillRule="evenodd" />
    <Path d={GEAR.ring} fill={`url(#${id})`} fillRule="evenodd" />
    <Path d={GEAR.spokes} fill="none" stroke={`url(#${id})`} strokeWidth={1.3} strokeLinecap="round" />
    <Circle cx={12} cy={12} r={1.9} fill={`url(#${id})`} />
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

function TabIcon({ item, active, kick, pressed, index }: { item: TabItem; active: boolean; kick: SharedValue<number>; pressed: SharedValue<number>; index: number }) {
  const t = useTheme();
  // `kick` grows by 1 on every tap of this tab; each icon plays its own motion from it.
  const style = useAnimatedStyle(() => {
    const k = kick.value % 1; const bump = Math.sin(k * Math.PI);
    const press = pressed.value === index ? 0.84 : 1;
    if (item.id === 'profile') return { transform: [{ scale: press }, { rotate: `${kick.value * 120}deg` }] };
    if (item.id === 'people' || item.id === 'channels') return { transform: [{ scale: press * (1 + bump * 0.2) }, { rotate: `${Math.sin(k * Math.PI * 2) * 10}deg` }] };
    if (item.id === 'chats') return { transform: [{ translateY: -bump * 4 }, { scale: press * (1 + bump * 0.22) }] };
    if (item.id === 'music') return { transform: [{ scale: press }, { rotate: `${Math.sin(k * Math.PI * 3) * 14 * (1 - k)}deg` }] };
    return { transform: [{ scale: press * (1 + bump * 0.3) }, { rotate: `${Math.sin(k * Math.PI * 2) * 18}deg` }] };
  });
  return <Animated.View style={style}>
    {item.id === 'profile' ? <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}><GearIcon size={36} active={active} accent={t.accent} muted={t.muted} /></View> : <Ionicons name={active ? item.activeIcon : item.icon} size={22} color={active ? t.accent : t.muted} style={{ width: 22, height: 22, lineHeight: 22, textAlign: 'center' }} />}
    {item.badge ? <View style={{ position: 'absolute', top: -6, left: 13, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, borderWidth: 2, borderColor: t.dark ? '#15171D' : '#FFF', backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 10, fontWeight: '800' }}>{badgeText(item.badge)}</Text></View> : null}
  </Animated.View>;
}

const REEL = 40; // one carousel row: icon + label

/** «Люди» / «Каналы» as a vertical carousel: rows [Люди, Каналы, Люди] rolled by `reel` (0 → 1 → 2). */
function SlotReel({ reel, people, channels, active, kick, pressed, index }: { reel: SharedValue<number>; people: TabItem; channels: TabItem; active: boolean; kick: SharedValue<number>; pressed: SharedValue<number>; index: number }) {
  const t = useTheme();
  const roll = useAnimatedStyle(() => ({ transform: [{ translateY: -reel.value * REEL }] }));
  const row = (item: TabItem, key: string) => <View key={key} style={{ height: REEL, alignItems: 'center', justifyContent: 'center', gap: 4 }}>
    <TabIcon item={item} active={active} kick={kick} pressed={pressed} index={index} />
    <Text numberOfLines={1} maxFontSizeMultiplier={1} style={{ fontSize: 10, lineHeight: 12, letterSpacing: -.1, color: active ? t.accent : t.muted, fontWeight: active ? '700' : '600' }}>{item.label}</Text>
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
  const pill = useSharedValue(activeIndex); const lens = useSharedValue(0); const pressed = useSharedValue(-1);
  // The slot is a vertical carousel [Люди, Каналы, Люди]: a swipe always plays the same quick roll up.
  const reel = useSharedValue(current === 'channels' ? 1 : 0);
  useEffect(() => { reel.value = current === 'channels' ? 1 : 0; }, [current]);
  const k0 = useSharedValue(0), k1 = useSharedValue(0), k2 = useSharedValue(0), k3 = useSharedValue(0), k4 = useSharedValue(0), k5 = useSharedValue(0);
  const kicks = [k0, k1, k2, k3, k4, k5];
  useEffect(() => { if (!lens.value) pill.value = withSpring(activeIndex, SPRING); }, [activeIndex]);

  const open = (index: number) => {
    const item = shown[index]; if (!item) return;
    const kick = kicks[index];
    // Longer and smoother: the gear turns with a soft overshoot (~0.75 s), the others play over ~0.65 s.
    kick.value = withTiming(Math.floor(kick.value) + 1, item.id === 'profile' ? { duration: 760, easing: Easing.out(Easing.back(1.7)) } : { duration: 650, easing: Easing.out(Easing.quad) });
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

  const pillStyle = useAnimatedStyle(() => ({ top: 2 - lens.value * 9, bottom: 2 - lens.value * 9, transform: [{ translateX: pill.value * cell }, { scale: 1 + lens.value * 0.12 }] }));
  const pillInner = useAnimatedStyle(() => ({ backgroundColor: lens.value > 0.5 ? (t.dark ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.75)') : t.accentSoft, borderRadius: 22 + lens.value * 10 }));

  return <GestureDetector gesture={gesture}>
    <View collapsable={false} onLayout={e => setWidth(e.nativeEvent.layout.width)} accessibilityRole="tablist" style={{ flexDirection: 'row', alignItems: 'center', minHeight: 54 }}>
      {width ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, width: cell, padding: 2 }, pillStyle]}>
        <Animated.View style={[{ flex: 1, borderWidth: 0.5, borderColor: t.glassBorder }, pillInner]} />
      </Animated.View> : null}
      {shown.map((item, index) => { const on = index === activeIndex; const slotted = index === slotIndex; return <View key={slotted ? 'slot' : item.id} accessible accessibilityRole="tab"
        accessibilityLabel={`${item.label}${item.badge ? `, ${item.badge}` : ''}${slotted && other ? `. Смахни вверх — ${other.label}` : ''}`} accessibilityState={{ selected: on }}
        accessibilityActions={slotted ? [{ name: 'activate' }, { name: 'magicTap', label: other?.label }] : undefined}
        onAccessibilityAction={slotted ? event => { if (event.nativeEvent.actionName === 'magicTap') switchSlot(); else open(index); } : undefined}
        onAccessibilityTap={() => open(index)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6 }}>
        {slotted && other ? <SlotReel reel={reel} people={item.id === 'people' ? item : other} channels={item.id === 'channels' ? item : other} active={on} kick={kicks[index]} pressed={pressed} index={index} /> : <>
          <TabIcon item={item} active={on} kick={kicks[index]} pressed={pressed} index={index} />
          {/* The gear has no caption: it spans from the icons' top to the captions' bottom (measured ≈34 pt), so it stands level with them and in the middle of the bar. */}
          {item.id === 'profile' ? null : <Text numberOfLines={1} maxFontSizeMultiplier={1} style={{ fontSize: 10, lineHeight: 12, letterSpacing: -.1, color: on ? t.accent : t.muted, fontWeight: on ? '700' : '600' }}>{item.label}</Text>}
        </>}
        {/* A small hint that the slot switches: a dot (with the other section's unread count) above it. */}
        {slotted && other ? other.badge ? <View pointerEvents="none" accessibilityElementsHidden style={{ position: 'absolute', top: -2, minWidth: 18, height: 14, paddingHorizontal: 4, borderRadius: 7, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 9, fontWeight: '800' }}>{badgeText(other.badge)}</Text></View>
          : <View pointerEvents="none" style={{ position: 'absolute', top: 1, width: 14, height: 3, borderRadius: 2, backgroundColor: t.muted, opacity: .35 }} /> : null}
      </View>; })}
    </View>
  </GestureDetector>;
}
