import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';
import { harness } from './support/crypto-harness.mjs';

const va = loadTs(new URL('../src/communities/voiceAuth.ts', import.meta.url));
const sdp = fp => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=group:BUNDLE 0 1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\n`;
const FP_A = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const FP_B = '10:20:30:40:50:60:70:80:90:A0:B0:C0:D0:E0:F0:01:10:20:30:40:50:60:70:80:90:A0:B0:C0:D0:E0:F0:01';
const FP_M = 'DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF';

test('fingerprints are read from every a=fingerprint line, normalised', () => {
  assert.equal(va.sdpFingerprints(sdp(FP_A.toLowerCase()).replace('sha-256', 'SHA-256')), `sha-256 ${FP_A}`);
  assert.equal(va.sdpFingerprints('v=0\r\n'), '');
  assert.throws(() => va.authText('c', 'a', 'b', 'v=0\r\n', sdp(FP_B)), /DTLS/);
});

test('connection check: matching fingerprints pass; a swapped fingerprint (server in the middle) is refused', () => {
  // Alice (socket a) offered with FP_A, Bob (socket b) answered with FP_B; no one in between.
  const fromBob = va.authText('chan', 'b', 'a', sdp(FP_B), sdp(FP_A));
  assert.equal(va.checkAuth(fromBob, { channelId: 'chan', self: 'a', peer: 'b', localSdp: sdp(FP_A), remoteSdp: sdp(FP_B) }), true);
  // The server replaced Bob's answer with its own fingerprint: Alice sees FP_M, Bob's note says FP_B.
  assert.equal(va.checkAuth(fromBob, { channelId: 'chan', self: 'a', peer: 'b', localSdp: sdp(FP_A), remoteSdp: sdp(FP_M) }), false);
  // The server replaced Alice's offer: Bob saw FP_M as «yours» — Alice's real fingerprint is FP_A.
  const bobFooled = va.authText('chan', 'b', 'a', sdp(FP_B), sdp(FP_M));
  assert.equal(va.checkAuth(bobFooled, { channelId: 'chan', self: 'a', peer: 'b', localSdp: sdp(FP_A), remoteSdp: sdp(FP_B) }), false);
  // A note from another room, another pair of sockets, or garbage is refused too.
  assert.equal(va.checkAuth(fromBob, { channelId: 'other', self: 'a', peer: 'b', localSdp: sdp(FP_A), remoteSdp: sdp(FP_B) }), false);
  assert.equal(va.checkAuth(fromBob, { channelId: 'chan', self: 'a', peer: 'x', localSdp: sdp(FP_A), remoteSdp: sdp(FP_B) }), false);
  assert.equal(va.checkAuth('not json', { channelId: 'chan', self: 'a', peer: 'b', localSdp: sdp(FP_A), remoteSdp: sdp(FP_B) }), false);
});

test('notes are Signal-sealed for one device, outside chats, and cannot be forged or redirected', async t => {
  const { alice, bob, make, approve } = await harness(t, { autoTrust: true });
  const text = va.authText('chan', 'a', 'b', sdp(FP_A), sdp(FP_B));
  const bobDevice = bob.service.deviceId, aliceDevice = alice.service.deviceId;
  const note = await alice.service.sealNote(bob.userId, bobDevice, text);
  assert.equal(note.senderDeviceId, aliceDevice);
  assert.equal(JSON.stringify(note).includes(FP_A), false, 'the fingerprints are not readable by the server');
  assert.equal(await bob.service.openNote(alice.userId, note), text);
  // Nothing about the note lands in chat history or the outbox.
  assert.equal([...alice.vault.data.keys()].some(key => key.startsWith('outbox') || key.startsWith('history')), false);
  // A replay of the same note is refused by Signal.
  await assert.rejects(bob.service.openNote(alice.userId, note));
  // Claimed to come from someone else: refused.
  const carol = await make();
  await assert.rejects(bob.service.openNote(carol.userId, await alice.service.sealNote(bob.userId, bobDevice, text)));
  // Sealed for Bob, given to Carol: she cannot open it.
  await assert.rejects(carol.service.openNote(alice.userId, await alice.service.sealNote(bob.userId, bobDevice, text)));
  // Notes in both directions keep working, and chat messages are unaffected by them.
  const back = await bob.service.sealNote(alice.userId, aliceDevice, 'reply');
  assert.equal(await alice.service.openNote(bob.userId, back), 'reply');
  assert.equal(await bob.service.openNote(alice.userId, await alice.service.sealNote(bob.userId, bobDevice, 'second')), 'second');
  await assert.rejects(alice.service.sealNote(bob.userId, randomUUID(), text), /не найдено/);
  void approve;
});

test('without automatic trust a note to an unchecked device is refused', async t => {
  const { alice, bob } = await harness(t);
  await assert.rejects(alice.service.sealNote(bob.userId, bob.service.deviceId, 'x'), { name: 'UntrustedDeviceError' });
});
