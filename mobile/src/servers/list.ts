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
