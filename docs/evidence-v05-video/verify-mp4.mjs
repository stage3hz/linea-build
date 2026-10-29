// Run from any directory with Node 24+, FFmpeg and ffprobe on PATH.
// These are representative FFmpeg containers, not captured device outputs.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sanitizeMp4 } from '../../mobile/src/media/mp4.ts';

const fixture=name=>fileURLToPath(new URL(`./fixtures/${name}`,import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function command(program,args) {
  const result=spawnSync(program,args,{encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(result.status,0,`${program}: ${result.stderr}`);
  return result.stdout.trim();
}
const probe=path=>JSON.parse(command('ffprobe',['-v','error','-select_streams','v:0','-show_frames','-show_streams','-show_format','-of','json',path]));
function videoDigest(path,format) {
  return command('ffmpeg',['-v','error','-i',path,'-map','0:v:0','-c:v','rawvideo','-threads','1','-pix_fmt',format,'-fps_mode','passthrough','-f','md5','-']);
}
const audioDigest=path=>command('ffmpeg',['-v','error','-i',path,'-map','0:a:0','-c:a','pcm_s16le','-f','md5','-']);
const hdrData=probe=>probe.frames.map(frame=>(frame.side_data_list??[]).filter(side=>['Mastering display metadata','Content light level metadata'].includes(side.side_data_type)));
const colors=stream=>Object.fromEntries(['pix_fmt','color_primaries','color_transfer','color_space'].map(key=>[key,stream[key]??null]));

const nativeFilter=[];
for(const [name,extension,pixelFormat] of [['sdr','h264','yuv420p'],['hdr10','hevc','yuv420p10le']]) {
  const before=fixture(`${name}.${extension}`),after=fixture(`clean-${name}.${extension}`);
  const a=probe(before),b=probe(after),digestBefore=videoDigest(before,pixelFormat),digestAfter=videoDigest(after,pixelFormat);
  assert.equal(digestAfter,digestBefore);
  assert.equal(b.frames.length,2);
  assert.deepEqual(hdrData(a),hdrData(b));
  assert.equal(b.frames.some(frame=>(frame.side_data_list??[]).some(side=>side.side_data_type.includes('User Data Unregistered'))),false);
  nativeFilter.push({name,frames:b.frames.length,pixelFormat,digestBefore,digestAfter,hdrDataEqual:true,privateUuidSeiRemoved:true,color:colors(b.streams[0])});
}

const containers=[];
for(const [name,hdr,pixelFormat,hasAudio] of [['sdr','sdr','yuv420p',false],['hdr10','pq','yuv420p10le',false],['audio','sdr','yuv420p',true]]) {
  const before=fixture(`native-like-${name}.mp4`),after=fixture(`final-${name}.mp4`);
  const input=readFileSync(before),clean=sanitizeMp4(input,hdr),output=Buffer.from(clean.bytes);
  writeFileSync(after,output);
  assert.equal(output.length,input.length);
  assert.deepEqual(sanitizeMp4(output,hdr).bytes,clean.bytes);
  assert.equal(output.includes(Buffer.from('private')),false);
  const a=probe(before),b=probe(after),digestBefore=videoDigest(before,pixelFormat),digestAfter=videoDigest(after,pixelFormat);
  assert.equal(digestAfter,digestBefore);
  assert.equal(b.frames.length,2);
  assert.equal(digestAfter,nativeFilter.find(item=>item.name===(name==='hdr10'?'hdr10':'sdr')).digestAfter);
  assert.deepEqual(hdrData(a),hdrData(b));
  assert.deepEqual(colors(a.streams[0]),colors(b.streams[0]));
  for(const tags of [b.format.tags,...b.streams.map(stream=>stream.tags)]) {
    assert.equal(Object.keys(tags??{}).some(key=>/title|comment|location|creation_time|handler_name|encoder/i.test(key)),false);
  }
  const audio=hasAudio?{digestBefore:audioDigest(before),digestAfter:audioDigest(after)}:null;
  if(audio)assert.equal(audio.digestAfter,audio.digestBefore);
  containers.push({name,hdr,size:output.length,width:clean.width,height:clean.height,frames:b.frames.length,sha256Before:hash(input),sha256After:hash(output),idempotent:true,decodedVideoEqual:true,digestBefore,digestAfter,hdrDataEqual:true,color:colors(b.streams[0]),audio,outputTags:b.format.tags,frameSideData:hdrData(b)});
}
const report={scope:'Production Kotlin NAL-filter outputs + representative FFmpeg MP4s; no Android/iOS media runtime claimed',nativeFilter,containers};
writeFileSync(new URL('./decoder-verification.json',import.meta.url),`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({nativeFilterCases:nativeFilter.length,containerCases:containers.length,allAssertionsPassed:true},null,2));
