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

/**
 * Economy voice for slow links (EDGE/3G). Opus can work from 6 kbit/s (RFC 7587 §3.1); the RFC
 * recommends 8–12 kbit/s for narrowband speech and 16–20 kbit/s for wideband. Our SDP tells the
 * other phone what to send us; packets of 60 ms cut header overhead about threefold vs 20 ms;
 * DTX (no packets in silence) only when bandwidth is very tight, as the RFC advises.
 */
export type CallTier = 'slow' | 'medium' | 'fast';
export const SEND_BITRATE: Record<CallTier, number | null> = { slow: 12_000, medium: 24_000, fast: null };

export function economySdp(sdp: string, tier: CallTier): string {
  if (tier === 'fast' || !sdp) return sdp;
  const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  const wanted: Record<string, string> = tier === 'slow'
    ? { maxaveragebitrate: '12000', maxplaybackrate: '16000', stereo: '0', useinbandfec: '1', usedtx: '1' }
    : { maxaveragebitrate: '24000', stereo: '0', useinbandfec: '1' };
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const fmtp = lines.findIndex(l => l.startsWith(`a=fmtp:${pt} `));
  const merge = (existing: string) => {
    const params = new Map(existing.split(';').map(p => p.trim()).filter(Boolean).map(p => { const i = p.indexOf('='); return [i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1)] as [string, string]; }));
    for (const [k, v] of Object.entries(wanted)) params.set(k, v);
    return [...params].map(([k, v]) => (v ? `${k}=${v}` : k)).join(';');
  };
  if (fmtp >= 0) lines[fmtp] = `a=fmtp:${pt} ${merge(lines[fmtp].slice(`a=fmtp:${pt} `.length))}`;
  else { const map = lines.findIndex(l => l.startsWith(`a=rtpmap:${pt} `)); lines.splice(map + 1, 0, `a=fmtp:${pt} ${merge('')}`); }
  if (tier === 'slow') {
    // a=ptime belongs to the audio section: put it right after that section's m= line block start.
    const audio = lines.findIndex(l => l.startsWith('m=audio'));
    const end = lines.findIndex((l, i) => i > audio && l.startsWith('m='));
    const section = lines.slice(audio, end < 0 ? lines.length : end);
    if (audio >= 0 && !section.some(l => l.startsWith('a=ptime:'))) lines.splice((end < 0 ? lines.length : end) - (lines[lines.length - 1] === '' && end < 0 ? 1 : 0), 0, 'a=ptime:60');
  }
  return lines.join(eol);
}
