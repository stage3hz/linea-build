import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { callLink, callLinkLines } from '../src/calls/callModel.ts';

// Диагностика звонка: how the call travels and how well, from WebRTC's own statistics.
const reports = (local, more = {}) => [
  { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
  { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.184, state: 'succeeded', nominated: true },
  { id: 'L', type: 'local-candidate', ...local },
  { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
  { id: 'I', type: 'inbound-rtp', kind: 'audio', packetsLost: 30, packetsReceived: 970, jitter: 0.021, bytesReceived: 60_000, ...more.inbound },
  { id: 'O', type: 'outbound-rtp', kind: 'audio', bytesSent: 90_000, ...more.outbound },
];

test('the route is told apart: direct, through the relay by UDP, through the relay by TCP', () => {
  assert.equal(callLink(reports({ candidateType: 'srflx' }), null, 0).link.route, 'direct');
  assert.equal(callLink(reports({ candidateType: 'host' }), null, 0).link.route, 'direct');
  assert.equal(callLink(reports({ candidateType: 'relay', relayProtocol: 'udp' }), null, 0).link.route, 'relay-udp');
  assert.equal(callLink(reports({ candidateType: 'relay', relayProtocol: 'tcp' }), null, 0).link.route, 'relay-tcp');
  assert.equal(callLink(reports({ candidateType: 'relay' }), null, 0).link.route, 'relay');
  const theirs = reports({ candidateType: 'srflx' }); theirs[3].candidateType = 'relay';
  assert.equal(callLink(theirs, null, 0).link.route, 'relay', 'the other side\'s relay is a relay too');
  assert.equal(callLink([], null, 0).link.route, null);
});

test('delay, losses and jitter are read as they are; the bitrates come from two samples', () => {
  const first = callLink(reports({ candidateType: 'relay', relayProtocol: 'udp' }), null, 10_000);
  assert.deepEqual({ rtt: first.link.rttMs, loss: first.link.lossPct, jitter: first.link.jitterMs }, { rtt: 184, loss: 3, jitter: 21 });
  assert.equal(first.link.kbpsOut, null, 'no rate from one sample');
  const second = callLink(reports({ candidateType: 'relay', relayProtocol: 'udp' }, { inbound: { bytesReceived: 66_000 }, outbound: { bytesSent: 96_000 } }), first.sample, 12_000);
  assert.equal(second.link.kbpsOut, 24);
  assert.equal(second.link.kbpsIn, 24);
  const junk = callLink([{ id: 'P', type: 'candidate-pair', selected: true, currentRoundTripTime: 'x' }, null, 5], null, 0);
  assert.deepEqual(junk.link, { route: 'direct', rttMs: null, lossPct: null, jitterMs: null, kbpsOut: null, kbpsIn: null });
});

test('the lines on the call screen; a dash where there is no figure yet', () => {
  const lines = callLinkLines({ route: 'relay-tcp', rttMs: 184, lossPct: 3, jitterMs: 21, kbpsOut: 24, kbpsIn: null }, 'medium');
  assert.deepEqual(lines, ['Маршрут: через сервер (TCP)', 'Задержка: 184 мс · потери: 3 % · дрожание: 21 мс', 'Отправка: 24 кбит/с · приём: —', 'Режим звука: средний (24 кбит/с)']);
  assert.equal(callLinkLines({ route: null, rttMs: null, lossPct: null, jitterMs: null, kbpsOut: null, kbpsIn: null }, 'fast')[0], 'Маршрут: —');
  const screen = readFileSync(new URL('../src/calls/CallProvider.tsx', import.meta.url), 'utf8');
  assert.ok(screen.includes('onPress={() => setStats(value => !value)}'), 'a tap on the status shows them');
  assert.ok(screen.includes("if (!stats || call.status !== 'active') { setLink(null); lastSample.current = null; return; }"), 'read only while shown, in a call that is up');
});
