import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { sanitizeMp4 } from '../src/media/mp4.ts';
import { atom,full,mp4Fixture } from './support/mp4-fixture.mjs';
test('MP4 sanitation zeroes personal tags, dates, handler/compressor names and unused media bytes',()=>{
  const {bytes,sample,start}=mp4Fixture();const clean=sanitizeMp4(bytes);
  assert.equal(clean.width,2);assert.equal(clean.height,2);
  assert.equal(clean.bytes.length,bytes.length,'chunk offsets remain stable');
  assert.equal(Buffer.from(clean.bytes).includes(Buffer.from('private')),false);
  assert.deepEqual(Buffer.from(clean.bytes).subarray(start,start+sample.length*2),Buffer.concat([sample,sample]));
  assert.equal(Buffer.from(clean.bytes).readUInt32BE(Buffer.from(clean.bytes).indexOf('mvhd')+8),0);
  assert.equal(Buffer.from(clean.bytes).readUInt32BE(Buffer.from(clean.bytes).indexOf('tkhd')+8),0);
  assert.equal(Buffer.from(clean.bytes).readUInt32BE(Buffer.from(clean.bytes).indexOf('mdhd')+8),0);
  assert.deepEqual(sanitizeMp4(clean.bytes).bytes,clean.bytes);
  assert.ok(bytes.includes(Buffer.from('private')));
});
test('HDR color information is preserved exactly and inconsistent claims are refused',()=>{
  for(const hdr of ['pq','hlg']){const {bytes}=mp4Fixture({hdr});const clean=sanitizeMp4(bytes,hdr);assert.equal(clean.hdr,hdr);const offset=bytes.indexOf('colr');assert.deepEqual(Buffer.from(clean.bytes).subarray(offset,offset+15),bytes.subarray(offset,offset+15));assert.throws(()=>sanitizeMp4(bytes,'sdr'),/HDR/);}
});
test('metadata tracks, external data references and unsupported codec entries fail closed',()=>{
  assert.throws(()=>sanitizeMp4(mp4Fixture({privateTrack:true}).bytes),/трек|track|MP4/);
  assert.throws(()=>sanitizeMp4(mp4Fixture({external:true}).bytes),/ссыл|reference|MP4/);
  assert.throws(()=>sanitizeMp4(mp4Fixture({codec:'av01'}).bytes),/кодек|codec|MP4/);
});
test('chunk offsets cannot point to metadata or beyond the media payload',()=>{
  assert.throws(()=>sanitizeMp4(mp4Fixture({offsetDelta:10000}).bytes),/данн|offset|MP4/);
});
test('truncated boxes, fragmented inputs, oversized files and unsupported atom trees are refused',()=>{
  const {bytes}=mp4Fixture();
  for(const data of [bytes.subarray(0,-1),Buffer.from('not mp4'),Buffer.concat([bytes,atom('moof',Buffer.alloc(8))]),Buffer.concat([bytes,atom('evil',Buffer.from('private'))])])assert.throws(()=>sanitizeMp4(data),/MP4|блок|atom/);
  assert.throws(()=>sanitizeMp4(Buffer.alloc(20*1024*1024+1)),/20/);
});

// Fixture edits rebuild ancestor sizes; the fixture places mdat before moov,
// so its absolute sample offsets remain valid when headers grow or disappear.
function editBox(bytes,type,edit) {
  const prefix={moov:0,trak:0,mdia:0,minf:0,dinf:0,stbl:0,edts:0,stsd:8,avc1:78,avc3:78,hvc1:78,hev1:78,mp4a:28};
  const output=[];
  for(let offset=0;offset<bytes.length;) {
    const length=bytes.readUInt32BE(offset),name=bytes.toString('latin1',offset+4,offset+8);
    let payload=Buffer.from(bytes.subarray(offset+8,offset+length));offset+=length;
    if(name in prefix){const start=prefix[name];payload=Buffer.concat([payload.subarray(0,start),editBox(payload.subarray(start),type,edit)]);}
    if(name===type)payload=edit(payload);
    if(payload!==null)output.push(atom(name,payload));
  }
  return Buffer.concat(output);
}

