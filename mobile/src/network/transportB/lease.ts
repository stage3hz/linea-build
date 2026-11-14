// Stage B: validate a short-lived, device-bound WebRTC session offer.
// This does NOT acquire the offer; the restricted-network bootstrap remains unimplemented.
import { ed25519 } from '@noble/curves/ed25519';
import { toByteArray } from 'base64-js';

export type TransportBLease = {
  protocol: 'invizent-transport-b-v1';
  provider: 'wbstream';
  joinLink: string;
  deviceId: string;
  realm: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
};
export type SignedTransportBLease = { payload: string; sig: string };
export const MAX_LEASE_MS = 30 * 60_000;
const ROOM = /^wbstream:\/\/[a-zA-Z0-9_-]{6,160}$/;
const DEVICE = /^[a-zA-Z0-9_-]{8,96}$/;
const BASE64_SIG = /^[a-zA-Z0-9+/]{86}==$/;
const BASE64_KEY = /^[a-zA-Z0-9+/]{43}=$/;

/** Only accept offers authenticated by a pinned online signing key and bound to this device and realm. */
export function verifyTransportBLease(
  signed: unknown,
  publicKeys: readonly string[],
  expected: { deviceId: string; realm: string; now: number; minSequence?: number },
): TransportBLease | null {
  if (!signed || typeof signed !== 'object' || !expected || !Array.isArray(publicKeys) || !publicKeys.length || publicKeys.length > 8) return null;
  const { payload, sig } = signed as SignedTransportBLease;
  if (typeof payload !== 'string' || payload.length > 4096 || !payload || typeof sig !== 'string' || !BASE64_SIG.test(sig)) return null;
  if (typeof expected.deviceId !== 'string' || !DEVICE.test(expected.deviceId) || typeof expected.realm !== 'string' || !expected.realm.startsWith('https://') || !Number.isSafeInteger(expected.now)) return null;
  const message = new TextEncoder().encode(payload);
  let valid = false;
  for (const key of publicKeys) {
    if (typeof key !== 'string' || !BASE64_KEY.test(key)) continue;
    try {
      if (ed25519.verify(toByteArray(sig), message, toByteArray(key))) { valid = true; break; }
    } catch { /* invalid signature/key */ }
  }
  if (!valid) return null;
  if (expected.minSequence !== undefined && (!Number.isSafeInteger(expected.minSequence) || expected.minSequence < 0)) return null;
  let lease: TransportBLease;
  try { lease = JSON.parse(payload) as TransportBLease; } catch { return null; }
  if (!lease || typeof lease !== 'object' || lease.protocol !== 'invizent-transport-b-v1' || lease.provider !== 'wbstream' || typeof lease.joinLink !== 'string' || !ROOM.test(lease.joinLink)) return null;
  if (lease.deviceId !== expected.deviceId || lease.realm !== expected.realm) return null;
  if (!Number.isSafeInteger(lease.sequence) || lease.sequence < 0 || (expected.minSequence !== undefined && lease.sequence <= expected.minSequence)) return null;
  if (!Number.isSafeInteger(lease.issuedAt) || !Number.isSafeInteger(lease.expiresAt)) return null;
  if (lease.issuedAt > expected.now + 60_000 || lease.expiresAt <= expected.now || lease.expiresAt <= lease.issuedAt || lease.expiresAt - lease.issuedAt > MAX_LEASE_MS) return null;
  return lease;
}
