// Emoji status like Telegram Premium: tapping the badge next to your name opens a panel right under
// it — the default Platina diamond first, then the emoji grid; a tap sets the status and closes it.
import React, { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './typography';
import { useTheme } from './theme';
import { menuSurface } from './ContextMenu';
import { AnimatedEmoji } from './platina/AnimatedEmoji';
import { PlatinaGem } from './platina/PlatinaMark';
import { lightFeedback } from './haptics';

export function StatusPicker({ visible, anchorY, choices, current, platina, canSet, busy, onPick, onClose }: {
  visible: boolean; anchorY: number; choices: string[]; current: string | null; platina: boolean; canSet: boolean; busy: boolean;
  onPick: (emoji: string | null) => void; onClose: () => void;
}) {
  const t = useTheme(); const { width, height } = useWindowDimensions(); const insets = useSafeAreaInsets();
  const shown = useSharedValue(0);
  useEffect(() => { shown.value = visible ? withSpring(1, { damping: 18, stiffness: 260 }) : withTiming(0, { duration: 120 }); }, [visible]);
  const panel = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateY: (1 - shown.value) * -12 }, { scale: 0.92 + 0.08 * shown.value }] }));
  const columns = 8, side = 12, pad = 10, gap = 4;
  const cell = Math.floor((Math.min(width, 520) - side * 2 - pad * 2 - gap * (columns - 1)) / columns);
  const panelHeight = Math.min(360, height * 0.45);
  const top = Math.max(insets.top + 8, Math.min(anchorY + 14, height - insets.bottom - panelHeight - 8));
  const pick = (emoji: string | null) => { if (busy) return; lightFeedback(); onPick(emoji); };
  const Cell = ({ selected, label, onPress, disabled, children }: { selected: boolean; label: string; onPress: () => void; disabled?: boolean; children: React.ReactNode }) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ width: cell, height: cell, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? t.accentSoft : pressed ? 'rgba(127,127,127,0.15)' : 'transparent', borderWidth: selected ? 1.5 : 0, borderColor: t.accent, opacity: disabled ? .4 : 1 })}>{children}</Pressable>;
  return <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <Pressable accessibilityLabel="Закрыть" onPress={onClose} style={StyleSheet.absoluteFill} />
    <Animated.View style={[{ position: 'absolute', top, left: (width - Math.min(width, 520)) / 2 + side, width: Math.min(width, 520) - side * 2, maxHeight: panelHeight, borderRadius: 22, backgroundColor: menuSurface(t), padding: pad, shadowColor: '#000', shadowOpacity: .35, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12, transformOrigin: 'left top' } as object, panel]}>
      {!canSet ? <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center', paddingBottom: 8 }}>Статус меняется с активной Platina</Text> : null}
      <Animated.ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
          {platina ? <Cell selected={!current} label="Значок Platina по умолчанию" onPress={() => pick(null)}><PlatinaGem size={Math.round(cell * 0.5)} /></Cell> : null}
          {choices.map(emoji => <Cell key={emoji} selected={current === emoji} label={`Статус ${emoji}`} disabled={!canSet} onPress={() => pick(emoji)}><AnimatedEmoji emoji={emoji} size={Math.round(cell * 0.68)} /></Cell>)}
        </View>
      </Animated.ScrollView>
    </Animated.View>
  </Modal>;
}
