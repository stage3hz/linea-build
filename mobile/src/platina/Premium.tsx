import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, LinearGradient as SvgGradient, Path, Stop } from 'react-native-svg';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming, type SharedValue } from 'react-native-reanimated';
import { useMotion } from '../motion';
import { useTheme } from '../theme';

/**
 * Platina premium decorations, drawn in code (sharp at any size, 60 fps, no assets):
 * six avatar frames and six animated statuses. Every animation is a transform or an opacity
 * on the UI thread, and stops when animations are off (reduced motion / energy saving).
 */

export const PREMIUM_FRAMES = [
  { id: 'chrome', label: 'Жидкий металл' },
  { id: 'veil', label: 'Северное сияние' },
  { id: 'ember', label: 'Пламя' },
  { id: 'crystal', label: 'Кристалл' },
  { id: 'neon', label: 'Неон' },
  { id: 'orbit', label: 'Орбита' },
] as const;
export type PremiumFrameId = typeof PREMIUM_FRAMES[number]['id'];

export const PREMIUM_STATUSES = [
  { id: 'gem', label: 'Бриллиант' },
  { id: 'flame', label: 'Огонь' },
  { id: 'heart', label: 'Сердце' },
  { id: 'moon', label: 'Луна' },
  { id: 'comet', label: 'Комета' },
  { id: 'bolt', label: 'Молния' },
] as const;
export type PremiumStatusId = typeof PREMIUM_STATUSES[number]['id'];

