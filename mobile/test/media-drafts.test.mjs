import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const {appendAttachments,messageAttachmentBatch}=loadTs(new URL('../src/messageAttachments.ts',import.meta.url));
const file=id=>({id,name:`${id}.png`,mimeType:'image/png',size:100});
test('successful parts of an attachment retry remain once and in selection order',()=>{
  const a=file('a'),b=file('b'),c=file('c');
  assert.deepEqual(appendAttachments([a,b],[b,c]),[a,b,c]);
  assert.deepEqual(appendAttachments([a],[b,b]),[a,b]);
});
test('multiple selected files become ordered messages with caption only on the first',()=>{
  const files=[file('one'),file('two')];
  assert.deepEqual(messageAttachmentBatch(' подпись ',files),[{text:'подпись',attachment:files[0]},{text:'',attachment:files[1]}]);
});
test('text-only drafts still send, but empty drafts cannot create empty messages',()=>{
  assert.deepEqual(messageAttachmentBatch(' hello ',[]),[{text:'hello',attachment:null}]);
  assert.deepEqual(messageAttachmentBatch(' \n ',[]),[]);
});
test('combining partial selections never silently discards the existing draft',()=>{
  const current=Array.from({length:10},(_,i)=>file(String(i)));
  assert.throws(()=>appendAttachments(current,[file('overflow')]),/10/);
  assert.equal(current.length,10);
});
