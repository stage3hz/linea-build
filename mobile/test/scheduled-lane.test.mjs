import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { harness } from './support/crypto-harness.mjs';

// F4 «Отправить позже» with the real libsignal: a scheduled message is encrypted now and released
// later. Regression for the review finding: in the normal Double Ratchet session every reply in
// between is a DH step and libsignal keeps only 5 receiver chains, so after ≥6 exchanges the old
// ciphertext could not be opened any more. Scheduled messages therefore go through their own lane
// session per device (core.ts Lane), which never ratchets.
const deliverAt = '2026-11-09T09:00:00.000Z';
const exchange = async (relay, chatId, from, to, text) => { const id = randomUUID(); relay.deliver(from.userId, chatId, id, await from.service.encrypt(chatId, to.userId, id, text, null)); await to.service.syncChat(chatId); };
const shown = async (who, message) => { await who.service.syncChat(message.chatId); return who.service.preview(message); };

async function probe(t, rounds, { replies }) {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  await exchange(relay, chatId, alice, bob, 'hi'); await exchange(relay, chatId, bob, alice, 'hi back');
  const scheduledId = randomUUID();
  const scheduled = await alice.service.encrypt(chatId, bob.userId, scheduledId, 'scheduled text', null, undefined, deliverAt);
  assert.equal(scheduled.lane, 'scheduled', 'the envelope says which session opens it');
  for (let i = 0; i < rounds; i++) {
    await exchange(relay, chatId, alice, bob, `a${i}`);
    if (replies) await exchange(relay, chatId, bob, alice, `b${i}`);
  }
  const result = await shown(bob, relay.deliver(alice.userId, chatId, scheduledId, scheduled));
  return { state: result.cryptoState, text: result.text, createdAt: result.createdAt, alice, bob, relay, chatId };
}

for (const rounds of [6, 10, 50]) {
  test(`a scheduled message still opens after ${rounds} ping-pong rounds (DH ratchet steps) in between`, async t => {
    const result = await probe(t, rounds, { replies: true });
    assert.equal(result.state, 'decrypted'); assert.equal(result.text, 'scheduled text'); assert.equal(result.createdAt, deliverAt);
    // The normal session is untouched by the lane: both directions keep working afterwards.
    await exchange(result.relay, result.chatId, result.alice, result.bob, 'after');
    await exchange(result.relay, result.chatId, result.bob, result.alice, 'after back');
    const last = result.relay.messages.at(-1);
    assert.equal((await result.alice.service.preview(last)).text, 'after back');
  });
}
test('a scheduled message still opens after 50 one-way messages (skipped message keys)', async t => {
  const result = await probe(t, 50, { replies: false });
  assert.equal(result.state, 'decrypted'); assert.equal(result.text, 'scheduled text');
});

test('two scheduled messages released out of order both open; ordinary messages never carry the lane', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  await exchange(relay, chatId, alice, bob, 'hi'); await exchange(relay, chatId, bob, alice, 'hi back');
  const first = randomUUID(), second = randomUUID();
  const one = await alice.service.encrypt(chatId, bob.userId, first, 'first scheduled', null, undefined, deliverAt);
  const two = await alice.service.encrypt(chatId, bob.userId, second, 'second scheduled', null, undefined, '2026-11-10T09:00:00.000Z');
  assert.equal(one.lane, 'scheduled'); assert.equal(two.lane, 'scheduled');
  for (let i = 0; i < 8; i++) { await exchange(relay, chatId, alice, bob, `a${i}`); await exchange(relay, chatId, bob, alice, `b${i}`); }
  const later = relay.deliver(alice.userId, chatId, second, two);
  assert.equal((await shown(bob, later)).text, 'second scheduled');
  const earlier = relay.deliver(alice.userId, chatId, first, one);
  assert.equal((await shown(bob, earlier)).text, 'first scheduled', 'the earlier one is opened with a skipped message key of the lane');
  // Nobody encrypts to a lane address: Bob's replies and Alice's normal messages use the normal session only.
  const plainId = randomUUID();
  const plain = await alice.service.encrypt(chatId, bob.userId, plainId, 'plain', null);
  assert.equal(plain.lane, undefined); assert.equal(JSON.stringify(plain).includes('lane'), false);
  assert.equal((await shown(bob, relay.deliver(alice.userId, chatId, plainId, plain))).text, 'plain');
  const replyId = randomUUID();
  const reply = await bob.service.encrypt(chatId, alice.userId, replyId, 'reply', null);
  assert.equal(reply.lane, undefined);
  assert.equal((await shown(alice, relay.deliver(bob.userId, chatId, replyId, reply))).text, 'reply');
  const bobState = JSON.parse(await bob.vault.get('protocol'));
  const aliceState = JSON.parse(await alice.vault.get('protocol'));
  assert.ok(Object.keys(bobState.sessions).some(key => key.includes('.scheduled.in:')), 'Bob holds the receive-only lane session he opens scheduled messages with');
  assert.equal(Object.keys(bobState.sessions).some(key => key.includes('.scheduled:')), false, 'and no sending lane (he scheduled nothing)');
  assert.equal(Object.keys(aliceState.sessions).filter(key => key.includes('.scheduled:')).length, 1, 'Alice holds one lane per Bob device and none from Bob');
  assert.equal(relay.claims.filter(claim => claim.userId === bob.userId).length, 2, 'one prekey for the normal session, one for the lane');
});

