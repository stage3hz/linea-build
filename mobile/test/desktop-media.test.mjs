import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
test('desktop does not send WebM recorder bytes disguised as AAC and accepts an M4A audio file',async()=>{
 const original=globalThis.fetch;let bytes=new Uint8Array([0x1a,0x45,0xdf,0xa3,0,0,0,0]);
 globalThis.fetch=async()=>new Response(bytes);
 try{
  const {prepareMediaForUpload}=loadTs(new URL('../src/media/pipeline.web.ts',import.meta.url));
  const file={uri:'blob:test',name:'voice-123.m4a',mimeType:'audio/mp4',size:8};
  await assert.rejects(prepareMediaForUpload(file),/Выбери аудиофайл/);
  bytes=new Uint8Array([0,0,0,20,0x66,0x74,0x79,0x70,0x4d,0x34,0x41,0x20,0,0,0,0,0x4d,0x34,0x41,0x20]);
  const prepared=await prepareMediaForUpload(file);assert.equal(prepared.file.mimeType,'audio/mp4');assert.equal(prepared.video,false);await prepared.dispose();
 }finally{globalThis.fetch=original;}
});
