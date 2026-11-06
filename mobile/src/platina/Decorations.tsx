import React, { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { Image } from 'expo-image';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

/**
 * Platina avatar decorations: hand-painted art around a round avatar (Discord-style).
 * `scale` is the art size relative to the avatar, measured so the avatar fills the opening.
 * Motion is drawn in code over the still art: a light sweep over metal, a breathing glow,
 * rising embers or drifting sparkles. Lists show the still art; motion plays in profiles.
 */
type Motion = { sweep?: boolean; glow?: string; particles?: { color: string; rise: boolean } };
export type Decoration = { id: string; label: string; collection: string; image: number; scale: number; motion: Motion };

export const DECORATION_COLLECTIONS = ['Готика', 'Хоррор', 'Пламя', 'Ночь'] as const;

export const DECORATIONS: Decoration[] = [
  { id: 'deco-black-roses', label: 'Чёрные розы', collection: 'Готика', image: require('../../assets/decorations/black_roses.webp'), scale: 1.282, motion: { sweep: true } },
  { id: 'deco-white-roses', label: 'Белые розы', collection: 'Готика', image: require('../../assets/decorations/white_roses.webp'), scale: 1.272, motion: { sweep: true, particles: { color: '#F1E9FF', rise: false } } },
  { id: 'deco-chrome', label: 'Хром', collection: 'Готика', image: require('../../assets/decorations/chrome.webp'), scale: 1.5, motion: { sweep: true } },
  { id: 'deco-fangs', label: 'Пасть', collection: 'Хоррор', image: require('../../assets/decorations/fangs.webp'), scale: 1.267, motion: { sweep: true } },
  { id: 'deco-eye', label: 'Глаз', collection: 'Хоррор', image: require('../../assets/decorations/eye.webp'), scale: 1.5, motion: { sweep: true } },
  { id: 'deco-ink', label: 'Чернила', collection: 'Хоррор', image: require('../../assets/decorations/ink.webp'), scale: 1.292, motion: { glow: '#B9C0CC' } },
  { id: 'deco-skulls', label: 'Черепа', collection: 'Пламя', image: require('../../assets/decorations/skulls.webp'), scale: 1.332, motion: { glow: '#2FE6FF', particles: { color: '#8CF4FF', rise: true } } },
  { id: 'deco-eclipse', label: 'Затмение', collection: 'Пламя', image: require('../../assets/decorations/eclipse_smoke.webp'), scale: 1.244, motion: { glow: '#FF6A1F', particles: { color: '#FFB35C', rise: true } } },
  { id: 'deco-corona', label: 'Корона', collection: 'Пламя', image: require('../../assets/decorations/corona.webp'), scale: 1.5, motion: { glow: '#FFC13B', particles: { color: '#FFE08A', rise: true } } },
  { id: 'deco-moon', label: 'Лунная ночь', collection: 'Ночь', image: require('../../assets/decorations/lavender.webp'), scale: 1.482, motion: { glow: '#B48CFF', particles: { color: '#F0E6FF', rise: false } } },
  { id: 'deco-moths', label: 'Мотыльки', collection: 'Ночь', image: require('../../assets/decorations/moths.webp'), scale: 1.5, motion: { glow: '#C7A8FF', particles: { color: '#FFFFFF', rise: false } } },
  { id: 'deco-arch', label: 'Арка', collection: 'Ночь', image: require('../../assets/decorations/arch.webp'), scale: 1.335, motion: { sweep: true, particles: { color: '#FFE7A3', rise: false } } },
];

export const findDecoration = (id?: string | null) => (id ? DECORATIONS.find(item => item.id === id) : undefined);

function useLoop(still: boolean, duration: number, delay = 0) {
  const progress = useSharedValue(0);
  useEffect(() => {
    if (still) { cancelAnimation(progress); progress.value = 0; return; }
    progress.value = 0;
    progress.value = withDelay(delay, withRepeat(withTiming(1, { duration, easing: Easing.inOut(Easing.quad) }), -1, false));
    return () => cancelAnimation(progress);
  }, [still, duration, delay]);
  return progress;
}

/** A soft band of light crossing the art, clipped to its shape: polished metal, petals, gold. */
function Sweep({ image, size }: { image: number; size: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    // Sweep, then rest: a constant shimmer looks cheap, an occasional glint looks expensive.
    progress.value = withRepeat(withSequence(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.cubic) }), withTiming(1, { duration: 2600 }), withTiming(0, { duration: 0 })), -1, false);
    return () => cancelAnimation(progress);
  }, []);
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: -size * 1.2 + progress.value * size * 2.4 }, { rotate: '18deg' }] }));
  return <MaskedView pointerEvents="none" style={StyleSheet.absoluteFill} maskElement={<Image source={image} style={{ width: size, height: size }} contentFit="contain" />}>
    <Animated.View style={[{ position: 'absolute', top: -size * .25, width: size * .55, height: size * 1.5 }, band]}>
      <LinearGradient colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0)']} start={{ x: 0, y: .5 }} end={{ x: 1, y: .5 }} style={StyleSheet.absoluteFill} />
    </Animated.View>
  </MaskedView>;
}

