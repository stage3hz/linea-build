// Produces tests/vectors/preview.json: what the reference `validPreview` (mobile/src/media/previewModel.ts) says
// about many previews. The reference itself is run — previewModel.ts with its real jpeg.ts, jpegHdr.ts and
// base64-js — through the loader the mobile tests use. Every case is a JSON text (as it arrives in a message)
// and the verdict for JSON.parse of it; a case without `json` is `undefined` (no preview).
// Also tests/vectors/preview-create.json: what the reference `createPreview` makes of the same files (the cleaned
// picture and its size, or a refusal). `validPreview` only tells whether the result equals the input, so some
// of what it runs — taking the first picture of a gain-map file, dropping what follows the end — shows only there.
// Run from the repository root:  node native/core/tests/generate-preview-vectors.mjs
import { writeFileSync } from 'node:fs';
import { loadTs } from '../../../mobile/test/support/load-ts.mjs';
import { jpegFixture, jpegSegment } from '../../../mobile/test/support/jpeg-fixture.mjs';

const cache = new Map();
const { validPreview, createPreview } = loadTs(new URL('../../../mobile/src/media/previewModel.ts', import.meta.url), {}, cache);
const { sanitizeJpeg } = loadTs(new URL('../../../mobile/src/photo/jpeg.ts', import.meta.url), {}, cache);

// A fixed generator: the same cases on every run.
let seed = 0x1badc0de;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const below = n => Math.floor(random() * n);
const pick = list => list[below(list.length)];
const randomBytes = (n, safe = false) => Buffer.from(Array.from({ length: n }, () => { const b = below(256); return safe && b === 255 ? 254 : b; }));

const cases = [];
const seen = new Set();
function addText(name, json) {
  if (json !== undefined && seen.has(json)) return;
  seen.add(json);
  const value = json === undefined ? undefined : JSON.parse(json);
  const valid = validPreview(value);
  if (typeof valid !== 'boolean') throw new Error('the reference did not answer: ' + name);
  cases.push(json === undefined ? { name, valid } : { name, json, valid });
  return valid;
}
const add = (name, value) => addText(name, JSON.stringify(value));
const b64 = bytes => Buffer.from(bytes).toString('base64');
const preview = (bytes, width, height, extra = {}) => ({ mimeType: 'image/jpeg', base64: b64(bytes), width, height, ...extra });
/** The size the reference's own sanitiser reads from the file, when it accepts it. */
const sizeOf = bytes => { try { const c = sanitizeJpeg(bytes); return [c.width, c.height]; } catch { return null; } };
/** The file with the size it really has (or the given one when the sanitiser refuses it). */
const files = [];
function addFile(name, bytes) {
  const file = b64(bytes);
  if (seenFiles.has(file)) return;
  seenFiles.add(file);
  let made = null;
  try { made = createPreview(new Uint8Array(bytes)); } catch { /* refused */ }
  if (made && made.mimeType !== 'image/jpeg') throw new Error('the reference changed: ' + name);
  // `same`: the cleaned picture is the file itself.
  files.push(made ? { name, file, ...(made.base64 === file ? { same: true } : { base64: made.base64 }), width: made.width, height: made.height } : { name, file });
}
const seenFiles = new Set();
const honest = (name, bytes, fallback = [2, 2]) => { addFile(name, bytes); const [w, h] = sizeOf(bytes) ?? fallback; return add(name, preview(bytes, w, h)); };

