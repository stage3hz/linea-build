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
