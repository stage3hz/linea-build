import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { deviceMessage, devicePublicKey, deviceSignatureValid, PROOF_GRACE_MS, PROOF_TTL_MS } from '../src/devicebind.js';

// A session bound to a device key: the token alone (what a stealer copies off the disk) no longer signs in.

const PASSWORD = 'correct-horse-42', RECOVERY_WORD = 'SilverHarborLantern', CONFIRMATION_WORD = 'AmberGardenPrism';
const PHONE = { deviceName: 'iPhone', platform: 'ios', deviceModel: 'iPhone 15 Pro', osVersion: 'iOS 18.1', appVersion: '0.14.14' };
const LAPTOP = { deviceName: 'Windows', platform: 'windows', deviceModel: 'Windows PC', osVersion: 'Windows 11', appVersion: '0.14.14' };

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-bind-test-'));
  const clock = { now: Date.now() };
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, now: () => clock.now, ...options });
  await app.ready();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, clock };
}
const call = (app, method, url, token, payload, proof) => app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(proof ? { 'x-linea-proof': proof } : {}) }, ...(payload === undefined ? {} : { payload }) });
async function register(app, username, device = PHONE) {
  const response = await call(app, 'POST', '/auth/register', null, { username, displayName: username, password: PASSWORD, recoveryWord: RECOVERY_WORD, confirmationWord: CONFIRMATION_WORD, ...device });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
async function login(app, username, device = LAPTOP) {
  const response = await call(app, 'POST', '/auth/login', null, { username, password: PASSWORD, confirmationWord: CONFIRMATION_WORD, ...device });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
function deviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  const sign = (message, dsaEncoding = 'der') => createSign('sha256').update(message).sign({ key: privateKey, dsaEncoding }).toString('base64url');
  return { point, sign };
}
async function challenge(app, token) {
  const response = await call(app, 'POST', '/auth/device/challenge', token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function bind(app, token, key, kind = 'hardware') {
  const { challenge: value, sessionId } = await challenge(app, token);
  const response = await call(app, 'POST', '/auth/device/bind', token, { publicKey: key.point, kind, signature: key.sign(deviceMessage('bind', sessionId, value)) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().proof;
}
async function prove(app, token, key, encoding) {
  const { challenge: value, sessionId } = await challenge(app, token);
  return call(app, 'POST', '/auth/device/proof', token, { signature: key.sign(deviceMessage('proof', sessionId, value), encoding) });
}

test('a public key is the 65-byte P-256 point; a signature is accepted as DER or as raw r‖s, only for its own message', () => {
  const key = deviceKey(), other = deviceKey();
  const parsed = devicePublicKey(key.point);
  assert.ok(parsed);
  assert.equal(devicePublicKey(key.point.slice(0, 86)), null);
  assert.equal(devicePublicKey('A'.repeat(87)), null, 'not an uncompressed point');
  assert.equal(devicePublicKey(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url')), null, 'not on the curve');
  const message = deviceMessage('proof', 'session', 'challenge');
  assert.equal(deviceSignatureValid(parsed, message, key.sign(message)), true);
  assert.equal(deviceSignatureValid(parsed, message, key.sign(message, 'ieee-p1363')), true, 'Windows CNG signs as r‖s');
  assert.equal(deviceSignatureValid(parsed, message, other.sign(message)), false);
  assert.equal(deviceSignatureValid(parsed, deviceMessage('bind', 'session', 'challenge'), key.sign(message)), false, 'a proof signature does not bind');
  assert.equal(deviceSignatureValid(parsed, deviceMessage('proof', 'another', 'challenge'), key.sign(message)), false);
  assert.equal(deviceSignatureValid(parsed, message, 'x'), false);
});

test('an unbound session (an older app) works with the token alone', async t => {
  const { app } = await fixture(t);
  const ann = await register(app, 'ann');
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token)).statusCode, 200);
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token)).json().sessions[0].deviceKey, null);
});

test('a bound session: the token without the proof is refused, with it accepted; a copied token cannot get a proof', async t => {
  const { app } = await fixture(t);
  const ann = await register(app, 'ann');
  const key = deviceKey();
  const proof = await bind(app, ann.token, key);
  const stolen = await call(app, 'GET', '/auth/sessions', ann.token);
  assert.equal(stolen.statusCode, 401);
  assert.equal(stolen.json().code, 'device_proof');
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, 'A'.repeat(43))).statusCode, 401);
  const own = await call(app, 'GET', '/auth/sessions', ann.token, undefined, proof);
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().sessions[0].deviceKey, 'hardware');
  // The thief has the token, not the key: the challenge is given, the answer is not accepted.
  const thief = deviceKey();
  const refused = await prove(app, ann.token, thief);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, 'device_signature');
  // …and the session cannot be bound again to the thief's key.
  const { challenge: value, sessionId } = await challenge(app, ann.token);
  const rebind = await call(app, 'POST', '/auth/device/bind', ann.token, { publicKey: thief.point, kind: 'software', signature: thief.sign(deviceMessage('bind', sessionId, value)) });
  assert.equal(rebind.statusCode, 409);
  assert.equal(rebind.json().code, 'device_bound');
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, proof)).statusCode, 200, 'the owner is not disturbed');
});