// ---- Building blocks: hand-assembled JPEG streams (structure only; nothing here decodes pixels) ----
const SOI = Buffer.from([255, 0xd8]), EOI = Buffer.from([255, 0xd9]);
function frame({ width = 2, height = 2, precision = 8, components = 3, marker = 0xc0, extra = Buffer.alloc(0) } = {}) {
  const data = Buffer.alloc(6 + components * 3); data[0] = precision; data.writeUInt16BE(height, 1); data.writeUInt16BE(width, 3); data[5] = components;
  for (let i = 0; i < components; i++) { data[6 + i * 3] = i + 1; data[7 + i * 3] = 0x11; data[8 + i * 3] = i ? 1 : 0; }
  return jpegSegment(marker, Buffer.concat([data, extra]));
}
function scan({ components = 3, extra = Buffer.alloc(0) } = {}) {
  const data = Buffer.alloc(1 + components * 2 + 3); data[0] = components;
  for (let i = 0; i < components; i++) data[1 + i * 2] = i + 1;
  data[data.length - 2] = 63;
  return jpegSegment(0xda, Buffer.concat([data, extra]));
}
const dqt = (id = 0, precision = 0, fill = 1) => jpegSegment(0xdb, Buffer.concat([Buffer.from([precision << 4 | id]), Buffer.alloc(64 * (precision ? 2 : 1), fill)]));
function dht(kind = 0, id = 0, counts = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]) {
  const total = counts.reduce((a, b) => a + b, 0);
  return jpegSegment(0xc4, Buffer.concat([Buffer.from([kind << 4 | id]), Buffer.from(counts), Buffer.from(Array.from({ length: total }, (_, i) => i & 255))]));
}
const dri = (n = 4) => jpegSegment(0xdd, Buffer.from([n >> 8, n & 255]));
const ENTROPY = Buffer.from([0x12, 0x34, 0x56]);
function jpeg({ head = [], tables = [dqt(), dht()], frameAt = {}, afterFrame = [], scanAt = {}, entropy = ENTROPY, tail = [], end = true, soi = true, hasFrame = true, hasScan = true } = {}) {
  return Buffer.concat([...(soi ? [SOI] : []), ...head, ...tables, ...(hasFrame ? [frame(frameAt)] : []), ...afterFrame, ...(hasScan ? [scan(scanAt), entropy] : []), ...tail, ...(end ? [EOI] : [])]);
}

// ---- Valid previews ----
const pillow = Buffer.from(sanitizeJpeg(jpegFixture()).bytes);
const made = createPreview(jpegFixture());
add('made by createPreview', made);
addText('no preview', undefined);
honest('minimal: frame and scan only', jpeg({ tables: [] }));
honest('minimal grey', jpeg({ tables: [], frameAt: { components: 1 }, scanAt: { components: 1 } }));
for (const marker of [0xc0, 0xc1, 0xc2]) honest(`frame marker ${marker.toString(16)}`, jpeg({ frameAt: { marker } }));
for (const [width, height] of [[1, 1], [1, 256], [256, 1], [256, 256], [255, 256], [16, 9], [100, 100]]) honest(`size ${width}x${height}`, jpeg({ frameAt: { width, height } }));
honest('scan with one of three components', jpeg({ scanAt: { components: 1 } }));
honest('scan with two components', jpeg({ scanAt: { components: 2 } }));
honest('several scans', jpeg({ frameAt: { marker: 0xc2 }, tail: [scan({ components: 1 }), Buffer.from([1, 2]), dht(1, 1), scan({ components: 1 }), Buffer.from([3])] }));
honest('tables between scans', jpeg({ tail: [dqt(1), dri(0), scan(), Buffer.from([9, 9, 9])] }));
honest('all table kinds', jpeg({ tables: [dqt(0), dqt(1, 1), dqt(3, 0, 255), dht(0, 0), dht(1, 3), dri(8)] }));
honest('two tables in one DQT', jpeg({ tables: [jpegSegment(0xdb, Buffer.concat([dqt(0).subarray(4), dqt(1, 1).subarray(4)]))] }));
honest('two tables in one DHT', jpeg({ tables: [jpegSegment(0xc4, Buffer.concat([dht(0, 0).subarray(4), dht(1, 1).subarray(4)]))] }));
honest('DHT with 256 symbols', jpeg({ tables: [dht(0, 0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 255])] }));
honest('DHT with no symbols', jpeg({ tables: [dht(0, 0, Array(16).fill(0))] }));
honest('tables after the frame', jpeg({ tables: [], afterFrame: [dqt(), dht(), dri()] }));
honest('stuffed bytes and restart markers', jpeg({ tables: [dri(1)], entropy: Buffer.from([1, 255, 0, 2, 255, 0xd0, 3, 255, 0xd7, 4, 255, 0xd3]) }));
honest('fill bytes before a stuffed zero', jpeg({ entropy: Buffer.from([1, 255, 255, 0, 2]) }));
honest('fill bytes before a restart marker', jpeg({ entropy: Buffer.from([1, 255, 255, 255, 0xd1, 2]) }));
honest('entropy starting with a restart marker', jpeg({ entropy: Buffer.from([255, 0xd0]) }));
honest('entropy of one stuffed byte', jpeg({ entropy: Buffer.from([255, 0]) }));
// Exactly at the size limit, and just over it.
const sized = total => { const empty = jpeg({ entropy: Buffer.alloc(0) }).length; return jpeg({ entropy: Buffer.alloc(total - empty, 0x5a) }); };
for (const total of [8190, 8191, 8192, 8193, 8194, 8195, 8196, 9000]) honest(`${total} bytes`, sized(total));
// Varied valid files.
const validFiles = [pillow, jpeg({}), jpeg({ tables: [] }), jpeg({ frameAt: { components: 1 }, scanAt: { components: 1 }, tables: [dqt(), dht(), dht(1, 0)] }), jpeg({ frameAt: { marker: 0xc2, width: 64, height: 48 }, tables: [dqt(0), dqt(1), dht(0, 0), dht(1, 0), dri(2)], entropy: Buffer.from([7, 255, 0, 8, 255, 0xd0, 9, 10]), tail: [scan({ components: 1 }), Buffer.from([1, 2, 3, 4])] })];
for (let i = 0; i < 160; i++) {
  const components = pick([1, 3]), width = 1 + below(pick([4, 256, 300])), height = 1 + below(pick([4, 256, 300]));
  const tables = Array.from({ length: below(5) }, () => pick([() => dqt(below(4), below(2), below(256)), () => dht(below(2), below(4), Array.from({ length: 16 }, () => below(4))), () => dri(below(65536))])());
  let entropy = randomBytes(1 + below(40), true);
  if (below(3) === 0) entropy = Buffer.concat([entropy, Buffer.from([255, pick([0, 0xd0, 0xd4, 0xd7])]), randomBytes(below(6), true)]);
  const file = jpeg({ tables, frameAt: { components, width, height, marker: pick([0xc0, 0xc1, 0xc2]) }, scanAt: { components: 1 + below(components) }, entropy });
  if (i < 6) validFiles.push(file);
  honest(`random well-formed file ${i}`, file);
}

