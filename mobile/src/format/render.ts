// Render model: text + entities → blocks of styled spans. Pure, so a test can check what a bubble
// shows without React Native. The UI (FormattedText) only maps this to <Text>/<View>.
import { type Entity, normalizeEntities } from './entities';

export type Span = { text: string; bold?: true; italic?: true; underline?: true; strike?: true; code?: true; spoiler?: true; url?: string };
export type Block = { kind: 'text' | 'quote' | 'pre'; spans: Span[]; language?: string };

const INLINE: Record<string, keyof Omit<Span, 'text' | 'url'>> = { bold: 'bold', italic: 'italic', underline: 'underline', strikethrough: 'strike', code: 'code', spoiler: 'spoiler' };

function spansOf(text: string, start: number, end: number, entities: readonly Entity[]): Span[] {
  const inline = entities.filter(entity => entity.type !== 'pre' && entity.type !== 'quote' && entity.offset < end && start < entity.offset + entity.length);
  const cuts = new Set<number>([start, end]);
  for (const entity of inline) { cuts.add(Math.max(start, entity.offset)); cuts.add(Math.min(end, entity.offset + entity.length)); }
  const points = [...cuts].sort((a, b) => a - b);
  const spans: Span[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const from = points[index], to = points[index + 1];
    if (to <= from) continue;
    const span: Span = { text: text.slice(from, to) };
    for (const entity of inline) {
      if (entity.offset > from || entity.offset + entity.length < to) continue;
      if (entity.type === 'text_link') span.url = entity.url; else span[INLINE[entity.type]] = true;
    }
    spans.push(span);
  }
  return spans;
}

/** Splits a message into blocks: plain runs, quotes (accent bar) and code blocks, each made of styled spans. */
export function toBlocks(text: string, entities?: readonly Entity[]): Block[] {
  const list = normalizeEntities(entities, text);
  if (!list.length) return text ? [{ kind: 'text', spans: [{ text }] }] : [];
  const blocks: Block[] = [];
  const blockEntities = list.filter(entity => entity.type === 'pre' || entity.type === 'quote').sort((a, b) => a.offset - b.offset);
  let position = 0;
  const pushText = (from: number, to: number) => {
    // The line breaks that only separate a block from its neighbours are not shown as empty lines.
    if (from > 0 && text[from] === '\n' && blocks.length && blocks[blocks.length - 1].kind !== 'text') from++;
    if (to < text.length && text[to - 1] === '\n' && to > from) to--;
    if (to > from) blocks.push({ kind: 'text', spans: spansOf(text, from, to, list) });
  };
  for (const block of blockEntities) {
    pushText(position, block.offset);
    const end = block.offset + block.length;
    blocks.push(block.type === 'pre'
      ? { kind: 'pre', spans: [{ text: text.slice(block.offset, end), code: true }], ...(block.language ? { language: block.language } : {}) }
      : { kind: 'quote', spans: spansOf(text, block.offset, end, list) });
    position = end;
  }
  pushText(position, text.length);
  return blocks;
}

/** True when the message ends with a quote or code block, so the time cannot sit on the last text line. */
export function endsInBlock(text: string, entities?: readonly Entity[]): boolean {
  const blocks = toBlocks(text, entities);
  return !!blocks.length && blocks[blocks.length - 1].kind !== 'text';
}

export const hasSpoiler = (entities?: readonly Entity[]) => !!entities?.some(entity => entity.type === 'spoiler');
