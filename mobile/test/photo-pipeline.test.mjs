import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';
import { pngChunk,pngFixture,readPngChunks } from './support/png-fixture.mjs';
import { jpegSegment,withJpegMetadata } from './support/jpeg-fixture.mjs';
import { ultraHdrFixture } from './support/jpeg-hdr-fixture.mjs';

const source={uri:'file:///user/holiday.jpg',name:'private-camera-location.jpg',mimeType:'image/jpeg'};
const options=()=>({background:'keep',document:'none',scale:1,strokes:[],allowDownsample:false});
function harness(config={}) {
  const files=new Map([[source.uri,Buffer.from([255,216,255,1,2,3])]]),calls={render:[],dispose:[],writes:[],deletes:[],maxActive:0};
  let active=0;
  const bridge={
    capabilities:async()=>({backgroundRemoval:true,backgroundReady:true,objectRemoval:'diffusion',upscale:'bicubic',maxPlainPixels:16000000,maxProcessingPixels:4000000,maxOutputPixels:8000000}),
    inspect:async()=>config.inspect?config.inspect():({width:1,height:1,processingWidth:1,processingHeight:1,downsampled:false}),
    prepareBackground:async()=>bridge.capabilities(),
    async render(uri,parameters){
      calls.render.push({uri,parameters});active++;calls.maxActive=Math.max(active,calls.maxActive);
      try{
        if(config.beforeRender)await config.beforeRender(calls.render.length);
        if(config.renderError)throw new Error('native render unavailable');
        if(config.consent&&parameters.dynamicRange!=='sdr')throw Object.assign(new Error('native consent'),{code:'ERR_LINEA_PHOTO_HDR_NEEDS_CONSENT'});
        if(config.followFormat){config.format=parameters.format;config.png=parameters.format==='jpeg'?withJpegMetadata([]):undefined;config.width=config.height=parameters.format==='jpeg'?2:1;}
        const resultUri=config.resultUri||`file:///cache/linea-photo/linea-native-photo-${randomUUID()}.${config.format==='jpeg'?'jpg':'png'}`;
        files.set(resultUri,config.png||pngFixture({before:[pngChunk('eXIf',Buffer.from('private GPS metadata'))]}));
        return {uri:resultUri,width:config.width||1,height:config.height||1,downsampled:false,format:config.format||'png',mimeType:config.format==='jpeg'?'image/jpeg':'image/png',...(config.hdr?{hdr:config.hdr}:{})};
      }finally{active--;}
    },
    async dispose(uri){calls.dispose.push(uri);files.delete(uri);},clearCache:async()=>{},
  };
  const fs={
    cacheDirectory:'file:///cache/',EncodingType:{Base64:'base64'},
    async getInfoAsync(uri){return files.has(uri)?{exists:true,isDirectory:false,size:files.get(uri).length}:{exists:false};},
    async readAsStringAsync(uri,read={}){const data=files.get(uri);if(!data)throw new Error('file missing');return data.subarray(read.position||0,read.length===undefined?undefined:(read.position||0)+read.length).toString('base64');},
    async writeAsStringAsync(uri,data){calls.writes.push(uri);files.set(uri,Buffer.from(data,'base64'));if(config.writeError)throw new Error('disk write failed');},
    async deleteAsync(uri){calls.deletes.push(uri);files.delete(uri);},
    async readDirectoryAsync(){return [...files.keys()].filter(uri=>uri.startsWith('file:///cache/')).map(uri=>uri.slice('file:///cache/'.length));},
  };
  const consent=loadTs(new URL('../src/photo/hdrConsent.ts',import.meta.url));
  const pipeline=loadTs(new URL('../src/photo/pipeline.ts',import.meta.url),{
    './hdrConsent':consent,
    'expo-file-system/legacy':fs,'expo-crypto':{randomUUID},
    './bridge':{getPhotoBridge:()=>{if(config.noNative)throw new Error('native unavailable');return bridge;}},
    'base64-js':{fromByteArray:bytes=>Buffer.from(bytes).toString('base64'),toByteArray:value=>new Uint8Array(Buffer.from(value,'base64'))},
  });
  return {pipeline,files,calls,bridge,consent};
}

