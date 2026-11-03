// Voice activation (PC): the microphone track is switched on only while the level is above the
// threshold set in Настройки → Звук и микрофон, with a short hold so word endings are not cut.
// Measured on a copy of the track, so a closed gate can still hear when speech starts.
import { audioPrefs, PTT_RELEASE_MS } from './devices';

// Рация: held by the bound key (src/audio/binds.ts) or the on-screen button.
let pttDown = false, pttUpAt = 0;
export function setPushToTalk(down: boolean) { if (pttDown && !down) pttUpAt = Date.now(); pttDown = down; }
export const pushToTalkActive = (now = Date.now()) => pttDown || now - pttUpAt < PTT_RELEASE_MS;
// «Молчать, пока зажато» (Discord's Push to Mute): wins over every mode.
let muteDown = false;
export function setPushToMute(down: boolean) { muteDown = down; }

export const HOLD_MS = 350;
export const dbfs = (rms: number) => (rms > 0 ? 20 * Math.log10(rms) : -100);

/** Pure decision (tested): open while loud; stays open HOLD_MS after the last loud moment. */
export function gateOpen(levelDb: number, threshold: number, lastLoudAt: number, now: number): { open: boolean; lastLoudAt: number } {
  if (levelDb >= threshold) return { open: true, lastLoudAt: now };
  return { open: now - lastLoudAt < HOLD_MS, lastLoudAt };
}

/** Starts gating `track`; `muted()` always wins. Returns a function that stops it. */
export function gateTrack(track: any, muted: () => boolean): () => void {
  if (typeof AudioContext === 'undefined' || !track) return () => {};
  const probe = track.clone(); probe.enabled = true;
  const ctx = new AudioContext(); const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  ctx.createMediaStreamSource(new MediaStream([probe])).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let lastLoudAt = 0;
  const timer = setInterval(() => {
    const p = audioPrefs();
    if (muted() || muteDown) { track.enabled = false; return; }
    if (p.inputMode === 'always') { track.enabled = true; return; }
    if (p.inputMode === 'ptt') { track.enabled = pushToTalkActive(); return; }
    analyser.getFloatTimeDomainData(data);
    let sum = 0; for (const v of data) sum += v * v;
    const next = gateOpen(dbfs(Math.sqrt(sum / data.length)), p.threshold, lastLoudAt, Date.now());
    lastLoudAt = next.lastLoudAt; track.enabled = next.open;
  }, 20);
  return () => { clearInterval(timer); probe.stop(); void ctx.close(); track.enabled = !muted(); };
}
