// Produces tests/vectors/format.json: what the reference `nativeText` (mobile/src/format/nativeSpans.ts, with the
// real render.ts, entities.ts and markdown.ts behind it) makes of many texts and entity lists.
// Run from the repository root:  node native/core/tests/generate-format-vectors.mjs
//
// One case per line, each JSON.stringify's own text (the Rust test reads and writes every line back to the same text
// and compares the answer as the reference's JSON text):
//   {"text": string, "entities": any JSON value (absent: undefined), "out": {"text","fmt":[…],"urls":[…]} | null}
// `entities` is given to the reference as JSON.parse returns it — nativeText is called directly, with no shape check
// before it, so the vectors also pin what JavaScript itself does with a wrong value. `out` is null where the
// reference throws (always a TypeError; anything else stops the run).
//
// The reference is imported as it is (Node strips the types and keeps every offset); a resolve hook only adds the
// `.ts` its extensionless imports lack. Coverage of the ported functions is V8's own block coverage
// (node:inspector); the run fails if a block of them never ran, except the ones listed in UNREACHABLE with the reason.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import { Session } from 'node:inspector/promises';

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

// Coverage has to be on before the reference is compiled.
const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const { nativeText, NATIVE_FMT } = await import(pathToFileURL(file('nativeSpans.ts')).href);
const { ENTITY_TYPES, ENTITY_LIMITS } = await import(pathToFileURL(file('entities.ts')).href);

// What the Rust port relies on, checked against this very engine.
for (const a of ENTITY_TYPES) for (const b of ENTITY_TYPES) if (a.localeCompare(b) !== (a < b ? -1 : a > b ? 1 : 0)) throw new Error(`localeCompare(${a}, ${b}) is not the code unit order`);
if (JSON.stringify(NATIVE_FMT) !== '{"bold":1,"italic":2,"underline":4,"strike":8,"mono":16,"spoiler":32,"link":64,"quote":128,"pre":256}') throw new Error('NATIVE_FMT changed');
if (JSON.stringify(ENTITY_TYPES) !== '["bold","italic","underline","strikethrough","code","pre","spoiler","quote","text_link"]' || ENTITY_LIMITS.count !== 100 || ENTITY_LIMITS.language !== 32 || ENTITY_LIMITS.url !== 2048) throw new Error('entities.ts changed');
if (process.versions.unicode !== '17.0') console.warn(`Unicode ${process.versions.unicode}: the \\p{M} table in src/format.rs is 17.0's`);

// ---- a deterministic generator ----
let seed = 0x5eed1e55;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = n => Math.floor(rnd() * n);
const between = (a, b) => a + int(b - a + 1);
const chance = p => rnd() < p;
const pick = list => list[int(list.length)];

const lines = [];
const seen = new Set();
const count = {}, size = {};
let family = '';
const stats = { thrown: 0, runs: 0, links: 0, mentions: 0, quotes: 0, pres: 0 };
function add(text, entities) {
  const input = entities === undefined ? undefined : JSON.parse(JSON.stringify(entities));
  if (input === undefined && entities !== undefined) throw new Error('not a JSON value');
  let out;
  try { out = nativeText(text, input); } catch (error) { if (!(error instanceof TypeError)) throw error; out = null; }
  const line = JSON.stringify(input === undefined ? { text, out } : { text, entities: input, out });
  if (seen.has(line)) return out;
  seen.add(line); lines.push(line);
  count[family] = (count[family] ?? 0) + 1; size[family] = (size[family] ?? 0) + Buffer.byteLength(line) + 1;
  if (!out) stats.thrown++;
  else {
    if (out.fmt.length % 3 || out.fmt.some(n => !Number.isInteger(n) || n < 0)) throw new Error('fmt is not triples of whole numbers: ' + line);
    let links = 0;
    for (let i = 0; i < out.fmt.length; i += 3) { stats.runs++; if (out.fmt[i] & 64) links++; if (out.fmt[i] & 128) stats.quotes++; if (out.fmt[i] & 256) stats.pres++; if (out.fmt[i + 1] + out.fmt[i + 2] > out.text.length) throw new Error('a run outside the text: ' + line); }
    if (links !== out.urls.length) throw new Error('urls do not match the link runs: ' + line);
    stats.links += links; stats.mentions += out.urls.filter(url => url.startsWith('mention:')).length;
  }
  return out;
}
const E = (type, offset, length, extra) => ({ type, offset, length, ...extra });
const link = (offset, length, url = 'https://example.org/a') => E('text_link', offset, length, { url });
const cp = code => String.fromCodePoint(code);

