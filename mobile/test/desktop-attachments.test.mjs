import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { desktopSignalBridge } from '../../desktop/signal.mjs';
import { loadTs } from './support/load-ts.mjs';
test('desktop chunked upload resumes after a lost completion and removes corrupt partial downloads',async()=>{
 const original=globalThis.fetch,cache=new Map(),parts=[];let lost=true,received=0,state;
 const plain=Buffer.alloc(20*1024*1024+517);for(let i=0;i<plain.length;i+=103)plain[i]=i%251;
 const fs={cacheDirectory:'invizent-cache://local/',deleteAsync:async uri=>cache.delete(uri),makeDirectoryAsync:async()=>{}};
 const files=async(method,[target,bytes])=>{if(method==='append')cache.set(target,Buffer.concat([cache.get(target)||Buffer.alloc(0),bytes]));else if(method==='write')cache.set(target,Buffer.from(bytes));else throw new Error('Unexpected file method');};
 let corrupt=false;
 globalThis.fetch=async(url,options)=>{
  if(url==='blob:input')return new Response(plain);
  assert.equal(url,'https://file.test/upload');assert.equal(options.headers.Authorization,'Bearer test-token');
  const match=/bytes=(\d+)-(\d+)/.exec(options.headers.Range),start=Number(match[1]),end=Number(match[2]);
  const bytes=Buffer.from(Buffer.concat(parts).subarray(start,end+1));if(corrupt&&start>0)bytes[0]^=1;
  return new Response(bytes,{status:206});
 };
 try{
  const model=loadTs(new URL('../src/e2ee/attachments.web.ts',import.meta.url),{
   'expo-crypto':{getRandomBytesAsync:async size=>randomBytes(size),randomUUID},
   '../desktopFs.web':fs,'../desktop':{desktopBridge:()=>({files})},
   '../api':{},'./signal':{getSignalBridge:()=>desktopSignalBridge},'../media/pipeline.web':{},
  });
  let putCalls=0;
  const api={token:'test-token',fileUrl:()=> 'https://file.test/upload',async request(url,options){
   if(url==='/e2ee/limits')return {maxFileBytes:100*1024*1024};
   if(url==='/e2ee/uploads')return {id:'session'};
   if(url==='/e2ee/uploads/session')return {received};
   if(url.startsWith('/e2ee/uploads/session?offset=')){assert.equal(Number(url.split('=')[1]),received);parts.push(Buffer.from(options.body));received+=options.body.length;putCalls++;return {};}
   if(url==='/e2ee/uploads/session/complete'){if(lost){lost=false;throw new Error('connection lost after last chunk');}return {id:'upload',size:received};}
   throw new Error('Unexpected URL '+url);
  }};
  const file={uri:'blob:input',name:'large.bin',mimeType:'application/octet-stream',size:plain.length};
  await assert.rejects(model.encryptAndUploadLarge(api,file,{onState:value=>state=value}),/connection lost/);
  const before=putCalls,attachment=await model.encryptAndUploadLarge(api,file,{state});assert.equal(putCalls,before,'completed chunks are not uploaded again');
  assert.equal(received,model.chunkedCipherSize(plain.length));
  await model.decryptAttachmentWithProgress(api,attachment,()=>{},'invizent-cache://local/result');assert.deepEqual(cache.get('invizent-cache://local/result'),plain);
  corrupt=true;await assert.rejects(model.decryptAttachmentWithProgress(api,attachment,()=>{},'invizent-cache://local/corrupt'));assert.equal(cache.has('invizent-cache://local/corrupt'),false);
 }finally{globalThis.fetch=original;}
});

test('desktop: a small MP4 with a video track named and typed as audio is cleaned, never sent raw', async () => {
 const { bigMp4 } = await import('./support/stream-fixtures.mjs');
 const { bytes } = bigMp4({ gap: 4096 });
 assert.ok(bytes.includes(Buffer.from('GPS-SECRET')), 'the fixture carries a location');
 const original = globalThis.fetch, cache = new Map(), parts = []; let received = 0, small = null;
 const fs = { cacheDirectory: 'invizent-cache://local/', deleteAsync: async uri => cache.delete(uri), makeDirectoryAsync: async () => {} };
 const files = async (method, [target, data]) => { if (method === 'write') cache.set(target, Buffer.from(data)); else if (method === 'append') cache.set(target, Buffer.concat([cache.get(target) || Buffer.alloc(0), data])); else throw new Error('Unexpected file method ' + method); };
 globalThis.fetch = async url => {
  if (url === 'blob:clip') return new Response(bytes);
  if (url === 'https://file.test/upload') return new Response(Buffer.concat(parts), { status: 200 });
  throw new Error('Unexpected fetch ' + url);
 };
 try {
  const model = loadTs(new URL('../src/e2ee/attachments.web.ts', import.meta.url), {
   'expo-crypto': { getRandomBytesAsync: async size => randomBytes(size), randomUUID },
   '../desktopFs.web': fs, '../desktop': { desktopBridge: () => ({ files }) },
   '../api': { multipartFile: body => { small = Buffer.from(body); return { body, contentType: 'application/octet-stream' }; } },
   './signal': { getSignalBridge: () => desktopSignalBridge },
   // The 20 MB pipeline does not treat an audio-typed file as video: it hands the bytes back unchanged.
   '../media/pipeline.web': { prepareMediaForUpload: async file => ({ file: { ...file, size: bytes.length }, photo: false, video: false, dispose: async () => {} }) },
  });
  const api = { token: 'test-token', fileUrl: () => 'https://file.test/upload', async request(url, options) {
   if (url === '/e2ee/limits') return { maxFileBytes: 100 * 1024 * 1024, maxVideoBytes: 100 * 1024 * 1024 };
   if (url === '/e2ee/uploads') return { id: 'session' };
   if (url.startsWith('/e2ee/uploads/session?offset=')) { parts.push(Buffer.from(options.body)); received += options.body.length; return {}; }
   if (url === '/e2ee/uploads/session/complete') return { id: 'upload', size: received };
   if (url === '/e2ee/files') return { id: 'small', size: small?.length ?? 0 };
   throw new Error('Unexpected URL ' + url);
  } };
  const attachment = await model.encryptAndUpload(api, { uri: 'blob:clip', name: 'clip.m4a', mimeType: 'audio/mp4', size: bytes.length });
  assert.equal(small, null, 'not sealed as a raw small file');
  await model.decryptAttachmentWithProgress(api, attachment, () => {}, 'invizent-cache://local/out');
  const out = cache.get('invizent-cache://local/out');
  assert.equal(out.length, bytes.length);
  assert.equal(out.includes(Buffer.from('GPS-SECRET')), false, 'location removed');
 } finally { globalThis.fetch = original; }
});
