// Automatic reconnection of a call (Telegram's «Восстановление связи…»), pure logic shared by 1:1 calls
// (CallProvider.tsx) and voice-room mesh connections (communities/voice.ts). No React Native imports:
// covered by test/call-reconnect.test.mjs.
//
// A live connection that goes `disconnected` gets a short grace period (ICE often recovers by itself
// after a Wi-Fi hiccup). If it does not, or it goes `failed`, or the phone's network changed, the side
// that offers sends an ICE restart (createOffer({ iceRestart: true })) through the same signalling as the
// first SDP — inside Signal for 1:1 calls — and retries with backoff. After RECONNECT_WINDOW_MS without
// media the call ends («Связь потеряна»). The DTLS certificate of a connection does not change on an
// ICE restart, so the fingerprints (and the call's key emoji / the voice-room note) stay valid; a restart
// SDP with other fingerprints is refused (sameFingerprints).

import { sdpFingerprints } from './callModel';

/** `disconnected` is often transient: wait this long before restarting ICE. */
export const DISCONNECT_GRACE_MS = 3_000;
/** The side that does not win the tie-break waits a little longer, so normally only one offer is in flight. */
export const POLITE_EXTRA_MS = 1_500;
/** Give up after this long without media. */
export const RECONNECT_WINDOW_MS = 30_000;
/** Delay before restart attempt N (1-based): at once, then 2 s, 4 s, 8 s, 8 s… */
export const RESTART_BACKOFF_MS = [0, 2_000, 4_000, 8_000] as const;
export const restartDelay = (attempt: number) => RESTART_BACKOFF_MS[Math.max(0, Math.min(attempt, RESTART_BACKOFF_MS.length - 1))];

export type LinkPhase = 'up' | 'grace' | 'reconnecting' | 'lost';
export type Link = {
  phase: LinkPhase;
  /** When the trouble started (the 30 s window counts from here); null while up. */
  troubleAt: number | null;
  /** Restarts sent since the trouble started. */
  attempts: number;
  /** When the next step is due (grace over / next attempt). */
  nextAt: number | null;
};
export const LINK_UP: Link = { phase: 'up', troubleAt: null, attempts: 0, nextAt: null };

export type LinkInput =
  /** RTCPeerConnection.connectionState (or iceConnectionState) changed. */
  | { kind: 'state'; state: string }
  /** The phone's network changed (Wi-Fi ↔ LTE, new IP). */
  | { kind: 'network' }
  /** A timer set for `wakeAt` fired. */
  | { kind: 'timer' };
export type LinkOptions = { graceMs?: number; windowMs?: number };
export type LinkStep = {
  link: Link;
  /** Send an ICE restart offer now. */
  restart: boolean;
  /** The window ran out: end the call / give up on the peer. */
  end: boolean;
  /** The media is back after a reconnect. */
  recovered: boolean;
  /** Call linkNext({ kind: 'timer' }) at this time (null: nothing scheduled). */
  wakeAt: number | null;
};

const wake = (link: Link, windowMs: number) => link.phase === 'up' || link.phase === 'lost' || link.troubleAt === null ? null
  : Math.min(link.nextAt ?? Infinity, link.troubleAt + windowMs);

/**
 * The reconnect state machine: up → grace (disconnected) → reconnecting (restart offers with backoff)
 * → up again (connected) or lost (the window ran out). `lost` is final.
 */
export function linkNext(link: Link, input: LinkInput, now: number, options: LinkOptions = {}): LinkStep {
  const graceMs = options.graceMs ?? DISCONNECT_GRACE_MS, windowMs = options.windowMs ?? RECONNECT_WINDOW_MS;
  const out = (next: Link, restart = false, end = false, recovered = false): LinkStep => ({ link: next, restart, end, recovered, wakeAt: wake(next, windowMs) });
  if (link.phase === 'lost') return out(link);
  const attempt = (troubleAt: number, attempts: number): LinkStep =>
    out({ phase: 'reconnecting', troubleAt, attempts, nextAt: now + restartDelay(attempts) }, true);

  if (input.kind === 'state') {
    if (input.state === 'connected' || input.state === 'completed') return out(LINK_UP, false, false, link.phase !== 'up');
    if (input.state === 'disconnected') {
      if (link.phase !== 'up') return out(link);
      return out({ phase: 'grace', troubleAt: now, attempts: 0, nextAt: now + graceMs });
    }
    if (input.state === 'failed') {
      // Already restarting: the next attempt is on its timer (a failed check of the previous attempt changes nothing).
      if (link.phase === 'reconnecting') return out(link);
      return attempt(link.troubleAt ?? now, 1);
    }
    return out(link); // new / checking / connecting / closed
  }
  if (input.kind === 'network') {
    // The old path is probably gone: restart at once. While the media still flows, no «Восстановление связи…».
    if (link.phase === 'up') return { ...out(link), restart: true };
    return attempt(link.troubleAt ?? now, link.attempts + 1);
  }
  // timer
  if (link.phase === 'up' || link.troubleAt === null) return out(link);
  if (now >= link.troubleAt + windowMs) return out({ ...link, phase: 'lost', nextAt: null }, false, true);
  if (link.nextAt !== null && now >= link.nextAt) return attempt(link.troubleAt, link.attempts + 1);
  return out(link);
}