test('dependency metadata must match the sample count and contain only defined bits',()=>{
  const source=mp4Fixture().bytes;
  const inject=data=>editBox(source,'stbl',payload=>Buffer.concat([payload,full('sdtp',data)]));
  assert.throws(()=>sanitizeMp4(inject(Buffer.from('private GPS serial'))),/sdtp|зависим|образц/i);
  assert.throws(()=>sanitizeMp4(inject(Buffer.from([0x47,0x50]))),/sdtp|бит|зависим/i);
  const valid=inject(Buffer.from([0x20,0x10]));
  assert.equal(sanitizeMp4(valid).bytes.length,valid.length);
});

test('reserved CICP values and mismatched HDR primaries are refused',()=>{
  for(const offset of [4,6,8]) {
    const bytes=editBox(mp4Fixture().bytes,'colr',payload=>{payload.writeUInt16BE(65535,offset);return payload;});
    assert.throws(()=>sanitizeMp4(bytes,'sdr'),/цвет|CICP|HDR/i);
  }
  const falseHdr=editBox(mp4Fixture({hdr:'pq'}).bytes,'colr',payload=>{payload.writeUInt16BE(1,4);return payload;});
  assert.throws(()=>sanitizeMp4(falseHdr,'pq'),/цвет|CICP|HDR/i);
});

test('essential movie and track headers cannot be omitted',()=>{
  for(const type of ['mvhd','tkhd','mdhd','dinf','vmhd','stts']) {
    const bytes=editBox(mp4Fixture().bytes,type,()=>null);
    assert.throws(()=>sanitizeMp4(bytes),/обязательн|неполн|заголов|таблиц/i,type);
  }
});

test('sample timing and sync tables are tied to the declared samples',()=>{
  const source=mp4Fixture().bytes;
  const wrongTiming=editBox(source,'stts',payload=>{payload.writeUInt32BE(1,8);return payload;});
  assert.throws(()=>sanitizeMp4(wrongTiming),/stts|образц|таблиц/i);
  const flags=editBox(source,'stts',payload=>{payload[3]=1;return payload;});
  assert.throws(()=>sanitizeMp4(flags),/флаг|верси|stts/i);
  const invalidSync=editBox(source,'stbl',payload=>Buffer.concat([payload,full('stss',Buffer.from([0,0,0,1,0,0,3,232]))]));
  assert.throws(()=>sanitizeMp4(invalidSync),/stss|синхр|образц/i);
});

test('static HDR payload has bounded chromaticity and luminance fields',()=>{
  const mastering=Buffer.alloc(24);mastering.writeUInt16BE(60000,0);mastering.writeUInt32BE(10000000,16);mastering.writeUInt32BE(50,20);
  const bytes=editBox(mp4Fixture({hdr:'pq'}).bytes,'avc1',payload=>Buffer.concat([payload,atom('mdcv',mastering)]));
  assert.throws(()=>sanitizeMp4(bytes,'pq'),/HDR|цвет|ярк/i);
});

function aacDescription(config,{duplicate=false,wrongStream=false}={}) {
  const descriptor=(tag,data)=>Buffer.concat([Buffer.from([tag,data.length]),data]);
  const decoder=Buffer.alloc(13);decoder[0]=0x40;decoder[1]=wrongStream?0x17:0x15;
  const asc=descriptor(5,config);
  const nested=descriptor(4,Buffer.concat([decoder,asc,...(duplicate?[asc]:[])]));
  const root=descriptor(3,Buffer.concat([Buffer.from([0,1,0]),nested,descriptor(6,Buffer.from([2]))]));
  return Buffer.concat([Buffer.alloc(4),root]);
}