// ---- plain texts ----
family = 'plain texts';
const PLAIN = ['', 'x', 'привет', 'как дела?', 'line one\nline two', '\n', '\n\n\n', ' ', 'tabs\tand  spaces', '😀', '👨‍👩‍👧 семья', '🇷🇺🇺🇸', '👍🏽', '❤️', '1️⃣', 'é', 'x\ud83dy', '\ude00 lone', '\ud83d', 'a'.repeat(5000), 'я'.repeat(300) + '😀',
  'ww.x.y', 'http:/x.y', 'https//x.y', 'www', 'www.', 'http://', 'https://', 'www.a', 'http://a', 'www..', 'http://..', 'www.!?', 'at sign @', '@', '@@', 'a@b', '@ab', '0', 'null', '«цитата»', '<b>не тег</b>', '**не жирный**', '`не код`', '\u0000', '﻿', '  '];
for (const text of PLAIN) { add(text); add(text, []); add(text, null); }

// ---- addresses ----
family = 'addresses';
const PREFIXES = ['http://', 'https://', 'HTTP://', 'hTTpS://', 'www.', 'WWW.', 'Www.', 'http://www.', 'https://WWW.', 'http:/', 'https:', 'htp://', 'httpss://', 'wwww.', 'xwww.', '_www.', '9http://', 'Zhttps://', '-http://', '.www.', '/www.', '://www.', 'ftp://', '//', 'http://http://', 'www.www.', 'httpſ://', 'ｈttp://', 'www．', 'я' + 'www.', 'яhttp://', 'é' + 'www.'];
const HOSTS = ['example.org', 'a.b', 'ab', 'a', '', '.', '..', 'a.', '.a', 'пример.рф', 'пример.рф/путь?я=1', 'localhost:8080', '127.0.0.1:3000/x', '[::1]:80/', 'a.b/path/to?x=1&y=2#frag', 'a.b/(x)', 'a.b/(x', 'a.b/[x]', 'a.b/x]', 'ex.org/a_b~c*d|e`f', 'a.b/п/😀', 'a.b/\ud83d', 'user:pw@host.com', 'a.b?x=@name', 'a.b/@name', 'a.b,c.d', 'a.b;c', 'a.b:', 'a.b:8080', 'a.b!', 'a!b', 'a?b', 'a)b', 'a]b', '!', '!!', '!a', '?a!', 'a.b/' + 'x'.repeat(300), 'A.B/C?D=E', 'é.org', 'a.b‍', 'a.b/%20%D1%8F'];
const WRAPS = ['%', '(%)', '[%]', '<%>', '"%"', "'%'", '«%»', '{%}', '%.', '%,', '%...', '%!?', '%;', '%:', '%)', '%]', '%).', '%)]!?', '% ', ' %', 'см. % и %', '%\n%', '%\t%', '%%', 'x%', '%x', 'текст%', '!%', '@%', '%@abc', '% @abc', '**%**', '`%`', '~~%~~', '% x', '% x', '%　', '%﻿x', '% ', '% x', '%​x', '%⁠x', '%\u0085x', '%😀', '%\ud83d', '%́', '(% )', '%<', '%>x', '%"x', "%'x", '%«x', '%»x', '%\rx', '%\vx', '%\fx', '% x', '% x', '% x'];
const wrap = (form, address) => form.replaceAll('%', address);
for (const prefix of PREFIXES) for (const host of HOSTS) add(prefix + host);
for (const prefix of PREFIXES.slice(0, 9)) for (const form of WRAPS) if (prefix.length < 9 || chance(0.5)) add(wrap(form, prefix + 'example.org/a'));
for (const host of HOSTS) for (const form of WRAPS) if (chance(0.4)) add(wrap(form, pick(PREFIXES.slice(0, 9)) + host));
for (let i = 0; i < 300; i++) add(wrap(pick(WRAPS), pick(PREFIXES) + pick(HOSTS)) + (chance(0.3) ? pick([' ', '\n', ', ']) + wrap(pick(WRAPS), pick(PREFIXES) + pick(HOSTS)) : ''));

