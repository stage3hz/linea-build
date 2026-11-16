// Signed server list. The owner signs it offline (deploy/servers.mjs); the app only accepts
// lists signed by a key built into it, so a hijacked DNS name or a captured data centre cannot
// point people at a foreign server. Pure functions — tested in test/servers.test.mjs.
import { ed25519 } from '@noble/curves/ed25519';
import { toByteArray } from 'base64-js';

export type ServerEntry = { url: string; region?: string };
export type ServerList = { version: number; issuedAt: string; servers: ServerEntry[] };
export type SignedServerList = { payload: string; sig: string };

/** Only our own domains may ever carry the account (the PC app enforces the same rule). */
export const TRUSTED_HOST = /^(?:[a-z0-9-]+\.)*invizent\.(?:com|ru)$|^141-133-194-51\.nip\.io$|^invizent-api\.invizent-8165e2\.workers\.dev$/;

export function normalizeServer(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
    if (!TRUSTED_HOST.test(u.hostname) || (u.port && u.port !== '443')) return null;
    return `https://${u.hostname}`;
  } catch { return null; }
}

const fromBase64 = (value: string) => toByteArray(value);

/**
 * Checks the signature with the built-in keys and the content rules. Returns the list or null.
 * `minVersion` stops an attacker from replaying an older, still-validly-signed list.
 */
export function verifyServerList(signed: unknown, keys: readonly string[], minVersion = 0): ServerList | null {
  if (!signed || typeof signed !== 'object') return null;
  const { payload, sig } = signed as SignedServerList;
  if (typeof payload !== 'string' || payload.length > 16_384 || typeof sig !== 'string' || !/^[A-Za-z0-9+/=]{80,100}$/.test(sig)) return null;
  const message = new TextEncoder().encode(payload);
  let ok = false;
  for (const key of keys) {
    try { if (/^[A-Za-z0-9+/=]{40,48}$/.test(key) && ed25519.verify(fromBase64(sig), message, fromBase64(key))) { ok = true; break; } } catch { /* next key */ }
  }
  if (!ok) return null;
  let list: ServerList;
  try { list = JSON.parse(payload); } catch { return null; }
  if (!Number.isSafeInteger(list?.version) || list.version < minVersion || !Array.isArray(list.servers) || list.servers.length < 1 || list.servers.length > 32) return null;
  const servers: ServerEntry[] = [];
  for (const entry of list.servers) {
    const url = normalizeServer(entry?.url);
    if (!url || servers.some(s => s.url === url)) return null;
    servers.push({ url, ...(typeof entry.region === 'string' && entry.region.length <= 40 ? { region: entry.region } : {}) });
  }
  return { version: list.version, issuedAt: String(list.issuedAt || ''), servers };
}

/**
 * Picks the server to use. Measured round trips decide; the current one is kept unless it
 * fails or another is clearly faster (≥40 ms and ≥30 %), so the app does not flip-flop.
 */
export function chooseServer(current: string | null, rtt: Record<string, number | null>): string | null {
  const alive = Object.entries(rtt).filter((e): e is [string, number] => typeof e[1] === 'number').sort((a, b) => a[1] - b[1]);
  if (!alive.length) return current;
  const [bestUrl, best] = alive[0];
  const now = current ? rtt[current] : null;
  if (current && typeof now === 'number' && !(now - best >= 40 && best <= now * 0.7)) return current;
  return bestUrl;
}

/**
 * After `failed` stopped answering: the next server to try. Measured-alive servers first (fastest
 * first), then never-measured ones; servers whose last probe failed or that failed recently come
 * after — and if every other server is known dead, we stay on `failed` (a slow link drops
 * requests now and then; jumping to a dead server would waste a whole upload).
 */
export function fallbackServer(failed: string, all: readonly string[], rtt: Record<string, number | null | undefined>, down: Record<string, number>, now: number, downMs: number): string | null {
  const others = all.filter(u => u !== failed);
  if (!others.length) return null;
  const recentlyDown = (u: string) => !!down[u] && now - down[u] < downMs;
  const rank = (u: string) => (recentlyDown(u) || rtt[u] === null ? 2 : typeof rtt[u] === 'number' ? 0 : 1);
  const best = [...others].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (rtt[a] as number) - (rtt[b] as number) : rank(a) === 2 ? (down[a] || 0) - (down[b] || 0) : 0))[0];
  return rank(best) === 2 && all.includes(failed) ? failed : best;
}