/** 0 → 1 forever (linear), or 0 when still. */
function useLoop(duration: number, still: boolean, delay = 0) {
  const value = useSharedValue(0);
  useEffect(() => {
    if (still) { cancelAnimation(value); value.value = 0; return; }
    value.value = 0;
    value.value = withDelay(delay, withRepeat(withTiming(1, { duration, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(value);
  }, [duration, still, delay]);
  return value;
}

/** A point on a rounded square's outline, `p` ∈ [0, 1) clockwise from the top-left straight edge. */
function perimeter(p: number, size: number, r: number) {
  'worklet';
  const s = size - 2 * r, arc = Math.PI * r / 2, total = 4 * s + 4 * arc;
  let d = (((p % 1) + 1) % 1) * total;
  const corner = (cx: number, cy: number, from: number) => { const a = from + (d / arc) * (Math.PI / 2); return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
  if (d < s) return { x: r + d, y: 0 }; d -= s;
  if (d < arc) return corner(size - r, r, -Math.PI / 2); d -= arc;
  if (d < s) return { x: size, y: r + d }; d -= s;
  if (d < arc) return corner(size - r, size - r, 0); d -= arc;
  if (d < s) return { x: size - r - d, y: size }; d -= s;
  if (d < arc) return corner(r, size - r, Math.PI / 2); d -= arc;
  if (d < s) return { x: 0, y: size - r - d }; d -= s;
  return corner(r, r, Math.PI);
}

/** A gradient ring that turns: a big rotating gradient clipped to a rounded square. */
function TurningRing({ size, radius, colors, duration, still, reverse = false, opacity = 1 }: { size: number; radius: number; colors: string[]; duration: number; still: boolean; reverse?: boolean; opacity?: number }) {
  const turn = useLoop(duration, still);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${(reverse ? -1 : 1) * turn.value * 360}deg` }] }));
  const big = size * 1.5;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden', opacity }]}>
    <Animated.View style={[{ position: 'absolute', width: big, height: big, left: (size - big) / 2, top: (size - big) / 2 }, style]}>
      <LinearGradient colors={colors as [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
    </Animated.View>
  </View>;
}

/** A glowing dot travelling along the outline, with an optional fading trail. */
function Traveller({ size, radius, inset, loop, offset = 0, dot, color, trail = 0, spacing = 0.012, reverse = false }: { size: number; radius: number; inset: number; loop: SharedValue<number>; offset?: number; dot: number; color: string; trail?: number; spacing?: number; reverse?: boolean }) {
  return <>{Array.from({ length: trail + 1 }, (_, index) => <TrailDot key={index} index={index} trail={trail} size={size} radius={radius} inset={inset} loop={loop} offset={offset} dot={dot} color={color} spacing={spacing} reverse={reverse} />)}</>;
}
function TrailDot({ index, trail, size, radius, inset, loop, offset, dot, color, spacing, reverse }: { index: number; trail: number; size: number; radius: number; inset: number; loop: SharedValue<number>; offset: number; dot: number; color: string; spacing: number; reverse: boolean }) {
  const scale = 1 - index / (trail + 1) * 0.7, alpha = index === 0 ? 1 : 0.55 * (1 - index / (trail + 1));
  const d = dot * scale, path = size - 2 * inset;
  const style = useAnimatedStyle(() => {
    const p = (reverse ? -1 : 1) * loop.value + offset - (reverse ? -1 : 1) * index * spacing;
    const point = perimeter(p, path, Math.max(0, radius - inset));
    return { transform: [{ translateX: inset + point.x - d / 2 }, { translateY: inset + point.y - d / 2 }] };
  });
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: d, height: d, borderRadius: d / 2, backgroundColor: color, opacity: alpha }, index === 0 ? { shadowColor: color, shadowOpacity: 1, shadowRadius: d, shadowOffset: { width: 0, height: 0 } } : null, style]}>
    {index === 0 ? <View style={{ position: 'absolute', left: -d * .6, top: -d * .6, width: d * 2.2, height: d * 2.2, borderRadius: d * 1.1, backgroundColor: color, opacity: .22 }} /> : null}
  </Animated.View>;
}

/** Soft halo: a few rounded squares stepping outwards with falling opacity (works on every platform). */
function Halo({ size, radius, color, spread, opacity }: { size: number; radius: number; color: string; spread: number; opacity: SharedValue<number> | number }) {
  const style = useAnimatedStyle(() => ({ opacity: typeof opacity === 'number' ? opacity : opacity.value }));
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
    {[1, 2, 3, 4].map(step => { const grow = spread * step / 4; return <View key={step} style={{ position: 'absolute', left: -grow, top: -grow, width: size + 2 * grow, height: size + 2 * grow, borderRadius: radius + grow, borderWidth: spread / 4 + 1, borderColor: color, opacity: 0.32 / step }} />; })}
  </Animated.View>;
}

const STAR = 'M12 0C12.9 7.6 16.4 11.1 24 12 16.4 12.9 12.9 16.4 12 24 11.1 16.4 7.6 12.9 0 12 7.6 11.1 11.1 7.6 12 0Z';

/** Twinkle: a soft four-point star that grows, turns a little and fades. */
function Sparkle({ x, y, size, color, duration, delay, still }: { x: number; y: number; size: number; color: string; duration: number; delay: number; still: boolean }) {
  const loop = useLoop(duration, still, delay);
  const style = useAnimatedStyle(() => { const k = Math.sin(loop.value * Math.PI); return { opacity: still ? 0.75 : k, transform: [{ scale: still ? 0.8 : 0.25 + k * 0.85 }, { rotate: `${loop.value * 40}deg` }] }; });
  // The glow is a larger faint star behind (a view shadow would draw a square on some platforms).
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size }, style]}>
    <Svg width={size * 1.9} height={size * 1.9} viewBox="0 0 24 24" style={{ position: 'absolute', left: -size * .45, top: -size * .45, opacity: .28 }}><Path d={STAR} fill={color} /></Svg>
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d={STAR} fill={color} /></Svg>
  </Animated.View>;
}

/** Ember particle rising from the top edge. */
function Ember({ x, base, rise, size, color, duration, delay, still }: { x: number; base: number; rise: number; size: number; color: string; duration: number; delay: number; still: boolean }) {
  const loop = useLoop(duration, still, delay);
  const style = useAnimatedStyle(() => ({
    opacity: still ? 0 : Math.sin(loop.value * Math.PI) * 0.95,
    transform: [{ translateX: x + Math.sin(loop.value * Math.PI * 2) * size * 1.2 }, { translateY: base - loop.value * rise }, { scale: 1 - loop.value * 0.6 }],
  }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: -size / 2, top: -size / 2, width: size, height: size, borderRadius: size / 2, backgroundColor: color, shadowColor: color, shadowOpacity: 1, shadowRadius: size, shadowOffset: { width: 0, height: 0 } }, style]} />;
}

/** Diamond shard at a corner that pulses. */
function Shard({ x, y, size, delay, still }: { x: number; y: number; size: number; delay: number; still: boolean }) {
  const loop = useLoop(2400, still, delay);
  const style = useAnimatedStyle(() => { const k = Math.pow(Math.sin(loop.value * Math.PI), 2); return { transform: [{ rotate: '45deg' }, { scale: still ? 1 : 0.75 + k * 0.45 }], opacity: still ? 1 : 0.7 + k * 0.3 }; });
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: size * .18, overflow: 'hidden', shadowColor: '#BFE6FF', shadowOpacity: .9, shadowRadius: size * .8, shadowOffset: { width: 0, height: 0 } }, style]}>
    <LinearGradient colors={['#FFFFFF', '#BFE6FF', '#6FB6FF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
  </Animated.View>;
}

/**
 * A premium frame around `children` (the avatar). `size` is the avatar size; the frame grows outwards
 * and cancels its own size with negative margins, so lists keep their layout.
 */
export function PremiumFrame({ kind, size, children, animated = true }: { kind: PremiumFrameId; size: number; children: React.ReactNode; animated?: boolean }) {
  const t = useTheme(); const { enabled } = useMotion();
  const still = !(animated && enabled);
  const ring = Math.max(2.5, Math.round(size * .05)), gap = Math.max(2, Math.round(size * .04));
  const outer = size + 2 * (ring + gap), radius = outer * .36;
  const breathe = useSharedValue(0.6);
  useEffect(() => {
    if (still) { cancelAnimation(breathe); breathe.value = 0.6; return; }
    breathe.value = withRepeat(withSequence(withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.sin) }), withTiming(0.45, { duration: 1600, easing: Easing.inOut(Easing.sin) })), -1, false);
    return () => cancelAnimation(breathe);
  }, [still]);
  const fast = useLoop(kind === 'neon' ? 2600 : 3400, still);
  const slow = useLoop(5200, still);
  const slower = useLoop(7600, still);
  const cover = <View style={{ position: 'absolute', left: ring, top: ring, width: size + 2 * gap, height: size + 2 * gap, borderRadius: (size + 2 * gap) * .36, backgroundColor: t.bg }} />;
  const mid = ring / 2; // dots ride the middle of the ring
  let back: React.ReactNode = null, front: React.ReactNode = null;
  if (kind === 'chrome') {
    back = <TurningRing size={outer} radius={radius} duration={7000} still={still} colors={['#4B5262', '#FFFFFF', '#9AA3B5', '#F1F4F9', '#30363F', '#FFFFFF', '#8A93A6', '#4B5262']} />;
    front = <><Traveller size={outer} radius={radius} inset={mid} loop={fast} dot={ring * 1.9} color="#FFFFFF" trail={5} spacing={0.008} /><Traveller size={outer} radius={radius} inset={mid} loop={fast} offset={0.5} dot={ring * 1.4} color="#E9EDF4" trail={3} spacing={0.008} /></>;
  } else if (kind === 'veil') {
    back = <><Halo size={outer} radius={radius} color="#2EE6C8" spread={ring * 2.6} opacity={breathe} /><TurningRing size={outer} radius={radius} duration={9000} still={still} colors={['#2EE6C8', '#7B5CFF', '#3FA9F5', '#9CFFB0', '#C77DFF', '#2EE6C8']} /></>;
    front = <TurningRing size={outer} radius={radius} duration={6000} still={still} reverse opacity={0.35} colors={['transparent', '#E8FFF8', 'transparent', 'transparent', '#E6DBFF', 'transparent']} />;
  } else if (kind === 'ember') {
    back = <><Halo size={outer} radius={radius} color="#FF6A2E" spread={ring * 2} opacity={breathe} /><TurningRing size={outer} radius={radius} duration={3600} still={still} colors={['#FF3D2E', '#FFB03A', '#FF2E63', '#FFD66B', '#FF5A1F', '#FF3D2E']} /></>;
    front = <>{[0.12, 0.26, 0.38, 0.5, 0.62, 0.74, 0.88, 0.2, 0.56, 0.8].map((x, index) => <Ember key={index} x={outer * x} base={ring * 2} rise={outer * 0.42} size={Math.max(2.5, ring * (index % 3 === 0 ? 1.1 : 0.75))} color={index % 2 ? '#FFC24B' : '#FF6A2E'} duration={1700 + (index % 4) * 260} delay={index * 190} still={still} />)}</>;
  } else if (kind === 'crystal') {
    back = <><Halo size={outer} radius={radius} color="#9AD7FF" spread={ring * 2} opacity={breathe} /><TurningRing size={outer} radius={radius} duration={8000} still={still} colors={['#CDEBFF', '#FFFFFF', '#7CC4FF', '#E9F7FF', '#5AA8F0', '#CDEBFF']} /></>;
    const c = radius * (1 - Math.SQRT1_2); // the middle of each rounded corner
    front = <>
      {[[c, c], [outer - c, c], [outer - c, outer - c], [c, outer - c]].map(([x, y], index) => <Shard key={index} x={x} y={y} size={ring * 3.2} delay={index * 600} still={still} />)}
      {[[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5], [0.25, 0], [0.75, 1]].map(([x, y], index) => <Sparkle key={index} x={outer * x} y={outer * y} size={ring * 2.6} color="#FFFFFF" duration={1800 + index * 230} delay={index * 420} still={still} />)}
    </>;
  } else if (kind === 'neon') {
    const line = Math.max(1.5, ring * .45);
    back = <>
      <Halo size={outer} radius={radius} color="#FF2BD6" spread={ring * 2.4} opacity={breathe} />
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: outer, height: outer, borderRadius: radius, borderWidth: line, borderColor: '#FF4FE0', shadowColor: '#FF2BD6', shadowOpacity: 1, shadowRadius: ring * 2, shadowOffset: { width: 0, height: 0 } }} />
      <View pointerEvents="none" style={{ position: 'absolute', left: ring - line, top: ring - line, width: outer - 2 * (ring - line), height: outer - 2 * (ring - line), borderRadius: radius - (ring - line), borderWidth: line, borderColor: '#3FF2FF', shadowColor: '#3FF2FF', shadowOpacity: 1, shadowRadius: ring * 2, shadowOffset: { width: 0, height: 0 } }} />
    </>;
    front = <Traveller size={outer} radius={radius} inset={mid} loop={fast} dot={ring * 1.8} color="#FFFFFF" trail={8} spacing={0.01} />;
  } else {
    back = <><Halo size={outer} radius={radius} color="#4F8CFF" spread={ring * 1.8} opacity={breathe} /><TurningRing size={outer} radius={radius} duration={12000} still={still} colors={['#0B1B3F', '#2B5BD7', '#0B1B3F', '#5B3FB8', '#0B1B3F']} /></>;
    front = <>
      <Traveller size={outer} radius={radius} inset={mid} loop={fast} dot={ring * 1.7} color="#FFFFFF" trail={12} spacing={0.005} />
      <Traveller size={outer} radius={radius} inset={mid} loop={slow} offset={0.33} dot={ring * 1.3} color="#8FB4FF" trail={10} spacing={0.006} reverse />
      <Traveller size={outer} radius={radius} inset={mid} loop={slower} offset={0.66} dot={ring * 1.1} color="#C9A8FF" trail={8} spacing={0.007} />
    </>;
  }
  return <View style={{ width: outer, height: outer, margin: -(ring + gap), alignItems: 'center', justifyContent: 'center' }}>
    {back}
    {cover}
    <View style={{ width: size, height: size }}>{children}</View>
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>{front}</View>
  </View>;
}

// ------------------------------------------------------------------- statuses

const HEART = 'M12 21s-7.5-4.6-9.6-9.2C.7 8 3 4 6.9 4c2.2 0 3.7 1.2 5.1 3 1.4-1.8 2.9-3 5.1-3C21 4 23.3 8 21.6 11.8 19.5 16.4 12 21 12 21z';
const MOON = 'M15.5 2.5a9.5 9.5 0 1 0 6 16.9A8 8 0 0 1 15.5 2.5z';
const BOLT = 'M13.5 1.5 4 13.6h6.4L9.2 22.5 19.8 9.9h-6.6z';

function useBeat(still: boolean, pattern: 'heart' | 'flicker' | 'flash') {
  const value = useSharedValue(1);
  useEffect(() => {
    if (still) { cancelAnimation(value); value.value = 1; return; }
    const ease = Easing.out(Easing.quad);
    value.value = pattern === 'heart'
      ? withRepeat(withSequence(withTiming(1.16, { duration: 140, easing: ease }), withTiming(1, { duration: 160 }), withTiming(1.1, { duration: 120, easing: ease }), withTiming(1, { duration: 520 })), -1, false)
      : pattern === 'flicker'
        ? withRepeat(withSequence(withTiming(1.08, { duration: 180 }), withTiming(0.94, { duration: 140 }), withTiming(1.05, { duration: 200 }), withTiming(0.97, { duration: 160 })), -1, true)
        : withRepeat(withSequence(withTiming(1, { duration: 1400 }), withTiming(0.35, { duration: 60 }), withTiming(1, { duration: 80 }), withTiming(0.5, { duration: 60 }), withTiming(1, { duration: 120 })), -1, false);
    return () => cancelAnimation(value);
  }, [still]);
  return value;
}

/** Animated status next to a name. `size` is the status size in points (≈ the name's line height). */
export function PremiumStatus({ kind, size = 22, animated = true }: { kind: PremiumStatusId; size?: number; animated?: boolean }) {
  const { enabled } = useMotion(); const still = !(animated && enabled);
  const s = size;
  const sweep = useLoop(2600, still);
  const orbit = useLoop(1800, still);
  const beat = useBeat(still, kind === 'heart' ? 'heart' : kind === 'flame' ? 'flicker' : 'flash');
  const pulse = useAnimatedStyle(() => ({ transform: [{ scale: beat.value }] }));
  const flash = useAnimatedStyle(() => ({ opacity: beat.value }));
  const glint = useAnimatedStyle(() => ({ transform: [{ translateX: -s + Math.min(1, sweep.value * 1.6) * s * 2.2 }, { rotate: '20deg' }] }));
  const ripple = useAnimatedStyle(() => ({ opacity: still ? 0 : (1 - orbit.value) * 0.6, transform: [{ scale: 0.7 + orbit.value * 0.8 }] }));
  const box = { width: s, height: s, alignItems: 'center' as const, justifyContent: 'center' as const };
  if (kind === 'gem') {
    const g = s * .64;
    return <View style={box}>
      <View style={{ width: g, height: g, transform: [{ rotate: '45deg' }], borderRadius: g * .16, overflow: 'hidden', shadowColor: '#8FB8FF', shadowOpacity: .9, shadowRadius: s * .3, shadowOffset: { width: 0, height: 0 } }}>
        <LinearGradient colors={['#FFFFFF', '#BFD6FF', '#6F8CFF', '#3A4FD6']} locations={[0, .35, .7, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', left: g * .18, top: g * .18, width: g * .64, height: g * .64, borderRadius: g * .1, borderWidth: Math.max(.8, s * .03), borderColor: 'rgba(255,255,255,0.55)' }} />
        <Animated.View style={[{ position: 'absolute', top: -g * .3, width: g * .22, height: g * 1.6, backgroundColor: 'rgba(255,255,255,0.85)' }, glint]} />
      </View>
      <Sparkle x={s * .86} y={s * .14} size={s * .34} color="#FFFFFF" duration={2600} delay={900} still={still} />
    </View>;
  }
  if (kind === 'flame') {
    const drop = (w: number, colors: string[], style: object) => <Animated.View style={[{ position: 'absolute', bottom: s * .06, width: w, height: w, borderTopLeftRadius: w, borderBottomLeftRadius: w, borderBottomRightRadius: w, borderTopRightRadius: w * .08, overflow: 'hidden', transform: [{ rotate: '-45deg' }] }, style]}>
      <LinearGradient colors={colors as [string, string, ...string[]]} start={{ x: 1, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
    </Animated.View>;
    return <View style={box}>
      <Animated.View style={[{ width: s, height: s, alignItems: 'center' }, pulse]}>
        {drop(s * .64, ['#FFB03A', '#FF3D2E'], { shadowColor: '#FF4D3A', shadowOpacity: .9, shadowRadius: s * .3, shadowOffset: { width: 0, height: 0 } })}
        {drop(s * .44, ['#FFE08A', '#FF8A2E'], { bottom: s * .08 })}
        {drop(s * .24, ['#FFFFFF', '#FFE08A'], { bottom: s * .1 })}
      </Animated.View>
    </View>;
  }
  if (kind === 'heart') {
    return <View style={box}>
      {s >= 28 ? <Animated.View style={[{ position: 'absolute', width: s * .9, height: s * .9, borderRadius: s, borderWidth: Math.max(1, s * .06), borderColor: '#FF6B8A' }, ripple]} /> : null}
      <Animated.View style={pulse}><Svg width={s * .86} height={s * .86} viewBox="0 0 24 24"><Defs><SvgGradient id="h" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#FFB3C7" /><Stop offset=".5" stopColor="#FF4F7A" /><Stop offset="1" stopColor="#D61F5A" /></SvgGradient></Defs><Path d={HEART} fill="url(#h)" /><Path d="M7 7.2c-1.4.4-2.2 1.7-2 3" stroke="#FFFFFF" strokeOpacity={.7} strokeWidth={1.4} strokeLinecap="round" fill="none" /></Svg></Animated.View>
    </View>;
  }
  if (kind === 'moon') {
    return <View style={box}>
      <Svg width={s * .82} height={s * .82} viewBox="0 0 24 24"><Defs><SvgGradient id="m" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#FFF6CF" /><Stop offset="1" stopColor="#F2B53A" /></SvgGradient></Defs><Path d={MOON} fill="url(#m)" /></Svg>
      <Sparkle x={s * .84} y={s * .2} size={s * .3} color="#FFF6CF" duration={2000} delay={0} still={still} />
      <Sparkle x={s * .7} y={s * .62} size={s * .22} color="#FFFFFF" duration={2400} delay={700} still={still} />
      <Sparkle x={s * .96} y={s * .48} size={s * .18} color="#FFF6CF" duration={1800} delay={1300} still={still} />
    </View>;
  }
  if (kind === 'comet') {
    const core = s * .42;
    return <View style={box}>
      <View style={{ width: core, height: core, borderRadius: core, overflow: 'hidden', shadowColor: '#6FB6FF', shadowOpacity: 1, shadowRadius: s * .3, shadowOffset: { width: 0, height: 0 } }}>
        <LinearGradient colors={['#FFFFFF', '#8FC8FF', '#4F6BFF']} start={{ x: .2, y: .1 }} end={{ x: .9, y: 1 }} style={StyleSheet.absoluteFill} />
      </View>
      {Array.from({ length: 10 }, (_, index) => <CometDot key={index} index={index} s={s} loop={orbit} />)}
    </View>;
  }
  return <View style={box}>
    <Animated.View style={flash}><Svg width={s * .9} height={s * .9} viewBox="0 0 24 24"><Defs><SvgGradient id="b" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#FFF6B0" /><Stop offset=".55" stopColor="#FFD23F" /><Stop offset="1" stopColor="#FF9F1C" /></SvgGradient></Defs><Path d={BOLT} fill="url(#b)" stroke="#FFF8D6" strokeWidth={.6} /></Svg></Animated.View>
    <Sparkle x={s * .2} y={s * .25} size={s * .26} color="#FFF6B0" duration={1600} delay={200} still={still} />
    <Sparkle x={s * .85} y={s * .78} size={s * .22} color="#FFFFFF" duration={1900} delay={900} still={still} />
  </View>;
}

function CometDot({ index, s, loop }: { index: number; s: number; loop: SharedValue<number> }) {
  const d = s * (0.2 - index * 0.016), r = s * .38;
  const style = useAnimatedStyle(() => {
    const a = (loop.value - index * 0.018) * Math.PI * 2;
    return { transform: [{ translateX: Math.cos(a) * r - d / 2 }, { translateY: Math.sin(a) * r * 0.55 - d / 2 }] };
  });
  return <Animated.View style={[{ position: 'absolute', left: s / 2, top: s / 2, width: d, height: d, borderRadius: d, backgroundColor: index ? '#BFE0FF' : '#FFFFFF', opacity: 1 - index * 0.09 }, style]} />;
}
