import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionHeld, holdConnection, resetConnectionHolds, socketTick } from '../src/connectionHold.ts';

test('B12: holds are counted per key and released by the returned function', () => {
  resetConnectionHolds();
  assert.equal(connectionHeld(), false);
  const voice = holdConnection('voice'), call = holdConnection('call');
  assert.equal(connectionHeld(), true);
  voice();
  assert.equal(connectionHeld(), true, 'the call still holds it');
  call();
  assert.equal(connectionHeld(), false);
  resetConnectionHolds();
});

test('B12: in the background the socket sleeps, unless a call or a voice room holds it', () => {
  assert.equal(socketTick({ foreground: false, held: false, open: true, sinceReceive: 0 }), 'sleep');
  assert.equal(socketTick({ foreground: false, held: false, open: false, sinceReceive: 0 }), 'idle');
  assert.equal(socketTick({ foreground: false, held: true, open: true, sinceReceive: 1000 }), 'ping', 'the heartbeat keeps the room alive');
  assert.equal(socketTick({ foreground: false, held: true, open: true, sinceReceive: 20000 }), 'reconnect', 'a dead socket is replaced even in the background');
  assert.equal(socketTick({ foreground: false, held: true, open: false, sinceReceive: 0 }), 'idle');
});

test('B12: foreground behaviour is unchanged: ping while fresh, reconnect when stale', () => {
  assert.equal(socketTick({ foreground: true, held: false, open: true, sinceReceive: 3000 }), 'ping');
  assert.equal(socketTick({ foreground: true, held: false, open: true, sinceReceive: 15001 }), 'reconnect');
  assert.equal(socketTick({ foreground: true, held: false, open: false, sinceReceive: 0 }), 'idle');
  assert.equal(socketTick({ foreground: true, held: false, open: true, sinceReceive: 5000, stale: 4000 }), 'reconnect');
});
