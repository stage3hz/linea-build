import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import type { LocalFile } from '../types';

/**
 * Android galleries hand out content:// URIs, which expo-file-system cannot read
 * with readAsStringAsync («Unsupported scheme for location content://…»).
 * The file is copied once into the app cache; the caller deletes the copy.
 */
export async function ensureFileUri(file: LocalFile): Promise<{ file: LocalFile; dispose: () => Promise<void> }> {
  if (!file.uri.startsWith('content://')) return { file, dispose: async () => {} };
  if (!FileSystem.cacheDirectory) throw new Error('Кэш приложения недоступен.');
  const extension = (/\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] || 'bin').toLowerCase();
  const uri = `${FileSystem.cacheDirectory}linea-import-${Crypto.randomUUID()}.${extension}`;
  try { await FileSystem.copyAsync({ from: file.uri, to: uri }); }
  catch (error) { await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); throw new Error('Не удалось прочитать файл из галереи. Попробуй выбрать его ещё раз.'); }
  const info = await FileSystem.getInfoAsync(uri);
  return { file: { ...file, uri, ...(info.exists && !info.isDirectory ? { size: info.size } : {}) }, dispose: () => FileSystem.deleteAsync(uri, { idempotent: true }) };
}
