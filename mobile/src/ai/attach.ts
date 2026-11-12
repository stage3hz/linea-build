// Attachments of the AI chat (phone): photos and videos from the gallery become small JPEG pictures
// for the model (a video becomes three frames — beginning, middle, end); documents are read into text
// by the server. The originals never leave the device as they are.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as DocumentPicker from 'expo-document-picker';
import { toByteArray } from 'base64-js';
import { planUpload } from '../media/stream/index';

/** Photos and videos never go to the model as documents (with EXIF/GPS): only as cleaned pictures or frames. */
export const MEDIA_AS_DOCUMENT='Фото и видео прикрепляй кнопкой «Фото и видео»: модель получит копию без метаданных (места съёмки, даты, модели камеры).';
export function refuseMediaDocument(header: Uint8Array, name: string, mimeType: string): void {
  if (planUpload(header, { name, mimeType }).kind !== 'raw') throw new Error(MEDIA_AS_DOCUMENT);
}

export type AIPicture = { id: string; uri: string; data: string; video?: boolean };
export type PickedFile = { name: string; base64: string };
export const MAX_PICTURES = 8;
const MAX_DOCUMENT = 15 * 1024 * 1024;

async function jpeg(uri: string, width?: number, height?: number): Promise<string> {
  const edge = Math.max(width || 0, height || 0);
  const small = await ImageManipulator.manipulateAsync(uri, edge > 1280 || !edge ? [{ resize: (width || 1) >= (height || 0) ? { width: 1280 } : { height: 1280 } }] : [], { format: ImageManipulator.SaveFormat.JPEG, compress: .8, base64: true });
  if (!small.base64 || small.base64.length > 5_000_000) throw new Error('Фото слишком большое для вопроса.');
  return `data:image/jpeg;base64,${small.base64}`;
}

/** Several photos or videos at once. Returns pictures ready to send (up to `room`). */
export async function pickPictures(room: number): Promise<AIPicture[]> {
  if (room <= 0) throw new Error(`К вопросу — до ${MAX_PICTURES} фото и кадров.`);
  const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: room, quality: 1, exif: false, videoMaxDuration: 600 });
  if (picked.canceled) return [];
  const out: AIPicture[] = [];
  for (const asset of picked.assets) {
    if (out.length >= room) break;
    if (asset.type === 'video') {
      const seconds = (asset.duration || 0) / 1000;
      for (const at of seconds > 1 ? [0.1, 0.5, 0.9] : [0]) {
        if (out.length >= room) break;
        const frame = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: Math.round(seconds * at * 1000), quality: .8 });
        try { out.push({ id: `${asset.assetId || asset.uri}#${at}`, uri: frame.uri, data: await jpeg(frame.uri, frame.width, frame.height), video: true }); }
        finally { /* the frame file stays in the cache for the preview; the OS clears the cache */ }
      }
    } else out.push({ id: asset.assetId || asset.uri, uri: asset.uri, data: await jpeg(asset.uri, asset.width, asset.height) });
  }
  return out;
}

/** PDF, Word, PowerPoint, Excel, OpenDocument and text files (several at once). */
export async function pickDocuments(): Promise<PickedFile[]> {
  const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
  if (picked.canceled) return [];
  const out: PickedFile[] = [];
  for (const asset of picked.assets) {
    try {
      if (asset.size && asset.size > MAX_DOCUMENT) throw new Error(`«${asset.name}» больше 15 МБ.`);
      refuseMediaDocument(toByteArray(await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64, position: 0, length: 768 })), asset.name, asset.mimeType || '');
      out.push({ name: asset.name, base64: await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 }) });
    } finally { await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {}); }
  }
  return out;
}

/**
 * «Файл» with a photo or a video chosen in it: instead of refusing («прикрепляй кнопкой „Фото и видео“»), the file is
 * prepared the same way that button prepares it — a photo is re-encoded (which drops EXIF/GPS), a video is replaced by
 * frames — and comes back as pictures. Everything else comes back as documents. Never the original media file.
 */
export async function pickDocumentsOrMedia(room: number): Promise<{ files: PickedFile[]; pictures: AIPicture[] }> {
  const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
  if (picked.canceled) return { files: [], pictures: [] };
  const files: PickedFile[] = [], pictures: AIPicture[] = [];
  for (const asset of picked.assets) {
    let keep = false;
    try {
      const header = toByteArray(await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64, position: 0, length: 768 }));
      const media = planUpload(header, { name: asset.name, mimeType: asset.mimeType || '' }).kind !== 'raw';
      if (!media) {
        if (asset.size && asset.size > MAX_DOCUMENT) throw new Error(`«${asset.name}» больше 15 МБ.`);
        files.push({ name: asset.name, base64: await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 }) });
        continue;
      }
      if (pictures.length >= room) throw new Error(`К вопросу — до ${MAX_PICTURES} фото и кадров.`);
      const video = (asset.mimeType || '').startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(asset.name);
      try {
        if (video) {
          // The length is not known here: a frame near the start and, when the video is long enough, two later ones.
          for (const time of [400, 3000, 9000]) {
            if (pictures.length >= room) break;
            try { const frame = await VideoThumbnails.getThumbnailAsync(asset.uri, { time, quality: .8 }); pictures.push({ id: `${asset.uri}#${time}`, uri: frame.uri, data: await jpeg(frame.uri, frame.width, frame.height), video: true }); }
            catch { if (time === 400) throw new Error('frame'); break; }
          }
        } else { pictures.push({ id: asset.uri, uri: asset.uri, data: await jpeg(asset.uri) }); keep = true; }
      } catch { throw new Error(MEDIA_AS_DOCUMENT); }
    } finally { if (!keep) await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {}); }
  }
  return { files, pictures };
}

export async function pickAudio(): Promise<PickedFile | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: 'audio/*', multiple: false, copyToCacheDirectory: true });
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return null;
  try {
    if (asset.size && asset.size > 10 * 1024 * 1024) throw new Error('Аудио для расшифровки — до 10 МБ.');
    return { name: asset.name, base64: await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 }) };
  } finally { await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {}); }
}
