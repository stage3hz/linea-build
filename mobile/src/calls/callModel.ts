// Pure helpers for calls (no React Native imports, covered by tests).

export const OFFER_TTL_MS = 45_000;       // an offer older than this is a missed call, never rings
export const RING_TIMEOUT_MS = 45_000;    // the caller gives up after this
export const GATHER_TIMEOUT_MS = 3_000;   // non-trickle ICE: send what was gathered by then
/** With a relay (TURN) configured, the wait goes on up to this long for the relay's own address to arrive. */
export const GATHER_RELAY_MS = 10_000;

/**
 * Non-trickle ICE: the addresses a phone can be reached at are sent once, inside the offer / answer — whatever is
 * missing then never reaches the other side. On a mobile network the two phones usually cannot reach each other
 * directly and the call lives on the relay's address alone; that one takes the longest to arrive (a name lookup,
 * then two round trips to the relay, over TCP when the operator drops UDP). Sending after a flat 3 s left it out on
 * a slow or busy link — the call rang and then failed with «Не удалось соединиться», while the same two people
 * connected fine on Wi-Fi. So: once gathering is complete, at once; otherwise after 3 s only if the relay's address
 * is already there (or no relay is configured); and never later than 10 s.
 */
export function gatherDone(state: { complete: boolean; relay: boolean; wantRelay: boolean; elapsedMs: number }): boolean {
  if (state.complete || state.elapsedMs >= GATHER_RELAY_MS) return true;
  return state.elapsedMs >= GATHER_TIMEOUT_MS && (state.relay || !state.wantRelay);
}
/** Whether an ICE candidate line is the relay's address (`… typ relay …`). */
export const isRelayCandidate = (candidate: unknown): boolean => typeof candidate === 'string' && /\btyp relay\b/.test(candidate);
/** Whether the servers the app was given include a relay (TURN). */
export const hasRelay = (iceServers: readonly { urls?: string | string[] }[] | undefined): boolean =>
  !!iceServers?.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => typeof url === 'string' && /^turns?:/i.test(url)));

/** How long the servers for a call (and the relay's short-lived password, good for 6 h) may be reused when the
 *  request for fresh ones fails. */
export const ICE_REUSE_MS = 4 * 60 * 60_000;

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

// ─── Диагностика звонка (экран звонка: нажатие на статус) ───────────────────────────────────────────────────────
/** How the call's media travels and how well: read from WebRTC's own statistics while the call is up. */
export type CallLink = {
  /** direct: phone to phone; relay-udp / relay-tcp: through the server's relay (TCP when the network drops UDP). */
  route: 'direct' | 'relay-udp' | 'relay-tcp' | 'relay' | null;
  rttMs: number | null; lossPct: number | null; jitterMs: number | null; kbpsOut: number | null; kbpsIn: number | null;
};
export type CallLinkSample = { at: number; sent: number; received: number };
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** `reports`: the entries of RTCPeerConnection.getStats(). `previous`: the last sample, for the bitrates. */
export function callLink(reports: Iterable<any>, previous: CallLinkSample | null, nowMs: number): { link: CallLink; sample: CallLinkSample } {
  const byId = new Map<string, any>(); const all: any[] = [];
  for (const report of reports) { if (report && typeof report === 'object') { all.push(report); if (typeof report.id === 'string') byId.set(report.id, report); } }
  const transport = all.find(r => r.type === 'transport' && typeof r.selectedCandidatePairId === 'string');
  const pair = (transport && byId.get(transport.selectedCandidatePairId)) || all.find(r => r.type === 'candidate-pair' && (r.selected === true || (r.nominated === true && r.state === 'succeeded'))) || null;
  const local = pair ? byId.get(pair.localCandidateId) : null, remote = pair ? byId.get(pair.remoteCandidateId) : null;
  let route: CallLink['route'] = null;
  if (pair) {
    if (local?.candidateType === 'relay') route = local.relayProtocol === 'udp' ? 'relay-udp' : local.relayProtocol === 'tcp' || local.relayProtocol === 'tls' ? 'relay-tcp' : 'relay';
    else if (remote?.candidateType === 'relay') route = 'relay';
    else route = 'direct';
  }
  const audioIn = all.find(r => r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio'));
  const audioOut = all.find(r => r.type === 'outbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio'));
  const lost = num(audioIn?.packetsLost), got = num(audioIn?.packetsReceived);
  const sent = all.filter(r => r.type === 'outbound-rtp').reduce((sum, r) => sum + (num(r.bytesSent) ?? 0), 0);
  const received = all.filter(r => r.type === 'inbound-rtp').reduce((sum, r) => sum + (num(r.bytesReceived) ?? 0), 0);
  const seconds = previous ? (nowMs - previous.at) / 1000 : 0;
  const rate = (now: number, before: number) => (previous && seconds >= 0.5 && now >= before ? Math.round((now - before) * 8 / seconds / 1000) : null);
  const rtt = num(pair?.currentRoundTripTime), jitter = num(audioIn?.jitter);
  return {
    link: {
      route,
      rttMs: rtt === null ? null : Math.round(rtt * 1000),
      lossPct: lost === null || got === null || lost + got <= 0 ? null : Math.round(Math.max(0, lost) / (Math.max(0, lost) + got) * 1000) / 10,
      jitterMs: jitter === null ? null : Math.round(jitter * 1000),
      kbpsOut: rate(sent, previous?.sent ?? 0), kbpsIn: rate(received, previous?.received ?? 0),
    },
    sample: { at: nowMs, sent, received },
  };
}
const ROUTES: Record<NonNullable<CallLink['route']>, string> = { direct: 'напрямую', 'relay-udp': 'через сервер (UDP)', 'relay-tcp': 'через сервер (TCP)', relay: 'через сервер' };
const TIERS: Record<CallTier, string> = { slow: 'экономия (12 кбит/с)', medium: 'средний (24 кбит/с)', fast: 'полное качество' };
/** The lines shown on the call screen. A dash where WebRTC has no figure yet. */
export function callLinkLines(link: CallLink, tier: CallTier): string[] {
  const show = (value: number | null, unit: string) => (value === null ? '—' : `${value} ${unit}`);
  return [
    `Маршрут: ${link.route ? ROUTES[link.route] : '—'}`,
    `Задержка: ${show(link.rttMs, 'мс')} · потери: ${show(link.lossPct, '%')} · дрожание: ${show(link.jitterMs, 'мс')}`,
    `Отправка: ${show(link.kbpsOut, 'кбит/с')} · приём: ${show(link.kbpsIn, 'кбит/с')}`,
    `Режим звука: ${TIERS[tier]}`,
  ];
}