test('AAC config permits only defined LC fields and cannot retain private trailing bytes',()=>{
  const source=readFileSync(new URL('../modules/linea-video/android/src/test/resources/video/sdr-audio.mp4',import.meta.url));
  const replace=(config,options)=>editBox(source,'esds',()=>aacDescription(config,options));
  for(const config of [Buffer.from([0x11,0x88]),Buffer.from([0x11,0x88,0x56,0xe5,0])]) {
    assert.equal(sanitizeMp4(replace(config)).width,64);
  }
  const trailing=Buffer.concat([Buffer.from([0x11,0x88]),Buffer.from('private audio GPS')]);
  assert.throws(()=>sanitizeMp4(replace(trailing)),/AAC|аудио|config|конфиг/i);
  for(const invalid of [[0x17,0x88],[0x11,0x80],[0x11,0x8f],[0x11,0x88,0x56,0xe5,0x80]]) {
    assert.throws(()=>sanitizeMp4(replace(Buffer.from(invalid))),/AAC|аудио|config|конфиг/i);
  }
  assert.throws(()=>sanitizeMp4(replace(Buffer.from([0x11,0x88]),{duplicate:true})),/AAC|аудио|descriptor/i);
  assert.throws(()=>sanitizeMp4(replace(Buffer.from([0x11,0x88]),{wrongStream:true})),/AAC|аудио|descriptor/i);
});

const integers=(...values)=>{
  const bytes=Buffer.alloc(values.length*4);
  values.forEach((value,index)=>bytes.writeUInt32BE(value>>>0,index*4));
  return bytes;
};
const addSampleBoxes=(source,...extra)=>editBox(source,'stbl',payload=>Buffer.concat([payload,...extra]));
const addCodecBoxes=(source,...extra)=>editBox(source,'avc1',payload=>Buffer.concat([payload,...extra]));

test('color profiles require a complete recognized numeric layout and consistent declarations',()=>{
  const source=mp4Fixture().bytes;
  const nclc=editBox(source,'colr',payload=>{payload.write('nclc');return payload.subarray(0,10);});
  assert.equal(sanitizeMp4(nclc,'sdr').hdr,'sdr');
  const invalid=[
    editBox(source,'colr',payload=>{payload.write('prof');return payload;}),
    editBox(source,'colr',payload=>payload.subarray(0,9)),
    editBox(source,'colr',payload=>Buffer.concat([payload,Buffer.from([0])])),
    editBox(source,'colr',payload=>{payload[10]=1;return payload;}),
  ];
  for(const bytes of invalid)assert.throws(()=>sanitizeMp4(bytes),/цвет|профил|colr|размер/i);
  const alternate=Buffer.alloc(11);alternate.write('nclx');alternate.writeUInt16BE(9,4);alternate.writeUInt16BE(16,6);alternate.writeUInt16BE(9,8);
  assert.throws(()=>sanitizeMp4(addCodecBoxes(source,atom('colr',alternate))),/HDR|повтор/i);
});

