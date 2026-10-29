import React, { useEffect, useRef } from 'react';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';

/** Telegram-for-iPhone style popup: reactions on top, a compact action list, shown next to the pressed message. */
export function ContextMenu({ visible, y, onClose, reactions, preview, mine = false, children }: { visible: boolean; y: number; onClose: () => void; reactions?: React.ReactNode; preview?: string; mine?: boolean; children: React.ReactNode }) {
  const t = useTheme(); const { height, width } = useWindowDimensions(); const insets = useSafeAreaInsets();
  const scale = useRef(new Animated.Value(0.9)).current; const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) return;
    scale.setValue(0.9); opacity.setValue(0);
    Animated.parallel([Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 7 }), Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true })]).start();
  }, [visible]);
  const menuHeight = Math.min(470, height * 0.62);
  const top = Math.max(insets.top + 12, Math.min(y - 70, height - insets.bottom - menuHeight - 12));
  return <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <Pressable accessibilityRole="button" accessibilityLabel="Закрыть меню" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: t.dark ? 'rgba(0,0,0,0.5)' : 'rgba(20,30,60,0.25)' }]} />
    <Animated.View style={{ position: 'absolute', top, left: 0, width, alignItems: 'center', opacity, transform: [{ scale }] }}>
      <View style={{ width: Math.min(300, width - 32), gap: 8 }}>
        {reactions ? <View style={{ alignSelf: 'stretch', borderRadius: 26, backgroundColor: t.dark ? '#1F2638' : '#FFFFFF', paddingVertical: 6, paddingHorizontal: 6, shadowColor: '#000', shadowOpacity: .25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>{reactions}</View> : null}
        {preview ? <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '100%', borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: mine ? t.bubble : t.incoming }}><Text numberOfLines={6} style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{preview}</Text></View> : null}
        <View style={{ borderRadius: 16, overflow: 'hidden', backgroundColor: t.dark ? '#1F2638' : '#FFFFFF', maxHeight: menuHeight - 64, shadowColor: '#000', shadowOpacity: .25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
          <ScrollView bounces={false}>{children}</ScrollView>
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
