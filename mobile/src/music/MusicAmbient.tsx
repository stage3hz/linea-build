import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, type SharedValue } from 'react-native-reanimated';

/**
 * Music «Главная» background: soft light patches that drift slowly while each patch's colour
 * flows blue → emerald → ice white (no pulsing). Everything runs on the UI thread as plain
 * transforms and opacity, so it costs almost nothing; it freezes when animations are off.
 */
// Mostly blue, a single touch of emerald and an ice-white accent — tuned per theme so the
// top of the screen continues the app background instead of sitting on it as a dark block.
const PALETTES = {
  dark: { base: '#0A1529', colors: ['#0D3480', '#0B6450', '#123E92', '#0A2F6E', '#B8D8F5'], accent: 4, green: 1 },
  black: { base: '#000000', colors: ['#0A2766', '#08483A', '#0E2F72', '#071F4F', '#8FB3D9'], accent: 4, green: 1 },
  light: { base: '#E7EFFC', colors: ['#9DBDF2', '#A9E0CF', '#B5CDF5', '#8FB0EA', '#FFFFFF'], accent: 4, green: 1 },
} as const;
export type AmbientTone = keyof typeof PALETTES;
const COUNT = 5;
const STEP = 6000; // ms per colour

function Glow({ color, size, opacity }: { color: string; size: number; opacity: number }) {
  const id = `g${color.slice(1)}${size}`;
  return <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
    <Defs><RadialGradient id={id} cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor={color} stopOpacity={opacity} /><Stop offset="1" stopColor={color} stopOpacity={0} /></RadialGradient></Defs>
    <Rect width={size} height={size} fill={`url(#${id})`} />
  </Svg>;
}

/** One colour layer of a patch; its opacity rises while the cycle passes its slot. */
function Layer({ phase, index, children }: { phase: SharedValue<number>; index: number; children: React.ReactNode }) {
  const style = useAnimatedStyle(() => {
    const n = COUNT; let d = Math.abs(((phase.value - index) % n + n) % n); d = Math.min(d, n - d);
    const k = Math.max(0, 1 - d); return { opacity: k * k * (3 - 2 * k) };
  });
  return <Animated.View style={[StyleSheet.absoluteFill, style]}>{children}</Animated.View>;
}

function Patch({ x, y, size, offset, drift, strength, tone }: { x: number; y: number; size: number; offset: number; drift: number; strength: number; tone: AmbientTone }) {
  const palette = PALETTES[tone];
  const phase = useSharedValue(offset); const dx = useSharedValue(0); const dy = useSharedValue(0);
  useEffect(() => {
    phase.value = withRepeat(withTiming(offset + COUNT, { duration: STEP * COUNT, easing: Easing.linear }), -1, false);
    const ease = Easing.inOut(Easing.sin);
    dx.value = withRepeat(withSequence(withTiming(drift, { duration: 9000 + offset * 900, easing: ease }), withTiming(-drift, { duration: 9000 + offset * 900, easing: ease })), -1, true);
    dy.value = withRepeat(withSequence(withTiming(-drift * .7, { duration: 11000 + offset * 700, easing: ease }), withTiming(drift * .7, { duration: 11000 + offset * 700, easing: ease })), -1, true);
  }, []);
  const move = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }, { translateY: dy.value }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size }, move]}>
    {palette.colors.map((color, index) => <Layer key={`${tone}${index}`} phase={phase} index={index}><Glow color={color} size={size} opacity={index === palette.accent ? strength * (tone === 'light' ? .8 : .35) : index === palette.green ? strength * .7 : strength} /></Layer>)}
  </Animated.View>;
}

/** `fadeTo` blends the bottom edge into the screen background below (the track list). */
export function MusicAmbient({ width, height, tone = 'dark', fadeTo }: { width: number; height: number; tone?: AmbientTone; fadeTo?: string }) {
  const palette = PALETTES[tone];
  const strength = tone === 'light' ? .75 : 1;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: palette.base, overflow: 'hidden' }]}>
    <Patch tone={tone} x={width * .25} y={height * .35} size={width * 1.3} offset={0} drift={50} strength={.55 * strength} />
    <Patch tone={tone} x={width * .85} y={height * .55} size={width * 1.2} offset={1.7} drift={45} strength={.45 * strength} />
    <Patch tone={tone} x={width * .5} y={height * .85} size={width * 1.3} offset={3.1} drift={40} strength={.5 * strength} />
    <Patch tone={tone} x={width * .55} y={height * .3} size={width * .8} offset={4.2} drift={55} strength={.3 * strength} />
    {fadeTo ? <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs><LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><Stop offset="0.62" stopColor={fadeTo} stopOpacity={0} /><Stop offset="1" stopColor={fadeTo} stopOpacity={1} /></LinearGradient></Defs>
      <Rect width={width} height={height} fill="url(#fade)" />
    </Svg> : null}
  </View>;
}
