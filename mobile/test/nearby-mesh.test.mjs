import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';

const { MeshStore, MESH_LIMITS, parsePacket } = loadTs(new URL('../src/nearby/mesh.ts', import.meta.url));
const { recipientTag } = loadTs(new URL('../src/nearby/tag.ts', import.meta.url));
const NOW = 1_800_000_000_000;
const packet = (to, extra = {}) => ({ v: 1, id: randomBytes(16).toString('hex'), kind: 'msg', to, hops: 0, expiresAt: NOW + 3600_000, body: '{"scheme":"signal-v1"}', ...extra });
const phone = userId => new MeshStore(() => [recipientTag(userId)]);
// Two phones meet: each tells what it has, asks for what it lacks, receives it.
function meet(a, b, now = NOW) {
  const delivered = [];
  for (const [from, to] of [[a, b], [b, a]]) for (const p of from.give(to.wanted(from.inventory(now)), now)) { const r = to.receive(p, now); if (r.deliver) delivered.push(r.deliver); }
  return delivered;
}

test('recipient tag is stable, short and url-safe', () => {
  assert.equal(recipientTag('u1'), recipientTag('u1'));
  assert.notEqual(recipientTag('u1'), recipientTag('u2'));
  assert.match(recipientTag('u1'), /^[A-Za-z0-9_-]{22}$/);
});

test('a message hops A → B → C and is delivered only to C, once', () => {
  const A = phone('alice'), B = phone('bob'), C = phone('carol');
  const msg = packet(recipientTag('carol'));
  A.addOwn(msg, NOW);
  assert.deepEqual(meet(A, B), []);
  assert.equal(B.size, 1, 'B keeps it to pass on');
  const got = meet(B, C);
  assert.equal(got.length, 1); assert.equal(got[0].id, msg.id); assert.equal(got[0].hops, 1);
  assert.deepEqual(meet(A, C), [], 'C never gets the same message twice');
});

test('ack lets relays drop the delivered message', () => {
  const B = phone('bob'); const msg = packet(recipientTag('carol'));
  B.receive(msg, NOW); assert.equal(B.size, 1);
  B.forget(msg.id, NOW); assert.equal(B.size, 0);
  assert.equal(B.receive(msg, NOW).stored, false, 'not taken again after ack');
});

test('hop limit, expiry and malformed packets from strangers', () => {
  const B = phone('bob');
  assert.equal(B.receive(packet('x'.repeat(22), { hops: MESH_LIMITS.maxHops }), NOW).stored, false);
  assert.equal(B.receive(packet('x'.repeat(22), { expiresAt: NOW - 1 }), NOW).stored, false);
  assert.equal(B.receive(packet('x'.repeat(22), { expiresAt: NOW + 30 * 86400_000 }), NOW).stored, false, 'too far in the future');
  assert.equal(B.receive({ ...packet('x'.repeat(22)), body: 'a'.repeat(MESH_LIMITS.maxBody + 1) }, NOW).stored, false);
  for (const bad of [null, 1, 'x', { v: 2 }, { ...packet('bad tag!') }, { ...packet('x'.repeat(22)), id: '../../etc' }, { ...packet('x'.repeat(22)), kind: 'exec' }]) assert.equal(B.receive(bad, NOW).stored, false);
  assert.equal(parsePacket({ ...packet('x'.repeat(22)), extra: 'dropped' }, NOW).extra, undefined, 'unknown fields are not carried on');
  assert.deepEqual(B.wanted(['zz', 5, null]), []);
  assert.deepEqual(B.give('nope', NOW), []);
  const expiring = packet('y'.repeat(22), { expiresAt: NOW + 10 }); B.receive(expiring, NOW);
  assert.deepEqual(B.inventory(NOW + 20).includes(expiring.id), false, 'expired packets disappear');
});

test('storage is bounded and our own messages are kept longest', () => {
  const B = phone('bob'); const own = packet(recipientTag('carol'));
  B.addOwn(own, NOW);
  for (let i = 0; i < MESH_LIMITS.maxPackets + 50; i++) B.receive(packet('z'.repeat(22)), NOW + i);
  assert.equal(B.size, MESH_LIMITS.maxPackets);
  assert.ok(B.inventory(NOW + 1000).includes(own.id));
});

const { MeshSession, ackBody, packetFor, newPacketId, receiptTarget } = loadTs(new URL('../src/nearby/session.ts', import.meta.url));

// Phones linked in memory; `link(a,b)` = they came into Bluetooth range.
function town() {
  const phones = new Map(); const queue = [];
  const make = name => {
    const log = { delivered: [], handed: [] };
    const s = new MeshSession(() => [recipientTag(name)], (peer, text) => queue.push([peer, name, text]), { deliver: p => log.delivered.push(p), handedOver: id => log.handed.push(id) }, () => NOW);
    phones.set(name, { s, log }); return phones.get(name);
  };
  const flush = () => { let n = 0; while (queue.length && n++ < 10000) { const [to, from, text] = queue.shift(); phones.get(to).s.receive(from, text); } };
  const link = (a, b) => { phones.get(a).s.peerJoined(b); phones.get(b).s.peerJoined(a); flush(); };
  const unlink = (a, b) => { phones.get(a).s.peerLeft(b); phones.get(b).s.peerLeft(a); };
  return { make, link, unlink, flush };
}

