import type { MusicMedia, MusicSearchResult, MusicTrack } from './types';

/**
 * SoundCloud goes through our server (it holds the Artist Pro app keys and works where
 * soundcloud.com is blocked). Needs a signed-in session, so without one only Audius is offered.
 * Policy we keep here: no downloads or offline copies, attribution with a link back, and its
 * tracks never share a queue with another service (see MusicProvider.play).
 */
type Request = <T>(path: string) => Promise<T>;
let request: Request | null = null;
let available: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export function setSoundCloudApi(api: { request: <T>(path: string, options?: RequestInit) => Promise<T> } | null) {
  request = api ? <T,>(path: string) => api.request<T>(path) : null;
  available = null;
  listeners.forEach(listener => listener());
}
export const onSoundCloudChange = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Whether the server has SoundCloud set up (cached per session). */
export function soundCloudAvailable(): Promise<boolean> {
  if (!request) return Promise.resolve(false);
  available ??= request<{ available: boolean }>('/music/soundcloud/status').then(result => result.available === true).catch(() => { available = null; return false; });
  return available;
}

const URN = /^soundcloud:tracks:\d{1,20}$/;
function need(): Request {
  if (!request) throw new Error('SoundCloud доступен после входа в аккаунт.');
  return request;
}
function clean(value: unknown): MusicTrack | null {
  const x = value as Partial<MusicTrack> | null;
  if (!x || x.source !== 'soundcloud' || typeof x.sourceId !== 'string' || !URN.test(x.sourceId) || typeof x.title !== 'string' || typeof x.artist !== 'string') return null;
  const https = (input: unknown) => { try { return typeof input === 'string' && new URL(input).protocol === 'https:' ? input : undefined; } catch { return undefined; } };
  return {
    id: `sc:${x.sourceId}`, source: 'soundcloud', sourceId: x.sourceId, title: x.title.slice(0, 200), artist: x.artist.slice(0, 120),
    artworkUrl: https(x.artworkUrl) || null, duration: Math.max(0, Number(x.duration) || 0), genre: typeof x.genre === 'string' ? x.genre.slice(0, 60) : undefined,
    sourceUrl: https(x.sourceUrl), downloadable: false,
  };
}

export async function searchSoundCloud({ query = '', mood = '', offset = 0, limit = 24 }: { query?: string; mood?: string; offset?: number; limit?: number }): Promise<MusicSearchResult> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (query.trim()) params.set('q', query.trim().slice(0, 160));
  if (mood) params.set('mood', mood);
  const result = await need()<{ tracks: unknown[]; nextOffset: number | null }>(`/music/soundcloud/tracks?${params}`);
  return { tracks: (Array.isArray(result.tracks) ? result.tracks : []).map(clean).filter((track): track is MusicTrack => !!track), nextOffset: typeof result.nextOffset === 'number' ? result.nextOffset : null };
}

export async function getSoundCloudTrack(urn: string): Promise<MusicTrack> {
  if (!URN.test(urn)) throw new Error('Некорректный трек SoundCloud.');
  const track = clean((await need()<{ track: unknown }>(`/music/soundcloud/tracks/${encodeURIComponent(urn)}`)).track);
  if (!track) throw new Error('Этот трек больше недоступен в SoundCloud.');
  return track;
}

export async function resolveSoundCloudStream(track: MusicTrack): Promise<MusicMedia> {
  if (!track.sourceId || !URN.test(track.sourceId)) throw new Error('Некорректный трек SoundCloud.');
  const result = await need()<{ uri: string; mimeType?: string }>(`/music/soundcloud/tracks/${encodeURIComponent(track.sourceId)}/stream`);
  if (typeof result.uri !== 'string' || !result.uri.startsWith('https://')) throw new Error('SoundCloud не дал адрес для воспроизведения.');
  return { uri: result.uri, mimeType: result.mimeType || 'application/x-mpegURL' };
}

export const isSoundCloudUrn = (value: unknown): value is string => typeof value === 'string' && URN.test(value);