test('valid static HDR stays byte-identical while invalid light and mastering ranges fail closed',()=>{
  const source=mp4Fixture({hdr:'pq'}).bytes;
  const mastering=(maximum=10000000,minimum=50,coordinate=34000)=>{
    const bytes=Buffer.alloc(24);bytes.writeUInt16BE(coordinate);bytes.writeUInt32BE(maximum,16);bytes.writeUInt32BE(minimum,20);return bytes;
  };
  const light=(maximum,average)=>{const bytes=Buffer.alloc(4);bytes.writeUInt16BE(maximum);bytes.writeUInt16BE(average,2);return bytes;};
  for(const [type,payload] of [['mdcv',mastering()],['mdcv',mastering(100000000,0,50000)],['clli',light(1000,400)],['clli',light(0,65535)]]){
    const bytes=addCodecBoxes(source,atom(type,payload)),clean=Buffer.from(sanitizeMp4(bytes,'pq').bytes),offset=bytes.indexOf(type)+4;
    assert.deepEqual(clean.subarray(offset,offset+payload.length),payload);
    assert.deepEqual(Buffer.from(sanitizeMp4(clean,'pq').bytes),clean);
  }
  for(const payload of [mastering(0,0),mastering(100,100),mastering(100000001,0),mastering(10000000,50,50001),Buffer.alloc(23)]){
    assert.throws(()=>sanitizeMp4(addCodecBoxes(source,atom('mdcv',payload)),'pq'),/HDR|mdcv/i);
  }
  assert.throws(()=>sanitizeMp4(addCodecBoxes(source,atom('clli',light(999,1000))),'pq'),/HDR/i);
  assert.throws(()=>sanitizeMp4(addCodecBoxes(mp4Fixture().bytes,atom('clli',light(1000,400)))) ,/HDR/i);
  const noColor=editBox(mp4Fixture().bytes,'colr',()=>null);
  assert.throws(()=>sanitizeMp4(addCodecBoxes(noColor,atom('clli',light(1000,400)))),/HDR/i);
});

test('sample group descriptions accept defined versions and reject opaque or wrong-sized groups',()=>{
  const source=mp4Fixture().bytes;
  const group=(type,data,version=0)=>full(type,Buffer.concat([Buffer.from('roll'),data]),version);
  const definitions=[
    group('sgpd',Buffer.concat([integers(1),Buffer.from([0xff,0xff])])),
    group('sgpd',Buffer.concat([integers(2,1),Buffer.from([0xff,0xff])]),1),
    group('sgpd',Buffer.concat([integers(2,0,1),Buffer.from([0xff,0xff])]),2),
  ];
  for(const description of definitions){
    const bytes=addSampleBoxes(source,description,group('sbgp',integers(1,2,1)));
    assert.equal(sanitizeMp4(bytes).width,2);
  }
  const versionOne=addSampleBoxes(source,definitions[1],group('sbgp',integers(0,1,2,1),1));
  assert.equal(sanitizeMp4(versionOne).width,2);
  const wrongSize=group('sgpd',Buffer.concat([integers(4,1),Buffer.alloc(4)]),1);
  assert.throws(()=>sanitizeMp4(addSampleBoxes(source,wrongSize)),/sgpd|длин/i);
  const unknown=full('sgpd',Buffer.concat([Buffer.from('priv'),integers(1),Buffer.from('private')]));
  assert.throws(()=>sanitizeMp4(addSampleBoxes(source,unknown)),/групп/i);
  assert.throws(()=>sanitizeMp4(addSampleBoxes(source,group('sgpd',integers(0),3))),/верси|sgpd/i);
});

test('sample run boundaries, descriptions, and media overlaps are validated',()=>{
  const {bytes:source,start,sample}=mp4Fixture();
  for(const run of [[0,2,1],[2,2,1],[1,0,1],[1,1000001,1],[1,2,2]]){
    const bytes=editBox(source,'stsc',()=>Buffer.concat([Buffer.alloc(4),integers(1,...run)]));
    assert.throws(()=>sanitizeMp4(bytes),/stsc|образц|таблиц/i);
  }
  const runs=editBox(source,'stsc',()=>Buffer.concat([Buffer.alloc(4),integers(2,1,1,1,2,1,1)]));
  const separated=editBox(runs,'stco',()=>Buffer.concat([Buffer.alloc(4),integers(2,start,start+sample.length)]));
  const clean=Buffer.from(sanitizeMp4(separated).bytes);
  assert.deepEqual(clean.subarray(start,start+2*sample.length),Buffer.concat([sample,sample]));
  const overlap=editBox(runs,'stco',()=>Buffer.concat([Buffer.alloc(4),integers(2,start,start)]));
  assert.throws(()=>sanitizeMp4(overlap),/пересека|област/i);
});

