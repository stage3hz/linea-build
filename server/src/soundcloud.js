import { readFileSync } from 'node:fs';

/**
 * SoundCloud through this server (official API, client credentials of the owner's Artist Pro app).
 * The secret never reaches the app. Rules we follow (developers.soundcloud.com/policies):
 * only `access=playable` tracks, no Go-only content, no downloads or offline, uploader and SoundCloud
 * credited with a link back, no SoundCloud content mixed with other services in one queue (the app
 * keeps separate queues), nothing sold through Platina. Playback requests are capped per day
 * (SoundCloud's default is 1500 stream requests per 24h per app).
 */

const API = 'https://api.soundcloud.com';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const URN = /^soundcloud:tracks:\d{1,20}$/;
const DAY = 24 * 60 * 60 * 1000;
// After a failed token request nobody asks SoundCloud for another one this long: a burst of searches
// against a broken or exhausted token endpoint must not turn into a burst of /oauth/token calls.
export const TOKEN_RETRY_MS = 15_000;

export function loadSoundCloudCredentials(path) {
  if (!path) return null;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value.client_id !== 'string' || typeof value.client_secret !== 'string' || !value.client_id || !value.client_secret) {
    throw new Error('SOUNDCLOUD_CREDENTIALS: нужен JSON с client_id и client_secret.');
  }
  return { clientId: value.client_id, clientSecret: value.client_secret };
}

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const https = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } };

/** SoundCloud track → the app's MusicTrack shape (no audio address: that is asked for at play time). */
export function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.urn !== 'string' || !URN.test(raw.urn)) return null;
  if (raw.access !== 'playable' || raw.streamable === false) return null;
  const artwork = https(raw.artwork_url) || https(raw.user?.avatar_url);
  return {
    id: `sc:${raw.urn}`,
    source: 'soundcloud',
    sourceId: raw.urn,
    title: text(raw.title, 200) || 'Без названия',
    artist: text(raw.metadata_artist, 120) || text(raw.user?.username, 120) || 'SoundCloud',
    // «-large» is 100×100; «-t500x500» is the documented bigger rendition of the same image.
    artworkUrl: artwork ? artwork.replace('-large.', '-t500x500.') : null,
    duration: Math.max(0, Math.round((Number(raw.duration) || 0) / 1000)),
    genre: text(raw.genre, 60) || undefined,
    sourceUrl: https(raw.permalink_url) || undefined,
    downloadable: false,
  };
}

// The app's moods → SoundCloud genres (tracks are tagged by genre, not by mood).
export const SC_MOOD_GENRES = {
  Peaceful: 'ambient,chill,piano,classical',
  Energizing: 'electronic,dance & edm,drum & bass,house',
  Cool: 'lo-fi,hip-hop & rap,deep house',
  Upbeat: 'pop,dance & edm,disco',
  Romantic: 'r&b & soul,soul,pop',
  Melancholy: 'indie,alternative rock,piano',
};

