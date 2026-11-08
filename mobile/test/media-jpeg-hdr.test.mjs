import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
import { jpegFixture } from './support/jpeg-fixture.mjs';
import { ultraHdrFixture, hdrgmXmp, isoMetadata, structuralJpeg, SRGB_ICC, codingBytes } from './support/jpeg-hdr-fixture.mjs';

const gate = loadTs(new URL('../src/photo/jpegHdr.ts', import.meta.url));
const { sanitizeJpeg } = loadTs(new URL('../src/photo/jpeg.ts', import.meta.url));
const icc = loadTs(new URL('../src/photo/icc.ts', import.meta.url));
const PRIVATE = ['private', 'Pixel 8', 'Private Camera', 'lcms', 'APPL', 'No copyright'];
const leaks = bytes => { const data = Buffer.from(bytes); return PRIVATE.filter(word => data.includes(Buffer.from(word, 'latin1')) || data.includes(Buffer.from(word, 'utf16le').swap16())); };

function mpfImages(bytes) {
  const data = Buffer.from(bytes), at = data.indexOf(Buffer.from('MPF\0', 'latin1')), tiff = at + 4;
  const big = data.toString('latin1', tiff, tiff + 2) === 'MM', u32 = o => big ? data.readUInt32BE(tiff + o) : data.readUInt32LE(tiff + o);
  const list = u32(4) + 2 + 3 * 12 + 4;
  return [0, 1].map(i => ({ size: u32(list + i * 16 + 4), offset: u32(list + i * 16 + 8), tiff }));
}

test('Ultra HDR is rebuilt: EXIF/GPS/MakerNote, foreign XMP, IPTC, comments and ICC text are gone; DCT data is identical', () => {
  const source = ultraHdrFixture();
  assert.ok(leaks(source).length >= 4, 'the fixture really carries personal metadata');
  const clean = gate.sanitizePhotoJpeg(source);
  assert.equal(clean.hdr, 'gainmap'); assert.equal(clean.width, 2); assert.equal(clean.height, 2);
  assert.deepEqual(leaks(clean.bytes), []);
  const out = Buffer.from(clean.bytes);
  assert.equal(out.includes(Buffer.from('Exif', 'latin1')), false);
  assert.equal(out.includes(Buffer.from('JFIF', 'latin1')), false);
  assert.equal(out.includes(Buffer.from('photoshop', 'latin1')), false);
  // Both images keep their compressed data byte for byte.
  const parts = gate.splitGainmapJpeg(clean.bytes);
  assert.deepEqual(Buffer.from(codingBytes(Buffer.from(parts.base))), codingBytes(jpegFixture()));
  assert.deepEqual(Buffer.from(codingBytes(Buffer.from(parts.map))), codingBytes(jpegFixture()));
});

test('metadata is regenerated from validated numbers: hdrgm, ISO 21496-1, MPF offsets and a Linea ICC profile', () => {
  const clean = Buffer.from(gate.sanitizePhotoJpeg(ultraHdrFixture()).bytes);
  for (const text of ['hdrgm:GainMapMax="2"', 'hdrgm:HDRCapacityMax="2"', 'hdrgm:OffsetSDR="0.015625"', 'urn:iso:std:iso:ts:21496:-1', 'Item:Semantic="GainMap"'])
    assert.ok(clean.includes(Buffer.from(text, 'latin1')), text);
  const [primary, secondary] = mpfImages(clean);
  assert.equal(primary.offset, 0);
  const start = primary.tiff + secondary.offset;
  assert.equal(start, primary.size, 'the gain map starts right after the primary image');
  assert.equal(start + secondary.size, clean.length);
  assert.deepEqual([clean[start], clean[start + 1]], [255, 0xd8]);
  const length = /Item:Length="(\d+)"/.exec(clean.toString('latin1'))[1];
  assert.equal(Number(length), secondary.size);
  assert.ok(clean.includes(Buffer.from('Linea RGB', 'utf16le').swap16()));
  const parts = gate.splitGainmapJpeg(clean);
  assert.deepEqual(parts.metadata, { min: [0], max: [2], gamma: [1], offsetSdr: [0.015625], offsetHdr: [0.015625], capacityMin: 0, capacityMax: 2, useBaseColorSpace: false });
  assert.equal(parts.icc.curve.kind, 'srgb');
});

