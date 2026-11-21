// Produces tests/vectors/calls.json: the rules of one-to-one calls as the reference itself answers them
// (mobile/src/calls/callModel.ts, reconnect.ts, callStatus.ts, callLog.ts and scheduled/model.ts `pushKind`).
// Run from the repository root:  node native/core/tests/generate-calls-vectors.mjs
//
// One case per line (JSON.stringify's own text): {"name", "args", "want"} — `name` and `args` are what the apps
// hand to the core (`calls::view`), `want` is the reference's answer put together the way the core's doc says.
// The Rust test (tests/calls_vectors.rs) reads and writes every line back to the same text and compares the
// answers as JSON text.
//
// The reference is imported as it is (Node strips the types); a resolve hook only adds the `.ts` its
// extensionless imports lack. Branch coverage of the ported functions is V8's own block coverage; the run fails
// if a block of them never ran.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const file = name => join(root, 'mobile/src', name);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/mobile/src/') && !/\.[a-z]+$/.test(specifier)) {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const model = await import(pathToFileURL(file('calls/callModel.ts')).href);
const reconnect = await import(pathToFileURL(file('calls/reconnect.ts')).href);
const status = await import(pathToFileURL(file('calls/callStatus.ts')).href);
const log = await import(pathToFileURL(file('calls/callLog.ts')).href);
const { pushKind } = await import(pathToFileURL(file('scheduled/model.ts')).href);

