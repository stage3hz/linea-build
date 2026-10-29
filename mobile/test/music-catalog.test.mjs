import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canDownloadAudius,
  canStreamAudius,
  normalizeAudiusPage,
  normalizeAudiusTrack,
  safeHttpsUrl,
} from '../src/music/catalog.ts';

// Provider-shaped fixtures exercise access decisions, not a copy of the guard
// implementation. No request is made to Audius or to any URL below.
const publicTrack = {
  id: 'D7KyD',
  title: 'Public track',
  duration: 213,
  permalink: '/artist/public-track',
  user: { name: 'Artist', handle: 'artist' },
  artwork: { '480x480': 'https://creator-node.audius.co/artwork/cover.jpg' },
  is_available: true,
  is_streamable: true,
  is_stream_gated: false,
  is_downloadable: true,
  is_download_gated: false,
  is_delete: false,
  is_unlisted: false,
  access: { stream: true, download: true },
  allowed_api_keys: null,
  access_authorities: [],
  stream_conditions: null,
  download_conditions: null,
  stream: { url: 'https://api.audius.co/v1/tracks/D7KyD/stream' },
  download: { url: 'https://api.audius.co/v1/tracks/D7KyD/download' },
};

function track(overrides = {}) {
  return { ...structuredClone(publicTrack), ...overrides };
}

test('explicit public access produces a playable track; streaming does not grant downloading', () => {
  const raw = track();
  assert.equal(canStreamAudius(raw), true);
  assert.equal(canDownloadAudius(raw), true);
  const normalized = normalizeAudiusTrack(raw);
  assert.ok(normalized);
  assert.equal(normalized.source, 'audius');
  assert.equal(normalized.title, raw.title);
  assert.equal(normalized.artist, raw.user.name);
  assert.equal(normalized.downloadable, true);

  const streamingOnly = track({
    is_downloadable: false,
    access: { stream: true, download: false },
  });
  assert.equal(canStreamAudius(streamingOnly), true);
  assert.equal(canDownloadAudius(streamingOnly), false);
  assert.equal(normalizeAudiusTrack(streamingOnly)?.downloadable, false);
});

test('gated, premium, unavailable, unlisted and API-restricted tracks never become playable', () => {
  const denied = [
    ['unavailable', { is_available: false }],
    ['not streamable', { is_streamable: false }],
    ['stream gate', { is_stream_gated: true }],
    ['access denied', { access: { stream: false, download: true } }],
    ['deleted', { is_delete: true }],
    ['unlisted', { is_unlisted: true }],
    ['premium condition', { stream_conditions: { usdc_purchase: { price: 100 } } }],
    ['unknown condition', { stream_conditions: { future_access_rule: true } }],
    ['API disabled by empty allowlist', { allowed_api_keys: [] }],
    ['API key restriction', { allowed_api_keys: ['another-app'] }],
    ['access authority', { access_authorities: ['0x123456'] }],
  ];
  for (const [reason, overrides] of denied) {
    const raw = track(overrides);
    assert.equal(canStreamAudius(raw), false, reason);
    assert.equal(canDownloadAudius(raw), false, reason);
    assert.equal(normalizeAudiusTrack(raw), null, reason);
  }
});

test('missing or ambiguous permission values fail closed without throwing', () => {
  for (const raw of [null, undefined, false, 1, 'track', [], {}]) {
    assert.equal(canStreamAudius(raw), false);
    assert.equal(canDownloadAudius(raw), false);
    assert.equal(normalizeAudiusTrack(raw), null);
  }
  for (const field of ['is_available', 'is_streamable', 'is_stream_gated', 'is_delete', 'is_unlisted']) {
    for (const ambiguous of [undefined, null, 'true', 'false', 0, 1]) {
      const raw = track({ [field]: ambiguous });
      assert.equal(canStreamAudius(raw), false, `${field}=${String(ambiguous)}`);
      assert.equal(normalizeAudiusTrack(raw), null, `${field}=${String(ambiguous)}`);
    }
  }
  for (const access of [undefined, null, {}, { stream: 'true' }, { stream: 1 }]) {
    assert.equal(canStreamAudius(track({ access })), false, JSON.stringify(access));
  }
});

test('download permission requires explicit provider grants and an ungated public URL', () => {
  const denied = [
    ['no download flag', { is_downloadable: undefined }],
    ['download denied', { is_downloadable: false }],
    ['ambiguous download flag', { is_downloadable: 'true' }],
    ['download access denied', { access: { stream: true, download: false } }],
    ['download access unknown', { access: { stream: true } }],
    ['download access ambiguous', { access: { stream: true, download: 'true' } }],
    ['download gate', { is_download_gated: true }],
    ['download gate unknown', { is_download_gated: undefined }],
    ['purchase condition', { download_conditions: { usdc_purchase: { price: 100 } } }],
    ['unknown condition', { download_conditions: { future_rule: true } }],
    ['missing URL', { download: {} }],
    ['unsafe URL', { download: { url: 'http://api.audius.co/v1/tracks/D7KyD/download' } }],
  ];
  for (const [reason, overrides] of denied) {
    const raw = track(overrides);
    assert.equal(canStreamAudius(raw), true, reason);
    assert.equal(canDownloadAudius(raw), false, reason);
    assert.equal(normalizeAudiusTrack(raw)?.downloadable, false, reason);
  }
});