test('render exports a real sanitized PNG with a neutral name and disposes only its own files',async()=>{
  const {pipeline,files,calls}=harness();const rendered=await pipeline.renderPhoto(source,options());
  assert.equal(rendered.file.mimeType,'image/png');assert.equal(rendered.file.name,'photo.png');
  assert.equal(rendered.file.size,files.get(rendered.file.uri).length);
  assert.deepEqual(readPngChunks(files.get(rendered.file.uri)).map(c=>c.type),['IHDR','IDAT','IEND']);
  assert.equal(files.get(rendered.file.uri).includes(Buffer.from('private GPS')),false);
  assert.equal(calls.dispose.length,1);assert.ok(files.has(source.uri));
  await rendered.dispose();await rendered.dispose();
  assert.equal(files.has(rendered.file.uri),false);assert.ok(files.has(source.uri));
});

test('render failure cannot fall back to sending the original JPEG',async()=>{
  const {pipeline,files,calls}=harness({renderError:true});
  await assert.rejects(pipeline.renderPhoto(source,options()),/native render/);
  assert.equal(calls.writes.length,0);assert.ok(files.has(source.uri));
});

test('a native result outside its dedicated cache is rejected without deleting user data',async()=>{
  const {pipeline,files,calls}=harness({resultUri:source.uri});
  await assert.rejects(pipeline.renderPhoto(source,options()),/кэш|cache|путь/i);
  assert.equal(calls.dispose.length,0);assert.equal(calls.writes.length,0);assert.ok(files.has(source.uri));
});

test('an invalid PNG still releases the temporary native output',async()=>{
  const {pipeline,calls}=harness({png:Buffer.from('not a png')});
  await assert.rejects(pipeline.renderPhoto(source,options()),/PNG/);
  assert.equal(calls.dispose.length,1);assert.equal(calls.writes.length,0);
});

test('a failed export write removes partial output and native temporary data',async()=>{
  const {pipeline,files,calls}=harness({writeError:true});
  await assert.rejects(pipeline.renderPhoto(source,options()),/disk write/);
  assert.equal(calls.dispose.length,1);assert.equal(calls.writes.length,1);
  assert.equal(files.has(calls.writes[0]),false);assert.ok(files.has(source.uri));
});

test('upload detects a JPEG from bytes even when the picker calls it a binary document',async()=>{
  const {pipeline,calls}=harness();
  const prepared=await pipeline.preparePhotoForUpload({...source,name:'unrelated.bin',mimeType:'application/octet-stream'});
  assert.equal(prepared.photo,true);assert.equal(prepared.file.mimeType,'image/png');assert.equal(calls.render.length,1);await prepared.dispose();
});

test('non-image documents do not require a native renderer and keep their identity',async()=>{
  const {pipeline,files,calls}=harness({noNative:true});const file={uri:'file:///user/text.txt',name:'text.txt',mimeType:'text/plain'};
  files.set(file.uri,Buffer.from('a document'));
  const prepared=await pipeline.preparePhotoForUpload(file);
  assert.equal(prepared.photo,false);assert.deepEqual(prepared.file,file);assert.equal(calls.render.length,0);await prepared.dispose();assert.ok(files.has(file.uri));
});

test('image upload fails closed when the native renderer is absent',async()=>{
  const {pipeline}=harness({noNative:true});await assert.rejects(pipeline.preparePhotoForUpload(source),/native unavailable/);
});

test('an editor-owned PNG is reused during upload without destroying its preview lease',async()=>{
  const {pipeline,files,calls}=harness();const rendered=await pipeline.renderPhoto(source,options());
  const prepared=await pipeline.preparePhotoForUpload(rendered.file);await prepared.dispose();
  assert.equal(prepared.photo,true);assert.equal(calls.render.length,1);assert.ok(files.has(rendered.file.uri));
  await rendered.dispose();assert.equal(files.has(rendered.file.uri),false);
});

test('renders are serialized, snapshot brush settings, and continue after an earlier failure',async()=>{
  let release;const firstWait=new Promise(resolve=>{release=resolve;});
  const {pipeline,calls}=harness({beforeRender:async index=>{if(index===1){await firstWait;throw new Error('first failure');}}});
  const first=pipeline.renderPhoto(source,options());const secondOptions={...options(),strokes:[{radius:.02,points:[{x:.2,y:.3}]}]};
  const second=pipeline.renderPhoto(source,secondOptions);void second.catch(()=>{});secondOptions.strokes[0].points[0].x=.9;
  release();await assert.rejects(first,/first failure/);const rendered=await second;
  assert.equal(calls.maxActive,1);assert.equal(calls.render[1].parameters.strokes[0].points[0].x,.2);await rendered.dispose();
});

