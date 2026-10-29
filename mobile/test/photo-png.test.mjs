import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { sanitizePng } from '../src/photo/png.ts';
import { pngChunk,pngFixture,pngSignature,readPngChunks } from './support/png-fixture.mjs';

test('PNG export removes EXIF, GPS text, XMP, dates and private ancillary chunks while preserving pixels and alpha',()=>{
  const privateData=Buffer.from('GPS=55.7558; author=private; XMP=camera-serial');
  const metadata=['eXIf','tEXt','iTXt','zTXt','tIME','iCCP','pHYs','gAMA','sRGB','raNd'].map(type=>pngChunk(type,privateData));
  const original=pngFixture({before:metadata.slice(0,5),after:metadata.slice(5)});
  const clean=sanitizePng(original),chunks=readPngChunks(clean.bytes);
  assert.deepEqual(chunks.map(c=>c.type),['IHDR','IDAT','IEND']);
  assert.deepEqual(Buffer.from(clean.removedChunks.join(',')),Buffer.from(metadata.map(m=>m.toString('ascii',4,8)).join(',')));
  assert.equal(Buffer.from(clean.bytes).includes(privateData),false);
  assert.deepEqual(inflateSync(Buffer.concat(chunks.filter(c=>c.type==='IDAT').map(c=>c.data))),Buffer.from([0,20,40,60,127]));
  assert.deepEqual({width:clean.width,height:clean.height,alpha:clean.hasAlpha},{width:1,height:1,alpha:true});
  assert.deepEqual(sanitizePng(clean.bytes).bytes,clean.bytes,'repeated sanitation is byte-identical');
  assert.equal(original.includes(privateData),true,'source bytes remain unchanged');
});

test('indexed transparency and the palette required to decode it survive sanitation',()=>{
  const palette=Buffer.from([255,0,0,0,255,0]),alpha=Buffer.from([0,255]);
  const clean=sanitizePng(pngFixture({color:3,before:[pngChunk('PLTE',palette),pngChunk('tRNS',alpha)],pixels:Buffer.from([0,1])}));
  assert.deepEqual(readPngChunks(clean.bytes).map(c=>c.type),['IHDR','PLTE','tRNS','IDAT','IEND']);
  assert.equal(clean.hasAlpha,true);
});

test('an opaque truecolor PNG remains opaque',()=>{
  assert.equal(sanitizePng(pngFixture({color:2,pixels:Buffer.from([0,1,2,3])})).hasAlpha,false);
});

test('a suggested truecolor palette cannot appear after its transparency chunk',()=>{
  const before=[pngChunk('tRNS',Buffer.alloc(6)),pngChunk('PLTE',Buffer.from([0,0,0]))];
  assert.throws(()=>sanitizePng(pngFixture({color:2,before,pixels:Buffer.from([0,1,2,3])})),/поряд|PLTE/i);
});

test('PNG checksum corruption is rejected even in a metadata chunk that would be removed',()=>{
  const chunk=pngChunk('tEXt',Buffer.from('private'));chunk[chunk.length-1]^=1;
  assert.throws(()=>sanitizePng(pngFixture({before:[chunk]})),/CRC|контроль/i);
});

