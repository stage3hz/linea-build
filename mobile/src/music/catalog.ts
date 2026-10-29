import type { MusicSearchResult, MusicTrack } from './types';

type JsonObject = Record<string, unknown>;

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'alac']);
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff',
  aiff: 'audio/aiff', alac: 'audio/mp4',
};

export function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

export function audiusId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value) ? value : null;
}

/** Validates transport only; media must additionally come from a fresh official API response. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return null;
    // URL canonicalization also catches hexadecimal/decimal/short IPv4 spellings.
    if (!host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host) || host.endsWith('.')) return null;
    if (/(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|invalid|test|onion)$/.test(host)) return null;
    if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function emptyObject(value: unknown): boolean {
  return value == null || (asObject(value) !== null && Object.keys(value as JsonObject).length === 0);
}

function publicAuthorities(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

export function audiusMediaUrl(value: unknown, kind: 'stream' | 'download'): string | null {
  const track = asObject(value);
  return safeHttpsUrl(asObject(track?.[kind])?.url);
}

/** The search flags are hints, never permission. Unknown access flags fail closed. */
export function canStreamAudius(value: unknown): boolean {
  const track = asObject(value);
  const access = asObject(track?.access);
  return !!track
    && audiusId(track.id) !== null
    && track.is_available === true
    && track.is_streamable === true
    && track.is_delete === false
    && track.is_unlisted === false
    && track.is_stream_gated === false
    && access?.stream === true
    // A present allowlist, including [], is not permission for our anonymous app.
    && track.allowed_api_keys == null
    && publicAuthorities(track.access_authorities)
    && emptyObject(track.stream_conditions)
    && audiusMediaUrl(track, 'stream') !== null;
}

/** Artist-enabled public download capability; this is not an offline-storage licence. */
export function canDownloadAudius(value: unknown): boolean {
  const track = asObject(value);
  const access = asObject(track?.access);
  const downloadable = track && ('is_downloadable' in track ? track.is_downloadable : track.downloadable);
  return canStreamAudius(track)
    && downloadable === true
    && track?.is_download_gated === false
    && access?.download === true
    && emptyObject(track?.download_conditions)
    && audiusMediaUrl(track, 'download') !== null;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || undefined;
}

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.startsWith('//')) return undefined;
  try {
    const url = new URL(value, 'https://audius.co');
    if (url.origin !== 'https://audius.co' || url.username || url.password || url.search || url.hash) return undefined;
    if (!/^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return undefined;
    return safeHttpsUrl(url.toString()) ?? undefined;
  } catch {
    return undefined;
  }
}

export function safeAudioFilename(value: unknown): { fileName?: string; mimeType?: string } {
  if (typeof value !== 'string') return {};
  const basename = value.split(/[\\/]/).pop() ?? '';
  const extension = /\.([a-zA-Z0-9]+)$/.exec(basename)?.[1].toLowerCase();
  if (!extension || !AUDIO_EXTENSIONS.has(extension)) return {};
  const stem = basename.slice(0, -(extension.length + 1))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '').replace(/^\.+|[. ]+$/g, '').trim();
  return { fileName: `${Array.from(stem || 'Музыка').slice(0, 120).join('')}.${extension}`, mimeType: MIME_TYPES[extension] };
}

export function normalizeAudiusTrack(value: unknown): MusicTrack | null {
  if (!canStreamAudius(value)) return null;
  const raw = asObject(value)!;
  const user = asObject(raw.user);
  const id = audiusId(raw.id)!;
  const title = text(raw.title, 240);
  const artist = text(user?.name, 160) ?? text(user?.handle, 160);
  const link = sourceUrl(raw.permalink);
  // Every displayed release retains its artist credit and official source link.
  if (!title || !artist || !link) return null;
  const artwork = asObject(raw.artwork);
  const duration = typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration >= 0
    ? Math.round(raw.duration) : 0;
  return {
    id: `audius:${id}`,
    source: 'audius',
    sourceId: id,
    title,
    artist,
    artworkUrl: safeHttpsUrl(artwork?.['480x480']) ?? safeHttpsUrl(artwork?.['150x150']) ?? safeHttpsUrl(artwork?.['1000x1000']),
    duration,
    genre: text(raw.genre, 80),
    mood: text(raw.mood, 80),
    sourceUrl: link,
    downloadable: canDownloadAudius(raw),
    ...safeAudioFilename(raw.orig_filename),
  };
}

export function normalizeAudiusPage(
  rawPage: unknown,
  options: { offset: number; limit: number; downloadableOnly?: boolean },
): MusicSearchResult {
  if (!Array.isArray(rawPage)) throw new Error('Сервис музыки вернул неверный ответ. Попробуйте позже.');
  const seen = new Set<string>();
  const tracks: MusicTrack[] = [];
  for (const raw of rawPage) {
    const track = normalizeAudiusTrack(raw);
    if (!track || seen.has(track.id) || (options.downloadableOnly && !track.downloadable)) continue;
    seen.add(track.id);
    tracks.push(track);
  }
  return {
    tracks,
    // A full page of unavailable records must not prematurely end pagination.
    nextOffset: rawPage.length >= options.limit ? options.offset + rawPage.length : null,
  };
}
