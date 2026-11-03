// Who is talking right now (for the overlay): one shared AudioContext, one small analyser per
// voice, sampled 8 times a second — and only while the overlay is on and you are in a channel.
const SPEAKING_DB = -50;
type Probe = { analyser: AnalyserNode; source: MediaStreamAudioSourceNode; data: Float32Array<ArrayBuffer> };
let ctx: AudioContext | null = null;
const probes = new Map<string, Probe>();

export function watchVoice(id: string, track: MediaStreamTrack | null | undefined) {
  unwatchVoice(id);
  if (!track || typeof AudioContext === 'undefined') return;
  ctx ||= new AudioContext();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
  const source = ctx.createMediaStreamSource(new MediaStream([track])); source.connect(analyser);
  probes.set(id, { analyser, source, data: new Float32Array(analyser.fftSize) });
}
export function unwatchVoice(id: string) { const p = probes.get(id); if (p) { try { p.source.disconnect(); } catch { /* gone */ } probes.delete(id); } }
export function unwatchAll() { for (const id of [...probes.keys()]) unwatchVoice(id); void ctx?.close().catch(() => {}); ctx = null; }

/** ids whose level is above the speaking threshold right now. */
export function speakingNow(): Set<string> {
  const out = new Set<string>();
  for (const [id, p] of probes) {
    p.analyser.getFloatTimeDomainData(p.data);
    let sum = 0; for (const v of p.data) sum += v * v;
    const rms = Math.sqrt(sum / p.data.length);
    if (rms > 0 && 20 * Math.log10(rms) > SPEAKING_DB) out.add(id);
  }
  return out;
}