test('the gate is idempotent', () => {
  for (const source of [ultraHdrFixture(), ultraHdrFixture({ iso: null, primaryIso: null }), ultraHdrFixture({ mapXmp: null }), ultraHdrFixture({ icc: null }), ultraHdrFixture({ preview: true })]) {
    const once = gate.sanitizePhotoJpeg(source).bytes, twice = gate.sanitizePhotoJpeg(once).bytes;
    assert.deepEqual(Buffer.from(twice), Buffer.from(once));
  }
});

test('hdrgm-only (Android 14) and ISO-only files are both accepted; ISO wins when both are present', () => {
  const hdrgm = gate.splitGainmapJpeg(ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ GainMapMax: '3.5' }) }));
  assert.deepEqual(hdrgm.metadata.max, [3.5]);
  const iso = gate.splitGainmapJpeg(ultraHdrFixture({ mapXmp: null, iso: isoMetadata({ max: 192 }) }));
  assert.deepEqual(iso.metadata.max, [3]);
  const both = gate.splitGainmapJpeg(ultraHdrFixture({ mapXmp: hdrgmXmp({ GainMapMax: '1' }), iso: isoMetadata({ max: 192 }) }));
  assert.deepEqual(both.metadata.max, [3]);
  // Separate denominators (no common-denominator flag, libultrahdr's default writer layout).
  const data = Buffer.alloc(4 + 1 + 16 + 40);
  data[4] = 0; let at = 5;
  for (const [n, d] of [[0, 1], [5, 2]]) { data.writeUInt32BE(n, at); data.writeUInt32BE(d, at + 4); at += 8; }
  for (const [n, d, signed] of [[0, 1, true], [3, 1, true], [1, 1, false], [1, 64, true], [1, 64, true]]) { signed ? data.writeInt32BE(n, at) : data.writeUInt32BE(n, at); data.writeUInt32BE(d, at + 4); at += 8; }
  const separate = gate.splitGainmapJpeg(ultraHdrFixture({ mapXmp: null, iso: Buffer.concat([Buffer.from('urn:iso:std:iso:ts:21496:-1\0', 'latin1'), data]) }));
  assert.deepEqual([separate.metadata.max[0], separate.metadata.capacityMax], [3, 2.5]);
});

test('MPF previews and depth images are dropped, the gain map is kept', () => {
  const source = ultraHdrFixture({ preview: true });
  assert.ok(Buffer.from(source).includes(Buffer.from('private preview')));
  const clean = gate.sanitizePhotoJpeg(source);
  assert.deepEqual(leaks(clean.bytes), []);
  assert.equal(mpfImages(clean.bytes)[1].size + mpfImages(clean.bytes)[0].size, clean.bytes.length);
});

test('the strict SDR gate still refuses gain maps, while the photo gate accepts valid ones', () => {
  assert.throws(() => sanitizeJpeg(ultraHdrFixture()), /HDR/);
  assert.equal(gate.sanitizePhotoJpeg(jpegFixture()).hdr, undefined);
  assert.equal(gate.announcesGainmap(ultraHdrFixture()), true);
  assert.equal(gate.announcesGainmap(jpegFixture()), false);
});

