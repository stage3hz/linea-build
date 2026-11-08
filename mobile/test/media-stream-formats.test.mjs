// Containers added after the privacy review: MPEG-TS/AVCHD, MPEG-PS, FLV, ASF; SEI/T.35 rules; iPhone-like MOV;
// content sniffing of camera RAW and MOV with leading boxes (the reviewer's probe cases, as assertions).
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
import { atom, full } from './support/mp4-fixture.mjs';
import { GPS, be32, mvhd } from './support/stream-fixtures.mjs';

const stream = loadTs(new URL('../src/media/stream/index.ts', import.meta.url));
const nal = loadTs(new URL('../src/media/stream/nal.ts', import.meta.url));
const mem = b => ({ size: b.length, async read(o, l) { return new Uint8Array(b.subarray(o, o + l)); } });
async function clean(bytes, hint) {
  const route = stream.planUpload(bytes.subarray(0, 768), hint), plan = await stream.planStreamClean(route, mem(bytes));
  return { route, plan, out: plan ? Buffer.from(await stream.readClean(plan, mem(bytes), 0, bytes.length)) : null };
}
const has = (b, s) => b.includes(Buffer.from(s));
const kind = r => r.kind === 'video' || r.kind === 'opaque' ? `${r.kind}:${r.container}` : r.kind;

test('sniffing: MOV after leading boxes, any non-image ftyp, camera RAW signatures', () => {
  const pad = b => Buffer.concat([b, Buffer.alloc(Math.max(0, 800 - b.length))]);
  const rows = [
    [Buffer.concat([atom('free', Buffer.alloc(8)), atom('ftyp', Buffer.from('qt  '), be32(0), Buffer.from('qt  '))]), 'video:iso'],
    [Buffer.concat([atom('skip', Buffer.alloc(8)), atom('moov', Buffer.alloc(8))]), 'video:iso'],
    [Buffer.concat([atom('uuid', Buffer.alloc(16)), atom('ftyp', Buffer.from('isom'), be32(0), Buffer.from('isom'))]), 'video:iso'],
    [atom('ftyp', Buffer.from('mmp4'), be32(0), Buffer.from('mmp4')), 'video:iso'],
    [atom('ftyp', Buffer.from('cmfc'), be32(0), Buffer.from('cmfc')), 'video:iso'],
    [atom('ftyp', Buffer.from('heic'), be32(0), Buffer.from('mif1heic')), 'photo'],
    [Buffer.from([0x49, 0x49, 0x55, 0, 0x18, 0, 0, 0]), 'photo'],
    [Buffer.from('IIRO\x08\x00\x00\x00', 'latin1'), 'photo'],
    [Buffer.from('FUJIFILMCCD-RAW 0201FF383501'), 'photo'],
    [Buffer.from('FOVb\x00\x00\x00\x00', 'latin1'), 'photo'],
    [Buffer.from([0, 0x4d, 0x52, 0x4d, 0, 0, 0, 0]), 'photo'],
    [Buffer.from([0, 0, 1, 0xba, 0x44]), 'video:mpegps'],
    [Buffer.from([0, 0, 1, 0xb3, 0x14]), 'video:mpegvideo'],
    [(() => { const b = Buffer.alloc(192 * 4); for (let i = 0; i < 4; i++) b[i * 192 + 4] = 0x47; return b; })(), 'video:mpegts'],
  ];
  for (const [bytes, expected] of rows) assert.equal(kind(stream.planUpload(pad(bytes))), expected, bytes.subarray(0, 16).toString('hex'));
  const unknown = Buffer.alloc(800, 0x41);
  assert.equal(kind(stream.planUpload(unknown, { name: 'a.mov', mimeType: 'video/quicktime' })), 'opaque:unknown', 'unknown content named as video: ask, never send raw');
  assert.equal(kind(stream.planUpload(unknown, { name: 'DSC.NEF', mimeType: 'application/octet-stream' })), 'photo');
  assert.equal(kind(stream.planUpload(unknown, { name: 'voice.m4a', mimeType: 'audio/mp4' })), 'raw');
  assert.equal(kind(stream.planUpload(unknown, { name: 'notes.txt', mimeType: 'text/plain' })), 'raw');
});

