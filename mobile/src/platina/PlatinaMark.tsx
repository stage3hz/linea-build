import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Text } from '../typography';
import { Icon } from '../components';
import { useMotion } from '../motion';
import type { User } from '../types';

/** Platinum: cool white metal with a slow light passing over it. */
export const PLATINUM = ['#D9DEE8', '#FFFFFF', '#AEB8CA', '#F4F6FA', '#C3CBD9', '#FFFFFF'] as const;
const NAME_METAL = ['#C9D0DC', '#FFFFFF', '#9AA4B6', '#F3F5F9', '#C9D0DC', '#FFFFFF', '#9AA4B6'] as const;
export const hasPlatina = (user?: Pick<User, 'seal'> | null) => user?.seal === 'platina';

// Opening the showcase from anywhere (someone's seal, a platinum name, the settings card).
type Listener = (owner?: Pick<User, 'id' | 'displayName'>) => void;
const listeners = new Set<Listener>();
export const openPlatinaShowcase = (owner?: Pick<User, 'id' | 'displayName'>) => listeners.forEach(listener => listener(owner));
export const onPlatinaShowcase = (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function Sheen({ width, still, colors, duration = 3600 }: { width: number; still: boolean; colors: readonly string[]; duration?: number }) {
  const shift = useSharedValue(0);
  useEffect(() => {
    if (still || !width) { cancelAnimation(shift); shift.value = 0; return; }
    shift.value = 0; shift.value = withRepeat(withTiming(1, { duration, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(shift);
  }, [still, width, duration]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: -shift.value * width * 1.5 }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, width: width * 2.5 }, style]}>
    <LinearGradient colors={colors as unknown as [string, string, ...string[]]} start={{ x: 0, y: 0.3 }} end={{ x: 1, y: 0.7 }} style={StyleSheet.absoluteFill} />
  </Animated.View>;
}

/**
 * A name in platinum: the letters are a window onto moving metal. Without Platina, or on web
 * (no masking), it is ordinary text.
 */
export function PlatinaName({ user, style, numberOfLines = 1, animated = true }: { user: Pick<User, 'displayName' | 'seal'>; style?: StyleProp<TextStyle>; numberOfLines?: number; animated?: boolean }) {
  const { enabled } = useMotion(); const [width, setWidth] = useState(0);
  if (!hasPlatina(user) || Platform.OS === 'web') return <Text numberOfLines={numberOfLines} style={[style, hasPlatina(user) ? { color: '#E9EDF4' } : null]}>{user.displayName}</Text>;
  return <MaskedView style={{ flexShrink: 1 }} maskElement={<Text numberOfLines={numberOfLines} style={[style, { color: '#000' }]}>{user.displayName}</Text>}>
    <Text numberOfLines={numberOfLines} onLayout={event => setWidth(event.nativeEvent.layout.width)} style={[style, { opacity: 0 }]}>{user.displayName}</Text>
    <Sheen width={width} still={!(animated && enabled)} colors={NAME_METAL} />
  </MaskedView>;
}

/** The PLATINA seal next to a name. Tapping it opens the showcase («вот так будешь выглядеть ты»). */
export function PlatinaSeal({ size = 'md', owner, onPress }: { size?: 'sm' | 'md'; owner?: Pick<User, 'id' | 'displayName'>; onPress?: () => void }) {
  const { enabled } = useMotion(); const [width, setWidth] = useState(0);
  const small = size === 'sm';
  return <Pressable accessibilityRole="button" accessibilityLabel="Инвиз Platina" onPress={onPress || (() => openPlatinaShowcase(owner))} hitSlop={6}
    onLayout={event => setWidth(event.nativeEvent.layout.width)}
    style={({ pressed }) => ({ height: small ? 18 : 22, borderRadius: small ? 6 : 7, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: small ? 3 : 5, paddingLeft: small ? 5 : 6, paddingRight: small ? 6 : 8, transform: [{ scale: pressed ? .96 : 1 }] })}>
    <Sheen width={width} still={!enabled} colors={PLATINUM} duration={4200} />
    <Icon name="diamond" size={small ? 9 : 11} color="#1A1F2A" />
    <Text style={{ color: '#151922', fontSize: small ? 8.5 : 10.5, fontWeight: '800', letterSpacing: small ? 1 : 1.4 }}>PLATINA</Text>
  </Pressable>;
}

/** Compact mark for list rows: a small platinum gem after the name. */
export function PlatinaGem({ size = 13 }: { size?: number }) {
  return <View style={{ width: size + 4, height: size + 4, borderRadius: (size + 4) / 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
    <LinearGradient colors={PLATINUM as unknown as [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
    <Icon name="diamond" size={size * .62} color="#1A1F2A" />
  </View>;
}