// ---- The description around the picture ----
const good = preview(pillow, 2, 2);
for (const [key, values] of Object.entries({
  width: [0, 1, 3, 256, 257, -2, 2.5, 2.0000001, '2', null, true, [2], { valueOf: 2 }, 1e21],
  height: [0, 1, 3, 256, 257, -2, 2.5, '2', null, false, [2], {}],
  mimeType: ['image/jpg', 'image/png', 'image/svg+xml', 'IMAGE/JPEG', 'image/jpeg ', ' image/jpeg', 'image/jpeg\u0000', '', null, 7, ['image/jpeg'], { a: 1 }, true],
  base64: ['', null, 7, true, [good.base64], { a: good.base64 }, 'https://outside.example/image', 'A', 'AA', 'AAA', 'AAAA', '=', '==', '====', 'AA==', 'AAA=', 'A===', '/9g=', '/9j/2Q==', '/9k='],
})) for (const value of values) add(`${key} = ${JSON.stringify(value)}`, { ...good, [key]: value });
for (const key of Object.keys(good)) { const copy = { ...good }; delete copy[key]; add(`without ${key}`, copy); }
for (const key of ['url', 'hdr', 'durationMs', 'Width', 'mimetype', '', ' base64', '__proto__x', 'constructor', 'toString', 'length', '0']) add(`extra key ${JSON.stringify(key)}`, { ...good, [key]: 1 });
add('keys in another order', { height: 2, width: 2, base64: good.base64, mimeType: 'image/jpeg' });
const text = JSON.stringify(good);
addText('spaces in the JSON', text.replace(/,/g, ' ,\n ').replace(/:/, ' : '));
addText('a repeated key, the last one right', text.replace('"width":2', '"width":7,"width":2'));
addText('a repeated key, the last one wrong', text.replace('"width":2', '"width":2,"width":7'));
addText('a repeated picture, the last one right', text.replace('"base64":', '"base64":"AAAA","base64":'));
addText('an extra __proto__ key', text.replace('{', '{"__proto__":null,'));
addText('an extra __proto__ object', text.replace('{', '{"__proto__":{"url":1},'));
addText('everything inside __proto__', `{"__proto__":${text}}`);
addText('the size inside __proto__', text.replace(',"width":2,"height":2', ',"__proto__":{"width":2,"height":2}'));
addText('width 2.0', text.replace('"width":2', '"width":2.0'));
addText('width 2e0', text.replace('"width":2', '"width":2e0'));
addText('width 0.2e1', text.replace('"width":2', '"width":0.2e1'));
addText('width 20e-1', text.replace('"width":2', '"width":20e-1'));
addText('width -0', text.replace('"width":2', '"width":-0'));
addText('width 1e999', text.replace('"width":2', '"width":1e999'));
addText('width 2.0000000000000001', text.replace('"width":2', '"width":2.0000000000000001'));
addText('width 1.9999999999999999', text.replace('"width":2', '"width":1.9999999999999999'));
addText('escaped letters in the text', text.replace('image/jpeg', 'image\\/jp\\u0065g'));
addText('escaped letters in a key', text.replace('"width"', '"w\\u0069dth"'));
addText('escaped digits in the picture', text.replace('"/9j/', '"\\/9j\\u002f'));
for (const value of [null, true, false, 0, 1, -1, 2.5, '', 'image/jpeg', good.base64, [], [good], [[good]], {}, { preview: good }, [1, 2], 'undefined', { 0: good }]) add(`not a preview: ${JSON.stringify(value).slice(0, 40)}`, value);

