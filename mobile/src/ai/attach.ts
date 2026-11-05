// Attachments of the AI chat (phone): photos and videos from the gallery become small JPEG pictures
// for the model (a video becomes three frames — beginning, middle, end); documents are read into text
// by the server. The originals never leave the device as they are.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as DocumentPicker from 'expo-document-picker';

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
      out.push({ name: asset.name, base64: await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 }) });
    } finally { await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {}); }
  }
  return out;
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
