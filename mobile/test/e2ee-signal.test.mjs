import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { nodeSignalBridge as bridge, claimedBundle, signal, SIGNAL_VERSION } from './support/signal-node.mjs';

const address = () => `${randomUUID()}.${randomUUID()}`;
const base64 = bytes => Buffer.from(bytes).toString('base64');

async function device() {
  const name = address();
  return { name, ...(await bridge.createState(name, 1)) };
}

async function approve(owner, peer) {
  owner.state = (await bridge.trustIdentity(owner.state, peer.name, 1, peer.bundle.identityKey)).state;
}

async function encrypt(from, to, plaintext, bundle = null) {
  const encrypted = await bridge.encrypt(from.state, to.name, 1, plaintext, bundle);
  from.state = encrypted.state;
  return { type: encrypted.type, body: encrypted.body };
}

async function decrypt(to, from, encrypted) {
  const decrypted = await bridge.decrypt(to.state, from.name, 1, encrypted.type, encrypted.body);
  to.state = decrypted.state;
  return decrypted.plaintext;
}

async function establishedPair() {
  const alice = await device(), bob = await device();
  await approve(alice, bob);
  await approve(bob, alice);
  const first = await encrypt(alice, bob, 'Первое тестовое сообщение 🦉', claimedBundle(bob.bundle));
  assert.equal(first.type, 3, 'a new session starts with a real Signal pre-key message');
  assert.equal(await decrypt(bob, alice, first), 'Первое тестовое сообщение 🦉');
  const reply = await encrypt(bob, alice, 'Ответ другого устройства');
  assert.equal(reply.type, 2);
  assert.equal(await decrypt(alice, bob, reply), 'Ответ другого устройства');
  return { alice, bob, first };
}

test('official pinned libsignal creates independently signed EC and Kyber public bundles', async () => {
  assert.equal(SIGNAL_VERSION, '0.106.0');
  const alice = await device(), bob = await device();
  for (const current of [alice, bob]) {
    const bundle = current.bundle;
    assert.ok(bundle.registrationId >= 1 && bundle.registrationId <= 16383);
    assert.equal(Buffer.from(bundle.identityKey, 'base64').length, 33);
    assert.equal(Buffer.from(bundle.signedPreKey.publicKey, 'base64').length, 33);
    assert.equal(Buffer.from(bundle.kyberPreKey.publicKey, 'base64').length, 1569);
    assert.equal(bundle.preKeys.length, 20);
    assert.equal(new Set(bundle.preKeys.map(key => key.id)).size, 20);
    const identity = signal.PublicKey.deserialize(Buffer.from(bundle.identityKey, 'base64'));
    for (const key of [bundle.signedPreKey, bundle.kyberPreKey]) {
      assert.equal(Buffer.from(key.signature, 'base64').length, 64);
      assert.equal(identity.verify(Buffer.from(key.publicKey, 'base64'), Buffer.from(key.signature, 'base64')), true);
    }
    assert.equal(/private|secret|session|trusted/i.test(JSON.stringify(bundle)), false, 'published bundle contains public material only');
  }
  assert.notEqual(alice.bundle.identityKey, bob.bundle.identityKey);
});

test('both directions require explicit identity approval and a pinned key cannot be replaced silently', async () => {
  const alice = await device(), bob = await device();
  await assert.rejects(bridge.encrypt(alice.state, bob.name, 1, 'Not approved', claimedBundle(bob.bundle)), /identity/i);
  await approve(alice, bob);
  const message = await encrypt(alice, bob, 'Approved sender-side', claimedBundle(bob.bundle));
  await assert.rejects(bridge.decrypt(bob.state, alice.name, 1, message.type, message.body), /identity/i);
  await approve(bob, alice);
  assert.equal(await decrypt(bob, alice, message), 'Approved sender-side');
  const replacement = await device();
  await assert.rejects(bridge.trustIdentity(alice.state, bob.name, 1, replacement.bundle.identityKey), /changed/i);
  await assert.rejects(bridge.encrypt(alice.state, bob.name, 1, 'Replacement bundle', claimedBundle(replacement.bundle)), /identity/i);
});

test('two restored device stores exchange real Signal messages in both directions and advance session state', async () => {
  const { alice, bob } = await establishedPair();
  const oldAlice = alice.state, oldBob = bob.state;
  const bodies = new Set();
  for (let index = 0; index < 12; index++) {
    const from = index % 2 ? bob : alice, to = index % 2 ? alice : bob;
    const text = JSON.stringify({ id: index, text: 'Одно и то же содержимое 🔐' });
    const encrypted = await encrypt(from, to, text);
    assert.equal(encrypted.type, 2);
    assert.equal(Buffer.from(encrypted.body, 'base64').includes(Buffer.from(text)), false);
    assert.equal(await decrypt(to, from, encrypted), text);
    assert.equal(bodies.has(encrypted.body), false);
    bodies.add(encrypted.body);
    // Every bridge call reconstructs stores from the saved opaque string.
    from.state = String(from.state);
    to.state = String(to.state);
  }
  assert.notEqual(alice.state, oldAlice);
  assert.notEqual(bob.state, oldBob);
});

