import { boxes, fullBox, isoText, isoView, mp4Fail, need, tableCount, zeroBox, type IsoBox } from './mp4Boxes.ts';
import { cleanMediaGaps, sampleRanges, type SampleTable } from './mp4Samples.ts';

type Hdr = 'sdr' | 'pq' | 'hlg';
type Track = SampleTable & {
  kind?: 'vide' | 'soun'; width?: number; height?: number; hdr?: Hdr;
  codec?: string; mediaHeader?: 'vmhd' | 'smhd';
};
type Context = { bytes: Uint8Array; tracks: Track[]; expectedHdr?: Hdr; count: number };
const PRIVATE = new Set(['udta', 'meta', 'ilst', 'uuid', 'free', 'skip', 'wide']);
const CONTAINERS: Record<string, readonly string[]> = {
  moov: ['mvhd', 'trak'], trak: ['tkhd', 'mdia', 'edts'], mdia: ['mdhd', 'hdlr', 'minf'],
  minf: ['vmhd', 'smhd', 'dinf', 'stbl'], dinf: ['dref'], edts: ['elst'],
  stbl: ['stsd', 'stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'sdtp', 'sgpd', 'sbgp', 'stsh'],
};
const REQUIRED: Record<string, readonly string[]> = {
  moov: ['mvhd', 'trak'], trak: ['tkhd', 'mdia'], mdia: ['mdhd', 'hdlr', 'minf'],
  minf: ['dinf', 'stbl'], dinf: ['dref'], edts: ['elst'], stbl: ['stsd', 'stts', 'stsc', 'stsz'],
};
const HEADER_SIZES: Record<string, readonly number[]> = { mvhd: [100, 112], tkhd: [84, 96], mdhd: [24, 36] };
const fail = mp4Fail;

function clearMovieHeader(bytes: Uint8Array, box: IsoBox, version: number): void {
  const extra = version * 12;
  bytes.fill(0, box.data + 26 + extra, box.data + 36 + extra);
  bytes.fill(0, box.data + 72 + extra, box.data + 96 + extra);
}

function clearTrackHeader(bytes: Uint8Array, box: IsoBox, version: number): void {
  bytes.fill(0, box.data + 16 + version * 8, box.data + 20 + version * 8);
  bytes.fill(0, box.data + 24 + version * 12, box.data + 32 + version * 12);
  bytes.fill(0, box.data + 38 + version * 12, box.data + 40 + version * 12);
}

function clearMediaHeader(bytes: Uint8Array, box: IsoBox, version: number): void {
  const language = box.data + 20 + version * 12;
  isoView(bytes).setUint16(language, 0x55c4); // ISO-639 language "und".
  bytes.fill(0, language + 2, box.end);
}

function dates(context: Context, box: IsoBox): void {
  const bytes = context.bytes;
  const version = fullBox(bytes, box, [0, 1], box.type === 'tkhd' ? 7 : 0);
  need(box, HEADER_SIZES[box.type][version], true);
  bytes.fill(0, box.data + 4, box.data + 12 + version * 8);
  const scrub: Record<string, typeof clearMovieHeader> = {
    mvhd: clearMovieHeader, tkhd: clearTrackHeader, mdhd: clearMediaHeader,
  };
  scrub[box.type](bytes, box, version);
}

function handler(context: Context, box: IsoBox, track: Track): void {
  fullBox(context.bytes, box);
  need(box, 24);
  const bytes = context.bytes, kind = isoText(bytes, box.data + 8, box.data + 12);
  if (kind !== 'vide' && kind !== 'soun') return fail('неподдерживаемый или служебный трек.');
  track.kind = kind;
  bytes.fill(0, box.data + 4, box.data + 8);
  bytes.fill(0, box.data + 12, box.end);
}

function dataReferences(context: Context, box: IsoBox): void {
  fullBox(context.bytes, box);
  need(box, 8);
  const bytes = context.bytes, entries = boxes(bytes, box.data + 8, box.end);
  if (isoView(bytes).getUint32(box.data + 4) !== entries.length || entries.length !== 1) fail('неверное число ссылок на данные.');
  const entry = entries[0];
  need(entry, 4, true);
  if (entry.type !== 'url ' || isoView(bytes).getUint32(entry.data) !== 1) fail('внешняя ссылка на медиаданные запрещена.');
}

function colorRange(primaries: number, transfer: number, matrix: number): Hdr {
  if (![1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22].includes(primaries)) fail('неподдерживаемые primaries CICP.');
  if (![0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(matrix)) fail('неподдерживаемая матрица цвета CICP.');
  if (![1, 4, 5, 6, 7, 8, 13, 14, 15, 16, 18].includes(transfer)) fail('неподдерживаемая передаточная функция цвета CICP.');
  const hdr: Hdr = transfer === 16 ? 'pq' : transfer === 18 ? 'hlg' : 'sdr';
  if (hdr !== 'sdr') validateHdrColor(primaries, matrix);
  return hdr;
}

function validateHdrColor(primaries: number, matrix: number): void {
  if (primaries !== 9 || ![9, 10, 14].includes(matrix)) fail('HDR требует согласованного цвета BT.2020.');
}

function assignHdr(context: Context, track: Track, hdr: Hdr): void {
  if (context.expectedHdr && hdr !== context.expectedHdr) fail('HDR не совпадает с проверенным видеопотоком.');
  if (track.hdr && track.hdr !== hdr) fail('противоречивые данные HDR.');
  track.hdr = hdr;
}

function color(context: Context, box: IsoBox, track: Track): void {
  need(box, 10);
  const bytes = context.bytes, view = isoView(bytes), kind = isoText(bytes, box.data, box.data + 4);
  if (kind !== 'nclx' && kind !== 'nclc') fail('неподдерживаемый цветовой профиль MP4.');
  need(box, kind === 'nclx' ? 11 : 10, true);
  if (kind === 'nclx' && (bytes[box.data + 10] & 127) !== 0) fail('неверные зарезервированные биты цвета.');
  const hdr = colorRange(view.getUint16(box.data + 4), view.getUint16(box.data + 6), view.getUint16(box.data + 8));
  assignHdr(context, track, hdr);
}

function contentLight(view: DataView, offset: number): void {
  const maximum = view.getUint16(offset), average = view.getUint16(offset + 2);
  if (maximum !== 0 && average > maximum) fail('некорректные уровни HDR.');
}

function masteringDisplay(view: DataView, offset: number): void {
  for (let index = 0; index < 8; index++) {
    if (view.getUint16(offset + index * 2) > 50000) fail('некорректные координаты цвета HDR.');
  }
  const maximum = view.getUint32(offset + 16), minimum = view.getUint32(offset + 20);
  if (maximum <= minimum || maximum > 100000000) fail('некорректная яркость HDR.');
}

function staticHdr(context: Context, box: IsoBox, track: Track): void {
  const hdr = track.hdr || context.expectedHdr;
  if (!hdr || hdr === 'sdr') fail('статические данные HDR без HDR видеопотока.');
  const isMastering = box.type === 'mdcv';
  need(box, isMastering ? 24 : 4, true);
  const validate = isMastering ? masteringDisplay : contentLight;
  validate(isoView(context.bytes), box.data);
}

type Descriptor = { tag: number; data: number; end: number };
function descriptor(bytes: Uint8Array, offset: number, end: number): Descriptor {
  const tag = bytes[offset++];
  let length = 0, count = 0, byte = 0;
  do {
    if (offset >= end || ++count > 4) fail('обрезан AAC descriptor.');
    byte = bytes[offset++];
    length = length * 128 + (byte & 127);
  } while (byte & 128);
  if (offset + length > end) fail('неверная длина AAC descriptor.');
  return { tag, data: offset, end: offset + length };
}

function aacBaseLength(data: Uint8Array): number {
  const frequencyIndex = ((data[0] & 7) << 1) | (data[1] >> 7);
  if (frequencyIndex === 15) {
    if (data.length < 5) return fail('обрезана явная частота AAC config.');
    const rate = ((data[1] & 127) << 17) | (data[2] << 9) | (data[3] << 1) | (data[4] >> 7);
    if (!rate || rate > 192000) fail('неподдерживаемая частота AAC config.');
    return 5;
  }
  if (frequencyIndex > 12) fail('зарезервированная частота AAC config.');
  return 2;
}

function aacExtension(data: Uint8Array, offset: number): void {
  if (data.length === offset) return;
  // Defined sync extension: SBR explicitly absent. No opaque appended payload.
  const expected = [0x56, 0xe5, 0];
  if (data.length !== offset + expected.length) fail('неизвестное расширение AAC config.');
  if (expected.some((value, index) => data[offset + index] !== value)) fail('неизвестное расширение AAC config.');
}

function aacConfig(bytes: Uint8Array, config: Descriptor): void {
  const data = bytes.subarray(config.data, config.end);
  if (config.tag !== 5 || data.length < 2 || (data[0] >> 3) !== 2) fail('ожидался AAC-LC codec config.');
  const length = aacBaseLength(data), channels = (data[length - 1] >> 3) & 15, flags = data[length - 1] & 7;
  if (![1, 2].includes(channels) || flags !== 0) fail('неподдерживаемые каналы или флаги AAC config.');
  aacExtension(data, length);
}

function decoderConfig(bytes: Uint8Array, item: Descriptor): void {
  if (item.tag !== 4 || item.end - item.data < 13 || bytes[item.data] !== 0x40 || bytes[item.data + 1] !== 0x15) fail('неподдерживаемый AAC decoder descriptor.');
  const config = descriptor(bytes, item.data + 13, item.end);
  if (config.end !== item.end) fail('лишние AAC decoder descriptors.');
  aacConfig(bytes, config);
}

function validateEsRoot(bytes: Uint8Array, root: Descriptor, end: number): void {
  if (root.tag !== 3 || root.end !== end || root.end - root.data < 3 || bytes[root.data + 2] !== 0) fail('внешние или неизвестные ES descriptor flags.');
}

function syncDescriptor(bytes: Uint8Array, offset: number, end: number): void {
  const sync = descriptor(bytes, offset, end);
  if (sync.tag !== 6 || sync.end !== end || sync.end - sync.data !== 1 || bytes[sync.data] !== 2) fail('неподдерживаемый AAC sync descriptor.');
}

function elementaryStream(context: Context, box: IsoBox): void {
  fullBox(context.bytes, box);
  const bytes = context.bytes, root = descriptor(bytes, box.data + 4, box.end);
  validateEsRoot(bytes, root, box.end);
  const decoder = descriptor(bytes, root.data + 3, root.end);
  decoderConfig(bytes, decoder);
  syncDescriptor(bytes, decoder.end, root.end);
}

const CODEC_CONFIG: Record<string, string> = { mp4a: 'esds', avc1: 'avcC', avc3: 'avcC', hvc1: 'hvcC', hev1: 'hvcC' };
const CODEC_EXTRA_SIZES: Record<string, number> = { pasp: 8, clap: 32, btrt: 12, fiel: 2 };

function codecConfiguration(context: Context, box: IsoBox): void {
  if (box.type === 'esds') { elementaryStream(context, box); return; }
  need(box, box.type === 'avcC' ? 7 : 23);
  if (context.bytes[box.data] !== 1) fail('неверный codec config.');
}

function validateCodecChild(entry: IsoBox, box: IsoBox): void {
  const required = CODEC_CONFIG[entry.type];
  if (['avcC', 'hvcC', 'esds'].includes(box.type) && box.type !== required) fail('несогласованный блок кодека.');
  if (entry.type === 'mp4a' && !['esds', 'btrt'].includes(box.type)) fail('неподдерживаемый дополнительный блок аудиокодека.');
}

function codecChild(context: Context, entry: IsoBox, box: IsoBox, track: Track): void {
  validateCodecChild(entry, box);
  if (box.type === 'colr') return; // Parsed first, before static HDR children.
  if (box.type === CODEC_CONFIG[entry.type]) { codecConfiguration(context, box); return; }
  if (box.type === 'mdcv' || box.type === 'clli') { staticHdr(context, box, track); return; }
  const size = CODEC_EXTRA_SIZES[box.type];
  if (size === undefined) fail(`неподдерживаемый блок кодека ${box.type}; HDR не будет удалён молча.`);
  need(box, size, true);
}

function codecChildren(context: Context, entry: IsoBox, offset: number, track: Track): void {
  const children = boxes(context.bytes, offset, entry.end), seen = new Set<string>();
  for (const box of children.filter(item => item.type === 'colr')) color(context, box, track);
  for (const box of children) {
    if (PRIVATE.has(box.type)) { zeroBox(context.bytes, box); continue; }
    if (seen.has(box.type)) fail('повторный блок кодека.');
    seen.add(box.type);
    codecChild(context, entry, box, track);
  }
  if (!seen.has(CODEC_CONFIG[entry.type])) fail('нет обязательного codec config.');
}

function visualEntry(context: Context, entry: IsoBox, track: Track): void {
  need(entry, 78);
  const bytes = context.bytes, view = isoView(bytes);
  track.width = view.getUint16(entry.data + 24); track.height = view.getUint16(entry.data + 26);
  if (!track.width || !track.height || track.width > 16384 || track.height > 16384) fail('неверный размер видеокадра.');
  bytes.fill(0, entry.data + 8, entry.data + 24);
  bytes.fill(0, entry.data + 36, entry.data + 40);
  bytes.fill(0, entry.data + 42, entry.data + 74);
  codecChildren(context, entry, entry.data + 78, track);
}

function audioEntry(context: Context, entry: IsoBox, track: Track): void {
  need(entry, 28);
  if (isoView(context.bytes).getUint16(entry.data + 8) !== 0) fail('неподдерживаемая версия аудиозаписи.');
  context.bytes.fill(0, entry.data + 10, entry.data + 16);
  codecChildren(context, entry, entry.data + 28, track);
}

function sampleDescription(context: Context, box: IsoBox, track: Track): void {
  need(box, 8);
  const bytes = context.bytes, entries = boxes(bytes, box.data + 8, box.end);
  if (isoView(bytes).getUint32(box.data + 4) !== 1 || entries.length !== 1) fail('неподдерживаемое число описаний кодека.');
  const entry = entries[0]; track.codec = entry.type;
  need(entry, 8);
  if (isoView(bytes).getUint16(entry.data + 6) !== 1) fail('неверная ссылка описания кодека.');
  bytes.fill(0, entry.data, entry.data + 6);
  if (['avc1', 'avc3', 'hvc1', 'hev1'].includes(entry.type)) { visualEntry(context, entry, track); return; }
  if (entry.type === 'mp4a') { audioEntry(context, entry, track); return; }
  fail(`неподдерживаемый кодек ${entry.type}.`);
}

function groupDescriptions(bytes: Uint8Array, box: IsoBox, group: string, version: number): void {
  const size = ['roll', 'prol'].includes(group) ? 2 : 1;
  if (version === 0) { tableCount(bytes, box, size, 12); return; }
  if (isoView(bytes).getUint32(box.data + 8) !== size) fail('неподдерживаемая длина sgpd.');
  tableCount(bytes, box, size, version === 2 ? 20 : 16);
}

function sampleGroup(context: Context, box: IsoBox): void {
  need(box, 12);
  const bytes = context.bytes, version = bytes[box.data], group = isoText(bytes, box.data + 4, box.data + 8);
  if (!['roll', 'prol', 'rap ', 'sync'].includes(group)) fail('неподдерживаемая группа образцов.');
  if (box.type === 'sbgp') { tableCount(bytes, box, 8, version === 1 ? 16 : 12); return; }
  groupDescriptions(bytes, box, group, version);
}

const SAMPLE_FIELDS: Record<string, keyof SampleTable> = {
  stsz: 'sizes', stsc: 'runs', stco: 'chunks', co64: 'chunks', stts: 'timing',
  ctts: 'composition', stss: 'sync', sdtp: 'dependencies',
};
const TABLE_VERSIONS: Record<string, readonly number[]> = { sgpd: [0, 1, 2], ctts: [0, 1], sbgp: [0, 1] };
function sampleTable(context: Context, box: IsoBox, track: Track): void {
  fullBox(context.bytes, box, TABLE_VERSIONS[box.type] ?? [0]);
  const field = SAMPLE_FIELDS[box.type];
  if (field) { track[field] = box; return; }
  if (box.type === 'stsd') { sampleDescription(context, box, track); return; }
  if (box.type === 'sgpd' || box.type === 'sbgp') { sampleGroup(context, box); return; }
  tableCount(context.bytes, box, 8); // stsh: shadowed and sync sample pairs.
}

function mediaHeader(context: Context, box: IsoBox, track?: Track): void {
  const video = box.type === 'vmhd';
  fullBox(context.bytes, box, [0], video ? 1 : 0);
  need(box, video ? 12 : 8, true);
  if (!track) return fail('заголовок без медиатрека.');
  track.mediaHeader = video ? 'vmhd' : 'smhd';
}

function leaf(context: Context, box: IsoBox, track?: Track): void {
  if (HEADER_SIZES[box.type]) { dates(context, box); return; }
  if (box.type === 'dref') { dataReferences(context, box); return; }
  if (box.type === 'elst') {
    const version = fullBox(context.bytes, box, [0, 1]);
    tableCount(context.bytes, box, version === 1 ? 20 : 12); return;
  }
  if (box.type === 'vmhd' || box.type === 'smhd') { mediaHeader(context, box, track); return; }
  if (!track) return fail('блок без медиатрека.');
  if (box.type === 'hdlr') handler(context, box, track); else sampleTable(context, box, track);
}

function requiredChildren(parent: string, seen: Set<string>): void {
  for (const type of REQUIRED[parent]) if (!seen.has(type)) fail(`нет обязательного блока ${type} в ${parent}.`);
  if (parent === 'minf' && Number(seen.has('vmhd')) + Number(seen.has('smhd')) !== 1) fail('нет единственного обязательного заголовка media.');
  if (parent === 'stbl' && Number(seen.has('stco')) + Number(seen.has('co64')) !== 1) fail('неполная таблица offsets.');
}

function visit(context: Context, box: IsoBox, track?: Track): void {
  if (box.type === 'trak') {
    if (context.tracks.length >= 2) fail('слишком много медиатреков.');
    const next: Track = {}; context.tracks.push(next); walk(context, box, next); return;
  }
  if (CONTAINERS[box.type]) walk(context, box, track); else leaf(context, box, track);
}

function walk(context: Context, parent: IsoBox, track?: Track): void {
  const seen = new Set<string>();
  for (const box of boxes(context.bytes, parent.data, parent.end)) {
    if (++context.count > 8192) fail('слишком много MP4 блоков.');
    if (PRIVATE.has(box.type)) { zeroBox(context.bytes, box); continue; }
    if (!CONTAINERS[parent.type].includes(box.type)) fail(`неподдерживаемый блок ${box.type} в ${parent.type}.`);
    if (seen.has(box.type) && box.type !== 'trak') fail(`повторный блок ${box.type}.`);
    seen.add(box.type);
    visit(context, box, track);
  }
  requiredChildren(parent.type, seen);
}

function fileType(bytes: Uint8Array, box: IsoBox): void {
  need(box, 8);
  if ((box.end - box.data) % 4) fail('неверный ftyp.');
  const allowed = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'hvc1', 'hev1', 'M4V ', 'qt  ']);
  isoView(bytes).setUint32(box.data + 4, 0);
  for (let offset = box.data; offset < box.end; offset += 4) {
    if (offset === box.data + 4) continue;
    if (!allowed.has(isoText(bytes, offset, offset + 4))) bytes.set([105, 115, 111, 109], offset);
  }
}

