// Sign-in backdrop: deep background with two slowly drifting glows in the theme's
// own colours, and the app icon as a lit tile. Motion follows the app's energy
// policy (low battery / reduce motion → still image).
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { FONT_FAMILY, Text } from '../typography';
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

/** The sign-in hero: the name itself, large, with the same soft halo the app icon has. */
// Platinum for the letters: cool white metal on dark themes, dark polished metal on light ones.
const METAL_DARK = ['#B9C1CF', '#FFFFFF', '#8E99AD', '#EEF1F6', '#B9C1CF', '#FFFFFF', '#8E99AD'];
const METAL_LIGHT = ['#2E3542', '#7B879B', '#1E232D', '#5A6477', '#2E3542', '#8893A7', '#1E232D'];
let webKeyframes = false;

/**
 * «Инвиз» in platinum: the letters are a window onto slowly moving metal, with a glint that
 * passes now and then (a constant shimmer looks cheap). Under them a soft, deep shadow and a faint
 * cool glow — depth instead of the old coloured blur. Still image when motion is off.
 */
export function Wordmark({ size = 58 }: { size?: number }) {
  const t = useTheme();
  const { enabled } = useMotion();
  const enter = useRef(new Animated.Value(enabled ? 0 : 1)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = React.useState(0);
  useEffect(() => { if (enabled) Animated.spring(enter, { toValue: 1, useNativeDriver: true, speed: 8, bounciness: 6 }).start(); }, []);
  useEffect(() => {
    if (!enabled || !width) { sweep.setValue(0.35); return; }
    // Sweep across in 2.4 s, rest 2.6 s.
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(sweep, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.delay(2600),
      Animated.timing(sweep, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));
    loop.start(); return () => loop.stop();
  }, [enabled, width]);
  const metal = t.dark ? METAL_DARK : METAL_LIGHT;
  const font = { fontSize: size, lineHeight: size * 1.18, fontWeight: '800' as const, letterSpacing: -size * 0.035 };
  // Depth: a dark shadow right under the letters + a wide faint cool glow behind. Both copies sit
  // exactly under the metal letters (their own fill is hidden; a transparent glyph casts no shadow on iOS).
  const shadow = <Text pointerEvents="none" style={{ ...font, position: 'absolute', color: metal[2], textShadowColor: t.dark ? 'rgba(0,0,0,0.85)' : 'rgba(20,28,45,0.28)', textShadowRadius: size * 0.16, textShadowOffset: { width: 0, height: size * 0.07 } }}>Инвиз</Text>;
  const glow = <Text pointerEvents="none" style={{ ...font, position: 'absolute', color: metal[2], textShadowColor: t.dark ? 'rgba(205,220,255,0.38)' : 'rgba(120,140,190,0.25)', textShadowRadius: size * 0.55, textShadowOffset: { width: 0, height: 0 } }}>Инвиз</Text>;
  let letters: React.ReactNode;
  if (Platform.OS === 'web') {
    // The PC app: CSS paints the moving metal inside the letters.
    if (enabled && !webKeyframes && typeof document !== 'undefined') {
      webKeyframes = true;
      const style = document.createElement('style');
      style.textContent = '@keyframes invizMetal{0%{background-position:100% 50%}48%{background-position:0% 50%}100%{background-position:0% 50%}}';
      document.head.appendChild(style);
    }
    letters = React.createElement('div', { role: 'presentation', style: {
      fontFamily: FONT_FAMILY, fontSize: size, lineHeight: `${size * 1.18}px`, fontWeight: 800, letterSpacing: -size * 0.035,
      backgroundImage: `linear-gradient(105deg, ${metal.join(', ')})`, backgroundSize: '300% 100%', backgroundPosition: '60% 50%',
      WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitTextFillColor: 'transparent',
      animation: enabled ? 'invizMetal 5s cubic-bezier(.65,0,.35,1) infinite' : 'none', position: 'relative',
      // Shadow and glow from the letters' own shape (text-shadow would show through the metal).
      filter: t.dark ? `drop-shadow(0 ${size * 0.07}px ${size * 0.09}px rgba(0,0,0,0.85)) drop-shadow(0 0 ${size * 0.3}px rgba(205,220,255,0.35))` : `drop-shadow(0 ${size * 0.06}px ${size * 0.08}px rgba(20,28,45,0.3)) drop-shadow(0 0 ${size * 0.28}px rgba(120,140,190,0.25))`,
    } }, 'Инвиз');
  } else {
    letters = <MaskedView maskElement={<Text style={{ ...font, color: '#000' }}>Инвиз</Text>}>
      <Text onLayout={e => setWidth(e.nativeEvent.layout.width)} style={{ ...font, opacity: 0 }}>Инвиз</Text>
      <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: (width || size * 4) * 3, transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [0, -(width || size * 4) * 2] }) }] }}>
        <LinearGradient colors={metal as [string, string, ...string[]]} start={{ x: 0, y: 0.35 }} end={{ x: 1, y: 0.65 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </MaskedView>;
  }
  return <Animated.View accessible accessibilityRole="header" accessibilityLabel="Инвиз" style={{ alignItems: 'center', justifyContent: 'center', height: size * 1.5, opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }}>
    {Platform.OS === 'web' ? null : <>{glow}{shadow}</>}{letters}
  </Animated.View>;
}