test('AAC descriptors reject truncation, overlong lengths, external flags, and invalid sync data',()=>{
  const source=readFileSync(new URL('../modules/linea-video/android/src/test/resources/video/sdr-audio.mp4',import.meta.url));
  const complete=aacDescription(Buffer.from([0x11,0x88]));
  const flagged=Buffer.from(complete);flagged[8]=0x80;
  const sync=Buffer.from(complete);sync[sync.length-1]=0;
  const invalid=[Buffer.from([0,0,0,0,3]),Buffer.from([0,0,0,0,3,0x80]),Buffer.from([0,0,0,0,3,0x81,0x80,0x80,0x80,0]),Buffer.from([0,0,0,0,3,127]),flagged,sync];
  for(const payload of invalid)assert.throws(()=>sanitizeMp4(editBox(source,'esds',()=>payload)),/AAC|descriptor|flags/i);
});

test('extended and to-end atom sizes preserve sample positions and reject invalid bounds',()=>{
  const source=mp4Fixture().bytes;
  const extended=Buffer.alloc(24);extended.writeUInt32BE(1);extended.write('free',4);extended.writeUInt32BE(24,12);extended.write('private',16);
  const toEnd=Buffer.concat([Buffer.from([0,0,0,0]),Buffer.from('free'),Buffer.from('private')]);
  for(const extra of [extended,toEnd]){
    const bytes=Buffer.concat([source,extra]),clean=Buffer.from(sanitizeMp4(bytes).bytes);
    assert.equal(clean.length,bytes.length);assert.equal(clean.includes(Buffer.from('private')),false);
  }
  const high=Buffer.from(extended);high.writeUInt32BE(1,8);
  const tooSmall=Buffer.from(extended);tooSmall.writeUInt32BE(15,12);
  const beyond=Buffer.from(extended);beyond.writeUInt32BE(25,12);
  for(const extra of [high,tooSmall,beyond,extended.subarray(0,12)])assert.throws(()=>sanitizeMp4(Buffer.concat([source,extra])),/блок|длин|размер/i);
});

test('timing tables allow signed composition offsets but reject zero or inconsistent counts',()=>{
  const source=mp4Fixture().bytes;
  for(const [count,delta] of [[0,1000],[3,1000],[2,0]]){
    const bytes=editBox(source,'stts',()=>Buffer.concat([Buffer.alloc(4),integers(1,count,delta)]));
    assert.throws(()=>sanitizeMp4(bytes),/stts|образц|длительн/i);
  }
  const composition=full('ctts',integers(2,1,-100,1,100),1);
  const bytes=addSampleBoxes(source,composition),clean=Buffer.from(sanitizeMp4(bytes).bytes);
  const offset=bytes.indexOf('ctts')-4;
  assert.deepEqual(clean.subarray(offset,offset+composition.length),composition);
  const mismatch=addSampleBoxes(source,full('ctts',integers(1,1,100)));
  assert.throws(()=>sanitizeMp4(mismatch),/ctts|образц/i);
});

const shortInteger=value=>{const bytes=Buffer.alloc(2);bytes.writeUInt16BE(value);return bytes;};
const longInteger=value=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(value));return bytes;};
// Serialize named ISO-BMFF header fields independently of sanitizer offsets.
function timedHeader(type,version,privateFields) {
  const hidden=size=>Buffer.alloc(size,privateFields?0xa5:0);
  const prefix=Buffer.from([version,0,0,type==='tkhd'?7:0]);
  const dates=hidden(version?16:8),duration=version?longInteger(2000):integers(2000);
  const matrix=Buffer.concat([integers(65536,0,0),integers(0,65536,0),integers(0,0,0x40000000)]);
  if(type==='mvhd')return Buffer.concat([prefix,dates,integers(1000),duration,integers(65536),shortInteger(256),hidden(10),matrix,hidden(24),integers(2)]);
  if(type==='tkhd')return Buffer.concat([prefix,dates,integers(1),hidden(4),duration,hidden(8),shortInteger(0),shortInteger(0),shortInteger(0),hidden(2),matrix,integers(2*65536,2*65536)]);
  return Buffer.concat([prefix,dates,integers(1000),duration,shortInteger(privateFields?0x3456:0x55c4),hidden(2)]);
}