// Every character an address may hold, end with, or stand after — one by one for the low planes, sampled above.
family = 'address characters';
const units = [];
for (let unit = 0; unit < 0x10000; unit++) if (unit < 0x500 || (unit >= 0x1670 && unit < 0x1690) || (unit >= 0x1ff0 && unit < 0x2070) || (unit >= 0x2ff0 && unit < 0x3010) || unit >= 0xfef0 || unit % 89 === 0 || (unit >= 0xd7f0 && unit < 0xe010 && unit % 5 === 0)) units.push(unit);
const chr = String.fromCharCode;
for (let at = 0; at < units.length; at += 16) add(units.slice(at, at + 16).map(unit => 'http://a' + chr(unit) + 'b').join(' '));
const low = units.filter(unit => unit < 0x250 || (unit >= 0x1670 && unit < 0x1690) || (unit >= 0x1ff0 && unit < 0x2070) || (unit >= 0x2ff0 && unit < 0x3010) || unit >= 0xfef0);
for (let at = 0; at < low.length; at += 12) {
  add(low.slice(at, at + 12).map(unit => 'www.ab' + chr(unit)).join(' '));          // the last character
  add(low.slice(at, at + 12).map(unit => chr(unit) + 'www.ab').join(' '));          // the one before (\b)
  add(low.slice(at, at + 12).map(unit => chr(unit) + '@abc').join(' '));            // before a mention
  add(low.slice(at, at + 12).map(unit => '@abc' + chr(unit)).join(' '));            // after a mention
  add(low.slice(at, at + 12).map(unit => '@ab' + chr(unit) + 'c').join(' '));       // inside a name
  if (low[at] < 0x180) add(low.slice(at, at + 12).map(unit => 'htt' + chr(unit) + '://ab www' + chr(unit) + 'ab ' + chr(unit) + 'ttp://ab').join(' '));
}
for (const letter of ['ſ', 'K', 'ı', 'İ', 'ｗ', 'ｈ', 'Ｈ', 'ŝ', 'ẞ', 'ß']) add(`htt${letter}://ab http${letter}://ab ${letter}ww.ab ww${letter}.ab @a${letter}c @${letter}bcd`);

// ---- mentions ----
family = 'mentions';
const name = n => 'abcdefghij_0123456789ABCDEFGHIJxyz'.slice(0, n);
const MENTIONS = ['@a', '@ab', '@abc', '@a_1', '@___', '@123', '@' + name(23), '@' + name(24), '@' + name(25), '@' + name(26), '@' + name(24) + ' x', '@' + name(24) + '@' + name(3), '@' + 'a'.repeat(48), '@' + 'a'.repeat(49), '@abc@def', '@@abc', '@abc@', 'a@abc', 'mail a@mail.ru', 'a@mail.ru', 'A@ABC', '9@abc', '_@abc', '.@abc', '/@abc', '-@abc',
  '+@abc', '(@abc)', '[@abc]', '@abc.', '@abc,', '@abc!', '@abc:', '@abc-def', '@abc.def', '@abc/def', '@ABC', '@Abc_DEF', '@абв', '@abcд', 'д@abc', '@abc д', 'привет, @abc!', '@abc @def @ghi', '@abc\n@def', '@abc\t@def', '@abc,@def', '@abc.@def', '@abc/@def', '@abc-@def', '@ab @abc',
  'https://t.me/@abc', 'www.x.y @abc', 'www.x.y@abc', '@abc www.x.y', '@abc/www.x.yz', '@www.abc', '@www.ab @www', '@http://a.bc', '@https', 'http://@abc', 'www.@abc', '😀@abc', '@abc😀', '\ud83d@abc', '@abc\ud83d', '@abć', '́@abc', '@abc‍', 'é@abc', '@ abc', '@\nabc', '＠abc', '@abc' + '@abc'.repeat(30), ('@abc ').repeat(60), '@İstanbul', '@ſſſ', '@KKK', '@KKK'];
for (const text of MENTIONS) { add(text); add('x ' + text + ' y'); add(text + text); }
for (let n = 0; n <= 60; n++) { add('@' + 'a'.repeat(n)); add('@' + 'B'.repeat(n) + ' ' + '@' + '9'.repeat(60 - n) + '.'); }
for (let i = 0; i < 300; i++) add(Array.from({ length: between(1, 5) }, () => pick(MENTIONS.slice(0, 60))).join(pick([' ', '', '\n', ', ', '.', '/', '-', '@', 'x'])));

