/**
 * Stage B: signed per-device WebRTC offers.
 * Prototype only; the private key and strictly increasing sequence source MUST be
 * injected by a trusted service (never be bundled into the mobile app).
 */
import { createPrivateKey, createPublicKey, sign as signEd25519 } from 'node:crypto';
import { isProviderJoinLink, requireTransportProvider } from './providers.mjs';

const DEVICE = /^[A-Za-z0-9_-]{8,96}$/;
const MAX_TTL_MS = 30 * 60_000;
const CANONICAL_REALM = 'https://api.invizent.com';

export function makeLeaseIssuer({ privateKey, nextSequence, now = Date.now, realm = CANONICAL_REALM, provider: selectedProvider } = {}) {
  const provider = requireTransportProvider(selectedProvider);
  if (!privateKey || typeof nextSequence !== 'function' || typeof now !== 'function') {
    throw new TypeError('privateKey, nextSequence and clock are required');
  }
  if (realm !== CANONICAL_REALM) throw new TypeError('unsupported realm');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 signing key required');
  const publicKey = createPublicKey(key);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // RFC 8410 Ed25519 SPKI prefix, followed by exactly 32 raw key bytes.
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (spki.length !== prefix.length + 32 || !spki.subarray(0, prefix.length).equals(prefix))
    throw new Error('unexpected Ed25519 public key encoding');
  const publicKeyBase64 = spki.subarray(prefix.length).toString('base64');

  async function issue({ deviceId, joinLink, expiresAt, provider: requestedProvider }) {
    if (requestedProvider !== undefined) throw new TypeError('provider is configured by the issuer');
    if (typeof deviceId !== 'string' || !DEVICE.test(deviceId)) throw new TypeError('invalid device ID');
    if (!isProviderJoinLink(provider, joinLink)) throw new TypeError('invalid join link');
    const issuedAt = now();
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) throw new RangeError('invalid session lease lifetime');
    // This callback must use durable monotonic state for each device; no shared in-memory
    // sequence source is sufficient for production when multiple servers/restarts are involved.
    const sequence = await nextSequence(deviceId);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('invalid lease sequence');
    const payload = JSON.stringify({
      protocol: 'invizent-transport-b-v1', provider,
      joinLink, deviceId, realm, sequence, issuedAt, expiresAt,
    });
    const sig = signEd25519(null, Buffer.from(payload, 'utf8'), key).toString('base64');
    return { payload, sig };
  }

  return { realm, publicKeyBase64, issue };
}
