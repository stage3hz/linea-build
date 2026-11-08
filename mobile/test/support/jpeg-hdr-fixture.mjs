// Synthetic Ultra HDR / ISO 21496-1 JPEG built from two real baseline JPEG streams, written independently
// of the production gate (MPF offsets, XMP and ISO bytes are computed here by hand).
import { readFileSync } from 'node:fs';
import { jpegFixture, jpegSegment } from './jpeg-fixture.mjs';

export const SRGB_ICC = readFileSync(new URL('../../modules/linea-photo/android/src/test/resources/srgb-lcms.icc', import.meta.url));
const XMP = 'http://ns.adobe.com/xap/1.0/\0', ISO = 'urn:iso:std:iso:ts:21496:-1\0';

/** Minimal structural JPEG (frame + scan + EOI) of any size; not decodable pixels, only container structure. */
export function structuralJpeg({ width = 2, height = 2, components = 1 } = {}) {
  const frame = Buffer.alloc(6 + components * 3); frame[0] = 8; frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3); frame[5] = components;
  for (let i = 0; i < components; i++) { frame[6 + i * 3] = i + 1; frame[7 + i * 3] = 0x11; }
  const scan = Buffer.alloc(1 + components * 2 + 3); scan[0] = components; for (let i = 0; i < components; i++) scan[1 + i * 2] = i + 1; scan[scan.length - 2] = 63;
  return Buffer.concat([Buffer.from([255, 216]), jpegSegment(0xc0, frame), jpegSegment(0xda, scan), Buffer.from([7, 255, 0, 9]), Buffer.from([255, 217])]);
}

export function exif(orientation = 1) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('private GPS 55.7558N 37.6173E private MakerNote serial 12345', 'latin1')]);
}

export function hdrgmXmp(fields = {}) {
  const values = { GainMapMin: '0', GainMapMax: '2', Gamma: '1', OffsetSDR: '0.015625', OffsetHDR: '0.015625', HDRCapacityMin: '0', HDRCapacityMax: '2', ...fields };
  const attributes = Object.entries(values).filter(([, v]) => v !== null).map(([k, v]) => ` hdrgm:${k}="${v}"`).join('');
  return Buffer.from(`${XMP}<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Private Camera Toolkit"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" hdrgm:Version="1.0"${attributes} xmp:CreatorTool="Pixel 8 Pro private"/></rdf:RDF></x:xmpmeta>`, 'utf8');
}

/** ISO 21496-1 gain-map metadata with a common denominator (64). */
export function isoMetadata({ min = 0, max = 128, gamma = 64, offset = 1, baseHeadroom = 0, altHeadroom = 128, flags = 0x08, denominator = 64 } = {}) {
  const data = Buffer.alloc(4 + 1 + 4 + 8 + 20);
  data.writeUInt16BE(0, 0); data.writeUInt16BE(0, 2); data[4] = flags;
  data.writeUInt32BE(denominator, 5); data.writeUInt32BE(baseHeadroom, 9); data.writeUInt32BE(altHeadroom, 13);
  data.writeInt32BE(min, 17); data.writeInt32BE(max, 21); data.writeUInt32BE(gamma, 25); data.writeInt32BE(offset, 29); data.writeInt32BE(offset, 33);
  return Buffer.concat([Buffer.from(ISO, 'latin1'), data]);
}

function mpfPayload(entries) {
  const count = entries.length, tiff = Buffer.alloc(8 + 2 + 3 * 12 + 4 + count * 16);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(3, 8);
  const entry = (i, tag, type, n, value) => { const at = 10 + i * 12; tiff.writeUInt16LE(tag, at); tiff.writeUInt16LE(type, at + 2); tiff.writeUInt32LE(n, at + 4); if (typeof value === 'string') tiff.write(value, at + 8, 'latin1'); else tiff.writeUInt32LE(value, at + 8); };
  entry(0, 0xb000, 7, 4, '0100'); entry(1, 0xb001, 4, 1, count); entry(2, 0xb002, 7, count * 16, 50);
  entries.forEach((e, i) => { const at = 50 + i * 16; tiff.writeUInt32LE(i ? 0 : 0x030000, at); tiff.writeUInt32LE(e.size, at + 4); tiff.writeUInt32LE(e.offset, at + 8); });
  return Buffer.concat([Buffer.from('MPF\0', 'latin1'), tiff]);
}

const body = jpeg => jpeg.subarray(2);

/**
 * Options: orientation, icc (Buffer|null), mapXmp (Buffer|null), iso (Buffer|null), map (JPEG Buffer),
 * base (JPEG Buffer), preview (extra MPF image), trailer (bytes after the last image), mpf (false: Container only),
 * mpfShift (corrupts the gain-map offset), primaryIso (Buffer|null).
 */
export function ultraHdrFixture(options = {}) {
  const base = options.base ?? jpegFixture(), map = options.map ?? jpegFixture();
  const secondary = Buffer.concat([Buffer.from([255, 216]),
    ...(options.mapXmp === null ? [] : [jpegSegment(0xe1, options.mapXmp ?? hdrgmXmp())]),
    ...(options.iso === null ? [] : [jpegSegment(0xe2, options.iso ?? isoMetadata())]),
    jpegSegment(0xfe, Buffer.from('private map comment')), body(map)]);
  const preview = options.preview ? Buffer.concat([Buffer.from([255, 216]), jpegSegment(0xe1, Buffer.from('Exif\0\0private preview', 'latin1')), body(jpegFixture())]) : null;
  const primaryXmp = Buffer.from(`${XMP}<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" hdrgm:Version="1.0" photoshop:City="private city"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${secondary.length}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`, 'utf8');
  const before = [
    jpegSegment(0xe1, exif(options.orientation ?? 1)), jpegSegment(0xe1, primaryXmp),
    ...(options.icc === null ? [] : [jpegSegment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), options.icc ?? SRGB_ICC]))]),
    ...(options.primaryIso === null ? [] : [jpegSegment(0xe2, options.primaryIso ?? Buffer.from(`${ISO}\0\0\0\0`, 'latin1'))]),
  ];
  const after = [jpegSegment(0xfe, Buffer.from('private comment')), jpegSegment(0xed, Buffer.from('Photoshop 3.0\0private IPTC'))];
  const images = [secondary, ...(preview ? [preview] : [])];
  const head = Buffer.concat([Buffer.from([255, 216]), ...before]);
  const tail = Buffer.concat([...after, body(base)]);
  if (options.mpf === false) return Buffer.concat([head, tail, ...images, options.trailer ?? Buffer.alloc(0)]);
  const placeholder = jpegSegment(0xe2, mpfPayload([{ size: 0, offset: 0 }, ...images.map(() => ({ size: 0, offset: 0 }))]));
  const primaryLength = head.length + placeholder.length + tail.length, tiffStart = head.length + 4 + 4;
  let at = primaryLength;
  const entries = [{ size: primaryLength, offset: 0 }, ...images.map(image => { const e = { size: image.length, offset: at - tiffStart }; at += image.length; return e; })];
  if (options.mpfShift) entries[1].offset += options.mpfShift;
  const mpf = jpegSegment(0xe2, mpfPayload(entries));
  return Buffer.concat([head, mpf, tail, ...images, options.trailer ?? Buffer.alloc(0)]);
}

/** Bytes of the entropy-coded data and tables of a plain stream, from the first DQT/DHT/SOF to EOI. */
export function codingBytes(jpeg) {
  const sos = jpeg.indexOf(Buffer.from([255, 0xda]));
  return jpeg.subarray(sos);
}
