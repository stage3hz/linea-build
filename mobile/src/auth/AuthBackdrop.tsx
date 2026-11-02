// Sign-in backdrop: deep background with two slowly drifting glows in the theme's
// own colours, and the app icon as a lit tile. Motion follows the app's energy
// policy (low battery / reduce motion → still image).
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../theme';
import { useMotion } from '../motion';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function Glow({ color, size, from, to, duration }: { color: string; size: number; from: [number, number]; to: [number, number]; duration: number }) {
  const { enabled } = useMotion();
  const p = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!enabled) { p.setValue(0.5); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(p, { toValue: 1, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(p, { toValue: 0, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [enabled, duration]);
  const translateX = p.interpolate({ inputRange: [0, 1], outputRange: [from[0], to[0]] });
  const translateY = p.interpolate({ inputRange: [0, 1], outputRange: [from[1], to[1]] });
  const scale = p.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.12, 1] });
  return <Animated.View pointerEvents="none" style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, transform: [{ translateX }, { translateY }, { scale }], opacity: 0.9 }}>
    <LinearGradient colors={[color, 'transparent']} start={{ x: 0.5, y: 0.5 }} end={{ x: 1, y: 1 }} style={{ flex: 1, borderRadius: size / 2 }} />
  </Animated.View>;
}

export function AuthBackdrop() {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const size = Math.max(width, height) * 0.85, insets = useSafeAreaInsets();
  // Drawn under the status and navigation bars too, so there is no seam.
  return <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: -insets.top, bottom: -insets.bottom }}>
    <LinearGradient colors={t.dark ? [t.bgGradient[0], t.bg, t.bg] : t.bgGradient} style={StyleSheet.absoluteFill} />
    <Glow color={t.ambientBlue} size={size} from={[-size * 0.45, -size * 0.55]} to={[-size * 0.25, -size * 0.4]} duration={9000} />
    <Glow color={t.ambientLilac} size={size} from={[width - size * 0.45, height - size * 0.55]} to={[width - size * 0.65, height - size * 0.7]} duration={11000} />
    <LinearGradient colors={['transparent', t.dark ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)']} style={StyleSheet.absoluteFill} />
  </View>;
}

/** The app icon (white outline N) as a lit tile, the same picture as on the home screen. */
export function AppMark({ size = 84 }: { size?: number }) {
  const t = useTheme();
  const { enabled } = useMotion();
  const enter = useRef(new Animated.Value(enabled ? 0 : 1)).current;
  useEffect(() => { if (enabled) Animated.spring(enter, { toValue: 1, useNativeDriver: true, speed: 9, bounciness: 7 }).start(); }, []);
  const radius = size * 0.27;
  return <Animated.View style={{ width: size, height: size, opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }] }}>
    {/* Soft halo: stacked faint rings fade out smoothly instead of one disc with an edge. */}
    {[1.9, 1.65, 1.42, 1.22].map((k, i) => <View key={k} pointerEvents="none" style={{ position: 'absolute', left: (size - size * k) / 2, top: (size - size * k) / 2, width: size * k, height: size * k, borderRadius: size * k / 2, backgroundColor: t.accent, opacity: 0.035 + i * 0.02 }} />)}
    <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', shadowColor: t.accent, shadowOpacity: 0.35, shadowRadius: 22, shadowOffset: { width: 0, height: 8 } }}>
      <Image source={require('../../assets/icons/outline.png')} style={{ width: size, height: size }} accessibilityLabel="Инвиз" />
    </View>
  </Animated.View>;
}
