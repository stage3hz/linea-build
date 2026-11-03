import test from 'node:test';
import assert from 'node:assert/strict';
import { createSfu, parseSfuMessage, sfuConfig } from '../src/sfu.js';

test('SFU is off until SFU_PUBLIC_IP is set; config is checked', () => {
  assert.equal(sfuConfig({}), null);
  assert.deepEqual(sfuConfig({ SFU_PUBLIC_IP: '203.0.113.7' }), { ip: '203.0.113.7', port: 40000, listenIp: '0.0.0.0' });
  assert.throws(() => sfuConfig({ SFU_PUBLIC_IP: 'evil host' }));
  assert.throws(() => sfuConfig({ SFU_PUBLIC_IP: '1.2.3.4', SFU_PORT: '80' }));
});

test('messages from clients are checked strictly', () => {
  assert.deepEqual(parseSfuMessage({ id: 1, op: 'caps' }), { id: 1, op: 'caps' });
  assert.equal(parseSfuMessage({ id: 2, op: 'transport', direction: 'send' }).direction, 'send');
  for (const bad of [null, {}, { id: 'x', op: 'caps' }, { id: 1, op: 'rm' }, { id: 1, op: 'transport', direction: 'both' },
    { id: 1, op: 'produce', transportId: 't', kind: 'audio', rtpParameters: {}, source: 'microphone' },
    { id: 1, op: 'connect', transportId: 'x'.repeat(65), dtlsParameters: {} }, { id: 1, op: 'consume', transportId: 't', producerId: 'p', rtpCapabilities: [] }])
    assert.throws(() => parseSfuMessage(bad));
});

test('a room gives capabilities and transports; limits hold; leaving cleans up', async t => {
  const sfu = await createSfu({ config: { ip: '127.0.0.1', port: 40000 + Math.floor(Math.random() * 2000), listenIp: '127.0.0.1' } });
  t.after(() => sfu.close());
  const call = (socketId, data) => sfu.handle({ channelId: 'ch', socketId, data, notify: () => {} });
  const caps = await call('a', { id: 1, op: 'caps' });
  assert.ok(caps.rtpCapabilities.codecs.some(c => c.mimeType === 'video/VP8'));
  assert.ok(caps.rtpCapabilities.codecs.some(c => c.mimeType === 'audio/opus' && c.channels === 2), 'stereo opus');
  const send = await call('a', { id: 2, op: 'transport', direction: 'send' });
  assert.ok(send.id && send.iceCandidates.length && send.dtlsParameters.fingerprints.length);
  await call('a', { id: 3, op: 'transport', direction: 'recv' });
  await assert.rejects(call('a', { id: 4, op: 'transport', direction: 'recv' }), /too many/);
  await assert.rejects(call('b', { id: 5, op: 'connect', transportId: send.id, dtlsParameters: { fingerprints: [], role: 'client' } }), /no transport/, 'another socket cannot use it');
  assert.deepEqual((await call('b', { id: 6, op: 'producers' })).producers, []);
  sfu.leave('ch', 'a'); sfu.leave('ch', 'b');
  assert.equal(sfu.stats().rooms, 0);
});