// ---- Spellings of base64 ----
const spell = (name, base64, width = 2, height = 2) => add(name, { mimeType: 'image/jpeg', base64, width, height });
for (const file of [pillow, jpeg({}), jpeg({ entropy: Buffer.from([1, 2]) }), jpeg({ entropy: Buffer.from([1]) })]) {
  const right = b64(file), pad = right.length - right.replace(/=+$/, '').length, bare = right.slice(0, right.length - pad), tag = `(${file.length} bytes, padding ${pad})`;
  spell(`canonical ${tag}`, right);
  spell(`without padding ${tag}`, bare);
  for (const more of ['=', '==', '===', '====']) spell(`${more} added ${tag}`, right + more);
  for (const end of ['\n', '\r\n', ' ', '\t', '\u0000', ' ', 'A', 'AAAA', 'A===', 'AA==', 'AAA=']) spell(`${JSON.stringify(end)} added ${tag}`, right + end);
  spell(`a line break inside ${tag}`, right.slice(0, 8) + '\n' + right.slice(8));
  spell(`a space in front ${tag}`, ' ' + right);
  spell(`URL-safe alphabet ${tag}`, right.replace(/\+/g, '-').replace(/\//g, '_'));
  spell(`padding in the middle ${tag}`, right.slice(0, 4) + '=' + right.slice(5));
  spell(`padding at the start ${tag}`, '=' + right.slice(1));
  spell(`a full-width digit ${tag}`, right.slice(0, 5) + 'Ａ' + right.slice(6));
  spell(`a Cyrillic letter ${tag}`, right.slice(0, 5) + 'А' + right.slice(6));
  spell(`a character above U+FFFF ${tag}`, right.slice(0, 4) + '😀' + right.slice(6));
  addText(`a lone surrogate ${tag}`, JSON.stringify({ mimeType: 'image/jpeg', base64: 'SURROGATE' + right.slice(1), width: 2, height: 2 }).replace('SURROGATE', '\\ud800'));
  for (const c of ['-', '_', '.', ',', '*', '%', '@', '[', '`', '{', ':', '\u007f', '\u0080', 'é']) spell(`${JSON.stringify(c)} in place of a digit ${tag}`, right.slice(0, 9) + c + right.slice(10));
  // Unused low bits of the last digit: the same bytes, another spelling.
  if (pad) { const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', last = digits.indexOf(bare.at(-1)); for (let bits = 1; bits < (pad === 2 ? 16 : 4); bits++) spell(`loose bits ${bits} ${tag}`, bare.slice(0, -1) + digits[last ^ bits] + '='.repeat(pad)); }
  for (const cut of [1, 2, 3, 4, 5, 8]) spell(`${cut} characters short ${tag}`, right.slice(0, -cut));
}
for (const length of [10920, 10921, 10922, 10923, 10924, 10925, 10926, 10927, 10928, 16400, 70000]) { spell(`${length} letters A`, 'A'.repeat(length)); spell(`${length} characters, padded`, 'A'.repeat(length - 2) + '=='); }
{ // A too-long text whose picture would otherwise be fine.
  const long = sized(8194); spell('8194 bytes of a well-formed file', b64(long));
  spell('8192 bytes, then padding to 10926', b64(sized(8192)) + '==');
}

// ---- What the sanitiser removes or refuses ----
const META = [0xe0, 0xe1, 0xe2, 0xe3, 0xe7, 0xec, 0xed, 0xee, 0xef, 0xfe];
const places = { 'before the tables': s => ({ head: [s] }), 'after the frame': s => ({ afterFrame: [s] }), 'after the scan': s => ({ tail: [s] }), 'after a second scan': s => ({ tail: [scan(), Buffer.from([5]), s] }) };
for (const marker of META) for (const [where, at] of Object.entries(places)) for (const payload of [Buffer.alloc(0), Buffer.from('JFIF\0\x01\x01'), Buffer.from('private')]) honest(`segment ${marker.toString(16)} ${where}, ${payload.length} bytes`, jpeg(at(jpegSegment(marker, payload))));
honest('the Pillow file as encoded (JFIF)', jpegFixture());
const WORDS = ['hdrgm:', 'hdrgm:Version="1.0"', 'HDRGM:', 'HdRgM:', 'hdrgm', 'hdrgm :', 'HDRGainMap', 'hdrgainmap', 'HDRGAINMAP', 'HDRGainMa', 'HDRCapacity', 'hdrcapacitymax', 'HDRCapacit y', 'urn:iso:std:iso:ts:21496', 'URN:ISO:STD:ISO:TS:21496:-1\0', 'urn:iso:std:iso:ts:2149', 'urn:iso:std:iso:ts:21 496',
  'urn:iſo:std:iso:ts:21496', 'urn:ıso:std:iso:ts:21496', 'urn:İso:std:iso:ts:21496', 'HDRCapaKity', 'HDRCapaſity', 'ｈdrgm:', 'xxhdrgm:xx', '﻿hdrgm:', 'hdr﻿gm:', 'hdr\u0000gm:', 'HDRGain​Map'];
const WORD_BYTES = [...WORDS.map(w => [JSON.stringify(w), Buffer.from(w, 'utf8')]),
  ['a stray byte inside', Buffer.concat([Buffer.from('hdr'), Buffer.from([0x80]), Buffer.from('gm:')])], ['a cut sequence inside', Buffer.concat([Buffer.from('hdr'), Buffer.from([0xe2, 0x82]), Buffer.from('gm:')])],
  ['a cut sequence in front', Buffer.concat([Buffer.from([0xf0, 0x9f]), Buffer.from('hdrgm:')])], ['a stray byte behind', Buffer.concat([Buffer.from('HDRGainMap'), Buffer.from([0xff, 0xfe])])],
  ['an overlong letter', Buffer.concat([Buffer.from('hdr'), Buffer.from([0xc1, 0xa7]), Buffer.from('m:')])], ['a mark in front, then a stray byte', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xc0]), Buffer.from('hdrcapacity')])],
  ['UTF-16', Buffer.from('hdrgm:', 'utf16le')]];