const sei = (type, payload) => Buffer.concat([be32(payload.length + 4), Buffer.from([6, type, payload.length]), payload, Buffer.from([0x80])]);
test('T.35 SEI: HDR10+ and captions kept, any other registered data erased', () => {
  const hdr10 = Buffer.concat([Buffer.from([0xb5, 0, 0x3c, 0, 1]), Buffer.from('HDR10PLUS')]);
  const captions = Buffer.concat([Buffer.from([0xb5, 0, 0x31]), Buffer.from('GA94'), Buffer.from('CC-DATA')]);
  const other = Buffer.concat([Buffer.from([0xb5, 0x12, 0x34]), Buffer.from(GPS)]);
  const sample = Buffer.concat([sei(4, hdr10), sei(4, captions), sei(4, other)]);
  nal.neutraliseSample(sample, false, 4);
  assert.ok(has(sample, 'HDR10PLUS') && has(sample, 'CC-DATA'));
  assert.equal(has(sample, 'GPS-SECRET'), false);
});

test('MPEG-2 user data and JPEG APPn are erased in place', () => {
  const es = Buffer.concat([Buffer.from([0, 0, 1, 0xb3, 1, 2]), Buffer.from([0, 0, 1, 0xb2]), Buffer.from('Camcorder ' + GPS), Buffer.from([0, 0, 1, 0, 9, 9])]);
  const before = es.length; nal.neutraliseMpeg2(es);
  assert.equal(es.length, before); assert.equal(has(es, 'GPS-SECRET'), false); assert.ok(has(es, Buffer.from([0, 0, 1, 0, 9, 9])));
});

// ---- MPEG-TS / AVCHD ----
const PARITY = Buffer.from('RS-PARITY-16BYTE');
function tsPacket(pid, payload, { pusi = false, prefix = false, parity = false } = {}) {
  const body = Buffer.alloc(184, 0xff); payload.copy(body, 0, 0, Math.min(184, payload.length));
  const p = Buffer.concat([Buffer.from([0x47, (pusi ? 0x40 : 0) | (pid >> 8), pid & 255, 0x10]), body]);
  if (parity) return Buffer.concat([p, PARITY]);
  return prefix ? Buffer.concat([Buffer.alloc(4, 0x11), p]) : p;
}
function psi(table, body) { const section = Buffer.concat([Buffer.from([table, 0xb0, body.length + 4]), body, Buffer.alloc(4)]); return Buffer.concat([Buffer.from([0]), section]); }
export function avchd(prefix = false, parity = false) {
  const pat = psi(0, Buffer.from([0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0x00]));
  const es = (type, pid, desc = Buffer.alloc(0)) => Buffer.concat([Buffer.from([type, 0xe0 | (pid >> 8), pid & 255, 0xf0, desc.length]), desc]);
  const pmt = psi(2, Buffer.concat([Buffer.from([0, 1, 0xc1, 0, 0, 0xf0 | 0x10, 0x11, 0xf0, 0]), es(0x1b, 0x1011), es(0x81, 0x1100), es(0x06, 0x1200), es(0x06, 0x1300, Buffer.from([0x05, 4, 0x41, 0x43, 0x2d, 0x33]))]));
  const mdpm = Buffer.concat([Buffer.from('MDPM-UUID-16BYTE'), Buffer.from('date 2026 model HDR-CX ' + GPS + ' '.repeat(120))]);
  const elementary = Buffer.concat([Buffer.from([0, 0, 0, 1, 9, 0xf0]), Buffer.from([0, 0, 1, 6, 5, mdpm.length]), mdpm, Buffer.from([0x80]), Buffer.from([0, 0, 1, 0x65]), Buffer.from('SLICE-DATA-0123')]);
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1]), elementary]);
  const packets = [tsPacket(0, pat, { pusi: true, prefix, parity }), tsPacket(0x100, pmt, { pusi: true, prefix, parity }), tsPacket(0x1f, Buffer.from('SIT ' + GPS), { pusi: true, prefix, parity })];
  for (let i = 0; i < pes.length; i += 184) packets.push(tsPacket(0x1011, pes.subarray(i, i + 184), { pusi: i === 0, prefix, parity }));
  packets.push(tsPacket(0x1100, Buffer.concat([Buffer.from([0, 0, 1, 0xbd, 0, 0, 0x80, 0x80, 0]), Buffer.from('AC3-AUDIO')]), { pusi: true, prefix, parity }));
  packets.push(tsPacket(0x1200, Buffer.from('PRIVATE ' + GPS), { pusi: true, prefix, parity }));
  packets.push(tsPacket(0x1300, Buffer.from('AC3-IN-PRIVATE'), { pusi: true, prefix, parity }));
  return Buffer.concat(packets);
}
for (const prefix of [false, true]) test(`AVCHD ${prefix ? 'M2TS (192-byte packets)' : 'MPEG-TS'}: MDPM SEI across packets, SIT and private PIDs erased, audio kept`, async () => {
  const bytes = avchd(prefix), { route, out } = await clean(bytes);
  assert.equal(kind(route), 'video:mpegts');
  assert.equal(out.length, bytes.length);
  assert.equal(has(out, 'GPS-SECRET'), false);
  assert.equal(has(out, 'HDR-CX'), false);
  assert.ok(has(out, 'SLICE-DATA-0123') && has(out, 'AC3-AUDIO') && has(out, 'AC3-IN-PRIVATE'));
  const size = prefix ? 192 : 188; for (let i = prefix ? 4 : 0; i < out.length; i += size) assert.equal(out[i], 0x47, 'packet structure intact');
});

