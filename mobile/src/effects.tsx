// Small animated pieces shared by several screens: confetti (Platina granted), skeleton rows (chat list
// loading) and text that appears word by word (welcome and sign-in titles). All of them respect the
// app's motion setting (useMotion): with animations off they render the final state at once.
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions, type StyleProp, type TextStyle } from 'react-native';
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming, type SharedValue } from 'react-native-reanimated';
import { Text } from './typography';
import { useTheme } from './theme';
import { useMotion } from './motion';
import { tr, useLanguage } from './i18n';

// ── Confetti ────────────────────────────────────────────────────────────────────────────────────────
type Piece = { x: number; size: number; color: string; delay: number; speed: number; drift: number; phase: number; spin: number; round: boolean };
const CONFETTI_MS = 2800;

function ConfettiPiece({ piece, progress, height }: { piece: Piece; progress: SharedValue<number>; height: number }) {
  const style = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, (progress.value - piece.delay) / (1 - piece.delay)));
    const y = -30 + p * (height + 60) * piece.speed;
    const x = piece.x + Math.sin(p * 6 + piece.phase) * piece.drift;
    return { opacity: p <= 0 ? 0 : interpolate(p, [0, 0.08, 0.8, 1], [0, 1, 1, 0]), transform: [{ translateX: x }, { translateY: y }, { rotate: `${p * piece.spin}deg` }, { scaleX: piece.round ? 1 : Math.cos(p * 9 + piece.phase) }] };
  });
  return <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: piece.size, height: piece.round ? piece.size : piece.size * 0.45, borderRadius: piece.round ? piece.size / 2 : 1.5, backgroundColor: piece.color }, style]} />;
}

/** A one-shot shower of confetti over the whole screen; `onDone` fires when it has fallen. */
export function Confetti({ colors, count = 70, onDone }: { colors: string[]; count?: number; onDone?: () => void }) {
  const { width, height } = useWindowDimensions();
  const progress = useSharedValue(0);
  const pieces = useMemo<Piece[]>(() => Array.from({ length: count }, (_, i) => ({
    x: Math.random() * width, size: 7 + Math.random() * 7, color: colors[i % colors.length],
    delay: Math.random() * 0.25, speed: 0.75 + Math.random() * 0.4, drift: 12 + Math.random() * 28,
    phase: Math.random() * Math.PI * 2, spin: (Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 480), round: Math.random() < 0.25,
  })), [count, width, colors]);
  useEffect(() => {
    progress.value = withTiming(1, { duration: CONFETTI_MS, easing: Easing.out(Easing.quad) });
    const timer = setTimeout(() => onDone?.(), CONFETTI_MS + 100);
    return () => clearTimeout(timer);
  }, []);
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>{pieces.map((piece, i) => <ConfettiPiece key={i} piece={piece} progress={progress} height={height} />)}</View>;
}

// ── Skeleton ────────────────────────────────────────────────────────────────────────────────────────
/** A soft pulse shared by all skeleton blocks on screen (one animation, not one per block). */
function usePulse() {
  const { enabled } = useMotion();
  const pulse = useSharedValue(0.55);
  useEffect(() => {
    if (!enabled) { pulse.value = 0.55; return; }
    pulse.value = withRepeat(withSequence(withTiming(1, { duration: 750, easing: Easing.inOut(Easing.quad) }), withTiming(0.45, { duration: 750, easing: Easing.inOut(Easing.quad) })), -1);
  }, [enabled]);
  return pulse;
}

/** Placeholder rows shaped exactly like the chat list rows (60 pt avatar, name, preview, time). */
export function ChatListSkeleton({ rows = 9 }: { rows?: number }) {
  const t = useTheme(); const pulse = usePulse();
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  const block = t.dark ? 'rgba(255,255,255,0.09)' : 'rgba(30,40,70,0.075)';
  const widths = [0.62, 0.45, 0.7, 0.52, 0.38, 0.66, 0.5, 0.58, 0.42];
  return <Animated.View accessibilityLabel="Загрузка чатов" accessibilityRole="progressbar" style={[{ paddingTop: 4 }, style]}>
    {Array.from({ length: rows }, (_, i) => <View key={i} style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center' }}>
      <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: block }} />
      <View style={{ flex: 1, minHeight: 68, justifyContent: 'center', gap: 9 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ height: 14, borderRadius: 7, width: `${Math.round(widths[i % widths.length] * 70)}%`, backgroundColor: block }} />
          <View style={{ flex: 1 }} />
          <View style={{ height: 11, width: 34, borderRadius: 6, backgroundColor: block }} />
        </View>
        <View style={{ height: 12, borderRadius: 6, width: `${Math.round(widths[(i + 3) % widths.length] * 100)}%`, backgroundColor: block }} />
      </View>
    </View>)}
  </Animated.View>;
}

// ── Text that appears word by word ──────────────────────────────────────────────────────────────────
const AnimatedAppText = Animated.createAnimatedComponent(Text);
function Word({ word, index, start, style }: { word: string; index: number; start: number; style?: StyleProp<TextStyle> }) {
  const p = useSharedValue(0);
  useEffect(() => { p.value = 0; p.value = withDelay(start + index * 70, withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) })); }, [word, start]);
  const animated = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: (1 - p.value) * 10 }] }));
  return <AnimatedAppText raw style={[style, animated]}>{word}</AnimatedAppText>;
}

/**
 * Text whose words rise and fade in one after another; re-plays when `children` changes. Lines are
 * split on '\n'; each line keeps the alignment of `style.textAlign`. Screen readers get the whole
 * text at once.
 */
export function AppearingText({ children, style, delay = 0 }: { children: string; style?: StyleProp<TextStyle>; delay?: number }) {
  const { enabled } = useMotion(); const language = useLanguage();
  if (!enabled) return <Text style={style}>{children}</Text>;
  // Each line is translated whole first (the dictionary holds whole phrases), then split into words.
  const text = children.split('\n').map(line => tr(line, language)).join('\n');
  const flat = StyleSheet.flatten(style) || {};
  const justify = flat.textAlign === 'center' ? 'center' : flat.textAlign === 'right' ? 'flex-end' : 'flex-start';
  let index = 0;
  return <View accessible accessibilityRole="header" accessibilityLabel={text} style={{ alignSelf: 'stretch' }}>
    {text.split('\n').map((line, row) => <View key={`${row}:${line}`} style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: justify }}>
      {line.split(' ').filter(Boolean).map((word, i, all) => <Word key={`${i}:${word}`} word={i < all.length - 1 ? `${word} ` : word} index={index++} start={delay} style={style} />)}
    </View>)}
  </View>;
}
