// "Rebuild, don't copy" gate for JPEG with a gain map (Ultra HDR / ISO 21496-1).
//
// Only the compressed data of the two images (tables, frame, scans) is kept. Every metadata segment of the
// source is dropped: EXIF (GPS, MakerNote), JFIF, Adobe, comments, IPTC, foreign XMP, MPF previews, depth maps
// and anything after the last image. The gain-map description is parsed into numbers, validated, and written
// anew: hdrgm XMP (Ultra HDR), ISO 21496-1, MPF and a generated ICC profile. Passthrough is allowed only for
// upright photos (EXIF orientation 1). The output is idempotent: sanitize(sanitize(x)) == sanitize(x).
import {
  GAINMAP_MARKER, SOF, TABLES, checkScan, checkTables, segmentBytes, entropyEnd, isMetadata, joined, readFrame, sanitizeJpeg, segmentAt, type Frame,
} from './jpeg.ts';
import { exifIsUpright } from './exifOrientation.ts';
import { buildIcc, canonicalIcc, parseIcc, type IccNumbers } from './icc.ts';

export type GainmapMetadata = {
  /** log2 of the minimum/maximum boost per channel (1 or 3 values). */
  min: number[]; max: number[]; gamma: number[]; offsetSdr: number[]; offsetHdr: number[];
  /** log2 of the display headroom where the map starts/fully applies. */
  capacityMin: number; capacityMax: number;
  useBaseColorSpace: boolean;
};
export type CleanJpeg = { bytes: Uint8Array; width: number; height: number; hdr?: 'gainmap' };
export type GainmapParts = {
  /** Plain JPEG streams (SOI, tables, frame, scans, EOI) without any metadata. */
  base: Uint8Array; map: Uint8Array; metadata: GainmapMetadata; icc?: IccNumbers;
  width: number; height: number; mapWidth: number; mapHeight: number;
};

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_XMP = 60 * 1024; // A segment holds at most 65533 bytes; real gain-map XMP is a few KB.
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const ISO_ID = 'urn:iso:std:iso:ts:21496:-1\0';
const ICC_ID = 'ICC_PROFILE\0';
const MPF_ID = 'MPF\0';
const DENOMINATOR = 1_000_000;

class GateError extends Error {}
const fail = (reason: string): never => { throw new GateError(`JPEG HDR: ${reason}`); };
const ascii = (value: string) => Uint8Array.from(value, c => c.charCodeAt(0));
const startsWith = (data: Uint8Array, prefix: string) => data.length >= prefix.length && Array.from(prefix).every((c, i) => data[i] === c.charCodeAt(0));
const dv = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const round6 = (value: number) => { const r = Math.round(value * DENOMINATOR) / DENOMINATOR; return Object.is(r, -0) ? 0 : r; };

type Meta = { marker: number; payload: Uint8Array; at: number };
type Stream = { start: number; end: number; frame: Frame; meta: Meta[]; parts: Uint8Array[] };

/** One JPEG codestream from SOI to EOI: metadata separated from coding data. */
function codestream(bytes: Uint8Array, start: number): Stream {
  if (start < 0 || start + 2 > bytes.length || bytes[start] !== 255 || bytes[start + 1] !== 0xd8) fail('нет начальной сигнатуры изображения.');
  const meta: Meta[] = [], parts: Uint8Array[] = [bytes.subarray(start, start + 2)];
  let offset = start + 2, frame: Frame | null = null, scan = false, count = 0;
  for (;;) {
    if (offset >= bytes.length) fail('изображение не завершено.');
    if (++count > 4096) fail('слишком много сегментов.');
    const segment = segmentAt(bytes, offset);
    if (segment.marker === 0xd9) {
      if (!frame || !scan) fail('нет кадра или данных изображения.');
      parts.push(segmentBytes(bytes, segment));
      return { start, end: segment.end, frame: frame!, meta, parts };
    }
    if (isMetadata(segment.marker)) { meta.push({ marker: segment.marker, payload: segment.payload, at: segment.end - segment.payload.length }); offset = segment.end; continue; }
    if (SOF.has(segment.marker)) { if (frame) fail('повторный заголовок кадра.'); frame = readFrame(segment); }
    else if (TABLES.has(segment.marker)) checkTables(segment);
    else if (segment.marker !== 0xda) fail('неподдерживаемый маркер кодирования.');
    parts.push(segmentBytes(bytes, segment));
    if (segment.marker !== 0xda) { offset = segment.end; continue; }
    if (!frame) fail('сканирование до заголовка кадра.');
    checkScan(segment.payload); scan = true;
    const end = entropyEnd(bytes, segment.end);
    if (end === segment.end) fail('пустые данные изображения.');
    parts.push(bytes.subarray(segment.end, end)); offset = end;
  }
}