test('MPEG-TS with 204-byte packets: SEI erased across packets, Reed-Solomon parity left untouched', async () => {
  const bytes = avchd(false, true), { route, out } = await clean(bytes);
  assert.equal(kind(route), 'video:mpegts');
  assert.equal(out.length, bytes.length);
  assert.equal(has(out, 'GPS-SECRET'), false);
  assert.equal(has(out, 'HDR-CX'), false);
  assert.ok(has(out, 'SLICE-DATA-0123') && has(out, 'AC3-AUDIO'));
  for (let i = 0; i < out.length; i += 204) {
    assert.equal(out[i], 0x47, 'packet structure intact');
    assert.deepEqual(out.subarray(i + 188, i + 204), PARITY, 'parity is not stream data: never read, never zeroed');
  }
});

test('MPEG-PS: user data, subpictures and private_stream_2 erased; AC-3 and video kept', async () => {
  const pack = Buffer.from([0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 1, 0x89, 0xc3, 0xf8]);
  const pes = (id, payload) => { const header = Buffer.from([0x80, 0x80, 5, 0x21, 0, 1, 0, 1]); const body = Buffer.concat([header, payload]); const len = Buffer.alloc(2); len.writeUInt16BE(body.length); return Buffer.concat([Buffer.from([0, 0, 1, id]), len, body]); };
  const video = Buffer.concat([Buffer.from([0, 0, 1, 0xb3, 1, 2, 3]), Buffer.from([0, 0, 1, 0xb2]), Buffer.from('Sony ' + GPS), Buffer.from([0, 0, 1, 0]), Buffer.from('PICTURE-DATA')]);
  const nav = Buffer.concat([Buffer.from([0, 0, 1, 0xbf, 0, 20]), Buffer.from(('NAV ' + GPS).slice(0, 20))]);
  const bytes = Buffer.concat([pack, pes(0xe0, video), pes(0xbd, Buffer.concat([Buffer.from([0x80, 1, 0, 1]), Buffer.from('AC3-AUDIO')])), pes(0xbd, Buffer.concat([Buffer.from([0x20]), Buffer.from('SUBPIC ' + GPS)])), nav, Buffer.from([0, 0, 1, 0xb9])]);
  const { route, out } = await clean(bytes);
  assert.equal(kind(route), 'video:mpegps');
  assert.equal(out.length, bytes.length);
  assert.equal(has(out, 'GPS-SECRET'), false);
  assert.ok(has(out, 'PICTURE-DATA') && has(out, 'AC3-AUDIO'));
});

