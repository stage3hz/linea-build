import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
const { economySdp, gradeLink, steadyGrade, audioCap, VIDEO_CAP } = loadTs(new URL('../src/calls/callModel.ts', import.meta.url));
const SDP = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 63', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtpmap:63 red/48000/2', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', ''].join('\r\n');

test('fast links keep the SDP untouched', () => assert.equal(economySdp(SDP, 'fast'), SDP));

test('EDGE: 12 kbit/s narrowband opus, DTX, 60 ms packets, only in the audio section', () => {
  const out = economySdp(SDP, 'slow');
  assert.match(out, /a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=12000;maxplaybackrate=16000;stereo=0;usedtx=1/);
  const audio = out.split('m=video')[0];
  assert.match(audio, /a=ptime:60/);
  assert.doesNotMatch(out.split('m=video')[1], /ptime/);
  assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out), 'line endings kept');
  assert.equal(economySdp(out, 'slow'), out, 'applying twice changes nothing');
});

test('3G: 24 kbit/s, no DTX; opus without fmtp gets one', () => {
  assert.match(economySdp(SDP, 'medium'), /maxaveragebitrate=24000/);
  assert.doesNotMatch(economySdp(SDP, 'medium'), /usedtx|a=ptime/);
  const bare = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
  assert.match(economySdp(bare, 'slow'), /a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 maxaveragebitrate=12000/);
  assert.equal(economySdp('v=0\r\nm=audio 9 RTP 0\r\n', 'slow'), 'v=0\r\nm=audio 9 RTP 0\r\n', 'no opus: untouched');
});

test('a reading of the link is graded by loss, delay and jitter; unknown numbers are not a bad link', () => {
  assert.equal(gradeLink({ rttMs: null, lossPct: null, jitterMs: null }), 'good');
  assert.equal(gradeLink({ rttMs: 120, lossPct: 0.5, jitterMs: 12 }), 'good');
  assert.equal(gradeLink({ rttMs: 120, lossPct: 3, jitterMs: 12 }), 'weak');
  assert.equal(gradeLink({ rttMs: 400, lossPct: 0, jitterMs: 12 }), 'weak');
  assert.equal(gradeLink({ rttMs: 120, lossPct: 12, jitterMs: 12 }), 'bad');
  assert.equal(gradeLink({ rttMs: 120, lossPct: 0, jitterMs: 150 }), 'bad');
});

test('the grade worsens at once and recovers one step after three calm readings', () => {
  assert.deepEqual(steadyGrade('good', 'bad', 0), { grade: 'bad', calm: 0 });
  let state = { grade: 'bad', calm: 0 };
  state = steadyGrade(state.grade, 'good', state.calm); assert.deepEqual(state, { grade: 'bad', calm: 1 });
  state = steadyGrade(state.grade, 'good', state.calm); assert.deepEqual(state, { grade: 'bad', calm: 2 });
  state = steadyGrade(state.grade, 'good', state.calm); assert.deepEqual(state, { grade: 'weak', calm: 0 }, 'one step, not straight to good');
  state = steadyGrade(state.grade, 'weak', 2); assert.deepEqual(state, { grade: 'weak', calm: 0 }, 'a reading of the same grade starts the count again');
  assert.deepEqual(steadyGrade('weak', 'bad', 2), { grade: 'bad', calm: 0 });
});

test('the voice cap is the tighter of the network speed and the live link; the picture gives way first', () => {
  assert.equal(audioCap('fast', 'good'), null);
  assert.equal(audioCap('fast', 'weak'), 24000);
  assert.equal(audioCap('fast', 'bad'), 12000);
  assert.equal(audioCap('slow', 'good'), 12000);
  assert.equal(audioCap('medium', 'bad'), 12000);
  assert.ok(VIDEO_CAP.good > VIDEO_CAP.weak && VIDEO_CAP.weak > VIDEO_CAP.bad);
});
