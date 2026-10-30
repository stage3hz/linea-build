import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, type SharedValue } from 'react-native-reanimated';

/**
 * Music «Главная» background: soft light patches that drift slowly while each patch's colour
 * flows blue → emerald → ice white (no pulsing). Everything runs on the UI thread as plain
 * transforms and opacity, so it costs almost nothing; it freezes when animations are off.
 */
// Mostly deep blue, a single touch of emerald and an ice-white accent.
const COLORS = ['#0D3480', '#0B6450', '#123E92', '#0A2F6E', '#B8D8F5'];
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
    const n = COLORS.length; let d = Math.abs(((phase.value - index) % n + n) % n); d = Math.min(d, n - d);
    const k = Math.max(0, 1 - d); return { opacity: k * k * (3 - 2 * k) };
  });
  return <Animated.View style={[StyleSheet.absoluteFill, style]}>{children}</Animated.View>;
}

function Patch({ x, y, size, offset, drift, strength }: { x: number; y: number; size: number; offset: number; drift: number; strength: number }) {
  const phase = useSharedValue(offset); const dx = useSharedValue(0); const dy = useSharedValue(0);
  useEffect(() => {
    phase.value = withRepeat(withTiming(offset + COLORS.length, { duration: STEP * COLORS.length, easing: Easing.linear }), -1, false);
    const ease = Easing.inOut(Easing.sin);
    dx.value = withRepeat(withSequence(withTiming(drift, { duration: 9000 + offset * 900, easing: ease }), withTiming(-drift, { duration: 9000 + offset * 900, easing: ease })), -1, true);
    dy.value = withRepeat(withSequence(withTiming(-drift * .7, { duration: 11000 + offset * 700, easing: ease }), withTiming(drift * .7, { duration: 11000 + offset * 700, easing: ease })), -1, true);
  }, []);
  const move = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }, { translateY: dy.value }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size }, move]}>
    {COLORS.map((color, index) => <Layer key={color} phase={phase} index={index}><Glow color={color} size={size} opacity={color === '#B8D8F5' ? strength * .35 : color === '#0B6450' ? strength * .7 : strength} /></Layer>)}
  </Animated.View>;
}

export function MusicAmbient({ width, height }: { width: number; height: number }) {
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#030A14', overflow: 'hidden' }]}>
    <Patch x={width * .25} y={height * .35} size={width * 1.3} offset={0} drift={50} strength={.55} />
    <Patch x={width * .85} y={height * .55} size={width * 1.2} offset={1.7} drift={45} strength={.45} />
    <Patch x={width * .5} y={height * .85} size={width * 1.3} offset={3.1} drift={40} strength={.5} />
    <Patch x={width * .55} y={height * .3} size={width * .8} offset={4.2} drift={55} strength={.3} />
    {/* Darken the top for the header and the bottom edge where the list sheet starts. */}
    <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs><RadialGradient id="vignette" cx="50%" cy="45%" r="75%"><Stop offset="0.55" stopColor="#030A14" stopOpacity={0} /><Stop offset="1" stopColor="#030A14" stopOpacity={0.7} /></RadialGradient></Defs>
      <Rect width={width} height={height} fill="url(#vignette)" />
    </Svg>
  </View>;
}
