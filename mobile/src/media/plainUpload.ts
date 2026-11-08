// Android/iPhone side of the chunked plaintext uploads (plainUploadCore.ts): the file is read through an
// expo-file-system File handle (one 4 MiB window at a time, content:// included) and each chunk is PUT from a
// temporary file, like the encrypted big files (e2ee/attachments.ts).
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { fromByteArray } from 'base64-js';
import { CLIENT_HEADER, type Api } from '../api';
import { attestHeaders } from '../attest/index';
import { networkTier, timeoutFor } from '../network/quality';
import type { Attachment, LocalFile } from '../types';
import { prepareMediaForUpload } from './pipeline';
import { needsStreamedClean, sniffRoute, uploadPlainChunked, type OpenSource, type PlainIo, type PlainUploadOptions } from './plainUploadCore';

export { SMALL_UPLOAD, cancelPlainUpload, needsStreamedClean, type PlainUploadState, type PlainUploadOptions } from './plainUploadCore';

function openFile(uri: string, known?: number): OpenSource {
  const source = new File(uri);
  const size = typeof source.size === 'number' && source.size > 0 ? source.size : known || 0;
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Не удалось определить размер файла.');
  const handle = source.open();
  return { size, read: async (offset, length) => { handle.offset = offset; return handle.readBytes(length); }, close: () => handle.close() };
}

export const nativeIo: PlainIo = {
  open: async file => openFile(file.uri, file.size),
  async put(api, path, bytes, signal) {
    const temp = `${FileSystem.cacheDirectory}linea-plain-up-${Crypto.randomUUID()}.bin`;
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
    try {
      await FileSystem.writeAsStringAsync(temp, fromByteArray(bytes), { encoding: FileSystem.EncodingType.Base64 });
      // A task, not a bare uploadAsync: «Отмена» and a stalled connection stop the chunk instead of waiting forever.
      const task = FileSystem.createUploadTask(`${api.endpoint}${path}`, temp, { httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/octet-stream', 'X-Linea-Client': CLIENT_HEADER, ...attestHeaders('PUT', path) } });
      cancel = () => { task.cancelAsync().catch(() => {}); };
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(cancel, timeoutFor('upload', networkTier()) * 2);
      const result = signal?.aborted ? null : await task.uploadAsync().catch(() => null);
      if (!result) return null;
      let body: { received?: number; error?: string; code?: string } = {};
      try { body = JSON.parse(result.body || '{}'); } catch { body = {}; }
      return { status: result.status, body };
    } finally {
      if (timer) clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
      await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {});
    }
  },
  async bigPhoto(file) {
    const prepared = await prepareMediaForUpload(file);
    if (!prepared.photo) { await prepared.dispose().catch(() => {}); throw new Error('Не удалось обработать фото. Файл не отправлен.'); }
    try { return { source: openFile(prepared.file.uri, prepared.file.size), name: prepared.file.name, mimeType: prepared.file.mimeType, dispose: prepared.dispose }; }
    catch (error) { await prepared.dispose().catch(() => {}); throw error; }
  },
};

/** Cleans (streamed) and uploads a file of any size in resumable 4 MiB chunks. */
export const uploadPlainLarge = (api: Api, file: LocalFile, options: PlainUploadOptions): Promise<Attachment> => uploadPlainChunked(api, file, nativeIo, options);
/** Whether a file the 20 MB pipeline could not take must go through the streamed cleaner. */
export const streamRouteNeeded = async (file: LocalFile) => needsStreamedClean(await sniffRoute(nativeIo, file), file);
