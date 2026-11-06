// The phone tab bar, Telegram-style:
// • every tab has its own little icon animation on tap (the gear turns, the chat bubble bounces, the
//   sparkles twinkle…) and the tab presses in under the finger;
// • the selection is a pill that slides between tabs; hold the bar and drag to move the pill across the
//   tabs, let go to open the one under it;
// • «Обзор» is a folder: «Люди» and «Каналы» pop up above it.
import React, { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, FadeIn, FadeOut, ZoomIn, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
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
  const t = useTheme(); const { width: screen } = useWindowDimensions();
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
    {/* The «Обзор» folder: its two sections pop up above the tab. */}
    <Modal visible={!!folder} transparent animationType="none" onRequestClose={() => setFolder(null)} statusBarTranslucent>
      <Pressable accessibilityLabel="Закрыть" onPress={() => setFolder(null)} style={StyleSheet.absoluteFill} />
      {folder && folderItem?.children ? <Animated.View entering={ZoomIn.springify().damping(16).stiffness(240)} exiting={FadeOut.duration(120)}
        style={{ position: 'absolute', top: folder.y - 128, left: Math.max(12, Math.min(screen - 232, folder.x - 110)), width: 220, flexDirection: 'row', gap: 10 }}>
        {folderItem.children.map((child, i) => <Animated.View key={child.id} entering={FadeIn.delay(40 + i * 50)} style={{ flex: 1 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={child.label} onPress={() => { setFolder(null); lightFeedback(); child.onPress(); }}
            style={({ pressed: down }) => ({ height: 108, borderRadius: 26, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: t.glassOpaque, borderWidth: StyleSheet.hairlineWidth, borderColor: t.glassBorder, transform: [{ scale: down ? 0.94 : 1 }], shadowColor: '#000', shadowOpacity: .3, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 })}>
            <View><Icon name={child.icon} size={28} color={t.text} />{child.badge ? <View style={{ position: 'absolute', top: -6, right: -12, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 10, fontWeight: '800' }}>{badgeText(child.badge)}</Text></View> : null}</View>
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{child.label}</Text>
          </Pressable>
        </Animated.View>)}
      </Animated.View> : null}
    </Modal>
  </>;
}
