import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
test('desktop fetch preserves local URLs and cancellation while routing API through isolated IPC',async()=>{
 const original=globalThis.fetch,oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
 const direct=[],requests=[];let handler;
 globalThis.fetch=async(...args)=>{direct.push(args);return new Response('asset');};
 Object.defineProperty(globalThis,'location',{value:{href:'invizent://app/index.html'},configurable:true});
 try {
  const bridge={request:async(id,request)=>{requests.push(request);return handler?handler(id,request):{status:200,statusText:'OK',headers:{},body:new TextEncoder().encode('api').buffer};},cancelRequest:async()=>{}};
  loadTs(new URL('../src/installDesktopFetch.ts',import.meta.url),{'./desktop':{desktopBridge:()=>bridge}});
  assert.equal(await (await fetch('/fonts/Montserrat-Regular.ttf')).text(),'asset');assert.equal(direct.length,1);assert.equal(requests.length,0);
  assert.equal(await (await fetch('https://api.invizent.com/health')).text(),'api');assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');
  const aborted=new AbortController();aborted.abort();await assert.rejects(fetch('https://api.invizent.com/health',{signal:aborted.signal}),{name:'AbortError'});assert.equal(requests.length,1);
  const controller=new AbortController();handler=async()=>{controller.abort();return {status:200,statusText:'OK',headers:{},body:new ArrayBuffer(0)};};
  await assert.rejects(fetch('https://api.invizent.com/health',{signal:controller.signal}),{name:'AbortError'});
 }finally{globalThis.fetch=original;if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else delete globalThis.location;}
});
