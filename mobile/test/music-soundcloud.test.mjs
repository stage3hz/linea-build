import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const sc = loadTs(new URL('../src/music/soundcloud.ts', import.meta.url));

test('without a session SoundCloud is unavailable and calls explain why', async () => {
  sc.setSoundCloudApi(null);
  assert.equal(await sc.soundCloudAvailable(), false);
  await assert.rejects(sc.searchSoundCloud({ query: 'x' }), /после входа/);
});

test('search goes to our server, keeps only clean SoundCloud tracks, streams are https only', async () => {
  const paths = [];
  sc.setSoundCloudApi({ request: async path => {
    paths.push(path);
    if (path === '/music/soundcloud/status') return { available: true };
    if (path.startsWith('/music/soundcloud/tracks?')) return { tracks: [
      { source: 'soundcloud', sourceId: 'soundcloud:tracks:1', title: 'A', artist: 'B', duration: 10, artworkUrl: 'http://insecure/x.jpg', sourceUrl: 'https://soundcloud.com/b/a' },
      { source: 'audius', sourceId: 'x', title: 'mixed in', artist: 'no' },
      { source: 'soundcloud', sourceId: '../../me', title: 'bad', artist: 'bad' },
    ], nextOffset: 24 };
    if (path.endsWith('/stream')) return { uri: 'https://cf-hls-media.sndcdn.com/a.m3u8' };
    throw new Error(path);
  } });
  assert.equal(await sc.soundCloudAvailable(), true);
  const page = await sc.searchSoundCloud({ query: ' lofi ', mood: 'Peaceful' });
  assert.equal(paths[1], '/music/soundcloud/tracks?offset=0&limit=24&q=lofi&mood=Peaceful');
  assert.deepEqual(page.tracks.map(t => t.id), ['sc:soundcloud:tracks:1']);
  assert.equal(page.tracks[0].artworkUrl, null, 'http artwork dropped');
  assert.equal(page.tracks[0].downloadable, false);
  assert.equal(page.nextOffset, 24);
  assert.equal((await sc.resolveSoundCloudStream(page.tracks[0])).uri, 'https://cf-hls-media.sndcdn.com/a.m3u8');
  assert.equal(paths.at(-1), '/music/soundcloud/tracks/soundcloud%3Atracks%3A1/stream');
  sc.setSoundCloudApi(null);
});