// ---- MPF ----

type MpEntry = { size: number; offset: number };
function readMpf(payload: Uint8Array): { entries: MpEntry[] } {
  const tiff = payload.subarray(4);
  if (tiff.length < 8) fail('обрезан MPF.');
  const little = tiff[0] === 0x49 && tiff[1] === 0x49, big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) fail('неверный порядок байтов MPF.');
  const view = dv(tiff), u16 = (at: number) => view.getUint16(at, little), u32 = (at: number) => view.getUint32(at, little);
  if (u16(2) !== 42) fail('неверный заголовок MPF.');
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) fail('неверное смещение MPF.');
  const count = u16(ifd);
  if (count > 64 || ifd + 2 + count * 12 + 4 > tiff.length) fail('неверный каталог MPF.');
  let images = -1, entryOffset = -1, entryLength = -1;
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12, tag = u16(at), type = u16(at + 2), length = u32(at + 4);
    if (tag === 0xb001) { if (type !== 4 || length !== 1) fail('неверное число изображений MPF.'); images = u32(at + 8); }
    if (tag === 0xb002) { if (type !== 7) fail('неверный список изображений MPF.'); entryLength = length; entryOffset = length <= 4 ? at + 8 : u32(at + 8); }
  }
  if (images < 2 || images > 8 || entryLength !== images * 16 || entryOffset < 8 || entryOffset + entryLength > tiff.length) fail('неверный список изображений MPF.');
  const entries: MpEntry[] = [];
  for (let i = 0; i < images; i++) { const at = entryOffset + i * 16; entries.push({ size: u32(at + 4), offset: u32(at + 8) }); }
  if (entries[0].offset !== 0) fail('первое изображение MPF не основное.');
  return { entries };
}

function writeMpf(primaryLength: number, secondaryLength: number, secondaryOffset: number): Uint8Array {
  const data = new Uint8Array(4 + 8 + 2 + 3 * 12 + 4 + 32), view = new DataView(data.buffer);
  data.set(ascii(MPF_ID), 0);
  const t = 4; // TIFF header start; offsets inside are relative to it.
  data.set(ascii('MM'), t); view.setUint16(t + 2, 42); view.setUint32(t + 4, 8);
  view.setUint16(t + 8, 3);
  const entry = (index: number, tag: number, type: number, count: number, value: number | number[]) => {
    const at = t + 10 + index * 12; view.setUint16(at, tag); view.setUint16(at + 2, type); view.setUint32(at + 4, count);
    if (Array.isArray(value)) data.set(value, at + 8); else view.setUint32(at + 8, value);
  };
  entry(0, 0xb000, 7, 4, Array.from('0100', c => c.charCodeAt(0)));
  entry(1, 0xb001, 4, 1, 2);
  entry(2, 0xb002, 7, 32, 8 + 2 + 36 + 4);
  view.setUint32(t + 10 + 36, 0); // No next IFD.
  const list = t + 8 + 2 + 36 + 4;
  view.setUint32(list, 0x030000); view.setUint32(list + 4, primaryLength); view.setUint32(list + 8, 0);
  view.setUint32(list + 16, 0); view.setUint32(list + 20, secondaryLength); view.setUint32(list + 24, secondaryOffset);
  return data;
}

// ---- hdrgm XMP ----

const FIELDS = ['Version', 'GainMapMin', 'GainMapMax', 'Gamma', 'OffsetSDR', 'OffsetHDR', 'HDRCapacityMin', 'HDRCapacityMax', 'BaseRenditionIsHDR'] as const;
type Field = typeof FIELDS[number];
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d{1,3})?$/;

function xmpText(payload: Uint8Array): string {
  const body = payload.subarray(XMP_ID.length);
  if (body.length > MAX_XMP) fail('слишком большой XMP.');
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return fail('XMP не в UTF-8.'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) fail('XMP с DTD или сущностями.');
  return value;
}

