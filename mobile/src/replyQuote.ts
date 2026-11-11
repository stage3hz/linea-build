// The quote above an answer, as in Telegram: the live original when it is loaded (its own text, or a label
// with a small thumbnail — round for a video message, square for a photo or video), otherwise the preview
// stored with the answer. Older answers stored «⏺ Видеосообщение · 0:10»: the ⏺ glyph drew as a white
// square on iPhone, and Telegram says just «Видеосообщение»; such previews are shown the new way.
import type { Attachment, AttachmentPreview, Message } from './types';
import { isVideoNote, isVoice } from './voice/voice.ts';
import { maskSpoilers } from './format/entities.ts';

export const DELETED_QUOTE = 'Сообщение удалено';

const clock = /\s·\s\d{1,3}:\d{2}$/;
/** Labels the app itself put in a preview after a glyph (attachmentLabel, old and new). */
const KNOWN: { glyph: RegExp; label: RegExp; keepDuration: boolean }[] = [
  { glyph: /^⏺️?\s*/u, label: /^Видеосообщение(?:\s·\s\d{1,3}:\d{2})?$/, keepDuration: false },
  { glyph: /^🎤️?\s*/u, label: /^Голосовое сообщение(?:\s·\s\d{1,3}:\d{2})?$/, keepDuration: true },
  { glyph: /^🖼️?\s*/u, label: /^Фотография$/, keepDuration: true },
  { glyph: /^🎬️?\s*/u, label: /^Видео$/, keepDuration: true },
  // A file: the name, which ends in an extension.
  { glyph: /^📎️?\s*/u, label: /^\S.*\.[A-Za-z0-9]{1,8}$/, keepDuration: true },
];

/** A stored quote preview in today's form: no leading glyph, no duration on a video message. Text a
 *  person typed (which merely starts with an emoji) is left as it is. */
export function normalizeQuotePreview(preview: string): string {
  const text = preview.trim().replace(/\s+/g, ' ');
  for (const item of KNOWN) {
    const match = item.glyph.exec(text);
    if (!match) continue;
    const rest = text.slice(match[0].length);
    if (!item.label.test(rest)) continue;
    return item.keepDuration ? rest : rest.replace(clock, '');
  }
  // «Видеосообщение · 0:10» without the glyph (some builds) — Telegram shows no duration in the quote.
  if (/^Видеосообщение\s·\s\d{1,3}:\d{2}$/.test(text)) return 'Видеосообщение';
  return text;
}

/** The quote's word for an attachment without a caption (no glyphs: the thumbnail says the kind). */
export function quoteLabel(attachment: Pick<Attachment, 'name' | 'mimeType' | 'media'>): string {
  if (isVoice(attachment)) return 'Голосовое сообщение';
  if (isVideoNote(attachment)) return 'Видеосообщение';
  if (attachment.mimeType.startsWith('image/')) return 'Фотография';
  if (attachment.mimeType.startsWith('video/')) return 'Видео';
  return attachment.name;
}

export type QuoteThumb = { preview: AttachmentPreview; round: boolean };
export type QuoteContent = { text: string; thumb: QuoteThumb | null };

/** What the quote shows. `original` is the replied-to message when it is loaded and not deleted. */
export function quoteContent(original: Pick<Message, 'text' | 'attachment' | 'meta'> | undefined, stored: string | undefined): QuoteContent {
  if (!original) return { text: normalizeQuotePreview(stored || '') || DELETED_QUOTE, thumb: null };
  if (original.meta?.poll) return { text: `📊 ${original.meta.poll.question}`.slice(0, 200), thumb: null };
  const attachment = original.attachment;
  const visual = !!attachment && !isVoice(attachment) && (isVideoNote(attachment) || /^(image|video)\//.test(attachment.mimeType));
  const thumb = visual && attachment!.preview ? { preview: attachment!.preview, round: isVideoNote(attachment!) } : null;
  const body = maskSpoilers(original.text, original.meta?.entities).trim().replace(/\s+/g, ' ');
  if (body) return { text: body.slice(0, 200), thumb };
  if (attachment) return { text: quoteLabel(attachment).slice(0, 200), thumb };
  return { text: normalizeQuotePreview(stored || '') || DELETED_QUOTE, thumb: null };
}
