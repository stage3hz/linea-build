import assert from 'node:assert/strict';
import test from 'node:test';
import { createSoundCloud, normalizeTrack } from '../src/soundcloud.js';

const playable = (id, extra = {}) => ({ urn: `soundcloud:tracks:${id}`, title: `Track ${id}`, access: 'playable', streamable: true, duration: 183400, permalink_url: `https://soundcloud.com/a/t${id}`, artwork_url: `https://i1.sndcdn.com/artworks-${id}-large.jpg`, user: { username: 'artist' }, ...extra });

function fakeSoundCloud(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('https://secure.soundcloud.com/oauth/token')) {
      assert.match(options.headers.authorization, /^Basic /);
      return new Response(JSON.stringify({ access_token: `tok${calls.length}`, refresh_token: 'r', expires_in: 3600 }), { status: 200 });
    }
    const path = String(url).replace('https://api.soundcloud.com', '');
    for (const [prefix, handler] of routes) if (path.startsWith(prefix)) return handler(path, options);
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls };
}

test('normalizeTrack keeps only playable tracks and never exposes an audio address', () => {
  const track = normalizeTrack(playable(7));
  assert.equal(track.id, 'sc:soundcloud:tracks:7');
  assert.equal(track.source, 'soundcloud');
  assert.equal(track.duration, 183);
  assert.equal(track.downloadable, false);
  assert.equal(track.artworkUrl, 'https://i1.sndcdn.com/artworks-7-t500x500.jpg');
  assert.equal(track.sourceUrl, 'https://soundcloud.com/a/t7');
  assert.equal('stream_url' in track, false);
  assert.equal(normalizeTrack(playable(8, { access: 'preview' })), null, 'Go+ previews are left out');
  assert.equal(normalizeTrack(playable(9, { access: 'blocked' })), null);
  assert.equal(normalizeTrack({ ...playable(10), urn: 'soundcloud:users:1' }), null);
});

test('search: only playable, token reused, genres for moods', async () => {
  const { fetch, calls } = fakeSoundCloud([['/tracks?', path => {
    const params = new URL(`https://x${path}`).searchParams;
    assert.equal(params.get('access'), 'playable');
    return new Response(JSON.stringify({ collection: [playable(1), playable(2, { access: 'preview' })], next_href: 'https://api.soundcloud.com/tracks?page=2' }), { status: 200 });
  }]]);
  const sc = createSoundCloud({ clientId: 'id', clientSecret: 'secret' }, { fetch });
  const page = await sc.search({ query: 'lofi', limit: 1 });
  assert.deepEqual(page.tracks.map(t => t.sourceId), ['soundcloud:tracks:1']);
  assert.equal(page.nextOffset, 1);
  await sc.search({ mood: 'Peaceful' });
  assert.match(calls.at(-1).url, /genres=ambient/);
  assert.equal(calls.filter(c => c.url.includes('oauth/token')).length, 1, 'one token for both searches');
  assert.equal(calls.at(-1).options.headers.authorization, 'OAuth tok1');
});

test('stream: HLS address, daily cap enforced, bad URN rejected', async () => {
  const { fetch } = fakeSoundCloud([['/tracks/soundcloud%3Atracks%3A5/streams', () => new Response(JSON.stringify({ hls_aac_160_url: 'https://cf-hls-media.sndcdn.com/playlist/5.m3u8', preview_mp3_128_url: 'https://x/p.mp3' }), { status: 200 })]]);
  let clock = 1_000_000;
  const sc = createSoundCloud({ clientId: 'id', clientSecret: 'secret' }, { fetch, now: () => clock, dailyLimit: 2 });
  assert.equal((await sc.stream('soundcloud:tracks:5')).uri, 'https://cf-hls-media.sndcdn.com/playlist/5.m3u8');
  await sc.stream('soundcloud:tracks:5');
  await assert.rejects(sc.stream('soundcloud:tracks:5'), error => error.statusCode === 429);
  clock += 24 * 60 * 60 * 1000;
  assert.ok(await sc.stream('soundcloud:tracks:5'), 'the cap resets after a day');
  await assert.rejects(sc.stream('../../me'), error => error.statusCode === 400);
});

test('expired token is renewed once on 401', async () => {
  let first = true;
  const { fetch, calls } = fakeSoundCloud([['/tracks/', () => { if (first) { first = false; return new Response('{}', { status: 401 }); } return new Response(JSON.stringify(playable(3)), { status: 200 }); }]]);
  const sc = createSoundCloud({ clientId: 'id', clientSecret: 'secret' }, { fetch });
  assert.equal((await sc.track('soundcloud:tracks:3')).title, 'Track 3');
  assert.equal(calls.filter(c => c.url.includes('oauth/token')).length, 2);
});

test('not configured → null (routes only report unavailable)', () => {
  assert.equal(createSoundCloud(null), null);
});