const invalid=[
  ['wrong signature',()=>Buffer.from('not a png'),/PNG/],
  ['truncated chunk',()=>pngFixture().subarray(0,40),/обрезан|длин/i],
  ['missing IEND',()=>pngFixture({end:false}),/IEND|заверш/i],
  ['trailing data',()=>Buffer.concat([pngFixture(),Buffer.from('private')]),/после|конц/i],
  ['zero width',()=>pngFixture({width:0}),/размер/i],
  ['pixel cap',()=>pngFixture({width:5000,height:5000}),/размер|пиксел/i],
  ['impossible color depth',()=>pngFixture({color:6,depth:1}),/цвет|глубин/i],
  ['unknown critical chunk',()=>pngFixture({before:[pngChunk('ABCD')]}),/обязательн|critical/i],
  ['animated PNG',()=>pngFixture({before:[pngChunk('acTL',Buffer.alloc(8))]}),/анимац|APNG/i],
  ['palette absent',()=>pngFixture({color:3,pixels:Buffer.from([0,0])}),/палитр|PLTE/i],
  ['invalid palette length',()=>pngFixture({color:3,before:[pngChunk('PLTE',Buffer.from([0]))]}),/палитр|PLTE/i],
  ['palette after data',()=>pngFixture({after:[pngChunk('PLTE',Buffer.from([0,0,0]))]}),/поряд|PLTE/i],
  ['duplicate header',()=>pngFixture({before:[pngChunk('IHDR',Buffer.alloc(13))]}),/IHDR|заголов/i],
  ['transparency incompatible with RGBA',()=>pngFixture({before:[pngChunk('tRNS',Buffer.from([0,1]))]}),/прозрач|tRNS/i],
  ['split data sequence',()=>pngFixture({after:[pngChunk('tEXt'),pngChunk('IDAT',Buffer.from([0]))]}),/IDAT|поряд/i],
];
for(const [name,fixture,error] of invalid)test(`sanitation fails closed: ${name}`,()=>assert.throws(()=>sanitizePng(fixture()),error));

test('a chunk with an overflowing declared length never reads beyond the file',()=>{
  const broken=Buffer.concat([pngSignature,Buffer.from([255,255,255,255]),Buffer.from('IHDR'),Buffer.alloc(20)]);
  assert.throws(()=>sanitizePng(broken),/длин|обрезан/i);
});

test('an incomplete chunk header produces a controlled PNG error',()=>{
  for(let length=1;length<12;length++) {
    const broken=Buffer.concat([pngSignature,Buffer.alloc(length)]);
    assert.throws(()=>sanitizePng(broken),error=>!(error instanceof RangeError)&&/обрезан/i.test(error.message));
  }
});

test('a bounded declared chunk length cannot exceed the actual input',()=>{
  const broken=Buffer.concat([pngSignature,Buffer.from([0,0,0,100]),Buffer.from('IHDR'),Buffer.alloc(12)]);
  assert.throws(()=>sanitizePng(broken),error=>!(error instanceof RangeError)&&/длин|обрезан/i.test(error.message));
});

test('a PNG without image data is rejected',()=>{
  const header=readPngChunks(pngFixture())[0].data;
  assert.throws(()=>sanitizePng(Buffer.concat([pngSignature,pngChunk('IHDR',header),pngChunk('IEND')])),/IDAT|данн/i);
});

const pixelFormats=[
  {color:0,depth:1,pixels:[0,128]}, {color:0,depth:2,pixels:[0,128]},
  {color:0,depth:4,pixels:[0,160]}, {color:0,depth:8,pixels:[0,123]},
  {color:0,depth:16,pixels:[0,18,52]}, {color:2,depth:8,pixels:[0,20,40,60]},
  {color:2,depth:16,pixels:[0,18,52,86,120,154,188]},
  {color:3,depth:1,pixels:[0,128]}, {color:3,depth:2,pixels:[0,64]},
  {color:3,depth:4,pixels:[0,16]}, {color:3,depth:8,pixels:[0,1]},
  {color:4,depth:8,pixels:[0,120,127]}, {color:4,depth:16,pixels:[0,18,52,86,120]},
  {color:6,depth:8,pixels:[0,20,40,60,127]}, {color:6,depth:16,pixels:[0,18,52,86,120,154,188,222,240]},
];
for(const format of pixelFormats)test(`supported PNG samples and transparency survive: color ${format.color}, depth ${format.depth}`,()=>{
  const before=format.color===3?[pngChunk('PLTE',Buffer.from([255,0,0,0,255,0])),pngChunk('tRNS',Buffer.from([0,127]))]:[];
  const original=pngFixture({...format,pixels:Buffer.from(format.pixels),before:[...before,pngChunk('tEXt',Buffer.from('Author\0private'))]});
  const clean=sanitizePng(original),chunks=readPngChunks(clean.bytes);
  assert.equal(clean.hasAlpha,[3,4,6].includes(format.color));
  assert.deepEqual(inflateSync(Buffer.concat(chunks.filter(c=>c.type==='IDAT').map(c=>c.data))),Buffer.from(format.pixels));
  for(const type of ['IHDR','PLTE','tRNS'])assert.deepEqual(chunks.filter(c=>c.type===type),readPngChunks(original).filter(c=>c.type===type));
  assert.deepEqual(sanitizePng(clean.bytes).bytes,clean.bytes);
});