// ---- every entity type ----
const TYPES = [...ENTITY_TYPES];
const extra = type => type === 'text_link' ? { url: 'https://example.org/a' } : {};
family = 'one entity';
const TEXTS = ['hello world', 'привет, мир', 'ab\ncd\n\nef\n', '\nab\n', 'a', '\n', 'x😀y', 'see https://example.org/a?b and @name ok', 'www.a.bc', '@abc', 'one\ntwo\nthree', '  spaced  '];
for (const text of TEXTS) for (const type of TYPES) {
  add(text, [E(type, 0, text.length, extra(type))]);
  add(text, [E(type, 0, 1, extra(type))]);
  add(text, [E(type, text.length - 1, 1, extra(type))]);
  add(text, [E(type, 1, 3, extra(type))]);
  add(text, [E(type, between(0, text.length), between(0, text.length), extra(type))]);
}
// Every range of a text with lines, for every type; and of an address with a mention, for the inline ones.
for (const text of ['ab\ncd\n\nef\n', '\n\na\n']) for (const type of TYPES) for (let offset = 0; offset <= text.length + 1; offset++) for (let length = 0; offset + length <= text.length + 2; length++) add(text, [E(type, offset, length, extra(type))]);
{
  const text = 'go https://example.org/a?b @name, www.x.yz!';
  for (const type of ['bold', 'code', 'text_link', 'spoiler']) for (let offset = 0; offset < text.length; offset++) for (let length = 1; offset + length <= text.length; length += type === 'bold' ? 3 : 5) add(text, [E(type, offset, length, extra(type))]);
}

family = 'several entities';
{
  const text = 'The quick brown fox\njumps over\nthe lazy dog\n\nand https://example.org runs to @home';
  const some = () => { const type = pick(TYPES); const offset = int(text.length); return E(type, offset, between(1, 12), extra(type)); };
  // nested, overlapping, adjacent, the same kind twice, one inside another
  add(text, [E('bold', 0, 20), E('italic', 4, 5)]); add(text, [E('bold', 0, 9), E('italic', 4, 11)]); add(text, [E('bold', 0, 4), E('bold', 4, 5)]); add(text, [E('bold', 0, 4), E('bold', 5, 5)]); add(text, [E('bold', 0, 4), E('bold', 2, 9), E('bold', 20, 3)]);
  add(text, [E('bold', 4, 5), E('italic', 4, 5), E('underline', 4, 5), E('strikethrough', 4, 5), E('code', 4, 5), E('spoiler', 4, 5), link(4, 5)]);
  add(text, [E('quote', 0, 19), E('pre', 20, 10)]); add(text, [E('quote', 0, 19), E('quote', 20, 10)]); add(text, [E('quote', 0, 30), E('pre', 20, 10)]); add(text, [E('pre', 20, 10), E('quote', 0, 30)]); add(text, [E('pre', 0, 19), E('pre', 20, 10)]); add(text, [E('pre', 0, 25), E('pre', 20, 10)]);
  add(text, [E('quote', 0, 19), E('bold', 4, 30), E('pre', 31, 3), link(50, 20)]); add(text, [E('quote', 49, 30), link(49, 3), E('code', 60, 10)]); add(text, [E('pre', 49, 30), link(49, 3), E('bold', 60, 10)]);
  add(text, [link(0, 9, 'https://a.example/1'), link(4, 11, 'https://b.example/2')]); add(text, [link(4, 11, 'https://b.example/2'), link(0, 9, 'https://a.example/1')]); add(text, [link(0, 9), link(9, 5)]); add(text, [link(0, 9), link(4, 11)]); add(text, [link(0, 9, 'https://a.example/1'), link(0, 9, 'https://b.example/2')]);
  add(text, [E('code', 47, 30), E('bold', 40, 20)]); add(text, [E('code', 50, 8)]); add(text, [E('spoiler', 50, 8), E('italic', 70, 20)]);
  for (let i = 0; i < 350; i++) add(text, Array.from({ length: between(2, 7) }, some));
  const lines5 = 'q1\nq2\n\ncode\nmore\ntail';
  for (let i = 0; i < 300; i++) add(lines5, Array.from({ length: between(1, 4) }, () => { const type = chance(0.7) ? pick(['quote', 'pre']) : pick(TYPES); return E(type, int(lines5.length + 1), between(0, 9), { ...extra(type), ...(type === 'pre' && chance(0.5) ? { language: pick(['js', 'rs']) } : {}) }); }));
}

