// Streamed metadata cleaning for media of any size (MP4/MOV plain, 64-bit and fragmented; MKV; AVI; GIF).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';
import { atom, full } from './support/mp4-fixture.mjs';
import { GPS, avcSample, be32, be64, bigMp4, fragmentedMp4, mkv, avi, gif, videoTrak, gpsTrak, mvhd, udta, ftyp } from './support/stream-fixtures.mjs';

const stream = loadTs(new URL('../src/media/stream/index.ts', import.meta.url));
const nal = loadTs(new URL('../src/media/stream/nal.ts', import.meta.url));
const MiB = 1024 * 1024, GiB = 1024 * MiB;
const memory = bytes => ({ size: bytes.length, reads: 0, async read(offset, length) { this.reads++; return new Uint8Array(bytes.subarray(offset, offset + length)); } });
async function cleanAll(bytes, kind) {
  const source = memory(bytes), route = stream.planUpload(bytes.subarray(0, 768));
  if (kind) assert.equal(route.kind === 'video' ? route.container : route.kind, kind);
  const plan = await stream.planStreamClean(route, source);
  const parts = [];
  for (let at = 0; at < plan.size; at += 4 * MiB) parts.push(Buffer.from(await stream.readClean(plan, source, at, Math.min(4 * MiB, plan.size - at))));
  return { plan, out: Buffer.concat(parts), source };
}

test('routing is decided by content, not by name: photo/video are cleaned, documents go as they are', () => {
  const r = bytes => { const route = stream.planUpload(Buffer.from(bytes)); return route.kind === 'video' ? `video:${route.container}` : route.kind === 'opaque' ? `opaque:${route.container}` : route.kind; };
  assert.equal(r([0xff, 0xd8, 0xff, 0xe1, 0, 0]), 'photo');
  assert.equal(r([137, 80, 78, 71, 13, 10, 26, 10]), 'photo');
  assert.equal(r(atom('ftyp', Buffer.from('heic'), be32(0), Buffer.from('mif1heic'))), 'photo');
  assert.equal(r(Buffer.from('GIF89a\x02\x00\x02\x00\x80\x00\x00', 'latin1')), 'gif');
  assert.equal(r(ftyp()), 'video:iso');
  assert.equal(r(atom('ftyp', Buffer.from('qt  '), be32(0), Buffer.from('qt  '))), 'video:iso');
  assert.equal(r(Buffer.concat([be32(8), Buffer.from('wide'), be32(100), Buffer.from('mdat')])), 'video:iso', 'old QuickTime without ftyp');
  assert.equal(r(mkv().bytes.subarray(0, 64)), 'video:matroska');
  assert.equal(r(avi().bytes.subarray(0, 64)), 'video:avi');
  const ts = Buffer.alloc(600); ts[0] = ts[188] = ts[376] = 0x47; assert.equal(r(ts), 'video:mpegts');
  assert.equal(r(Buffer.from('%PDF-1.7\n')), 'raw');
  assert.equal(r(Buffer.from([0x50, 0x4b, 3, 4, 0, 0])), 'raw');
});

test('SEI user data is neutralised in place: same sample size, payload size kept, timing SEI and slice untouched', () => {
  const sample = new Uint8Array(avcSample()), before = Buffer.from(sample);
  nal.neutraliseSample(sample, false, 4);
  assert.equal(sample.length, before.length);
  assert.equal(Buffer.from(sample).includes(Buffer.from('GPS-SECRET')), false);
  const seiLength = before.readUInt32BE(0), sei = sample.subarray(4, 4 + seiLength);
  const rbsp = nal.unescapeRbsp(sei.subarray(1));
  assert.equal(rbsp[0], 5); const size = rbsp[1];
  assert.deepEqual([...rbsp.subarray(2 + size, 2 + size + 4)], [6, 2, 0x84, 0x10], 'the recovery point SEI after it still parses at the same place');
  assert.equal(rbsp[2 + size + 4], 0x80);
  assert.deepEqual(Buffer.from(sample.subarray(4 + seiLength)), before.subarray(4 + seiLength), 'slice data unchanged');
});