test('grayscale and truecolor transparency values survive without a palette',()=>{
  for(const [color,data,pixels] of [[0,[0,123],[0,123]],[2,[0,20,0,40,0,60],[0,20,40,60]]]) {
    const transparency=Buffer.from(data),clean=sanitizePng(pngFixture({color,before:[pngChunk('tRNS',transparency)],pixels:Buffer.from(pixels)}));
    assert.equal(clean.hasAlpha,true);
    assert.deepEqual(readPngChunks(clean.bytes).find(c=>c.type==='tRNS').data,transparency);
  }
});

test('a suggested truecolor palette before transparency is retained in the valid order',()=>{
  const before=[pngChunk('PLTE',Buffer.from([20,40,60])),pngChunk('tRNS',Buffer.from([0,20,0,40,0,60]))];
  const clean=sanitizePng(pngFixture({color:2,before,pixels:Buffer.from([0,20,40,60])}));
  assert.deepEqual(readPngChunks(clean.bytes).map(c=>c.type),['IHDR','PLTE','tRNS','IDAT','IEND']);
  assert.equal(clean.hasAlpha,true);
});

test('indexed transparency may define one alpha while remaining palette entries stay opaque',()=>{
  const palette=Buffer.from([255,0,0,0,255,0]),alpha=Buffer.from([0]),pixels=Buffer.from([0,0,1]);
  const clean=sanitizePng(pngFixture({width:2,color:3,before:[pngChunk('PLTE',palette),pngChunk('tRNS',alpha)],pixels}));
  const chunks=readPngChunks(clean.bytes);
  assert.deepEqual(chunks.find(c=>c.type==='tRNS').data,alpha);
  assert.deepEqual(inflateSync(Buffer.concat(chunks.filter(c=>c.type==='IDAT').map(c=>c.data))),pixels);
  assert.equal(clean.hasAlpha,true);
  assert.deepEqual(sanitizePng(clean.bytes).bytes,clean.bytes);
});

test('consecutive image chunks, including empty IDAT chunks, retain the same pixel stream',()=>{
  const chunks=readPngChunks(pngFixture()),compressed=chunks.find(c=>c.type==='IDAT').data;
  const original=Buffer.concat([pngSignature,pngChunk('IHDR',chunks[0].data),pngChunk('IDAT'),pngChunk('IDAT',compressed.subarray(0,1)),pngChunk('IDAT',compressed.subarray(1)),pngChunk('IDAT'),pngChunk('IEND')]);
  const clean=sanitizePng(original);
  assert.deepEqual(Buffer.from(clean.bytes),original);
  assert.deepEqual(inflateSync(Buffer.concat(readPngChunks(clean.bytes).filter(c=>c.type==='IDAT').map(c=>c.data))),Buffer.from([0,20,40,60,127]));
});

test('byte offsets and independent output buffers prevent leaking surrounding memory',()=>{
  const original=pngFixture(),container=Buffer.concat([Buffer.from('private-prefix'),original,Buffer.from('private-suffix')]);
  const view=new Uint8Array(container.buffer,container.byteOffset+14,original.length),clean=sanitizePng(view);
  assert.deepEqual(Buffer.from(clean.bytes),original);
  clean.bytes[0]=0;
  assert.equal(view[0],137,'output must not alias source memory');
  assert.equal(container.includes(Buffer.from('private-prefix')),true,'unrelated source bytes are unchanged');
});