for (const [label, payload] of WORD_BYTES) {
  for (const marker of [0xe1, 0xe2, 0xfe]) for (const [where, at] of Object.entries(places)) honest(`gain-map word ${label} in ${marker.toString(16)} ${where}`, jpeg(at(jpegSegment(marker, payload))));
  honest(`gain-map word ${label} in a table`, jpeg({ tables: [jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.concat([payload, Buffer.alloc(64)]).subarray(0, 64)]))] }));
  honest(`gain-map word ${label} in the picture data`, jpeg({ entropy: Buffer.from(payload.filter(b => b !== 255)) }));
}
// A file that announces a gain map takes the other road (primaryJpeg): what follows its first picture is ignored there.
const announce = jpegSegment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x hdrgm:Version="1.0"/>'));
const second = jpeg({ head: [jpegSegment(0xe1, Buffer.from('hdrgm:GainMapMax="1"'))], frameAt: { components: 1, width: 1, height: 1 }, scanAt: { components: 1 } });
for (const [name, file] of Object.entries({
  'then a map': Buffer.concat([jpeg({ head: [announce] }), second]), 'then rubbish': Buffer.concat([jpeg({ head: [announce] }), Buffer.from('rubbish')]), 'alone': jpeg({ head: [announce] }),
  'no frame': jpeg({ head: [announce], hasFrame: false }), 'no scan': jpeg({ head: [announce], hasScan: false }), 'no end': jpeg({ head: [announce], end: false }), 'nothing else': Buffer.concat([SOI, announce]),
  'two frames': jpeg({ head: [announce], afterFrame: [frame()] }), 'a bad marker': jpeg({ head: [announce], afterFrame: [jpegSegment(0xc3, Buffer.alloc(4))] }), 'a bad table': jpeg({ head: [announce, jpegSegment(0xdb, Buffer.from([0x40]))] }),
  'scan first': Buffer.concat([SOI, announce, scan(), ENTROPY, frame(), EOI]), 'empty picture data': jpeg({ head: [announce], entropy: Buffer.alloc(0) }), 'a bad scan': jpeg({ head: [announce], scanAt: { extra: Buffer.from([0]) } }),
  'fill bytes': jpeg({ head: [Buffer.from([255]), announce, Buffer.from([255, 255])] }), 'cut in the announcement': Buffer.concat([SOI, announce.subarray(0, announce.length - 3)]),
  'oversize': jpeg({ head: [announce], frameAt: { width: 300, height: 300 } }), 'announced after the frame': jpeg({ afterFrame: [announce] }), 'announced twice': jpeg({ head: [announce, announce] }),
  'a plain segment, then the announcement': jpeg({ head: [jpegSegment(0xe0, Buffer.from('JFIF')), announce] }), 'an unknown marker before the announcement': jpeg({ head: [jpegSegment(0x01, Buffer.alloc(2)), announce] }),
})) honest(`announced gain map: ${name}`, file);