test('MP4 over 20 MiB: GPS, telemetry track and padding are gone, offsets and video samples intact', async () => {
  const { bytes, video, gps, vOff, gOff } = bigMp4();
  assert.ok(bytes.length > 20 * MiB);
  const { plan, out, source } = await cleanAll(bytes, 'iso');
  assert.equal(out.length, bytes.length, 'same size: chunk offsets stay valid');
  assert.equal(out.includes(Buffer.from('GPS-SECRET')), false);
  assert.equal(out.includes(Buffer.from('48.8577')), false);
  assert.equal(out.includes(Buffer.from('iPhone 15')), false);
  assert.equal(out.includes(Buffer.from('GoPro')), false, 'handler and compressor names');
  assert.equal(out.includes(Buffer.from('alice')), false, 'data reference path');
  assert.equal(out.includes(Buffer.from('MSNV')), false, 'unknown brands');
  for (const [i, at] of vOff.entries()) {
    const clean = out.subarray(at, at + video[i].length), seiEnd = 4 + video[i].readUInt32BE(0);
    assert.deepEqual(clean.subarray(seiEnd), video[i].subarray(seiEnd), 'slice bytes identical');
    assert.equal(clean.subarray(0, 4).readUInt32BE(0), video[i].readUInt32BE(0), 'NAL lengths identical');
  }
  for (const [i, at] of gOff.entries()) assert.ok(out.subarray(at, at + gps[i].length).every(b => b === 0), 'telemetry samples zeroed');
  const moov = out.indexOf('moov') - 4;
  assert.ok(out.indexOf('stco', moov) > 0);
  assert.equal(out.readUInt32BE(out.indexOf('stco', moov) + 12), vOff[0], 'chunk offsets unchanged');
  assert.equal(out.readUInt32BE(out.indexOf('tkhd', moov) + 8), 0, 'track creation date zeroed');
  assert.equal(out.readUInt32BE(out.indexOf('mvhd', moov) + 8), 0, 'movie creation date zeroed');
  assert.equal(out.toString('latin1').match(/trak/g).length, 1, 'only the video track remains a track');
  assert.deepEqual(plan.media, { width: 1920, height: 1080, durationMs: 2000 });
  assert.ok(source.reads < 40, `header scanning reads windows, not the whole file (${source.reads} reads)`);
});

function virtualFile(head, moov, mdatSize, samples) {
  // [head][mdat payload generated from the offset][moov]; nothing GB-sized is allocated.
  const moovAt = head.length + mdatSize, size = moovAt + moov.length;
  const at = offset => offset < head.length ? head[offset] : offset >= moovAt ? moov[offset - moovAt] : (offset * 7 + (offset >>> 13)) & 255;
  return { size, async read(offset, length) {
    const out = new Uint8Array(Math.min(length, size - offset));
    if (offset >= moovAt) { out.set(moov.subarray(offset - moovAt, offset - moovAt + out.length)); return out; }
    for (let i = 0; i < out.length; i++) out[i] = at(offset + i);
    for (const [start, bytes] of samples) { const from = Math.max(start, offset), to = Math.min(start + bytes.length, offset + out.length); for (let k = from; k < to; k++) out[k - offset] = bytes[k - start]; }
    return out;
  } };
}

test('10 GiB virtual MP4 with a 64-bit mdat and co64: offsets past 4 GiB, deterministic stream for resume', async () => {
  const head = Buffer.concat([ftyp(), be32(1), Buffer.from('mdat'), be64(0)]);
  const mdatSize = 10 * GiB, s1 = 5 * GiB + 123, s2 = 9 * GiB + 7, sample = avcSample(), gpsSample = Buffer.from('GPMF ' + GPS);
  head.writeBigUInt64BE(BigInt(mdatSize + 16), head.length - 8); // mdatSize = payload after the 16-byte header
  const g1 = s1 + sample.length + 10;
  const moov = atom('moov', mvhd(), videoTrak([sample.length, sample.length], [s1, s2], { co64: true }), gpsTrak([gpsSample.length], [g1], { co64: true }), udta());
  const samples = [[s1, sample], [s2, sample], [g1, gpsSample]];
  const source = virtualFile(head, moov, mdatSize, samples);
  const route = stream.planUpload(await source.read(0, 768));
  const plan = await stream.planStreamClean(route, source), again = await stream.planStreamClean(route, source);
  assert.equal(plan.size, source.size);
  const read = async (p, offset, length) => Buffer.from(await stream.readClean(p, source, offset, length));
  const chunk = 4 * MiB, around = Math.floor(s1 / chunk) * chunk;
  const a = await read(plan, around, chunk), b = await read(again, around, chunk);
  assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'), 'resume reproduces the same bytes');
  const cleanSample = await read(plan, s1, sample.length);
  assert.equal(cleanSample.includes(Buffer.from('GPS-SECRET')), false);
  assert.deepEqual(cleanSample.subarray(-11), sample.subarray(-11));
  assert.ok((await read(plan, g1, gpsSample.length)).every(x => x === 0), 'telemetry beyond 4 GiB zeroed');
  assert.ok((await read(plan, 6 * GiB, 4096)).every(x => x === 0), 'unreferenced media bytes zeroed');
  const tail = await read(plan, source.size - moov.length, moov.length);
  assert.equal(tail.includes(Buffer.from('GPS-SECRET')), false);
  assert.equal(tail.readUInt32BE(tail.indexOf('co64') + 12), 1, 'co64 high word kept');
  // A sample straddling two upload chunks is cleaned the same way from either side.
  const straddle = s2 - 3, left = await read(plan, straddle - chunk + 10, chunk), right = await read(plan, straddle + 10, chunk);
  const whole = await read(plan, s2, sample.length);
  assert.deepEqual(Buffer.concat([left.subarray(chunk - 10 + 3), right]).subarray(0, sample.length), whole);
});

