// The phone tab bar, Telegram-style:
// • every tab has its own little icon animation on tap (the gear turns, the chat bubble bounces, the
//   sparkles twinkle…) and the tab presses in under the finger;
// • the selection is a pill that slides between tabs; hold the bar and drag to move the pill across the
//   tabs, let go to open the one under it;
// • «Обзор» is a folder: «Люди» and «Каналы» fan out of it as round buttons.
import React, { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';
import { lightFeedback, tapFeedback } from './haptics';
import { badgeText } from './unreadBadge';

export type TabId = 'ai' | 'explore' | 'chats' | 'music' | 'profile';
export type TabChild = { id: 'people' | 'channels'; label: string; icon: IconName; badge: number; onPress: () => void };
export type TabItem = { id: TabId; label: string; icon: IconName; activeIcon: IconName; badge: number; onPress?: () => void; children?: TabChild[] };

const SPRING = { damping: 18, stiffness: 260, mass: 0.8 };

function TabIcon({ item, active, kick, pressed, index }: { item: TabItem; active: boolean; kick: SharedValue<number>; pressed: SharedValue<number>; index: number }) {
  const t = useTheme();
  // `kick` grows by 1 on every tap of this tab; each icon plays its own motion from it.
  const style = useAnimatedStyle(() => {
    const k = kick.value % 1; const bump = Math.sin(k * Math.PI);
    const press = pressed.value === index ? 0.84 : 1;
    if (item.id === 'profile') return { transform: [{ scale: press }, { rotate: `${kick.value * 120}deg` }] }; // the gear turns a third
    if (item.id === 'explore') return { transform: [{ scale: press }, { rotate: `${kick.value * 360}deg` }] }; // the compass spins
    if (item.id === 'chats') return { transform: [{ translateY: -bump * 4 }, { scale: press * (1 + bump * 0.22) }] }; // bounce
    if (item.id === 'music') return { transform: [{ scale: press }, { rotate: `${Math.sin(k * Math.PI * 3) * 14 * (1 - k)}deg` }] }; // headphones wiggle
    return { transform: [{ scale: press * (1 + bump * 0.3) }, { rotate: `${Math.sin(k * Math.PI * 2) * 18}deg` }] }; // sparkles twinkle
  });
  return <Animated.View style={style}>
    <Icon name={active ? item.activeIcon : item.icon} size={22} color={active ? t.accent : t.muted} />
    {item.badge ? <View style={{ position: 'absolute', top: -6, left: 13, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, borderWidth: 2, borderColor: t.dark ? '#15171D' : '#FFF', backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 10, fontWeight: '800' }}>{badgeText(item.badge)}</Text></View> : null}
  </Animated.View>;
}

export function TabBar({ items, active }: { items: TabItem[]; active: TabId }) {
  const t = useTheme();
  const [width, setWidth] = useState(0); const [folder, setFolder] = useState<{ x: number; y: number } | null>(null);
  const barRef = useRef<View>(null);
  const n = items.length; const cell = width / Math.max(1, n);
  const activeIndex = Math.max(0, items.findIndex(item => item.id === active));
  const pill = useSharedValue(activeIndex); const dragging = useSharedValue(0); const pressed = useSharedValue(-1);
  const k0 = useSharedValue(0), k1 = useSharedValue(0), k2 = useSharedValue(0), k3 = useSharedValue(0), k4 = useSharedValue(0), k5 = useSharedValue(0);
  const kicks = [k0, k1, k2, k3, k4, k5];
  React.useEffect(() => { if (!dragging.value) pill.value = withSpring(activeIndex, SPRING); }, [activeIndex]);

  const open = (index: number) => {
    const item = items[index]; if (!item) return;
    const kick = kicks[index];
    kick.value = withTiming(Math.floor(kick.value) + 1, { duration: item.id === 'profile' || item.id === 'explore' ? 520 : 460, easing: Easing.out(Easing.cubic) });
    tapFeedback();
    if (item.children) { barRef.current?.measureInWindow((x, y) => setFolder({ x: x + (width / n) * (index + 0.5), y })); return; }
    item.onPress?.();
  };

  const tap = Gesture.Tap().maxDuration(450)
    .onBegin(e => { pressed.value = Math.max(0, Math.min(n - 1, Math.floor(e.x / Math.max(1, width / n)))); })
    .onEnd(e => { runOnJS(open)(Math.max(0, Math.min(n - 1, Math.floor(e.x / Math.max(1, width / n))))); })
    .onFinalize(() => { pressed.value = -1; });
  // Telegram: hold the bar and slide — the pill follows the finger; letting go opens that tab.
  const drag = Gesture.Pan().activateAfterLongPress(220)
    .onStart(e => { dragging.value = 1; pressed.value = -1; pill.value = withSpring(Math.max(0, Math.min(n - 1, Math.floor(e.x / Math.max(1, width / n)))), SPRING); runOnJS(lightFeedback)(); })
    .onUpdate(e => { pill.value = Math.max(0, Math.min(n - 1, e.x / Math.max(1, width / n) - 0.5)); })
    .onEnd(e => { const index = Math.max(0, Math.min(n - 1, Math.floor(e.x / Math.max(1, width / n)))); pill.value = withSpring(index, SPRING); runOnJS(open)(index); })
    .onFinalize(() => { dragging.value = 0; });
  const gesture = Gesture.Exclusive(drag, tap);

  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pill.value * cell }, { scale: withSpring(dragging.value ? 1.08 : 1, SPRING) }] }));
  const folderItem = items.find(item => item.children);

  return <>
    <GestureDetector gesture={gesture}>
      <View ref={barRef} collapsable={false} onLayout={e => setWidth(e.nativeEvent.layout.width)} accessibilityRole="tablist" style={{ flexDirection: 'row', alignItems: 'center', minHeight: 54 }}>
        {width ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, bottom: 0, width: cell, padding: 2 }, pillStyle]}>
          <View style={{ flex: 1, borderRadius: 22, backgroundColor: t.accentSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: t.glassBorder }} />
        </Animated.View> : null}
        {items.map((item, index) => { const on = index === activeIndex; return <View key={item.id} accessible accessibilityRole="tab" accessibilityLabel={item.badge ? `${item.label}, ${item.badge}` : item.label} accessibilityState={{ selected: on }}
          onAccessibilityTap={() => open(index)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6 }}>
          <TabIcon item={item} active={on} kick={kicks[index]} pressed={pressed} index={index} />
          <Text numberOfLines={1} maxFontSizeMultiplier={1} style={{ fontSize: 10, letterSpacing: -.1, color: on ? t.accent : t.muted, fontWeight: on ? '700' : '600' }}>{item.label}</Text>
        </View>; })}
      </View>
    </GestureDetector>
    {/* The «Обзор» folder: its sections fan out of the tab as round buttons, up-left and up-right. */}
    <Modal visible={!!folder} transparent animationType="none" onRequestClose={() => setFolder(null)} statusBarTranslucent>
      <Pressable accessibilityLabel="Закрыть" onPress={() => setFolder(null)} style={StyleSheet.absoluteFill} />
      {folder && folderItem?.children ? folderItem.children.map((child, i) => <FanButton key={child.id} child={child} index={i} count={folderItem.children!.length} origin={folder} onPress={() => { setFolder(null); lightFeedback(); child.onPress(); }} />) : null}
    </Modal>
  </>;
}