test('refusal set: every broken or unsafe input is rejected with a JPEG HDR error', () => {
  const longXmp = Buffer.concat([hdrgmXmp(), Buffer.alloc(63 * 1024, 32)]);
  const cases = {
    'broken number': ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ GainMapMax: 'abc' }) }),
    'min > max': ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ GainMapMin: '3', GainMapMax: '1' }) }),
    'gamma <= 0': ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ Gamma: '0' }) }),
    'capacity order': ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ HDRCapacityMin: '2', HDRCapacityMax: '1' }) }),
    'huge values': ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ GainMapMax: '99' }) }),
    'negative offset': ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ OffsetSDR: '-1' }) }),
    'HDR base (hdrgm)': ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ BaseRenditionIsHDR: 'True' }) }),
    'missing capacity': ultraHdrFixture({ iso: null, mapXmp: hdrgmXmp({ HDRCapacityMax: null, GainMapMax: null, Gamma: '2' }) }),
    'backward direction': ultraHdrFixture({ mapXmp: null, iso: isoMetadata({ flags: 0x08 | 0x04 }) }),
    'zero denominator': ultraHdrFixture({ mapXmp: null, iso: isoMetadata({ denominator: 0 }) }),
    'unknown ISO flags': ultraHdrFixture({ mapXmp: null, iso: isoMetadata({ flags: 0x08 | 0x01 }) }),
    'ISO length': ultraHdrFixture({ mapXmp: null, iso: Buffer.concat([isoMetadata(), Buffer.from([0])]) }),
    'ISO version': ultraHdrFixture({ primaryIso: Buffer.from('urn:iso:std:iso:ts:21496:-1\0\0\x01\0\0', 'latin1') }),
    'map larger than base': ultraHdrFixture({ map: structuralJpeg({ width: 4, height: 4 }) }),
    'aspect mismatch': ultraHdrFixture({ base: structuralJpeg({ width: 40, height: 20 }), map: structuralJpeg({ width: 20, height: 20 }) }),
    'MPF offset mismatch': ultraHdrFixture({ mpfShift: 3 }),
    'data after EOI': ultraHdrFixture({ trailer: Buffer.from('SEFHprivate trailer') }),
    'Container data after EOI': ultraHdrFixture({ mpf: false, trailer: Buffer.from('x') }),
    'orientation 6': ultraHdrFixture({ orientation: 6 }),
    'unknown ICC': ultraHdrFixture({ icc: Buffer.concat([SRGB_ICC.subarray(0, 16), Buffer.from('GRAY'), SRGB_ICC.subarray(20)]) }),
    'XMP too long': ultraHdrFixture({ iso: null, mapXmp: longXmp }),
    'DTD in XMP': ultraHdrFixture({ iso: null, mapXmp: Buffer.from('http://ns.adobe.com/xap/1.0/\0<!DOCTYPE x [<!ENTITY a "b">]>hdrgm:GainMapMax="2" hdrgm:HDRCapacityMax="2"') }),
    'duplicated field': ultraHdrFixture({ iso: null, mapXmp: Buffer.from('http://ns.adobe.com/xap/1.0/\0<a hdrgm:GainMapMax="2" hdrgm:GainMapMax="3" hdrgm:HDRCapacityMax="2"/>') }),
    'no gain map metadata': ultraHdrFixture({ iso: null, mapXmp: null }),
  };
  for (const [name, bytes] of Object.entries(cases)) assert.throws(() => gate.sanitizePhotoJpeg(bytes), /JPEG HDR/, name);
  assert.throws(() => gate.sanitizePhotoJpeg(Buffer.alloc(20 * 1024 * 1024 + 1)), /20/);
});

test('a JPEG without MPF is found through the Ultra HDR container directory', () => {
  const clean = gate.sanitizePhotoJpeg(ultraHdrFixture({ mpf: false }));
  assert.equal(clean.hdr, 'gainmap'); assert.deepEqual(leaks(clean.bytes), []);
});

test('fuzz: random mutations never crash with a non-gate error and never leak metadata', () => {
  const source = ultraHdrFixture({ preview: true });
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  let accepted = 0;
  for (let round = 0; round < 600; round++) {
    const bytes = Buffer.from(source), edits = 1 + Math.floor(random() * 4);
    for (let i = 0; i < edits; i++) {
      const at = Math.floor(random() * bytes.length), kind = random();
      if (kind < 0.6) bytes[at] = Math.floor(random() * 256);
      else if (kind < 0.8) bytes[at] = bytes[at] ^ (1 << Math.floor(random() * 8));
      else bytes.writeUInt16BE(Math.floor(random() * 65536), Math.min(at, bytes.length - 2));
    }
    const cut = random() < 0.1 ? bytes.subarray(0, Math.floor(random() * bytes.length)) : bytes;
    try {
      const clean = gate.sanitizePhotoJpeg(cut);
      accepted++;
      assert.deepEqual(leaks(clean.bytes).filter(word => word !== 'APPL'), [], `round ${round}`);
      assert.deepEqual(Buffer.from(gate.sanitizePhotoJpeg(clean.bytes).bytes), Buffer.from(clean.bytes), `round ${round} idempotent`);
    } catch (error) {
      assert.ok(error instanceof Error, `round ${round}`);
      assert.match(error.message, /^(JPEG|ICC)/, `round ${round}: ${error.message}`);
    }
  }
  assert.ok(accepted > 0, 'some mutations hit only entropy data and stay valid');
});

