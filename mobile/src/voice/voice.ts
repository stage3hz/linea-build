// Voice messages are ordinary end-to-end encrypted attachments (AAC in .m4a).
// They are recognised by a fixed file-name pattern, so older clients still
// receive them as a playable audio file and the encrypted body schema is unchanged.
import type { Attachment } from '../types';

export const VOICE_MIME = 'audio/mp4';
export const VOICE_MIN_MS = 700;
export const VOICE_MAX_MS = 15 * 60 * 1000; // ~6 MB at 48 kbit/s, well under the 20 MB attachment limit
const VOICE_NAME = /^voice-\d{1,16}\.m4a$/;

export const voiceFileName = (now = Date.now()) => `voice-${Math.max(0, Math.floor(now))}.m4a`;

export function isVoice(attachment: Pick<Attachment, 'name' | 'mimeType'> | null | undefined): boolean {
  return !!attachment && attachment.mimeType === VOICE_MIME && VOICE_NAME.test(attachment.name);
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
  if (attachment.mimeType.startsWith('image/')) return '🖼 Фотография';
  if (attachment.mimeType.startsWith('video/')) return '🎬 Видео';
  return `📎 ${attachment.name}`;
}

/** Recording levels (dBFS, about -60…0) to a 0…1 bar height. */
export function levelFromMetering(db: number | undefined): number {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}
