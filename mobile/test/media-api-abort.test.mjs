import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './support/load-ts.mjs';
const {Api}=loadTs(new URL('../src/api.ts',import.meta.url),{'react-native':{Platform:{OS:'android'}}});
const abortError=()=>new DOMException('cancelled','AbortError');
test('cancelling an AI request aborts the actual network operation',async t=>{
  let networkSignal;const controller=new AbortController();
  // (The device-proof exchange that starts beside the first request of a session is not the request under test.)
  t.mock.method(globalThis,'fetch',(url,options)=>String(url).includes('/auth/device/')?Promise.reject(new TypeError('offline')):new Promise((resolve,reject)=>{networkSignal=options.signal;options.signal.addEventListener('abort',()=>reject(abortError()),{once:true});}));
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
test('a timeout is reported as a timeout even when fetch rejects with a TypeError (React Native), and still fails over',async t=>{
  const api=loadTs(new URL('../src/api.ts',import.meta.url),{'react-native':{Platform:{OS:'android'}}});
  t.mock.timers.enable({apis:['setTimeout']});let signal;
  // React Native's fetch: an aborted request fails like a dropped connection.
  t.mock.method(globalThis,'fetch',(_url,options)=>new Promise((resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(new TypeError('Network request failed')),{once:true});}));
  const request=new api.Api('https://example.invalid').request('/auth/register',{method:'POST',body:'{}'});
  const rejected=request.then(()=>assert.fail('resolved'),error=>error);
  // Sign-up hashes three secrets on the server: it is not cut off at the ordinary 18 s, only at 45 s.
  t.mock.timers.tick(18001);
  assert.equal(signal.aborted,false,'sign-up survives the ordinary limit');
  t.mock.timers.tick(27000);
  const error=await rejected;
  assert.equal(signal.aborted,true);
  assert.match(error.message,/вовремя/,'not «Нет связи с сервером»');
  assert.equal(error.name,'TimeoutError');
  assert.ok(error instanceof api.RequestTimeoutError);
  assert.ok(error instanceof api.NetworkError,'a silent server still counts as a network failure (failover, Mesh)');
});
test('a real connection failure is still «Нет связи с сервером»',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('Network request failed');});
  await assert.rejects(new Api('https://example.invalid').request('/chats'),/Нет связи с сервером/);
});
