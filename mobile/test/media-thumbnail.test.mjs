import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './support/load-ts.mjs';
import {jpegFixture} from './support/jpeg-fixture.mjs';
function setup({video=false,bad=false,outside=false}={}){
  const files=new Map(),calls={deleted:[],inputs:[],frames:0};let sequence=0;
  const clean={file:{uri:'file:///cache/already-clean.png',name:'photo.png',mimeType:'image/png'},photo:!video,video,media:{width:2,height:2},dispose:async()=>{}};
  const fs={cacheDirectory:'file:///cache/',EncodingType:{Base64:'base64'},getInfoAsync:async uri=>({exists:files.has(uri),isDirectory:false,size:files.get(uri)?.length}),readAsStringAsync:async uri=>files.get(uri).toString('base64'),deleteAsync:async uri=>{calls.deleted.push(uri);files.delete(uri);}};
  const {makeThumbnail}=loadTs(new URL('../src/media/thumbnail.ts',import.meta.url),{
    'expo-file-system/legacy':fs,
    'expo-image-manipulator':{SaveFormat:{JPEG:'jpeg'},manipulateAsync:async(uri)=>{calls.inputs.push(uri);const target=outside?'file:///photos/user-original.jpg':`file:///cache/ImageManipulator/${++sequence}.jpg`;files.set(target,bad?Buffer.from('not jpeg'):jpegFixture());return {uri:target,width:2,height:2};}},
    'expo-video-thumbnails':{getThumbnailAsync:async uri=>{calls.frames++;calls.inputs.push(uri);files.set('file:///cache/frame.jpg',jpegFixture());return {uri:'file:///cache/frame.jpg',width:2,height:2};}},
  });return {makeThumbnail,clean,calls,files};
}
test('thumbnail uses only cleaned local media and strips derivative JPEG metadata',async()=>{
  const h=setup(),result=await h.makeThumbnail(h.clean);assert.equal(result.width,2);assert.equal(Buffer.from(result.base64,'base64').includes(Buffer.from('JFIF')),false);
  assert.deepEqual(h.calls.inputs,[h.clean.file.uri]);assert.equal(h.files.size,0);assert.equal(h.calls.deleted.includes(h.clean.file.uri),false);
});
test('video frame and all thumbnail intermediates are released after generation',async()=>{
  const h=setup({video:true}),result=await h.makeThumbnail(h.clean);assert.ok(result);assert.equal(h.calls.frames,1);assert.equal(h.files.size,0);assert.equal(h.calls.deleted.includes('file:///cache/frame.jpg'),true);
});
test('invalid derivatives are never substituted with an original and all retries are cleaned',async()=>{
  const h=setup({bad:true});assert.equal(await h.makeThumbnail(h.clean),undefined);assert.equal(h.calls.inputs.length,3);assert.equal(h.files.size,0);
});
test('an unowned generated URI is rejected without deleting a user file',async()=>{
  const h=setup({outside:true});await assert.rejects(h.makeThumbnail(h.clean),/путь/);assert.deepEqual(h.calls.deleted,[]);assert.equal(h.files.has('file:///photos/user-original.jpg'),true);
});
