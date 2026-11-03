import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterConfig, majority, shouldGrantVote } from '../src/cluster.js';

const me = { myEpoch: 3, votedEpoch: 3, heardLeaderAgoMs: 20000, leaseMs: 8000, myPosition: 100 };

test('majority of the whole cluster', () => {
  assert.equal(majority(1), 1); assert.equal(majority(2), 2); assert.equal(majority(3), 2); assert.equal(majority(5), 3);
});

test('vote: only a newer epoch, once, after the primary went quiet, to a fresh enough copy', () => {
  assert.equal(shouldGrantVote(me, { epoch: 4, position: 100 }), true);
  assert.equal(shouldGrantVote(me, { epoch: 3, position: 999 }), false, 'same epoch');
  assert.equal(shouldGrantVote({ ...me, votedEpoch: 4 }, { epoch: 4, position: 100 }), false, 'already voted in this epoch');
  assert.equal(shouldGrantVote({ ...me, heardLeaderAgoMs: 1000 }, { epoch: 4, position: 100 }), false, 'primary still alive');
  assert.equal(shouldGrantVote(me, { epoch: 4, position: 99 }), false, 'candidate is missing data');
});

test('config is checked before anything starts', () => {
  const ok = { CLUSTER_SELF: 'msk', CLUSTER_PEERS: '[{"id":"spb","url":"https://api2.invizent.com"}]', CLUSTER_TOKEN: 'x'.repeat(32), CLUSTER_REPLICA: 's3://bucket/invizent' };
  assert.equal(clusterConfig(ok).self, 'msk');
  assert.throws(() => clusterConfig({ ...ok, CLUSTER_TOKEN: 'short' }), /CLUSTER_TOKEN/);
  assert.throws(() => clusterConfig({ ...ok, CLUSTER_REPLICA: '' }), /CLUSTER_REPLICA/);
  assert.throws(() => clusterConfig({ ...ok, CLUSTER_PEERS: '[{"id":"BAD ID","url":"x"}]' }), /CLUSTER_PEERS/);
});

test('witness votes only for a server that followed the last primary it heard', async () => {
  const { witnessGrantsVote } = await import('../src/cluster.js');
  const w = { myEpoch: 6, votedEpoch: 6, heardLeaderAgoMs: 20000, leaseMs: 8000, lastLeaderEpoch: 6 };
  assert.equal(witnessGrantsVote(w, { epoch: 7, followEpoch: 6 }), true);
  assert.equal(witnessGrantsVote(w, { epoch: 7, followEpoch: 5 }), false, 'was switched off during epoch 6: old copy');
  assert.equal(witnessGrantsVote(w, { epoch: 7 }), false, 'unknown freshness');
  assert.equal(witnessGrantsVote({ ...w, heardLeaderAgoMs: 1000 }, { epoch: 7, followEpoch: 6 }), false, 'primary still alive');
  assert.equal(witnessGrantsVote({ ...w, votedEpoch: 7 }, { epoch: 7, followEpoch: 6 }), false, 'one vote per epoch');
  assert.equal(witnessGrantsVote(w, { epoch: 6, followEpoch: 6 }), false, 'not a newer epoch');
});

test('a witness needs no storage settings', () => {
  const env = { CLUSTER_SELF: 'w', CLUSTER_PEERS: '[{"id":"msk","url":"https://api.invizent.com"}]', CLUSTER_TOKEN: 'x'.repeat(32), CLUSTER_WITNESS: '1' };
  assert.equal(clusterConfig(env).witness, true);
});
