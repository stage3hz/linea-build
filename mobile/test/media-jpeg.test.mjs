import assert from 'node:assert/strict';
import test from 'node:test';
import {sanitizeJpeg} from '../src/photo/jpeg.ts';
import { jpegFixture,jpegSegment,withJpegMetadata } from './support/jpeg-fixture.mjs';
test('fresh JPEG is stripped of every APP/COM segment with pixels and dimensions retained',()=>{
  const segments=[...Array.from({length:16},(_,i)=>jpegSegment(0xe0+i,Buffer.from(`private EXIF GPS camera ${i}`))),jpegSegment(0xfe,Buffer.from('private comment'))];
  const source=withJpegMetadata(segments),clean=sanitizeJpeg(source);
  assert.equal(clean.width,2);assert.equal(clean.height,2);assert.equal(Buffer.from(clean.bytes).includes(Buffer.from('private')),false);
  assert.deepEqual(sanitizeJpeg(clean.bytes).bytes,clean.bytes);
  const original=jpegFixture(),scan=original.indexOf(Buffer.from([255,218]));
  assert.deepEqual(Buffer.from(clean.bytes).subarray(Buffer.from(clean.bytes).indexOf(Buffer.from([255,218]))),original.subarray(scan));
  assert.ok(source.includes(Buffer.from('private')));
});
test('HDR gainmap and ISO gainmap payloads are rejected rather than silently stripped to SDR',()=>{
  for(const tag of ['hdrgm:Version="1.0"','urn:iso:std:iso:ts:21496:-1','HDRCapacityMax','HDRGainMap'])assert.throws(()=>sanitizeJpeg(withJpegMetadata([jpegSegment(0xe1,Buffer.from(tag))])),/HDR/);
});
test('truncated, concatenated, malformed or oversized JPEG cannot leave the device',()=>{
  const original=jpegFixture();
  for(const bytes of [Buffer.from('notjpeg'),original.subarray(0,15),original.subarray(0,original.length-2),Buffer.concat([original,Buffer.from('private trailer')]),Buffer.concat([original,original])])assert.throws(()=>sanitizeJpeg(bytes),/JPEG|JPG/);
  assert.throws(()=>sanitizeJpeg(Buffer.alloc(20*1024*1024+1)),/20/);
  const broken=withJpegMetadata([jpegSegment(0xe1,Buffer.from('x'))]);broken.writeUInt16BE(65535,4);assert.throws(()=>sanitizeJpeg(broken),/JPEG|длин/);
});
test('unsupported coding modes and deceptive dimensions fail before returning an attachment',()=>{
  const bytes=jpegFixture(),sof=bytes.indexOf(Buffer.from([255,192]));
  const huge=Buffer.from(bytes);huge.writeUInt16BE(20000,sof+5);huge.writeUInt16BE(20000,sof+7);assert.throws(()=>sanitizeJpeg(huge),/размер|пиксел/);
  const lossless=Buffer.from(bytes);lossless[sof+1]=0xc3;assert.throws(()=>sanitizeJpeg(lossless),/JPEG|кодир/);
});
test('late JPEG comments between image scan and end marker are also removed',()=>{
  const base=jpegFixture(),data=Buffer.concat([base.subarray(0,-2),jpegSegment(0xfe,Buffer.from('private late comment')),base.subarray(-2)]);
  assert.equal(Buffer.from(sanitizeJpeg(data).bytes).includes(Buffer.from('private')),false);
});

