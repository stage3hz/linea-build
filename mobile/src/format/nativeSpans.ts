// Message text for the native message list: the same blocks and spans FormattedText draws (render.ts), laid
// out as one string plus runs of flags, so Swift and Kotlin style it without knowing about entities.
// Offsets are UTF-16 code units — what NSString and java.lang.String count as well.
import { type Entity } from './entities';
import { linkTokens } from './markdown';
import { toBlocks } from './render';

export const NATIVE_FMT = { bold: 1, italic: 2, underline: 4, strike: 8, mono: 16, spoiler: 32, link: 64, quote: 128, pre: 256 } as const;
/** `fmt` holds triples [flags, offset, length]; `urls` has one entry per triple with the `link` flag, in order.
 *  An address is `https://…`, or `mention:<username>` for an @mention. */
export type NativeText = { text: string; fmt: number[]; urls: string[] };

const safeUrl = (url: string) => /^https?:\/\//i.test(url);
const mayLink = (text: string) => /https?:\/\/|www\./i.test(text) || text.includes('@');

export function nativeText(text: string, entities?: readonly Entity[]): NativeText {
  if (!text) return { text: '', fmt: [], urls: [] };
  if (!entities?.length && !mayLink(text)) return { text, fmt: [], urls: [] };
  const fmt: number[] = []; const urls: string[] = []; let out = '';
  const add = (piece: string, flags: number, url?: string) => {
    if (!piece) return;
    if (flags || url) { fmt.push(flags | (url ? NATIVE_FMT.link : 0), out.length, piece.length); if (url) urls.push(url); }
    out += piece;
  };
  toBlocks(text, entities).forEach((block, index) => {
    if (index) out += '\n';
    const base = block.kind === 'quote' ? NATIVE_FMT.quote : block.kind === 'pre' ? NATIVE_FMT.pre | NATIVE_FMT.mono : 0;
    for (const span of block.spans) {
      const flags = base | (span.bold ? NATIVE_FMT.bold : 0) | (span.italic ? NATIVE_FMT.italic : 0) | (span.underline ? NATIVE_FMT.underline : 0)
        | (span.strike ? NATIVE_FMT.strike : 0) | (span.code ? NATIVE_FMT.mono : 0) | (span.spoiler ? NATIVE_FMT.spoiler : 0);
      if (span.url && safeUrl(span.url)) add(span.text, flags, span.url);
      // Code is shown as typed: an address inside it is not a link (FormattedText does the same).
      else if (span.code || block.kind === 'pre' || !mayLink(span.text)) add(span.text, flags);
      else for (const token of linkTokens(span.text)) add(token.text, flags, token.kind === 'url' ? token.href : token.kind === 'mention' ? `mention:${token.username}` : undefined);
    }
  });
  return { text: out, fmt, urls };
}
