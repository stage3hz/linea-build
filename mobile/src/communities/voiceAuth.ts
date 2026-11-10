// End-to-end check of a voice-room connection. The SDP offer/answer goes through our server (fast,
// no extra round trip), so the server could swap the DTLS fingerprints and sit in the middle.
// Each side therefore also sends a short Signal-encrypted note (CryptoService.sealNote, sealed for
// the other person's very device) naming both fingerprints it sees. A connection is trusted only
// when the other side's note matches the SDP we actually used; on a mismatch it is torn down.
// Microphone, incoming sound, the screen and the screen-share frame keys wait for that check.
// Pure logic, tested in test/voice-auth.test.mjs.

/** `sha-256 AB:CD:…` of every a=fingerprint line, normalised, sorted, joined with '|'. Empty if none. */
export function sdpFingerprints(sdp: string): string {
  const found = new Set<string>();
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const match = /^a=fingerprint:\s*([A-Za-z0-9-]+)\s+([0-9A-Fa-f:]+)\s*$/.exec(line.trim());
    if (match) found.add(`${match[1].toLowerCase()} ${match[2].toUpperCase()}`);
  }
  return [...found].sort().join('|');
}

export type VoiceAuth = { v: 1; channelId: string; from: string; to: string; mine: string; yours: string };

/** The note's text: who I am in the room (socket ids), my fingerprint and the one I see for you. */
export function authText(channelId: string, self: string, peer: string, localSdp: string, remoteSdp: string): string {
  const mine = sdpFingerprints(localSdp), yours = sdpFingerprints(remoteSdp);
  if (!mine || !yours) throw new Error('В описании соединения нет отпечатка DTLS.');
  return JSON.stringify({ v: 1, channelId, from: self, to: peer, mine, yours } satisfies VoiceAuth);
}

/**
 * Checks the note the peer sent us against the SDP of our connection with them.
 * `mine` in their note must be the fingerprint in the SDP we received from them, `yours` must be ours.
 */
export function checkAuth(text: string, expected: { channelId: string; self: string; peer: string; localSdp: string; remoteSdp: string }): boolean {
  let note: any;
  try { note = JSON.parse(text); } catch { return false; }
  if (!note || note.v !== 1 || typeof note.mine !== 'string' || typeof note.yours !== 'string') return false;
  const theirs = sdpFingerprints(expected.remoteSdp), ours = sdpFingerprints(expected.localSdp);
  return !!theirs && !!ours && note.channelId === expected.channelId && note.from === expected.peer && note.to === expected.self
    && note.mine === theirs && note.yours === ours;
}
