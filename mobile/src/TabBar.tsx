// The phone tab bar, Telegram-style:
// • every tab has its own little icon animation on tap (the gear turns, the chat bubble bounces, the
//   sparkles twinkle…) and the tab presses in under the finger;
// • the selection is a pill; put a finger on the bar and slide (no need to lift or wait) — it becomes a
//   larger lens that follows the finger, letting go opens the tab under it;
// • one slot holds «Люди» or «Каналы»: swipe up on it to switch; the choice is remembered and stays
//   in the bar until switched back. (Tablets and PC show both in their rail.)
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';
import { impactFeedback, lightFeedback, tapFeedback } from './haptics';
import { badgeText } from './unreadBadge';

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

function TabIcon({ item, active, kick, pressed, index, flip }: { item: TabItem; active: boolean; kick: SharedValue<number>; pressed: SharedValue<number>; index: number; flip?: SharedValue<number> }) {
  const t = useTheme();
  // `kick` grows by 1 on every tap of this tab; each icon plays its own motion from it.
  const style = useAnimatedStyle(() => {
    const k = kick.value % 1; const bump = Math.sin(k * Math.PI);
    const press = pressed.value === index ? 0.84 : 1;
    const lift = flip ? flip.value : 0; // the slot switching: old icon slides up, the new one comes from below
    const slide = [{ translateY: lift }];
    if (item.id === 'profile') return { transform: [{ scale: press }, { rotate: `${kick.value * 120}deg` }] };
    if (item.id === 'people' || item.id === 'channels') return { opacity: 1 - Math.min(1, Math.abs(lift) / 14), transform: [...slide, { scale: press * (1 + bump * 0.2) }, { rotate: `${Math.sin(k * Math.PI * 2) * 10}deg` }] };
    if (item.id === 'chats') return { transform: [{ translateY: -bump * 4 }, { scale: press * (1 + bump * 0.22) }] };
    if (item.id === 'music') return { transform: [{ scale: press }, { rotate: `${Math.sin(k * Math.PI * 3) * 14 * (1 - k)}deg` }] };
    return { transform: [{ scale: press * (1 + bump * 0.3) }, { rotate: `${Math.sin(k * Math.PI * 2) * 18}deg` }] };
  });
  return <Animated.View style={style}>
    <Icon name={active ? item.activeIcon : item.icon} size={22} color={active ? t.accent : t.muted} />
    {item.badge ? <View style={{ position: 'absolute', top: -6, left: 13, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, borderWidth: 2, borderColor: t.dark ? '#15171D' : '#FFF', backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 10, fontWeight: '800' }}>{badgeText(item.badge)}</Text></View> : null}
  </Animated.View>;
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
  const pill = useSharedValue(activeIndex); const lens = useSharedValue(0); const pressed = useSharedValue(-1); const flip = useSharedValue(0);
  const k0 = useSharedValue(0), k1 = useSharedValue(0), k2 = useSharedValue(0), k3 = useSharedValue(0), k4 = useSharedValue(0), k5 = useSharedValue(0);
  const kicks = [k0, k1, k2, k3, k4, k5];
  useEffect(() => { if (!lens.value) pill.value = withSpring(activeIndex, SPRING); }, [activeIndex]);

  const open = (index: number) => {
    const item = shown[index]; if (!item) return;
    const kick = kicks[index];
    kick.value = withTiming(Math.floor(kick.value) + 1, { duration: item.id === 'profile' ? 520 : 460, easing: Easing.out(Easing.cubic) });
    tapFeedback(); item.onPress();
  };
  // Swipe up on the slot: «Люди» ⇄ «Каналы» (remembered), the icon flips like a slot machine.
  const switchSlot = () => {
    flip.value = withSequence(withTiming(-16, { duration: 110, easing: Easing.in(Easing.quad) }), withTiming(16, { duration: 0 }), withSpring(0, { damping: 18, stiffness: 340, mass: 0.6 }));
    impactFeedback();
    setTimeout(() => setSlot(slot === 'people' ? 'channels' : 'people'), 110);
  };
  const at = (x: number) => { 'worklet'; return Math.max(0, Math.min(n - 1, Math.floor(x / Math.max(1, width / n)))); };

  const tap = Gesture.Tap().maxDuration(500)
    .onBegin(e => { pressed.value = at(e.x); })
    .onEnd(e => { runOnJS(open)(at(e.x)); })
    .onFinalize(() => { pressed.value = -1; });
  // Telegram: put a finger down and slide — no waiting; the pill turns into a bigger lens under the finger.
  const slide = Gesture.Pan().activeOffsetX([-8, 8]).failOffsetY([-24, 24])
    .onStart(() => { lens.value = withSpring(1, SPRING); pressed.value = -1; runOnJS(lightFeedback)(); })
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
        <TabIcon item={item} active={on} kick={kicks[index]} pressed={pressed} index={index} flip={slotted ? flip : undefined} />
        <Text numberOfLines={1} maxFontSizeMultiplier={1} style={{ fontSize: 10, letterSpacing: -.1, color: on ? t.accent : t.muted, fontWeight: on ? '700' : '600' }}>{item.label}</Text>
        {/* A small hint that the slot switches: a dot (with the other section's unread count) above it. */}
        {slotted && other ? <View pointerEvents="none" style={{ position: 'absolute', top: 1, width: 14, height: 3, borderRadius: 2, backgroundColor: other.badge ? t.accent : t.muted, opacity: other.badge ? 1 : .35 }} /> : null}
      </View>; })}
    </View>
  </GestureDetector>;
}