function visitRoot(context: Context, box: IsoBox, mdats: IsoBox[]): void {
  if (box.type === 'ftyp') { fileType(context.bytes, box); return; }
  if (box.type === 'moov') { walk(context, box); return; }
  if (box.type === 'mdat') { mdats.push(box); return; }
  fail(`неподдерживаемый MP4 root блок ${box.type}.`);
}

function topLevel(context: Context): IsoBox[] {
  const roots = boxes(context.bytes), mdats: IsoBox[] = [], seen = new Set<string>();
  for (const box of roots) {
    if (PRIVATE.has(box.type)) { zeroBox(context.bytes, box); continue; }
    if (seen.has(box.type) && box.type !== 'mdat') fail('повторный MP4 root блок.');
    seen.add(box.type);
    visitRoot(context, box, mdats);
  }
  if (!seen.has('ftyp') || !seen.has('moov') || !mdats.length) fail('неполный MP4 контейнер.');
  return mdats;
}

function validateTrack(track: Track): void {
  if (!track.kind || track.kind === 'soun' && track.codec !== 'mp4a') fail('неверное описание медиатрека.');
  if (track.mediaHeader !== (track.kind === 'vide' ? 'vmhd' : 'smhd')) fail('несогласованный обязательный заголовок медиатрека.');
}

function videoTrack(tracks: Track[]): Track & { width: number; height: number } {
  const video = tracks.filter(track => track.kind === 'vide');
  if (video.length !== 1 || !video[0].width || !video[0].height) return fail('не найден единственный видеотрек.');
  tracks.forEach(validateTrack);
  return video[0] as Track & { width: number; height: number };
}

/** Runs after native sample/SEI filtering and audio re-encoding, never instead of it. */
export function sanitizeMp4(input: Uint8Array, expectedHdr?: Hdr): { bytes: Uint8Array; width: number; height: number; hdr?: Hdr } {
  if (input.length > 20 * 1024 * 1024) fail('файл больше 20 МиБ.');
  const context: Context = { bytes: new Uint8Array(input), tracks: [], expectedHdr, count: 0 };
  const mdats = topLevel(context), video = videoTrack(context.tracks);
  cleanMediaGaps(context.bytes, mdats, context.tracks.flatMap(track => sampleRanges(context.bytes, track)));
  return { bytes: context.bytes, width: video.width, height: video.height, hdr: video.hdr || expectedHdr };
}