test('legacy download metadata cannot override an explicit modern denial or ambiguous value', () => {
  const legacy = track({ downloadable: true });
  delete legacy.is_downloadable;
  assert.equal(canDownloadAudius(legacy), true);
  assert.equal(canDownloadAudius(track({ is_downloadable: false, downloadable: true })), false);
  assert.equal(canDownloadAudius(track({ is_downloadable: null, downloadable: true })), false);
  assert.equal(canDownloadAudius(track({ is_downloadable: 'true', downloadable: true })), false);
});

test('media URLs reject insecure protocols, credentials, local hosts and disguised IP addresses', () => {
  const unsafe = [
    null, undefined, 123, '', 'not a URL', '/relative.mp3',
    'http://api.audius.co/track.mp3',
    'file:///sdcard/track.mp3',
    'data:audio/mpeg;base64,AAAA',
    'javascript:alert(1)',
    'https://user:secret@api.audius.co/track.mp3',
    'https://user@api.audius.co/track.mp3',
    'https://api.audius.co:8443/track.mp3',
    'https://localhost/track.mp3',
    'https://localhost./track.mp3',
    'https://music.local/track.mp3',
    'https://intranet/track.mp3',
    'https://127.0.0.1/track.mp3',
    'https://127.1/track.mp3',
    'https://2130706433/track.mp3',
    'https://0x7f000001/track.mp3',
    'https://0177.0.0.1/track.mp3',
    'https://10.1.2.3/track.mp3',
    'https://172.16.1.2/track.mp3',
    'https://192.168.1.2/track.mp3',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/track.mp3',
    'https://[fc00::1]/track.mp3',
    'https://[fe80::1]/track.mp3',
    'https://[::ffff:127.0.0.1]/track.mp3',
    'https://[::ffff:10.0.0.1]/track.mp3',
  ];
  for (const url of unsafe) {
    assert.equal(safeHttpsUrl(url), null, String(url));
  }
  for (const url of [
    'https://api.audius.co/v1/tracks/D7KyD/stream',
    'https://creator-node.audius.co/audio/track.mp3?token=public',
  ]) {
    assert.equal(safeHttpsUrl(url), url);
  }
});

test('unsafe provider stream URLs cannot reach a normalized playable track', () => {
  for (const url of [undefined, 'http://api.audius.co/stream', 'https://127.0.0.1/stream', 'https://user@api.audius.co/stream']) {
    const raw = track({ stream: { url } });
    assert.equal(canStreamAudius(raw), false, String(url));
    assert.equal(normalizeAudiusTrack(raw), null, String(url));
  }
});

test('download-only search results still check each track permission independently', () => {
  const raw = [
    track({ id: 'allowed' }),
    track({ id: 'streamingOnly', is_downloadable: false }),
    track({ id: 'gated', is_stream_gated: true }),
    track({ id: 'noAccess', access: { stream: true, download: false } }),
  ];
  const all = normalizeAudiusPage(raw, { offset: 0, limit: 10 });
  assert.equal(all.tracks.length, 3);
  assert.equal(all.tracks.filter(item => item.downloadable).length, 1);
  const downloadable = normalizeAudiusPage(raw, { offset: 0, limit: 10, downloadableOnly: true });
  assert.equal(downloadable.tracks.length, 1);
  assert.equal(downloadable.tracks[0].downloadable, true);
  assert.equal(downloadable.nextOffset, null);
});

test('a full provider page containing only filtered tracks still exposes the next page', () => {
  const hidden = [
    track({ id: 'gatedOne', is_stream_gated: true }),
    track({ id: 'gatedTwo', is_available: false }),
  ];
  const emptyVisible = normalizeAudiusPage(hidden, { offset: 8, limit: 2 });
  assert.deepEqual(emptyVisible.tracks, []);
  assert.equal(emptyVisible.nextOffset, 10);
  const next = normalizeAudiusPage([track()], { offset: emptyVisible.nextOffset, limit: 2 });
  assert.equal(next.tracks.length, 1);
  assert.equal(next.nextOffset, null);

  const filteredDownloads = normalizeAudiusPage([
    track({ is_downloadable: false }), track({ id: 'second', is_downloadable: false }),
  ], { offset: 0, limit: 2, downloadableOnly: true });
  assert.deepEqual(filteredDownloads.tracks, []);
  assert.equal(filteredDownloads.nextOffset, 2);
});

test('pagination terminates on short or empty raw pages and rejects malformed envelopes', () => {
  const short = normalizeAudiusPage([track({ is_available: false })], { offset: 10, limit: 2 });
  assert.deepEqual(short, { tracks: [], nextOffset: null });
  assert.deepEqual(normalizeAudiusPage([], { offset: 10, limit: 2 }), { tracks: [], nextOffset: null });
  for (const malformed of [undefined, null, {}, { data: [] }, 'not-an-array']) {
    assert.throws(() => normalizeAudiusPage(malformed, { offset: 0, limit: 2 }));
  }
});

test('duplicate provider rows do not duplicate results or stall the raw pagination cursor', () => {
  const result = normalizeAudiusPage([track(), track()], { offset: 4, limit: 2 });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.nextOffset, 6);
});
