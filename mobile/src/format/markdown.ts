// Markdown shortcuts typed in the composer, as Telegram Desktop understands them on send:
// **bold**, __italic__, ~~strike~~, `mono`, ```block```, ||spoiler||. The markers are removed from
// the text and become entities; entities the toolbar already made are moved along with the text.
import { type Entity, normalizeEntities } from './entities';

type Marker = { open: string; type: Entity['type']; multiline: boolean };
const MARKERS: readonly Marker[] = [
  { open: '```', type: 'pre', multiline: true },
  { open: '**', type: 'bold', multiline: true },
  { open: '__', type: 'italic', multiline: true },
  { open: '~~', type: 'strikethrough', multiline: true },
  { open: '||', type: 'spoiler', multiline: true },
  { open: '`', type: 'code', multiline: false },
];

const inside = (entities: readonly Entity[], position: number) => entities.some(entity => (entity.type === 'code' || entity.type === 'pre') && entity.offset <= position && position < entity.offset + entity.length);
/** The same pattern as linkify's URL_RE (kept in step by a test): markers inside an address are not shortcuts. */
export const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'«»]+[^\s<>"'«».,:;!?)\]])/gi;
/** Ranges of the text an address occupies; `**`, `~~`, `||` or a backtick glued to its end are left out (`**https://a.b**` still works). */
function urlRanges(text: string): { start: number; end: number }[] {
  if (!/https?:\/\/|www\./i.test(text)) return [];
  const out: { start: number; end: number }[] = []; let match: RegExpExecArray | null; URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text))) { const end = match.index + match[1].replace(/[*~|`]+$/, '').length; if (end > match.index) out.push({ start: match.index, end }); }
  return out;
}
const wordChar = (text: string, index: number) => index >= 0 && index < text.length && /[\p{L}\p{N}]/u.test(text[index]);

export type Formatted = { text: string; entities: Entity[] };

/**
 * Removes markdown markers and returns the new text with entities for them merged into `entities`
 * (already on the text, offsets adjusted). Code and pre regions are left as typed. Nesting is not
 * parsed (Telegram Desktop does not either): `**a __b__ a**` is bold text with literal underscores.
 */
export function parseMarkdown(text: string, entities: readonly Entity[] = []): Formatted {
  const existing = normalizeEntities(entities, text);
  const urls = urlRanges(text);
  const inUrl = (position: number) => urls.some(range => range.start < position && position < range.end);
  const removed: { start: number; end: number }[] = [];
  const found: { type: Entity['type']; start: number; end: number; language?: string }[] = []; // in OLD coordinates, content only
  let index = 0;
  scan: while (index < text.length) {
    if (inside(existing, index) || inUrl(index)) { index++; continue; }
    for (const marker of MARKERS) {
      if (!text.startsWith(marker.open, index)) continue;
      // A marker glued to a word on its outside (snake_case, 2**3) is not an opening one.
      if (marker.open !== '```' && wordChar(text, index - 1)) continue;
      const contentStart = index + marker.open.length;
      let close = text.indexOf(marker.open, contentStart);
      while (close >= 0 && (inside(existing, close) || inUrl(close) || (marker.open !== '```' && wordChar(text, close + marker.open.length) && !wordChar(text, close - 1)))) close = text.indexOf(marker.open, close + 1);
      if (close < 0) continue;
      let content = text.slice(contentStart, close);
      if (!content.trim() || (!marker.multiline && content.includes('\n'))) continue;
      let entityStart = contentStart, entityEnd = close, language: string | undefined;
      if (marker.type === 'pre') {
        // ```lang\ncode``` — the first line names the language when it has no spaces.
        const match = /^([A-Za-z0-9_+#.-]{1,32})\n/.exec(content);
        if (match) { language = match[1]; entityStart += match[0].length; content = content.slice(match[0].length); }
        if (content.startsWith('\n')) { entityStart++; content = content.slice(1); }
        if (content.endsWith('\n')) { entityEnd--; content = content.slice(0, -1); }
        if (!content.trim()) continue;
      } else if (/^\s|\s$/.test(content) && marker.type !== 'code') continue; // «** bold **» is not a shortcut
      removed.push({ start: index, end: entityStart }, { start: entityEnd, end: close + marker.open.length });
      found.push({ type: marker.type, start: entityStart, end: entityEnd, language });
      index = close + marker.open.length;
      continue scan;
    }
    index++;
  }
  if (!removed.length) return { text, entities: existing };
  removed.sort((a, b) => a.start - b.start);
  const map = (position: number) => { let shift = 0; for (const gap of removed) { if (gap.end <= position) shift += gap.end - gap.start; else if (gap.start < position) { shift += position - gap.start; } else break; } return position - shift; };
  let out = '', last = 0;
  for (const gap of removed) { out += text.slice(last, gap.start); last = gap.end; }
  out += text.slice(last);
  const moved: Entity[] = [];
  for (const entity of existing) { const start = map(entity.offset), end = map(entity.offset + entity.length); if (end > start) moved.push({ ...entity, offset: start, length: end - start }); }
  for (const item of found) { const start = map(item.start), end = map(item.end); if (end > start) moved.push({ type: item.type, offset: start, length: end - start, ...(item.language ? { language: item.language } : {}) }); }
  return { text: out, entities: normalizeEntities(moved, out) };
}

/** Markdown back from entities, for the clipboard or an older client that cannot show formatting. */
export function toMarkdown(text: string, entities: readonly Entity[]): string {
  const marks = new Map<number, string[]>();
  const push = (position: number, mark: string, before: boolean) => { const list = marks.get(position) ?? []; if (before) list.unshift(mark); else list.push(mark); marks.set(position, list); };
  for (const entity of normalizeEntities(entities, text)) {
    const open = entity.type === 'bold' ? '**' : entity.type === 'italic' ? '__' : entity.type === 'strikethrough' ? '~~' : entity.type === 'spoiler' ? '||' : entity.type === 'code' ? '`' : entity.type === 'pre' ? '```' : '';
    if (!open) continue;
    push(entity.offset, entity.type === 'pre' ? `\`\`\`${entity.language ?? ''}\n` : open, false);
    push(entity.offset + entity.length, entity.type === 'pre' ? '\n```' : open, true);
  }
  let out = '';
  for (let index = 0; index <= text.length; index++) { const list = marks.get(index); if (list) out += list.join(''); if (index < text.length) out += text[index]; }
  return out;
}

// ─── Links and @mentions inside message text ─────────────────────────────────────────────────────
/** A public name: 3–24 Latin letters, digits or underscores (the server's rule, security.js `usernameValue`). */
const MENTION_RE = /@([A-Za-z0-9_]{3,24})/g;
export type LinkToken = { kind: 'text'; text: string } | { kind: 'url'; text: string; href: string } | { kind: 'mention'; text: string; username: string };

/**
 * A message's text cut into plain parts, addresses and @mentions, in order. A mention is `@name` standing on its
 * own: not inside an address, an e-mail (`a@mail.ru`) or a longer word, and not longer than a name can be.
 */
export function linkTokens(text: string): LinkToken[] {
  if (!text) return [];
  const found: { start: number; end: number; token: LinkToken }[] = [];
  let match: RegExpExecArray | null; URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text))) { const raw = match[1]; found.push({ start: match.index, end: match.index + raw.length, token: { kind: 'url', text: raw, href: /^https?:\/\//i.test(raw) ? raw : `https://${raw}` } }); }
  const urls = found.slice();
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text))) {
    const start = match.index, end = start + match[0].length;
    const before = start ? text[start - 1] : '', after = text[end] || '';
    if (/[A-Za-z0-9_@.\/-]/.test(before) || /[A-Za-z0-9_@]/.test(after)) continue;
    if (urls.some(url => start < url.end && end > url.start)) continue;
    found.push({ start, end, token: { kind: 'mention', text: match[0], username: match[1].toLowerCase() } });
  }
  found.sort((a, b) => a.start - b.start);
  const out: LinkToken[] = []; let last = 0;
  for (const part of found) { if (part.start > last) out.push({ kind: 'text', text: text.slice(last, part.start) }); out.push(part.token); last = part.end; }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

