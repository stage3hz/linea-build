import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { nodeSignalBridge, claimedBundle } from './support/signal-node.mjs';

const nodeBridge = process.env.LINEA_SIGNAL_TEST_BRIDGE === 'desktop'
  ? (await import('../../desktop/signal.mjs')).desktopSignalBridge : nodeSignalBridge;

// Produced by `gradle interopClasspath` in modules/linea-signal/jvm-tests (JDK 21 + Maven Signal).
const classpathFile = new URL('../modules/linea-signal/jvm-tests/build/interop-classpath.txt', import.meta.url);

function nativeDriver(t) {
  const classpath = readFileSync(classpathFile, 'utf8').trim();
  const java = process.env.LINEA_SIGNAL_TEST_JAVA || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java');
  // The driver speaks JSON lines with Cyrillic test strings: pin the JVM to UTF-8 regardless of the host locale.
  const child = spawn(java, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstdin.encoding=UTF-8', '-cp', classpath, 'expo.modules.lineasignal.SignalInteropKt'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  let failure = null, stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000); });
  const fail = error => { failure = error; for (const request of pending.splice(0)) { clearTimeout(request.timer); request.reject(error); } };
  child.on('error', fail);
  child.on('exit', code => { if (code !== 0 && code !== null) fail(new Error(`Native test driver exited ${code}: ${stderr}`)); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const request = pending.shift();
    if (!request) return;
    clearTimeout(request.timer);
    try {
      const response = JSON.parse(line);
      if (response.ok) request.resolve(response.value);
      else request.reject(new Error(`Native rejection: ${response.error}`));
    } catch (error) { request.reject(error); }
  });
  t.after(() => { lines.close(); child.kill(); });
  return (method, ...args) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const timer = setTimeout(() => { fail(new Error(`Native test driver timeout for ${method}`)); child.kill(); }, 10000);
    pending.push({ resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ method, args })}\n`);
  });
}

test('actual Kotlin native core interoperates with official Node Signal for handshake, ratchet, out-of-order/replay/tamper and files', async t => {
  if (!existsSync(classpathFile)) {
    t.skip('JVM interop driver is not built: run `gradle interopClasspath` in mobile/modules/linea-signal/jvm-tests (JDK 21) first');
    return;
  }
  const native = nativeDriver(t);
  const aliceName = `${randomUUID()}.${randomUUID()}`, bobName = `${randomUUID()}.${randomUUID()}`;
  let alice = await nodeBridge.createState(aliceName, 1), bob = await native('createState', bobName, 1);
  await assert.rejects(native('encrypt', bob.state, aliceName, 1, 'Unapproved identity', claimedBundle(alice.bundle)), /TRUST|IDENTITY|CRYPTO/i);
  alice = { ...alice, ...await nodeBridge.trustIdentity(alice.state, bobName, 1, bob.bundle.identityKey) };
  bob = { ...bob, ...await native('trustIdentity', bob.state, aliceName, 1, alice.bundle.identityKey) };
  const first = await nodeBridge.encrypt(alice.state, bobName, 1, 'Node → Kotlin: привет 🦉', claimedBundle(bob.bundle));
  alice.state = first.state;
  const received = await native('decrypt', bob.state, aliceName, 1, first.type, first.body);
  bob.state = received.state;
  assert.equal(received.plaintext, 'Node → Kotlin: привет 🦉');
  const reply = await native('encrypt', bob.state, aliceName, 1, 'Kotlin → Node: ответ 🌿', null);
  bob.state = reply.state;
  assert.equal(reply.type, 2);
  const opened = await nodeBridge.decrypt(alice.state, bobName, 1, reply.type, reply.body);
  alice.state = opened.state;
  assert.equal(opened.plaintext, 'Kotlin → Node: ответ 🌿');

  const packets = [];
  for (let index = 0; index < 4; index++) {
    const packet = await nodeBridge.encrypt(alice.state, bobName, 1, `out-of-order-${index}`, null);
    alice.state = packet.state; packets.push(packet);
  }
  for (const index of [2, 0, 3, 1]) {
    const result = await native('decrypt', bob.state, aliceName, 1, packets[index].type, packets[index].body);
    bob.state = result.state;
    assert.equal(result.plaintext, `out-of-order-${index}`);
  }
  await assert.rejects(native('decrypt', bob.state, aliceName, 1, packets[0].type, packets[0].body), /Native rejection/);
  const fresh = await nodeBridge.encrypt(alice.state, bobName, 1, 'Untampered native message', null);
  alice.state = fresh.state;
  const tampered = Buffer.from(fresh.body, 'base64'); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(native('decrypt', bob.state, aliceName, 1, fresh.type, tampered.toString('base64')), /Native rejection/);
  const good = await native('decrypt', bob.state, aliceName, 1, fresh.type, fresh.body);
  bob.state = good.state;
  assert.equal(good.plaintext, 'Untampered native message');
  // Rekey on the native side: Node (Alice) loses its session, Kotlin (Bob) still has a live one.
  // A claimed bundle handed to the native encrypt must archive that session and send a PreKey message.
  const lostAlice = JSON.parse(alice.state); lostAlice.sessions = {}; alice.state = JSON.stringify(lostAlice);
  const stale = await native('encrypt', bob.state, aliceName, 1, 'stale chain', null);
  bob.state = stale.state;
  assert.equal(stale.type, 2);
  await assert.rejects(nodeBridge.decrypt(alice.state, bobName, 1, stale.type, stale.body));
  const rekeyed = await native('encrypt', bob.state, aliceName, 1, 'Kotlin rekey → Node', claimedBundle(alice.bundle, 1));
  bob.state = rekeyed.state;
  assert.equal(rekeyed.type, 3, 'the native core honours the bundle although a session exists');
  const reopened = await nodeBridge.decrypt(alice.state, bobName, 1, rekeyed.type, rekeyed.body);
  alice.state = reopened.state;
  assert.equal(reopened.plaintext, 'Kotlin rekey → Node');
  const after = await native('encrypt', bob.state, aliceName, 1, 'next on the new session', null);
  bob.state = after.state;
  const afterOpened = await nodeBridge.decrypt(alice.state, bobName, 1, after.type, after.body);
  alice.state = afterOpened.state;
  assert.equal(afterOpened.plaintext, 'next on the new session');
  let replacement = await native('createState', bobName, 1);
  replacement = { ...replacement, ...await native('trustIdentity', replacement.state, aliceName, 1, alice.bundle.identityKey) };
  await assert.rejects(native('decrypt', replacement.state, aliceName, 1, first.type, first.body), /Native rejection/);

  const plain = randomBytes(4096).toString('base64'), key = randomBytes(32).toString('base64'), nonce = randomBytes(12).toString('base64'), ad = Buffer.from('interoperability-file-id').toString('base64');
  const nodeCipher = await nodeBridge.seal(plain, key, nonce, ad);
  assert.equal(await native('open', nodeCipher, key, nonce, ad), plain);
  const nativeCipher = await native('seal', plain, key, nonce, ad);
  assert.equal(nativeCipher, nodeCipher, 'the same official AES-GCM-SIV inputs produce interoperable output');
  assert.equal(await nodeBridge.open(nativeCipher, key, nonce, ad), plain);
  await assert.rejects(native('open', nodeCipher, key, nonce, Buffer.from('changed-ad').toString('base64')), /Native rejection/);
});