export function createSoundCloud(credentials, { fetch: fetchImpl = globalThis.fetch, now = Date.now, dailyLimit = 1500 } = {}) {
  if (!credentials) return null;
  let token = null;
  let day = { start: now(), plays: 0 };
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

  // Tokens live about an hour and SoundCloud allows only 50 per 12h per app: reuse, refresh early, and
  // let every request that arrives while a token is being fetched wait for that one fetch (`pending`)
  // instead of making its own — sixty searches at start-up are one /oauth/token call, not sixty.
  let pending = null;
  let failedAt = 0;
  // Errors keep what SoundCloud answered (`status`) or what broke (`cause`) for the log; the app sees only the message and 502.
  const unavailable = extra => Object.assign(new Error('SoundCloud сейчас недоступен.'), { statusCode: 502, ...extra });
  const authFailed = response => unavailable(response ? { status: response.status } : {});
  const requestToken = async () => {
    if (failedAt && now() - failedAt < TOKEN_RETRY_MS) throw authFailed();
    const post = body => fetchImpl(TOKEN_URL, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body) });
    try {
      // An expired or rejected token is renewed through its refresh token first (does not count
      // against the client_credentials quota); only when that fails is a fresh token requested.
      let response = await post(token?.refresh ? { grant_type: 'refresh_token', refresh_token: token.refresh } : { grant_type: 'client_credentials' });
      if (!response.ok && token?.refresh) response = await post({ grant_type: 'client_credentials' });
      if (!response.ok) throw authFailed(response);
      const result = await response.json();
      if (typeof result?.access_token !== 'string' || !result.access_token) throw authFailed(response);
      token = { value: result.access_token, refresh: typeof result.refresh_token === 'string' && result.refresh_token ? result.refresh_token : null, issuedAt: now(), expires: now() + (Number(result.expires_in) || 3600) * 1000 };
      failedAt = 0;
      return token.value;
    } catch (error) {
      failedAt = now();
      throw error.statusCode ? error : unavailable({ cause: error });
    }
  };
  const accessToken = () => {
    if (token && token.expires > now() + 60_000) return Promise.resolve(token.value);
    if (!pending) pending = requestToken().finally(() => { pending = null; });
    return pending;
  };

  const get = async (path, retry = true) => {
    const used = await accessToken();
    const response = await fetchImpl(`${API}${path}`, { headers: { authorization: `OAuth ${used}`, accept: 'application/json; charset=utf-8' } });
    if (response.status === 401 && retry) {
      // Only the token that was just rejected is retired (a neighbour may already hold a newer one);
      // the retry then shares the single renewal with everyone else who got the same 401. A token
      // SoundCloud rejects right after issuing it is not retired: renewing it would only burn the
      // 50-per-12h token quota on an account that is broken anyway, so the request fails instead.
      if (token && token.value === used) {
        if (now() - token.issuedAt < TOKEN_RETRY_MS) throw unavailable({ status: 401 });
        token = { ...token, expires: 0 };
      }
      return get(path, false);
    }
    if (response.status === 404) throw Object.assign(new Error('Трек больше недоступен в SoundCloud.'), { statusCode: 404 });
    if (response.status === 429) throw Object.assign(new Error('SoundCloud временно ограничил запросы. Попробуй позже.'), { statusCode: 429 });
    if (!response.ok) throw unavailable({ status: response.status });
    return response.json();
  };

  return {
    async search({ query = '', mood = '', offset = 0, limit = 24 }) {
      const params = new URLSearchParams({ access: 'playable', limit: String(limit), offset: String(offset), linked_partitioning: 'true' });
      if (query) params.set('q', query);
      if (SC_MOOD_GENRES[mood]) params.set('genres', SC_MOOD_GENRES[mood]);
      if (!query && !SC_MOOD_GENRES[mood]) params.set('q', 'new');
      const result = await get(`/tracks?${params}`);
      const list = Array.isArray(result) ? result : Array.isArray(result?.collection) ? result.collection : [];
      const tracks = list.map(normalizeTrack).filter(Boolean);
      const hasMore = !Array.isArray(result) && typeof result?.next_href === 'string' && list.length >= limit;
      return { tracks, nextOffset: hasMore ? offset + limit : null };
    },
    async track(urn) {
      if (!URN.test(urn)) throw Object.assign(new Error('Некорректный трек.'), { statusCode: 400 });
      const track = normalizeTrack(await get(`/tracks/${encodeURIComponent(urn)}`));
      if (!track) throw Object.assign(new Error('Этот трек нельзя слушать вне SoundCloud.'), { statusCode: 403 });
      return track;
    },
    /** An address to play now (HLS). Counts against the daily cap. */
    async stream(urn) {
      if (!URN.test(urn)) throw Object.assign(new Error('Некорректный трек.'), { statusCode: 400 });
      if (now() - day.start >= DAY) day = { start: now(), plays: 0 };
      if (day.plays >= dailyLimit) throw Object.assign(new Error('Дневной лимит SoundCloud исчерпан. Пока можно слушать Audius.'), { statusCode: 429 });
      const streams = await get(`/tracks/${encodeURIComponent(urn)}/streams`);
      const url = https(streams?.hls_aac_160_url) || https(streams?.hls_mp3_128_url);
      if (!url) throw Object.assign(new Error('SoundCloud не дал адрес для воспроизведения.'), { statusCode: 403 });
      day.plays++;
      return { uri: url, mimeType: 'application/x-mpegURL' };
    },
    usage: () => ({ plays: day.plays, limit: dailyLimit }),
  };
}

export function installSoundCloudRoutes({ app, authOptions, soundcloud, limiter }) {
  const limit = (request, key, max) => { if (limiter && !limiter.allow(`${key}:${request.auth.user_id}`, max, 60 * 60_000)) throw Object.assign(new Error('Слишком много запросов музыки. Подожди немного.'), { statusCode: 429 }); };
  app.get('/music/soundcloud/status', authOptions, async () => ({ available: !!soundcloud }));
  if (!soundcloud) return;
  const send = (reply, error) => reply.code(error.statusCode || 502).send({ error: error.statusCode ? error.message : 'SoundCloud сейчас недоступен.' });
  const int = (value, fallback, min, max) => { const n = Number(value); return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback; };
  app.get('/music/soundcloud/tracks', authOptions, async (request, reply) => {
    const q = request.query || {};
    try {
      limit(request, 'sc-search', 600);
      return await soundcloud.search({ query: text(q.q, 160).trim(), mood: text(q.mood, 40), offset: int(q.offset, 0, 0, 2000), limit: int(q.limit, 24, 1, 40) });
    } catch (error) { return send(reply, error); }
  });
  app.get('/music/soundcloud/tracks/:urn', authOptions, async (request, reply) => {
    try { return { track: await soundcloud.track(String(request.params.urn)) }; } catch (error) { return send(reply, error); }
  });
  app.get('/music/soundcloud/tracks/:urn/stream', authOptions, async (request, reply) => {
    try { limit(request, 'sc-stream', 200); return await soundcloud.stream(String(request.params.urn)); } catch (error) { return send(reply, error); }
  });
}