// Fill bytes: 0xFF repeated before a marker is dropped by the sanitiser.
{ const base = jpeg({ tables: [dqt(), dht(), dri()] }); const marks = []; for (let i = 2; i < base.length - 1; i++) if (base[i] === 255 && base[i + 1] !== 0 && base[i + 1] !== 255) marks.push(i);
  for (const at of marks) for (const fill of [1, 2, 7]) honest(`${fill} fill bytes before the marker at ${at}`, Buffer.concat([base.subarray(0, at), Buffer.alloc(fill, 255), base.subarray(at)]));
  honest('fill byte before SOI', Buffer.concat([Buffer.from([255]), base])); honest('fill byte after EOI', Buffer.concat([base, Buffer.from([255])])); }

// Frames.
for (const marker of [0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xde, 0xdf, 0xdc, 0xf0, 0xf7, 0xfd, 0x01, 0x4f, 0xbf, 0xd0, 0xd7, 0xd8, 0x00]) {
  honest(`frame marker ${marker.toString(16)}`, jpeg({ frameAt: { marker } }));
  honest(`segment ${marker.toString(16)} before the frame`, jpeg({ head: [jpegSegment(marker, Buffer.alloc(3))] }));
  honest(`segment ${marker.toString(16)} after the scan`, jpeg({ tail: [jpegSegment(marker, Buffer.alloc(3))] }));
}
for (const [width, height] of [[0, 2], [2, 0], [0, 0], [257, 2], [2, 257], [257, 257], [256, 257], [1000, 1], [4000, 4000], [4001, 4000], [20000, 1], [20001, 1], [1, 20001], [65535, 65535], [512, 2], [2, 258]]) {
  const file = jpeg({ frameAt: { width, height } });
  honest(`frame ${width}x${height}`, file, [width, height]);
  add(`frame ${width}x${height}, described as 2x2`, preview(file, 2, 2));
  add(`frame ${width}x${height}, described within limits`, preview(file, Math.min(Math.max(width, 1), 256), Math.min(Math.max(height, 1), 256)));
}
for (const [width, height] of [[3, 5], [256, 1], [16, 9]]) {
  const file = jpeg({ frameAt: { width, height } });
  for (const [w, h] of [[height, width], [width + 1, height], [width, height + 1], [width - 1 || 2, height], [width, height - 1 || 2], [width + 256, height], [width * 256, height], [width + 0.5, height]]) add(`frame ${width}x${height} described as ${w}x${h}`, preview(file, w, h));
}
for (const settings of [{ precision: 12 }, { precision: 16 }, { precision: 0 }, { precision: 7 }, { components: 0 }, { components: 2 }, { components: 4 }, { components: 255 }, { extra: Buffer.from([0]) }, { extra: Buffer.alloc(3) }]) honest(`frame with ${JSON.stringify(settings)}`, jpeg({ frameAt: settings, scanAt: { components: 1 } }));
for (let n = 0; n <= 16; n++) honest(`frame payload of ${n} bytes`, jpeg({ hasFrame: false, afterFrame: [jpegSegment(0xc0, Buffer.from([8, 0, 2, 0, 2, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0].slice(0, n)))] }));
honest('grey frame cut by one byte', jpeg({ hasFrame: false, afterFrame: [jpegSegment(0xc0, Buffer.from([8, 0, 2, 0, 2, 1, 1, 0x11]))], scanAt: { components: 1 } }));
honest('grey frame, exact', jpeg({ hasFrame: false, afterFrame: [jpegSegment(0xc0, Buffer.from([8, 0, 2, 0, 2, 1, 1, 0x11, 0]))], scanAt: { components: 1 } }));
honest('two frames', jpeg({ afterFrame: [frame()] })); honest('a second frame after the scan', jpeg({ tail: [frame()] })); honest('two frames of different kinds', jpeg({ afterFrame: [frame({ marker: 0xc2 })] }));
honest('no frame', jpeg({ hasFrame: false })); honest('no scan', jpeg({ hasScan: false })); honest('no end', jpeg({ end: false })); honest('no start', jpeg({ soi: false }));
honest('scan before the frame', Buffer.concat([SOI, dqt(), scan(), ENTROPY, frame(), EOI]));
honest('frame only after the first scan', Buffer.concat([SOI, scan(), ENTROPY, frame(), scan(), ENTROPY, EOI]));
// Scans.
for (const settings of [{ components: 0 }, { components: 4 }, { components: 255 }, { extra: Buffer.from([0]) }, { extra: Buffer.alloc(2) }]) honest(`scan with ${JSON.stringify(settings)}`, jpeg({ scanAt: settings }));
for (let n = 0; n <= 11; n++) honest(`scan payload of ${n} bytes`, jpeg({ hasScan: false, tail: [jpegSegment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0].slice(0, n))), ENTROPY] }));
for (const [name, entropy] of Object.entries({ 'empty': [], 'a lone 0xFF': [255], 'data then a lone 0xFF': [1, 255], 'two 0xFF': [255, 255], 'a marker 01': [1, 255, 1, 2], 'a marker c0 cut': [1, 255, 0xc0], 'SOI inside': [1, 255, 0xd8, 2], 'EOI inside': [1, 255, 0xd9, 2], 'EOI inside, twice': [1, 255, 0xd9, 255, 0xd9], 'fill then EOI': [1, 255, 255, 0xd9], 'restart then end': [1, 255, 0xd7], 'd8 at the end': [1, 255, 0xd8], 'a comment inside': [1, 255, 0xfe, 0, 2, 2], 'a comment inside, cut': [1, 255, 0xfe, 0], 'stuffed zero last': [1, 255, 0], 'only restart markers': [255, 0xd0, 255, 0xd1], 'fill then zero then EOI data': [255, 255, 0, 255, 255, 0xd0] }))
  honest(`picture data: ${name}`, jpeg({ entropy: Buffer.from(entropy) }));