/** The art's own silhouette, tinted and blurred behind it, breathing in and out. */
function Glow({ image, size, color, still }: { image: number; size: number; color: string; still: boolean }) {
  const progress = useLoop(still, 2400);
  const style = useAnimatedStyle(() => { const wave = Math.sin(progress.value * Math.PI); return { opacity: .2 + .45 * wave, transform: [{ scale: 1 + .03 * wave }] }; });
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
    <Image source={image} style={{ width: size, height: size }} contentFit="contain" tintColor={color} blurRadius={Math.max(4, size * .05)} />
  </Animated.View>;
}

const rand = (seed: number) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };

/** Embers rise from the ring; sparkles drift around it and twinkle. */
function Particle({ index, size, color, rise }: { index: number; size: number; color: string; rise: boolean }) {
  const r = (n: number) => rand(index * 11 + n);
  const angle = r(1) * Math.PI * 2, radius = size * (.36 + r(2) * .1);
  const x = size / 2 + Math.cos(angle) * radius, y = size / 2 + Math.sin(angle) * radius;
  const dot = Math.max(2, size * (rise ? .018 : .022) * (.7 + r(3) * .6));
  const progress = useLoop(false, 1800 + r(4) * 1800, Math.round(r(5) * 1600));
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return rise
      ? { opacity: Math.min(1, p * 4, (1 - p) * 2), transform: [{ translateY: -p * size * .14 }, { translateX: Math.sin(p * 6 + index) * size * .015 }] }
      : { opacity: Math.abs(Math.sin(p * Math.PI)) * .9, transform: [{ scale: .5 + Math.sin(p * Math.PI) * .7 }] };
  });
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x - dot / 2, top: y - dot / 2, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color, shadowColor: color, shadowOpacity: .9, shadowRadius: dot * 1.5, shadowOffset: { width: 0, height: 0 } }, style]} />;
}

/** The decoration over an avatar of `size` (the caller places it centred). */
export function DecorationArt({ decoration, size, live }: { decoration: Decoration; size: number; live: boolean }) {
  const art = size * decoration.scale; const { motion } = decoration;
  // Masks are unreliable on web; the still art is shown there.
  const sweep = live && motion.sweep && Platform.OS !== 'web';
  return <View pointerEvents="none" style={{ position: 'absolute', width: art, height: art, left: (size - art) / 2, top: (size - art) / 2 }}>
    {live && motion.glow ? <Glow image={decoration.image} size={art} color={motion.glow} still={!live} /> : null}
    <Image source={decoration.image} style={{ width: art, height: art }} contentFit="contain" cachePolicy="memory-disk" accessibilityIgnoresInvertColors />
    {sweep ? <Sweep image={decoration.image} size={art} /> : null}
    {live && motion.particles ? Array.from({ length: motion.particles.rise ? 9 : 7 }, (_, index) => <Particle key={index} index={index} size={art} color={motion.particles!.color} rise={motion.particles!.rise} />) : null}
  </View>;
}
