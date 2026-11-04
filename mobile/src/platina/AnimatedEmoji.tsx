import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, View } from 'react-native';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '../typography';
import { useMotion } from '../motion';
import { ANIMATED_EMOJI } from './emojiAssets';
import { emojiClusters, isEmojiCluster } from './emojiText';
export { emojiClusters };

/** Parsed Lottie documents, loaded from the bundled asset on first use and kept for the session. */
/** The bundled animation for an emoji, tolerant to a missing or extra U+FE0F. */
// On iPhone the original Apple glyphs are shown everywhere (the bundled animations are Google's Noto
// drawings); they get a light motion of their own instead of the Lottie animation.
const NATIVE_GLYPHS = Platform.OS === 'ios';
function animationModule(emoji: string): number | undefined {
  if (NATIVE_GLYPHS) return undefined;
  return ANIMATED_EMOJI[emoji] ?? ANIMATED_EMOJI[emoji.replace(/\uFE0F/g, '')] ?? ANIMATED_EMOJI[`${emoji}\uFE0F`];
}


const cache = new Map<string, Promise<object | null>>();
function load(emoji: string): Promise<object | null> {
  const module = animationModule(emoji);
  if (!module || Platform.OS === 'web') return Promise.resolve(null);
  let pending = cache.get(emoji);
  if (!pending) {
    pending = (async () => {
      const asset = Asset.fromModule(module);
      if (!asset.localUri) await asset.downloadAsync();
      const uri = asset.localUri || asset.uri;
      return JSON.parse(await FileSystem.readAsStringAsync(uri)) as object;
    })().catch(() => { cache.delete(emoji); return null; });
    cache.set(emoji, pending);
  }
  return pending;
}

export const hasAnimatedEmoji = (emoji: string) => Platform.OS !== 'web' && (NATIVE_GLYPHS ? isEmojiCluster(emoji) : Boolean(animationModule(emoji)));

import { LottieView } from './lottie';
const lottie = () => LottieView;

/**
 * One emoji. With an animation available it plays as Lottie (`loop`, or `once` and then on tap);
 * otherwise, or while animations are off, it is the ordinary system glyph.
 */
export function AnimatedEmoji({ emoji, size, mode = 'loop', tapToReplay = false }: { emoji: string; size: number; mode?: 'loop' | 'once'; tapToReplay?: boolean }) {
  if (NATIVE_GLYPHS) return <NativeEmoji emoji={emoji} size={size} mode={mode} tapToReplay={tapToReplay} />;
  return <LottieEmoji emoji={emoji} size={size} mode={mode} tapToReplay={tapToReplay} />;
}

/** The system (Apple) glyph: pops in once, or breathes gently while `loop`. */
function NativeEmoji({ emoji, size, mode, tapToReplay }: { emoji: string; size: number; mode: 'loop' | 'once'; tapToReplay: boolean }) {
  const { enabled } = useMotion();
  const scale = useRef(new Animated.Value(enabled ? 0.6 : 1)).current;
  const play = () => {
    if (!enabled) { scale.setValue(1); return; }
    scale.stopAnimation(); scale.setValue(0.6);
    const pop = Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 14 });
    if (mode === 'once') { pop.start(); return; }
    const breathe = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: 1.08, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    Animated.sequence([pop, breathe]).start();
  };
  useEffect(() => { play(); return () => scale.stopAnimation(); }, [emoji, enabled, mode]);
  const glyph = <Animated.View accessible accessibilityLabel={emoji} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', transform: [{ scale }] }}>
    <Text raw style={{ fontSize: size * 0.86, lineHeight: size, textAlign: 'center' }}>{emoji}</Text>
  </Animated.View>;
  return tapToReplay ? <Pressable onPress={play}>{glyph}</Pressable> : glyph;
}

function LottieEmoji({ emoji, size, mode, tapToReplay }: { emoji: string; size: number; mode: 'loop' | 'once'; tapToReplay: boolean }) {
  const { enabled } = useMotion();
  const [source, setSource] = useState<object | null>(null);
  const ref = useRef<{ play: () => void; reset: () => void } | null>(null);
  useEffect(() => { let alive = true; if (enabled) void load(emoji).then(json => { if (alive) setSource(json); }); else setSource(null); return () => { alive = false; }; }, [emoji, enabled]);
  const Lottie = source ? lottie() : null;
  if (!Lottie || !source) return <Text accessibilityLabel={emoji} style={{ fontSize: size * 0.86, lineHeight: size, width: size, textAlign: 'center' }}>{emoji}</Text>;
  const view = <View accessible accessibilityLabel={emoji} style={{ width: size, height: size }}>
    <Lottie ref={ref as never} source={source as never} autoPlay loop={mode === 'loop'} style={{ width: size, height: size }} />
  </View>;
  if (!tapToReplay) return view;
  return <Pressable onPress={() => { ref.current?.reset(); ref.current?.play(); }}>{view}</Pressable>;
}

/** A message made of 1–3 emoji only (and at least one animated): shown large, as a sticker. */
export function bigEmoji(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 24) return null;
  const parts = emojiClusters(trimmed);
  if (parts.length < 1 || parts.length > 3) return null;
  if (!parts.every(isEmojiCluster)) return null;
  return NATIVE_GLYPHS || parts.some(part => animationModule(part)) ? parts : null;
}

