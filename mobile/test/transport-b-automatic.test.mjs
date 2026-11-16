import assert from 'node:assert/strict';
import test from 'node:test';
import {fromByteArray} from 'base64-js';
import {bootstrapFixture} from '../../prototype/transport-b/test/support/bootstrap-fixture.mjs';
import {loadTs} from './support/load-ts.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function settled(predicate){for(let i=0;i<200&&!predicate();i++)await tick();assert.ok(predicate(),'recovery did not settle');}
async function setup(t,overrides={}){
 const f=await bootstrapFixture();t.after(f.close);
 const cache=new Map(),store=new Map(),listeners=new Map(),started=[],stopped=[];let serial=0;
 const reply=value=>({status:200,headers:{'content-type':'application/json'},body:fromByteArray(new TextEncoder().encode(JSON.stringify(value)))});
 const emit=(kind,value)=>{for(const listener of [...(listeners.get(kind)||[])])listener(value);};
 const native={capabilities:()=>({protocol:1,nativeSession:true,appRouting:false,networkProtocol:1,sessionNetworking:true}),
  addListener:(kind,listener)=>{if(!listeners.has(kind))listeners.set(kind,new Set());listeners.get(kind).add(listener);return{remove:()=>listeners.get(kind).delete(listener)};},
  startSession:async id=>{started.push(id);queueMicrotask(()=>emit('transportState',{sessionId:id,state:'sessionConnected'}));},stopSession:async id=>{stopped.push(id);},
  request:async(_session,_id,url,_method,headers)=>{if(url.endsWith('/health'))return reply({status:'ok'});assert.ok(headers.authorization===`Bearer ${f.token}`);assert.ok(headers['x-linea-proof']===f.proof());return reply({user:{id:'user-1'}});},cancelRequest:async()=>{},
  socketOpen:async(sessionId,socketId)=>{emit('transportSocket',{sessionId,socketId,kind:'open'});},
  socketSend:async(sessionId,socketId)=>{queueMicrotask(()=>emit('transportSocket',{sessionId,socketId,kind:'message',text:'{"type":"ready"}'}));},socketClose:async()=>{},
 };
 const registry=loadTs(new URL('../src/network/messageRoute.ts',import.meta.url),{},cache);
 const bootstrap=loadTs(new URL('../src/network/transportB/bootstrap.ts',import.meta.url),{},cache);
 const api={base:'https://api.invizent.com',endpoint:'https://api.invizent.com',token:f.token,ensureProof:async()=>{},get proof(){return f.proof();},get authHeaders(){return{Authorization:`Bearer ${f.token}`,'X-Linea-Proof':f.proof()};}};
 const mocks={
  '@react-native-async-storage/async-storage':{getItem:async key=>store.get(key)??null,setItem:async(key,value)=>{if(overrides.diskFailure)throw Error('disk unavailable');store.set(key,value);}},
  'expo-crypto':{randomUUID:()=>`route_session_${++serial}`},'../../api':{CLIENT_HEADER:'invizent; v=0.14.19; p=ios'},
  '../../attest/index':{attestHeaders:()=>({})},'../../deviceKey':{deviceKey:()=>f.key},
  '../../servers/pool':{autoReserve:()=>true,measureServers:async()=>{}},'../messageRoute':registry,
  './config':{TRANSPORT_B_BOOTSTRAPS:[f.origin],TRANSPORT_B_LEASE_KEYS:[f.issuer.publicKeyBase64]},
  './native':{loadTransportBNetworkModule:()=>native},
  './bootstrap':{acquireBootstrap:overrides.acquire??((options,signal)=>bootstrap.acquireBootstrap({...options,fetcher:f.fetcher},signal))},
 };
 const automatic=loadTs(new URL('../src/network/transportB/automatic.ts',import.meta.url),mocks,cache);
 const off=automatic.attachAutomaticTransportB(api,'user-1');t.after(off);
 const recover=()=>registry.updateReserveAvailability({enabled:true,allFailed:true,directStable:false});
 return{...f,registry,store,native,started,stopped,emit,off,recover};
}
test('all failed direct candidates coalesce into one signed, persisted and verified route',async t=>{
 const f=await setup(t);f.recover();f.recover();f.recover();await settled(()=>f.registry.reserveRouteStatus()==='ready');
 assert.equal(f.allocations.length,1);assert.equal(f.started.length,1);assert.deepEqual([...f.store.values()],['1']);
 const response=await f.registry.messageFetch('https://141-133-194-51.nip.io/me',{headers:{Authorization:`Bearer ${f.token}`,'X-Linea-Proof':f.proof()}});assert.equal((await response.json()).user.id,'user-1');
 f.off();assert.equal(f.registry.reserveRouteStatus(),'off');await settled(()=>f.stopped.length>0);
});
test('failed durable replay storage never opens the native session',async t=>{
 const f=await setup(t,{diskFailure:true});f.recover();await settled(()=>f.allocations.length===1&&f.registry.reserveRouteStatus()==='off');assert.equal(f.started.length,0);
});
test('network loss fences the old session and a subsequent attempt uses a fresh sequence',async t=>{
 const f=await setup(t);f.recover();await settled(()=>f.registry.reserveRouteStatus()==='ready');const first=f.started[0];
 f.emit('transportState',{sessionId:first,state:'failed'});await settled(()=>f.registry.reserveRouteStatus()==='off');
 f.registry.resetReserveNetwork();f.recover();await settled(()=>f.registry.reserveRouteStatus()==='ready');assert.equal(f.started.length,2);assert.notEqual(f.started[0],f.started[1]);assert.deepEqual([...f.store.values()],['2']);
 f.emit('transportState',{sessionId:first,state:'failed'});assert.equal(f.registry.reserveRouteStatus(),'ready');
});
test('turning reserve off removes it immediately and stops its native session',async t=>{
 const f=await setup(t);f.recover();await settled(()=>f.registry.reserveRouteStatus()==='ready');
 f.registry.updateReserveAvailability({enabled:false,allFailed:true,directStable:false});assert.equal(f.registry.reserveRouteStatus(),'off');await settled(()=>f.stopped.length>0);
});
test('checking status does not unnecessarily change the message socket route revision',async t=>{
 const f=await setup(t);const previous=f.registry.messageRouteRevision();f.recover();assert.equal(f.registry.messageRouteRevision(),previous);
 await settled(()=>f.registry.reserveRouteStatus()==='ready');assert.equal(f.registry.messageRouteRevision(),previous+1);
});
test('stable direct recovery verifies the real account and ready frame before dropping reserve',async t=>{
 const f=await setup(t);f.recover();await settled(()=>f.registry.reserveRouteStatus()==='ready');
 const previousFetch=globalThis.fetch,previousSocket=globalThis.WebSocket;let requests=0;
 t.after(()=>{globalThis.fetch=previousFetch;globalThis.WebSocket=previousSocket;});
 globalThis.fetch=async address=>{requests++;return new Response(JSON.stringify(String(address).endsWith('/health')?{status:'ok'}:{user:{id:'user-1'}}),{headers:{'content-type':'application/json'}});};
 globalThis.WebSocket=class{readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null;constructor(){queueMicrotask(()=>{this.readyState=1;this.onopen?.({});});}send(){queueMicrotask(()=>this.onmessage?.({data:'{"type":"ready"}'}));}close(){this.readyState=3;this.onclose?.({code:1000});}};
 f.registry.updateReserveAvailability({enabled:true,allFailed:false,directStable:true});await settled(()=>f.registry.reserveRouteStatus()==='off');assert.equal(requests,2);assert.ok(f.stopped.length>0);
});
test('a cancelled bootstrap cannot publish its route after account cleanup',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let f;
 const bootstrap=loadTs(new URL('../src/network/transportB/bootstrap.ts',import.meta.url));
 f=await setup(t,{acquire:async(options,signal)=>{const offer=await bootstrap.acquireBootstrap({...options,fetcher:f.fetcher},signal);await gate;return offer;}});
 f.recover();await settled(()=>f.allocations.length===1);f.off();release();await tick();await tick();assert.equal(f.started.length,0);assert.equal(f.registry.reserveRouteStatus(),'off');
});
