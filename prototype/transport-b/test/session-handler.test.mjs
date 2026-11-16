import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { makeLeaseIssuer } from '../src/lease-issuer.mjs';
import { makeSessionHandler } from '../src/session-handler.mjs';

const deviceId = 'device-for-tests-12', realm = 'https://api.invizent.com';
const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({format:'pem',type:'pkcs8'});
const now = 1_000_000;

function setup({ auth = true, capacity = true, provider = 'wbstream' } = {}) {
  let allocations = 0, authentications = 0, sequence = 2;
  const pool = {
    async acquire(id) {
      allocations++;
      assert.equal(id, deviceId);
      if (!capacity) throw new Error('process or capacity internal secrets');
      return {joinLink:provider==='telemost'?'https://telemost.yandex.ru/j/1234567890123':'wbstream://room_123456789', expiresAt:now+120_000};
    },
  };
  const issuer = makeLeaseIssuer({privateKey,now:()=>now,nextSequence:async()=>++sequence,provider});
  const authenticate = async (token, proof) => {
    authentications++;
    if (!auth || token !== 'Bearer test-token-at-least-16-chars' || proof !== 'valid-device-proof') return null;
    return {deviceId,realm};
  };
  const server = createServer(makeSessionHandler({pool,issuer,authenticate}));
  return {server,issuer,getCounts:()=>({allocations,authentications})};
}
async function withServer(args, fn) {
  const instance = setup(args);
  await new Promise(resolve => instance.server.listen(0,'127.0.0.1',resolve));
  try {
    const address = instance.server.address();
    return await fn('http://127.0.0.1:'+address.port,instance);
  } finally {
    await new Promise((resolve,reject)=>instance.server.close(e=>e?reject(e):resolve()));
  }
}
const headers = {authorization:'Bearer test-token-at-least-16-chars','x-linea-proof':'valid-device-proof'};

test('device-authorized request returns Ed25519-signed lease with no caching',async()=>{
  await withServer({},async(url,instance)=>{
    const r=await fetch(url+'/v1/transport-b/session',{method:'POST',headers});
    assert.equal(r.status,200);
    assert.match(r.headers.get('cache-control'),/no-store/);
    assert.equal(r.headers.get('access-control-allow-origin'),null);
    const signed=await r.json();
    const key=Buffer.from(instance.issuer.publicKeyBase64,'base64');
    const spki=Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key]);
    const publicKey= {key:spki,format:'der',type:'spki'};
    assert.equal(verify(null,Buffer.from(signed.payload),publicKey,Buffer.from(signed.sig,'base64')),true);
    const payload=JSON.parse(signed.payload);
    assert.deepEqual({provider:payload.provider,deviceId:payload.deviceId,realm:payload.realm,sequence:payload.sequence}, {provider:'wbstream',deviceId,realm,sequence:3});
    assert.equal(instance.getCounts().allocations,1);
  });
});

test('neither unauthenticated callers nor wrong device proofs allocate sessions',async()=>{
  await withServer({},async(url,instance)=>{
    for(const h of [{},{authorization:headers.authorization},{...headers,'x-linea-proof':'something-else'}]){
      const r=await fetch(url+'/v1/transport-b/session',{method:'POST',headers:h});
      assert.equal(r.status,401);
    }
    assert.equal(instance.getCounts().allocations,0);
  });
});

test('a forged body cannot override deviceId or session link',async()=>{
  await withServer({},async(url,instance)=>{
    for(const body of ['{"deviceId":"target-account"}','{"joinLink":"wbstream://secret"}','{"provider":"telemost"}','[]','undefined']){
      const r=await fetch(url+'/v1/transport-b/session',{method:'POST',headers:{...headers,'content-type':'application/json'},body});
      assert.equal(r.status,400);
    }
    assert.equal(instance.getCounts().allocations,0);
  });
});

