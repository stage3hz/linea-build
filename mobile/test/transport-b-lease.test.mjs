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

test('accepts Telemost only when the authenticated provider matches its canonical link', () => {
  const joinLink = 'https://telemost.yandex.ru/j/1234567890123456';
  const lease = verifyTransportBLease(make({provider:'telemost',joinLink}), [pub], expected);
  assert.equal(lease?.provider, 'telemost');
  assert.equal(lease?.joinLink, joinLink);
  assert.equal(verifyTransportBLease(make({joinLink}), [pub], expected), null);
  assert.equal(verifyTransportBLease(make({provider:'telemost'}), [pub], expected), null);
});

test('signed Telemost destinations reject URL parser ambiguities and noncanonical identifiers', () => {
  const base = 'https://telemost.yandex.ru/j/123456789';
  for (const joinLink of [
    'http://telemost.yandex.ru/j/123456789',
    'https://telemost.yandex.ru.evil.example/j/123456789',
    'https://evil.example/telemost.yandex.ru/j/123456789',
    'https://telemost.yandex.ru@evil.example/j/123456789',
    'https://user@telemost.yandex.ru/j/123456789',
    'https://telemost.yandex.ru:443/j/123456789',
    'https://TELEMOST.yandex.ru/j/123456789',
    'https://telemost.yandex.ru/j/%31',
    'https://telemost.yandex.ru/j/../123456789',
    'https://telemost.yandex.ru/j/abc',
    'https://telemost.yandex.ru/j/',
    'https://telemost.yandex.ru/j/' + '1'.repeat(161),
    base+'?redirect=https://evil.example', base+'#fragment', base+'/',
    ' '+base, base+'\n', base+'\r\n',
  ]) assert.equal(verifyTransportBLease(make({provider:'telemost',joinLink}), [pub], expected), null, joinLink);
  assert.equal(verifyTransportBLease(make({joinLink:'wbstream://room_123456789\n'}), [pub], expected), null);
});

test('malformed signed data fails closed', () => {
  assert.equal(verifyTransportBLease(null, [pub], expected), null);
  assert.equal(verifyTransportBLease({payload: '{', sig: 'bogus'}, [pub], expected), null);
  assert.equal(verifyTransportBLease(make(), [], expected), null);
  assert.equal(verifyTransportBLease(make(), [pub], {...expected, now: NaN}), null);
});