test('session: Alice → (Bob walks over) → Carol, then the receipt reaches Alice through Bob', () => {
  const t = town(); const A = t.make('alice'), B = t.make('bob'), C = t.make('carol');
  const id = newPacketId(n => randomBytes(n));
  A.s.publish(packetFor('msg', recipientTag('carol'), '{"scheme":"signal-v1"}', id, NOW));
  t.link('alice', 'bob');
  assert.deepEqual(A.log.handed, [id], 'Alice sees «передано в Mesh»');
  t.unlink('alice', 'bob');
  t.link('bob', 'carol');
  assert.equal(C.log.delivered.length, 1); assert.equal(C.log.delivered[0].id, id);
  // Carol answers with a receipt. Bob passes it on but keeps the message: a receipt on the radio is
  // not authenticated, so it must never decide what a relay drops (see the forgery tests below).
  C.s.publish(packetFor('ack', recipientTag('alice'), ackBody(id), newPacketId(n => randomBytes(n)), NOW));
  t.flush();
  assert.equal(B.s.store.inventory(NOW).includes(id), true, 'Bob keeps the message until it expires');
  t.unlink('bob', 'carol'); t.link('bob', 'alice');
  assert.equal(A.log.delivered.filter(p => p.kind === 'ack').length, 1, 'Alice gets «доставлено»');
  assert.equal(receiptTarget(A.log.delivered.find(p => p.kind === 'ack')), id);
  assert.equal(B.s.store.inventory(NOW + MESH_LIMITS.ttlMs + 1).includes(id), false, 'expiry is what clears a relay');
});

test('session: a forged ack from a nearby phone drops nothing and is shown to nobody', () => {
  const t = town(); const A = t.make('alice'), B = t.make('bob'), C = t.make('carol'), E = t.make('eve');
  const id = newPacketId(n => randomBytes(n));
  A.s.publish(packetFor('msg', recipientTag('carol'), '{"scheme":"signal-v1"}', id, NOW));
  t.link('alice', 'bob'); t.unlink('alice', 'bob');
  assert.equal(B.s.store.inventory(NOW).includes(id), true, 'Bob relays Alice\'s message');
  // Eve walks up to Bob, learns the id from his inventory and forges receipts for it, addressed
  // to the recipient, to the sender and to a random tag (she can compute any tag she likes).
  t.link('eve', 'bob');
  for (const to of [recipientTag('carol'), recipientTag('alice'), recipientTag('nobody')]) {
    E.s.publish(packetFor('ack', to, ackBody(id), newPacketId(n => randomBytes(n)), NOW));
    E.s.publish(packetFor('read', to, JSON.stringify({ read: id }), newPacketId(n => randomBytes(n)), NOW));
  }
  t.flush();
  assert.equal(B.s.store.inventory(NOW).includes(id), true, 'the relay still holds the message');
  // Carol meets Eve (who relays both the forged receipts and the real message, taken from Bob),
  // then Bob: the real message must arrive exactly once and no forged receipt is shown to Carol.
  t.link('eve', 'carol'); t.unlink('eve', 'carol'); t.link('bob', 'carol');
  assert.equal(C.log.delivered.filter(p => p.kind === 'msg' && p.id === id).length, 1, 'Carol receives the real message');
  assert.deepEqual(C.log.delivered.filter(p => p.kind !== 'msg'), [], 'a receipt for a message Carol never sent is not shown to her');
  // Alice hears the forged receipts: her own copy stays available for other phones.
  t.link('eve', 'alice'); t.flush();
  assert.equal(A.s.store.inventory(NOW).includes(id), true, 'Alice keeps offering her own message');
  // A receipt for someone else\'s message is never shown as «доставлено»/«прочитано».
  const other = newPacketId(n => randomBytes(n));
  E.s.publish(packetFor('ack', recipientTag('alice'), ackBody(other), newPacketId(n => randomBytes(n)), NOW));
  E.s.publish(packetFor('read', recipientTag('alice'), JSON.stringify({ read: other }), newPacketId(n => randomBytes(n)), NOW));
  t.flush();
  assert.deepEqual(A.log.delivered.filter(p => receiptTarget(p) === other), []);
});

test('receiptTarget accepts only well-formed ack/read bodies', () => {
  const id = 'ab'.repeat(16);
  assert.equal(receiptTarget(packetFor('ack', 'x'.repeat(22), ackBody(id), id, NOW)), id);
  assert.equal(receiptTarget(packetFor('read', 'x'.repeat(22), JSON.stringify({ read: id }), id, NOW)), id);
  assert.equal(receiptTarget(packetFor('ack', 'x'.repeat(22), JSON.stringify({ read: id }), id, NOW)), null, 'kind and body must agree');
  assert.equal(receiptTarget(packetFor('msg', 'x'.repeat(22), ackBody(id), id, NOW)), null);
  for (const body of ['', 'nope', '{"ack":5}', '{"ack":"../x"}', JSON.stringify({ ack: id.slice(1) })]) assert.equal(receiptTarget(packetFor('ack', 'x'.repeat(22), body, id, NOW)), null);
});

test('session ignores garbage from a nearby phone', () => {
  const t = town(); const B = t.make('bob');
  for (const junk of ['', 'x', '{}', '{"t":"pkt","p":5}', '{"t":"want","ids":"all"}', 'a'.repeat(80000)]) B.s.receive('evil', junk);
  assert.equal(B.s.store.size, 0);
});
