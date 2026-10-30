import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';

/** Telegram-for-iPhone style popup: reactions on top, a compact action list, shown next to the pressed message.
 * The whole menu always fits on screen: it is measured first, then placed; a long action list scrolls. */
export function ContextMenu({ visible, y, onClose, reactions, preview, mine = false, children }: { visible: boolean; y: number; onClose: () => void; reactions?: React.ReactNode; preview?: string; mine?: boolean; children: React.ReactNode }) {
  const t = useTheme(); const { height, width } = useWindowDimensions(); const insets = useSafeAreaInsets();
  const [size, setSize] = useState(0);
  const shown = useSharedValue(0);
  useEffect(() => { if (!visible) { setSize(0); shown.value = 0; } }, [visible]);
  useEffect(() => { if (visible && size) shown.value = withSpring(1, { damping: 20, stiffness: 340, mass: 0.7 }); }, [visible, size]);
  const topLimit = insets.top + 10, bottomLimit = height - insets.bottom - 10;
  const top = size ? Math.max(topLimit, Math.min(y - 80, bottomLimit - size)) : topLimit;
  const style = useAnimatedStyle(() => ({ opacity: Math.min(1, shown.value * 1.6), transform: [{ scale: 0.88 + 0.12 * shown.value }] }));
  const backdrop = useAnimatedStyle(() => ({ opacity: withTiming(shown.value > 0 ? 1 : 0, { duration: 140, easing: Easing.out(Easing.quad) }) }));
  return <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.dark ? 'rgba(0,0,0,0.5)' : 'rgba(20,30,60,0.25)' }, backdrop]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Закрыть меню" onPress={onClose} style={StyleSheet.absoluteFill} />
    </Animated.View>
    <Animated.View onLayout={event => { const measured = Math.ceil(event.nativeEvent.layout.height); if (Math.abs(measured - size) > 1) setSize(measured); }}
      style={[{ position: 'absolute', top, left: 0, width, alignItems: 'center', maxHeight: bottomLimit - topLimit }, style]}>
      <View style={{ width: Math.min(300, width - 32), gap: 8, maxHeight: bottomLimit - topLimit }}>
        {reactions ? <View style={{ alignSelf: 'stretch', borderRadius: 26, backgroundColor: t.dark ? '#1F2638' : '#FFFFFF', paddingVertical: 6, paddingHorizontal: 6, shadowColor: '#000', shadowOpacity: .25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>{reactions}</View> : null}
        {preview ? <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '100%', borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: mine ? t.bubble : t.incoming }}><Text numberOfLines={4} style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{preview}</Text></View> : null}
        <View style={{ flexShrink: 1, minHeight: 0, borderRadius: 16, overflow: 'hidden', backgroundColor: t.dark ? '#1F2638' : '#FFFFFF' }}>
          <ScrollView bounces={false} style={{ flexGrow: 0 }}>{children}</ScrollView>
        </View>
      </View>
    </Animated.View>
  </Modal>;
}

export function MenuItem({ icon, label, onPress, danger = false }: { icon: IconName; label: string; description?: string; onPress: () => void; danger?: boolean }) {
  const t = useTheme();
  return <Pressable accessibilityRole="menuitem" onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 46, paddingHorizontal: 16, backgroundColor: pressed ? (t.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)') : 'transparent', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border })}>
    <Text style={{ flex: 1, color: danger ? t.danger : t.text, fontSize: 16 }}>{label}</Text>
    <Icon name={icon} size={20} color={danger ? t.danger : t.text} />
  </Pressable>;
}
