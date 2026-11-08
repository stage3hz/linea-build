// Text formatting inside a message, Telegram-style: the plain `text` stays readable for every
// client and an `entities` list (offset/length in UTF-16 code units, as JavaScript strings count)
// marks the formatted ranges. Everything here travels INSIDE the Signal ciphertext next to the
// text; the server never sees a single entity. Pure functions, no React.

export type EntityType = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre' | 'spoiler' | 'quote' | 'text_link';
export type Entity = { type: EntityType; offset: number; length: number; url?: string; language?: string };
export type Range = { start: number; end: number };

export const ENTITY_TYPES: readonly EntityType[] = ['bold', 'italic', 'underline', 'strikethrough', 'code', 'pre', 'spoiler', 'quote', 'text_link'];
/** Block entities take whole lines; the rest decorate text inside a line. */
export const BLOCK_TYPES: readonly EntityType[] = ['pre', 'quote'];
export const ENTITY_LIMITS = { count: 100, url: 2048, language: 32, text: 8000 } as const;
/** Russian labels for the composer toolbar/menu, in Telegram's order. */
export const ENTITY_LABELS: Record<EntityType, string> = { bold: 'Жирный', italic: 'Курсив', underline: 'Подчёркнутый', strikethrough: 'Зачёркнутый', code: 'Моноширинный', pre: 'Моноширинный блок', spoiler: 'Спойлер', quote: 'Цитата', text_link: 'Ссылка' };

const isBlock = (type: EntityType) => BLOCK_TYPES.includes(type);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const validLinkUrl = (url: unknown): url is string => typeof url === 'string' && url.length <= ENTITY_LIMITS.url && /^https?:\/\/\S+$/i.test(url);

/** Shape check for an `entities` array that arrived inside a decrypted payload. `textLength` bounds the offsets when known. */
export function validEntities(value: unknown, textLength: number = ENTITY_LIMITS.text): value is Entity[] {
  if (!Array.isArray(value) || value.length > ENTITY_LIMITS.count) return false;
  return value.every(item => {
    if (!record(item) || !Object.keys(item).every(key => ['type', 'offset', 'length', 'url', 'language'].includes(key))) return false;
    if (!ENTITY_TYPES.includes(item.type as EntityType)) return false;
    const { offset, length } = item;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || (offset as number) < 0 || (length as number) < 1 || (offset as number) + (length as number) > textLength) return false;
    if (item.type === 'text_link' ? !validLinkUrl(item.url) : item.url !== undefined) return false;
    if (item.language !== undefined && (item.type !== 'pre' || typeof item.language !== 'string' || item.language.length > ENTITY_LIMITS.language)) return false;
    return true;
  });
}

const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const ZWJ = 0x200d;
/** Marks that never start a grapheme: combining marks, variation selectors (VS16), the keycap sign, ZWJ and skin tones. */
const extend = (code: number) => code === ZWJ || (code >= 0x1f3fb && code <= 0x1f3ff) || /\p{M}/u.test(String.fromCodePoint(code));
const regionalIndicator = (code: number) => code >= 0x1f1e6 && code <= 0x1f1ff;
/** Start index of the code point that ends at `index` (a low surrogate steps back to its high one). */
const codePointStart = (text: string, index: number) => index >= 2 && low(text.charCodeAt(index - 1)) && high(text.charCodeAt(index - 2)) ? index - 2 : index - 1;
const codePointBefore = (text: string, index: number) => text.codePointAt(codePointStart(text, index)) as number;
/**
 * True when `index` (strictly inside the text) falls inside one grapheme: a surrogate pair, a ZWJ
 * sequence (👨‍👩‍👧), an emoji with VS16 (❤️) or a skin tone (👍🏽), a keycap (1️⃣) or a flag made of
 * two regional indicators (🇷🇺). A rough UAX #29, enough for the emoji people type.
 */
function joined(text: string, index: number): boolean {
  if (low(text.charCodeAt(index)) && high(text.charCodeAt(index - 1))) return true;
  const after = text.codePointAt(index) as number, before = codePointBefore(text, index);
  if (extend(after) || before === ZWJ) return true;
  if (regionalIndicator(after) && regionalIndicator(before)) {
    let count = 0; for (let at = index; at > 0 && regionalIndicator(codePointBefore(text, at)); at = codePointStart(text, at)) count++;
    return count % 2 === 1; // the first of a pair is followed by the second: no boundary
  }
  return false;
}
/** Moves a position back to the start of the grapheme it falls into (never cuts an emoji in two). */
export function snapToCodePoint(text: string, position: number): number {
  let at = Math.max(0, Math.min(text.length, position));
  while (at > 0 && at < text.length && joined(text, at)) at = codePointStart(text, at);
  return at;
}
/** The same for the end of a range: a cut inside a grapheme moves forward, so the whole emoji stays in. */
export function snapEnd(text: string, position: number): number {
  let at = Math.max(0, Math.min(text.length, position));
  while (at > 0 && at < text.length && joined(text, at)) at += high(text.charCodeAt(at)) && low(text.charCodeAt(at + 1)) ? 2 : 1;
  return at;
}

