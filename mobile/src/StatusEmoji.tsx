import React, { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { Text } from './typography';
import { statusEmojiRefreshDelay, visibleStatusEmoji, type StatusUser } from './statusEmojiModel';

export function StatusEmoji({ user, size = 16 }: { user: StatusUser; size?: number }) {
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
  return <Text accessibilityLabel={`Статус ${emoji}`} style={{ fontSize: size, lineHeight: size * 1.4, flexShrink: 0 }}>{emoji}</Text>;
}