// ---- emoji, surrogate pairs and combining marks at the edges ----
family = 'graphemes';
for (const text of ['a👨‍👩‍👧b🇷🇺🇺🇸c', '👍🏽d❤️e1️⃣f́g', '🇷🇺🇺🇸🇩', 'x\ud83d😀\ude00y‍‍z', '́‍a😀‍', '🇷\n🇺🇸\ń']) {
  for (const type of ['bold', 'quote', 'pre']) for (let offset = 0; offset <= text.length; offset++) for (let length = 0; offset + length <= text.length; length++) if (type === 'bold' || chance(0.25)) add(text, [E(type, offset, length)]);
  for (let offset = -0.5; offset <= text.length + 1; offset += 0.5) for (const length of [0.5, 1, 2.25]) { add(text, [E('bold', offset, length)]); if (chance(0.3)) add(text, [E(pick(['quote', 'pre', 'text_link', 'code']), offset, length, { url: 'http://x.y' })]); }
}
// \p{M}: the edges of every range, the skin tones, the regional indicators, ZWJ.
const marks = []; { let from = -1; for (let code = 0; code <= 0x110000; code++) { const is = code < 0x110000 && /\p{M}/u.test(cp(code)); if (is && from < 0) from = code; if (!is && from >= 0) { marks.push([from, code - 1]); from = -1; } } }
const edges = new Set([0x200c, 0x200d, 0x200e, 0x1f3fa, 0x1f3fb, 0x1f3ff, 0x1f400, 0x1f1e5, 0x1f1e6, 0x1f1ff, 0x1f200, 0xfe0e, 0xfe0f, 0x20e3, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0x10ffff]);
for (const [from, to] of marks) for (const code of [from - 1, from, to, to + 1]) edges.add(code);
for (const code of edges) { const text = 'x' + cp(code) + 'y' + cp(code) + cp(code) + 'z'; add(text, [E('bold', 0, 1), E('italic', 3, text.length - 4)]); }
for (const pair of [[0x1f1e6, 0x1f1ff], [0x1f1e5, 0x1f1e6], [0x1f1ff, 0x1f200], [0x1f1f7, 0x1f1fa]]) for (let n = 1; n <= 5; n++) { const text = 'a' + (cp(pair[0]) + cp(pair[1])).repeat(n).slice(0, n * 2) + 'b'; for (let offset = 0; offset <= text.length; offset++) add(text, [E('bold', offset, 1), E('spoiler', 0, offset)]); }

// ---- links given by an entity ----
family = 'text_link addresses';
const URLS = ['https://example.org', 'http://example.org/a?b#c', 'HTTPS://EXAMPLE.ORG', 'hTTp://x', 'https://пример.рф/путь', 'https://a.b/😀', 'https://\ud83d', 'http://', 'https://', 'https:// ', 'https://a b', 'https://a\n', 'https://a b', 'https://a ', 'https://a﻿', ' https://a.b', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'mailto:a@b.c', 'tel:+70000000000', 'data:text/html,x', '/relative', '../up', '//host/path', 'example.org', 'www.example.org', 'ftp://a.b', 'httpx://a.b', 'https:/a.b', 'https//a.b', '', ' ',
  'https://a.b/' + 'x'.repeat(2036), 'https://a.b/' + 'x'.repeat(2037), 'https://' + 'я'.repeat(2040), 'https://' + 'я'.repeat(2041), 'httpſ://a.b', 'http://a.b/\u0000', 'mention:abc', 'https://a.b/@name', 'https://www.x.y/"quoted"'];
for (const url of URLS) { add('click here now', [link(6, 4, url)]); add('go www.a.bc or @abc', [link(3, 8, url)]); add('ab', [link(0, 2, url), link(0, 1, 'https://second.example')]); }
for (const url of [undefined, null, 5, true, false, [], ['https://a.b'], {}, { url: 'https://a.b' }, 0, 'https://a.b']) { add('click here now', [{ type: 'text_link', offset: 6, length: 4, ...(url === undefined ? {} : { url }) }]); add('click', [E('bold', 0, 5, url === undefined ? {} : { url })]); }
// A link over an address or a mention, a part of one, or text next to it; and the same with code.
for (const text of ['see https://example.org/a now', 'hi @someone there', 'x www.a.bc', 'a@b.cd @ef', 'https://a.b']) for (let offset = 0; offset < text.length; offset += 2) for (const length of [1, 3, 8, 40]) { add(text, [link(offset, length)]); add(text, [E('code', offset, length)]); add(text, [E('pre', offset, length)]); add(text, [E('quote', offset, length), E('underline', offset + 1, length)]); }
for (const text of ['code:\nfetch("https://example.org/@x")\nend', 'https://a.bc\nwww.d.ef\n@ghi', '> https://a.bc @quoted\nplain www.d.ef']) for (const type of TYPES) for (let offset = 0; offset < text.length; offset += 5) add(text, [E(type, offset, between(1, 25), extra(type))]);

