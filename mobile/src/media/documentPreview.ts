// Opens a decrypted document inside the app, like Telegram:
// iPhone — Quick Look (PDF, Word, Excel, Keynote, text, images…);
// Android — the system viewer for that type (ACTION_VIEW with a temporary read grant).
// Returns false when nothing can preview the file, so the caller can offer «Открыть в…».
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { LineaPhotoBridge } from '../../modules/linea-photo';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { loadMedia } from './mediaCache';

const nativePhoto = requireOptionalNativeModule<LineaPhotoBridge>('LineaPhoto');
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export async function previewDocument(uri: string, mimeType: string): Promise<boolean> {
  if (Platform.OS === 'ios') {
    if (!nativePhoto?.previewFile) return false;
    return nativePhoto.previewFile(uri);
  }
  if (Platform.OS === 'android') {
    try {
      const IntentLauncher = await import('expo-intent-launcher');
      const data = await FileSystem.getContentUriAsync(uri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data, type: mimeType || '*/*', flags: FLAG_GRANT_READ_URI_PERMISSION });
      return true;
    } catch { return false; }
  }
  return false;
}

/** Downloads (or reuses) the decrypted copy and previews it. false = no viewer for this type. */
export async function openDocument(api: Api, file: Attachment): Promise<boolean> {
  const uri = await loadMedia(api, file);
  return previewDocument(uri, file.mimeType);
}
