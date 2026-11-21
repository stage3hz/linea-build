// Produces tests/vectors/compose.json: what the reference does while a message is written — `toggleEntity`,
// `clearFormatting`, `activeTypes`, `shiftEntities` of mobile/src/format/entities.ts, and the composer's `composed`
// of mobile/src/ChatScreen.tsx (`parseMarkdown` of mobile/src/format/markdown.ts, then the trim, `sliceEntities` and
// `packEntities`).
// Run from the repository root:  node native/core/tests/generate-compose-vectors.mjs
//
// One case per line, each JSON.stringify's own text: {"op": the core's name, "args": [...], "out": the answer}.
// The entities given are always ones the reference itself made (as on the phone, where they come from these very
// functions), so the cases are the composer's real inputs.
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const file = name => join(root, 'mobile/src/format', name);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/mobile/src/') && !/\.[a-z]+$/.test(specifier)) {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { toggleEntity, clearFormatting, activeTypes, shiftEntities, sliceEntities, packEntities, ENTITY_TYPES } = await import(pathToFileURL(file('entities.ts')).href);
const { parseMarkdown } = await import(pathToFileURL(file('markdown.ts')).href);

// The composer's `composed` (ChatScreen.tsx), with the field's text and entities.
const composed = (text, entities) => {
  const parsed = parseMarkdown(text, entities);
  const lead = parsed.text.length - parsed.text.trimStart().length;
  const plain = parsed.text.trim();
  const packed = packEntities(sliceEntities(parsed.entities, parsed.text, { start: lead, end: lead + plain.length }), plain);
  return { text: plain, entities: packed ?? null };
};

let seed = 0xc0de5eed;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = n => Math.floor(rnd() * n);
const chance = p => rnd() < p;
const pick = list => list[int(list.length)];

const PIECES = ['привет', 'мир', ' ', ' ', '  ', '\n', '\n\n', 'hello', 'World', 'a', '1', '_', 'snake_case', '2**3', '👍', '❤️', '👨‍👩‍👧', '🇷🇺', '1️⃣', '👍🏽', 'é', 'é',
  '**', '__', '~~', '||', '`', '```', '```js\n', '\n```', 'https://example.com/a**b', 'www.site.ru', 'http://x.y/z.', 'Ⓐ', '\t', ' ', '«', '»', '.', ',', '!', '#', '@имя', 'текст'];
const text = () => { let out = ''; const n = 1 + int(12); for (let i = 0; i < n; i++) out += pick(PIECES); return out; };
const markdown = () => {
  let out = ''; const n = 1 + int(8);
  for (let i = 0; i < n; i++) {
    if (chance(0.35)) { const mark = pick(['**', '__', '~~', '||', '`', '```']); out += mark + pick(PIECES) + (chance(0.5) ? pick(PIECES) : '') + (chance(0.85) ? mark : ''); }
    else out += pick(PIECES);
  }
  return out;
};
const URLS = ['https://example.com', 'http://a.b/c', 'https://сайт.рф/путь', 'ftp://no', 'javascript:alert(1)', 'https://', 'example.com'];
const range = value => { const a = int(value.length + 1), b = int(value.length + 1); return [a, b]; };
// Entities the reference made: a few toggles over random ranges.
const entitiesFor = value => {
  let list = [];
  const n = int(6);
  for (let i = 0; i < n; i++) {
    const [a, b] = range(value);
    const type = pick(ENTITY_TYPES);
    list = toggleEntity(list, value, { start: a, end: b }, type, type === 'text_link' ? pick(URLS) : undefined);
  }
  return list;
};

const lines = [];
const seen = new Set();
const add = (op, args, out) => { const line = JSON.stringify({ op, args, out }); if (seen.has(line)) return; seen.add(line); lines.push(line); };

for (let i = 0; i < 4000; i++) {
  const value = text(); const entities = entitiesFor(value); const [a, b] = range(value); const type = pick(ENTITY_TYPES);
  const url = type === 'text_link' || chance(0.1) ? pick(URLS) : null;
  add('composeToggle', [entities, value, a, b, type, url], toggleEntity(entities, value, { start: a, end: b }, type, url ?? undefined));
}
for (let i = 0; i < 1500; i++) {
  const value = text(); const entities = entitiesFor(value); const [a, b] = range(value);
  add('composeClear', [entities, value, a, b], clearFormatting(entities, value, { start: a, end: b }));
}
for (let i = 0; i < 2000; i++) {
  const value = text(); const entities = entitiesFor(value); let [a, b] = range(value); if (chance(0.3)) b = a;
  add('composeActive', [entities, a, b], [...activeTypes(entities, { start: a, end: b })]);
}
for (let i = 0; i < 3000; i++) {
  const old = text(); const entities = entitiesFor(old);
  // One edit: a span replaced by typed text, as a keyboard does (or several at once, as a paste).
  const [a, b] = range(old); const start = Math.min(a, b), end = Math.max(a, b);
  const typed = chance(0.3) ? '' : pick(PIECES) + (chance(0.3) ? pick(PIECES) : '');
  const fresh = chance(0.1) ? old : old.slice(0, start) + typed + old.slice(end);
  add('composeShift', [entities, old, fresh], shiftEntities(entities, old, fresh));
}
for (let i = 0; i < 4000; i++) {
  const value = chance(0.7) ? markdown() : text(); const entities = chance(0.5) ? entitiesFor(value) : [];
  add('composeOut', [value, entities], composed(value, entities));
}

writeFileSync(join(here, 'vectors', 'compose.json'), lines.join('\n') + '\n');
console.log(`${lines.length} cases written`);