// ---- values of the wrong kind ----
family = 'entities of the wrong shape';
for (const text of ['hello', 'a @abc www.d.ef', '']) {
  for (const entities of [null, true, false, 0, 5, -1, 1.5, '', 'bold', 'x'.repeat(200), '😀', {}, { length: 0 }, { length: 1 }, { length: -1 }, { length: '' }, { length: 'x' }, { length: '0' }, { length: null }, { length: false }, { length: true }, { length: [] }, { length: {} }, { length: 0.5 }, { length: 1, 0: E('bold', 0, 1) }, { 0: E('bold', 0, 1) }, { type: 'bold', offset: 0, length: 1 }, { type: 'bold', offset: 0, length: 0 },
    [], [null], [E('bold', 0, 1), null], [null, E('bold', 0, 1)], [1, 'a', true, false, [], 0.5, 'bold'], [[E('bold', 0, 1)]], [[]], [[null]], [{}], [{ type: 5 }], [{ type: null }], [{ type: ['bold'] }], [{ type: { type: 'bold' } }], [{ type: true }], [{ type: 'bold' }], [{ type: 'Bold', offset: 0, length: 1 }], [{ type: 'bold ', offset: 0, length: 1 }], [{ type: '', offset: 0, length: 1 }], [{ type: 'mention', offset: 0, length: 5 }], [{ type: 'url', offset: 0, length: 5 }],
    [{ type: 'blockquote', offset: 0, length: 5 }], [{ type: 'strike', offset: 0, length: 5 }], [{ type: 'custom_emoji', offset: 0, length: 5 }], [{ type: 'hashtag', offset: 0, length: 5 }], [{ type: 'toString', offset: 0, length: 5 }], [{ type: 'constructor', offset: 0, length: 5 }], [{ type: '__proto__', offset: 0, length: 5 }], [{ type: 'bold', offset: 0, length: 3, extra: 1, __proto__x: 2 }], [{ type: 'bold', offset: 0 }], [{ type: 'bold', length: 3 }], [{ offset: 0, length: 3 }],
    [E('unknown', 0, 2), E('italic', 1, 2)], [E('unknown', 0, 2), null], [{ type: 'bold', offset: 0, length: 2, toString: 1 }], [{ type: 'bold', offset: 0, length: 2, valueOf: 1, slice: 2, url: 3, language: 4 }]]) add(text, entities);
}
const NUMBERS = [undefined, null, true, false, 0, -0, 1, 2, 3, -1, -5, 0.5, 1.5, 2.999, -0.5, 1e21, 1e-7, 2 ** 53, 4294967296, 4294967297, -4294967295, 1e300, 5e-324,
  '', ' ', '0', '1', '2', ' 2 ', '\n3\t', '﻿1 ', '᠎1', '1.5', '.5', '5.', '+1', '-1', '-0', '+', '-', '.', 'e1', '1e', '1e+', '1e1', '2E0', '1e-1', '+.5e1', '0x2', '0X3', '0x', '-0x1', '+0x1', '0b10', '0B11', '0b2', '0o3', '0O4', '0o8', '0x1g', '0x1fffffffffffff8', '0x20000000000001', '0x20000000000003', '0x1' + '0'.repeat(300), '00012', '1_0', '1 2', '1,2', 'abc', 'Infinity', '+Infinity', '-Infinity', 'infinity', 'Infinityx', 'NaN', 'null', 'true', '１', '2n', '0.0000001', '1' + '0'.repeat(25), '0.' + '0'.repeat(30) + '1', '3.0000000000000000000000001', '😀',
  [], [1], [2], ['2'], [1, 2], [[3]], [[[1]]], [null], [null, null], [[], []], [true], [1.5], [-0], [1e21], [{}], ['a'], [[1], [2]], {}, { a: 1 }, { valueOf: 2 }, { toString: 2 }, { toString: null }, { toString: 'x', valueOf: 1 }, [{ toString: 1 }], [1, [{ toString: 1 }]], { length: 1 }, { 0: 1 }];
const withKeys = (type, offset, length) => ({ type, ...(offset === undefined ? {} : { offset }), ...(length === undefined ? {} : { length }), ...extra(type) });
for (const text of ['ab\ncd\nef\ngh\n']) for (const type of ['bold', 'quote', 'pre', 'text_link']) for (const value of NUMBERS) {
  for (const other of [1, '2', undefined]) { add(text, [withKeys(type, value, other)]); add(text, [withKeys(type, other, value)]); }
  add(text, [withKeys(type, value, value)]); if (type === 'bold' || type === 'quote') add(text, [E('italic', 1, 4), withKeys(type, value, 2), E('spoiler', 2, 5)]);
}
family = 'pre languages';
for (const language of [undefined, null, '', 'rust', 'js', 'x'.repeat(32), 'x'.repeat(33), 'x'.repeat(40), 0, -0, 5, 0.5, true, false, [], ['rust'], [[]], {}, { slice: 1 }, { length: 0 }, '😀'.repeat(17), 'x'.repeat(31) + '😀']) {
  const lang = language === undefined ? {} : { language };
  for (const text of ['ab\ncd\nef', 'code']) {
    add(text, [E('pre', 0, 2, lang)]); add(text, [E('pre', 0, 0, lang)]); add(text, [E('pre', 99, 1, lang)]); add(text, [E('pre', -3, 1, lang)]); add(text, [E('pre', 'x', 1, lang)]); add(text, [E('quote', 0, 2, lang)]); add(text, [E('bold', 0, 2, lang)]);
    if (text !== 'code') for (const second of [undefined, 'rust', 'x'.repeat(35), []]) for (const [a, b] of [[0, 3], [0, 0], [3, 3], [3, 0], [6, 0], [0, 6]]) add(text, [E('pre', a, 2, lang), E('pre', b, 5, second === undefined ? {} : { language: second })]);
  }
}

