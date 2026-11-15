import assert from 'node:assert/strict';
import test from 'node:test';
import {fromByteArray} from 'base64-js';
import {loadTs} from './support/load-ts.mjs';
const {TransportBSessionRoute,verifyMessageService}=loadTs(new URL('../src/network/transportB/route.ts',import.meta.url));
const origin='https://api.invizent.com',sessionId='session_attempt_123';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(verify) {
 const listeners=new Map(),requests=[],stops=[],writes=[],cancelled=[];
 const emit=(name,value)=>{for(const callback of [...(listeners.get(name)||[])])callback(value);};
 const reply=(value,status=200)=>({status,headers:{'content-type':'application/json'},body:fromByteArray(new TextEncoder().encode(JSON.stringify(value)))});
 const native={capabilities:()=>({protocol:1,nativeSession:true,appRouting:false,networkProtocol:1,sessionNetworking:true}),
  addListener(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);return {remove:()=>listeners.get(name).delete(callback)};},
  startSession:async()=>{},stopSession:async id=>{stops.push(id);},
  request:async(...args)=>{requests.push(args);return reply(args[2].endsWith('/health')?{status:'ok'}:{user:{id:'user-1'}});},
  cancelRequest:async(...args)=>{cancelled.push(args);},
  socketOpen:async(id,socketId)=>{emit('transportSocket',{sessionId:id,socketId,kind:'open'});},
  socketSend:async(id,socketId,text)=>{writes.push(text);if(JSON.parse(text).type==='auth')queueMicrotask(()=>emit('transportSocket',{sessionId:id,socketId,kind:'message',text:'{"type":"ready"}'}));},
  socketClose:async()=>{}};
 const route=new TransportBSessionRoute(native,sessionId,origin,verify||verifyMessageService('user-1',async()=>({headers:{Authorization:'Bearer fixture'},auth:{type:'auth',token:'fixture'}})));
 const connected=()=>emit('transportState',{sessionId,state:'sessionConnected'});
 return {route,native,emit,connected,requests,stops,writes,cancelled,reply};
}
async function ready(f) {const started=f.route.start('wbstream://fixture123',new AbortController().signal);f.connected();await started;}

test('resolved start and unrelated connected event never establish an application route',async()=>{
 const f=fixture(),abort=new AbortController(),started=f.route.start('wbstream://fixture123',abort.signal);
 await tick();assert.equal(f.route.ready,false);assert.equal(f.requests.length,0);
 f.emit('transportState',{sessionId:'other_session',state:'sessionConnected'});await tick();assert.equal(f.requests.length,0);
 abort.abort();await assert.rejects(started,{name:'AbortError'});assert.equal(f.stops.length,1);
 f.connected();assert.equal(f.route.ready,false);
});
test('ready requires TLS health, matching authenticated identity and WSS ready',async()=>{
 const f=fixture();await ready(f);assert.equal(f.route.ready,true);
 assert.deepEqual(f.requests.map(x=>x[2]),[origin+'/health',origin+'/me']);
 assert.equal(f.requests[1][4].authorization,'Bearer fixture');assert.equal(JSON.parse(f.writes[0]).type,'auth');
 await f.route.stop();assert.equal(f.route.ready,false);
});
test('captured portal, denied authentication and wrong account never become ready',async()=>{
 for(const answer of [f=>f.reply({status:'portal'}),f=>f.reply({error:'unauthorized'},401),f=>f.reply({user:{id:'someone-else'}})]){
  const f=fixture();const original=f.native.request;
  f.native.request=async(...args)=>{if(args[2].endsWith('/me')||answer(f).status===200&&JSON.parse(Buffer.from(answer(f).body,'base64')).status==='portal')return answer(f);return original(...args);};
  const started=f.route.start('wbstream://fixture123',new AbortController().signal);f.connected();await assert.rejects(started);assert.equal(f.route.ready,false);assert.equal(f.stops.length,1);
 }
});
test('stop cancels a verifier that never resolves and fences late success',async()=>{
 const pending=deferred(),f=fixture(()=>pending.promise);
 const started=f.route.start('wbstream://fixture123',new AbortController().signal);f.connected();await tick();await f.route.stop();
 await assert.rejects(started,{name:'AbortError'});pending.resolve();await tick();assert.equal(f.route.ready,false);
});
test('network loss closes sockets, rejects new work and ignores stale events',async()=>{
 const f=fixture();await ready(f);const socket=f.route.openSocket(origin.replace('https:','wss:')+'/ws');await tick();assert.equal(socket.readyState,1);
 let closed=0;socket.onclose=()=>closed++;
 f.emit('transportState',{sessionId,state:'failed'});await tick();assert.equal(f.route.ready,false);assert.equal(socket.readyState,3);assert.equal(closed,1);
 await assert.rejects(f.route.fetch(origin+'/me'));f.connected();assert.equal(f.route.ready,false);
});
test('an uncertain write is never repeated and caller cancellation reaches native',async()=>{
 const f=fixture();await ready(f);let applied=0;
 f.native.request=async()=>{applied++;throw Error('response lost after applying');};
 await assert.rejects(f.route.fetch(origin+'/messages',{method:'POST',body:'encrypted'}));assert.equal(applied,1);
 const pending=deferred();f.native.request=()=>pending.promise;
 const abort=new AbortController();const request=f.route.fetch(origin+'/me',{signal:abort.signal});abort.abort();await assert.rejects(request,{name:'AbortError'});
 assert.equal(f.cancelled.length,1);pending.resolve(f.reply({user:{id:'user-1'}}));await f.route.stop();
});
test('rejects a foreign destination and unsupported stream before native dispatch',async()=>{
 const f=fixture();await ready(f);const count=f.requests.length;
 await assert.rejects(f.route.fetch('https://example.com/me'));
 await assert.rejects(f.route.fetch(origin+'/files',{method:'POST',body:new ReadableStream()}));
 assert.equal(f.requests.length,count);await f.route.stop();
});
test('socket writes remain ordered and stale session frames cannot enter the socket',async()=>{
 const f=fixture();await ready(f);const socket=f.route.openSocket(origin.replace('https:','wss:')+'/ws');await tick();
 const sent=[],pending=deferred();f.native.socketSend=async(_id,_socket,text)=>{sent.push(text);if(text==='one')await pending.promise;};
 let messages=0;socket.onmessage=()=>messages++;
 f.emit('transportSocket',{sessionId:'old_attempt',socketId:socket.id,kind:'message',text:'stale'});assert.equal(messages,0);
 socket.send('one');socket.send('two');await tick();assert.deepEqual(sent,['one']);pending.resolve();await tick();assert.deepEqual(sent,['one','two']);await f.route.stop();
});
