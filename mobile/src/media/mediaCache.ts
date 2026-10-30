// Decrypted media for the current app session, like Telegram's cache: a photo,
// video or file is downloaded once, shows progress, and opens instantly later.
// Files live in the app's private cache folder under the `linea-view-` prefix,
// so clearDecryptedAttachmentCache() wipes them on sign-in and sign-out.
import { useCallback, useEffect, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { attachmentFileName, decryptAttachmentWithProgress } from '../e2ee/attachments';

export type MediaState = { status: 'idle' | 'loading' | 'ready' | 'error'; progress: number; uri?: string; error?: string };
type Entry = MediaState & { size: number; usedAt: number; abort?: AbortController; promise?: Promise<string> };

const LIMIT_BYTES = 300 * 1024 * 1024;
const IDLE: MediaState = { status: 'idle', progress: 0 };
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<(state: MediaState) => void>>();
let generation = 0;

/** Same file, same key: one cache entry. A re-uploaded copy gets its own key id. */
export const mediaKey = (attachment: Attachment) => `${attachment.id}:${attachment.encryption?.fileKeyId || ''}`;

function publish(key: string) {
  const entry = entries.get(key);
  const state: MediaState = entry ? { status: entry.status, progress: entry.progress, uri: entry.uri, error: entry.error } : IDLE;
  listeners.get(key)?.forEach(listener => listener(state));
}

function evict() {
  let total = [...entries.values()].reduce((sum, entry) => sum + (entry.status === 'ready' ? entry.size : 0), 0);
  if (total <= LIMIT_BYTES) return;
  const ready = [...entries.entries()].filter(([, entry]) => entry.status === 'ready').sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key, entry] of ready) {
    if (total <= LIMIT_BYTES) break;
    if (listeners.get(key)?.size) continue; // on screen right now
    entries.delete(key); total -= entry.size;
    if (entry.uri) void FileSystem.deleteAsync(entry.uri.slice(0, entry.uri.lastIndexOf('/') + 1), { idempotent: true }).catch(() => {});
  }
}

export function mediaState(attachment: Attachment): MediaState {
  const entry = entries.get(mediaKey(attachment));
  return entry ? { status: entry.status, progress: entry.progress, uri: entry.uri, error: entry.error } : IDLE;
}

/** Starts (or joins) the download; resolves with the decrypted local file. */
export function loadMedia(api: Api, attachment: Attachment): Promise<string> {
  const key = mediaKey(attachment);
  const existing = entries.get(key);
  if (existing?.status === 'ready' && existing.uri) { existing.usedAt = Date.now(); return Promise.resolve(existing.uri); }
  if (existing?.status === 'loading' && existing.promise) return existing.promise;
  const abort = new AbortController(), owner = generation;
  // One stable folder per file: the original name is kept (Quick Look / «Открыть в…» show it),
  // and after a restart the decrypted copy is found on disk instead of being downloaded again.
  const folder = `${FileSystem.cacheDirectory}linea-view-cache-${key.replace(/[^A-Za-z0-9-]/g, '_')}/`;
  const target = `${folder}${attachmentFileName(attachment)}`;
  const entry: Entry = { status: 'loading', progress: 0, size: attachment.size, usedAt: Date.now(), abort };
  let lastPublished = 0;
  entry.promise = FileSystem.getInfoAsync(target).catch(() => null).then(async info => {
    if (info?.exists && !info.isDirectory && info.size === attachment.size) return;
    await FileSystem.deleteAsync(folder, { idempotent: true }).catch(() => {});
    await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    await decryptAttachmentWithProgress(api, attachment, fraction => {
    if (entries.get(key) !== entry) return;
    entry.progress = fraction;
    const now = Date.now();
    if (now - lastPublished > 80 || fraction >= 1) { lastPublished = now; publish(key); }
  }, target, abort.signal);
  }).then(() => {
    if (owner !== generation || entries.get(key) !== entry) { void FileSystem.deleteAsync(folder, { idempotent: true }).catch(() => {}); throw new Error('Загрузка отменена.'); }
    entry.status = 'ready'; entry.progress = 1; entry.uri = target; entry.abort = undefined; entry.promise = undefined;
    publish(key); evict();
    return target;
  }, error => {
    if (entries.get(key) === entry) {
      if (abort.signal.aborted) entries.delete(key);
      else { entry.status = 'error'; entry.error = error instanceof Error ? error.message : 'Не удалось загрузить файл.'; entry.abort = undefined; entry.promise = undefined; }
      publish(key);
    }
    throw error;
  });
  entries.set(key, entry); publish(key);
  entry.promise.catch(() => {});
  return entry.promise;
}

export function cancelMedia(attachment: Attachment) {
  const key = mediaKey(attachment), entry = entries.get(key);
  if (entry?.status !== 'loading') return;
  entry.abort?.abort(); entries.delete(key); publish(key);
}

/** Forget everything (the files themselves are removed by clearDecryptedAttachmentCache). */
export function resetMediaCache() {
  generation++;
  for (const entry of entries.values()) entry.abort?.abort();
  entries.clear();
  for (const key of listeners.keys()) publish(key);
}

/** Live download state of one attachment. `auto` starts the download right away (photos, as in Telegram). */
export function useMedia(api: Api, attachment: Attachment | null | undefined, auto = false) {
  const key = attachment ? mediaKey(attachment) : '';
  const [state, setState] = useState<MediaState>(() => attachment ? mediaState(attachment) : IDLE);
  useEffect(() => {
    if (!attachment) { setState(IDLE); return; }
    const set = listeners.get(key) ?? new Set(); listeners.set(key, set);
    set.add(setState); setState(mediaState(attachment));
    if (auto && attachment.encryption) void loadMedia(api, attachment).catch(() => {});
    return () => { set.delete(setState); if (!set.size) listeners.delete(key); };
  }, [key, auto, api]);
  const start = useCallback(() => attachment ? loadMedia(api, attachment) : Promise.reject(new Error('Нет файла.')), [api, key]);
  const cancel = useCallback(() => { if (attachment) cancelMedia(attachment); }, [key]);
  return { ...state, start, cancel };
}
