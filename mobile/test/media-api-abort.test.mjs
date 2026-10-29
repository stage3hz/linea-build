import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './support/load-ts.mjs';
const {Api}=loadTs(new URL('../src/api.ts',import.meta.url),{'react-native':{Platform:{OS:'android'}}});
const abortError=()=>new DOMException('cancelled','AbortError');
test('cancelling an AI request aborts the actual network operation',async t=>{
  let networkSignal;const controller=new AbortController();
  t.mock.method(globalThis,'fetch',(_url,options)=>new Promise((resolve,reject)=>{networkSignal=options.signal;options.signal.addEventListener('abort',()=>reject(abortError()),{once:true});}));
  const request=new Api('https://example.invalid','test-token').request('/ai/chat',{signal:controller.signal});
  controller.abort();
  assert.equal(networkSignal.aborted,true);
  await assert.rejects(request,/отмен|cancel|Abort/i);
});
test('a request cancelled before sending does not contact the server',async t=>{
  const controller=new AbortController();controller.abort();let called=0;
  t.mock.method(globalThis,'fetch',async()=>{called++;return new Response('{}');});
  await assert.rejects(new Api('https://example.invalid').request('/ai/chat',{signal:controller.signal}),/отмен|cancel|Abort/i);
  assert.equal(called,0);
});
test('AI has time for the bounded server request while ordinary requests retain their shorter timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let signal;
  t.mock.method(globalThis,'fetch',(_url,options)=>new Promise((resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(abortError()),{once:true});}));
  const request=new Api('https://example.invalid').request('/ai/chat');const rejected=assert.rejects(request,/вовремя/);
  t.mock.timers.tick(18001);assert.equal(signal.aborted,false);
  t.mock.timers.tick(52000);await rejected;
});