test('FLV: onMetaData strings, dates and custom numbers erased, playback fields and video kept', async () => {
  const str = s => { const b = Buffer.alloc(2); b.writeUInt16BE(s.length); return Buffer.concat([b, Buffer.from(s)]); };
  const num = v => { const b = Buffer.alloc(9); b[0] = 0; b.writeDoubleBE(v, 1); return b; };
  const meta = Buffer.concat([Buffer.from([2]), str('onMetaData'), Buffer.from([8, 0, 0, 0, 4]), str('duration'), num(12.5), str('creationdate'), Buffer.from([2]), str('Mon Jan 01 ' + GPS), str('metadatacreator'), Buffer.from([2]), str('Camtasia Studio'), str('latitude'), num(48.8577), Buffer.from([0, 0, 9])]);
  const tag = (type, data) => { const h = Buffer.alloc(11); h[0] = type; h.writeUIntBE(data.length, 1, 3); const prev = Buffer.alloc(4); prev.writeUInt32BE(data.length + 11); return Buffer.concat([h, data, prev]); };
  const avcC = Buffer.from([1, 100, 0, 40, 0xff, 0xe1, 0, 2, 0x67, 0, 1, 0, 2, 0x68, 0]);
  const frame = Buffer.concat([sei(5, Buffer.concat([Buffer.alloc(16, 1), Buffer.from(GPS)])), be32(4), Buffer.from('IDR!')]);
  const bytes = Buffer.concat([Buffer.from('FLV'), Buffer.from([1, 5, 0, 0, 0, 9, 0, 0, 0, 0]), tag(18, meta), tag(9, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), avcC])), tag(9, Buffer.concat([Buffer.from([0x17, 1, 0, 0, 0]), frame])), tag(8, Buffer.from([0xaf, 1, 9, 9]))]);
  const { route, out } = await clean(bytes);
  assert.equal(kind(route), 'video:flv');
  assert.equal(out.length, bytes.length);
  for (const secret of ['GPS-SECRET', 'Camtasia']) assert.equal(has(out, secret), false, secret);
  assert.ok(has(out, 'onMetaData') && has(out, 'IDR!'));
  assert.equal(out.readDoubleBE(out.indexOf('duration') + 9), 12.5, 'duration kept');
  assert.equal(out.readDoubleBE(out.indexOf('latitude') + 9), 0, 'unknown numbers erased');
});

test('ASF/WMV: content description, extended tags, metadata and creation date erased', async () => {
  const guid = text => { const h = text.replace(/-/g, ''); const b = i => h.slice(i * 2, i * 2 + 2); return Buffer.from([b(3), b(2), b(1), b(0), b(5), b(4), b(7), b(6), ...Array.from({ length: 8 }, (_, i) => b(8 + i))].join(''), 'hex'); };
  const object = (id, data) => { const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(24 + data.length)); return Buffer.concat([guid(id), size, data]); };
  const fileProps = Buffer.alloc(80); fileProps.write('CREATED!', 24);
  const content = object('75B22633-668E-11CF-A6D9-00AA0062CE6C', Buffer.concat([Buffer.from([20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(('T ' + GPS).slice(0, 20))]));
  const metadata = object('C5F8CBEA-5BAF-4877-8467-AA8C44FA4CCA', Buffer.from('META ' + GPS));
  const extension = object('5FBF03B5-A92E-11CF-8EE3-00C00C205365', Buffer.concat([Buffer.alloc(18), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(metadata.length); return b; })(), metadata]));
  const children = Buffer.concat([object('8CABDCA1-A947-11CF-8EE4-00C00C205365', fileProps), content, extension]);
  const header = object('75B22630-668E-11CF-A6D9-00AA0062CE6C', Buffer.concat([Buffer.from([3, 0, 0, 0, 1, 2]), children]));
  const bytes = Buffer.concat([header, object('75B22636-668E-11CF-A6D9-00AA0062CE6C', Buffer.from('PACKET-DATA'))]);
  const { route, out } = await clean(bytes);
  assert.equal(kind(route), 'video:asf');
  for (const secret of ['GPS-SECRET', 'CREATED!', 'META']) assert.equal(has(out, secret), false, secret);
  assert.ok(has(out, 'PACKET-DATA'));
});