// ---- more entities than are kept, and orders NaN makes inconsistent ----
family = 'many entities';
{
  const long = Array.from({ length: 60 }, (_, i) => `w${i} line`).join('\n') + ' https://example.org/x @tail';
  for (const n of [99, 100, 101, 150]) { add(long, Array.from({ length: n }, (_, i) => E('bold', i * 2, 1))); add(long, Array.from({ length: n }, (_, i) => E(TYPES[i % 5], (n - i) * 2, 1))); add(long, Array.from({ length: n }, (_, i) => E(i % 3 ? 'italic' : 'quote', i * 3, 1))); }
  const lost = () => pick([{ offset: 'x', length: 1 }, { length: 2 }, { offset: {}, length: 1 }, { offset: [1, 2], length: 3 }, { offset: 'NaN', length: 0 }]);
  const halfLost = at => pick([{ offset: at }, { offset: at, length: 'x' }, { offset: at, length: {} }]);
  const entity = (at, p) => {
    const type = chance(0.6) ? pick(['bold', 'italic', 'spoiler']) : pick(TYPES);
    const range = chance(p) ? lost() : chance(p / 2) ? halfLost(at) : { offset: at, length: pick([1, 1, 2, 3, 5, 9, 0.5, 1.5]) };
    return { type, ...range, ...(type === 'text_link' ? { url: 'https://e.org/' + int(4) } : {}) };
  };
  const list = (n, p, order) => {
    const at = order === 'random' ? () => int(long.length) : order === 'few' ? () => int(12) * 7 : null;
    let position = order === 'down' ? long.length : 0;
    return Array.from({ length: n }, (_, i) => {
      if (at) return entity(at(), p);
      if (order === 'up') position += int(4); else if (order === 'down') position -= int(4); else if (order === 'saw') position = (i % between(20, 90)) * 3; else if (order === 'two') position = i % 2 ? i * 2 : long.length - i * 2; else if (order === 'runs') position = chance(0.03) ? int(long.length) : position + int(3);
      return entity(Math.max(0, position), p);
    });
  };
  const ORDERS = ['random', 'few', 'up', 'down', 'saw', 'two', 'runs'];
  for (let i = 0; i < 140; i++) add(long.slice(0, between(40, 200)), list(between(2, 63), pick([0, 0.05, 0.2, 0.5]), pick(ORDERS)));
  for (let i = 0; i < 35; i++) add(long, list(pick([64, 65, 66, 100, 127, 128, 129, between(64, 160), between(64, 260), between(160, 260)]), pick([0, 0.01, 0.03, 0.1, 0.3]), ORDERS[i % ORDERS.length]));
}

// ---- random combinations ----
family = 'random';
const PARTS = ['привет', 'hello', ' ', ' ', '\n', '\n', '\n\n', 'https://example.org/a', 'http://a.b/c?d=1', 'www.site.ru', '@user_name', '@ab', 'a@mail.ru', '😀', '👨‍👩‍👧', '🇷🇺', '👍🏽', 'é', '\ud83d', '.', ',', '!', '(', ')', '«', '»', 'код', 'x', '1️⃣', '\t', 'Очень длинное слово', '`', '**', 'HTTPS://UP.CASE/X', '@@', '/'];
const someNumber = length => chance(0.85) ? between(-1, length + 2) : pick([0.5, 1.5, '1', '', null, true, 'x', [2], {}, 1e9, -3, 2.5, '0x2']);
for (let i = 0; i < 1000; i++) {
  const text = Array.from({ length: between(1, 9) }, () => pick(PARTS)).join('');
  const entities = Array.from({ length: between(0, 6) }, () => {
    const type = chance(0.93) ? pick(TYPES) : pick(['mention', 'blockquote', 'strike', 'url', 5, null]);
    const offset = chance(0.9) ? int(text.length + 1) : someNumber(text.length);
    const length = chance(0.9) ? between(1, Math.max(1, text.length - (typeof offset === 'number' ? offset : 0))) : someNumber(text.length);
    return { type, offset, length, ...(type === 'text_link' ? { url: chance(0.9) ? pick(['https://example.org/a', 'http://b.example']) : pick(URLS) } : {}), ...(type === 'pre' && chance(0.4) ? { language: pick(['rust', '', 'py']) } : {}) };
  });
  add(text, chance(0.04) ? pick([undefined, null, [], [...entities, null], 'text', { length: entities.length }]) : entities);
}