const malformedChunks=[
  ['IDAT before IHDR',()=>Buffer.concat([pngSignature,pngChunk('IDAT',Buffer.from([0])),pngChunk('IEND')]),/IHDR|перв/i],
  ['short IHDR',()=>Buffer.concat([pngSignature,pngChunk('IHDR',Buffer.alloc(12)),pngChunk('IEND')]),/IHDR|заголов/i],
  ['oversized IHDR',()=>Buffer.concat([pngSignature,pngChunk('IHDR',Buffer.alloc(14)),pngChunk('IEND')]),/IHDR|заголов/i],
  ['illegal chunk name',()=>pngFixture({before:[pngChunk('t1Xt')]}),/тип.*PNG/i],
  ['reserved lowercase chunk bit',()=>pngFixture({before:[pngChunk('text')]}),/тип.*PNG/i],
  ['duplicate PLTE',()=>pngFixture({color:3,before:[pngChunk('PLTE',Buffer.from([0,0,0])),pngChunk('PLTE',Buffer.from([0,0,0]))],pixels:Buffer.from([0,0])}),/поряд|PLTE/i],
  ['palette for grayscale',()=>pngFixture({color:0,before:[pngChunk('PLTE',Buffer.from([0,0,0]))],pixels:Buffer.from([0,0])}),/PLTE|серого/i],
  ['too many palette entries',()=>pngFixture({color:3,before:[pngChunk('PLTE',Buffer.alloc(771))],pixels:Buffer.from([0,0])}),/PLTE|палитр/i],
  ['empty optional truecolor palette',()=>pngFixture({color:2,before:[pngChunk('PLTE')],pixels:Buffer.from([0,20,40,60])}),/PLTE|палитр/i],
  ['oversized optional truecolor palette',()=>pngFixture({color:2,before:[pngChunk('PLTE',Buffer.alloc(771))],pixels:Buffer.from([0,20,40,60])}),/PLTE|палитр/i],
  ['palette exceeds bit depth',()=>pngFixture({color:3,depth:1,before:[pngChunk('PLTE',Buffer.alloc(9))],pixels:Buffer.from([0,0])}),/PLTE|глубин/i],
  ['duplicate transparency',()=>pngFixture({color:0,before:[pngChunk('tRNS',Buffer.alloc(2)),pngChunk('tRNS',Buffer.alloc(2))],pixels:Buffer.from([0,0])}),/поряд|tRNS/i],
  ['late transparency',()=>pngFixture({color:0,after:[pngChunk('tRNS',Buffer.alloc(2))],pixels:Buffer.from([0,0])}),/поряд|tRNS/i],
  ['bad grayscale transparency length',()=>pngFixture({color:0,before:[pngChunk('tRNS',Buffer.alloc(1))],pixels:Buffer.from([0,0])}),/tRNS|прозрач/i],
  ['bad RGB transparency length',()=>pngFixture({color:2,before:[pngChunk('tRNS',Buffer.alloc(5))],pixels:Buffer.from([0,0,0,0])}),/tRNS|прозрач/i],
  ['indexed transparency exceeds palette',()=>pngFixture({color:3,before:[pngChunk('PLTE',Buffer.alloc(3)),pngChunk('tRNS',Buffer.alloc(2))],pixels:Buffer.from([0,0])}),/tRNS|прозрач/i],
  ['empty indexed transparency',()=>pngFixture({color:3,before:[pngChunk('PLTE',Buffer.alloc(3)),pngChunk('tRNS')],pixels:Buffer.from([0,0])}),/tRNS|прозрач/i],
  ['frame control without animation header',()=>pngFixture({before:[pngChunk('fcTL',Buffer.alloc(26))]}),/APNG|анимац/i],
  ['frame data without animation header',()=>pngFixture({after:[pngChunk('fdAT',Buffer.alloc(4))]}),/APNG|анимац/i],
  ['unexpected IEND payload',()=>Buffer.concat([pngFixture({end:false}),pngChunk('IEND',Buffer.from([0]))]),/IEND|заверш/i],
  ['only empty IDAT',()=>Buffer.concat([pngSignature,pngChunk('IHDR',readPngChunks(pngFixture())[0].data),pngChunk('IDAT'),pngChunk('IEND')]),/IDAT|данн/i],
];
for(const [name,fixture,error] of malformedChunks)test(`invalid PNG structure is rejected: ${name}`,()=>assert.throws(()=>sanitizePng(fixture()),error));