test('network URIs are refused before the native image processor is called',async()=>{
  const {pipeline,calls}=harness();await assert.rejects(pipeline.renderPhoto({...source,uri:'https://example.invalid/photo.jpg'},options()),/локальн/i);assert.equal(calls.render.length,0);
});

test('startup cleanup removes stale generated files while retaining a live preview and unrelated cache data',async()=>{
  const {pipeline,files,bridge}=harness();const active=await pipeline.renderPhoto(source,options());
  const stale=`file:///cache/linea-photo-export-${randomUUID()}.png`,unrelated='file:///cache/saved-user-image.png';
  files.set(stale,pngFixture());files.set(unrelated,pngFixture());let nativeCleared=0;bridge.clearCache=async()=>{nativeCleared++;};
  await pipeline.clearPhotoCache();assert.equal(nativeCleared,1);assert.equal(files.has(stale),false);
  assert.ok(files.has(active.file.uri));assert.ok(files.has(unrelated));await active.dispose();
});

test('JPEG editor export is cleaned, named neutrally and keeps its preview lease during upload',async()=>{
  const jpeg=withJpegMetadata([jpegSegment(0xe1,Buffer.from('private GPS'))]);
  const {pipeline,files,calls}=harness({format:'jpeg',png:jpeg,width:2,height:2});
  const rendered=await pipeline.renderPhoto(source,{...options(),format:'jpeg'});
  assert.equal(rendered.file.name,'photo.jpg');assert.equal(rendered.file.mimeType,'image/jpeg');
  assert.equal(files.get(rendered.file.uri).includes(Buffer.from('private')),false);
  const upload=await pipeline.preparePhotoForUpload(rendered.file);await upload.dispose();
  assert.equal(upload.file.mimeType,'image/jpeg');assert.equal(calls.render.length,1);assert.ok(files.has(rendered.file.uri));await rendered.dispose();
});
test('a native format different from the requested format fails and releases its output',async()=>{
  const {pipeline,calls}=harness();await assert.rejects(pipeline.renderPhoto(source,{...options(),format:'jpeg'}),/формат/i);assert.equal(calls.dispose.length,1);
});
test('default HDR PNG is sanitized without an SDR pixel conversion, even when the HDR renderer is absent',async()=>{
  const {pipeline,files,calls}=harness({noNative:true});
  files.set(source.uri,pngFixture({before:[pngChunk('cICP',Buffer.from([9,16,0,1])),pngChunk('tEXt',Buffer.from('Author\0private'))]}));
  const prepared=await pipeline.preparePhotoForUpload(source);const data=files.get(prepared.file.uri);
  assert.equal(prepared.photo,true);assert.equal(prepared.media.hdr,'pq');assert.equal(calls.render.length,0);
  assert.ok(readPngChunks(data).some(chunk=>chunk.type==='cICP'));assert.equal(data.includes(Buffer.from('private')),false);await prepared.dispose();
});
test('HDR PNG cannot silently run through a crop or scale that would remove HDR',async()=>{
  const {pipeline,files,calls}=harness();files.set(source.uri,pngFixture({before:[pngChunk('cICP',Buffer.from([9,18,0,1]))]}));
  await assert.rejects(pipeline.renderPhoto(source,{...options(),scale:2}),/HDR/);assert.equal(calls.render.length,0);
});
test('the queued render snapshots crop coordinates as well as brush points',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);const h=harness({beforeRender:async index=>{if(index===1)await gate;}});
  const first=h.pipeline.renderPhoto(source,options());const parameters={...options(),crop:{x:.1,y:.1,width:.5,height:.5}};
  const second=h.pipeline.renderPhoto(source,parameters);parameters.crop.x=.9;release();
  const results=await Promise.all([first,second]);assert.equal(h.calls.render[1].parameters.crop.x,.1);await Promise.all(results.map(result=>result.dispose()));
});

