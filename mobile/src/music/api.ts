import type { MusicMedia, MusicMood, MusicSearch, MusicSearchResult, MusicTrack } from './types';
import {
  asObject, audiusId, canDownloadAudius, canStreamAudius, normalizeAudiusPage,
  normalizeAudiusTrack, safeAudioFilename, safeHttpsUrl,
} from './catalog';
import { mergeRanked, spellingVariants } from './fuzzy.ts';

const API_ORIGIN = 'https://api.audius.co';
const API_BASE = `${API_ORIGIN}/v1`;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESPONSE_LENGTH = 4 * 1024 * 1024;

export const MUSIC_MOODS: readonly MusicMood[] = [
  { id: 'all', label: 'Всё', icon: 'musical-notes-outline' },
  { id: 'calm', label: 'Спокойно', icon: 'water-outline', apiMood: 'Peaceful' },
  { id: 'energy', label: 'Энергия', icon: 'flash-outline', apiMood: 'Energizing' },
  { id: 'focus', label: 'Фокус', icon: 'headset-outline', apiMood: 'Cool' },
  { id: 'upbeat', label: 'Настроение', icon: 'sunny-outline', apiMood: 'Upbeat' },
  { id: 'romantic', label: 'Романтика', icon: 'heart-outline', apiMood: 'Romantic' },
  { id: 'melancholy', label: 'Меланхолия', icon: 'moon-outline', apiMood: 'Melancholy' },
];

class MusicRequestError extends Error {
  retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'MusicRequestError';
    this.retryable = retryable;
  }
}

/** No Linea session, Audius user token, persistent cache, or alternate host is used. */
async function requestJson(path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      // A read request must never silently move to an unrelated origin.
      if (response.url && new URL(response.url).origin !== API_ORIGIN) {
        throw new MusicRequestError('Сервис музыки вернул неподходящий адрес.');
      }
      if (response.status === 429) {
        throw new MusicRequestError('Audius временно ограничил запросы. Подождите немного и попробуйте снова.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new MusicRequestError('Эта музыка сейчас недоступна через Audius.');
      }
      if (response.status === 404) {
        throw new MusicRequestError('Трек больше недоступен в Audius.');
      }
      if (!response.ok) {
        throw new MusicRequestError('Сервис музыки временно недоступен. Попробуйте позже.', response.status >= 500);
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_LENGTH) {
        throw new MusicRequestError('Сервис музыки вернул слишком большой ответ.');
      }
      const body = await response.text();
      if (body.length > MAX_RESPONSE_LENGTH) throw new MusicRequestError('Сервис музыки вернул слишком большой ответ.');
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new MusicRequestError('Не удалось прочитать ответ Audius. Попробуйте позже.');
      }
    } catch (error) {
      const known = error instanceof MusicRequestError;
      const retryable = !known || error.retryable;
      if (attempt === 0 && retryable) {
        await new Promise<void>(resolve => setTimeout(resolve, 300));
        continue;
      }
      if (known) throw error;
      throw new Error(controller.signal.aborted
        ? 'Audius не ответил вовремя. Попробуйте ещё раз.'
        : 'Не удалось подключиться к Audius. Проверьте интернет.');
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('Не удалось подключиться к Audius.');
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

export async function searchMusic(search: MusicSearch = {}): Promise<MusicSearchResult> {
  const query = typeof search.query === 'string' ? search.query.trim().slice(0, 160) : '';
  const mood: MusicMood | undefined = MUSIC_MOODS.find(item => item.id === search.mood)
    ?? MUSIC_MOODS.find(item => 'apiMood' in item && item.apiMood === search.mood);
  const offset = integer(search.offset, 0, 0, 100000);
  const limit = integer(search.limit, 24, 1, 40);
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  const filtered = !!query || !!mood?.apiMood || search.downloadableOnly === true;
  let path: string;
  if (filtered) {
    if (query) params.set('query', query);
    if (mood?.apiMood) params.set('mood', mood.apiMood);
    params.set('sort_method', query ? 'relevant' : 'popular');
    // This exact mixed-case parameter comes from the official REST schema.
    params.set('includePurchaseable', 'false');
    if (search.downloadableOnly) {
      params.set('only_downloadable', 'true');
      params.set('has_downloads', 'true');
    }
    path = '/tracks/search';
  } else {
    params.set('time', 'week');
    path = '/tracks/trending';
  }
  const response = asObject(await requestJson(`${path}?${params}`));
  const page = normalizeAudiusPage(response?.data, { offset, limit, downloadableOnly: search.downloadableOnly });
  // Typos: Audius matches only the exact spelling, so a thin first page also tries likely spellings.
  if (!query || offset > 0 || page.tracks.length >= 6) return page;
  const variants = spellingVariants(query, 8);
  const extra = await Promise.all(variants.map(async variant => {
    const alt = new URLSearchParams(params); alt.set('query', variant); alt.set('limit', '10');
    try { return normalizeAudiusPage(asObject(await requestJson(`/tracks/search?${alt}`))?.data, { offset: 0, limit: 10, downloadableOnly: search.downloadableOnly }).tracks; }
    catch { return []; }
  }));
  const tracks = mergeRanked(query, [page.tracks, ...extra]).slice(0, 40);
  return { tracks, nextOffset: page.nextOffset };
}

async function freshTrack(sourceId: unknown): Promise<Record<string, unknown>> {
  const id = audiusId(sourceId);
  if (!id) throw new Error('Не удалось определить трек Audius.');
  const response = asObject(await requestJson(`/tracks/${encodeURIComponent(id)}`));
  const raw = asObject(response?.data);
  if (!raw || raw.id !== id) throw new Error('Audius вернул неверные данные трека.');
  return raw;
}

/** Restore an Audius favourite from its ID without retaining provider metadata on disk. */
export async function getMusicTrack(sourceId: string): Promise<MusicTrack> {
  const track = normalizeAudiusTrack(await freshTrack(sourceId));
  if (!track) throw new Error('Этот трек сейчас недоступен для свободного прослушивания.');
  return track;
}

function remoteId(track: MusicTrack): string {
  const id = track.source === 'audius' ? audiusId(track.sourceId) : null;
  if (!id) throw new Error('Этот источник музыки не поддерживается.');
  return id;
}

export async function resolveStream(track: MusicTrack): Promise<MusicMedia> {
  const id = remoteId(track);
  const raw = await freshTrack(id);
  if (!canStreamAudius(raw)) throw new Error('Автор ограничил доступ к треку, или он больше недоступен.');
  // Ask the normal official streaming endpoint after fresh permission validation.
  // The returned CDN address is provider-supplied, never taken from caller metadata.
  const response = asObject(await requestJson(`/tracks/${id}/stream?no_redirect=true`));
  const uri = safeHttpsUrl(response?.data);
  if (!uri) throw new Error('Audius не предоставил доступный адрес воспроизведения.');
  return { uri, mimeType: 'audio/mpeg' };
}

/** Open externally. API audio must not be retained in this app's offline library. */
export async function resolveDownload(track: MusicTrack): Promise<MusicMedia> {
  const id = remoteId(track);
  const raw = await freshTrack(id);
  if (!canDownloadAudius(raw)) {
    throw new Error('Автор не разрешил публичное скачивание этого трека. Его можно открыть в Audius.');
  }
  // The official endpoint rechecks access when the browser requests the file.
  // We neither rip the stream nor manufacture a link from a raw content CID.
  return { uri: `${API_BASE}/tracks/${id}/download`, ...safeAudioFilename(raw.orig_filename) };
}
