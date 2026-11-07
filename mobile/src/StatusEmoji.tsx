import { usePowerFeatures } from './motion';
import React, { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { Text } from './typography';
import { AnimatedEmoji, hasAnimatedEmoji } from './platina/AnimatedEmoji';
import { statusEmojiRefreshDelay, visibleStatusEmoji, type StatusUser } from './statusEmojiModel';
import { PlatinaGem } from './platina/PlatinaMark';

/**
 * `animated`: play the Platina animation (profile, chat header); lists keep the plain glyph.
 * Like Telegram Premium's star: a Platina account without a chosen status shows the Platina diamond;
 * a chosen emoji replaces it (`gem={false}` turns the fallback off).
 */
export function StatusEmoji({ user, size = 16, animated = false, gem = true }: { user: StatusUser & { seal?: string | null }; size?: number; animated?: boolean; gem?: boolean }) {
  const [clock, setClock] = useState(Date.now); const emojiOn = usePowerFeatures().emoji;
  const now = Math.max(clock, Date.now());
  const emoji = visibleStatusEmoji(user, now);
  useEffect(() => {
    const refresh = () => setClock(Date.now());
    const delay = statusEmojiRefreshDelay(user);
    const timer = delay === null ? undefined : setTimeout(refresh, delay);
    const listener = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { if (timer !== undefined) clearTimeout(timer); listener.remove(); };
  }, [user.statusEmoji, user.statusEmojiExpiresAt, user.statusEmojiPermanent, clock]);
  if (!emoji) return gem && user.seal === 'platina' ? <View accessibilityLabel="Platina" style={{ flexShrink: 0 }}><PlatinaGem size={Math.round(size * 0.8)} /></View> : null;
  if (animated && emojiOn && hasAnimatedEmoji(emoji)) return <View accessibilityLabel={`Статус ${emoji}`} style={{ flexShrink: 0 }}><AnimatedEmoji emoji={emoji} size={size * 1.2} /></View>;
  return <Text accessibilityLabel={`Статус ${emoji}`} style={{ fontSize: size, lineHeight: size * 1.4, flexShrink: 0 }}>{emoji}</Text>;
}
