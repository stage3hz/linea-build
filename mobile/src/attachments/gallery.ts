import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import type { PermissionResponse } from 'expo-media-library';
import type { AttachmentSelection, GalleryItem } from './selection';
import { ThumbnailSession } from './ThumbnailSession';
import { resolveVideoLibraryAsset } from '../media/pipeline';

export const GALLERY_PAGE_SIZE = 48;
type Library = typeof import('expo-media-library');
export type ResolvedSelection = AttachmentSelection & { dispose: () => Promise<void> };
const noCleanup = async () => {};
let library: Promise<Library> | null = null;

export function getGalleryLibrary(): Promise<Library> {
  if (Platform.OS === 'web') return Promise.reject(new Error('Галерея устройства доступна в приложении Android и iPhone.'));
  if (!library) library = import('expo-media-library').catch(error => { library = null; throw error; });
  return library;
}

export async function galleryPermission(request: boolean): Promise<PermissionResponse> {
  const api = await getGalleryLibrary();
  return request ? api.requestPermissionsAsync(false, ['photo', 'video']) : api.getPermissionsAsync(false, ['photo', 'video']);
}

/** The metadata query does not resolve or download the full asset. */
export async function readGalleryPage(offset: number): Promise<{ items: GalleryItem[]; nextOffset: number | null }> {
  const api = await getGalleryLibrary();
  const page = await new api.Query().within(api.AssetField.MEDIA_TYPE, [api.MediaType.IMAGE, api.MediaType.VIDEO])
    .orderBy({ key: api.AssetField.CREATION_TIME, ascending: false }).limit(GALLERY_PAGE_SIZE).offset(offset).exeForMetadata();
  const items = page.map(asset => {
    const kind = asset.mediaType === api.MediaType.VIDEO ? 'video' as const : 'photo' as const;
    return {
      id: `gallery:${asset.id}`, assetId: asset.id, kind, width: asset.width ?? 0, height: asset.height ?? 0, duration: asset.duration,
      file: { uri: asset.id, name: asset.filename || (kind === 'photo' ? 'photo' : 'video'), mimeType: kind === 'photo' ? 'image/*' : 'video/*' },
    };
  });
  return { items, nextOffset: page.length < GALLERY_PAGE_SIZE ? null : offset + page.length };
}

/** Called only after edit/add intent, never while populating the thumbnail grid. */
export async function resolveSelection(item: AttachmentSelection): Promise<ResolvedSelection> {
  if (!item.assetId) return { ...item, dispose: noCleanup };
  if (Platform.OS === 'android') return { ...item, file: { ...item.file, uri: item.assetId }, dispose: noCleanup };
  if (item.kind === 'video') {
    const original = await resolveVideoLibraryAsset(item.assetId);
    return { ...item, file: { ...item.file, uri: original.fileUri }, dispose: original.dispose };
  }
  const api = await getGalleryLibrary();
  const asset = new api.Asset(item.assetId);
  const uri = await asset.getUri();
  if (!uri.startsWith('file://')) throw new Error('Не удалось получить оригинал. Открой его на устройстве или выбери через «Файлы».');
  return { ...item, file: { ...item.file, uri }, dispose: noCleanup };
}

export function createVideoThumbnails(): ThumbnailSession {
  return new ThumbnailSession(async source => {
    if (Platform.OS !== 'android') throw new Error('На iPhone миниатюры загружает системная медиатека.');
    if (!/^(?:file|content):\/\//.test(source)) throw new Error('Оригинал видео недоступен на устройстве.');
    const api = await import('expo-video-thumbnails');
    const thumbnail = await api.getThumbnailAsync(source, { time: 0, quality: .45 });
    const cache = FileSystem.cacheDirectory;
    if (!cache || !thumbnail.uri.startsWith(`${cache}VideoThumbnails/`)) throw new Error('Недопустимый путь миниатюры.');
    return thumbnail.uri;
  }, uri => FileSystem.deleteAsync(uri, { idempotent: true }));
}