// Tables.
for (const [name, payload] of Object.entries({ 'empty DQT': [], 'DQT id only': [0], 'DQT one byte short': [0, ...Array(63).fill(1)], 'DQT one byte long': [0, ...Array(65).fill(1)], 'DQT precision 2': [0x20, ...Array(64).fill(1)], 'DQT id 4': [4, ...Array(64).fill(1)], 'DQT id 15': [0x0f, ...Array(64).fill(1)], '16-bit DQT short': [0x10, ...Array(64).fill(1)], '16-bit DQT exact': [0x13, ...Array(128).fill(1)], '16-bit DQT one long': [0x10, ...Array(129).fill(1)], 'second DQT bad': [0, ...Array(64).fill(1), 0x24, ...Array(64).fill(1)], 'second DQT cut': [0, ...Array(64).fill(1), 1, 2, 3] }))
  honest(`table: ${name}`, jpeg({ tables: [jpegSegment(0xdb, Buffer.from(payload))] }));
for (const [name, payload] of Object.entries({ 'empty DHT': [], 'DHT class only': [0], 'DHT 16 bytes': Array(16).fill(0), 'DHT exact, empty': Array(17).fill(0), 'DHT class 2': [0x20, ...Array(16).fill(0)], 'DHT id 4': [4, ...Array(16).fill(0)], 'DHT symbols missing': [0, 2, ...Array(15).fill(0), 1], 'DHT symbol extra': [0, 1, ...Array(15).fill(0), 1, 2], 'DHT 257 symbols': [0, ...Array(14).fill(0), 2, 255, ...Array(257).fill(7)], 'DHT 256 symbols': [0x13, ...Array(14).fill(0), 1, 255, ...Array(256).fill(7)], 'DHT 255 claimed, none there': [0, 255, ...Array(15).fill(0)], 'second DHT cut': [0, ...Array(16).fill(0), 1, 0, 0] }))
  honest(`table: ${name}`, jpeg({ tables: [jpegSegment(0xc4, Buffer.from(payload))] }));