function hdrgmFields(xmp: string): Map<Field, string[]> {
  const result = new Map<Field, string[]>();
  for (const name of FIELDS) {
    const attributes = [...xmp.matchAll(new RegExp(`\\bhdrgm:${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g'))];
    const elements = [...xmp.matchAll(new RegExp(`<hdrgm:${name}\\s*>([\\s\\S]*?)</hdrgm:${name}\\s*>`, 'g'))];
    if (attributes.length + elements.length > 1) fail(`повторное поле ${name}.`);
    if (attributes.length) result.set(name, [(attributes[0][1] ?? attributes[0][2]).trim()]);
    else if (elements.length) {
      const inner = elements[0][1];
      const items = [...inner.matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)].map(m => m[1].trim());
      result.set(name, items.length ? items : [inner.trim()]);
    }
  }
  return result;
}

function numbers(values: string[] | undefined, fallback: number | null, field: string): number[] {
  if (!values) { if (fallback === null) return fail(`нет поля ${field}.`); return [fallback]; }
  if (values.length !== 1 && values.length !== 3) fail(`неверное число каналов ${field}.`);
  return values.map(value => { if (!NUMBER.test(value)) fail(`неверное число ${field}.`); return Number(value); });
}

function metadataFromXmp(fields: Map<Field, string[]>): GainmapMetadata {
  const version = fields.get('Version');
  if (version && (version.length !== 1 || version[0] !== '1.0')) fail('неизвестная версия hdrgm.');
  const base = fields.get('BaseRenditionIsHDR');
  if (base && (base.length !== 1 || !/^(?:true|false)$/i.test(base[0]))) fail('неверное поле BaseRenditionIsHDR.');
  if (base && /^true$/i.test(base[0])) fail('основное изображение HDR: нужна отдельная обработка.');
  const capacityMin = numbers(fields.get('HDRCapacityMin'), 0, 'HDRCapacityMin'), capacityMax = numbers(fields.get('HDRCapacityMax'), null, 'HDRCapacityMax');
  if (capacityMin.length !== 1 || capacityMax.length !== 1) fail('ёмкость HDR задаётся одним числом.');
  return {
    min: numbers(fields.get('GainMapMin'), 0, 'GainMapMin'), max: numbers(fields.get('GainMapMax'), null, 'GainMapMax'),
    gamma: numbers(fields.get('Gamma'), 1, 'Gamma'), offsetSdr: numbers(fields.get('OffsetSDR'), 1 / 64, 'OffsetSDR'), offsetHdr: numbers(fields.get('OffsetHDR'), 1 / 64, 'OffsetHDR'),
    capacityMin: capacityMin[0], capacityMax: capacityMax[0], useBaseColorSpace: true,
  };
}

// ---- ISO 21496-1 (layout as in libultrahdr gainmapmetadata.cpp) ----

function readIso(payload: Uint8Array): GainmapMetadata | 'version' {
  const data = payload.subarray(ISO_ID.length), view = dv(data);
  if (data.length < 4) fail('обрезаны данные ISO 21496-1.');
  if (view.getUint16(0) !== 0) fail('неподдерживаемая версия ISO 21496-1.');
  if (data.length === 4) return 'version';
  const flags = data[4];
  if (flags & 0x33) fail('неизвестные флаги ISO 21496-1.');
  if (flags & 0x04) fail('основное изображение HDR (обратное направление): нужна отдельная обработка.');
  const channels = flags & 0x80 ? 3 : 1, common = (flags & 0x08) !== 0;
  let at = 5;
  const need = (bytes: number) => { if (at + bytes > data.length) fail('обрезаны данные ISO 21496-1.'); };
  const u32 = () => { need(4); const v = view.getUint32(at); at += 4; return v; };
  const s32 = () => { need(4); const v = view.getInt32(at); at += 4; return v; };
  const ratio = (n: number, d: number) => { if (d === 0) fail('нулевой знаменатель ISO 21496-1.'); return n / d; };
  const metadata: GainmapMetadata = { min: [], max: [], gamma: [], offsetSdr: [], offsetHdr: [], capacityMin: 0, capacityMax: 0, useBaseColorSpace: (flags & 0x40) !== 0 };
  if (common) {
    const d = u32();
    metadata.capacityMin = ratio(u32(), d); metadata.capacityMax = ratio(u32(), d);
    for (let c = 0; c < channels; c++) {
      metadata.min.push(ratio(s32(), d)); metadata.max.push(ratio(s32(), d)); metadata.gamma.push(ratio(u32(), d));
      metadata.offsetSdr.push(ratio(s32(), d)); metadata.offsetHdr.push(ratio(s32(), d));
    }
  } else {
    metadata.capacityMin = ratio(u32(), u32()); metadata.capacityMax = ratio(u32(), u32());
    for (let c = 0; c < channels; c++) {
      metadata.min.push(ratio(s32(), u32())); metadata.max.push(ratio(s32(), u32())); metadata.gamma.push(ratio(u32(), u32()));
      metadata.offsetSdr.push(ratio(s32(), u32())); metadata.offsetHdr.push(ratio(s32(), u32()));
    }
  }
  if (at !== data.length) fail('лишние байты в данных ISO 21496-1.');
  return metadata;
}

function writeIso(metadata: GainmapMetadata | null): Uint8Array {
  if (!metadata) return new Uint8Array([...ascii(ISO_ID), 0, 0, 0, 0]);
  const channels = metadata.min.length, size = 4 + 1 + 16 + channels * 40;
  const data = new Uint8Array(size), view = new DataView(data.buffer);
  data[4] = (channels === 3 ? 0x80 : 0) | (metadata.useBaseColorSpace ? 0x40 : 0);
  let at = 5;
  const u32 = (v: number) => { view.setUint32(at, v); at += 4; }, s32 = (v: number) => { view.setInt32(at, v); at += 4; };
  const n = (v: number) => Math.round(v * DENOMINATOR);
  u32(n(metadata.capacityMin)); u32(DENOMINATOR); u32(n(metadata.capacityMax)); u32(DENOMINATOR);
  for (let c = 0; c < channels; c++) {
    s32(n(metadata.min[c])); u32(DENOMINATOR); s32(n(metadata.max[c])); u32(DENOMINATOR); u32(n(metadata.gamma[c])); u32(DENOMINATOR);
    s32(n(metadata.offsetSdr[c])); u32(DENOMINATOR); s32(n(metadata.offsetHdr[c])); u32(DENOMINATOR);
  }
  return new Uint8Array([...ascii(ISO_ID), ...data]);
}

// ---- Validation and canonical form ----

export function validateGainmap(input: GainmapMetadata): GainmapMetadata {
  const channels = input.min.length;
  const lists = [input.min, input.max, input.gamma, input.offsetSdr, input.offsetHdr];
  if (![1, 3].includes(channels)) fail('неверное число каналов.');
  // Per-channel lists may mix 1 and 3 values (hdrgm allows it): expand to the channel count.
  const expand = (list: number[]) => list.length === channels ? list : list.length === 1 ? Array(channels).fill(list[0]) : fail('неверное число каналов.');
  const width = Math.max(...lists.map(list => list.length));
  if (width === 3 && channels === 1) return validateGainmap({ ...input, min: Array(3).fill(input.min[0]) });
  const [min, max, gamma, offsetSdr, offsetHdr] = lists.map(expand);
  const all = [...min, ...max, ...gamma, ...offsetSdr, ...offsetHdr, input.capacityMin, input.capacityMax];
  if (!all.every(Number.isFinite)) fail('нечисловые параметры карты.');
  if (all.some(value => Math.abs(value) > 16)) fail('параметры карты вне допустимых пределов.');
  for (let c = 0; c < channels; c++) {
    if (max[c] < min[c]) fail('GainMapMax меньше GainMapMin.');
    if (gamma[c] <= 0) fail('Gamma должна быть больше нуля.');
    if (offsetSdr[c] < 0 || offsetHdr[c] < 0 || offsetSdr[c] > 1 || offsetHdr[c] > 1) fail('неверные смещения карты.');
  }
  if (input.capacityMin < 0 || input.capacityMax <= input.capacityMin) fail('неверная ёмкость HDR.');
  const canonical = (list: number[]) => list.map(round6);
  const result = { min: canonical(min), max: canonical(max), gamma: canonical(gamma), offsetSdr: canonical(offsetSdr), offsetHdr: canonical(offsetHdr), capacityMin: round6(input.capacityMin), capacityMax: round6(input.capacityMax), useBaseColorSpace: input.useBaseColorSpace };
  if (result.gamma.some(value => value <= 0) || result.capacityMax <= result.capacityMin) fail('параметры карты вне точности.');
  // Three equal channels are stored as one.
  const stored = [result.min, result.max, result.gamma, result.offsetSdr, result.offsetHdr];
  if (channels === 3 && stored.every(list => list[0] === list[1] && list[1] === list[2])) {
    return { ...result, min: [result.min[0]], max: [result.max[0]], gamma: [result.gamma[0]], offsetSdr: [result.offsetSdr[0]], offsetHdr: [result.offsetHdr[0]] };
  }
  return result;
}

/** Neutral stored map value ("no boost") per channel, 0…255: the decoder uses G' = stored^(1/gamma). */
export function neutralGain(metadata: GainmapMetadata): number[] {
  return metadata.min.map((low, c) => {
    const high = metadata.max[c], gamma = metadata.gamma[c];
    if (!(high - low > 1e-12) || !(gamma > 0)) return 0;
    const share = Math.max(0, Math.min(1, -low / (high - low)));
    return Math.max(0, Math.min(255, Math.round(255 * share ** gamma)));
  });
}

// ---- Writing ----

const fmt = (value: number) => String(round6(value));
function segment(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 2 > 0xffff) fail('слишком большой сегмент.');
  const out = new Uint8Array(payload.length + 4);
  out[0] = 255; out[1] = marker; out[2] = (payload.length + 2) >> 8; out[3] = (payload.length + 2) & 255; out.set(payload, 4);
  return out;
}
const utf8 = (value: string) => new TextEncoder().encode(value);
const RDF = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';

function primaryXmp(mapLength: number): Uint8Array {
  return utf8(`${XMP_ID}<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ${RDF}><rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${mapLength}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`);
}

function mapXmp(m: GainmapMetadata): Uint8Array {
  const single = m.min.length === 1;
  const attributes = single ? ` hdrgm:GainMapMin="${fmt(m.min[0])}" hdrgm:GainMapMax="${fmt(m.max[0])}" hdrgm:Gamma="${fmt(m.gamma[0])}" hdrgm:OffsetSDR="${fmt(m.offsetSdr[0])}" hdrgm:OffsetHDR="${fmt(m.offsetHdr[0])}"` : '';
  const seq = (name: string, list: number[]) => `<hdrgm:${name}><rdf:Seq>${list.map(v => `<rdf:li>${fmt(v)}</rdf:li>`).join('')}</rdf:Seq></hdrgm:${name}>`;
  const elements = single ? '' : seq('GainMapMin', m.min) + seq('GainMapMax', m.max) + seq('Gamma', m.gamma) + seq('OffsetSDR', m.offsetSdr) + seq('OffsetHDR', m.offsetHdr);
  return utf8(`${XMP_ID}<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ${RDF}><rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"${attributes} hdrgm:HDRCapacityMin="${fmt(m.capacityMin)}" hdrgm:HDRCapacityMax="${fmt(m.capacityMax)}" hdrgm:BaseRenditionIsHDR="False">${elements}</rdf:Description></rdf:RDF></x:xmpmeta>`);
}

function iccSegments(icc: IccNumbers | undefined): Uint8Array[] {
  if (!icc) return [];
  const profile = buildIcc(icc), chunk = 65519, count = Math.ceil(profile.length / chunk);
  if (count > 255) fail('слишком большой профиль.');
  return Array.from({ length: count }, (_, i) => segment(0xe2, new Uint8Array([...ascii(ICC_ID), i + 1, count, ...profile.subarray(i * chunk, (i + 1) * chunk)])));
}

/** A plain JPEG stream (only coding data). */
function plain(stream: Stream): Uint8Array { return joined(stream.parts); }

/** Builds the canonical container from two plain JPEG streams and validated numbers. */
export function assembleGainmapJpeg(parts: Pick<GainmapParts, 'base' | 'map' | 'metadata' | 'icc'>): CleanJpeg {
  return guarded(() => {
    const base = codestream(parts.base, 0), map = codestream(parts.map, 0);
    if (base.end !== parts.base.length || map.end !== parts.map.length) fail('данные после конца изображения.');
    checkFrames(base.frame, map.frame);
    const metadata = validateGainmap(parts.metadata), icc = parts.icc ? canonicalIcc(parts.icc) : undefined;
    const secondary = joined([new Uint8Array([255, 0xd8]), segment(0xe1, mapXmp(metadata)), segment(0xe2, writeIso(metadata)), ...map.parts.slice(1)]);
    const head = [new Uint8Array([255, 0xd8]), segment(0xe1, primaryXmp(secondary.length)), ...iccSegments(icc), segment(0xe2, writeIso(null))];
    const headLength = head.reduce((sum, part) => sum + part.length, 0);
    const mpfLength = 4 + writeMpf(0, 0, 0).length;
    const bodyLength = base.parts.slice(1).reduce((sum, part) => sum + part.length, 0);
    const primaryLength = headLength + mpfLength + bodyLength;
    const tiffStart = headLength + 4 + MPF_ID.length;
    const mpf = segment(0xe2, writeMpf(primaryLength, secondary.length, primaryLength - tiffStart));
    const bytes = joined([...head, mpf, ...base.parts.slice(1), secondary]);
    if (bytes.length > MAX_BYTES) fail('файл больше 20 МиБ.');
    return { bytes, width: base.frame.width, height: base.frame.height, hdr: 'gainmap' as const };
  });
}

function checkFrames(base: Frame, map: Frame): void {
  if (map.width > base.width || map.height > base.height) fail('карта больше основного изображения.');
  // Same aspect ratio within one map pixel.
  if (Math.abs(map.width * base.height / base.width - map.height) > 1 + 1e-9) fail('пропорции карты не совпадают с изображением.');
}

function guarded<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof GateError) throw error;
    const message = error instanceof Error ? error.message : '';
    throw new GateError(/^JPEG|^ICC/.test(message) ? `JPEG HDR: ${message}` : 'JPEG HDR: повреждённые данные.');
  }
}

/** Parses and validates a gain-map JPEG into its two plain streams and numbers. Nothing else survives. */
export function splitGainmapJpeg(bytes: Uint8Array): GainmapParts {
  return guarded(() => {
    if (bytes.length > MAX_BYTES) fail('файл больше 20 МиБ.');
    const primary = codestream(bytes, 0);
    let primaryXmpText = '', mpf: Meta | null = null, isoVersion = false;
    const profiles = new Map<number, Uint8Array>(); let profileCount = 0;
    for (const item of primary.meta) {
      if (item.marker === 0xe1 && startsWith(item.payload, 'Exif\0\0')) { if (!exifIsUpright(item.payload.subarray(6))) fail('ориентация не 1: нужен нативный перекод.'); }
      else if (item.marker === 0xe1 && startsWith(item.payload, XMP_ID)) { if (primaryXmpText) fail('повторный XMP.'); primaryXmpText = xmpText(item.payload); }
      else if (item.marker === 0xe2 && startsWith(item.payload, ISO_ID)) { if (readIso(item.payload) !== 'version') fail('метаданные карты в основном изображении.'); isoVersion = true; }
      else if (item.marker === 0xe2 && startsWith(item.payload, MPF_ID)) { if (mpf) fail('повторный MPF.'); mpf = item; }
      else if (item.marker === 0xe2 && startsWith(item.payload, ICC_ID)) {
        if (item.payload.length < 14) fail('обрезан ICC.');
        const order = item.payload[12], count = item.payload[13];
        if (!order || !count || order > count || profiles.has(order) || (profileCount && count !== profileCount)) fail('неверная последовательность ICC.');
        profileCount = count; profiles.set(order, item.payload.subarray(14));
      }
      // Everything else (JFIF, Adobe, IPTC, comments, extended XMP, APP3–15) is dropped.
    }
    // Locate the images that follow the primary one.
    const ranges: { start: number; end: number; stream: Stream }[] = [];
    if (mpf) {
      const tiffStart = mpf.at + MPF_ID.length, { entries } = readMpf(mpf.payload);
      if (entries[0].size !== primary.end) fail('размер основного изображения в MPF не совпадает.');
      for (const entry of entries.slice(1)) {
        const start = tiffStart + entry.offset;
        if (entry.offset === 0 || start < primary.end || start + entry.size > bytes.length) fail('смещение изображения MPF вне файла.');
        const stream = codestream(bytes, start);
        if (stream.end !== start + entry.size) fail('размер изображения MPF не совпадает.');
        ranges.push({ start, end: stream.end, stream });
      }
    } else if (primary.end < bytes.length) {
      const stream = codestream(bytes, primary.end);
      const length = /Item:Semantic="GainMap"[^>]*?Item:Length="(\d+)"|Item:Length="(\d+)"[^>]*?Item:Semantic="GainMap"/.exec(primaryXmpText);
      if (length && Number(length[1] ?? length[2]) !== stream.end - stream.start) fail('Item:Length не совпадает с картой.');
      ranges.push({ start: primary.end, end: stream.end, stream });
    }
    // Every byte belongs to an image: no gaps, overlaps or trailing data.
    ranges.sort((a, b) => a.start - b.start);
    let cursor = primary.end;
    for (const range of ranges) { if (range.start !== cursor) fail('данные между изображениями.'); cursor = range.end; }
    if (cursor !== bytes.length) fail('данные после конца изображения.');
    // Exactly one of them is the gain map; others (previews, depth) are dropped.
    let found: { stream: Stream; metadata: GainmapMetadata } | null = null;
    for (const { stream } of ranges) {
      let xmp = '', iso: GainmapMetadata | null = null;
      for (const item of stream.meta) {
        if (item.marker === 0xe1 && startsWith(item.payload, XMP_ID)) { if (xmp) fail('повторный XMP карты.'); xmp = xmpText(item.payload); }
        if (item.marker === 0xe2 && startsWith(item.payload, ISO_ID)) { const value = readIso(item.payload); if (value !== 'version') { if (iso) fail('повторные данные ISO.'); iso = value; } }
      }
      const fields = xmp ? hdrgmFields(xmp) : new Map<Field, string[]>();
      const isMap = !!iso || fields.has('GainMapMax') || fields.has('HDRCapacityMax');
      if (!isMap) continue;
      if (found) fail('несколько карт яркости.');
      // ISO numbers take precedence over hdrgm (as on Android 15); hdrgm may also sit in the primary XMP.
      found = { stream, metadata: iso ?? metadataFromXmp(fields) };
    }
    if (!found && primaryXmpText) {
      const fields = hdrgmFields(primaryXmpText);
      if ((fields.has('GainMapMax') || fields.has('HDRCapacityMax')) && ranges.length === 1) found = { stream: ranges[0].stream, metadata: metadataFromXmp(fields) };
    }
    if (!found) fail('карта яркости не найдена или её метаданные не распознаны.');
    if (!isoVersion && !primaryXmpText) fail('нет описания карты в основном изображении.');
    const metadata = validateGainmap(found!.metadata);
    checkFrames(primary.frame, found!.stream.frame);
    let icc: IccNumbers | undefined;
    if (profiles.size) {
      if (profiles.size !== profileCount) fail('неполный ICC.');
      const profile = joined(Array.from({ length: profileCount }, (_, i) => profiles.get(i + 1)!));
      icc = canonicalIcc(parseIcc(profile));
    }
    return {
      base: plain(primary), map: plain(found!.stream), metadata, ...(icc ? { icc } : {}),
      width: primary.frame.width, height: primary.frame.height, mapWidth: found!.stream.frame.width, mapHeight: found!.stream.frame.height,
    };
  });
}

export function sanitizeGainmapJpeg(bytes: Uint8Array): CleanJpeg {
  return assembleGainmapJpeg(splitGainmapJpeg(bytes));
}

/** Only the primary (SDR) image of a gain-map JPEG, as a plain stream: used for the small message preview,
 * which is always SDR. Later images (the map, previews) are ignored. */
export function primaryJpeg(bytes: Uint8Array): Uint8Array {
  return guarded(() => plain(codestream(bytes, 0)));
}

/** Does the primary image announce a gain map? (Cheap scan of the metadata before the first scan.) */
export function announcesGainmap(bytes: Uint8Array): boolean {
  if (bytes[0] !== 255 || bytes[1] !== 0xd8) return false;
  let offset = 2;
  try {
    for (let count = 0; count < 4096 && offset < bytes.length; count++) {
      const item = segmentAt(bytes, offset);
      if (item.marker === 0xda || item.marker === 0xd9) return false;
      if (isMetadata(item.marker) && GAINMAP_MARKER.test(new TextDecoder().decode(item.payload))) return true;
      offset = item.end;
    }
  } catch { return false; }
  return false;
}

/** The single entry for photos: strict SDR gate, or the gain-map gate when the file announces a gain map. */
export function sanitizePhotoJpeg(bytes: Uint8Array): CleanJpeg {
  if (announcesGainmap(bytes)) return sanitizeGainmapJpeg(bytes);
  return sanitizeJpeg(bytes);
}
