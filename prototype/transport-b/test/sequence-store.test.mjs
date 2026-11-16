import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSequenceStore } from '../src/sequence-store.mjs';

test('sequence values survive process-like close and reopen',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'invizent-lease-'));
  const file=join(dir,'secure','seq.sqlite');
  try {
    let store=openSequenceStore(file);
    assert.equal(await store.nextSequence('testdevice_0001'),1);
    assert.equal(await store.nextSequence('testdevice_0001'),2);
    assert.equal(await store.nextSequence('testdevice_0002'),1);
    store.close();
    store=openSequenceStore(file);
    assert.equal(await store.nextSequence('testdevice_0001'),3);
    assert.equal(await store.nextSequence('testdevice_0002'),2);
    store.close();
    assert.equal(statSync(file).mode&0o777,0o600);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('invalid device IDs are rejected before hitting SQLite',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'invizent-lease-'));
  const store=openSequenceStore(join(dir,'seq.sqlite'));
  try {
    for(const device of ['x','',"' OR 1=1 --",'bad/name','a'.repeat(200)])
      await assert.rejects(store.nextSequence(device),/device ID/);
    assert.equal(await store.nextSequence('testdevice_0001'),1);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('database path must be absolute',()=>{
  assert.throws(()=>openSequenceStore('../seq.sqlite'),/absolute/);
  assert.throws(()=>openSequenceStore(undefined),/absolute/);
});

test('signing issuer can use persisted anti-replay sequence',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'invizent-lease-'));
  const store=openSequenceStore(join(dir,'seq.sqlite'));
  try {
    const { generateKeyPairSync }=await import('node:crypto');
    const { makeLeaseIssuer }=await import('../src/lease-issuer.mjs');
    const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});
    const issuer=makeLeaseIssuer({privateKey:key,now:()=>100_000,nextSequence:store.nextSequence});
    const a=await issuer.issue({deviceId:'testdevice_0001',joinLink:'wbstream://room_123456789',expiresAt:200_000});
    const b=await issuer.issue({deviceId:'testdevice_0001',joinLink:'wbstream://room_123456789',expiresAt:200_000});
    assert.equal(JSON.parse(a.payload).sequence,1);
    assert.equal(JSON.parse(b.payload).sequence,2);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
