import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GATHER_RELAY_MS, GATHER_TIMEOUT_MS, ICE_REUSE_MS, gatherDone, hasRelay, isRelayCandidate } from '../src/calls/callModel.ts';

// A call between two mobile networks lives on the relay's address: the offer must not leave without it.

test('the offer waits for the relay\'s address: 3 s is enough only when it has arrived', () => {
  const at = (elapsedMs, more = {}) => gatherDone({ complete: false, relay: false, wantRelay: true, elapsedMs, ...more });
  assert.equal(at(100, { complete: true }), true, 'gathering finished: at once');
  assert.equal(at(GATHER_TIMEOUT_MS - 1, { relay: true }), false, 'the first 3 s are for the direct addresses too');
  assert.equal(at(GATHER_TIMEOUT_MS, { relay: true }), true);
  assert.equal(at(GATHER_TIMEOUT_MS), false, 'no relay address yet (a slow mobile link): the offer used to leave here, without it');
  assert.equal(at(7_000), false);
  assert.equal(at(7_000, { relay: true }), true, 'sent as soon as it arrives');
  assert.equal(at(GATHER_RELAY_MS), true, 'never later than 10 s');
  assert.equal(at(GATHER_TIMEOUT_MS, { wantRelay: false }), true, 'no relay on the server: as before');
});

test('the relay is recognised in the servers and among the candidates', () => {
  assert.equal(hasRelay([{ urls: ['stun:a:3478'] }, { urls: ['turn:a:3478?transport=udp', 'turn:a:3478?transport=tcp'], username: 'u', credential: 'c' }]), true);
  assert.equal(hasRelay([{ urls: 'TURNS:a:5349' }]), true);
  assert.equal(hasRelay([{ urls: ['stun:stun.l.google.com:19302'] }]), false);
  assert.equal(hasRelay(undefined), false);
  assert.equal(isRelayCandidate('candidate:3 1 udp 41885439 194.87.254.249 49171 typ relay raddr 10.0.0.2 rport 50000'), true);
  assert.equal(isRelayCandidate('candidate:1 1 udp 1686052607 85.1.2.3 40000 typ srflx raddr 10.0.0.2 rport 50000'), false);
  assert.equal(isRelayCandidate('candidate:0 1 udp 2122260223 100.64.1.2 50000 typ host'), false);
  assert.equal(isRelayCandidate(undefined), false);
});

test('the call screen uses the rule for the first offer, the answer and an ICE restart; the relay request is not given up at once', () => {
  const calls = readFileSync(new URL('../src/calls/CallProvider.tsx', import.meta.url), 'utf8');
  assert.equal(calls.match(/gatherDone\(\{ complete/g)?.length, 2, 'the first round and a restart');
  assert.ok(!/setTimeout\(done, GATHER_TIMEOUT_MS\)/.test(calls), 'no flat 3 s timer left');
  assert.ok(calls.includes('for (let attempt = 0; attempt < 2; attempt++)') && calls.includes('Date.now() - lastIce.at < ICE_REUSE_MS'));
  assert.ok(ICE_REUSE_MS < 6 * 60 * 60_000, 'reused only while the relay\'s password (6 h) is still good');
});
