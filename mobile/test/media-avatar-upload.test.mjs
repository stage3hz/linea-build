import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './support/load-ts.mjs';
const source={uri:'file:///photos/private.jpg',name:'private.jpg',mimeType:'image/jpeg'};
function setup({prepareError=false,uploadError=false,platform='android'}={}){
  const calls={prepared:0,disposed:0,uploaded:0};
  const {Api}=loadTs(new URL('../src/api.ts',import.meta.url),{
    'react-native':{Platform:{OS:platform}},
    'expo-file-system/legacy':{EncodingType:{Base64:'base64'},readAsStringAsync:async()=>Buffer.from('clean-png').toString('base64')},
    'base64-js':{toByteArray:value=>new Uint8Array(Buffer.from(value,'base64'))},
    './media/pipeline':{prepareMediaForUpload:async()=>{calls.prepared++;if(prepareError)throw new Error('conversion failed');return {file:{uri:'file:///cache/clean.png',name:'photo.png',mimeType:'image/png',size:8},photo:true,dispose:async()=>{calls.disposed++;}};}},
  });
  const api=new Api('https://test.invalid','token');api.request=async(path,options)=>{calls.uploaded++;assert.equal(path,'/uploads');assert.match(options.headers['Content-Type'],/^multipart\/form-data; boundary=/);assert.ok(Buffer.from(options.body).includes(Buffer.from('clean-png')));if(uploadError)throw new Error('upload failed');return {attachment:{id:'test',mimeType:'image/png'}};};
  return {api,calls};
}
test('public profile upload also uses the metadata preparation path and releases its clean copy',async()=>{
  const h=setup();await h.api.upload(source);assert.deepEqual(h.calls,{prepared:1,disposed:1,uploaded:1});
});
test('a failed preparation never uploads the original avatar and a failed upload releases the clean copy',async()=>{
  const bad=setup({prepareError:true});await assert.rejects(bad.api.upload(source),/conversion failed/);assert.equal(bad.calls.uploaded,0);
  const network=setup({uploadError:true});await assert.rejects(network.api.upload(source),/upload failed/);assert.equal(network.calls.disposed,1);
});
test('web profile upload cannot bypass native metadata preparation',async()=>{
  const h=setup({platform:'web'});await assert.rejects(h.api.upload(source),/Android|iPhone/);assert.equal(h.calls.uploaded,0);
});