// These vectors exercise container boundaries; pixel decoding is independently
// checked against the real Pillow fixture, not claimed for synthetic scan bytes.
function structuralJpeg({width=2,height=2,precision=8,components=3,frame=true,scan=true,end=true,entropy=Buffer.from([1]),frameExtra=Buffer.alloc(0),scanComponents=components}={}){
  const frameData=Buffer.alloc(6+components*3);frameData[0]=precision;frameData.writeUInt16BE(height,1);frameData.writeUInt16BE(width,3);frameData[5]=components;
  for(let i=0;i<components;i++){frameData[6+i*3]=i+1;frameData[7+i*3]=0x11;}
  const scanData=Buffer.alloc(1+scanComponents*2+3);scanData[0]=scanComponents;
  for(let i=0;i<scanComponents;i++)scanData[1+i*2]=i+1;scanData[scanData.length-2]=63;
  return Buffer.concat([Buffer.from([255,216]),...(frame?[jpegSegment(0xc0,Buffer.concat([frameData,frameExtra]))]:[]),...(scan?[jpegSegment(0xda,scanData),entropy]:[]),...(end?[Buffer.from([255,217])]:[])]);
}
test('grayscale, precision, component counts and exact frame sizes are checked independently',()=>{
  assert.equal(sanitizeJpeg(structuralJpeg({components:1})).width,2);
  for(const settings of [{precision:16},{components:2},{components:4},{components:0},{frameExtra:Buffer.from([0])}])assert.throws(()=>sanitizeJpeg(structuralJpeg(settings)),/JPEG/);
  assert.throws(()=>sanitizeJpeg(Buffer.concat([Buffer.from([255,216]),jpegSegment(0xc0,Buffer.from([8])),Buffer.from([255,217])])),/JPEG/);
  assert.throws(()=>sanitizeJpeg(structuralJpeg({scanComponents:4})),/JPEG/);
});
test('JPEG dimension and pixel limits accept their exact edges and refuse each excess',()=>{
  for(const [width,height] of [[1,20000],[20000,1],[4000,4000]])assert.equal(sanitizeJpeg(structuralJpeg({width,height})).width,width);
  for(const [width,height] of [[0,1],[1,0],[1,20001],[20001,1],[4001,4000]])assert.throws(()=>sanitizeJpeg(structuralJpeg({width,height})),/размер/);
});
test('escaped entropy bytes and both restart marker boundaries survive unchanged',()=>{
  const entropy=Buffer.from([1,255,0,2,255,0xd0,3,255,0xd7,4]);
  const source=structuralJpeg({entropy});assert.deepEqual(Buffer.from(sanitizeJpeg(source).bytes),source);
  assert.throws(()=>sanitizeJpeg(structuralJpeg({entropy:Buffer.alloc(0)})),/пуст/);
});
test('independently missing JPEG signature, frame, scan or end cannot be accepted',()=>{
  for(const settings of [{frame:false},{scan:false},{end:false}])assert.throws(()=>sanitizeJpeg(structuralJpeg(settings)),/JPEG/);
  for(const position of [0,1]){const bytes=structuralJpeg();bytes[position]=0;assert.throws(()=>sanitizeJpeg(bytes),/сигнатур/);}
  assert.throws(()=>sanitizeJpeg(Buffer.concat([structuralJpeg(),jpegSegment(0xfe)])),/после конца/);
  assert.deepEqual(Buffer.from(sanitizeJpeg(withJpegMetadata([jpegSegment(0xfe)])).bytes),Buffer.from(sanitizeJpeg(jpegFixture()).bytes));
});
test('JPEG segment count and byte limits accept the boundary and reject a single excess',()=>{
  // This structural image has exactly SOF, SOS and EOI: three segments.
  const source=structuralJpeg();
  const padded=count=>Buffer.concat([source.subarray(0,2),...Array.from({length:count},()=>jpegSegment(0xfe)),source.subarray(2)]);
  assert.equal(sanitizeJpeg(padded(4093)).width,2);assert.throws(()=>sanitizeJpeg(padded(4094)),/много сегментов/);
  const max=20*1024*1024,large=structuralJpeg({entropy:Buffer.alloc(max-source.length+1,1)});
  assert.equal(large.length,max);assert.equal(sanitizeJpeg(large).width,2);
});

test('truncated JPEG length headers produce a controlled format error before any out-of-bounds read',()=>{
  for(const bytes of [Buffer.from([255,216,255,225]),Buffer.from([255,216,255,225,0])])assert.throws(()=>sanitizeJpeg(bytes),/JPEG: обрезан заголовок/);
});
