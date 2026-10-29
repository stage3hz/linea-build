export const STATUS_EMOJI_CHOICES = Object.freeze(['✨', '⭐', '🌙', '☀️', '🌊', '🌿', '🔥', '💎', '🪐', '🎧', '🎮', '🦋']);
const EMOJI = new Set(STATUS_EMOJI_CHOICES);
const MAX_TIMESTAMP = 8_640_000_000_000_000;

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function validStoredGrant(row) {
  if (!row || row.source !== 'admin') return false;
  if (!validTimestamp(row.granted_at)) return false;
  return row.expires_at === null || (validTimestamp(row.expires_at) && row.expires_at > row.granted_at);
}

/** Read only. Grants originate from the separate, trusted administrator CLI. */
export function platinaState(db, userId, time = Date.now()) {
  const row = db.prepare('SELECT source,granted_at,expires_at,revoked_at FROM platina_entitlements WHERE user_id=?').get(userId);
  const valid = validStoredGrant(row);
  const permanent = valid && row.expires_at === null;
  return {
    active: Boolean(valid && validTimestamp(time) && row.revoked_at === null && row.granted_at <= time && (permanent || row.expires_at > time)),
    expiresAt: valid && !permanent ? new Date(row.expires_at).toISOString() : null,
    ...(permanent ? { permanent: true } : {}),
  };
}

export function isStatusEmoji(value) { return typeof value === 'string' && EMOJI.has(value); }

export function visibleStatus(user, platina) {
  const visible = platina.active && isStatusEmoji(user.status_emoji);
  return {
    statusEmoji: visible ? user.status_emoji : null,
    statusEmojiExpiresAt: visible ? platina.expiresAt : null,
    ...(visible && platina.permanent === true && platina.expiresAt === null ? { statusEmojiPermanent: true } : {}),
  };
}