/** One section of the folder: flies out of the tab on an arc and lands as a round glass button with a label. */
function FanButton({ child, index, count, origin, onPress }: { child: TabChild; index: number; count: number; origin: { x: number; y: number }; onPress: () => void }) {
  const t = useTheme(); const out = useSharedValue(0);
  React.useEffect(() => { out.value = withDelay(index * 45, withSpring(1, { damping: 13, stiffness: 230, mass: 0.7 })); }, []);
  const size = 56; const spread = count > 1 ? (index / (count - 1)) * 2 - 1 : 0; // -1 (left) … 1 (right)
  const dx = spread * 46, dy = -(86 - Math.abs(spread) * 14); // an arc above the tab
  const style = useAnimatedStyle(() => ({ opacity: Math.min(1, out.value * 1.5), transform: [{ translateX: dx * out.value }, { translateY: dy * out.value }, { scale: 0.3 + 0.7 * out.value }] }));
  return <Animated.View style={[{ position: 'absolute', left: origin.x - size / 2, top: origin.y - size / 2 + 6, width: size, alignItems: 'center' }, style]}>
    <Pressable accessibilityRole="button" accessibilityLabel={child.label} onPress={onPress} style={({ pressed }) => ({ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: t.glassOpaque, borderWidth: StyleSheet.hairlineWidth, borderColor: t.glassBorder, transform: [{ scale: pressed ? 0.9 : 1 }], shadowColor: '#000', shadowOpacity: .35, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10 })}>
      <Icon name={child.icon} size={24} color={t.text} />
      {child.badge ? <View style={{ position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 10, fontWeight: '800' }}>{badgeText(child.badge)}</Text></View> : null}
    </Pressable>
    <Text maxFontSizeMultiplier={1} style={{ color: t.text, fontSize: 11, fontWeight: '600', marginTop: 4, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 }}>{child.label}</Text>
  </Animated.View>;
}