/** «Восстановление связи…» on the call screen: from the first restart until the media is back. */
export const linkShowsReconnecting = (link: Link) => link.phase === 'reconnecting' || link.phase === 'grace';

/**
 * Glare: both sides sent a restart offer at once. The tie-break is fixed by the call itself: the caller
 * is «impolite» (keeps its offer, ignores the other one), the callee «polite» (rolls its own back and
 * answers). In voice rooms the smaller room id is the impolite side.
 */
/** Our own restart offer older than this no longer wins glare (its message may have been lost): answer theirs. */
export const PENDING_OFFER_STALE_MS = 8_000;
export type RemoteRestartDecision = 'answer' | 'rollback-and-answer' | 'ignore-glare' | 'ignore-stale' | 'ignore-fingerprint';
export function remoteRestart(input: { gen: number; lastRemoteGen: number; signalingState: string; polite: boolean; fingerprintsMatch: boolean; pendingAgeMs?: number }): RemoteRestartDecision {
  if (!Number.isInteger(input.gen) || input.gen <= input.lastRemoteGen) return 'ignore-stale';
  if (!input.fingerprintsMatch) return 'ignore-fingerprint';
  if (input.signalingState === 'have-local-offer') return input.polite || (input.pendingAgeMs ?? 0) > PENDING_OFFER_STALE_MS ? 'rollback-and-answer' : 'ignore-glare';
  return 'answer';
}

/** A restart answer counts only for the offer we are waiting for (the newest one we sent). */
export function restartAnswerFits(input: { gen: number; pendingGen: number | null; signalingState: string; fingerprintsMatch: boolean }): boolean {
  return input.pendingGen !== null && input.gen === input.pendingGen && input.signalingState === 'have-local-offer' && input.fingerprintsMatch;
}

/** Voice rooms: which side of a pair sends the ICE restart (and wins glare). Deterministic on both sides. */
export const voiceRestartOfferer = (self: string, peer: string) => self < peer;

/** The DTLS fingerprints of a restart SDP must be the ones the call was set up (and verified) with. */
export function sameFingerprints(a: string, b: string): boolean {
  const x = sdpFingerprints(a), y = sdpFingerprints(b);
  return x.length > 0 && x.length === y.length && [...x].sort().join('|') === [...y].sort().join('|');
}

/**
 * Capability marker: a client that understands the `restart` / `restart-answer` steps says so with a
 * session-level SDP attribute (unknown attributes are ignored by every WebRTC stack, RFC 8866 §5.13).
 * Older apps reject unknown call steps (validMeta), so they never get one.
 */
export const RESTART_ATTRIBUTE = 'a=x-invizent-restart:1';
export function markRestartCapable(sdp: string): string {
  if (!sdp || sdp.includes(RESTART_ATTRIBUTE)) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const media = lines.findIndex(line => line.startsWith('m='));
  if (media < 0) return sdp;
  lines.splice(media, 0, RESTART_ATTRIBUTE);
  return lines.join(eol);
}
export const restartCapable = (sdp: string | undefined) => !!sdp && sdp.split(/\r?\n/).includes(RESTART_ATTRIBUTE);
/** The marker is ours, not WebRTC's: removed before the SDP is handed to the connection. */
export const stripRestartMarker = (sdp: string) => sdp.replace(/^a=x-invizent-restart:1(\r?\n|$)/m, '');

/** A key for «the network changed»: type plus the IP address (NetInfo), so LTE → Wi-Fi and a new IP both count. */
export function networkKey(state: { type?: string; isConnected?: boolean | null; details?: { ipAddress?: string } | null } | null | undefined): string {
  if (!state || state.isConnected === false) return 'offline';
  return `${state.type || 'unknown'}|${state.details?.ipAddress || ''}`;
}
