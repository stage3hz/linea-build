// «Студийный звук (тест)»: an Equalizer APO-style preset for the outgoing microphone (1:1 calls and voice
// rooms, PC only for now). Three peaking filters, then a gentle limiter with an output trim so the +12 dB
// shelf of presence cannot clip. Pure maths and parameters, tested in test/studio-sound.test.mjs; the Web
// Audio graph that uses them is studioSound.ts.

export type PeakingFilter = { frequency: number; gain: number; q: number };

/** 77 Hz +8 dB Q 2 (body), 777 Hz −6 dB Q 1.5 (boxiness out), 6 kHz +12 dB Q 2 (presence / air). */
export const STUDIO_FILTERS: readonly PeakingFilter[] = [
  { frequency: 77, gain: 8, q: 2 },
  { frequency: 777, gain: -6, q: 1.5 },
  { frequency: 6000, gain: 12, q: 2 },
];

/** A gentle limiter after the EQ (DynamicsCompressorNode): catches peaks the boosts create. */
export const STUDIO_LIMITER = { threshold: -6, knee: 6, ratio: 4, attack: 0.003, release: 0.15 } as const;

/** RBJ Audio EQ Cookbook peaking filter, normalised (a0 = 1) — the same curve as Web Audio's 'peaking' BiquadFilterNode. */
export function peakingCoefficients(filter: PeakingFilter, sampleRate: number) {
  const A = Math.pow(10, filter.gain / 40);
  const w0 = (2 * Math.PI * filter.frequency) / sampleRate;
  const alpha = Math.sin(w0) / (2 * filter.q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0, b1: (-2 * cos) / a0, b2: (1 - alpha * A) / a0,
    a1: (-2 * cos) / a0, a2: (1 - alpha / A) / a0,
  };
}

/** Gain in dB of one peaking filter at `frequency`. */
export function peakingResponseDb(filter: PeakingFilter, frequency: number, sampleRate: number): number {
  const { b0, b1, b2, a1, a2 } = peakingCoefficients(filter, sampleRate);
  const w = (2 * Math.PI * frequency) / sampleRate;
  // |H(e^jw)| with z^-1 = e^-jw
  const re = (c0: number, c1: number, c2: number) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
  const im = (c1: number, c2: number) => -(c1 * Math.sin(w) + c2 * Math.sin(2 * w));
  const num = Math.hypot(re(b0, b1, b2), im(b1, b2));
  const den = Math.hypot(re(1, a1, a2), im(a1, a2));
  return 20 * Math.log10(num / den);
}

/** The whole chain's EQ gain in dB at `frequency` (filters in series add up in dB). */
export const chainResponseDb = (frequency: number, sampleRate = 48_000, filters: readonly PeakingFilter[] = STUDIO_FILTERS) =>
  filters.reduce((sum, filter) => sum + peakingResponseDb(filter, frequency, sampleRate), 0);

/** The largest boost of the chain over the voice band (log-spaced scan), dB. */
export function peakBoostDb(sampleRate = 48_000, filters: readonly PeakingFilter[] = STUDIO_FILTERS): number {
  let max = -Infinity;
  for (let f = 20; f <= Math.min(20_000, sampleRate / 2 - 1); f *= 1.01) max = Math.max(max, chainResponseDb(f, sampleRate, filters));
  return max;
}

/**
 * Output trim (linear gain) after the limiter: half of the peak boost is taken back, so a full-scale
 * sound at 6 kHz lands near the limiter's threshold instead of 12 dB over it, and speech keeps most of
 * the «studio» tilt. Never louder than unity.
 */
export function studioTrim(sampleRate = 48_000, filters: readonly PeakingFilter[] = STUDIO_FILTERS): number {
  const peak = peakBoostDb(sampleRate, filters);
  return Math.min(1, Math.pow(10, -Math.max(0, peak) / 2 / 20));
}