for (let n = 0; n <= 4; n++) honest(`DRI of ${n} bytes`, jpeg({ tables: [jpegSegment(0xdd, Buffer.alloc(n, 1))] }));
// Segment lengths and ends.
{ const base = jpeg({});
  for (const length of [0, 1, 2, 3, 0x42, 0x44, 0xffff]) { const file = Buffer.from(base); file.writeUInt16BE(length, 4); honest(`first segment length ${length}`, file); }
  for (const more of [[0], [255], [255, 0xd9], [255, 0xd8], [0, 0], [10], [255, 0xfe, 0, 2], [255, 255]]) honest(`after the end: ${JSON.stringify(more)}`, Buffer.concat([base, Buffer.from(more)]));
  honest('two files', Buffer.concat([base, base])); honest('two ends', Buffer.concat([base, EOI])); honest('SOI twice', Buffer.concat([SOI, base]));
  honest('only SOI', SOI); honest('SOI and EOI', Buffer.concat([SOI, EOI])); honest('one byte', Buffer.from([255])); honest('not a JPEG', Buffer.from('notjpeg')); honest('PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); honest('GIF', Buffer.from('GIF89a')); honest('zeros', Buffer.alloc(12)); honest('all 0xFF', Buffer.alloc(12, 255));
  honest('SOI then 0xFF to the end', Buffer.concat([SOI, Buffer.alloc(5, 255)])); honest('SOI, a marker and one byte', Buffer.concat([SOI, Buffer.from([255, 0xdb, 0])])); honest('SOI and a marker', Buffer.concat([SOI, Buffer.from([255, 0xdb])]));
}
// Every prefix of two files, and every suffix dropped from the front.
for (const [name, file] of [['small', jpeg({})], ['Pillow', pillow]]) {
  const step = file.length > 300 ? 3 : 1;
  for (let n = 1; n < file.length; n += step) honest(`${name} file cut to ${n} bytes`, file.subarray(0, n));
  for (let n = 1; n < Math.min(file.length, 12); n++) honest(`${name} file without its first ${n} bytes`, file.subarray(n));
}

// ---- Mutations: bytes flipped, removed and added ----
const LOADED = [0, 1, 2, 3, 8, 0x11, 0x7f, 0x80, 0xc0, 0xc2, 0xc3, 0xc4, 0xd0, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdd, 0xe0, 0xe1, 0xfe, 0xff, 0xff, 0xff];
const someByte = () => below(2) ? pick(LOADED) : below(256);
function mutate(file) {
  const out = Array.from(file), kind = below(10), at = below(out.length);
  if (kind < 4) out[at] = below(3) ? someByte() : out[at] ^ (1 << below(8));
  else if (kind < 6) out.splice(at, 1 + (below(4) === 0 ? below(4) : 0));
  else if (kind < 8) out.splice(at, 0, ...Array.from({ length: 1 + (below(4) === 0 ? below(3) : 0) }, someByte));
  else if (kind === 8) { const other = below(out.length); [out[at], out[other]] = [out[other], out[at]]; }
  else { const length = 1 + below(8); out.splice(below(out.length), 0, ...out.slice(at, at + length)); }
  return Buffer.from(out);
}
let mutants = 0;
for (let round = 0; mutants < 1400 && round < 20000; round++) {
  const source = validFiles[round % validFiles.length], [w, h] = sizeOf(source);
  let file = mutate(source);
  if (below(5) === 0) file = mutate(file);
  if (file.equals(source)) continue;
  // Described either by the size the file had, or by the size the sanitiser reads from it now.
  const size = below(2) ? [w, h] : sizeOf(file) ?? [w, h];
  const before = cases.length;
  add(`mutant ${mutants} of file ${round % validFiles.length}`, preview(file, ...size));
  if (cases.length > before) { if (mutants < 400) addFile(`mutant ${mutants}`, file); mutants++; }
}

writeFileSync(new URL('./vectors/preview.json', import.meta.url), '[\n' + cases.map(c => JSON.stringify(c)).join(',\n') + '\n]\n');
const yes = cases.filter(c => c.valid).length;
console.log('preview.json', cases.length, 'valid', yes, 'refused', cases.length - yes);
writeFileSync(new URL('./vectors/preview-create.json', import.meta.url), '[\n' + files.map(c => JSON.stringify(c)).join(',\n') + '\n]\n');
const kept = files.filter(c => c.same).length, cleaned = files.filter(c => c.base64).length;
console.log('preview-create.json', files.length, 'kept as is', kept, 'cleaned', cleaned, 'refused', files.length - kept - cleaned);