test('unsupported header algorithms and color types are rejected',()=>{
  const chunks=readPngChunks(pngFixture());
  for(const [offset,value] of [[9,1],[9,5],[10,1],[11,1],[12,2]]) {
    const header=Buffer.from(chunks[0].data);header[offset]=value;
    assert.throws(()=>sanitizePng(Buffer.concat([pngSignature,pngChunk('IHDR',header),...chunks.slice(1).map(c=>pngChunk(c.type,c.data))])),/цвет|глубин|кодирован/i);
  }
});

test('the defined Adam7 interlace flag is retained for a one-pixel image',()=>{
  const chunks=readPngChunks(pngFixture()),header=Buffer.from(chunks[0].data);header[12]=1;
  const original=Buffer.concat([pngSignature,pngChunk('IHDR',header),...chunks.slice(1).map(c=>pngChunk(c.type,c.data))]);
  assert.deepEqual(Buffer.from(sanitizePng(original).bytes),original);
});

test('the maximum palette and matching transparency table remain valid',()=>{
  const palette=Buffer.alloc(768);palette[767]=255;
  const alpha=Buffer.alloc(256,255);alpha[255]=127;
  const clean=sanitizePng(pngFixture({color:3,before:[pngChunk('PLTE',palette),pngChunk('tRNS',alpha)],pixels:Buffer.from([0,255])}));
  assert.deepEqual(readPngChunks(clean.bytes).filter(c=>['PLTE','tRNS'].includes(c.type)).map(c=>c.data),[palette,alpha]);
  assert.equal(clean.hasAlpha,true);
});

test('PNG dimension and pixel caps accept their boundaries and reject excess',()=>{
  for(const [width,height] of [[20000,1],[1,20000],[4000,4000]]) {
    const pixels=Buffer.alloc(height*(1+Math.ceil(width/8)));
    const clean=sanitizePng(pngFixture({width,height,color:0,depth:1,pixels}));
    assert.deepEqual([clean.width,clean.height],[width,height]);
  }
  for(const [width,height] of [[0,1],[1,0],[20001,1],[1,20001],[4000,4001]])assert.throws(()=>sanitizePng(pngFixture({width,height})),/размер|пиксел/i);
});

test('PNG chunk count accepts 4096 chunks and rejects 4097',()=>{
  const metadata=Array.from({length:4093},()=>pngChunk('tEXt'));
  assert.equal(sanitizePng(pngFixture({before:metadata})).removedChunks.length,4093);
  assert.throws(()=>sanitizePng(pngFixture({before:[...metadata,pngChunk('tEXt')]})),/много.*блок/i);
});

test('PNG byte cap accepts exactly 20 MiB and rejects a larger input',()=>{
  const max=20*1024*1024,base=pngFixture(),metadata=pngChunk('raNd',Buffer.alloc(max-base.length-12));
  const atLimit=pngFixture({before:[metadata]});assert.equal(atLimit.length,max);
  assert.deepEqual(Buffer.from(sanitizePng(atLimit).bytes),base);
  assert.throws(()=>sanitizePng(Buffer.alloc(max+1)),/20 МБ|больше/i);
});
