import React, { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';

export type QuickReaction = { emoji: string; chosen: boolean };
const QUICK = 7;
// One spring for the whole menu so every part moves as one gesture (Telegram-like: fast, slight overshoot).
const OPEN = { damping: 19, stiffness: 300, mass: 0.75 } as const;
const CLOSE_MS = 170;

/**
 * Message menu in the Telegram-for-iPhone layout. Opening: the chat blurs and dims, the
 * pressed message lifts from where it was to its spot in the menu, the action list grows
 * out of the corner next to it and the reactions pop in one after another. Closing plays
 * the same motion back. Reduce motion / energy saving turns all of it into a cut.
 */
export function ContextMenu({ visible, y: liveY, x: liveX, onClose, reactions, onReact, preview, mine: liveMine = false, children }: { visible: boolean; y: number; x?: number; onClose: () => void; reactions?: QuickReaction[]; onReact?: (emoji: string) => void; preview?: string; mine?: boolean; children: React.ReactNode }) {
  const t = useTheme(); const { height, width } = useWindowDimensions(); const insets = useSafeAreaInsets();
  const [size, setSize] = useState(0); const [all, setAll] = useState(false); const [mounted, setMounted] = useState(visible);
  const shown = useSharedValue(0);
  // Keep the last content while the close animation plays (the caller clears it at once).
  const [held, setHeld] = useState({ reactions, preview, children, y: liveY, x: liveX, mine: liveMine });
  useEffect(() => { if (visible) setHeld({ reactions, preview, children, y: liveY, x: liveX, mine: liveMine }); }, [visible, reactions, preview, children, liveY, liveX, liveMine]);
  const { y, x, mine } = visible ? { y: liveY, x: liveX, mine: liveMine } : held;
  // Desktop: opened by the mouse — sits at the cursor, no blur, no preview (as Telegram Desktop).
  const atCursor = typeof x === 'number';
  useEffect(() => {
    if (visible) { setMounted(true); return; }
    if (!mounted) return;
    shown.value = withTiming(0, { duration: CLOSE_MS, easing: Easing.bezier(0.4, 0, 1, 1) }, done => { if (done) runOnJS(setMounted)(false); });
  }, [visible]);
  useEffect(() => { if (!mounted) { setSize(0); setAll(false); shown.value = 0; } }, [mounted]);
  useEffect(() => { if (visible && size) shown.value = withSpring(1, OPEN); }, [visible, size]);
  const topLimit = insets.top + 8, bottomLimit = height - insets.bottom - 8;
  const column = Math.min(atCursor ? 330 : 340, width - 24);
  const top = size ? Math.max(topLimit, Math.min(atCursor ? y - (held.reactions?.length ? 56 : 0) : y - 70, bottomLimit - size)) : topLimit;
  const side = atCursor ? { left: Math.max(8, Math.min(x! - 20, width - column - 8)) } : mine ? { right: 12 } : { left: 12 };
  const list = held.reactions || [];
  const reactionBlock = list.length ? 56 : 0;
  // How far the message travels: from the finger to its place under the reactions.
  const lift = size && !atCursor ? y - 20 - (top + reactionBlock) : 0;
  const backdrop = useAnimatedStyle(() => ({ opacity: interpolate(shown.value, [0, 1], [0, 1], 'clamp') }));
  const bubble = useAnimatedStyle(() => ({ opacity: interpolate(shown.value, [0, 0.25], [0, 1], 'clamp'), transform: [{ translateY: lift * (1 - shown.value) }, { scale: interpolate(shown.value, [0, 1], [0.96, 1]) }] }));
  const menu = useAnimatedStyle(() => ({ opacity: interpolate(shown.value, [0, 0.35], [0, 1], 'clamp'), transform: [{ scale: interpolate(shown.value, [0, 1], [0.35, 1]) }] }));
  const pill = useAnimatedStyle(() => ({ opacity: interpolate(shown.value, [0, 0.3], [0, 1], 'clamp'), transform: [{ scale: interpolate(shown.value, [0, 1], [0.55, 1]) }] }));
  // The menu follows the chat theme (black theme → near-black, coloured themes → their own tint).
  const surface = menuSurface(t);
  const shadow = { shadowColor: '#000', shadowOpacity: .28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8 };
  const corner = atCursor ? 'left' : mine ? 'right' : 'left';
  if (!mounted) return null;
  return <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
      {Platform.OS === 'web' || atCursor ? null : <BlurView intensity={30} tint={t.dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />}
      {atCursor ? null : <View style={[StyleSheet.absoluteFill, { backgroundColor: t.dark ? 'rgba(0,0,0,0.34)' : 'rgba(20,30,60,0.14)' }, Platform.OS === 'web' ? { backdropFilter: 'blur(14px)' } as object : null]} />}
      <Pressable accessibilityRole="button" accessibilityLabel="Закрыть меню" onPress={onClose} style={StyleSheet.absoluteFill} />
    </Animated.View>
    <View pointerEvents="box-none" onLayout={event => { const measured = Math.ceil(event.nativeEvent.layout.height); if (Math.abs(measured - size) > 1) setSize(measured); }}
      style={{ position: 'absolute', top, ...side, width: column, alignItems: atCursor ? 'flex-start' : mine ? 'flex-end' : 'flex-start', gap: 8, maxHeight: bottomLimit - topLimit, opacity: size ? 1 : 0 }}>
      {list.length ? <Animated.View style={[{ transformOrigin: `${corner} bottom` } as object, pill]}>{all ? <View style={{ width: column, borderRadius: 22, backgroundColor: surface, padding: 8, flexDirection: 'row', flexWrap: 'wrap', ...shadow }}>
        {list.map((item, index) => <ReactionButton key={item.emoji} item={item} index={index % 14} shown={shown} size={(column - 16) / 7} onPress={() => onReact?.(item.emoji)} />)}
      </View> : <View style={{ flexDirection: 'row', alignItems: 'center', height: 48, borderRadius: 24, backgroundColor: surface, paddingHorizontal: 4, ...shadow }}>
        {list.slice(0, QUICK).map((item, index) => <ReactionButton key={item.emoji} item={item} index={index} shown={shown} size={40} onPress={() => onReact?.(item.emoji)} />)}
        {list.length > QUICK ? <Pressable accessibilityRole="button" accessibilityLabel="Все реакции" onPress={() => setAll(true)} style={{ width: 30, height: 40, alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-down" size={18} color={t.muted} /></Pressable> : null}
      </View>}</Animated.View> : null}
      {held.preview && !atCursor ? <Animated.View style={[{ maxWidth: column, borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: mine ? t.bubble : t.incoming, ...shadow }, bubble]}><Text numberOfLines={6} style={{ color: t.text, fontSize: 16, lineHeight: 21 }}>{held.preview}</Text></Animated.View> : null}
      <Animated.View style={[{ width: 272, flexShrink: 1, minHeight: 0, borderRadius: 14, overflow: 'hidden', backgroundColor: surface, ...shadow, transformOrigin: `${corner} top` } as object, menu]}>
        <ScrollView bounces={false} style={{ flexGrow: 0 }}>{held.children}</ScrollView>
      </Animated.View>
    </View>
  </Modal>;
}

/** Each reaction pops in a beat after its left neighbour, with a small overshoot. */
function ReactionButton({ item, size, index, shown, onPress }: { item: QuickReaction; size: number; index: number; shown: SharedValue<number>; onPress: () => void }) {
  const t = useTheme();
  const pop = useSharedValue(0);
  useEffect(() => { pop.value = withDelay(40 + index * 26, withSpring(1, { damping: 11, stiffness: 320, mass: 0.6 })); }, []);
  const style = useAnimatedStyle(() => ({ opacity: Math.min(1, pop.value * 1.6) * Math.min(1, shown.value * 1.5), transform: [{ scale: interpolate(pop.value, [0, 1], [0.2, 1]) * interpolate(shown.value, [0, 1], [0.6, 1], 'clamp') }] }));
  return <Animated.View style={style}><Pressable accessibilityRole="button" accessibilityLabel={`Реакция ${item.emoji}`} accessibilityState={{ selected: item.chosen }} onPress={onPress} hitSlop={2}
    style={({ pressed }) => ({ width: size, height: Math.min(size, 40), borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: item.chosen ? t.accentSoft : 'transparent', transform: [{ scale: pressed ? 0.82 : 1 }] })}>
    <Text style={{ fontSize: 25 }}>{item.emoji}</Text>
  </Pressable></Animated.View>;
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

/**
 * Telegram's first menu row for an own, already read message: «Прочитано сегодня в 18:36».
 * Opens at once with a placeholder and fills in when the time arrives; disappears if there is none.
 */
export function ReadDateRow({ load }: { load: () => Promise<{ readAt: string | null; reason?: string }> }) {
  const t = useTheme();
  const [state, setState] = useState<{ text: string } | 'loading' | null>('loading');
  useEffect(() => {
    let alive = true;
    load().then(result => {
      if (!alive) return;
      if (result.readAt) setState({ text: readDateText(new Date(result.readAt)) });
      else if (result.reason === 'hidden') setState({ text: 'Прочитано' });
      else setState(null);
    }).catch(() => { if (alive) setState(null); });
    return () => { alive = false; };
  }, []);
  if (!state) return null;
  return <View>
    <View accessibilityRole="text" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40, paddingHorizontal: 14 }}>
      <Icon name="checkmark-done" size={19} color={t.muted} />
      {state === 'loading' ? <View style={{ height: 12, width: 150, borderRadius: 6, backgroundColor: t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)' }} />
        : <Text style={{ flex: 1, color: t.muted, fontSize: 14 }}>{state.text}</Text>}
    </View>
    <View style={{ height: 7, backgroundColor: t.dark ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.06)' }} />
  </View>;
}

export function readDateText(date: Date, now = new Date()): string {
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86400000);
  if (diff === 0) return `Прочитано сегодня в ${time}`;
  if (diff === 1) return `Прочитано вчера в ${time}`;
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `Прочитано ${date.getDate()} ${months[date.getMonth()]} в ${time}`;
}

/** Opaque menu colour from the theme background: a little lighter than the background in dark themes. */
export function menuSurface(t: { dark: boolean; bg: string }): string {
  if (!t.dark) return 'rgba(255,255,255,0.97)';
  const m = /^#?([0-9a-f]{6})$/i.exec(t.bg.trim());
  if (!m) return 'rgba(34,40,58,0.96)';
  const n = parseInt(m[1], 16), mix = (c: number) => Math.round(c + (255 - c) * 0.11);
  return `rgba(${mix(n >> 16 & 255)},${mix(n >> 8 & 255)},${mix(n & 255)},0.97)`;
}
