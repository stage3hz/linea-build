// «Студийный звук (тест)», PC (Electron / browser): the raw microphone (noise suppression / echo
// cancellation already applied by getUserMedia) → 3 peaking BiquadFilterNodes → limiter → output trim →
// a MediaStreamAudioDestinationNode track that goes to the call / voice room instead of the raw one.
// Phones: the LiveKit WebRTC fork only offers native audio-processing hooks (Android AudioProcessingFactory,
// iOS audioProcessingModule) set before the factory starts, nothing reachable from JS — PC only for now.
import { STUDIO_FILTERS, STUDIO_LIMITER, studioTrim } from './studioPreset';

let shared: AudioContext | null = null;
const context = (): AudioContext | null => {
  if (typeof AudioContext === 'undefined') return null;
  if (!shared || shared.state === 'closed') shared = new AudioContext({ latencyHint: 'interactive' });
  if (shared.state === 'suspended') void shared.resume().catch(() => {});
  return shared;
};

export const studioSoundSupported = () => typeof AudioContext !== 'undefined';

/**
 * The processed track for `raw`. Stopping it (track.stop()) also stops the raw microphone and
 * disconnects the graph, so callers keep treating it as their one microphone track. Null if Web Audio is missing.
 */
export function studioTrack(raw: MediaStreamTrack): MediaStreamTrack | null {
  const ctx = context(); if (!ctx || !raw) return null;
  try {
    const source = ctx.createMediaStreamSource(new MediaStream([raw]));
    const filters = STUDIO_FILTERS.map(f => {
      const node = ctx.createBiquadFilter();
      node.type = 'peaking'; node.frequency.value = f.frequency; node.Q.value = f.q; node.gain.value = f.gain;
      return node;
    });
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = STUDIO_LIMITER.threshold; limiter.knee.value = STUDIO_LIMITER.knee; limiter.ratio.value = STUDIO_LIMITER.ratio;
    limiter.attack.value = STUDIO_LIMITER.attack; limiter.release.value = STUDIO_LIMITER.release;
    const trim = ctx.createGain(); trim.gain.value = studioTrim(ctx.sampleRate);
    const out = ctx.createMediaStreamDestination();
    const chain: AudioNode[] = [source, ...filters, limiter, trim, out];
    for (let i = 1; i < chain.length; i++) chain[i - 1].connect(chain[i]);
    const track = out.stream.getAudioTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop(); raw.stop();
      for (const node of [source, ...filters, limiter, trim]) { try { node.disconnect(); } catch { /* already */ } }
    };
    return track;
  } catch { return null; }
}

/** Swaps the stream's microphone for the processed one (in place). Returns the stream. */
export function applyStudio<T extends { getAudioTracks(): any[]; removeTrack?(t: any): void; addTrack?(t: any): void }>(stream: T): T {
  const raw = stream.getAudioTracks()[0]; if (!raw) return stream;
  const processed = studioTrack(raw); if (!processed) return stream;
  processed.enabled = raw.enabled;
  try { stream.removeTrack?.(raw); stream.addTrack?.(processed); } catch { processed.stop(); }
  return stream;
}
