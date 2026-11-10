// Emoji status like Telegram Premium: tapping the badge next to your name opens a panel right under
// it — the default Platina diamond first, then the emoji grid; a tap sets the status and closes it.
import React, { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './typography';
import { useTheme } from './theme';
import { menuSurface } from './ContextMenu';
import { AnimatedEmoji, preloadAnimatedEmoji } from './platina/AnimatedEmoji';
import { PlatinaGem } from './platina/PlatinaMark';
import { lightFeedback } from './haptics';

export function StatusPicker({ visible, anchorY, choices, current, platina, canSet, busy, onPick, onClose }: {
  visible: boolean; anchorY: number; choices: string[]; current: string | null; platina: boolean; canSet: boolean; busy: boolean;
  onPick: (emoji: string | null) => void; onClose: () => void;
}) {
  const t = useTheme(); const { width, height } = useWindowDimensions(); const insets = useSafeAreaInsets();
  // The panel is mounted with the profile (hidden), so the grid's animations load before it opens.
  useEffect(() => { preloadAnimatedEmoji(choices); }, [choices.join('')]);
  // Opens opaque from its first frame (Telegram): only a short slide, no fade-in and no scale — a
  // fading panel let the profile card's text show through it, and scaling (with spring overshoot past
  // 1) stretched the already-rendered emoji bitmaps. Closing still fades out quickly.
  const shown = useSharedValue(0), alpha = useSharedValue(0);
  useEffect(() => {
    if (visible) { alpha.value = 1; shown.value = withTiming(1, { duration: 160, easing: Easing.out(Easing.cubic) }); }
    else { alpha.value = withTiming(0, { duration: 120 }); shown.value = withTiming(0, { duration: 120 }); }
  }, [visible]);
  const panel = useAnimatedStyle(() => ({ opacity: alpha.value, transform: [{ translateY: Math.round((1 - shown.value) * -8) }] }));
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
    <Animated.View style={[{ position: 'absolute', top, left: (width - Math.min(width, 520)) / 2 + side, width: Math.min(width, 520) - side * 2, maxHeight: panelHeight, borderRadius: 22, backgroundColor: opaque(menuSurface(t)), padding: pad, shadowColor: '#000', shadowOpacity: .35, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12 } as object, panel]}>
      {!canSet ? <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center', paddingBottom: 8 }}>Статус меняется с активной Platina</Text> : null}
      <Animated.ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
          {platina ? <Cell selected={!current} label="Значок Platina по умолчанию" onPress={() => pick(null)}><PlatinaGem size={Math.round(cell * 0.5)} /></Cell> : null}
          {choices.map(emoji => <Cell key={emoji} selected={current === emoji} label={`Статус ${emoji}`} disabled={!canSet} onPress={() => pick(emoji)}><AnimatedEmoji emoji={emoji} size={Math.round(cell * 0.68)} mode="still" /></Cell>)}
        </View>
      </Animated.ScrollView>
    </Animated.View>
  </Modal>;
}

/** menuSurface is 96–97% opaque; the picker sits over the profile card's text, so drop the alpha. */
function opaque(color: string): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)$/.exec(color);
  return m ? `rgb(${m[1]},${m[2]},${m[3]})` : color;
}