/**
 * Whether an answer to GET /health is this service's own: HTTP 200 with the JSON `{"status":"ok"}` the server sends.
 * Any other successful page (a captive portal, a provider's stub, an HTML error page) is not a working route.
 */
export function healthOk(status: number, body: string): boolean {
  if (status !== 200 || body.length > 256) return false;
  try { const value = JSON.parse(body) as { status?: unknown } | null; return !!value && typeof value === 'object' && value.status === 'ok'; } catch { return false; }
}

/** How many measurements in a row a direct server must answer before the app leaves the reserve entrance for it. */
export const RETURN_AFTER = 2;

/**
 * Picks the address after a measurement, with the reserve entrance as the last resort:
 *  - a direct server is used whenever one answers — but coming BACK from the reserve needs RETURN_AFTER
 *    measurements in a row with a direct answer (`directStreak` counts them, this one included), so a direct route
 *    that works every other minute does not make the app jump to and fro;
 *  - the reserve is taken only when no direct server answers, and only if it is allowed (`reserveAllowed`);
 *  - nothing answers: the current address is kept and tried again.
 */
export function pickRoute(current: string | null, direct: Record<string, number | null>, reserve: Record<string, number | null>, directStreak: number, reserveAllowed: boolean): string | null {
  const onReserve = !!current && current in reserve;
  const directAlive = Object.values(direct).some(value => typeof value === 'number');
  if (directAlive) {
    if (onReserve && reserveAllowed && directStreak < RETURN_AFTER && typeof reserve[current!] === 'number') return current;
    return chooseServer(current && !onReserve ? current : null, direct);
  }
  if (reserveAllowed) { const next = chooseServer(onReserve ? current : null, reserve); if (next && typeof reserve[next] === 'number') return next; }
  return current;
}

export type RouteState = 'direct' | 'checking' | 'reserve' | 'returning' | 'offline';
/**
 * What the connection is doing, for the status line and diagnostics. It says which route is in use — never why another
 * one failed (a timeout does not show what stopped the request).
 *  - `reserve`: the reserve entrance is in use; `returning`: it still is, while a direct server has begun to answer;
 *  - `offline`: the last measurement found no answering server at all; `checking`: no measurement has finished yet,
 *    or the address in use has just failed and the others are being measured.
 */
export function routeState(input: { current: string | null; edges: readonly string[]; rtt: Record<string, number | null | undefined>; measured: boolean; probing: boolean; directStreak: number }): RouteState {
  const { current, edges, rtt } = input;
  const alive = Object.values(rtt).some(value => typeof value === 'number');
  if (!input.measured) return 'checking';
  if (!alive) return input.probing ? 'checking' : 'offline';
  if (current && edges.includes(current)) return input.directStreak > 0 ? 'returning' : 'reserve';
  if (current && typeof rtt[current] !== 'number') return 'checking';
  return 'direct';
}

/** The reserve entrance carries the traffic now (also while the direct route is being checked before the return). */
export const usesReserve = (state: RouteState): boolean => state === 'reserve' || state === 'returning';

/**
 * When to measure again, besides the regular five-minute round: `null` — no extra measurement.
 *  - on the reserve while a direct server has begun to answer: soon, so the return does not wait a whole round;
 *  - nothing answered: after 15 s, then 30 s, 60 s… up to the regular round (`emptyRuns` counts such measurements in a
 *    row), so a phone without a route neither waits five minutes nor asks in a tight loop.
 */
export function nextMeasureDelay(input: { alive: boolean; returning: boolean; emptyRuns: number; regularMs: number }): number | null {
  if (input.returning) return 20_000;
  if (input.alive) return null;
  return Math.min(input.regularMs, 15_000 * 2 ** Math.max(0, Math.min(10, input.emptyRuns - 1)));
}
