import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
const { economySdp } = loadTs(new URL('../src/calls/callModel.ts', import.meta.url));
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