test('the lane is started afresh once it is 20 days old; older lane messages still open', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  await exchange(relay, chatId, alice, bob, 'hi'); await exchange(relay, chatId, bob, alice, 'hi back');
  const oldId = randomUUID();
  const old = await alice.service.encrypt(chatId, bob.userId, oldId, 'old lane', null, undefined, deliverAt);
  const laneKey = `session:${bob.userId}:${bob.service.deviceId}:scheduled`;
  assert.ok(Date.now() - Date.parse(await alice.vault.get(laneKey)) < 60_000, 'the lane remembers when it was started');
  const claimsBefore = relay.claims.length;
  const sameId = randomUUID();
  const same = await alice.service.encrypt(chatId, bob.userId, sameId, 'same lane', null, undefined, deliverAt);
  assert.equal(relay.claims.length, claimsBefore, 'a fresh lane is reused without a new prekey');
  assert.equal(same.envelopes[0].type, 3, 'unanswered, the lane keeps sending PreKey messages (libsignal)');
  // 21 days pass (the vault remembers the start time; libsignal refuses unacknowledged sessions past 30 days).
  await alice.vault.commit({ [laneKey]: new Date(Date.now() - 21 * 86_400_000).toISOString() });
  const freshId = randomUUID();
  const fresh = await alice.service.encrypt(chatId, bob.userId, freshId, 'fresh lane', null, undefined, deliverAt);
  assert.equal(relay.claims.length, claimsBefore + 1, 'a new prekey bundle starts the lane afresh');
  assert.ok(Date.now() - Date.parse(await alice.vault.get(laneKey)) < 60_000);
  for (let i = 0; i < 7; i++) { await exchange(relay, chatId, alice, bob, `a${i}`); await exchange(relay, chatId, bob, alice, `b${i}`); }
  assert.equal((await shown(bob, relay.deliver(alice.userId, chatId, freshId, fresh))).text, 'fresh lane');
  assert.equal((await shown(bob, relay.deliver(alice.userId, chatId, oldId, old))).text, 'old lane', 'the archived lane chain still opens');
  assert.equal((await shown(bob, relay.deliver(alice.userId, chatId, sameId, same))).text, 'same lane');
});

test('a scheduled message as the first contact: the peer still starts a normal session to answer; own devices get the lane too', async t => {
  const { alice, bob, relay, chatId, approve, make } = await harness(t);
  const alice2 = await make(alice.userId);
  await approve(alice, bob); await approve(bob, alice); await approve(alice2, bob);
  const scheduledId = randomUUID();
  const scheduled = await alice.service.encrypt(chatId, bob.userId, scheduledId, 'first ever', null, undefined, deliverAt);
  assert.deepEqual(scheduled.envelopes.map(e => e.deviceId).sort(), [alice2.service.deviceId, bob.service.deviceId].sort(), 'the lane covers the peer and the sender\'s other device');
  const message = relay.deliver(alice.userId, chatId, scheduledId, scheduled);
  assert.equal((await shown(bob, message)).text, 'first ever');
  assert.equal((await shown(alice2, message)).text, 'first ever', 'the sender\'s second device reads it from its own lane');
  assert.equal(await bob.vault.get(`session:${alice.userId}:${alice.service.deviceId}`), null, 'no normal session with Alice was assumed from a lane message');
  const replyId = randomUUID();
  const reply = await bob.service.encrypt(chatId, alice.userId, replyId, 'and hello', null);
  assert.equal(reply.envelopes.find(e => e.deviceId === alice.service.deviceId).type, 3, 'Bob starts a normal session with a prekey bundle');
  assert.equal((await shown(alice, relay.deliver(bob.userId, chatId, replyId, reply))).text, 'and hello');
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, scheduledId, 'first ever', null), /уже использован/, 'the same clientId cannot switch lanes');
  relay.offline = true;
  await assert.rejects(alice.service.encrypt(chatId, bob.userId, randomUUID(), 'offline', null, undefined, deliverAt), /Нет связи/, 'scheduling needs the server (a lane may need a prekey bundle)');
});

// ---- after the re-review: both directions, own devices, a server forging the flag ----
const tryShow = async (who, message) => { for (let i = 0; i < 5; i++) { try { await who.service.syncChat(message.chatId); break; } catch (e) { if (i === 4) return { cryptoState: 'error', error: e.message }; } } return who.service.preview(message); };
const schedule = async (relay, chatId, from, to, text) => { const id = randomUUID(); const enc = await from.service.encrypt(chatId, to.userId, id, text, null, undefined, deliverAt); return { id, enc, deliver: () => relay.deliver(from.userId, chatId, id, enc) }; };