test('iPhone-like MOV: hvcC SEI array, mebx metadata track, keys/ilst, appl manufacturer and names erased', async () => {
  const seiPayload = Buffer.concat([Buffer.alloc(16, 0x22), Buffer.from('HEVC-SEI-' + GPS)]);
  const prefixSei = Buffer.concat([Buffer.from([39 << 1, 1, 5, seiPayload.length]), seiPayload, Buffer.from([0x80])]);
  const slice = Buffer.from([0x26, 1, 0xaf, 0x11, 0x22]);
  const sample = Buffer.concat([be32(prefixSei.length), prefixSei, be32(slice.length), slice]);
  const hv = Buffer.alloc(23); hv[0] = 1; hv[21] = 3; hv[22] = 1;
  const configSei = Buffer.concat([Buffer.from([39 << 1, 1, 5, 20]), Buffer.from('HVCC-' + GPS).subarray(0, 20), Buffer.from([0x80])]);
  const arrays = Buffer.concat([Buffer.from([0x80 | 39, 0, 1, 0, configSei.length]), configSei]);
  const visual = Buffer.alloc(78); visual.writeUInt16BE(1, 6); visual.write('appl', 12); visual.writeUInt16BE(1920, 24); visual.writeUInt16BE(1080, 26); visual.writeUInt16BE(1, 40); visual.write('HEVC iPhone 15 Pro Max', 43); visual.writeUInt16BE(24, 74);
  const entry = atom('hvc1', visual, atom('hvcC', hv, arrays));
  const mebx = Buffer.from('mebx location ' + GPS);
  const head = atom('ftyp', Buffer.from('qt  '), be32(0), Buffer.from('qt  '));
  const vOff = head.length + 8, mOff = vOff + sample.length;
  const hdlr = (k, name) => { const b = Buffer.alloc(24); b.write('mhlr', 4); b.write(k, 8); b.write('appl', 12); return atom('hdlr', b, Buffer.from(name)); };
  const tkhd = id => { const b = Buffer.alloc(84); b.writeUInt32BE(id, 12); b.writeUInt32BE(1920 << 16 >>> 0, 76); b.writeUInt32BE(1080 << 16 >>> 0, 80); return atom('tkhd', b); };
  const mdhd = () => { const b = Buffer.alloc(24); b.writeUInt32BE(600, 12); b.writeUInt32BE(600, 16); return atom('mdhd', b); };
  const stbl = (e, size, off) => atom('stbl', full('stsd', Buffer.concat([be32(1), e])), full('stts', be32(1, 1, 600)), full('stsc', be32(1, 1, 1, 1)), full('stsz', be32(0, 1, size)), full('stco', be32(1, off)));
  const video = atom('trak', tkhd(1), atom('mdia', mdhd(), hdlr('vide', 'Core Media Video'), atom('minf', full('vmhd', Buffer.alloc(8)), hdlr('alis', 'Core Media Data Handler'), stbl(entry, sample.length, vOff))), atom('meta', Buffer.from('trak ' + GPS)));
  const meta = atom('trak', tkhd(2), atom('mdia', mdhd(), hdlr('meta', 'Core Media Metadata'), atom('minf', full('nmhd'), stbl(atom('mebx', Buffer.alloc(8)), mebx.length, mOff))));
  const keys = atom('meta', atom('keys', Buffer.from('com.apple.quicktime.location.ISO6709')), atom('ilst', Buffer.from(GPS + ' Apple iPhone')));
  const bytes = Buffer.concat([head, atom('mdat', sample, mebx), atom('moov', mvhd(), video, meta, keys, atom('udta', atom('\xa9xyz', Buffer.from(GPS))))]);
  const { out } = await clean(bytes);
  assert.equal(out.length, bytes.length);
  assert.equal(has(out, GPS.slice(0, 10)), false, 'no GPS anywhere (samples, hvcC, mebx, keys, udta)');
  for (const secret of ['appl', 'iPhone', 'Core Media']) assert.equal(has(out, secret), false, secret);
  assert.ok(out.includes(slice));
});
