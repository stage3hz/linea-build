import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { makeLeaseIssuer } from '../../prototype/transport-b/src/lease-issuer.mjs';
import { loadTs } from './support/load-ts.mjs';

const { verifyTransportBLease } = loadTs(new URL('../src/network/transportB/lease.ts', import.meta.url));
const keys = generateKeyPairSync('ed25519');
const issuer = makeLeaseIssuer({
  privateKey:keys.privateKey.export({format:'pem',type:'pkcs8'}),
  now:()=>1_000_000,
  nextSequence:async()=>21,
});
const expected = {deviceId:'testdevice001',realm:'https://api.invizent.com',now:1_010_000,minSequence:20};

test('actual server-side Ed25519 signed offer is accepted by the mobile verifier',async()=>{
  const lease=await issuer.issue({
    deviceId:expected.deviceId,joinLink:'wbstream://room_123456789',expiresAt:1_100_000,
  });
  assert.equal(verifyTransportBLease(lease,[issuer.publicKeyBase64],expected)?.sequence,21);
  assert.equal(verifyTransportBLease(lease,[issuer.publicKeyBase64],{...expected,deviceId:'anotherdevice1'}),null);
});

test('mobile verifier rejects a server-signed lease after expiration, revocation, or realm change',async()=>{
  const lease=await issuer.issue({
    deviceId:expected.deviceId,joinLink:'wbstream://room_123456789',expiresAt:1_100_000,
  });
  assert.equal(verifyTransportBLease(lease,[issuer.publicKeyBase64],{...expected,now:1_100_001}),null);
  assert.equal(verifyTransportBLease(lease,[issuer.publicKeyBase64],{...expected,minSequence:21}),null);
  assert.equal(verifyTransportBLease(lease,[issuer.publicKeyBase64],{...expected,realm:'https://evil.example'}),null);
});

test('configured Telemost issuer interoperates with mobile validation and persistent replay checks',async()=>{
  const telemost = makeLeaseIssuer({
    provider:'telemost',
    privateKey:keys.privateKey.export({format:'pem',type:'pkcs8'}),
    now:()=>1_000_000, nextSequence:async()=>21,
  });
  const joinLink = 'https://telemost.yandex.ru/j/1234567890123456';
  const signed = await telemost.issue({deviceId:expected.deviceId,joinLink,expiresAt:1_100_000});
  assert.equal(verifyTransportBLease(signed,[telemost.publicKeyBase64],expected)?.provider,'telemost');
  const {TransportBController} = loadTs(new URL('../src/network/transportB/controller.ts',import.meta.url));
  let sequence = 20;
  const starts = [];
  const options = {
    ...expected, publicKeys:[telemost.publicKeyBase64], now:()=>expected.now,
    acquire:async()=>signed, loadSequence:async()=>sequence, saveSequence:async value=>{sequence=value;},
    joiner:{start:async link=>{assert.equal(sequence,21);starts.push(link);},stop:async()=>{}},
  };
  const controller = new TransportBController(options);
  assert.equal(await controller.start(),true);
  assert.deepEqual(starts,[joinLink]);
  await controller.stop();
  const restarted = new TransportBController(options);
  assert.equal(await restarted.start(),false);
  assert.deepEqual(starts,[joinLink]);
  assert.equal(verifyTransportBLease(signed,[telemost.publicKeyBase64],{...expected,deviceId:'anotherdevice1'}),null);
  assert.equal(verifyTransportBLease(signed,[telemost.publicKeyBase64],{...expected,now:1_100_000}),null);
});