test('both sides schedule (and own devices too): each lane stays one-way, a pending message survives 8 more rounds', async t => {
  const { alice, bob, relay, chatId, approve, make } = await harness(t);
  const alice2 = await make(alice.userId);
  await approve(alice, bob); await approve(bob, alice); await approve(alice2, bob);
  const round = async (from, to, text) => {
    const s = await schedule(relay, chatId, from, to, text);
    const message = s.deliver();
    for (const reader of [alice, alice2, bob].filter(c => c !== from)) assert.equal((await tryShow(reader, message)).text, text, `${text} at a reader`);
    return s.enc;
  };
  for (let i = 0; i < 5; i++) { await round(alice, bob, `a${i}`); await round(bob, alice, `b${i}`); await round(alice2, bob, `c${i}`); }
  const pending = await schedule(relay, chatId, alice, bob, 'PENDING');
  for (let i = 0; i < 8; i++) {
    const b = await round(bob, alice, `b+${i}`); const a = await round(alice, bob, `a+${i}`); await round(alice2, bob, `c+${i}`);
    assert.ok(b.envelopes.every(e => e.type === 3) && a.envelopes.every(e => e.type === 3), 'nobody ever answers in a lane: it never ratchets');
  }
  const message = pending.deliver();
  assert.equal((await tryShow(bob, message)).text, 'PENDING');
  assert.equal((await tryShow(alice2, message)).text, 'PENDING', 'own second device too');
  await exchange(relay, chatId, alice, bob, 'normal'); await exchange(relay, chatId, bob, alice, 'normal back');
  assert.equal((await alice.service.preview(relay.messages.at(-1))).text, 'normal back');
});

test('a server that strips the lane flag: refused, nothing committed, the normal session keeps working', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  await exchange(relay, chatId, alice, bob, 'hi'); await exchange(relay, chatId, bob, alice, 'hi back');
  const before = await bob.vault.get('protocol');
  const p = await schedule(relay, chatId, alice, bob, 'lane');
  const { lane, ...stripped } = p.enc;
  assert.equal(lane, 'scheduled');
  const forged = relay.deliver(alice.userId, chatId, p.id, stripped);
  assert.notEqual((await tryShow(bob, forged)).cryptoState, 'decrypted');
  assert.equal(JSON.stringify(JSON.parse(await bob.vault.get('protocol')).sessions), JSON.stringify(JSON.parse(before).sessions), 'the rejected decryption left no session behind');
  // The forgery is shown to Bob only (Alice's own device would flag it: «Сервер изменил сохранённое сообщение»).
  await alice.vault.commit({ [`cursor:${chatId}`]: String(forged.id) });
  await exchange(relay, chatId, bob, alice, 'bob after');
  assert.equal((await alice.service.preview(relay.messages.at(-1))).text, 'bob after');
  await exchange(relay, chatId, alice, bob, 'alice after');
  assert.equal((await bob.service.preview(relay.messages.at(-1))).text, 'alice after');
});

test('a server that adds the lane flag to a normal first PreKey: refused, the one-time prekey is not spent, the real copy opens', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const id = randomUUID(); const enc = await alice.service.encrypt(chatId, bob.userId, id, 'first', null);
  const before = await bob.vault.get('protocol');
  const forged = relay.deliver(alice.userId, chatId, id, { ...enc, lane: 'scheduled' });
  assert.notEqual((await tryShow(bob, forged)).cryptoState, 'decrypted');
  const after = JSON.parse(await bob.vault.get('protocol'));
  assert.deepEqual(Object.keys(after.preKeys), Object.keys(JSON.parse(before).preKeys), 'no prekey consumed by the forged copy');
  assert.equal(Object.keys(after.sessions).length, 0);
  const id2 = randomUUID(); const enc2 = await alice.service.encrypt(chatId, bob.userId, id2, 'second', null);
  assert.equal((await tryShow(bob, relay.deliver(alice.userId, chatId, id2, enc2))).text, 'second', 'the normal session still starts from the same PreKey');
});

test('normal messages without a lane inside the ciphertext (older apps) still open', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const id = randomUUID(); const enc = await alice.service.encrypt(chatId, bob.userId, id, 'old style', null);
  assert.equal(enc.lane, undefined);
  assert.equal((await tryShow(bob, relay.deliver(alice.userId, chatId, id, enc))).text, 'old style');
});

test('the vault outbox names a scheduled message with its time, so a lost intent can be rebuilt', async t => {
  const { alice, bob, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const laneId = randomUUID(), plainId = randomUUID();
  await alice.service.encrypt(chatId, bob.userId, laneId, 'later', null, undefined, deliverAt);
  await alice.service.encrypt(chatId, bob.userId, plainId, 'now', null);
  const items = await alice.service.pendingOutbox();
  assert.equal(items.find(item => item.clientId === laneId).deliverAt, deliverAt);
  assert.equal(items.find(item => item.clientId === plainId).deliverAt, undefined);
  // Retried with the rebuilt time: the very same committed ciphertext.
  const again = await alice.service.encrypt(chatId, bob.userId, laneId, 'later', null, undefined, deliverAt);
  assert.equal(again.lane, 'scheduled');
});
