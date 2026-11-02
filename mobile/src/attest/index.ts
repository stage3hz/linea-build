import { hmacSha256Hex } from './hmac.ts';
import { ATTEST_KEY } from './key.ts';

/** `X-Linea-Attest` for a state-changing request; empty when this build has no key. */
export function attestHeaders(method: string, pathWithQuery: string, nowMs = Date.now()): Record<string, string> {
  const verb = (method || 'GET').toUpperCase();
  if (!ATTEST_KEY || verb === 'GET' || verb === 'HEAD') return {};
  const ts = Math.floor(nowMs / 1000);
  return { 'X-Linea-Attest': `${ts}.${hmacSha256Hex(ATTEST_KEY, `${ts}\n${verb}\n${pathWithQuery}`)}` };
}
