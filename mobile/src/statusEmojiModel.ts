import type { User } from './types';

// A fixed set of Unicode emoji (animated with Platina where an animation is bundled). Unknown payloads are not rendered.
export const STATIC_STATUS_EMOJI = ['✨','⭐','🌙','☀️','🌊','🌿','🔥','💎','🪐','🎧','🎮','🦋','🌛','🌞','🎶','👾','⚡','❄️','🌈','👑'] as const;
export type StatusUser = Pick<User, 'statusEmoji' | 'statusEmojiExpiresAt' | 'statusEmojiPermanent'>;

export function visibleStatusEmoji(user: StatusUser, now = Date.now()): string | null {
  if (!(STATIC_STATUS_EMOJI as readonly string[]).includes(user.statusEmoji || '')) return null;
  const expiry = user.statusEmojiExpiresAt;
  // A missing expiry alone is never permission. Permanent grants have an
  // explicit server marker and exactly null expiry; inconsistent data hides.
  if (user.statusEmojiPermanent === true) return expiry === null ? user.statusEmoji! : null;
  if (user.statusEmojiPermanent !== undefined && user.statusEmojiPermanent !== false) return null;
  if (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= now) return null;
  return user.statusEmoji!;
}

export function statusEmojiRefreshDelay(user: StatusUser, now = Date.now()): number | null {
  if (!visibleStatusEmoji(user, now)) return null;
  if (user.statusEmojiPermanent === true) return null;
  return Math.min(2_147_483_647, Date.parse(user.statusEmojiExpiresAt!) - now + 1);
}