const lineStart = (text: string, position: number) => { const index = text.lastIndexOf('\n', Math.max(0, position - 1)); return index < 0 ? 0 : index + 1; };
const lineEnd = (text: string, position: number) => { const index = text.indexOf('\n', position); return index < 0 ? text.length : index; };
/** Block entities cover whole lines (Telegram: a quote cannot start mid-line). */
export function expandToLines(text: string, range: Range): Range {
  return { start: lineStart(text, range.start), end: lineEnd(text, Math.max(range.start, range.end > range.start ? range.end - 1 : range.end)) };
}

const sameKind = (a: Entity, b: Entity) => a.type === b.type && a.url === b.url && a.language === b.language;
const byPosition = (a: Entity, b: Entity) => a.offset - b.offset || b.length - a.length || a.type.localeCompare(b.type);

/**
 * Canonical form: clamped to the text, snapped to code points, empty ones dropped, adjacent or
 * overlapping entities of one kind merged, sorted by offset. Block entities never overlap each
 * other (the earlier one wins) and always cover whole lines.
 */
export function normalizeEntities(entities: readonly Entity[] | undefined, text: string): Entity[] {
  if (!entities?.length) return [];
  const clamped: Entity[] = [];
  for (const entity of entities) {
    if (!ENTITY_TYPES.includes(entity.type)) continue;
    let start = snapToCodePoint(text, Math.max(0, Math.min(text.length, entity.offset)));
    let end = snapEnd(text, entity.offset + entity.length);
    if (isBlock(entity.type)) ({ start, end } = expandToLines(text, { start, end }));
    if (entity.type === 'text_link' && !validLinkUrl(entity.url)) continue;
    if (end <= start) continue;
    clamped.push({ type: entity.type, offset: start, length: end - start, ...(entity.type === 'text_link' ? { url: entity.url } : {}), ...(entity.type === 'pre' && entity.language ? { language: entity.language.slice(0, ENTITY_LIMITS.language) } : {}) });
  }
  clamped.sort(byPosition);
  const merged: Entity[] = [];
  for (const entity of clamped) {
    const previous = merged.findLast(item => sameKind(item, entity));
    if (previous && previous.offset + previous.length >= entity.offset) { previous.length = Math.max(previous.offset + previous.length, entity.offset + entity.length) - previous.offset; continue; }
    if (isBlock(entity.type) && merged.some(item => isBlock(item.type) && item.offset < entity.offset + entity.length && entity.offset < item.offset + item.length)) continue;
    merged.push({ ...entity });
  }
  merged.sort(byPosition);
  return merged.slice(0, ENTITY_LIMITS.count);
}

/** Entities of `type` that lie (even partly) inside the range. */
export const entitiesIn = (entities: readonly Entity[], range: Range, type?: EntityType) => entities.filter(entity => (!type || entity.type === type) && entity.offset < range.end && range.start < entity.offset + entity.length);

/** True when every character of the range already carries `type`. */
export function rangeHas(entities: readonly Entity[], range: Range, type: EntityType): boolean {
  if (range.end <= range.start) return false;
  let position = range.start;
  for (const entity of [...entities].filter(item => item.type === type).sort((a, b) => a.offset - b.offset)) {
    if (entity.offset > position) break;
    position = Math.max(position, entity.offset + entity.length);
    if (position >= range.end) return true;
  }
  return false;
}

/** Cuts `range` out of every entity of `type` (splitting when the range sits in the middle). */
export function removeEntity(entities: readonly Entity[], range: Range, type: EntityType): Entity[] {
  const out: Entity[] = [];
  for (const entity of entities) {
    if (entity.type !== type || entity.offset >= range.end || entity.offset + entity.length <= range.start) { out.push(entity); continue; }
    const end = entity.offset + entity.length;
    if (entity.offset < range.start) out.push({ ...entity, length: range.start - entity.offset });
    if (end > range.end) out.push({ ...entity, offset: range.end, length: end - range.end });
  }
  return out;
}

/**
 * Toolbar action: adds `type` over the selection, or removes it when the whole selection already
 * has it. A link replaces any link in the range; a block type takes whole lines and drops the other
 * block type there (a line is a quote or code, never both).
 */
export function toggleEntity(entities: readonly Entity[], text: string, selection: Range, type: EntityType, url?: string): Entity[] {
  let range: Range = { start: snapToCodePoint(text, Math.min(selection.start, selection.end)), end: snapEnd(text, Math.max(selection.start, selection.end)) };
  if (isBlock(type)) range = expandToLines(text, range);
  if (range.end <= range.start) return normalizeEntities(entities, text);
  if (type === 'text_link') {
    const cleared = removeEntity(entities, range, 'text_link');
    return normalizeEntities(validLinkUrl(url) ? [...cleared, { type, offset: range.start, length: range.end - range.start, url }] : cleared, text);
  }
  if (rangeHas(entities, range, type)) return normalizeEntities(removeEntity(entities, range, type), text);
  let base: readonly Entity[] = entities;
  if (isBlock(type)) for (const other of BLOCK_TYPES) base = removeEntity(base, range, other);
  if (type === 'code' || type === 'pre') for (const other of ['bold', 'italic', 'underline', 'strikethrough', 'text_link'] as const) base = removeEntity(base, range, other);
  return normalizeEntities([...base, { type, offset: range.start, length: range.end - range.start }], text);
}