test('configured Telemost issuer signs only its own provider and canonical links',async()=>{
  let sequence=0;
  const issuer=makeLeaseIssuer({privateKey,provider:'telemost',now:()=>now,nextSequence:async()=>++sequence});
  const link='https://telemost.yandex.ru/j/1234567890123';
  const signed=await issuer.issue({deviceId,joinLink:link,expiresAt:now+1000});
  assert.equal(verify(null,Buffer.from(signed.payload),keys.publicKey,Buffer.from(signed.sig,'base64')),true);
  const lease=JSON.parse(signed.payload);
  assert.equal(lease.provider,'telemost');
  assert.equal(lease.joinLink,link);
  for(const joinLink of ['wbstream://room_123456789',link+'\n',link+'?token=secret','https://telemost.yandex.ru.evil/j/123'])
    await assert.rejects(issuer.issue({deviceId,joinLink,expiresAt:now+1000}),/join link/);
  await assert.rejects(issuer.issue({deviceId,joinLink:link,expiresAt:now+1000,provider:'wbstream'}),/provider/);
  assert.equal(sequence,1,'invalid offers never advance persistent sequence');
  assert.throws(()=>makeLeaseIssuer({privateKey,nextSequence:async()=>1,provider:'vk'}),/provider/);
  const wb=makeLeaseIssuer({privateKey,nextSequence:async()=>1,now:()=>now});
  await assert.rejects(wb.issue({deviceId,joinLink:link,expiresAt:now+1000}),/join link/);
});

test('authorized session allocation preserves the configured Telemost provider',async()=>{
  await withServer({provider:'telemost'},async(url,instance)=>{
    const r=await fetch(url+'/v1/transport-b/session',{method:'POST',headers});
    assert.equal(r.status,200);
    const signed=await r.json();
    assert.equal(verify(null,Buffer.from(signed.payload),keys.publicKey,Buffer.from(signed.sig,'base64')),true);
    const lease=JSON.parse(signed.payload);
    assert.equal(lease.provider,'telemost');
    assert.equal(lease.joinLink,'https://telemost.yandex.ru/j/1234567890123');
    assert.equal(lease.deviceId,deviceId);
    assert.equal(instance.getCounts().allocations,1);
  });
});

test('body size is bounded',async()=>{
  await withServer({},async(url,instance)=>{
    const r=await fetch(url+'/v1/transport-b/session',{method:'POST',headers,body:JSON.stringify({junk:'x'.repeat(1024)})});
    assert.equal(r.status,400);
    assert.equal(instance.getCounts().allocations,0);
  });
});

test('unavailable creator yields generic 503 and no leaked secrets',async()=>{
  await withServer({capacity:false},async url=>{
    const r=await fetch(url+'/v1/transport-b/session',{method:'POST',headers});
    assert.equal(r.status,503);
    assert.deepEqual(await r.json(),{error:'no_capacity_or_route'});
  });
});

test('invalid path or method is rejected with no creator invocation',async()=>{
  await withServer({},async(url,instance)=>{
    assert.equal((await fetch(url+'/')).status,404);
    assert.equal((await fetch(url+'/v1/transport-b/session',{method:'GET',headers})).status,404);
    assert.equal(instance.getCounts().allocations,0);
  });
});

test('issuer requires Ed25519 and valid device/session boundaries',async()=>{
  assert.throws(()=>makeLeaseIssuer({nextSequence:async()=>1}),/privateKey/);
  const issuer=makeLeaseIssuer({privateKey,now:()=>now,nextSequence:async()=>0});
  await assert.rejects(issuer.issue({deviceId:'bad',joinLink:'wbstream://room_123456789',expiresAt:now+1000}),/device/);
  await assert.rejects(issuer.issue({deviceId,joinLink:'http://evil',expiresAt:now+1000}),/join link/);
  await assert.rejects(issuer.issue({deviceId,joinLink:'wbstream://room_123456789',expiresAt:now+31*60_000}),/lifetime/);
});

test('issuer refuses invalid/non-monotonic sequence source output',async()=>{
  const issuer=makeLeaseIssuer({privateKey,now:()=>now,nextSequence:async()=>-1});
  await assert.rejects(issuer.issue({deviceId,joinLink:'wbstream://room_123456789',expiresAt:now+1000}),/sequence/);
});
