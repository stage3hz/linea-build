// Pictures, videos and speech made by the AI live in the app's private cache folder under the
// `linea-ai-` prefix (like `linea-view-` in media/mediaCache.ts). A file belongs to the conversation
// that produced it: it is stored with the encrypted history, removed together with the conversation,
// and the whole set is capped — the oldest files of other conversations go first.
// Files are identified by name only: on iOS the cache folder's absolute path changes with every app
// update, so a name is resolved against the current folder each time it is shown, checked or deleted.
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { AI_MEDIA_PREFIX, aiMediaName, isAIMediaUri, type AITurn } from './conversation';

export { AI_MEDIA_PREFIX, aiMediaName, isAIMediaUri };
export const AI_MEDIA_LIMIT_BYTES = 150 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'video/mp4': 'mp4' };

export type AIMediaFile = { name: string; size: number; modifiedAt: number };

/** `linea-ai-<conversation>-<uuid>.<ext>`: the conversation id is kept in the name so orphans can be told apart. */
export function aiMediaFileName(conversationId: string, mimeType: string, uuid: string): string {
  return `${AI_MEDIA_PREFIX}${conversationId.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64)}-${uuid}.${EXT[mimeType] || 'bin'}`;
}

/** The cache files these turns show, by name (a stored name and a full URI of the same file are one entry). */
export const mediaUris = (turns: readonly AITurn[]): string[] => turns.flatMap(turn => turn.media && isAIMediaUri(turn.media.uri) ? [aiMediaName(turn.media.uri)] : []);

const nativeCache = () => Platform.OS !== 'web' ? FileSystem.cacheDirectory : null;
/** Where the file is right now: the stored name (or an older absolute URI) placed in the current cache folder. Anything else (data: URIs on web) is returned as is. */
export const resolveAIMediaUri = (uri: string): string => { const dir = nativeCache(); return dir && isAIMediaUri(uri) ? `${dir}${aiMediaName(uri)}` : uri; };

// Files a mounted AI screen is showing right now. The quick dialog has no history, so the main screen's
// prune would otherwise take its files for orphans (and the main screen's own files, once they are no
// longer stored, would go from under an open quick dialog). Counted, as both screens can be up at once.
const held = new Map<string, number>();
/** Registers the files on screen; the returned function releases them again (unmount). */
export function holdAIMedia(uris: Iterable<string>): () => void {
  const names = [...new Set([...uris].filter(isAIMediaUri).map(aiMediaName))];
  for (const name of names) held.set(name, (held.get(name) || 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    for (const name of names) { const count = (held.get(name) || 0) - 1; if (count > 0) held.set(name, count); else held.delete(name); }
  };
}
export const heldAIMedia = (): ReadonlySet<string> => new Set(held.keys());

/** A file younger than this is never treated as an orphan: it may belong to a turn still being completed. */
export const AI_MEDIA_GRACE_MS = 2 * 60_000;

/**
 * Which cache files to delete. Pure: files not referenced by any stored or open conversation are
 * orphans and go at once; then, while the rest is over the limit, the oldest files go — except those
 * of the conversation on screen (`protect`), which are never evicted from under the user.
 */
export function planAIMediaCleanup(files: readonly AIMediaFile[], keep: ReadonlySet<string>, protect: ReadonlySet<string>, limit = AI_MEDIA_LIMIT_BYTES, now = Date.now()): string[] {
  const remove: string[] = [];
  const kept: AIMediaFile[] = [];
  for (const file of files) {
    if (!file.name.startsWith(AI_MEDIA_PREFIX)) continue;
    if (keep.has(file.name)) kept.push(file);
    else if (now - file.modifiedAt < AI_MEDIA_GRACE_MS) continue;
    else remove.push(file.name);
  }
  let total = kept.reduce((sum, file) => sum + file.size, 0);
  for (const file of kept.sort((a, b) => a.modifiedAt - b.modifiedAt)) {
    if (total <= limit) break;
    if (protect.has(file.name)) continue;
    remove.push(file.name); total -= file.size;
  }
  return remove;
}

/** Writes AI output to the cache. PC app (web): no file cache — the result stays in memory as a data URI. */
export async function writeAIMedia(conversationId: string, base64: string, mimeType: string): Promise<string> {
  if (Platform.OS === 'web') return `data:${mimeType};base64,${base64}`;
  const dir = FileSystem.cacheDirectory; if (!dir) throw new Error('Кэш недоступен на этом устройстве.');
  const uri = `${dir}${aiMediaFileName(conversationId, mimeType, Crypto.randomUUID())}`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}

async function listAIMedia(dir: string): Promise<AIMediaFile[]> {
  const names = (await FileSystem.readDirectoryAsync(dir)).filter(name => name.startsWith(AI_MEDIA_PREFIX));
  const files = await Promise.all(names.map(async name => {
    const info = await FileSystem.getInfoAsync(`${dir}${name}`).catch(() => null);
    if (!info?.exists || info.isDirectory) return null;
    return { name, size: info.size || 0, modifiedAt: (info.modificationTime || 0) * 1000 } as AIMediaFile;
  }));
  return files.filter((file): file is AIMediaFile => file !== null);
}

/** Deletes AI cache files by name or URI — only inside the current cache folder, whatever folder a URI names. */
export async function deleteAIMedia(uris: Iterable<string>): Promise<void> {
  const dir = nativeCache(); if (!dir) return;
  const names = new Set([...uris].filter(isAIMediaUri).map(aiMediaName));
  await Promise.all([...names].map(name => FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => {})));
}

/** Removes orphans and keeps the cache under the limit; `keepUris` are the files the stored history and the open conversation still show. Files held by a mounted screen (holdAIMedia) are always kept. */
export async function pruneAIMedia(keepUris: Iterable<string>, protectUris: Iterable<string> = []): Promise<string[]> {
  const dir = nativeCache(); if (!dir) return [];
  const files = await listAIMedia(dir).catch(() => [] as AIMediaFile[]);
  const names = (uris: Iterable<string>) => new Set([...[...uris].filter(isAIMediaUri).map(aiMediaName), ...heldAIMedia()]);
  const remove = planAIMediaCleanup(files, names(keepUris), names(protectUris));
  await Promise.all(remove.map(name => FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => {})));
  return remove.map(name => `${dir}${name}`);
}

/** Media of a reopened conversation whose files are no longer on disk (evicted or wiped by the system). Returns the turns' own `media.uri` values, for dropMedia. */
export async function missingAIMedia(turns: readonly AITurn[]): Promise<string[]> {
  const dir = nativeCache(); if (!dir) return [];
  const stored = turns.flatMap(turn => turn.media && isAIMediaUri(turn.media.uri) ? [turn.media.uri] : []);
  const missing = await Promise.all(stored.map(async uri => {
    const info = await FileSystem.getInfoAsync(`${dir}${aiMediaName(uri)}`).catch(() => null);
    return info?.exists ? null : uri;
  }));
  return missing.filter((uri): uri is string => uri !== null);
}
