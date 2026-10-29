// Kept in test:e2ee: this suite uses the separately installed official SDK.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes,randomUUID } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';
import { nodeSignalBridge as bridge } from './support/signal-node.mjs';
import { pngChunk,pngFixture,readPngChunks } from './support/png-fixture.mjs';
import {jpegFixture,withJpegMetadata,jpegSegment} from './support/jpeg-fixture.mjs';
import {mp4Fixture} from './support/mp4-fixture.mjs';

function harness({conversionError=false,uploadError=false,photo=true,video=false,format='png',previewError=false}={}) {
  const source={uri:'file:///user/source.jpg',name:'private-source-name.jpg',mimeType:'image/jpeg'};
  const extension=video?'mp4':format;
  const exported={uri:`file:///cache/linea-export.${extension}`,name:video?'video.mp4':`photo.${extension}`,mimeType:video?'video/mp4':format==='jpg'?'image/jpeg':'image/png'};
  const privateData=Buffer.from('GPS:51.0,0.1; camera serial SECRET');
  const png=pngFixture({before:[pngChunk('eXIf',privateData),pngChunk('iTXt',privateData)]});
  const data=video?mp4Fixture().bytes:format==='jpg'?withJpegMetadata([jpegSegment(0xe1,privateData)]):png;
  const files=new Map([[source.uri,Buffer.concat([Buffer.from([255,216,255]),privateData])],[exported.uri,data]]);
  const calls={prepared:0,disposed:0,uploaded:0},uploaded=[];
  const fs={cacheDirectory:'file:///cache/',EncodingType:{Base64:'base64'},
    async getInfoAsync(uri){return {exists:files.has(uri),isDirectory:false,size:files.get(uri)?.length||0};},
    async readAsStringAsync(uri){return files.get(uri).toString('base64');},
    async writeAsStringAsync(uri,value){files.set(uri,Buffer.from(value,'base64'));},
    async deleteAsync(uri){files.delete(uri);},
  };
  const {encryptAndUpload}=loadTs(new URL('../src/e2ee/attachments.ts',import.meta.url),{
    'react-native':{Platform:{OS:'android'}},'expo-file-system/legacy':fs,'expo-sharing':{},
    'expo-crypto':{randomUUID,getRandomBytesAsync:async count=>new Uint8Array(randomBytes(count))},
    './signal':{getSignalBridge:()=>bridge},
    '../media/pipeline':{prepareMediaForUpload:async()=>{
      calls.prepared++;if(conversionError)throw new Error('photo conversion failed');
      return {file:photo||video?exported:source,photo,video,media:photo||video?{width:2,height:2,hdr:'sdr'}:undefined,dispose:async()=>{calls.disposed++;files.delete(exported.uri);}};
    }},
    '../media/thumbnail':{makeThumbnail:async()=>{if(previewError)throw new Error('thumbnail unsupported');return loadTs(new URL('../src/media/previewModel.ts',import.meta.url)).createPreview(jpegFixture());}},
    'base64-js':{fromByteArray:bytes=>Buffer.from(bytes).toString('base64'),toByteArray:value=>new Uint8Array(Buffer.from(value,'base64'))},
  });
  const api={async request(){calls.uploaded++;if(uploadError)throw new Error('network failed');
    const entry=[...files].find(([uri])=>uri.endsWith('.bin'));assert.ok(entry);uploaded.push(Buffer.from(entry[1]));
    return {id:randomUUID(),size:entry[1].length};
  }};
  return {source,exported,privateData,png,files,calls,uploaded,encryptAndUpload,api};
}

async function openUploaded(attachment,cipher){
  const encryption=attachment.encryption,ad=Buffer.from(`linea-attachment-v1:${encryption.fileKeyId}`).toString('base64');
  return Buffer.from(await bridge.open(cipher.toString('base64'),encryption.key,encryption.nonce,ad),'base64');
}

test('the actual upload caller cleans PNG metadata before real Signal AEAD encryption and reports exact sanitized size',async()=>{
  const h=harness(),attachment=await h.encryptAndUpload(h.api,h.source);
  assert.equal(h.calls.prepared,1);assert.equal(h.calls.disposed,1);
  assert.equal(attachment.name,'photo.png');assert.equal(attachment.mimeType,'image/png');
  const plain=await openUploaded(attachment,h.uploaded[0]);
  assert.deepEqual(readPngChunks(plain).map(chunk=>chunk.type),['IHDR','IDAT','IEND']);
  assert.equal(plain.includes(h.privateData),false);assert.equal(h.uploaded[0].includes(h.privateData),false);
  assert.equal(attachment.size,plain.length);assert.equal(h.uploaded[0].length,plain.length+16);
  assert.ok(h.files.has(h.source.uri),'the original photo is never deleted');
  assert.equal([...h.files.keys()].some(uri=>uri.endsWith('.bin')),false,'temporary ciphertext is cleaned');
});

test('failed conversion prevents any original image from reaching upload',async()=>{
  const h=harness({conversionError:true});await assert.rejects(h.encryptAndUpload(h.api,h.source),/conversion failed/);
  assert.equal(h.calls.uploaded,0);assert.ok(h.files.has(h.source.uri));
});

test('failed upload releases prepared photo and ciphertext without deleting the original',async()=>{
  const h=harness({uploadError:true});await assert.rejects(h.encryptAndUpload(h.api,h.source),/network failed/);
  assert.equal(h.calls.disposed,1);assert.equal(h.files.has(h.exported.uri),false);
  assert.equal([...h.files.keys()].some(uri=>uri.endsWith('.bin')),false);assert.ok(h.files.has(h.source.uri));
});

test('ordinary documents are encrypted byte for byte without a PNG rewrite',async()=>{
  const h=harness({photo:false});const original=Buffer.from(h.files.get(h.source.uri));
  const attachment=await h.encryptAndUpload(h.api,h.source);
  assert.deepEqual(await openUploaded(attachment,h.uploaded[0]),original);
  assert.equal(attachment.preview,undefined);assert.equal(attachment.media,undefined);
});

test('JPEG output is sanitized and encrypted with its real format and bounded embedded preview',async()=>{
  const h=harness({format:'jpg'}),attachment=await h.encryptAndUpload(h.api,h.source),plain=await openUploaded(attachment,h.uploaded[0]);
  assert.equal(attachment.mimeType,'image/jpeg');assert.equal(plain.includes(h.privateData),false);
  assert.equal(plain.includes(Buffer.from('JFIF')),false);assert.equal(attachment.preview.width,2);assert.equal(attachment.media.width,2);
  assert.equal(h.calls.disposed,1);
});
test('native-prepared video passes final container cleanup before real AEAD encryption',async()=>{
  const h=harness({photo:false,video:true}),attachment=await h.encryptAndUpload(h.api,h.source),plain=await openUploaded(attachment,h.uploaded[0]);
  assert.equal(attachment.mimeType,'video/mp4');assert.equal(plain.includes(Buffer.from('private')),false);
  assert.equal(attachment.media.hdr,'sdr');assert.equal(attachment.preview.mimeType,'image/jpeg');assert.equal(attachment.size,plain.length);
});
test('a thumbnail decoder error does not bypass the protected media path or prevent sending the cleaned file',async()=>{
  const h=harness({previewError:true}),attachment=await h.encryptAndUpload(h.api,h.source),plain=await openUploaded(attachment,h.uploaded[0]);
  assert.equal(attachment.preview,undefined);assert.equal(plain.includes(h.privateData),false);assert.equal(h.calls.disposed,1);
});