// ---- a deterministic generator ----
let seed = 0x5ca11ab5;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = n => Math.floor(rnd() * n);
const between = (a, b) => a + int(b - a + 1);
const chance = p => rnd() < p;
const pick = list => list[int(list.length)];
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[int(16)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

const lines = [];
const count = {};
const write = (name, args, want) => {
  const line = JSON.stringify({ name, args, want: want === undefined ? null : want });
  // What the apps hand over is JSON: a case must survive the trip unchanged.
  if (JSON.stringify(JSON.parse(line)) !== line) throw new Error(`not stable JSON: ${name}`);
  lines.push(line); count[name] = (count[name] ?? 0) + 1;
};

// ---- the constants ----
write('callRules', [], { offerTtlMs: model.OFFER_TTL_MS, ringTimeoutMs: model.RING_TIMEOUT_MS, gatherTimeoutMs: model.GATHER_TIMEOUT_MS, gatherRelayMs: model.GATHER_RELAY_MS,
  iceReuseMs: model.ICE_REUSE_MS, networkWaitMs: status.NETWORK_WAIT_MS, disconnectGraceMs: reconnect.DISCONNECT_GRACE_MS, politeExtraMs: reconnect.POLITE_EXTRA_MS,
  reconnectWindowMs: reconnect.RECONNECT_WINDOW_MS, barHeight: status.CALL_BAR_HEIGHT, noConnectionText: status.NO_CONNECTION_TEXT });

// ---- gathering ----
for (const complete of [false, true]) for (const relay of [false, true]) for (const wantRelay of [false, true])
  for (const elapsedMs of [0, 1, 2999, 3000, 3001, 9999, 10000, 10001, 60000, 2999.5, -5])
    write('callGatherDone', [complete, relay, wantRelay, elapsedMs], model.gatherDone({ complete, relay, wantRelay, elapsedMs }));
const CANDIDATES = ['candidate:1 1 udp 41885439 203.0.113.7 51000 typ relay raddr 0.0.0.0 rport 0', 'candidate:2 1 udp 2122260223 192.168.1.5 50000 typ host', 'candidate:3 1 udp 1686052607 198.51.100.2 50001 typ srflx raddr 192.168.1.5 rport 50000',
  'typ relay', 'typ relayed', 'xtyp relay', 'typ relay.', ' typ relay ', 'TYP RELAY', 'typ  relay', 'typ relay_', 'a-typ relay-b', 'ятyp relay', 'typ relayя', '', 'typ', 'typ relaytyp relay', 'typ relayx typ relay', null, 5, true, ['typ relay'], { candidate: 'typ relay' }];
for (const candidate of CANDIDATES) write('callIsRelayCandidate', [candidate], model.isRelayCandidate(candidate));
const SERVERS = [[], [{ urls: ['stun:stun.l.google.com:19302'] }], [{ urls: ['stun:a:3478'] }, { urls: ['turn:a:3478?transport=udp', 'turn:a:3478?transport=tcp'], username: 'u', credential: 'c' }], [{ urls: 'turns:a:443?transport=tcp' }], [{ urls: 'TURN:a' }], [{ urls: 'Turns:a' }],
  [{ urls: 'turn' }], [{ urls: 'turnss:a' }], [{ urls: ' turn:a' }], [{ urls: 'stun:turn:a' }], [{}], [{ urls: null }], [{ urls: [null, 5, 'turn:x'] }], [{ urls: [] }], [{ urls: 7 }], [5, 'turn:a', { urls: 'turn:b' }], [{ url: 'turn:a' }], [{ urls: ['x', ['turn:a']] }], [{ urls: 'turnſ:a' }], [{ urls: 'turnſ:a' }]];
for (const servers of SERVERS) write('callHasRelay', [servers], model.hasRelay(servers));

// ---- offers ----
{
  const base = Date.parse('2026-11-21T10:00:00.000Z');
  for (let i = 0; i < 300; i++) {
    const id = uuid();
    const seen = Array.from({ length: int(4) }, uuid); if (chance(0.25)) seen.push(id);
    const delta = pick([0, 1, -1, 59999, 60000, 60001, -59999, -60000, -60001, 30000, 120000, -120000, between(-200000, 200000)]);
    const created = chance(0.08) ? pick(['', 'вчера', '2026-13-01T00:00:00.000Z', '2026-11-21', '2026-11-21T10:00:00Z', '2026-11-21T13:00:00.000+03:00']) : new Date(base + (chance(0.5) ? 0 : int(999))).toISOString();
    const at = Date.parse(created);
    // The core reads the ISO form only; the server writes no other.
    const now = Number.isFinite(at) ? at + delta : base;
    write('callOfferFresh', [created, now, seen, id], model.offerIsFresh(created, now, new Set(seen), id));
  }
}

// ---- SDPs ----
const fp = () => Array.from({ length: 32 }, () => hex(2)).join(':');
const ALGOS = ['sha-256', 'SHA-256', 'sha-1', 'Sha-384', 'sha-512', 'ΣΑΣ-256', 'İ-256', 'ß256', 'x'];
function fingerprintLine() {
  const algo = chance(0.7) ? 'sha-256' : pick(ALGOS);
  const value = chance(0.5) ? fp().toUpperCase() : chance(0.5) ? fp() : pick(['AB:CD', 'ab', ':', 'A', 'zz:zz', 'AB:CG', '']);
  const tail = pick(['', '', '', ' ', '  ', '\t', ' x', ' ', ' ']);
  const sep = chance(0.93) ? ' ' : pick(['  ', '\t', '']);
  return `${chance(0.95) ? 'a=fingerprint:' : pick(['A=fingerprint:', 'a=fingerprint', ' a=fingerprint:', 'a=Fingerprint:'])}${algo}${sep}${value}${tail}`;
}
function sdp(options = {}) {
  const eol = options.eol ?? (chance(0.7) ? '\r\n' : '\n');
  const pt = options.pt ?? pick(['111', '111', '111', '109', '96', '0']);
  const out = ['v=0', `o=- ${between(1, 9e9)} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0'];
  if (chance(0.3)) out.push(fingerprintLine());
  if (options.marker ?? chance(0.3)) out.push(chance(0.9) ? reconnect.RESTART_ATTRIBUTE : pick(['a=x-invizent-restart:10', ' a=x-invizent-restart:1', 'a=x-invizent-restart:1 ']));
  out.push('a=group:BUNDLE 0 1', 'a=msid-semantic: WMS s');
  const media = between(0, 3);
  for (let m = 0; m < media; m++) {
    const audio = m === 0 ? chance(0.9) : chance(0.2);
    out.push(audio ? `m=audio 9 UDP/TLS/RTP/SAVPF ${pt} 63 9 0 8 13 110 126` : pick(['m=video 9 UDP/TLS/RTP/SAVPF 96 97', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel']));
    out.push('c=IN IP4 0.0.0.0', `a=ice-ufrag:${hex(4)}`, `a=ice-pwd:${hex(24)}`);
    if (chance(0.85)) out.push(fingerprintLine());
    if (chance(0.15)) out.push(fingerprintLine());
    out.push('a=setup:actpass', `a=mid:${m}`, 'a=sendrecv', 'a=rtcp-mux');
    if (audio) {
      if (chance(0.9)) out.push(pick([`a=rtpmap:${pt} opus/48000/2`, `a=rtpmap:${pt} opus/48000/2`, `a=rtpmap:${pt} opus/48000`, `a=rtpmap:${pt} OPUS/48000/2`, `A=RTPMAP:${pt} opus/48000/2`, `a=rtpmap:${pt}  opus/48000/2`, `a=rtpmap:${pt} opus/16000`, `xa=rtpmap:${pt} opus/48000/2`, `a=rtpmap:x${pt} opus/48000/2`, `a=rtpmap: opus/48000/2`]));
      if (chance(0.75)) out.push(`a=fmtp:${pt}${pick([' ', ' ', ' ', '  ', ''])}${pick(['minptime=10;useinbandfec=1', 'minptime=10; useinbandfec=1 ;stereo=1', 'stereo=1;sprop-stereo=1;maxaveragebitrate=510000', 'usedtx', 'cbr;usedtx=0;;x=;=y;a=b=c', '', ' ', ';', 'maxplaybackrate=48000;stereo=1;stereo=0', 'useinbandfec=1; minptime=10 '])}`);
      if (chance(0.1)) out.push(`a=fmtp:${pt} second=1`);
      out.push('a=rtpmap:63 red/48000/2', `a=fmtp:63 ${pt}/${pt}`);
      if (chance(0.2)) out.push(pick(['a=ptime:20', 'a=ptime:60', 'a=maxptime:60', ' a=ptime:20']));
    } else {
      out.push('a=rtpmap:96 VP8/90000', 'a=rtcp-fb:96 nack');
      if (chance(0.15)) out.push('a=ptime:20');
      if (chance(0.1)) out.push('a=rtpmap:120 opus/48000/2');
    }
    if (chance(0.3)) out.push(`a=candidate:1 1 udp 41885439 203.0.113.7 ${between(1024, 65000)} typ relay raddr 0.0.0.0 rport 0`);
  }
  const text = out.join(eol) + pick([eol, eol, eol, '', eol + eol]);
  return chance(0.03) ? text.replace(eol, pick(['\n', '\r', ' ', '\r\n'])) : text;
}
const ODD = ['', 'v=0', 'v=0\r\n', 'm=audio', 'a=rtpmap:111 opus/48000/2', 'a=rtpmap:111 opus/48000/2\na=fmtp:111 x=1\nm=audio 9\na=ptime:20\n', 'm=audio 9\na=rtpmap:111 opus/48000/2', 'm=audio 9\na=rtpmap:111 opus/48000/2\n', 'm=audio 9\r\na=rtpmap:111 opus/48000/2\r\n\r\n',
  'A=RTPMAP:111 OPUS/48000\nm=audio 9\n', 'a=x-invizent-restart:1', 'a=x-invizent-restart:1\n', 'a=x-invizent-restart:1\r\n', 'a=x-invizent-restart:1\r', 'v=0\ra=x-invizent-restart:1\rm=audio', 'v=0 a=x-invizent-restart:1 m=audio', 'v=0\na=x-invizent-restart:1x\na=x-invizent-restart:1\nm=audio\n',
  'v=0\n a=x-invizent-restart:1\nm=audio\n', 'v=0\r\r\na=x-invizent-restart:1\r\r\nm=audio 9\r\n', 'v=0\na=x-invizent-restart:1\n\na=x-invizent-restart:1\nm=audio\n', 'a=fingerprint:sha-256 AB:CD', 'a=fingerprint:sha-256 AB:CD\n\n\na=fingerprint:sha-1 01:02\n', 'a=fingerprint:sha-256 AB:CD  \n \n \t\na=fingerprint:sha-1 ef\r\r\n',
  'a=fingerprint:sha-256 AB:CD \n x\na=fingerprint:sha-256 AB:CE x\n', 'x\ra=fingerprint:sha-256 aa a=fingerprint:sha-256 bb a=fingerprint:sha-256 cc', 'a=fingerprint:sha-256 AB:CD \na=fingerprint: x AB\n', 'a=fingerprint:😀 AB\na=fingerprint:￿ AB\na=fingerprint:я AB\na=fingerprint:z AB\n', 'm=video 9\nm=audio 9\na=rtpmap:96 opus/48000\n',
  'm=audio 9\na=rtpmap:96 opus/48000\nm=video 9\n', 'm=audio 9\na=rtpmap:96 opus/48000\nm=video 9\na=ptime:20\n', 'a=rtpmap:96 opus/48000\na=rtpmap:97 opus/48000\na=fmtp:97 x\nm=audio\n', 'a=rtpmap:9١ opus/48000\nm=audio\n', 'a=rtpmap:96 opus/48000\na=fmtp:96 \nm=audio\n\n'];
const sdps = [...ODD, ...Array.from({ length: 220 }, () => sdp())];
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
for (const text of sdps) {
  for (const tier of ['slow', 'medium', 'fast']) write('callEconomySdp', [text, tier], model.economySdp(text, tier));
  write('callMarkRestart', [text], reconnect.markRestartCapable(text));
  write('callStripRestart', [text], reconnect.stripRestartMarker(text));
  write('callRestartCapable', [text], reconnect.restartCapable(text));
}
write('callRestartCapable', [null], reconnect.restartCapable(undefined));
// A marked SDP is capable, and stripping gives the SDP back.
for (const text of sdps.slice(ODD.length, ODD.length + 80)) { const marked = reconnect.markRestartCapable(text); write('callRestartCapable', [marked], reconnect.restartCapable(marked)); write('callStripRestart', [marked], reconnect.stripRestartMarker(marked)); }
for (let i = 0; i < 320; i++) {
  const a = pick(sdps), same = chance(0.4);
  // The other side of a pair: another SDP, or the same fingerprints in another order and spelling.
  const b = same ? a.split(/\r?\n/).reverse().map(line => (chance(0.3) && line.startsWith('a=fingerprint:sha-256 ') ? line.toLowerCase() : line)).join('\n') : pick(sdps);
  const material = model.keyMaterial(a, b);
  write('callKey', [a, b], material === null ? null : model.keyEmoji(sha256(material)));
  write('callSameFingerprints', [a, b], reconnect.sameFingerprints(a, b));
}

// ---- the `end`, the hang-up, the push ----
const REASONS = ['hangup', 'declined', 'busy', 'missed', 'failed'];
for (let i = 0; i < 400; i++) {
  const now = 1795000000000 + int(1e9);
  const startedAt = chance(0.4) ? null : chance(0.05) ? 0 : now - pick([0, 1, 499, 500, 501, 1499, 1500, 42000, 192000, 3725000, 7 * 86400000, 7 * 86400000 + 499, 7 * 86400000 + 500, 8 * 86400000, -1, -500, -501, -90000, between(0, 5e6)]);
  const call = { id: uuid(), video: chance(0.4), incoming: chance(0.5), startedAt };
  const reason = pick(REASONS);
  write('callEnd', [call, reason, now], model.callEndMeta(call, reason, now));
}
for (const state of ['requesting', 'ringing', 'incoming', 'connecting', 'active', 'ended', 'other']) for (const incoming of [false, true]) write('callHangup', [state, incoming], model.hangupOutcome(state, incoming));
const METAS = [null, {}, { silent: true }, { silent: false }, { silent: 1 }, { reply: { clientId: uuid() } }, { action: null, silent: true }, { action: { type: 'react', target: uuid(), emoji: '👍' } }, { action: { type: 'react', target: uuid(), emoji: '👍' }, silent: true },
  { action: { type: 'edit', target: uuid(), text: 'x' } }, { action: { type: 'settings', ttl: 0, noCopy: false } }];
for (const step of ['offer', 'answer', 'end', 'restart', 'restart-answer']) for (const reason of [undefined, ...REASONS]) for (const caller of [undefined, true, false]) for (const video of [undefined, true])
  METAS.push({ action: { type: 'call', call: uuid(), step, ...(reason ? { reason } : {}), ...(caller === undefined ? {} : { caller }), ...(video ? { video } : {}) } });
for (const meta of METAS) write('callPushKind', [meta], pushKind(meta ?? undefined) ?? null);

// ---- the link's grade, its caps, its statistics ----
const GRADES = ['good', 'weak', 'bad'];
const NUMBERS = [null, 0, 1, 2.9, 3, 3.1, 9.9, 10, 49, 50, 51, 119, 120, 121, 349, 350, 351, 799, 800, 801, 5000];
for (let i = 0; i < 600; i++) {
  const reading = { rttMs: pick(NUMBERS), lossPct: pick(NUMBERS), jitterMs: pick(NUMBERS) };
  if (chance(0.5)) { reading.rttMs = pick([null, 10, 100]); if (chance(0.5)) reading.jitterMs = pick([null, 5]); }
  const current = pick(GRADES), calm = int(4);
  const read = model.gradeLink(reading), step = model.steadyGrade(current, read, calm);
  write('callGrade', [reading, current, calm], { reading: read, grade: step.grade, calm: step.calm });
}
for (const tier of ['slow', 'medium', 'fast']) for (const grade of GRADES) write('callCaps', [tier, grade], { audio: model.audioCap(tier, grade), video: model.VIDEO_CAP[grade], send: model.SEND_BITRATE[tier], text: model.LINK_TEXT[grade] });
const maybe = (p, value) => (chance(p) ? value() : undefined);
function reports() {
  const list = [];
  const pairId = 'CP' + hex(4), localId = 'L' + hex(4), remoteId = 'R' + hex(4);
  const kind = pick(['transport', 'selected', 'nominated', 'none', 'transport-missing', 'both']);
  if (kind === 'transport' || kind === 'both' || kind === 'transport-missing') list.push({ id: 'T0', type: 'transport', selectedCandidatePairId: kind === 'transport-missing' ? pick(['nope', 5, null]) : pairId });
  if (kind !== 'none') {
    const pair = { id: pairId, type: 'candidate-pair', localCandidateId: chance(0.9) ? localId : pick([undefined, 7, 'gone']), remoteCandidateId: chance(0.9) ? remoteId : undefined,
      currentRoundTripTime: pick([undefined, 0, 0.0424, 0.25, 0.3505, 1.2, '0.1', null, 0.0005, 0.0015]) };
    if (kind === 'selected') pair.selected = pick([true, true, false, 1]);
    if (kind === 'nominated' || kind === 'both' || kind === 'transport-missing') { pair.nominated = pick([true, true, false]); pair.state = pick(['succeeded', 'succeeded', 'in-progress']); }
    list.push(pair);
    if (chance(0.3)) list.push({ id: 'CPx', type: 'candidate-pair', selected: true, currentRoundTripTime: 0.5 });
    list.push({ id: localId, type: 'local-candidate', candidateType: pick(['host', 'srflx', 'relay', 'relay', 'prflx']), relayProtocol: pick(['udp', 'tcp', 'tls', undefined, 'quic']) });
    list.push({ id: remoteId, type: 'remote-candidate', candidateType: pick(['host', 'srflx', 'relay']) });
    if (chance(0.1)) list.push({ id: localId, type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tcp' });
  }
  const rtp = (type, media) => ({ id: type + media + hex(2), type, ...(chance(0.8) ? { kind: media } : { mediaType: media }),
    ...(type === 'inbound-rtp' ? { packetsLost: pick([0, 0, 3, 40, -2, undefined, '4']), packetsReceived: pick([0, 100, 1000, 12345, undefined]), jitter: pick([undefined, 0, 0.004, 0.0505, 0.13, 0.0125]), bytesReceived: pick([undefined, 0, between(0, 5e6)]) }
      : { bytesSent: pick([undefined, 0, between(0, 5e6), '9']) }) });
  for (const media of ['audio', 'video']) { if (chance(0.85)) list.push(rtp('inbound-rtp', media)); if (chance(0.85)) list.push(rtp('outbound-rtp', media)); }
  if (chance(0.2)) list.push(null, 'text', 5, [], [{ type: 'transport' }], { type: 'codec' });
  for (let i = list.length - 1; i > 0; i--) { if (chance(0.3)) { const j = int(i + 1); [list[i], list[j]] = [list[j], list[i]]; } }
  return JSON.parse(JSON.stringify(list));
}
const linkSamples = [];
for (let i = 0; i < 900; i++) {
  const list = reports(), now = 1795000000000 + int(1e7);
  const previous = chance(0.3) ? null : { at: now - pick([0, 100, 499, 500, 501, 2000, 3000, -1000]), sent: pick([0, between(0, 5e6)]), received: pick([0, between(0, 5e6)]) };
  const answer = model.callLink(list, previous, now);
  write('callLink', [list, previous, now], answer);
  linkSamples.push(JSON.parse(JSON.stringify(answer.link)));
}
for (const link of [{ route: null, rttMs: null, lossPct: null, jitterMs: null, kbpsOut: null, kbpsIn: null }, ...linkSamples.slice(0, 250)]) for (const tier of ['slow', 'medium', 'fast']) write('callLinkLines', [link, tier], model.callLinkLines(link, tier));

// ---- reconnection ----
const STATES = ['new', 'checking', 'connecting', 'connected', 'completed', 'disconnected', 'failed', 'closed'];
for (let walk = 0; walk < 500; walk++) {
  let link = null, now = 1795000000000 + int(1e6);
  const incoming = chance(0.5), calm = chance(0.3);
  for (let stepIndex = 0; stepIndex < between(4, 30); stepIndex++) {
    const input = chance(0.45) ? { kind: 'timer' } : chance(0.2) ? { kind: 'network' } : { kind: 'state', state: calm && chance(0.6) ? pick(['disconnected', 'failed']) : pick(STATES) };
    const current = link ?? reconnect.LINK_UP;
    // The caller's grace is the reference's own default.
    const step = incoming ? reconnect.linkNext(current, input, now, { graceMs: reconnect.DISCONNECT_GRACE_MS + reconnect.POLITE_EXTRA_MS }) : reconnect.linkNext(current, input, now);
    write('callLinkNext', [link, input, now, incoming], { ...step, showing: reconnect.linkShowsReconnecting(step.link) });
    link = JSON.parse(JSON.stringify(step.link));
    // Mostly the timer fires when it is due; sometimes early, late, or much later.
    now = step.wakeAt !== null && chance(0.6) ? step.wakeAt + pick([0, 0, 1, -1, 250]) : now + pick([0, 1, 500, 2000, 3000, 4500, 8000, 31000]);
  }
}
// States the machine itself never makes (a time is missing): the reference still answers, and so does the core.
for (const phase of ['up', 'grace', 'reconnecting', 'lost']) for (const troubleAt of [null, 1795000000000]) for (const nextAt of [null, 1795000002000]) for (const attempts of [0, 2, 5])
  for (const input of [{ kind: 'timer' }, { kind: 'network' }, { kind: 'state', state: 'failed' }, { kind: 'state', state: 'disconnected' }, { kind: 'state', state: 'connected' }]) for (const after of [0, 2000, 40000]) {
    const link = { phase, troubleAt, attempts, nextAt }, now = 1795000000000 + after;
    const step = reconnect.linkNext(link, input, now);
    write('callLinkNext', [link, input, now, false], { ...step, showing: reconnect.linkShowsReconnecting(step.link) });
  }
const SIGNALING = ['stable', 'have-local-offer', 'have-remote-offer', 'closed'];
for (const gen of [1, 2, 3, 100000, 0, -1, 1.5, null, '2']) for (const lastRemoteGen of [0, 1, 2]) for (const signalingState of SIGNALING) for (const polite of [false, true]) for (const fingerprintsMatch of [false, true])
  for (const pendingAgeMs of [null, 0, 7999, 8000, 8001, 60000]) {
    const input = { gen, lastRemoteGen, signalingState, polite, fingerprintsMatch, pendingAgeMs };
    write('callRemoteRestart', [input], reconnect.remoteRestart({ ...input, pendingAgeMs: pendingAgeMs ?? undefined }));
  }
for (const gen of [1, 2, 7]) for (const pendingGen of [null, 1, 2, 7]) for (const signalingState of SIGNALING) for (const fingerprintsMatch of [false, true]) {
  const input = { gen, pendingGen, signalingState, fingerprintsMatch };
  write('callRestartAnswerFits', [input], reconnect.restartAnswerFits(input));
}

// ---- what a call says about itself ----
const NETWORKS = ['online', 'waiting', 'connecting'];
for (const connection of ['connecting', 'connected', 'offline']) for (const online of [null, true, false]) write('callSignalNetwork', [connection, online], status.signalNetwork(connection, online));
for (const state of ['requesting', 'ringing', 'incoming', 'connecting', 'active', 'ended']) for (const incoming of [false, true]) for (const video of [false, true]) for (const reconnecting of [false, true]) for (const network of NETWORKS)
  for (const elapsed of [null, 0, 999, 1000, 59999, 60000, 3599000, 3600000, 7325000, -5000]) {
    const now = 1795000000000;
    const input = { status: state, incoming, video, reconnecting, startedAt: elapsed === null ? null : now - elapsed, endedText: pick(['', 'Звонок завершён', 'Нет ответа', 'Собеседник занят']), network, now };
    write('callStatus', [input], { text: status.callStatusText(input), clock: status.callBarText(input).clock, tone: status.callBarTone(state, reconnecting, network), system: status.systemCallText(state, video, reconnecting, network) });
  }
for (const network of NETWORKS) write('callRingExpiry', [network], status.ringExpiry(network));

// ---- the row in the chat ----
for (const reason of [undefined, ...REASONS]) for (const caller of [undefined, true, false]) for (const video of [undefined, true, false]) for (const duration of [undefined, 0, 42, 192, 3725, 59.9, null]) for (const mine of [false, true]) {
  const action = { type: 'call', call: uuid(), step: 'end', ...(reason ? { reason } : {}), ...(caller === undefined ? {} : { caller }), ...(video === undefined ? {} : { video }), ...(duration === undefined ? {} : { duration }) };
  const me = 'user-a', sender = mine ? me : 'user-b';
  write('callServiceText', [action, sender, me], log.callServiceText(action, sender, me));
}

// ---- did every branch of the reference run? ----
const { result } = await session.post('Profiler.takePreciseCoverage');
// The functions the core ports, as [file, from, to] marks in the source (to: null — the end of the file).
const PORTED = [
  ['calls/callModel.ts', 'export function gatherDone', '/** Telegram\'s call duration'], ['calls/callModel.ts', 'export function economySdp', '// ---- The `end` a call leaves behind'],
  ['calls/callModel.ts', 'export const callDurationSeconds', '/**\n * How an incoming call announces itself'], ['calls/callModel.ts', 'export function gradeLink', null],
  ['calls/reconnect.ts', 'export const restartDelay', '/** Voice rooms: which side'], ['calls/reconnect.ts', 'export function sameFingerprints', '/** A key for «the network changed»'],
  ['calls/callStatus.ts', 'export function signalNetwork', '/** Height of the minimised call bar'], ['calls/callStatus.ts', 'export function ringExpiry', null],
  ['calls/callLog.ts', 'export function senderPlacedCall', '/**\n * The chat-list line for a chat whose last message'], ['scheduled/model.ts', 'export function pushKind', '/** The meta a message goes out with'],
];
let unreached = 0, blocks = 0;
for (const [name, from, to] of PORTED) {
  const source = readFileSync(file(name), 'utf8');
  const start = source.indexOf(from), end = to === null ? source.length : source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`${name} changed: ${from}`);
  const script = result.find(entry => entry.url === pathToFileURL(file(name)).href);
  if (!script) throw new Error(`no coverage for ${name}`);
  for (const fn of script.functions) for (const range of fn.ranges) {
    if (range.startOffset < start || range.endOffset > end) continue;
    blocks++;
    if (range.count > 0) continue;
    unreached++;
    console.log(`NEVER RAN  ${name}:${source.slice(0, range.startOffset).split('\n').length}  ${JSON.stringify(source.slice(range.startOffset, Math.min(range.endOffset, range.startOffset + 110)))}`);
  }
}
await session.post('Profiler.stopPreciseCoverage');
session.disconnect();

for (const name of Object.keys(count).sort()) console.log(String(count[name]).padStart(7), name);
console.log(`reference coverage: ${blocks - unreached} of ${blocks} blocks (functions and branches) of the ported code ran`);
if (unreached) { console.error('not every branch of the reference was reached — vectors not written'); process.exit(1); }
writeFileSync(join(here, 'vectors', 'calls.json'), lines.join('\n') + '\n');
console.log('calls.json', lines.length, 'cases,', Math.round(lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) / 1024), 'KiB');
