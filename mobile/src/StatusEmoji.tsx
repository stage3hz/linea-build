import React, { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { Text } from './typography';
import { AnimatedEmoji, hasAnimatedEmoji } from './platina/AnimatedEmoji';
import { statusEmojiRefreshDelay, visibleStatusEmoji, type StatusUser } from './statusEmojiModel';

/** `animated`: play the Platina animation (profile, chat header); lists keep the plain glyph. */
export function StatusEmoji({ user, size = 16, animated = false }: { user: StatusUser; size?: number; animated?: boolean }) {
  const [clock, setClock] = useState(Date.now);
  const now = Math.max(clock, Date.now());
  const emoji = visibleStatusEmoji(user, now);
  useEffect(() => {
    const refresh = () => setClock(Date.now());
    const delay = statusEmojiRefreshDelay(user);
    const timer = delay === null ? undefined : setTimeout(refresh, delay);
    const listener = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { if (timer !== undefined) clearTimeout(timer); listener.remove(); };
  }, [user.statusEmoji, user.statusEmojiExpiresAt, user.statusEmojiPermanent, clock]);
  if (!emoji) return null;
  if (animated && hasAnimatedEmoji(emoji)) return <View accessibilityLabel={`Статус ${emoji}`} style={{ flexShrink: 0 }}><AnimatedEmoji emoji={emoji} size={size * 1.2} /></View>;
  return <Text accessibilityLabel={`Статус ${emoji}`} style={{ fontSize: size, lineHeight: size * 1.4, flexShrink: 0 }}>{emoji}</Text>;
}
