import assert from 'node:assert/strict';
import { createPublicKey, createSign, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createDeviceKey, pointFromBlob } = require('../devicekey.cjs');

const memoryVault = () => { const values = {}; return { values, open: async () => ({ get: async name => values[name] ?? null, commit: async changes => { Object.assign(values, changes); } }) }; };
const keyOf = point => { const raw = Buffer.from(point, 'base64url'); return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } }); };

/** What Windows answers: a CNG public blob and r‖s signatures, from a key that never leaves this closure. */
function fakeTpm() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const header = Buffer.alloc(8); header.writeUInt32LE(0x31534345, 0); header.writeUInt32LE(32, 4);
  const publicBlob = Buffer.concat([header, Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  const calls = [];
  const run = async (action, message) => {
    calls.push(action);
    if (action === 'create') return { publicBlob };
    return { publicBlob, signature: createSign('sha256').update(Buffer.from(message, 'base64')).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') };
  };
  return { run, calls };
}

test('Windows with a TPM: the key is made in the chip, tested, and only its public half is stored', async () => {
  const vault = memoryVault(), tpm = fakeTpm();
  const key = createDeviceKey({ vault: vault.open, platform: 'win32', run: tpm.run });
  const { publicKey, kind } = await key.ensure();
  assert.equal(kind, 'hardware');
  assert.deepEqual(tpm.calls, ['create', 'sign'], 'created, then a self-test signature');
  assert.deepEqual(Object.keys(vault.values.key).sort(), ['kind', 'publicKey'], 'no private key on disk');
  const message = 'invizent-device-proof-v1\nsession\nchallenge';
  const signature = Buffer.from(await key.sign(message), 'base64url');
  assert.equal(signature.length, 64);
  assert.equal(verify('sha256', Buffer.from(message), { key: keyOf(publicKey), dsaEncoding: 'ieee-p1363' }, signature), true);
  // The next start reads the record: the chip is not asked to create anything again.
  const again = createDeviceKey({ vault: vault.open, platform: 'win32', run: tpm.run });
  assert.deepEqual(await again.ensure(), { publicKey, kind });
  assert.equal(tpm.calls.filter(action => action === 'create').length, 1);
});

test('no TPM, a failing chip or a wrong answer: an ordinary key in the vault, said to be «software»', async () => {
  for (const run of [async () => { throw new Error('no TPM'); }, async () => ({ publicBlob: 'AAAA' }), async action => (action === 'create' ? fakeTpm().run('create') : { ...(await fakeTpm().run('create')), signature: Buffer.alloc(64).toString('base64') })]) {
    const vault = memoryVault();
    const key = createDeviceKey({ vault: vault.open, platform: 'win32', run });
    const { publicKey, kind } = await key.ensure();
    assert.equal(kind, 'software');
    const message = 'invizent-device-bind-v1\nsession\nchallenge';
    assert.equal(verify('sha256', Buffer.from(message), keyOf(publicKey), Buffer.from(await key.sign(message), 'base64url')), true);
  }
  // Not Windows: PowerShell is never started.
  let started = false;
  const key = createDeviceKey({ vault: memoryVault().open, platform: 'linux', run: async () => { started = true; throw new Error('x'); } });
  assert.equal((await key.ensure()).kind, 'software');
  assert.equal(started, false);
});

test('the key signs only the server\'s device messages, and a replaced TPM key is not passed off as the old one', async () => {
  const vault = memoryVault(), tpm = fakeTpm();
  const key = createDeviceKey({ vault: vault.open, platform: 'win32', run: tpm.run });
  await key.ensure();
  await assert.rejects(key.sign('pay 100 to mallory'), /Invalid message/);
  await assert.rejects(key.sign(42), /Invalid message/);
  const other = fakeTpm();
  const swapped = createDeviceKey({ vault: vault.open, platform: 'win32', run: other.run });
  await assert.rejects(swapped.sign('invizent-device-proof-v1\ns\nc'), /TPM key changed/);
  assert.throws(() => pointFromBlob(Buffer.alloc(72).toString('base64')), /Unexpected TPM public key/);
});

test('the app ships the file and exposes only «ensure» and «sign» to the page', () => {
  const pack = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pack.build.files.includes('devicekey.cjs'), 'a file missing from the package stops the app at start');
  const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  assert.ok(preload.includes("deviceKey: Object.freeze({ ensure: () => invoke('deviceKeyEnsure'), sign: message => invoke('deviceKeySign', message) })"));
  const script = readFileSync(new URL('../devicekey.cjs', import.meta.url), 'utf8');
  assert.ok(script.includes("ExportPolicy=[System.Security.Cryptography.CngExportPolicies]::None"), 'the TPM key is not exportable');
  assert.ok(!/-Command',\s*`/.test(script) && script.includes('INVIZENT_KEY_MESSAGE'), 'arguments go through the environment, not the command text');
});
