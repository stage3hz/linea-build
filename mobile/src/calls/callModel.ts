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

/** Telegram's call duration: 0:42, 3:12, 1:02:05 (hours appear only from the first full hour). */
export function formatCallDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

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

// ---- The `end` a call leaves behind (F9) and the incoming alert (F2) --------------------------------

export type CallEndReason = 'hangup' | 'declined' | 'busy' | 'missed' | 'failed';
/** What an `end` needs to know about the call: its id, whether it was video, whether this phone placed it, when the media connected. */
export type CallEndSource = { id: string; video: boolean; incoming: boolean; startedAt: number | null };
export type CallEndMeta = { type: 'call'; call: string; step: 'end'; reason: CallEndReason; video: boolean; caller: boolean; duration?: number };

/** Whole seconds since the media connected, never negative and never longer than the week validMeta allows. */
export const callDurationSeconds = (startedAt: number, nowMs: number) => Math.min(7 * 86400, Math.max(0, Math.round((nowMs - startedAt) / 1000)));

/**
 * Every `end` this phone sends is built here, so the busy / privacy / timeout ends carry the same fields as a
 * hang-up: the outcome, whether it was video, whether this phone placed the call and — for an answered call — how
 * long it lasted. Both chats render the service row and Люди › Звонки from these fields alone, inside the ciphertext.
 */
export function callEndMeta(call: CallEndSource, reason: CallEndReason, nowMs = Date.now()): CallEndMeta {
  return { type: 'call', call: call.id, step: 'end', reason, video: call.video, caller: !call.incoming, ...(call.startedAt ? { duration: callDurationSeconds(call.startedAt, nowMs) } : {}) };
}

/**
 * «Завершить» / «Отклонить» by status (Telegram's discard reasons): a call that never connected is never an
 * answered call. Incoming ring → declined; ringing → the other person missed it (this chat: «Отменённый звонок»);
 * connecting (the answer arrived, the media did not) → missed for the caller, declined for the callee; active →
 * hangup with the duration. While requesting nothing was sent yet, so nothing is sent now (reason null).
 */
export function hangupOutcome(status: CallStatus, incoming: boolean): { text: string; reason: CallEndReason | null } {
  switch (status) {
    case 'incoming': return { text: 'Звонок отклонён', reason: 'declined' };
    case 'requesting': return { text: 'Звонок отменён', reason: null };
    case 'ringing': return { text: 'Звонок отменён', reason: 'missed' };
    case 'connecting': return incoming ? { text: 'Звонок отклонён', reason: 'declined' } : { text: 'Звонок отменён', reason: 'missed' };
    default: return { text: 'Звонок завершён', reason: 'hangup' };
  }
}

/**
 * How an incoming call announces itself, from Настройки › Уведомления и звуки › Звонки: «Без мелодии» rings
 * silently, «Вибрация» off keeps the phone still. Both named melodies play the one incoming asset the app ships
 * (call_incoming.wav); the ringback the caller hears is not a ringtone and is not affected.
 */
export function incomingAlert(calls: { ringtone: 'neon' | 'pulse' | 'none'; vibration: boolean }): { sound: boolean; vibrate: boolean } {
  return { sound: calls.ringtone !== 'none', vibrate: calls.vibration };
}