test('32- and 64-bit movie headers erase dates and private padding while preserving playback fields',()=>{
  for(const version of [0,1])for(const type of ['mvhd','tkhd','mdhd']){
    const source=editBox(mp4Fixture().bytes,type,()=>timedHeader(type,version,true)),original=Buffer.from(source);
    const clean=Buffer.from(sanitizeMp4(source).bytes),offset=clean.indexOf(type)+4,expected=timedHeader(type,version,false);
    assert.deepEqual(clean.subarray(offset,offset+expected.length),expected,`${type} version ${version}`);
    assert.deepEqual(source,original,'sanitation does not mutate its input');
  }
  for(const type of ['mvhd','tkhd','mdhd']){
    const trailing=editBox(mp4Fixture().bytes,type,payload=>Buffer.concat([payload,Buffer.from('private')]));
    assert.throws(()=>sanitizeMp4(trailing),/размер|MP4/i);
  }
});

function visualHeader(privateFields,width=2,height=2) {
  const hidden=size=>Buffer.alloc(size,privateFields?0xa5:0);
  return Buffer.concat([hidden(6),shortInteger(1),hidden(16),shortInteger(width),shortInteger(height),integers(72*65536,72*65536),hidden(4),shortInteger(1),hidden(32),shortInteger(24),shortInteger(65535)]);
}

test('visual and AAC entries remove private reserved bytes without damaging essential codec fields',()=>{
  const video=editBox(mp4Fixture().bytes,'avc1',payload=>Buffer.concat([visualHeader(true),payload.subarray(78)]));
  const output=Buffer.from(sanitizeMp4(video).bytes),at=output.indexOf('avc1')+4;
  assert.deepEqual(output.subarray(at,at+78),visualHeader(false));
  const audio=readFileSync(new URL('../modules/linea-video/android/src/test/resources/video/sdr-audio.mp4',import.meta.url));
  const header=privateFields=>Buffer.concat([Buffer.alloc(6,privateFields?0xa5:0),shortInteger(1),shortInteger(0),Buffer.alloc(6,privateFields?0xa5:0),shortInteger(1),shortInteger(16),shortInteger(0),shortInteger(0),integers(48000*65536)]);
  const source=editBox(audio,'mp4a',payload=>Buffer.concat([header(true),payload.subarray(28)]));
  const clean=Buffer.from(sanitizeMp4(source).bytes),offset=clean.indexOf('mp4a')+4;
  assert.deepEqual(clean.subarray(offset,offset+28),header(false));
});

test('dimension limits reject zero and oversized video and retain the accepted boundary',()=>{
  const video=(width,height)=>editBox(mp4Fixture().bytes,'avc1',payload=>Buffer.concat([visualHeader(false,width,height),payload.subarray(78)]));
  for(const [width,height] of [[0,2],[2,0],[16385,2],[2,16385]])assert.throws(()=>sanitizeMp4(video(width,height)),/размер/i);
  assert.equal(sanitizeMp4(video(16384,2)).width,16384);
  assert.equal(sanitizeMp4(video(2,16384)).height,16384);
});

