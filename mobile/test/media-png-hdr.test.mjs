import assert from 'node:assert/strict';
import test from 'node:test';
import {sanitizePng,containsHdrPng} from '../src/photo/png.ts';
import {exifIsUpright} from '../src/photo/exifOrientation.ts';
import { pngChunk,pngFixture,readPngChunks } from './support/png-fixture.mjs';
const cicp=(transfer=16)=>pngChunk('cICP',Buffer.from([9,transfer,0,1]));
const mastering=()=>{const data=Buffer.alloc(24);[35400,14600,8500,39850,6550,2300,15635,16450].forEach((value,index)=>data.writeUInt16BE(value,index*2));data.writeUInt32BE(10000000,16);data.writeUInt32BE(5,20);return data;};
const light=()=>{const data=Buffer.alloc(8);data.writeUInt32BE(10000000);data.writeUInt32BE(2500000,4);return data;};
const exif=(orientation=1)=>{const b=Buffer.alloc(26);b.write('II');b.writeUInt16LE(42,2);b.writeUInt32LE(8,4);b.writeUInt16LE(1,8);b.writeUInt16LE(0x112,10);b.writeUInt16LE(3,12);b.writeUInt32LE(1,14);b.writeUInt16LE(orientation,18);return Buffer.concat([b,Buffer.from('private GPS')]);};
const hdrPng=(extra=[],transfer=16)=>pngFixture({before:[cicp(transfer),pngChunk('mDCV',mastering()),pngChunk('cLLI',light()),...extra]});
test('HDR PNG keeps only validated HDR information and identical compressed pixels',()=>{
  const source=hdrPng([pngChunk('eXIf',exif()),pngChunk('tEXt',Buffer.from('Author\0private name'))]);
  const clean=sanitizePng(source),chunks=readPngChunks(clean.bytes);
  assert.equal(clean.hdr,'pq');
  assert.deepEqual(chunks.map(c=>c.type),['IHDR','cICP','mDCV','cLLI','IDAT','IEND']);
  assert.deepEqual(Buffer.from(chunks.find(c=>c.type==='IDAT').data),Buffer.from(readPngChunks(source).find(c=>c.type==='IDAT').data));
  assert.equal(Buffer.from(clean.bytes).includes(Buffer.from('private')),false);
  assert.deepEqual(clean.bytes,sanitizePng(clean.bytes).bytes);
});
test('HLG code points are kept instead of silently becoming an unlabelled SDR image',()=>assert.equal(sanitizePng(hdrPng([],18)).hdr,'hlg'));
test('HDR passthrough cannot discard an orientation that has not been applied to its pixels',()=>{
  for(const orientation of [2,3,4,5,6,7,8])assert.throws(()=>sanitizePng(hdrPng([pngChunk('eXIf',exif(orientation))])),/ориентац|HDR/);
  assert.throws(()=>sanitizePng(hdrPng([pngChunk('eXIf',Buffer.from('unknown orientation'))])),/ориентац|HDR/);
});
test('SDR optional color chunks do not count as permitted HDR metadata',()=>{
  const clean=sanitizePng(pngFixture({before:[cicp(13)]}));
  assert.equal(clean.hdr,undefined);assert.deepEqual(readPngChunks(clean.bytes).map(c=>c.type),['IHDR','IDAT','IEND']);
});
test('HDR color chunks must be unique, correctly sized and before image data',()=>{
  for(const before of [[cicp(),cicp()],[pngChunk('cICP',Buffer.from([9,16,0]))],[cicp(),pngChunk('mDCV',Buffer.alloc(23))],[cicp(),pngChunk('cLLI',Buffer.alloc(7))]])assert.throws(()=>sanitizePng(pngFixture({before})),/HDR|cICP|mDCV|cLLI/);
  assert.throws(()=>sanitizePng(pngFixture({after:[cicp()]})),/HDR|cICP|поряд/);
});
test('HDR static metadata cannot be retained without known HDR code points',()=>{
  assert.throws(()=>sanitizePng(pngFixture({before:[pngChunk('mDCV',mastering())]})),/HDR|cICP/);
});
test('invalid HDR ranges and chromaticities are rejected, not hidden in optional fields',()=>{
  for(const data of [Buffer.from([9,16,1,1]),Buffer.from([9,16,0,2]),Buffer.from([255,16,0,1])])assert.throws(()=>sanitizePng(pngFixture({before:[pngChunk('cICP',data)]})),/HDR|cICP/);
  const invalid=mastering();invalid.writeUInt16BE(65535);assert.throws(()=>sanitizePng(pngFixture({before:[cicp(),pngChunk('mDCV',invalid)]})),/HDR|mDCV/);
  const inverse=mastering();inverse.writeUInt32BE(4,16);assert.throws(()=>sanitizePng(pngFixture({before:[cicp(),pngChunk('mDCV',inverse)]})),/HDR|mDCV/);
  const invalidLight=light();invalidLight.writeUInt32BE(20000000,4);assert.throws(()=>sanitizePng(pngFixture({before:[cicp(),pngChunk('cLLI',invalidLight)]})),/HDR|cLLI/);
});

