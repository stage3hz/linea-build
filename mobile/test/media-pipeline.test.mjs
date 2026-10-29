import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {loadTs} from './support/load-ts.mjs';
import {mp4Fixture} from './support/mp4-fixture.mjs';
const source={uri:'file:///user/private-camera.mov',name:'private-camera.mov',mimeType:'video/quicktime'};
function harness(config={}){
  const files=new Map([[source.uri,mp4Fixture().bytes]]),calls={sanitize:[],inspect:[],dispose:[],deletes:[],photo:0,writes:[]};
  const info={width:2,height:2,durationMs:1000,rotation:0,videoCodec:'avc',hasAudio:false,hdr:'sdr',inputBytes:100,removedTrackCount:0};
  const bridge={
    async inspect(uri){calls.inspect.push(uri);if(config.audioOnly){const e=new Error('audio only');e.code='NO_VIDEO_TRACK';throw e;}return info;},
    async sanitize(uri){calls.sanitize.push(uri);if(config.error)throw new Error(config.error);const output=config.resultUri||`file:///cache/linea-video/linea-native-video-${randomUUID()}.mp4`;const bytes=config.output||mp4Fixture().bytes;files.set(output,bytes);return {...info,uri:output,mimeType:'video/mp4',outputBytes:bytes.length,audioTranscoded:false};},
    async resolveLibraryAsset(){const uri=config.sourceUri||`file:///cache/linea-video/linea-native-video-source-${randomUUID()}.bin`;files.set(uri,mp4Fixture().bytes);return {uri,owned:true};},
    async dispose(uri){calls.dispose.push(uri);files.delete(uri);},async clearCache(){},
  };
  const fs={cacheDirectory:'file:///cache/',EncodingType:{Base64:'base64'},
    async getInfoAsync(uri){return files.has(uri)?{exists:true,isDirectory:false,size:files.get(uri).length}:{exists:false};},
    async readAsStringAsync(uri,o={}){const b=files.get(uri);if(!b)throw new Error('missing input');return b.subarray(o.position||0,o.length===undefined?undefined:(o.position||0)+o.length).toString('base64');},
    async writeAsStringAsync(uri,data){calls.writes.push(uri);files.set(uri,Buffer.from(data,'base64'));if(config.writeError)throw new Error('disk full');},
    async deleteAsync(uri){calls.deletes.push(uri);files.delete(uri);},async readDirectoryAsync(){return [...files.keys()].filter(uri=>uri.startsWith('file:///cache/')).map(uri=>uri.slice('file:///cache/'.length));},
  };
  const pipeline=loadTs(new URL('../src/media/pipeline.ts',import.meta.url),{
    'expo-file-system/legacy':fs,'expo-crypto':{randomUUID},'base64-js':{fromByteArray:b=>Buffer.from(b).toString('base64'),toByteArray:b=>new Uint8Array(Buffer.from(b,'base64'))},
    './videoBridge':{getVideoBridge:()=>{if(config.noNative)throw new Error('native unavailable');return bridge;}},
    '../photo/pipeline':{preparePhotoForUpload:async file=>{calls.photo++;return {file,photo:false,dispose:async()=>{}};}},
  });
  return {pipeline,files,calls,bridge};
}
test('default video sending remuxes first, removes private container data and returns only the new MP4',async()=>{
  const h=harness(),p=await h.pipeline.prepareMediaForUpload(source);
  assert.equal(p.video,true);assert.equal(p.photo,false);assert.equal(p.file.name,'video.mp4');assert.equal(p.file.mimeType,'video/mp4');
  assert.equal(h.files.get(p.file.uri).includes(Buffer.from('private')),false);assert.equal(h.calls.sanitize.length,1);assert.equal(h.calls.dispose.length,1);
  assert.equal(p.media.width,2);assert.equal(p.media.hdr,'sdr');assert.ok(h.files.has(source.uri));await p.dispose();await p.dispose();assert.ok(h.files.has(source.uri));assert.equal(h.files.has(p.file.uri),false);
});
test('video bytes disguised as an ordinary file still take the protected path',async()=>{
  const h=harness();const p=await h.pipeline.prepareMediaForUpload({...source,name:'data.bin',mimeType:'application/octet-stream'});assert.equal(p.video,true);assert.equal(h.calls.sanitize.length,1);await p.dispose();
});
test('unsupported HDR, absent native code, malformed native output and write failure never send the original',async()=>{
  for(const config of [{error:'HDR cannot be preserved'},{noNative:true},{output:Buffer.from('not MP4')},{writeError:true}]){
    const h=harness(config);await assert.rejects(h.pipeline.prepareMediaForUpload(source));assert.ok(h.files.has(source.uri));assert.equal([...h.files.keys()].filter(uri=>uri.includes('linea-video-export')).length,0);
  }
});
test('a native output outside its owned cache is rejected without deleting user data',async()=>{
  const h=harness({resultUri:source.uri});await assert.rejects(h.pipeline.prepareMediaForUpload(source),/кэш|путь/);assert.equal(h.calls.dispose.length,0);assert.ok(h.files.has(source.uri));
});
test('confirmed audio-only MP4 remains an audio file while false audio hints cannot bypass video sanitation',async()=>{
  const h=harness({audioOnly:true}),f={...source,name:'track.m4a',mimeType:'audio/mp4'};
  const p=await h.pipeline.prepareMediaForUpload(f);assert.equal(p.video,false);assert.equal(p.file.mimeType,'audio/mp4');assert.equal(h.calls.sanitize.length,0);
  const h2=harness(),p2=await h2.pipeline.prepareMediaForUpload(f);assert.equal(p2.video,true);assert.equal(h2.calls.sanitize.length,1);await p2.dispose();
});
test('ordinary documents are passed unchanged and remote URLs are blocked',async()=>{
  const h=harness({noNative:true}),f={uri:'file:///user/report.txt',name:'report.txt',mimeType:'text/plain'};h.files.set(f.uri,Buffer.from('ordinary report'));
  assert.deepEqual((await h.pipeline.prepareMediaForUpload(f)).file,f);
  await assert.rejects(h.pipeline.prepareMediaForUpload({...f,uri:'https://example.invalid/video.mp4'}),/локальн/);
});
test('iOS original resource copies have a bounded owned lifetime and cannot name an original user file',async()=>{
  const h=harness(),copy=await h.pipeline.resolveVideoLibraryAsset('asset-local-id');assert.ok(h.files.has(copy.fileUri));await copy.dispose();await copy.dispose();assert.equal(h.calls.dispose.length,1);
  const bad=harness({sourceUri:source.uri});await assert.rejects(bad.pipeline.resolveVideoLibraryAsset('id'),/кэш|путь/);assert.equal(bad.calls.dispose.length,0);assert.ok(bad.files.has(source.uri));
});
