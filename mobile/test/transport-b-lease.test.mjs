import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { loadTs } from './support/load-ts.mjs';

const { verifyTransportBLease, MAX_LEASE_MS } = loadTs(new URL('../src/network/transportB/lease.ts', import.meta.url));
const secret = randomBytes(32);
const pub = Buffer.from(ed25519.getPublicKey(secret)).toString('base64');
const other = Buffer.from(ed25519.getPublicKey(randomBytes(32))).toString('base64');
const now = 1_000_000;
const deviceId = 'device-abcdef12', realm = 'https://api.invizent.com';
const make = changes => {
  const payload = JSON.stringify({ protocol: 'invizent-transport-b-v1', provider: 'wbstream', joinLink: 'wbstream://room_123456789', deviceId, realm, sequence: 7, issuedAt: now - 1000, expiresAt: now + 120_000, ...changes });
  return { payload, sig: Buffer.from(ed25519.sign(Buffer.from(payload), secret)).toString('base64') };
};
const expected = { deviceId, realm, now, minSequence: 6 };

test('accepts only an authenticated short-lived offer for the expected device', () => {
  assert.equal(verifyTransportBLease(make(), [pub], expected).joinLink, 'wbstream://room_123456789');
  assert.equal(MAX_LEASE_MS, 30 * 60_000);
});

test('wrong signing key or tampered signed payload is rejected', () => {
  const lease = make();
  assert.equal(verifyTransportBLease(lease, [other], expected), null);
  assert.equal(verifyTransportBLease({ ...lease, payload: lease.payload.replace('room_123456789', 'room_hijacked01') }, [pub], expected), null);
});

test('lease cannot be transferred between devices or account realms', () => {
  assert.equal(verifyTransportBLease(make(), [pub], { ...expected, deviceId: 'otherdevice01234' }), null);
  assert.equal(verifyTransportBLease(make(), [pub], { ...expected, realm: 'https://api.evil.com' }), null);
});

test('rejects revoked sequence and expired or future offers', () => {
  assert.equal(verifyTransportBLease(make({ sequence: 6 }), [pub], expected), null);
  assert.equal(verifyTransportBLease(make({ expiresAt: now }), [pub], expected), null);
  assert.equal(verifyTransportBLease(make({ issuedAt: now + 60_001, expiresAt: now + 180_000 }), [pub], expected), null);
  assert.equal(verifyTransportBLease(make({ expiresAt: now + MAX_LEASE_MS + 20_000 }), [pub], expected), null);
});

test('invalid providers, schemes and URLs cannot become a native tunnel destination', () => {
  assert.equal(verifyTransportBLease(make({ provider: 'custom' }), [pub], expected), null);
  assert.equal(verifyTransportBLease(make({ joinLink: 'https://api.evil.com' }), [pub], expected), null);
  assert.equal(verifyTransportBLease(make({ joinLink: 'wbstream://../../secret' }), [pub], expected), null);
});

test('malformed signed data fails closed', () => {
  assert.equal(verifyTransportBLease(null, [pub], expected), null);
  assert.equal(verifyTransportBLease({payload: '{', sig: 'bogus'}, [pub], expected), null);
  assert.equal(verifyTransportBLease(make(), [], expected), null);
  assert.equal(verifyTransportBLease(make(), [pub], {...expected, now: NaN}), null);
});