test('fragmented MP4: telemetry traf and its samples removed, video samples kept', async () => {
  const { bytes, video, gps, videoStart, gpsStart } = fragmentedMp4();
  const { out } = await cleanAll(bytes, 'iso');
  assert.equal(out.length, bytes.length);
  assert.equal(out.includes(Buffer.from('GPS-SECRET')), false);
  assert.ok(out.subarray(gpsStart, gpsStart + gps[0].length).every(b => b === 0));
  const v0 = out.subarray(videoStart, videoStart + video[0].length), seiEnd = 4 + video[0].readUInt32BE(0);
  assert.deepEqual(v0.subarray(seiEnd), video[0].subarray(seiEnd));
  assert.equal(out.toString('latin1').match(/traf/g).length, 1);
});

test('unknown root boxes and vendor trailers are neutralised; a file that is not a container is refused', async () => {
  const { bytes } = bigMp4({ gap: 64 });
  const odd = Buffer.concat([bytes, atom('evil', Buffer.from(GPS)), Buffer.from('INSTA360 trailer ' + GPS)]);
  const { out } = await cleanAll(odd, 'iso');
  assert.equal(out.length, odd.length);
  assert.equal(out.includes(Buffer.from('GPS-SECRET')), false);
  const broken = Buffer.concat([ftyp(), be32(0xffffff), Buffer.from('mdat'), Buffer.alloc(32)]);
  await assert.rejects(stream.planStreamClean(stream.planUpload(broken), memory(broken)), /повреждён/);
});

test('audio-only MP4/M4A (voice messages, music) is not changed', async () => {
  const sizes = [10, 10], offsets = [40, 50];
  const soun = atom('trak', atom('tkhd', Buffer.alloc(84)), atom('mdia', atom('mdhd', Buffer.alloc(24)), atom('hdlr', Buffer.from('\0\0\0\0\0\0\0\0soun\0\0\0\0\0\0\0\0\0\0\0\0\0')), atom('minf', full('smhd', Buffer.alloc(4)))));
  const m4a = Buffer.concat([atom('ftyp', Buffer.from('M4A '), be32(0), Buffer.from('M4A isom')), atom('mdat', Buffer.alloc(20)), atom('moov', mvhd(), soun)]);
  void sizes; void offsets;
  assert.equal(await stream.planStreamClean(stream.planUpload(m4a), memory(m4a)), null);
  assert.equal(await stream.planForUpload(stream.planUpload(m4a), memory(m4a), 'audio/mp4'), null, 'audio only: sent unchanged');
  // An «audio» MP4 whose index cannot be read may still hide a video track: refused, never sent raw because of its MIME type.
  await assert.rejects(stream.planForUpload(stream.planUpload(m4a), memory(Buffer.concat([m4a.subarray(0, 40), Buffer.from('garbage')])), 'audio/mp4'), /метаданные/);
});

test('Matroska: Tags, Attachments, title, apps, date and track names become Void; clusters untouched', async () => {
  const { bytes, block, slice } = mkv();
  const { out } = await cleanAll(bytes, 'matroska');
  assert.ok(out.includes(slice), 'video slice kept while its SEI user data is erased');
  assert.equal(out.includes(Buffer.from([0xbf, 0x84, 1, 2, 3, 4])), false, 'CRC-32 of the changed Tracks master voided');
  assert.equal(out.length, bytes.length);
  for (const secret of ['GPS-SECRET', 'Holiday', 'DJI Mini', 'Lavf60', 'cam of alice', 'cover.jpg']) assert.equal(out.includes(Buffer.from(secret)), false, secret);
  assert.equal(out.toString('latin1').split(block.toString('latin1')).length - 1, 1, 'cluster of unknown size kept');
  assert.ok(out.includes(Buffer.from('V_MPEG4/ISO/AVC')));
});

test('AVI: INFO, IDIT, stream names, vendor lists and JUNK text are blanked; frames kept', async () => {
  const { bytes, scan } = avi();
  const { out } = await cleanAll(bytes, 'avi');
  assert.equal(out.length, bytes.length);
  for (const secret of ['GPS-SECRET', 'Nikon', 'CanonMVI06', '2026', 'serial 1234', 'dashcam', 'driver data']) assert.equal(out.includes(Buffer.from(secret)), false, secret);
  assert.ok(out.includes(scan) && out.includes(Buffer.from('AVI1')), 'JPEG scan data and the AVI1 APP0 kept, EXIF APP1 erased');
  assert.ok(out.includes(Buffer.from('LIST')) && out.includes(Buffer.from('hdrl')) && out.includes(Buffer.from('movi')));
});

test('GIF over 20 MiB: comment, XMP and trailing data zeroed, loop block and frames kept', async () => {
  const { bytes, netscape, frame } = gif({ pad: 21 * MiB });
  assert.ok(bytes.length > 20 * MiB);
  const { out, plan } = await cleanAll(bytes, 'gif');
  assert.equal(out.length, bytes.length);
  assert.equal(out.includes(Buffer.from('GPS-SECRET')), false);
  assert.equal(out.includes(Buffer.from('XMP DataXMP')), false);
  assert.ok(out.includes(netscape) && out.includes(frame));
  assert.deepEqual(plan.media, { width: 2, height: 2 });
});