test('HDR routing hint reads bounded chunks and stops before pixel data',()=>{
  assert.equal(containsHdrPng(Buffer.from('not png')),false);assert.equal(containsHdrPng(pngFixture()),false);
  assert.equal(containsHdrPng(pngFixture({before:[cicp()]})),true);assert.equal(containsHdrPng(pngFixture({before:[cicp(13)]})),false);
  const signature=pngFixture().subarray(0,8);assert.equal(containsHdrPng(signature),false);
  assert.equal(containsHdrPng(Buffer.concat([signature,pngChunk('IEND',Buffer.alloc(0))])),false);
  assert.throws(()=>containsHdrPng(Buffer.concat([signature,...Array.from({length:4097},()=>pngChunk('tEXt',Buffer.alloc(0)))])),/много/);
});

test('EXIF orientation accepts upright little/big-endian data and refuses ambiguous or malformed IFD0',()=>{
  assert.equal(exifIsUpright(exif()),true);
  const be=Buffer.alloc(26);be.write('MM');be.writeUInt16BE(42,2);be.writeUInt32BE(8,4);be.writeUInt16BE(1,8);be.writeUInt16BE(0x112,10);be.writeUInt16BE(3,12);be.writeUInt32BE(1,14);be.writeUInt16BE(1,18);assert.equal(exifIsUpright(be),true);
  const missing=exif();missing.writeUInt16LE(0x100,10);assert.equal(exifIsUpright(missing),true);
  for(const [offset,value,width] of [[0,0x5454,2],[2,43,2],[4,7,4],[4,400,4],[8,513,2],[8,3,2],[12,4,2],[14,2,4],[18,6,2]]){
    const bad=exif();width===2?bad.writeUInt16LE(value,offset):bad.writeUInt32LE(value,offset);assert.equal(exifIsUpright(bad),false);
  }
  assert.equal(exifIsUpright(Buffer.alloc(0)),false);
  const duplicate=Buffer.alloc(38);exif().subarray(0,22).copy(duplicate);duplicate.writeUInt16LE(2,8);exif().subarray(10,22).copy(duplicate,22);assert.equal(exifIsUpright(duplicate),false);
  assert.throws(()=>sanitizePng(hdrPng([pngChunk('eXIf',exif()),pngChunk('eXIf',exif())])),/ориентац|HDR/);
});

test('HDR PNG routing honours its full chunk-count boundary and IDAT stop',()=>{
  const signature=pngFixture().subarray(0,8),text=pngChunk('tEXt',Buffer.alloc(0));
  const boundary=Buffer.concat([signature,...Array.from({length:4095},()=>text),cicp()]);
  assert.equal(containsHdrPng(boundary),true);
  assert.equal(containsHdrPng(Buffer.concat([signature,pngChunk('IDAT',Buffer.from([1])),cicp()])),false);
});
test('HDR mastering coordinates and luminance boundaries cannot conceal invalid values',()=>{
  const clean=data=>sanitizePng(pngFixture({before:[cicp(),pngChunk('mDCV',data)]}));
  for(const [x,y] of [[50000,0],[0,50000],[30000,20000]]){const data=mastering();data.writeUInt16BE(x,0);data.writeUInt16BE(y,2);assert.equal(clean(data).hdr,'pq');}
  const peak=mastering();peak.writeUInt32BE(100000000,16);assert.equal(clean(peak).hdr,'pq');
  for(const [x,y] of [[50001,0],[0,50001],[30000,20001]]){const data=mastering();data.writeUInt16BE(x,0);data.writeUInt16BE(y,2);assert.throws(()=>clean(data),/mDCV/);}
  const equal=mastering();equal.writeUInt32BE(5,16);assert.throws(()=>clean(equal),/mDCV/);
  const clli=(maximum,average)=>{const b=Buffer.alloc(8);b.writeUInt32BE(maximum);b.writeUInt32BE(average,4);return pngFixture({before:[cicp(),pngChunk('cLLI',b)]});};
  assert.equal(sanitizePng(clli(1,1)).hdr,'pq');assert.equal(sanitizePng(clli(0,5)).hdr,'pq');assert.throws(()=>sanitizePng(clli(1,2)),/cLLI/);
});
test('EXIF accepts empty and maximum-size IFD0 and reads a later orientation correctly',()=>{
  const make=count=>{const b=Buffer.alloc(14+count*12);b.write('II');b.writeUInt16LE(42,2);b.writeUInt32LE(8,4);b.writeUInt16LE(count,8);return b;};
  assert.equal(exifIsUpright(make(0)),true);assert.equal(exifIsUpright(make(512)),true);assert.equal(exifIsUpright(make(513)),false);
  const later=make(2);later.writeUInt16LE(0x100,10);exif().subarray(10,22).copy(later,22);later.writeUInt16LE(6,30);assert.equal(exifIsUpright(later),false);
  for(const order of ['IM','MI']){const invalid=make(0);invalid.write(order);assert.equal(exifIsUpright(invalid),false);}
  const thumbnailIfd=Buffer.alloc(280);make(0).copy(thumbnailIfd);thumbnailIfd.writeUInt32LE(274,10);assert.equal(exifIsUpright(thumbnailIfd),true);
  for(const missing of [1,2,3,4])assert.equal(exifIsUpright(make(1).subarray(0,-missing)),false);
});

test('an IFD offset overlapping or just beyond EOF is rejected without reading outside TIFF',()=>{
  for(const offset of [13,14,19,20]){
    const data=Buffer.alloc(14);data.write('II');data.writeUInt16LE(42,2);data.writeUInt32LE(offset,4);assert.equal(exifIsUpright(data),false);
  }
});
