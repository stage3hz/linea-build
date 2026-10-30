import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '../typography';
import { useMotion } from '../motion';
import { ANIMATED_EMOJI } from './emojiAssets';
import { emojiClusters, isEmojiCluster } from './emojiText';
export { emojiClusters };

/** Parsed Lottie documents, loaded from the bundled asset on first use and kept for the session. */
/** The bundled animation for an emoji, tolerant to a missing or extra U+FE0F. */
function animationModule(emoji: string): number | undefined {
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

export const hasAnimatedEmoji = (emoji: string) => Platform.OS !== 'web' && Boolean(animationModule(emoji));

import { LottieView } from './lottie';
const lottie = () => LottieView;

/**
 * One emoji. With an animation available it plays as Lottie (`loop`, or `once` and then on tap);
 * otherwise, or while animations are off, it is the ordinary system glyph.
 */
export function AnimatedEmoji({ emoji, size, mode = 'loop', tapToReplay = false }: { emoji: string; size: number; mode?: 'loop' | 'once'; tapToReplay?: boolean }) {
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
  return parts.some(part => animationModule(part)) ? parts : null;
}