/** Removes every entity touching the selection («Очистить форматирование»). */
export function clearFormatting(entities: readonly Entity[], text: string, selection: Range): Entity[] {
  const range: Range = { start: Math.min(selection.start, selection.end), end: Math.max(selection.start, selection.end) };
  let out: readonly Entity[] = entities;
  for (const type of ENTITY_TYPES) out = removeEntity(out, range, type);
  return normalizeEntities(out, text);
}

/** The types every character of the selection carries (toolbar highlight). A caret reports the entities around it. */
export function activeTypes(entities: readonly Entity[], selection: Range): Set<EntityType> {
  const range: Range = { start: Math.min(selection.start, selection.end), end: Math.max(selection.start, selection.end) };
  const active = new Set<EntityType>();
  if (range.end === range.start) { for (const entity of entities) if (entity.offset < range.start && range.start < entity.offset + entity.length) active.add(entity.type); return active; }
  for (const type of ENTITY_TYPES) if (rangeHas(entities, range, type)) active.add(type);
  return active;
}

/**
 * Keeps entities in place while the user types: the edit is found as the one replaced span between
 * the common prefix and suffix of the old and new text. Text typed inside a formatted range joins
 * it; a range that is deleted disappears.
 */
export function shiftEntities(entities: readonly Entity[], oldText: string, newText: string): Entity[] {
  if (!entities.length) return [];
  if (oldText === newText) return normalizeEntities(entities, newText);
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0; while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let suffix = 0; while (suffix < max - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix++;
  const oldEnd = oldText.length - suffix, newEnd = newText.length - suffix, delta = newText.length - oldText.length;
  // Symmetric at both edges: a range that ends where typing starts does not grow, and one that
  // starts there is pushed along instead of swallowing the new text.
  const map = (position: number, isEnd: boolean) => (isEnd ? position <= prefix : position < prefix) ? position : position >= oldEnd ? position + delta : isEnd ? newEnd : prefix;
  const out: Entity[] = [];
  for (const entity of entities) {
    const start = entity.offset, end = entity.offset + entity.length;
    // Text typed right inside a range (or replacing a part of it) stays formatted; a range that
    // ends exactly where typing starts does not swallow the new text.
    const spans = start < prefix && end > oldEnd;
    const newStart = spans ? start : map(start, false), newEnd2 = spans ? end + delta : map(end, true);
    if (newEnd2 > newStart) out.push({ ...entity, offset: newStart, length: newEnd2 - newStart });
  }
  return normalizeEntities(out, newText);
}

/** Entities for a slice of the text (e.g. the first message of a split), offsets relative to the slice. */
export function sliceEntities(entities: readonly Entity[], text: string, range: Range): Entity[] {
  const out: Entity[] = [];
  for (const entity of entities) {
    const start = Math.max(entity.offset, range.start), end = Math.min(entity.offset + entity.length, range.end);
    if (end > start) out.push({ ...entity, offset: start - range.start, length: end - start });
  }
  return normalizeEntities(out, text.slice(range.start, range.end));
}

const BLOCK = '▒';
/** Chat list / reply quote: the text of a spoiler is replaced by ▒ so a glance at the list reveals nothing. */
export function maskSpoilers(text: string, entities?: readonly Entity[]): string {
  const spoilers = (entities ?? []).filter(entity => entity.type === 'spoiler').sort((a, b) => a.offset - b.offset);
  if (!spoilers.length) return text;
  let out = '', position = 0;
  for (const entity of spoilers) {
    const start = Math.max(position, Math.min(text.length, entity.offset)), end = Math.min(text.length, entity.offset + entity.length);
    if (end <= start) continue;
    out += text.slice(position, start) + BLOCK.repeat(Math.min(12, Math.max(1, Array.from(text.slice(start, end).replace(/\s+/g, '')).length)));
    position = end;
  }
  return out + text.slice(position);
}

/**
 * A text_link whose visible text is not the address itself («docs» → https://evil.example) is
 * confirmed before opening, as Telegram does: true when the text already shows where it goes.
 */
export function linkTextMatchesUrl(text: string, url: string): boolean {
  const strip = (value: string) => value.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
  const shown = strip(text), target = strip(url);
  return !!shown && shown === target;
}

/** Entities to store: undefined when there is nothing to say (keeps old payloads byte-identical). */
export function packEntities(entities: readonly Entity[] | undefined, text: string): Entity[] | undefined {
  const normalized = normalizeEntities(entities, text);
  return normalized.length ? normalized : undefined;
}
