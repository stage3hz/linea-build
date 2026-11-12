import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DeviceProof, DeviceProofError, PROOF_MARGIN_MS, PROOF_RETRY_MS } from '../src/deviceProof.ts';
import { deviceMessage, devicePublicKey, deviceSignatureValid } from '../../server/src/devicebind.js';

// The app's side of a session bound to a device key, against the server's own rules for the signature.

function softwareKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  return { point, key: { ensure: async () => ({ publicKey: point, kind: 'hardware' }), sign: async message => createSign('sha256').update(message).sign(privateKey).toString('base64url') } };
}
const refuse = (status, code) => Object.assign(new Error('refused'), { status, code });

/** The server's three routes, checked with the server's own functions. */
function server({ bound = null } = {}) {
  const state = { bound, challenge: null, calls: [], proofs: 0 };
  const post = async (path, body) => {
    state.calls.push(path);
    if (path === '/auth/device/challenge') { state.challenge = `c${state.calls.length}`; return { challenge: state.challenge, sessionId: 'session-1', bound: !!state.bound }; }
    const purpose = path.endsWith('/bind') ? 'bind' : 'proof';
    if (purpose === 'bind' && state.bound) throw refuse(409, 'device_bound');
    if (!state.challenge) throw refuse(409, 'device_challenge');
    const key = devicePublicKey(purpose === 'bind' ? body.publicKey : state.bound);
    if (!deviceSignatureValid(key, deviceMessage(purpose, 'session-1', state.challenge), body.signature)) throw refuse(403, 'device_signature');
    state.challenge = null;
    if (purpose === 'bind') state.bound = body.publicKey;
    return { proof: `proof-${++state.proofs}`, expiresIn: 600 };
  };
  return { state, post };
}

test('first run binds the session to the device key; afterwards the same key only proves', async () => {
  const device = softwareKey(), remote = server();
  let now = 1_000_000;
  const proof = new DeviceProof(() => device.key, remote.post, () => now, false);
  assert.equal(proof.current, null);
  assert.equal(proof.due, true);
  assert.equal(proof.known, false, 'not yet known to need a proof: requests are not held back');
  assert.equal(await proof.refresh(), true);
  assert.equal(remote.state.bound, device.point);
  assert.equal(proof.current, 'proof-1');
  assert.equal(proof.known, true);
  assert.equal(proof.due, false);
  assert.deepEqual(remote.state.calls, ['/auth/device/challenge', '/auth/device/bind']);
  // Still fresh: nothing is asked again.
  assert.equal(await proof.refresh(), true);
  assert.equal(remote.state.calls.length, 2);
  // Close to its end: renewed by a signature, not by binding again.
  now += 600_000 - PROOF_MARGIN_MS + 1;
  assert.equal(proof.due, true);
  assert.equal(await proof.refresh(), true);
  assert.equal(proof.current, 'proof-2');
  assert.deepEqual(remote.state.calls.slice(2), ['/auth/device/challenge', '/auth/device/proof']);
  now += 600_001;
  assert.equal(proof.current, null, 'an expired proof is not sent');
});

test('requests that arrive together share one exchange', async () => {
  const device = softwareKey(), remote = server();
  const proof = new DeviceProof(() => device.key, remote.post, () => 0, false);
  const results = await Promise.all([proof.refresh(), proof.refresh(), proof.refresh(true)]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(remote.state.calls.length, 2);
});

test('an older server, a browser without a key, or a key that does not work: the session stays as it was', async () => {
  const none = new DeviceProof(() => softwareKey().key, async () => { throw refuse(404, ''); }, () => 0, false);
  assert.equal(await none.refresh(), false);
  assert.equal(none.due, false, 'not asked again in this run');
  assert.equal(none.current, null);
  const browser = server();
  const noKey = new DeviceProof(() => null, browser.post, () => 0, false);
  assert.equal(await noKey.refresh(), false);
  assert.equal(browser.state.bound, null);
  const broken = new DeviceProof(() => ({ ensure: async () => { throw new Error('no chip'); }, sign: async () => '' }), server().post, () => 0, false);
  assert.equal(await broken.refresh(), false);
  assert.equal(broken.due, false);
});

test('a session bound to a key this device does not have is lost; a key that fails for a moment is not', async () => {
  const owner = softwareKey();
  // Another device's token copied here: there is a key, but not the one the session knows.
  const copied = new DeviceProof(() => softwareKey().key, server({ bound: owner.point }).post, () => 0, false);
  await assert.rejects(copied.refresh(), error => error instanceof DeviceProofError && error.reason === 'lost');
  const keyless = new DeviceProof(() => null, server({ bound: owner.point }).post, () => 0, false);
  await assert.rejects(keyless.refresh(), error => error instanceof DeviceProofError && error.reason === 'lost');
  const cleared = new DeviceProof(() => ({ ...owner.key, sign: async () => { throw new Error("Error invoking remote method 'x': Error: TPM key changed"); } }), server({ bound: owner.point }).post, () => 0, false);
  await assert.rejects(cleared.refresh(), error => error instanceof DeviceProofError && error.reason === 'lost');
  let now = 0, fail = true;
  const flaky = new DeviceProof(() => ({ ...owner.key, sign: message => (fail ? Promise.reject(new Error('busy')) : owner.key.sign(message)) }), server({ bound: owner.point }).post, () => now, false);
  await assert.rejects(flaky.refresh(), error => error instanceof DeviceProofError && error.reason === 'unavailable');
  assert.equal(flaky.due, false, 'the next request does not hammer the key');
  now += PROOF_RETRY_MS; fail = false;
  assert.equal(flaky.due, true);
  assert.equal(await flaky.refresh(), true);
});

test('bound a moment ago by another request: the exchange turns into a proof', async () => {
  const device = softwareKey(), remote = server();
  let first = true;
  const post = async (path, body) => {
    if (path === '/auth/device/bind' && first) { first = false; remote.state.bound = device.point; }
    return remote.post(path, body);
  };
  const proof = new DeviceProof(() => device.key, post, () => 0, false);
  assert.equal(await proof.refresh(), true);
  assert.deepEqual(remote.state.calls, ['/auth/device/challenge', '/auth/device/bind', '/auth/device/challenge', '/auth/device/proof']);
});

test('the app sends the proof wherever it sends the token, and never stores it', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const api = read('../src/api.ts');
  assert.ok(api.includes("return { Authorization: `Bearer ${this.token}`, ...(proof ? { 'X-Linea-Proof': proof } : {}) };"));
  assert.equal(api.split('Bearer ').length - 1, 1, 'one place builds the header');
  assert.ok(api.includes("const first = !!held && held.due && !held.known;") && api.includes("if (first) void held!.refresh().catch(() => {});"), 'the first requests of a run do not wait for the exchange');
  assert.ok(api.includes("error.status !== 401 || error.code !== 'device_proof') throw error;"), 'a refused proof is renewed and the request repeated');
  assert.ok(api.includes("if (error instanceof DeviceProofError && error.reason === 'lost') throw new ApiError('Войдите в аккаунт заново.', 401, {});"));
  const proof = read('../src/deviceProof.ts');
  assert.ok(!/AsyncStorage|SecureStore|localStorage|writeAsStringAsync/.test(proof), 'the proof stays in memory');
  const messenger = read('../src/useMessenger.ts');
  assert.ok(messenger.includes("...(api.proof?{proof:api.proof}:{})"), 'the socket carries it in its auth frame');
  assert.ok(messenger.includes('event.code===4402'));
});