// ---- did every block of the reference run? ----
const { result } = await session.post('Profiler.takePreciseCoverage');
// The functions the core ports, as [file, from, to] marks in the source (a missing `to` is the end of the file).
const PORTED = [
  ['nativeSpans.ts', 'const safeUrl', null],
  ['render.ts', 'function spansOf', '/** True when the message ends'],
  ['entities.ts', 'const isBlock', 'const record'], ['entities.ts', 'export const validLinkUrl', '\n\n'], ['entities.ts', 'const high', '/** Entities of `type` that lie'],
  ['markdown.ts', 'const MENTION_RE', null],
];
// Blocks nativeText cannot reach, each with the reason; anything else that never ran fails the run.
const UNREACHABLE = [
  // The cut points come from a Set and are sorted ascending: two neighbours are never equal or reversed.
  ['render.ts', 'continue;\n    const span: Span = { text: text.slice(from, to) }'],
  // toBlocks with an empty text: nativeText answers an empty text before calling it.
  ['render.ts', ': [];\n  const blocks: Block[] = [];'],
  // linkTokens with an empty text: nativeText calls it only for a span that holds an address or an `@`.
  ['markdown.ts', 'return [];\n  const found: { start: number; end: number; token: LinkToken }[] = [];'],
];
let unreached = 0, blocks = 0, excused = 0;
for (const [name, from, to] of PORTED) {
  const source = readFileSync(file(name), 'utf8');
  const start = source.indexOf(from), end = to === null ? source.length : source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`${name} changed: ${from}`);
  const script = result.find(entry => entry.url === pathToFileURL(file(name)).href);
  if (!script) throw new Error(`no coverage for ${name}`);
  for (const fn of script.functions) for (const range of fn.ranges) {
    if (range.startOffset < start || range.endOffset > end) continue;
    blocks++;
    if (range.count > 0) continue;
    const rest = source.slice(range.startOffset);
    const known = UNREACHABLE.findIndex(([where, begins]) => where === name && rest.startsWith(begins.split('\n')[0]) && source.slice(range.startOffset, range.startOffset + 400).replace(/\s+/g, ' ').startsWith(begins.replace(/\s+/g, ' ').slice(0, range.endOffset - range.startOffset)));
    if (known >= 0) { excused++; UNREACHABLE[known].seen = true; console.log(`cannot run  ${name}:${source.slice(0, range.startOffset).split('\n').length}  ${JSON.stringify(source.slice(range.startOffset, range.endOffset).slice(0, 60))}`); continue; }
    unreached++;
    console.log(`NEVER RAN  ${name}:${source.slice(0, range.startOffset).split('\n').length}  ${JSON.stringify(source.slice(range.startOffset, Math.min(range.endOffset, range.startOffset + 110)))}`);
  }
}
await session.post('Profiler.stopPreciseCoverage');
session.disconnect();
for (const entry of UNREACHABLE) if (!entry.seen) throw new Error(`a block listed as unreachable ran or is gone: ${entry[1]}`);

for (const key of Object.keys(count)) console.log(String(count[key]).padStart(7), key.padEnd(30), String(Math.round(size[key] / 1024)).padStart(5), 'KiB');
console.log(`${stats.thrown} cases where the reference throws; ${stats.runs} runs, ${stats.links} with an address (${stats.mentions} mentions), ${stats.quotes} quoted, ${stats.pres} in code blocks`);
console.log(`reference coverage: ${blocks - unreached - excused} of ${blocks} blocks (functions and branches) of the ported code ran; ${excused} cannot be reached through nativeText, ${unreached} missed`);
if (unreached) { console.error('not every block of the reference was reached — vectors not written'); process.exit(1); }
const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
if (bytes > 4 * 1024 * 1024) { console.error(`format.json would be ${bytes} bytes — over 4 MiB, not written`); process.exit(1); }
writeFileSync(join(here, 'vectors', 'format.json'), lines.join('\n') + '\n');
console.log('format.json', lines.length, 'cases,', Math.round(bytes / 1024), 'KiB');
