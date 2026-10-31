import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import { useMotion } from '../motion';

/** Discord-style profile effects: particles over the top of a profile while it is open. */
export const PROFILE_EFFECTS: { id: string; label: string }[] = [
  { id: 'snow', label: 'Снег' }, { id: 'sparks', label: 'Искры' }, { id: 'petals', label: 'Лепестки' },
  { id: 'bubbles', label: 'Пузырьки' }, { id: 'stars', label: 'Звёзды' }, { id: 'embers', label: 'Угольки' },
];
type Kind = { count: number; rise: boolean; colors: string[]; size: [number, number]; duration: [number, number]; shape: 'dot' | 'star' | 'petal' | 'ring'; twinkle?: boolean };
const KINDS: Record<string, Kind> = {
  snow: { count: 22, rise: false, colors: ['#FFFFFF', '#E6F0FF'], size: [3, 7], duration: [5200, 9000], shape: 'dot' },
  sparks: { count: 16, rise: true, colors: ['#FFF4C2', '#FFFFFF', '#FFD86B'], size: [6, 11], duration: [3200, 5200], shape: 'star', twinkle: true },
  petals: { count: 14, rise: false, colors: ['#FFB8CF', '#FFD3E1', '#FF9DBB'], size: [7, 11], duration: [6000, 9500], shape: 'petal' },
  bubbles: { count: 14, rise: true, colors: ['rgba(170,220,255,0.9)', 'rgba(255,255,255,0.8)'], size: [8, 18], duration: [5000, 8500], shape: 'ring' },
  stars: { count: 20, rise: false, colors: ['#FFFFFF', '#CFE0FF', '#FFF2C7'], size: [5, 9], duration: [1800, 3400], shape: 'star', twinkle: true },
  embers: { count: 18, rise: true, colors: ['#FF8A3D', '#FFB347', '#FF5A36'], size: [3, 6], duration: [3600, 6400], shape: 'dot' },
};
// Deterministic pseudo-random so a profile looks the same each time it opens.
const rand = (seed: number) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };

function Particle({ kind, index, width, height, still }: { kind: Kind; index: number; width: number; height: number; still: boolean }) {
  const r = (n: number) => rand(index * 7 + n);
  const size = kind.size[0] + r(1) * (kind.size[1] - kind.size[0]);
  const x = r(2) * (width - size); const sway = 8 + r(3) * 18;
  const duration = kind.duration[0] + r(4) * (kind.duration[1] - kind.duration[0]);
  const color = kind.colors[Math.floor(r(5) * kind.colors.length)];
  const progress = useSharedValue(still ? r(6) : 0);
  useEffect(() => {
    if (still) { cancelAnimation(progress); return; }
    progress.value = 0;
    progress.value = withDelay(Math.round(r(6) * duration), withRepeat(withTiming(1, { duration, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(progress);
  }, [still]);
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    const y = kind.rise ? height - p * (height + size * 2) : -size + p * (height + size * 2);
    const fade = kind.twinkle ? 0.25 + 0.75 * Math.abs(Math.sin(p * Math.PI * 3)) : Math.min(1, p * 6, (1 - p) * 4);
    return { opacity: fade, transform: [{ translateX: x + Math.sin(p * Math.PI * 2) * sway }, { translateY: y }, { rotate: `${p * 360 * (kind.shape === 'petal' ? 1 : 0)}deg` }] };
  });
  const body = kind.shape === 'ring' ? { borderWidth: 1.2, borderColor: color, borderRadius: size }
    : kind.shape === 'petal' ? { backgroundColor: color, borderTopLeftRadius: size, borderBottomRightRadius: size, borderTopRightRadius: 2, borderBottomLeftRadius: 2 }
    : kind.shape === 'star' ? { backgroundColor: color, borderRadius: 1.5, transform: [{ rotate: '45deg' }] }
    : { backgroundColor: color, borderRadius: size };
  return <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: size, height: kind.shape === 'petal' ? size * 0.7 : size, shadowColor: color, shadowOpacity: kind.shape === 'dot' ? 0.6 : 0.9, shadowRadius: size, shadowOffset: { width: 0, height: 0 } }, style]}>
    <View style={[StyleSheet.absoluteFill, body]} />
  </Animated.View>;
}

/** Plays over the top part of an open profile. Off when motion is reduced. */
export function ProfileEffect({ effect, width, height }: { effect?: string | null; width: number; height: number }) {
  const { enabled } = useMotion();
  const kind = effect ? KINDS[effect] : undefined;
  const items = useMemo(() => kind ? Array.from({ length: kind.count }, (_, index) => index) : [], [kind]);
  if (!kind || !enabled || !width) return null;
  return <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width, height, overflow: 'hidden' }}>
    {items.map(index => <Particle key={`${effect}-${index}`} kind={kind} index={index} width={width} height={height} still={false} />)}
  </View>;
}

/** A small preview for the picker (still frame when motion is reduced). */
export function EffectSwatch({ effect, size = 56 }: { effect: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: 16, overflow: 'hidden', backgroundColor: '#11141C' }}><ProfileEffect effect={effect} width={size} height={size} /></View>;
}

/** Discord-style nameplates: a backdrop behind the name in lists, fading out to the left. */
export const NAMEPLATES: { id: string; label: string; colors: [string, string] }[] = [
  { id: 'platinum', label: 'Платина', colors: ['rgba(235,240,248,0.32)', 'rgba(150,162,184,0.12)'] },
  { id: 'deep', label: 'Глубина', colors: ['rgba(70,110,230,0.45)', 'rgba(40,60,140,0.14)'] },
  { id: 'aurora', label: 'Сияние', colors: ['rgba(46,230,200,0.38)', 'rgba(140,90,240,0.16)'] },
  { id: 'ember', label: 'Пламя', colors: ['rgba(255,110,60,0.42)', 'rgba(255,46,99,0.14)'] },
  { id: 'mint', label: 'Мята', colors: ['rgba(80,220,150,0.38)', 'rgba(20,120,90,0.14)'] },
  { id: 'night', label: 'Ночь', colors: ['rgba(120,90,255,0.42)', 'rgba(30,20,80,0.18)'] },
  { id: 'sakura', label: 'Сакура', colors: ['rgba(255,150,190,0.42)', 'rgba(200,90,150,0.14)'] },
];
export function Nameplate({ plate, radius = 0 }: { plate?: string | null; radius?: number }) {
  const item = NAMEPLATES.find(entry => entry.id === plate);
  if (!item) return null;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
    <LinearGradient colors={['transparent', item.colors[1], item.colors[0]]} locations={[0, 0.45, 1]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
    <LinearGradient colors={['rgba(255,255,255,0.10)', 'transparent']} start={{ x: 1, y: 0 }} end={{ x: 0.6, y: 1 }} style={StyleSheet.absoluteFill} />
  </View>;
}
