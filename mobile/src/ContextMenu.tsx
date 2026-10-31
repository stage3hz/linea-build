import React, { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';

export type QuickReaction = { emoji: string; chosen: boolean };
const QUICK = 7;

/**
 * Message menu in the Telegram-for-iPhone layout: the chat behind blurs, the pressed message is
 * shown at its own side, above it a compact reaction pill (a chevron opens every reaction),
 * below it a narrow action list. Opens and closes in about 0.18 s; it always fits on screen.
 */
export function ContextMenu({ visible, y, onClose, reactions, onReact, preview, mine = false, children }: { visible: boolean; y: number; onClose: () => void; reactions?: QuickReaction[]; onReact?: (emoji: string) => void; preview?: string; mine?: boolean; children: React.ReactNode }) {
  const t = useTheme(); const { height, width } = useWindowDimensions(); const insets = useSafeAreaInsets();
  const [size, setSize] = useState(0); const [all, setAll] = useState(false);
  const shown = useSharedValue(0);
  useEffect(() => { if (!visible) { setSize(0); setAll(false); shown.value = 0; } }, [visible]);
  useEffect(() => { if (visible && size) shown.value = withTiming(1, { duration: 180, easing: Easing.bezier(0.2, 0, 0, 1) }); }, [visible, size]);
  const topLimit = insets.top + 8, bottomLimit = height - insets.bottom - 8;
  const top = size ? Math.max(topLimit, Math.min(y - 70, bottomLimit - size)) : topLimit;
  const column = Math.min(340, width - 24);
  const side = mine ? { right: 12 } : { left: 12 };
  const style = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: 0.92 + 0.08 * shown.value }] }));
  const backdrop = useAnimatedStyle(() => ({ opacity: shown.value }));
  const surface = t.dark ? 'rgba(34,40,58,0.96)' : 'rgba(255,255,255,0.97)';
  const shadow = { shadowColor: '#000', shadowOpacity: .28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8 };
  const list = reactions || [];
  return <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
      {Platform.OS === 'web' ? null : <BlurView intensity={28} tint={t.dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: t.dark ? 'rgba(0,0,0,0.32)' : 'rgba(20,30,60,0.12)' }]} />
      <Pressable accessibilityRole="button" accessibilityLabel="Закрыть меню" onPress={onClose} style={StyleSheet.absoluteFill} />
    </Animated.View>
    <Animated.View onLayout={event => { const measured = Math.ceil(event.nativeEvent.layout.height); if (Math.abs(measured - size) > 1) setSize(measured); }}
      style={[{ position: 'absolute', top, ...side, width: column, alignItems: mine ? 'flex-end' : 'flex-start', gap: 8, maxHeight: bottomLimit - topLimit }, style]}>
      {list.length ? all ? <View style={{ width: column, borderRadius: 22, backgroundColor: surface, padding: 8, flexDirection: 'row', flexWrap: 'wrap', ...shadow }}>
        {list.map(item => <ReactionButton key={item.emoji} item={item} size={(column - 16) / 7} onPress={() => onReact?.(item.emoji)} />)}
      </View> : <View style={{ flexDirection: 'row', alignItems: 'center', height: 48, borderRadius: 24, backgroundColor: surface, paddingHorizontal: 4, ...shadow }}>
        {list.slice(0, QUICK).map(item => <ReactionButton key={item.emoji} item={item} size={40} onPress={() => onReact?.(item.emoji)} />)}
        {list.length > QUICK ? <Pressable accessibilityRole="button" accessibilityLabel="Все реакции" onPress={() => setAll(true)} style={{ width: 30, height: 40, alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-down" size={18} color={t.muted} /></Pressable> : null}
      </View> : null}
      {preview ? <View style={{ maxWidth: column, borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: mine ? t.bubble : t.incoming, ...shadow }}><Text numberOfLines={6} style={{ color: t.text, fontSize: 16, lineHeight: 21 }}>{preview}</Text></View> : null}
      <View style={{ width: 256, flexShrink: 1, minHeight: 0, borderRadius: 14, overflow: 'hidden', backgroundColor: surface, ...shadow }}>
        <ScrollView bounces={false} style={{ flexGrow: 0 }}>{children}</ScrollView>
      </View>
    </Animated.View>
  </Modal>;
}

function ReactionButton({ item, size, onPress }: { item: QuickReaction; size: number; onPress: () => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={`Реакция ${item.emoji}`} accessibilityState={{ selected: item.chosen }} onPress={onPress} hitSlop={2}
    style={({ pressed }) => ({ width: size, height: Math.min(size, 40), borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: item.chosen ? t.accentSoft : 'transparent', transform: [{ scale: pressed ? 0.9 : 1 }] })}>
    <Text style={{ fontSize: 25 }}>{item.emoji}</Text>
  </Pressable>;
}

/** One action: icon on the left, as in Telegram. `separated` puts a thick gap above it (destructive group). */
export function MenuItem({ icon, label, onPress, danger = false, separated = false }: { icon: IconName; label: string; description?: string; onPress: () => void; danger?: boolean; separated?: boolean }) {
  const t = useTheme();
  return <View>
    {separated ? <View style={{ height: 7, backgroundColor: t.dark ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.06)' }} /> : null}
    <Pressable accessibilityRole="menuitem" onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 42, paddingHorizontal: 14, backgroundColor: pressed ? (t.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)') : 'transparent' })}>
      <Icon name={icon} size={19} color={danger ? t.danger : t.text} />
      <Text style={{ flex: 1, color: danger ? t.danger : t.text, fontSize: 15.5 }}>{label}</Text>
    </Pressable>
  </View>;
}
