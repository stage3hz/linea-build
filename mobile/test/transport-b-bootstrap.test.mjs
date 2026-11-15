import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {bootstrapFixture} from '../../prototype/transport-b/test/support/bootstrap-fixture.mjs';
import {loadTs} from './support/load-ts.mjs';
const {acquireBootstrap,bootstrapOrigin}=loadTs(new URL('../src/network/transportB/bootstrap.ts',import.meta.url));
const {verifyTransportBLease}=loadTs(new URL('../src/network/transportB/lease.ts',import.meta.url));
const options=f=>({origins:[f.origin],token:f.token,key:()=>f.key,headers:()=>({'X-Linea-Client':'invizent; v=0.14.19; p=ios'}),fetcher:f.fetcher});

test('cold bootstrap uses only its independent origin and proves the existing device before allocating',async t=>{
 const f=await bootstrapFixture();t.after(f.close);
 const offer=await acquireBootstrap(options(f),new AbortController().signal);
 assert.equal(offer.deviceId,f.sessionId);assert.equal(offer.proof,f.proof());assert.deepEqual(f.allocations,[f.sessionId]);
 assert.deepEqual(f.primaryCalls,['/auth/device/challenge','/auth/device/proof','/auth/sessions']);
 const lease=verifyTransportBLease(offer.signed,[f.issuer.publicKeyBase64],{deviceId:f.sessionId,realm:'https://api.invizent.com',now:Date.now(),minSequence:0});
 assert.equal(lease.provider,'wbstream');
 const second=await acquireBootstrap(options(f),new AbortController().signal);
 const next=verifyTransportBLease(second.signed,[f.issuer.publicKeyBase64],{deviceId:f.sessionId,realm:'https://api.invizent.com',now:Date.now(),minSequence:lease.sequence});
 assert.ok(next.sequence>lease.sequence);
});
test('a copied token with another device key cannot allocate a session',async t=>{
 const f=await bootstrapFixture();t.after(f.close);const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const stolen={...f.key,sign:async message=>sign('sha256',Buffer.from(message),other.privateKey).toString('base64url')};
 await assert.rejects(acquireBootstrap({...options(f),key:()=>stolen},new AbortController().signal));assert.deepEqual(f.allocations,[]);
});
test('unbound sessions and fake proof values fail closed',async t=>{
 const f=await bootstrapFixture();t.after(f.close);
 let response=await f.fetcher(f.origin+'/v1/transport-b/session',{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'X-Linea-Proof':'a'.repeat(43),'X-Linea-Client':'invizent; v=0.14.19; p=ios'},body:'{}'});
 assert.equal(response.status,401);assert.deepEqual(f.allocations,[]);
 f.setBound(false);await assert.rejects(acquireBootstrap(options(f),new AbortController().signal));assert.deepEqual(f.allocations,[]);
});
test('bootstrap cannot become an arbitrary proxy or accept an asserted device id',async t=>{
 const f=await bootstrapFixture();t.after(f.close);const headers={Authorization:`Bearer ${f.token}`,'X-Linea-Proof':'x'.repeat(43),'X-Linea-Client':'invizent; v=0.14.19; p=ios'};
 for(const path of ['/me','/uploads','/auth/device/challenge?url=https://example.com']){
  const response=await f.fetcher(f.origin+path,{method:'POST',headers,body:'{}'});assert.equal(response.status,404);
 }
 const response=await f.fetcher(f.origin+'/v1/transport-b/session',{method:'POST',headers,body:JSON.stringify({deviceId:'victim_device'})});assert.equal(response.status,400);assert.deepEqual(f.allocations,[]);
});
test('rejects primary-only, foreign, credentialed and plaintext bootstrap configuration',async()=>{
 for(const value of ['https://api.invizent.com','http://bootstrap.invizent.com','https://example.com','https://u:p@bootstrap.invizent.com','https://bootstrap.invizent.com/path','https://bootstrap.invizent.com:444'])assert.equal(bootstrapOrigin(value),null);
 assert.equal(bootstrapOrigin('https://bootstrap.invizent.com'),'https://bootstrap.invizent.com');
});
test('a cancelled cold start performs no request',async()=>{
 const abort=new AbortController();abort.abort();let calls=0;
 await assert.rejects(acquireBootstrap({origins:['https://bootstrap.invizent.com'],token:'fixture',key:()=>({}),headers:()=>({}),fetcher:async()=>{calls++;throw Error('offline');}},abort.signal),{name:'AbortError'});assert.equal(calls,0);
});
test('bootstrap global request budget bounds work even across random token buckets',async t=>{
 const f=await bootstrapFixture();t.after(f.close);let last;
 for(let i=0;i<121;i++)last=await f.fetcher(f.origin+'/auth/device/challenge',{method:'POST',headers:{Authorization:`Bearer ${String(i).padStart(43,'x')}`},body:'{}'});
 assert.equal(last.status,429);assert.ok(f.primaryCalls.length<=120);assert.equal(f.allocations.length,0);
});