test('an unedited gain-map JPEG is sent as HDR without the native renderer, with every personal segment removed',async()=>{
  const {pipeline,files,calls}=harness({noNative:true});files.set(source.uri,ultraHdrFixture());
  const prepared=await pipeline.preparePhotoForUpload(source);const data=files.get(prepared.file.uri);
  assert.equal(prepared.media.hdr,'gainmap');assert.equal(prepared.file.mimeType,'image/jpeg');assert.equal(calls.render.length,0);
  for(const word of ['private','Pixel 8','Exif'])assert.equal(data.includes(Buffer.from(word)),false,word);
  assert.ok(data.includes(Buffer.from('hdrgm:GainMapMax')));await prepared.dispose();
});
test('a native HDR refusal asks for consent; after «Отправить без HDR» the photo is rendered as explicit SDR',async()=>{
  const {pipeline,calls,consent}=harness({consent:true,followFormat:true,inspect:async()=>({width:2,height:2,processingWidth:2,processingHeight:2,downsampled:false,dynamicRange:'hdr',hdrKind:'gainmap'})});
  const error=await pipeline.preparePhotoForUpload(source).then(()=>null,value=>value);
  assert.ok(consent.isHdrConsentError(error));assert.equal(error.uri,source.uri);assert.deepEqual(consent.pendingHdrConsent().slice(-1),[source.uri]);
  assert.equal(calls.render[0].parameters.format,'jpeg','a gain-map photo is tried as JPEG, never silently as PNG');
  consent.allowSdr(source.uri);
  const prepared=await pipeline.preparePhotoForUpload(source);
  assert.equal(calls.render.at(-1).parameters.dynamicRange,'sdr');assert.equal(prepared.media.hdr,'sdr');await prepared.dispose();
  assert.equal(consent.pendingHdrConsent().includes(source.uri),false);
});
test('a native gain-map result passes the HDR gate and is labelled gainmap; a lost map is an error, not a silent SDR',async()=>{
  const ok=harness({format:'jpeg',png:ultraHdrFixture(),width:2,height:2,hdr:'gainmap'});
  const rendered=await ok.pipeline.renderPhoto(source,{...options(),format:'jpeg',rotation:90});
  assert.equal(rendered.media.hdr,'gainmap');await rendered.dispose();
  const lost=harness({format:'jpeg',png:withJpegMetadata([]),width:2,height:2,hdr:'gainmap'});
  await assert.rejects(lost.pipeline.renderPhoto(source,{...options(),format:'jpeg',rotation:90}),/HDR/);
});
test('an effect preview is never an uploadable export and is released through the native module',async()=>{
  const {pipeline,calls,files}=harness();
  const preview=await pipeline.renderPreview(source,{...options(),background:'white',preview:{maxPixels:1000000}});
  assert.equal(calls.render[0].parameters.dynamicRange,'sdr');assert.ok(files.has(preview.uri));
  await assert.rejects(pipeline.preparePhotoForUpload({uri:preview.uri,name:'p.png',mimeType:'image/png'}),/./).catch(()=>{});
  await preview.dispose();await preview.dispose();assert.equal(calls.dispose.filter(uri=>uri===preview.uri).length,1);
  await assert.rejects(pipeline.renderPreview(source,options()),/Предпросмотр/);
});
test('media.hdr gainmap is valid on receipt but is not put on the wire (older clients refuse unknown values)',async()=>{
  const preview=loadTs(new URL('../src/media/previewModel.ts',import.meta.url),{'base64-js':{fromByteArray:b=>Buffer.from(b).toString('base64'),toByteArray:v=>new Uint8Array(Buffer.from(v,'base64'))}});
  assert.equal(preview.validMedia({width:2,height:2,hdr:'gainmap'}),true);
  assert.deepEqual(preview.wireMedia({width:2,height:2,hdr:'gainmap'}),{width:2,height:2});
  assert.deepEqual(preview.wireMedia({width:2,height:2,hdr:'pq'}),{width:2,height:2,hdr:'pq'});
  // What a 0.14 client checks: hdr must be sdr/pq/hlg or absent.
  const old=media=>media.hdr===undefined||['sdr','pq','hlg'].includes(media.hdr);
  assert.equal(old(preview.wireMedia({width:2,height:2,hdr:'gainmap'})),true);
});

test('a native gain map the gate cannot rebuild asks for consent and then renders SDR instead of getting stuck',async()=>{
  const h=harness({format:'jpeg',png:ultraHdrFixture({orientation:6}),width:2,height:2,hdr:'gainmap'});
  const error=await h.pipeline.renderPhoto(source,{...options(),format:'jpeg',rotation:90}).then(()=>null,value=>value);
  assert.ok(h.consent.isHdrConsentError(error),String(error));assert.equal(error.uri,source.uri);
  assert.equal(h.calls.writes.length,0,'nothing is exported');
  assert.equal(h.calls.dispose.length,1,'the refused native output is released');
});
