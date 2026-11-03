// How fast the connection really is right now, measured from our own requests (no permissions,
// no list of networks): round-trip time of small requests and throughput of bigger answers.
// Pure core is tested in test/network-quality.test.mjs.

/** slow ≈ EDGE/2G, medium ≈ 3G, fast ≈ LTE/Wi-Fi. */
export type NetworkTier = 'slow' | 'medium' | 'fast';

export type QualityState = { rttMs: number | null; kbps: number | null; tier: NetworkTier };

const ALPHA = 0.2; // weight of a new sample: one odd request does not change the tier
const ewma = (old: number | null, sample: number) => (old === null ? sample : old + ALPHA * (sample - old));

export function classify(rttMs: number | null, kbps: number | null): NetworkTier {
  if ((kbps !== null && kbps < 200) || (rttMs !== null && rttMs > 900)) return 'slow';
  if ((kbps !== null && kbps < 2000) || (rttMs !== null && rttMs > 350)) return 'medium';
  return 'fast';
}

/**
 * One finished request. Small answers measure delay (rtt); answers of 16 KB+ measure speed.
 * `ms` is the whole request time as the app saw it.
 */
export function addSample(state: QualityState, sample: { ms: number; bytes: number }): QualityState {
  if (!(sample.ms > 0) || !(sample.bytes >= 0)) return state;
  let { rttMs, kbps } = state;
  if (sample.bytes < 4096) rttMs = ewma(rttMs, sample.ms);
  else if (sample.bytes >= 16384) {
    // Subtract one round trip so a big answer on a fast but distant server is not called slow.
    const transferMs = Math.max(20, sample.ms - (rttMs ?? 0));
    kbps = ewma(kbps, (sample.bytes * 8) / transferMs);
  }
  return { rttMs, kbps, tier: classify(rttMs, kbps) };
}

/** Time limits that fit the measured speed: a 3 KB message on EDGE must not time out. */
export function timeoutFor(kind: 'send' | 'read' | 'upload', tier: NetworkTier): number {
  const base = kind === 'upload' ? 120_000 : kind === 'send' ? 20_000 : 18_000;
  return tier === 'slow' ? base * 3 : tier === 'medium' ? Math.round(base * 1.5) : base;
}

/** What loads by itself. On slow links only text; media waits for a tap. */
export function autoload(kind: 'photo' | 'video' | 'animatedAvatar' | 'cover', tier: NetworkTier): boolean {
  if (tier === 'fast') return true;
  if (tier === 'medium') return kind === 'photo' || kind === 'cover';
  return false;
}

// ---- shared live value ----
let state: QualityState = { rttMs: null, kbps: null, tier: 'fast' };
const listeners = new Set<() => void>();
export function reportRequest(ms: number, bytes: number) {
  const next = addSample(state, { ms, bytes });
  const changed = next.tier !== state.tier;
  state = next;
  if (changed) for (const l of listeners) l();
}
export const networkTier = () => state.tier;
export const networkQuality = () => state;
export function subscribeNetwork(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