test('ICC: real sRGB profile becomes a generated Linea profile without the original texts', () => {
  const numbers = icc.parseIcc(new Uint8Array(SRGB_ICC));
  assert.equal(numbers.curve.kind, 'srgb');
  const built = Buffer.from(icc.buildIcc(icc.canonicalIcc(numbers)));
  assert.equal(built.readUInt32BE(0), built.length);
  assert.ok(built.includes(Buffer.from('Linea RGB', 'utf16le').swap16()));
  for (const word of ['cprt', 'dmnd', 'dmdd', 'lcms', 'APPL']) assert.equal(built.includes(Buffer.from(word, 'latin1')), false, word);
  assert.equal(built.includes(Buffer.from('sRGB built-in', 'utf16le').swap16()), false);
  assert.deepEqual(icc.parseIcc(new Uint8Array(built)), icc.canonicalIcc(numbers));
  assert.deepEqual(Buffer.from(icc.buildIcc(icc.parseIcc(new Uint8Array(built)))), built);
  const hdr = Buffer.from(SRGB_ICC); // A cicp tag with PQ is refused (needs tone mapping, not a passthrough).
  assert.throws(() => icc.parseIcc(new Uint8Array(Buffer.concat([hdr.subarray(0, 36), Buffer.from('xxxx'), hdr.subarray(40)]))), /ICC/);
});

test('neutral gain under pen strokes follows the metadata', () => {
  assert.deepEqual(gate.neutralGain({ min: [0], max: [2], gamma: [1] }), [0]);
  assert.deepEqual(gate.neutralGain({ min: [-1], max: [4], gamma: [1] }), [51]);
  assert.deepEqual(gate.neutralGain({ min: [-1, 0, -1], max: [4, 2, 4], gamma: [1, 1, 2] }), [51, 0, 10]);
});

test('message previews of gain-map thumbnails (Android 14+ image tools) use the SDR base only', () => {
  const preview = loadTs(new URL('../src/media/previewModel.ts', import.meta.url));
  const made = preview.createPreview(new Uint8Array(ultraHdrFixture()));
  const bytes = Buffer.from(made.base64, 'base64');
  assert.equal(made.width, 2);
  for (const word of ['hdrgm', 'urn:iso', 'MPF', 'private', 'Exif']) assert.equal(bytes.includes(Buffer.from(word)), false, word);
  assert.equal(preview.validPreview(made), true);
});

test('vendor text tags in ICC (HP `vued`, Apple `dscm`) do not block HDR', () => {
  const built = Buffer.from(icc.buildIcc(icc.canonicalIcc(icc.parseIcc(new Uint8Array(SRGB_ICC)))));
  for (const tag of ['vued', 'dscm']) {
    const patched = Buffer.from(built); patched.write(tag, 132, 'latin1'); // the first tag (desc) renamed
    assert.equal(icc.parseIcc(new Uint8Array(patched)).curve.kind, 'srgb', tag);
  }
});

test('hardening: fill bytes before markers are not copied and tables must have no trailing bytes', () => {
  const base = jpegFixture(), dqt = base.indexOf(Buffer.from([255, 0xdb]));
  const padded = Buffer.concat([base.subarray(0, dqt), Buffer.from([255, 255, 255]), base.subarray(dqt)]);
  assert.deepEqual(Buffer.from(sanitizeJpeg(padded).bytes), Buffer.from(sanitizeJpeg(base).bytes));
  const length = base.readUInt16BE(dqt + 2), trailing = Buffer.concat([base.subarray(0, dqt + 2 + length), Buffer.from([0x42]), base.subarray(dqt + 2 + length)]);
  trailing.writeUInt16BE(length + 1, dqt + 2);
  assert.throws(() => sanitizeJpeg(trailing), /таблиц/);
  assert.throws(() => gate.sanitizePhotoJpeg(ultraHdrFixture({ base: trailing })), /JPEG HDR/);
  const clean = Buffer.from(gate.sanitizePhotoJpeg(ultraHdrFixture({ base: padded })).bytes);
  assert.equal(clean.includes(Buffer.from([255, 255, 0xdb])), false);
});