test('Signal accepts out-of-order messages and rejects replay after the stored state advances', async () => {
  const { alice, bob } = await establishedPair();
  const packets = [];
  for (let index = 0; index < 6; index++) packets.push(await encrypt(alice, bob, `message-${index}`));
  for (const index of [4, 1, 5, 0, 3, 2]) assert.equal(await decrypt(bob, alice, packets[index]), `message-${index}`);
  await assert.rejects(bridge.decrypt(bob.state, alice.name, 1, packets[1].type, packets[1].body), /duplicate|old|replay/i);
});

test('tampered or misaddressed envelopes fail and never fall back to plaintext', async () => {
  const { alice, bob } = await establishedPair();
  const encrypted = await encrypt(alice, bob, 'Authenticated payload');
  const bytes = Buffer.from(encrypted.body, 'base64');
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(bridge.decrypt(bob.state, alice.name, 1, encrypted.type, bytes.toString('base64')));
  await assert.rejects(bridge.decrypt(bob.state, address(), 1, encrypted.type, encrypted.body));
  await assert.rejects(bridge.decrypt(bob.state, alice.name, 1, 8, base64('pretend plaintext')), /plaintext/i);
  assert.equal(await decrypt(bob, alice, encrypted), 'Authenticated payload', 'failed decryption did not overwrite the caller’s saved state');
});

test('a fresh identity at the same account/device address cannot decrypt the old archive', async () => {
  const { alice, bob, first } = await establishedPair();
  const archived = await encrypt(alice, bob, 'History encrypted before keys were lost');
  const replacement = { name: bob.name, ...(await bridge.createState(bob.name, 1)) };
  assert.notEqual(replacement.bundle.identityKey, bob.bundle.identityKey);
  await approve(replacement, alice);
  await assert.rejects(bridge.decrypt(replacement.state, alice.name, 1, archived.type, archived.body));
  await assert.rejects(bridge.decrypt(replacement.state, alice.name, 1, first.type, first.body));
  assert.equal(await decrypt(bob, alice, archived), 'History encrypted before keys were lost');
});

test('pre-key replenishment retains outstanding private keys and delayed messages remain decryptable', async () => {
  const alice = await device(), bob = await device();
  await approve(alice, bob);
  await approve(bob, alice);
  const oldClaim = claimedBundle(bob.bundle, 7);
  const replenished = await bridge.replenish(bob.state, 20);
  bob.state = replenished.state;
  assert.equal(replenished.bundle.preKeys.length, 20);
  assert.equal(replenished.bundle.identityKey, bob.bundle.identityKey);
  const oldIds = new Set(bob.bundle.preKeys.map(key => key.id));
  assert.equal(replenished.bundle.preKeys.some(key => oldIds.has(key.id)), false, 'fresh upload must not republish old pre-key ids');
  const delayed = await encrypt(alice, bob, 'Delivered after a pre-key top-up', oldClaim);
  assert.equal(await decrypt(bob, alice, delayed), 'Delivered after a pre-key top-up');
  await assert.rejects(bridge.decrypt(bob.state, alice.name, 1, delayed.type, delayed.body), /duplicate|old|replay/i);
});

test('invalid signatures are rejected before a new session is established', async () => {
  const alice = await device(), bob = await device();
  await approve(alice, bob);
  for (const field of ['signedPreKey', 'kyberPreKey']) {
    const bundle = structuredClone(claimedBundle(bob.bundle));
    const bytes = Buffer.from(bundle[field].signature, 'base64');
    bytes[0] ^= 1;
    bundle[field].signature = bytes.toString('base64');
    await assert.rejects(bridge.encrypt(alice.state, bob.name, 1, 'Invalid signed key', bundle), /signature|invalid/i);
  }
  await approve(bob, alice);
  const valid = await encrypt(alice, bob, 'Valid signed keys', claimedBundle(bob.bundle));
  assert.equal(await decrypt(bob, alice, valid), 'Valid signed keys');
});

test('file encryption uses official AES-256-GCM-SIV and authenticates ciphertext, nonce, key and associated data', async () => {
  const plaintext = randomBytes(64 * 1024), key = randomBytes(32), nonce = randomBytes(12);
  const ad = Buffer.from(JSON.stringify({ scheme: 'linea-file-v1', fileKeyId: randomUUID() }));
  const encrypted = await bridge.seal(base64(plaintext), base64(key), base64(nonce), base64(ad));
  assert.equal(Buffer.from(encrypted, 'base64').length, plaintext.length + 16);
  assert.equal(await bridge.open(encrypted, base64(key), base64(nonce), base64(ad)), base64(plaintext));
  const damaged = Buffer.from(encrypted, 'base64');
  damaged[123] ^= 0x40;
  await assert.rejects(bridge.open(base64(damaged), base64(key), base64(nonce), base64(ad)));
  await assert.rejects(bridge.open(encrypted, base64(randomBytes(32)), base64(nonce), base64(ad)));
  await assert.rejects(bridge.open(encrypted, base64(key), base64(randomBytes(12)), base64(ad)));
  await assert.rejects(bridge.open(encrypted, base64(key), base64(nonce), base64('different file metadata')));
});