test('private boxes and every unreferenced media gap become exact zero padding',()=>{
  const {bytes,start,sample,gap}=mp4Fixture({metadata:false});
  const privateTypes=['udta','meta','ilst','uuid','free','skip','wide'];
  const source=Buffer.concat([bytes,...privateTypes.map(type=>atom(type,Buffer.alloc(20,0xa5)))]);
  const clean=Buffer.from(sanitizeMp4(source).bytes);
  for(let index=0;index<privateTypes.length;index++){
    const offset=bytes.length+index*28;
    assert.equal(clean.readUInt32BE(offset),28);assert.equal(clean.toString('latin1',offset+4,offset+8),'free');
    assert.deepEqual(clean.subarray(offset+8,offset+28),Buffer.alloc(20));
  }
  assert.deepEqual(clean.subarray(start-gap.length,start),Buffer.alloc(gap.length));
  assert.deepEqual(clean.subarray(start+sample.length*2,start+sample.length*2+gap.length),Buffer.alloc(gap.length));
  assert.deepEqual(clean.subarray(start,start+sample.length*2),Buffer.concat([sample,sample]));
});

test('each reserved dependency field is rejected independently',()=>{
  const source=mp4Fixture().bytes;
  for(const value of [0x40,0x80,0xc0,0x30,0x0c,0x03]){
    assert.throws(()=>sanitizeMp4(addSampleBoxes(source,full('sdtp',Buffer.from([value,0])))),/sdtp|бит|зависим/i);
  }
  for(const value of [0,0x15,0x2a]){
    assert.equal(sanitizeMp4(addSampleBoxes(source,full('sdtp',Buffer.from([value,value])))).width,2);
  }
});

test('fixed sample sizes and 64-bit offsets remain bounded and point only at media',()=>{
  const {bytes:source,start,sample}=mp4Fixture();
  const fixed=editBox(source,'stsz',()=>Buffer.concat([Buffer.alloc(4),integers(sample.length,2)]));
  assert.equal(sanitizeMp4(fixed).width,2);
  for(const [size,count] of [[0,0],[1,1000001],[20*1024*1024+1,2]]){
    assert.throws(()=>sanitizeMp4(editBox(source,'stsz',()=>Buffer.concat([Buffer.alloc(4),integers(size,count)]))),/образц|размер|таблиц/i);
  }
  const noOffsets=editBox(source,'stco',()=>null);
  const co64=(high,low)=>addSampleBoxes(noOffsets,full('co64',integers(1,high,low)));
  assert.equal(sanitizeMp4(co64(0,start)).width,2);
  assert.throws(()=>sanitizeMp4(co64(1,start)),/offset/i);
  assert.throws(()=>sanitizeMp4(co64(0,0)),/offset|данн/i);
  const emptySize=editBox(source,'stsz',()=>Buffer.concat([Buffer.alloc(4),integers(0,2,0,sample.length)]));
  assert.throws(()=>sanitizeMp4(emptySize),/размер|образц/i);
});

test('self-contained data references reject missing flags and foreign reference types',()=>{
  const source=mp4Fixture().bytes;
  for(const [type,flags] of [['url ',0],['urn ',1]]){
    const bytes=editBox(source,'dref',()=>Buffer.concat([Buffer.alloc(4),integers(1),atom(type,integers(flags))]));
    assert.throws(()=>sanitizeMp4(bytes),/ссыл|MP4/i);
  }
});

test('AAC explicit frequency config accepts its defined layout and rejects zero or excessive rates',()=>{
  const source=readFileSync(new URL('../modules/linea-video/android/src/test/resources/video/sdr-audio.mp4',import.meta.url));
  const explicit=rate=>{
    const bits='00010'+'1111'+rate.toString(2).padStart(24,'0')+'0001'+'000';
    return Buffer.from(bits.match(/.{8}/g).map(byte=>parseInt(byte,2)));
  };
  const replace=rate=>editBox(source,'esds',()=>aacDescription(explicit(rate)));
  const config=explicit(48000),clean=Buffer.from(sanitizeMp4(replace(48000)).bytes);
  assert.equal(clean.includes(config),true,'the explicit sampling frequency is preserved');
  for(const rate of [0,192001])assert.throws(()=>sanitizeMp4(replace(rate)),/AAC|частот/i);
});
