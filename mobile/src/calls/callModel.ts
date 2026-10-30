// Pure helpers for calls (no React Native imports, covered by tests).

export const OFFER_TTL_MS = 45_000;       // an offer older than this is a missed call, never rings
export const RING_TIMEOUT_MS = 45_000;    // the caller gives up after this
export const GATHER_TIMEOUT_MS = 3_000;   // non-trickle ICE: send what was gathered by then

export type CallStatus = 'requesting' | 'ringing' | 'incoming' | 'connecting' | 'active' | 'ended';

/** An incoming offer rings only if it is fresh and not one we already handled. */
export function offerIsFresh(createdAt: string, nowMs: number, seen: ReadonlySet<string>, callId: string): boolean {
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && nowMs - at <= OFFER_TTL_MS && at - nowMs <= 60_000 && !seen.has(callId);
}

/** DTLS fingerprints from an SDP (the keys that protect the media). */
export function sdpFingerprints(sdp: string): string[] {
  return [...sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm)].map(m => `${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
}

const EMOJI = ['🐶','🐱','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦉','🦄','🐝','🦋','🐢','🐙','🦀','🐬','🐳','🌵','🌲','🌻','🍄','🍎','🍋','🍉','🍓','🍒','🥑','🌶','🍕','🍩','🍪','🎈','🎁','⚽','🏀','🎸','🎧','🚀','🚗','⛵','🏠','⏰','💡','🔑','🔒','📎','✏️','📚','💎','🔥','⭐','🌙','☀️','🌈','❄️','⚡','🌊'];

/** Four emoji derived from a digest of both fingerprints; both sides see the same, like Telegram's call key. */
export function keyEmoji(digestHex: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) out.push(EMOJI[parseInt(digestHex.slice(i * 4, i * 4 + 4), 16) % EMOJI.length]);
  return out;
}

/** Canonical text both peers hash: their fingerprints, sorted so the order does not depend on who called. */
export function keyMaterial(localSdp: string, remoteSdp: string): string | null {
  const local = sdpFingerprints(localSdp), remote = sdpFingerprints(remoteSdp);
  if (!local.length || !remote.length) return null;
  return [...local, ...remote].sort().join('|');
}

export const callClock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
