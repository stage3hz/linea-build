// Request signing ("build attestation"). A real INVIZENT build signs every API
// request with a per-build key: header `X-Linea-Attest: <unix-seconds>.<hex>`,
// where hex = HMAC-SHA256(key, `${ts}\n${METHOD}\n${pathWithQuery}`).
//
// Modes (ATTEST_MODE):
//   off     — nothing is checked (default, and whenever no key is configured);
//   warn    — mismatches are logged and the request still passes. Use this first
//             to see in the logs that every real build signs correctly;
//   enforce — unsigned or wrongly signed requests get 403 ATTEST_FAILED.
//
// The key ships inside the app, so a determined attacker can extract it. This
// is a rotatable bar against casual forks and scripts, not a replacement for
// authentication or end-to-end encryption, which stay unchanged.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ATTEST_WINDOW_SECONDS = 600; // phone clocks drift; replays still need a valid session

export function attestPayload(ts, method, url) {
  return `${ts}\n${String(method).toUpperCase()}\n${url}`;
}

export function signRequest(key, ts, method, url) {
  return createHmac('sha256', key).update(attestPayload(ts, method, url)).digest('hex');
}

/** Returns null when the signature is valid, otherwise a short reason code. */
export function verifyAttest(header, { key, method, url, nowSeconds, windowSeconds = ATTEST_WINDOW_SECONDS }) {
  if (typeof header !== 'string' || header.length > 100) return 'missing';
  const match = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(header);
  if (!match) return 'malformed';
  const ts = Number(match[1]);
  if (!Number.isSafeInteger(ts) || Math.abs(nowSeconds - ts) > windowSeconds) return 'stale';
  const expected = Buffer.from(signRequest(key, ts, method, url), 'hex');
  const given = Buffer.from(match[2], 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given) ? null : 'bad-signature';
}

export function attestMode(mode, key) {
  if (!key) return 'off';
  return mode === 'enforce' || mode === 'warn' ? mode : 'off';
}
