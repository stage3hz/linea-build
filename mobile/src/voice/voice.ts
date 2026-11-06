// Voice messages are ordinary end-to-end encrypted attachments (AAC in .m4a).
// They are recognised by a fixed file-name pattern, so older clients still
// receive them as a playable audio file and the encrypted body schema is unchanged.
import type { Attachment } from '../types';

export const VOICE_MIME = 'audio/mp4';
export const VOICE_MIN_MS = 500; // Telegram drops takes shorter than 0.5 s
export const VOICE_MAX_MS = 15 * 60 * 1000; // ~14.4 MB at 128 kbit/s, under the 20 MB attachment limit
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
