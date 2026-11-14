import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { makeLeaseIssuer } from '../../prototype/transport-b/src/lease-issuer.mjs';
import { loadTs } from './support/load-ts.mjs';

const { TransportBController } = loadTs(new URL('../src/network/transportB/controller.ts', import.meta.url));
const keys = generateKeyPairSync('ed25519');
const issuer = makeLeaseIssuer({
  privateKey:keys.privateKey.export({format:'pem',type:'pkcs8'}),
  now:()=>1_000_000,
  nextSequence:async()=>4,
});
const signed = () => issuer.issue({deviceId:'testdevice_001',joinLink:'wbstream://room_123456789',expiresAt:1_100_000});

function setup(overrides = {}) {
  const calls = [];
  let sequence = 3;
  const options = {
    deviceId:'testdevice_001',realm:'https://api.invizent.com',
    publicKeys:[issuer.publicKeyBase64],
    now:()=>1_010_000,
    acquire: async()=> signed(),
    loadSequence: async()=>sequence,
    saveSequence:async n=>{sequence=n;},
    joiner:{
      start:async(link,signal)=>{calls.push(['start',link,signal.aborted]);},
      stop:async()=>{calls.push(['stop']);},
    },
    ...overrides,
  };
  return {controller:new TransportBController(options),calls,getSequence:()=>sequence};
}

test('accepts a signed device lease, persists replay watermark and starts the native adapter once',async()=>{
  const {controller,calls,getSequence}=setup();
  const states=[];const off=controller.subscribe(s=>states.push(s));
  assert.equal(await controller.start(),true);
  assert.equal(controller.status,'connected');
  assert.equal(getSequence(),4);
  assert.equal(await controller.start(),true);
  assert.deepEqual(calls,[['start','wbstream://room_123456789',false]]);
  assert.deepEqual(states,['requesting','connecting','connected']);
  off();await controller.stop();
  assert.equal(controller.status,'idle');
  assert.deepEqual(calls[1],['stop']);
});

test('deduplicates simultaneous connection attempts',async()=>{
  let release;
  const acquired = new Promise(resolve=>{release=resolve;});
  const {controller,calls}=setup({acquire:async()=>acquired});
  const first=controller.start(), second=controller.start();
  assert.equal(first,second);
  release(await signed());
  assert.equal(await first,true);
  assert.equal(calls.filter(x=>x[0]==='start').length,1);
  await controller.stop();
});

test('badly signed or wrong-device session must not reach the native adapter',async()=>{
  const good=await signed();
  for(const lease of [{...good,payload:good.payload.replace('room_123456789','room_hijacked')},await issuer.issue({deviceId:'another_device_01',joinLink:'wbstream://room_123456789',expiresAt:1_100_000})]){
    const {controller,calls}=setup({acquire:async()=>lease});
    assert.equal(await controller.start(),false);
    assert.equal(controller.status,'unavailable');
    assert.deepEqual(calls,[['stop']]);
  }
});

test('expired lease and replayed sequence are rejected',async()=>{
  for(const overrides of [{now:()=>1_100_001},{loadSequence:async()=>4}]){
    const {controller,calls}=setup(overrides);
    assert.equal(await controller.start(),false);
    assert.equal(calls.some(x=>x[0]==='start'),false);
  }
});

test('sequence storage failure is fail-closed: no connection is opened',async()=>{
  const {controller,calls}=setup({saveSequence:async()=>{throw new Error('disk failed');}});
  assert.equal(await controller.start(),false);
  assert.equal(calls.some(x=>x[0]==='start'),false);
});

test('stopping during native initialization cannot return a live session',async()=>{
  let finish;
  const waiter=new Promise(resolve=>{finish=resolve;});
  const {controller,calls}=setup({joiner:{
    start:async(link)=>{calls.push(['start',link]);await waiter;},
    stop:async()=>{calls.push(['stop']);},
  }});
  const pending=controller.start();
  // Allow the async sequence and signature checks to reach the native adapter.
  for(let i=0;i<10&&!calls.some(x=>x[0]==='start');i++) await Promise.resolve();
  assert.equal(calls[0][0],'start');
  await controller.stop();
  finish();
  assert.equal(await pending,false);
  assert.equal(controller.status,'idle');
  assert.equal(calls.filter(x=>x[0]==='stop').length>=2,true);
});

test('bootstrap failure remains offline and never uses an arbitrary fallback link',async()=>{
  const {controller,calls}=setup({acquire:async()=>{throw new Error('offline');}});
  assert.equal(await controller.start(),false);
  assert.equal(controller.status,'unavailable');
  assert.equal(calls.some(x=>x[0]==='start'),false);
});

test('subscriber failure cannot crash the transport state machine',async()=>{
  const {controller}=setup();
  controller.subscribe(()=>{throw Error('subscriber fault');});
  assert.equal(await controller.start(),true);
  await controller.stop();
});
