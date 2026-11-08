// PC (Electron) side of the chunked plaintext uploads (plainUploadCore.ts): the file is a Blob read in slices,
// each chunk goes through the app's authenticated request channel, a big photo is re-encoded by the engine.
import type { Api } from '../api';
import type { Attachment, LocalFile } from '../types';
import { prepareBigPhoto } from './pipeline.web';
import { needsStreamedClean, sniffRoute, uploadPlainChunked, type OpenSource, type PlainIo, type PlainUploadOptions } from './plainUploadCore';

export { SMALL_UPLOAD, cancelPlainUpload, needsStreamedClean, type PlainUploadState, type PlainUploadOptions } from './plainUploadCore';

/**
 * The picked File itself when there is one (the PC pickers and drag-and-drop give it): slices read straight from
 * disk, nothing is copied. A bare blob: URI is fetched as a Blob, which the engine keeps by reference for blob:
 * URLs, but a file: or http URI would be read whole — the desktop callers always pass `file`.
 */
async function blobOf(file: LocalFile): Promise<Blob> {
  if (file.file) return file.file;
  const response = await fetch(file.uri); if (!response.ok) throw new Error('Не удалось прочитать файл.');
  return response.blob();
}
const blobSource = (blob: Blob): OpenSource => ({ size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()), close: () => {} });

export const webIo: PlainIo = {
  open: async file => blobSource(await blobOf(file)),
  async put(api, path, bytes, signal) {
    try { return { status: 200, body: await api.request<{ received?: number }>(path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes as unknown as BodyInit, signal }) }; }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const status = (error as { status?: number })?.status;
      if (typeof status !== 'number') return null;
      return { status, body: { received: (error as { received?: number }).received, code: (error as { code?: string }).code, error: (error as Error).message } };
    }
  },
  async bigPhoto(file) {
    const prepared = await prepareBigPhoto(file, await blobOf(file));
    // The re-encoded photo is read from its own URI: `prepared.file.file` would still be the original Blob.
    try { return { source: blobSource(await blobOf({ ...prepared.file, file: undefined })), name: prepared.file.name, mimeType: prepared.file.mimeType, dispose: prepared.dispose }; }
    catch (error) { await prepared.dispose().catch(() => {}); throw error; }
  },
};

export const uploadPlainLarge = (api: Api, file: LocalFile, options: PlainUploadOptions): Promise<Attachment> => uploadPlainChunked(api, file, webIo, options);
export const streamRouteNeeded = async (file: LocalFile) => needsStreamedClean(await sniffRoute(webIo, file), file);
