import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApi, startCarrier, exchange, sendWithFallback } from './lab.mjs';

const dir=mkdtempSync(join(tmpdir(),'invizent-allowlist-'));
execFileSync('openssl',[
  'req','-x509','-newkey','rsa:2048','-noenc',
  '-keyout',join(dir,'server.key'),'-out',join(dir,'ca.crt'),
  '-subj','/CN=api.lab.test','-addext','subjectAltName=DNS:api.lab.test','-days','1',
],{stdio:'ignore'});
const ca=readFileSync(join(dir,'ca.crt')),key=readFileSync(join(dir,'server.key'));
let api,carrier;
test.before(async()=>{
  api=await startTestApi({key,cert:ca});
  carrier=await startCarrier({targetHost:'127.0.0.1',targetPort:api.address.port});
});
test.after(async()=>{
  await Promise.all([
    new Promise(resolve=>carrier.server.close(resolve)),
    new Promise(resolve=>api.server.close(resolve)),
  ]);
  rmSync(dir,{recursive:true,force:true});
});
const primary=()=>({host:'127.0.0.1',port:api.address.port});
const reserve=()=>({host:'127.0.0.1',port:carrier.address.port});

test('normal network: verified TLS reaches direct API',async()=>{
  const r=await sendWithFallback({primary:primary(),reserve:reserve(),ca,clientId:'normal-1'});
  assert.equal(r.route,'direct');
  assert.deepEqual(r.attempts.map(x=>x.name),['direct']);
  assert.equal(r.response.firstDelivery,true);
});
test('simulated IP allowlist: direct blocked, carrier transports TLS',async()=>{
  const r=await sendWithFallback({primary:primary(),reserve:reserve(),ca,clientId:'restricted-1',policy:name=>name==='reserve'});
  assert.equal(r.route,'reserve');
  assert.deepEqual(r.attempts,[
    {name:'direct',outcome:'not_on_allowlist'},
    {name:'reserve',outcome:'delivered'}
  ]);
  assert.equal(r.response.firstDelivery,true);
  assert.equal(carrier.stats().connections>0,true);
});
test('no allowed route: offline without false delivered result',async()=>{
  const r=await sendWithFallback({primary:primary(),reserve:reserve(),ca,clientId:'blocked-all',policy:()=>false});
  assert.equal(r.route,'offline');
  assert.equal(r.response,null);
});
test('TLS identity survives carrier; mismatched certificate host rejected',async()=>{
  await assert.rejects(exchange({...reserve(),ca,servername:'allowed.sfu.test',clientId:'bad-cert'}),/certificate|Hostname|altname/i);
  assert.equal(api.seen.has('bad-cert'),false);
});
test('retry with stable ID does not create a second logical message',async()=>{
  const first=await exchange({...reserve(),ca,clientId:'dedup-1'});
  const second=await exchange({...reserve(),ca,clientId:'dedup-1'});
  assert.equal(first.firstDelivery,true);assert.equal(second.firstDelivery,false);
  assert.equal(first.storedMessages,second.storedMessages);
});
test('unreachable allowed carrier yields offline, not success',async()=>{
  const r=await sendWithFallback({primary:primary(),reserve:{host:'127.0.0.1',port:1},ca,clientId:'unreachable-1',policy:name=>name==='reserve'});
  assert.equal(r.route,'offline');
  assert.deepEqual(r.attempts.map(x=>x.outcome),['not_on_allowlist','unreachable']);
});
