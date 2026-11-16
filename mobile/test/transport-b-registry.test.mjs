import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './support/load-ts.mjs';
function setup(){const routing=loadTs(new URL('../src/network/messageRoute.ts',import.meta.url));let stops=0,requests=0;
 const handler={recover:async()=>false,returnDirect:async()=>false,stop:async()=>{}};
 const controls=routing.registerReserveRecovery(handler),route={origin:'https://api.invizent.com',ready:true,onLost:()=>()=>{},stop:async()=>{stops++;},fetch:async()=>{requests++;throw Error('response lost');},openSocket:()=>{throw Error('not used');}};
 assert.equal(controls.publish(route),true);return{routing,controls,route,handler,stops:()=>stops,requests:()=>requests};}
test('an uncertain write is never dispatched a second time on the normal network',async t=>{
 const f=setup(),before=globalThis.fetch;let direct=0;globalThis.fetch=async()=>{direct++;throw Error('not allowed');};t.after(()=>{globalThis.fetch=before;f.controls.dispose();});
 await assert.rejects(f.routing.messageFetch('https://api.invizent.com/messages',{method:'POST',body:'encrypted-envelope'}));assert.equal(f.requests(),1);assert.equal(direct,0);assert.equal(f.routing.reserveRouteStatus(),'off');
});
test('old-account cleanup cannot clear a newly published route',async()=>{
 const f=setup();const next=f.routing.registerReserveRecovery(f.handler);const route={...f.route};assert.equal(next.publish(route),true);
 f.controls.dispose();assert.equal(f.routing.reserveRouteStatus(),'ready');assert.equal(f.controls.publish(f.route),false);next.dispose();
});
test('unsupported media does not break the active text route',async()=>{
 const f=setup();f.route.fetch=async()=>{throw Object.assign(Error('Unsupported transfer'),{name:'ReserveTransferError'});};
 await assert.rejects(f.routing.messageFetch('https://api.invizent.com/files'));assert.equal(f.routing.reserveRouteStatus(),'ready');f.controls.dispose();
});
test('foreign destinations are refused before dispatching a token-bearing request',async()=>{
 const f=setup();await assert.rejects(f.routing.messageFetch('https://example.com/me',{headers:{Authorization:'Bearer fixture'}}));assert.equal(f.requests(),0);f.controls.dispose();
});
