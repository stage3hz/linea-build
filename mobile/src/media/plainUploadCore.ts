// Big plaintext uploads (community channels, profile posts and stories): never refused for their size below the
// account limits. The file is cleaned of metadata by the same streamed cleaner as the end-to-end encrypted big
// files (media/stream: planUpload → planForUpload → readClean) and sent in 4 MiB chunks that resume after a
// lost connection (server: POST /uploads/sessions, PUT ?offset=, /complete). The server only ever gets the
// cleaned bytes; the result is an ordinary attachment (a channel file or a post), not an encrypted one.
// Platform specifics (how the file is read, how a chunk is PUT, how a big photo is re-encoded) come in `io`.
import type { Api } from '../api';
import type { Attachment, LocalFile } from '../types';
import { limitError, uploadMeta, type FileLimits, type UncleanedFile } from '../e2ee/attachments';
import { planUpload, planForUpload, readClean, UncleanableMedia, type ByteSource, type CleanPlan, type UploadRoute } from './stream/index';

/** Above this size (after the usual cleaning) a plaintext upload goes in chunks instead of one request. */
export const SMALL_UPLOAD = 20 * 1024 * 1024;
export const PLAIN_CHUNK = 4 * 1024 * 1024;
export type PlainPurpose = 'channel' | 'post';
/** What a chunked upload needs to continue after a lost connection: the server's upload id. */
export type PlainUploadState = { sessionId: string };
export type PlainUploadOptions = { purpose: PlainPurpose; state?: PlainUploadState; onState?: (state: PlainUploadState) => void; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal };
export type OpenSource = ByteSource & { close: () => void };
export type PutResult = { status: number; body: { received?: number; error?: string; code?: string } } | null;
export type PlainIo = {
  open(file: LocalFile): Promise<OpenSource>;
  /** PUT one chunk; null when the connection dropped (no answer). */
  put(api: Api, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<PutResult>;
  /** A photo of any size re-encoded by the platform (≤ 20 MiB, no metadata). */
  bigPhoto(file: LocalFile): Promise<{ source: OpenSource; name: string; mimeType: string; dispose: () => Promise<void> }>;
  /** Back-off before retrying a chunk (tests make it instant). */
  wait?(attempt: number): Promise<void>;
  /** Pause while the server still runs an earlier request of this upload (409 UPLOAD_BUSY). */
  busyWait?(): Promise<void>;
};

export const POST_MEDIA_ONLY = 'Публикация — фото или видео MP4/MOV.';
const sendsUncleaned = (file: LocalFile) => (file as UncleanedFile).sendUncleaned === true;
export const isAudioHint = (file: LocalFile) => /^audio\//i.test(file.mimeType || '') || /\.(?:m4a|m4b|aac|mp3|wav|flac|ogg|oga|opus|caf|amr|alac|aiff?)$/i.test(file.name || '');

/** What the streamed sniffing sees in the file (null when it cannot be read). */
export async function sniffRoute(io: PlainIo, file: LocalFile): Promise<UploadRoute | null> {
  try { const source = await io.open(file); try { return planUpload(await source.read(0, Math.min(768, source.size)), file); } finally { source.close(); } }
  catch { return null; }
}
/**
 * True when a file the 20 MB pipeline could not handle (or did not recognise as media) must go through the
 * streamed cleaner instead: content our sniffing sees as photo/video/GIF never goes out unchanged.
 */
export function needsStreamedClean(route: UploadRoute | null, file: LocalFile): boolean {
  return !!route && route.kind !== 'raw' && !(route.kind === 'video' && isAudioHint(file));
}

function checkAbort(signal?: AbortSignal) { if (signal?.aborted) { const error = new Error('Загрузка отменена.'); error.name = 'AbortError'; throw error; } }
const defaultWait = (attempt: number) => new Promise<void>(resolve => setTimeout(resolve, 800 * 2 ** attempt));
const BUSY_PAUSE = 5000, BUSY_LIMIT = 90_000;
const defaultBusyWait = () => new Promise<void>(resolve => setTimeout(resolve, BUSY_PAUSE));

/** Cleans (streamed) and uploads a file in chunks; resumes `options.state` when given. */
export async function uploadPlainChunked(api: Api, file: LocalFile, io: PlainIo, options: PlainUploadOptions): Promise<Attachment> {
  if (!api.token) throw new Error('Нужно войти в аккаунт.');
  const opened = await io.open(file);
  let route: UploadRoute, plan: CleanPlan | null = null;
  try {
    route = planUpload(await opened.read(0, Math.min(768, opened.size)), file);
    // A post or a story is shown on the profile: a photo, a GIF or an MP4/MOV (what the server accepts).
    if (options.purpose === 'post' && !(route.kind === 'photo' || route.kind === 'gif' || (route.kind === 'video' && route.container === 'iso'))) throw new Error(POST_MEDIA_ONLY);
    if (route.kind === 'opaque' && !sendsUncleaned(file)) throw new UncleanableMedia();
    if (route.kind === 'photo') {
      opened.close();
      const photo = await io.bigPhoto(file);
      try { return await sendChunks(api, io, photo.source, { kind: 'file', name: photo.name, mimeType: photo.mimeType }, options); }
      finally { photo.source.close(); await photo.dispose().catch(() => {}); }
    }
    options.onProgress?.(0, opened.size);
    // Deterministic: a resumed upload plans the same file again and gets byte-for-byte the same stream.
    plan = await planForUpload(route, opened, file.mimeType || '');
  } catch (error) { opened.close(); throw error; }
  const meta = uploadMeta(file, route, plan);
  const source: OpenSource = plan ? { size: plan.size, read: (offset, length) => readClean(plan!, opened, offset, length), close: opened.close } : opened;
  try {
    const attachment = await sendChunks(api, io, source, { kind: meta.kind, name: file.name, mimeType: meta.mimeType }, options);
    return meta.media ? { ...attachment, media: meta.media } : attachment;
  } finally { source.close(); }
}

async function sendChunks(api: Api, io: PlainIo, source: ByteSource, meta: { kind: 'video' | 'file'; name: string; mimeType: string }, options: PlainUploadOptions, restarted = false): Promise<Attachment> {
  const size = source.size;
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Не удалось определить размер файла.');
  const limits = await api.request<FileLimits>('/uploads/limits').catch(() => null);
  const tooBig = limits && limitError(limits, meta.kind, size);
  if (tooBig) throw new Error(tooBig);
  const wait = io.wait || defaultWait;
  let sessionId = options.state?.sessionId, received = 0;
  if (sessionId) {
    try { received = (await api.request<{ received: number }>(`/uploads/sessions/${encodeURIComponent(sessionId)}`)).received; }
    catch { sessionId = undefined; }
  }
  if (!sessionId) {
    const started = await api.request<{ id: string }>('/uploads/sessions', { method: 'POST', body: JSON.stringify({ purpose: options.purpose, size, kind: meta.kind, name: meta.name.slice(0, 240) || 'file', mimeType: meta.mimeType }) });
    sessionId = started.id; received = 0; options.onState?.({ sessionId });
  }
  const path = `/uploads/sessions/${encodeURIComponent(sessionId)}`;
  let offset = Number.isSafeInteger(received) && received >= 0 && received <= size && received % PLAIN_CHUNK === 0 ? received : 0;
  if (offset !== received) { await api.request(path, { method: 'DELETE' }).catch(() => {}); return sendChunks(api, io, source, meta, { ...options, state: undefined }); }
  options.onProgress?.(offset, size);
  let attempt = 0, busyFor = 0;
  while (offset < size) {
    checkAbort(options.signal);
    const length = Math.min(PLAIN_CHUNK, size - offset);
    const bytes = await source.read(offset, length);
    if (bytes.length !== length) throw new Error('Файл изменился во время отправки.');
    const result = await io.put(api, `${path}?offset=${offset}`, bytes, options.signal).catch(() => null);
    checkAbort(options.signal);
    if (result?.status === 200) { offset += length; attempt = 0; options.onProgress?.(offset, size); continue; }
    // The chunk got through but the reply was lost, or the server has another offset: continue from what it has.
    const has = result?.status === 409 ? result.body?.received : undefined;
    if (typeof has === 'number' && Number.isSafeInteger(has) && has !== offset && has >= 0 && has <= size && (has % PLAIN_CHUNK === 0 || has === size)) {
      offset = has; attempt = 0; options.onProgress?.(offset, size); continue;
    }
    // The server lost what it had (its part file is gone): start a new upload once instead of five hopeless retries.
    // An earlier request of this upload is still running on the server (a connection that went silent): wait for it
    // without spending the retries, up to about 90 s.
    if (result?.status === 409 && result.body?.code === 'UPLOAD_BUSY' && busyFor < BUSY_LIMIT) {
      await (io.busyWait || defaultBusyWait)(); busyFor += BUSY_PAUSE; continue;
    }
    if (result?.status === 409 && result.body?.code === 'UPLOAD_LOST' && !restarted) {
      await api.request(path, { method: 'DELETE' }).catch(() => {});
      return sendChunks(api, io, source, meta, { ...options, state: undefined }, true);
    }
    if (result && [401, 403, 404, 413, 415, 507].includes(result.status)) throw new Error(result.body?.error || 'Сервер отклонил файл.');
    // Only a caller that keeps the state (onState) can continue later; otherwise say honestly that it starts over.
    if (attempt >= 5) throw new Error(options.onState ? 'Связь прервалась. Нажми «повторить» — отправка продолжится с того же места.' : 'Связь прервалась. Отправь файл ещё раз.');
    await wait(attempt++);
  }
  checkAbort(options.signal);
  const done = await api.request<{ attachment: Attachment }>(`${path}/complete`, { method: 'POST' });
  if (done.attachment.size !== size) throw new Error('Размер загруженного файла не совпадает.');
  return done.attachment;
}

/** Drops an unfinished chunked upload on the server (cancel). */
export async function cancelPlainUpload(api: Api, state?: PlainUploadState): Promise<void> {
  if (state?.sessionId) await api.request(`/uploads/sessions/${encodeURIComponent(state.sessionId)}`, { method: 'DELETE' }).catch(() => {});
}
