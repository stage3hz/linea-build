// Voice messages are ordinary end-to-end encrypted attachments (AAC in .m4a).
// They are recognised by a fixed file-name pattern, so older clients still
// receive them as a playable audio file and the encrypted body schema is unchanged.
import type { Attachment } from '../types';

export const VOICE_MIME = 'audio/mp4';
export const VOICE_MIN_MS = 500; // Telegram drops takes shorter than 0.5 s
// Telegram has no separate limit for voice messages. Here one take stays under 1 GB:
// 18 h × 128 kbit/s ≈ 1.04 × 10⁹ bytes (≈ 0.97 GiB). Takes over 20 MB go as a chunked encrypted file.
export const VOICE_MAX_MS = 18 * 60 * 60 * 1000;
/** Waveform samples kept while recording; a long take is compacted, so the waveform covers the whole take. */
export const VOICE_SAMPLE_CAP = 20000;

/**
 * Adds one meter level to the recording waveform. When the buffer is full, neighbouring samples are merged
 * (the louder one wins) and from then on every `stride` levels become one sample, so memory stays bounded
 * and the waveform still spans the whole recording instead of only its first minutes.
 */
export function pushVoiceSample(state: { samples: number[]; stride: number; pending: number; count: number }, level: number, cap = VOICE_SAMPLE_CAP): void {
  state.pending = state.count === 0 ? level : Math.max(state.pending, level);
  state.count += 1;
  if (state.count < state.stride) return;
  state.samples.push(state.pending); state.count = 0; state.pending = 0;
  if (state.samples.length < cap) return;
  const merged: number[] = [];
  for (let i = 0; i < state.samples.length; i += 2) merged.push(Math.max(state.samples[i], state.samples[i + 1] ?? 0));
  state.samples = merged; state.stride *= 2;
}

/** The waveform of a finished take: the collected samples plus the last, not yet full group. */
export const voiceSamples = (state: { samples: number[]; pending: number; count: number }): number[] =>
  state.count > 0 ? [...state.samples, state.pending] : state.samples;
const VOICE_NAME = /^voice-\d{1,16}\.m4a$/;

export const voiceFileName = (now = Date.now()) => `voice-${Math.max(0, Math.floor(now))}.m4a`;

export function isVoice(attachment: Pick<Attachment, 'name' | 'mimeType'> | null | undefined): boolean {
  return !!attachment && attachment.mimeType === VOICE_MIME && VOICE_NAME.test(attachment.name);
}

/** Recording timer as in Telegram: 0:04,63. */
export function formatVoiceTimeFine(ms: number): string {
  const value = Math.max(0, Number.isFinite(ms) ? ms : 0), total = Math.floor(value / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')},${String(Math.floor(value % 1000 / 10)).padStart(2, '0')}`;
}

// Waveform of a voice message (Telegram shows the loudness of the whole take in the bubble). It is
// measured while recording and travels inside the encrypted message: one letter per bar, 0…31.
const WAVE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
export const WAVEFORM_BARS = 100;
// As Telegram (ManagedAudioRecorder / AudioWaveform, studied, not copied): 100 bins by peak; the
// reference level is 1.8 × the mean (but not below a floor, so silence stays flat); each bin is
// min(value, reference) / reference × 31. Our recorder gives dB every 100 ms, so dB → amplitude first.
const WAVE_FLOOR = 2500 / 32767; // Telegram's floor on 16-bit peaks, as a fraction of full scale
export function encodeWaveform(levels: readonly number[]): string | undefined {
  if (levels.length < 4) return undefined;
  if (!(Math.max(...levels) > 0.02)) return undefined; // no metering (silence or unsupported): no fake bars
  const amp = levels.map(level => Math.pow(10, (Math.min(1, Math.max(0, level)) * 60 - 60) / 20));
  const bins: number[] = [];
  for (let bar = 0; bar < WAVEFORM_BARS; bar++) {
    const from = Math.floor(bar * amp.length / WAVEFORM_BARS), to = Math.max(from + 1, Math.floor((bar + 1) * amp.length / WAVEFORM_BARS));
    let value = 0; for (let i = from; i < to && i < amp.length; i++) value = Math.max(value, amp[i]);
    bins.push(value);
  }
  const reference = Math.max(WAVE_FLOOR, bins.reduce((sum, value) => sum + value, 0) / bins.length * 1.8);
  return bins.map(value => WAVE[Math.max(0, Math.min(31, Math.round(Math.min(value, reference) / reference * 31)))]).join('');
}
/** Fits the stored bars into `count` bars for the bubble width (peak of each group). */
export function fitWaveform(bars: readonly number[], count: number): number[] {
  if (count <= 0 || bars.length <= count) return [...bars];
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor(i * bars.length / count), to = Math.max(from + 1, Math.floor((i + 1) * bars.length / count));
    let value = 0; for (let k = from; k < to; k++) value = Math.max(value, bars[k]); return value;
  });
}
export function decodeWaveform(value: string | undefined): number[] | null {
  if (!value || !/^[A-Za-f]{8,100}$/.test(value)) return null;
  return [...value].map(char => WAVE.indexOf(char) / 31);
}

export function formatVoiceTime(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Short human label for previews (chat list, replies, pinned bar). */
export function attachmentLabel(attachment: Pick<Attachment, 'name' | 'mimeType' | 'media'>): string {
  if (isVoice(attachment)) {
    const ms = attachment.media?.durationMs;
    return `🎤 Голосовое сообщение${ms ? ` · ${formatVoiceTime(ms)}` : ''}`;
  }
  if (isVideoNote(attachment)) {
    const ms = attachment.media?.durationMs;
    return `⏺ Видеосообщение${ms ? ` · ${formatVoiceTime(ms)}` : ''}`;
  }
  if (attachment.mimeType.startsWith('image/')) return '🖼 Фотография';
  if (attachment.mimeType.startsWith('video/')) return '🎬 Видео';
  return `📎 ${attachment.name}`;
}

/** Recording levels (dBFS, about -60…0) to a 0…1 bar height. */
export function levelFromMetering(db: number | undefined): number {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

// Video notes («кружки»): an end-to-end encrypted MP4 recognised by its name.
export const VIDEO_NOTE_MAX_MS = 60 * 1000;
const VIDEO_NOTE_NAME = /^circle-\d{1,16}\.mp4$/;
export const videoNoteFileName = (now = Date.now()) => `circle-${Math.max(0, Math.floor(now))}.mp4`;
export function isVideoNote(attachment: Pick<Attachment, 'name' | 'mimeType'> | null | undefined): boolean {
  return !!attachment && attachment.mimeType === 'video/mp4' && VIDEO_NOTE_NAME.test(attachment.name);
}