test('binding needs a signature by the offered key over this session\'s challenge; a challenge is used once', async t => {
  const { app } = await fixture(t);
  const ann = await register(app, 'ann');
  const key = deviceKey(), other = deviceKey();
  const first = await challenge(app, ann.token);
  assert.equal(first.bound, false);
  const wrong = await call(app, 'POST', '/auth/device/bind', ann.token, { publicKey: key.point, kind: 'hardware', signature: other.sign(deviceMessage('bind', first.sessionId, first.challenge)) });
  assert.equal(wrong.statusCode, 403);
  assert.equal((await call(app, 'POST', '/auth/device/bind', ann.token, { publicKey: key.point, kind: 'tpm', signature: key.sign(deviceMessage('bind', first.sessionId, first.challenge)) })).statusCode, 400);
  const signature = key.sign(deviceMessage('bind', first.sessionId, first.challenge));
  assert.equal((await call(app, 'POST', '/auth/device/bind', ann.token, { publicKey: key.point, kind: 'software', signature })).statusCode, 200);
  // The same answer again: the session is bound now, and the challenge is gone.
  assert.equal((await call(app, 'POST', '/auth/device/bind', ann.token, { publicKey: key.point, kind: 'software', signature })).statusCode, 409);
  const again = await challenge(app, ann.token);
  assert.equal(again.bound, true);
  const proofSignature = key.sign(deviceMessage('proof', again.sessionId, again.challenge));
  assert.equal((await call(app, 'POST', '/auth/device/proof', ann.token, { signature: proofSignature })).statusCode, 200);
  const replay = await call(app, 'POST', '/auth/device/proof', ann.token, { signature: proofSignature });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().code, 'device_challenge');
});

test('a proof lasts ten minutes; a new one replaces it, the old one stays good for a minute', async t => {
  const { app, clock } = await fixture(t);
  const ann = await register(app, 'ann');
  const key = deviceKey();
  const first = await bind(app, ann.token, key, 'software');
  clock.now += PROOF_TTL_MS - 5_000;
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, first)).statusCode, 200);
  const renewed = await prove(app, ann.token, key, 'ieee-p1363');
  assert.equal(renewed.statusCode, 200, renewed.body);
  const second = renewed.json().proof;
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, first)).statusCode, 200, 'requests already on their way');
  clock.now += 6_000;
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, first)).statusCode, 401, 'never past its own ten minutes');
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, second)).statusCode, 200);
  const third = (await prove(app, ann.token, key)).json().proof;
  clock.now += PROOF_GRACE_MS + 1;
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, second)).statusCode, 401);
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, third)).statusCode, 200);
  clock.now += PROOF_TTL_MS;
  assert.equal((await call(app, 'GET', '/auth/sessions', ann.token, undefined, third)).statusCode, 401);
  assert.equal((await prove(app, ann.token, key)).statusCode, 200, 'the device asks again');
});

test('two devices of one account: each has its own key and both work at once', async t => {
  const { app } = await fixture(t);
  const phone = await register(app, 'ann');
  const laptop = await login(app, 'ann');
  const phoneKey = deviceKey(), laptopKey = deviceKey();
  const phoneProof = await bind(app, phone.token, phoneKey);
  const laptopProof = await bind(app, laptop.token, laptopKey, 'software');
  assert.equal((await call(app, 'GET', '/auth/sessions', phone.token, undefined, phoneProof)).statusCode, 200);
  assert.equal((await call(app, 'GET', '/auth/sessions', laptop.token, undefined, laptopProof)).statusCode, 200);
  assert.equal((await call(app, 'GET', '/auth/sessions', laptop.token, undefined, phoneProof)).statusCode, 401, 'a proof belongs to its session');
  assert.equal((await prove(app, laptop.token, phoneKey)).statusCode, 403);
  const listed = (await call(app, 'GET', '/auth/sessions', phone.token, undefined, phoneProof)).json().sessions;
  assert.deepEqual(listed.map(session => session.deviceKey).sort(), ['hardware', 'software']);
});

test('the socket of a bound session needs the proof in its auth frame', async t => {
  const { app } = await fixture(t);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const ann = await register(app, 'ann');
  const proof = await bind(app, ann.token, deviceKey());
  const url = `ws://127.0.0.1:${app.server.address().port}/ws`;
  const without = new WebSocket(url);
  await once(without, 'open');
  without.send(JSON.stringify({ type: 'auth', token: ann.token }));
  const [code] = await once(without, 'close');
  assert.equal(code, 4402);
  const withProof = new WebSocket(url);
  await once(withProof, 'open');
  withProof.send(JSON.stringify({ type: 'auth', token: ann.token, proof }));
  const [first] = await once(withProof, 'message');
  assert.notEqual(JSON.parse(first.toString()).type, undefined);
  withProof.close();
  await once(withProof, 'close');
});
