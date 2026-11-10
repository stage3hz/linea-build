import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const r = loadTs(new URL('../src/calls/reconnect.ts', import.meta.url), {});
const meta = loadTs(new URL('../src/messageMeta.ts', import.meta.url), {});
const id = '0b6f1b9a-1f0e-4c43-9a35-0e6f0c1d2e3f';
const sdp = fp => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ${fp}\r\n`;
const A = 'AA:BB:CC', B = '11:22:33';

test('disconnected → «Восстановление связи…» → grace → restart with backoff → connected', () => {
  let s = r.linkNext(r.LINK_UP, { kind: 'state', state: 'disconnected' }, 1000);
  assert.equal(s.link.phase, 'grace'); assert.equal(s.restart, false); assert.equal(s.wakeAt, 1000 + r.DISCONNECT_GRACE_MS);
  assert.equal(r.linkShowsReconnecting(s.link), true, 'shown at once, the clock keeps running');
  s = r.linkNext(s.link, { kind: 'timer' }, 1000 + r.DISCONNECT_GRACE_MS);
  assert.equal(s.link.phase, 'reconnecting'); assert.equal(s.restart, true); assert.equal(s.link.attempts, 1);
  const t1 = 1000 + r.DISCONNECT_GRACE_MS;
  assert.equal(s.wakeAt, t1 + r.restartDelay(1));
  s = r.linkNext(s.link, { kind: 'timer' }, t1 + 100); assert.equal(s.restart, false, 'not before the backoff');
  s = r.linkNext(s.link, { kind: 'timer' }, t1 + r.restartDelay(1));
  assert.equal(s.restart, true); assert.equal(s.link.attempts, 2);
  s = r.linkNext(s.link, { kind: 'state', state: 'checking' }, t1 + 3000); assert.equal(s.link.phase, 'reconnecting');
  s = r.linkNext(s.link, { kind: 'state', state: 'connected' }, t1 + 4000);
  assert.deepEqual(s.link, r.LINK_UP); assert.equal(s.recovered, true); assert.equal(s.wakeAt, null);
});

test('a short blip recovers by itself without a restart', () => {
  let s = r.linkNext(r.LINK_UP, { kind: 'state', state: 'disconnected' }, 0);
  s = r.linkNext(s.link, { kind: 'state', state: 'connected' }, 1500);
  assert.equal(s.link.phase, 'up'); assert.equal(s.restart, false); assert.equal(s.recovered, true);
});

test('failed restarts at once; a repeated failed waits for its timer', () => {
  let s = r.linkNext(r.LINK_UP, { kind: 'state', state: 'failed' }, 0);
  assert.equal(s.restart, true); assert.equal(s.link.phase, 'reconnecting');
  s = r.linkNext(s.link, { kind: 'state', state: 'failed' }, 10); assert.equal(s.restart, false);
  s = r.linkNext(s.link, { kind: 'state', state: 'disconnected' }, 20); assert.equal(s.link.phase, 'reconnecting');
});

test('the window runs out: «Связь потеряна», and lost is final', () => {
  let s = r.linkNext(r.LINK_UP, { kind: 'state', state: 'disconnected' }, 0);
  let restarts = 0;
  for (let now = 0; now <= r.RECONNECT_WINDOW_MS && !s.end; now += 500) { s = r.linkNext(s.link, { kind: 'timer' }, now); if (s.restart) restarts++; }
  assert.equal(s.end, true); assert.equal(s.link.phase, 'lost');
  assert.ok(restarts >= 4 && restarts <= 8, `${restarts} restarts in 30 s`);
  assert.equal(r.linkNext(s.link, { kind: 'state', state: 'connected' }, 40_000).link.phase, 'lost');
  assert.equal(r.linkNext(s.link, { kind: 'network' }, 40_000).restart, false);
});

test('backoff grows and is capped', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(r.restartDelay), [2000, 4000, 8000, 8000, 8000, 8000]);
  assert.equal(r.restartDelay(0), 0);
});

test('network change: restart at once; while up no «Восстановление связи…»', () => {
  const up = r.linkNext(r.LINK_UP, { kind: 'network' }, 0);
  assert.equal(up.restart, true); assert.equal(up.link.phase, 'up');
  let s = r.linkNext(r.LINK_UP, { kind: 'state', state: 'disconnected' }, 0);
  s = r.linkNext(s.link, { kind: 'network' }, 500);
  assert.equal(s.restart, true); assert.equal(s.link.phase, 'reconnecting'); assert.equal(s.link.troubleAt, 0, 'the window still counts from the first drop');
  assert.equal(r.networkKey({ type: 'wifi', isConnected: true, details: { ipAddress: '10.0.0.2' } }), 'wifi|10.0.0.2');
  assert.notEqual(r.networkKey({ type: 'cellular', isConnected: true, details: {} }), r.networkKey({ type: 'wifi', isConnected: true, details: {} }));
  assert.equal(r.networkKey({ type: 'none', isConnected: false }), 'offline');
});

test('glare: the caller keeps its offer, the callee rolls back and answers', () => {
  const base = { gen: 2, lastRemoteGen: 1, fingerprintsMatch: true };
  assert.equal(r.remoteRestart({ ...base, signalingState: 'stable', polite: false }), 'answer');
  assert.equal(r.remoteRestart({ ...base, signalingState: 'have-local-offer', polite: false }), 'ignore-glare');
  assert.equal(r.remoteRestart({ ...base, signalingState: 'have-local-offer', polite: true }), 'rollback-and-answer');
  assert.equal(r.remoteRestart({ ...base, signalingState: 'have-local-offer', polite: false, pendingAgeMs: r.PENDING_OFFER_STALE_MS + 1 }), 'rollback-and-answer', 'our own offer was probably lost');
  assert.equal(r.voiceRestartOfferer('a', 'b'), true); assert.equal(r.voiceRestartOfferer('b', 'a'), false);
});

test('stale or repeated restarts and foreign fingerprints are ignored', () => {
  assert.equal(r.remoteRestart({ gen: 3, lastRemoteGen: 3, signalingState: 'stable', polite: true, fingerprintsMatch: true }), 'ignore-stale');
  assert.equal(r.remoteRestart({ gen: 2, lastRemoteGen: 3, signalingState: 'stable', polite: true, fingerprintsMatch: true }), 'ignore-stale');
  assert.equal(r.remoteRestart({ gen: 4, lastRemoteGen: 3, signalingState: 'stable', polite: true, fingerprintsMatch: false }), 'ignore-fingerprint');
  assert.equal(r.restartAnswerFits({ gen: 2, pendingGen: 2, signalingState: 'have-local-offer', fingerprintsMatch: true }), true);
  assert.equal(r.restartAnswerFits({ gen: 1, pendingGen: 2, signalingState: 'have-local-offer', fingerprintsMatch: true }), false, 'answer to an older offer');
  assert.equal(r.restartAnswerFits({ gen: 2, pendingGen: null, signalingState: 'stable', fingerprintsMatch: true }), false, 'already applied');
  assert.equal(r.restartAnswerFits({ gen: 2, pendingGen: 2, signalingState: 'have-local-offer', fingerprintsMatch: false }), false);
  assert.equal(r.sameFingerprints(sdp(A), sdp(A.toLowerCase())), true);
  assert.equal(r.sameFingerprints(sdp(A), sdp(B)), false);
  assert.equal(r.sameFingerprints('v=0\r\n', 'v=0\r\n'), false, 'no fingerprint is never a match');
});

test('capability marker: added before the first m= line, detected, stripped, idempotent', () => {
  const marked = r.markRestartCapable(sdp(A));
  assert.equal(r.restartCapable(marked), true); assert.equal(r.restartCapable(sdp(A)), false);
  assert.ok(marked.indexOf(r.RESTART_ATTRIBUTE) < marked.indexOf('m=audio'));
  assert.equal(r.markRestartCapable(marked), marked);
  assert.equal(r.stripRestartMarker(marked), sdp(A));
  assert.equal(r.sameFingerprints(marked, sdp(A)), true);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'offer', sdp: marked } }), true, 'older apps accept the marked SDP');
});

test('restart steps are valid encrypted call actions, numbered, never visible', () => {
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'restart', gen: 1, sdp: sdp(A) } }), true);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'restart-answer', gen: 7, sdp: sdp(B) } }), true);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'restart', sdp: sdp(A) } }), false, 'needs a number');
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'restart', gen: 0, sdp: sdp(A) } }), false);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'restart', gen: 1.5, sdp: sdp(A) } }), false);
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'restart', gen: 1 } }), false, 'needs SDP');
  assert.equal(meta.validMeta({ action: { type: 'call', call: id, step: 'offer', gen: 1, sdp: sdp(A) } }), false, 'only restarts carry a number');
  const message = { id: 1, chatId: 'c', senderId: 'u', clientId: id, text: '📞', attachment: null, createdAt: '2026-11-10T10:00:00Z', cryptoState: 'decrypted', meta: { action: { type: 'call', call: id, step: 'restart', gen: 1, sdp: sdp(A) } } };
  assert.equal(meta.foldChat([message], 'u').messages.length, 0);
  assert.equal(meta.isCallSignal(message), true);
});

// Voice rooms: an ICE restart of a verified peer goes through voice.signal; it is recognised by the
// fingerprints the connection was verified with, and the verification (voiceAuth) stays in force.
const FP_ME = Array(32).fill('AA').join(':'), FP_ONE = Array(32).fill('11').join(':');
const vsdp = (fp, marked = true) => { const s = `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ${fp}\r\n`; return marked ? r.markRestartCapable(s) : s; };
function voiceFixture() {
  const pcs = [], socket = []; let handler;
  const mic = { kind: 'audio', enabled: true, stop() {}, addEventListener() {} };
  const stream = t => ({ release() {}, getTracks: () => [t], getAudioTracks: () => [t], getVideoTracks: () => [] });
  class PC {
    iceGatheringState = 'complete'; signalingState = 'stable'; connectionState = 'new'; listeners = {}; closed = false; offers = []; remotes = [];
    constructor() { pcs.push(this); }
    addEventListener(n, cb) { (this.listeners[n] ||= []).push(cb); }
    removeEventListener(n, cb) { this.listeners[n] = (this.listeners[n] || []).filter(x => x !== cb); }
    emit(n, e = {}) { for (const cb of [...(this.listeners[n] || [])]) cb(e); }
    addTransceiver() { return { sender: { track: null, replaceTrack: async () => {}, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} } }; }
    addTrack(t) { this.micSender = { track: t, replaceTrack: async x => { this.micSender.track = x; } }; return this.micSender; }
    createDataChannel() { return { readyState: 'open', label: 'screen-control', addEventListener() {}, send() {} }; }
    getReceivers() { return []; }
    async createOffer(o) { this.offers.push(o || {}); return { type: 'offer', sdp: vsdp(FP_ME, false) }; }
    async createAnswer() { return { type: 'answer', sdp: vsdp(FP_ME, false) }; }
    async setLocalDescription(v) { if (v.type === 'rollback') { this.signalingState = 'stable'; return; } this.localDescription = v; this.signalingState = v.type === 'offer' ? 'have-local-offer' : 'stable'; setTimeout(() => this.emit('icegatheringstatechange'), 0); }
    async setRemoteDescription(v) { this.remotes.push(v); this.remoteDescription = v; this.signalingState = v.type === 'offer' ? 'have-remote-offer' : 'stable'; }
    close() { this.closed = true; }
    state(value) { this.connectionState = value; this.emit('connectionstatechange'); }
  }
  const voice = loadTs(new URL('../src/communities/voice.ts', import.meta.url), {
    'react-native': { Platform: { OS: 'ios' } },
    react: { useSyncExternalStore: (_s, snapshot) => snapshot() },
    './voiceSounds': { playVoiceSound() {} },
    './screenCapture': { prepareScreenCapture: async () => {}, confirmScreenCapture: async () => {}, endScreenCapture() {} },
    'react-native-webrtc': { RTCPeerConnection: PC, RTCSessionDescription: class { constructor(v) { Object.assign(this, v); } }, MediaStream: class { constructor(t) { return stream(t[0]); } }, mediaDevices: { getUserMedia: async () => stream(mic) } },
    'react-native-incall-manager': { default: { start() {}, stop() {}, setForceSpeakerphoneOn() {} } },
    '../network/netChange': { onNetworkChange: () => () => {} },
  });
  const crypto = { initialize: async () => {}, deviceId: 'dev-me', sealNote: async (_u, _d, text) => ({ senderDeviceId: 'dev-me', type: 3, body: text }), openNote: async (_u, note) => note.body };
  const store = { sendSocket: m => { socket.push(m); return true; }, onSocket: cb => { handler = cb; return () => {}; }, cryptoRuntime: { get: async () => crypto } };
  const flush = async () => { for (let i = 0; i < 5; i++) { for (let j = 0; j < 30; j++) await Promise.resolve(); await new Promise(res => setTimeout(res, 1)); } };
  return {
    voice, pcs, socket, flush, receive: d => handler(d),
    // We are «me»; «one» sorts after us, so we offer restarts (voiceRestartOfferer) and win glare.
    async join(peer = 'one', fp = FP_ONE, marked = true) {
      await voice.joinVoice({ callIce: async () => ({ iceServers: [] }) }, store, { communityId: 'g', communityName: 'G', channelId: 'voice', channelName: 'V' });
      handler({ type: 'voice.joined', channelId: 'voice', self: 'me', peers: [{ peer, userId: 'u-' + peer, device: 'dev-' + peer }] }); await flush();
      handler({ type: 'voice.signal', channelId: 'voice', from: peer, userId: 'u-' + peer, data: { kind: 'answer', sdp: vsdp(fp, marked) } }); await flush();
      handler({ type: 'voice.auth', channelId: 'voice', from: peer, userId: 'u-' + peer, note: { senderDeviceId: 'dev-' + peer, type: 3, body: JSON.stringify({ v: 1, channelId: 'voice', from: peer, to: 'me', mine: 'sha-256 ' + fp, yours: 'sha-256 ' + FP_ME }) } });
      await flush();
    },
  };
}

test('voice room: a dropped verified peer gets an ICE restart through voice.signal and stays verified', async () => {
  const f = voiceFixture(); await f.join();
  const [pc] = f.pcs; assert.equal(pc.micSender.track?.kind, 'audio', 'verified');
  f.socket.length = 0;
  pc.state('failed'); await f.flush();
  assert.deepEqual(pc.offers.at(-1), { iceRestart: true });
  const offer = f.socket.find(m => m.type === 'voice.signal' && m.data.kind === 'offer');
  assert.ok(offer && r.restartCapable(offer.data.sdp));
  f.receive({ type: 'voice.signal', channelId: 'voice', from: 'one', userId: 'u-one', data: { kind: 'answer', sdp: vsdp(FP_ONE) } }); await f.flush();
  assert.equal(pc.closed, false); assert.equal(f.pcs.length, 1, 'the same connection, no new auth round');
  assert.equal(pc.remotes.at(-1).type, 'answer'); assert.equal(r.restartCapable(pc.remotes.at(-1).sdp), false, 'marker stripped before WebRTC');
  assert.equal(pc.micSender.track?.kind, 'audio');
  pc.state('connected'); f.voice.leaveVoice();
});

test('voice room: a restart answer with another DTLS fingerprint is refused', async () => {
  const f = voiceFixture(); await f.join();
  const [pc] = f.pcs; pc.state('failed'); await f.flush();
  f.receive({ type: 'voice.signal', channelId: 'voice', from: 'one', userId: 'u-one', data: { kind: 'answer', sdp: vsdp(Array(32).fill('EE').join(':')) } }); await f.flush();
  assert.equal(pc.closed, true); assert.match(f.voice.useVoice().error, /шифрование/);
  f.voice.leaveVoice();
});

test('voice room: the peer’s restart offer (same fingerprint) is answered on the same connection; a new fingerprint starts over', async () => {
  const f = voiceFixture(); await f.join();
  const [pc] = f.pcs; f.socket.length = 0;
  f.receive({ type: 'voice.signal', channelId: 'voice', from: 'one', userId: 'u-one', data: { kind: 'offer', sdp: vsdp(FP_ONE) } }); await f.flush();
  assert.equal(f.pcs.length, 1); assert.equal(pc.remotes.at(-1).type, 'offer');
  assert.ok(f.socket.some(m => m.type === 'voice.signal' && m.data.kind === 'answer'));
  assert.equal(f.socket.some(m => m.type === 'voice.auth'), false, 'no new note needed');
  f.receive({ type: 'voice.signal', channelId: 'voice', from: 'one', userId: 'u-one', data: { kind: 'offer', sdp: vsdp('22:'.repeat(31) + '22') } }); await f.flush();
  assert.equal(pc.closed, true); assert.equal(f.pcs.length, 2, 'a rejoin is a new connection, checked again');
  f.voice.leaveVoice();
});

test('voice room: an older app (no marker) never gets a restart', async () => {
  const f = voiceFixture(); await f.join('one', FP_ONE, false);
  const [pc] = f.pcs; f.socket.length = 0; pc.state('failed'); await f.flush();
  assert.equal(f.socket.some(m => m.type === 'voice.signal'), false);
  f.voice.leaveVoice();
});
