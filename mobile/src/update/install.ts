// Download → verify SHA-256 → hand to the system installer. The user still confirms
// the installation in the system window; nothing is installed silently.
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { desktopBridge } from '../desktop';
import { Sha256 } from './sha256';
import type { UpdateAsset } from './store';

export type Phase = { step: 'download' | 'verify' | 'install'; progress: number };
const CHUNK = 2 * 1024 * 1024;
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export const canSelfUpdate = () => !!desktopBridge()?.update || Platform.OS === 'android';
export const assetFor = (info: { android: UpdateAsset | null; windows: UpdateAsset | null }) => desktopBridge() ? info.windows : Platform.OS === 'android' ? info.android : null;

async function verifyFile(uri: string, asset: UpdateAsset, onPhase: (phase: Phase) => void) {
  const file = new File(uri);
  if (file.size !== asset.size) throw new Error('Файл загрузился не полностью. Попробуй ещё раз.');
  const hash = new Sha256(), handle = file.open();
  try {
    for (let offset = 0; offset < asset.size; offset += CHUNK) {
      handle.offset = offset;
      hash.update(handle.readBytes(Math.min(CHUNK, asset.size - offset)));
      onPhase({ step: 'verify', progress: Math.min(1, (offset + CHUNK) / asset.size) });
      await tick(); // keep the screen responsive
    }
  } finally { handle.close(); }
  if (hash.hex() !== asset.sha256) throw new Error('Файл обновления повреждён или подменён — установка отменена.');
}

export async function downloadAndInstall(asset: UpdateAsset, version: string, onPhase: (phase: Phase) => void): Promise<void> {
  const bridge = desktopBridge();
  if (bridge?.update) {
    let done = false;
    const poll = (async () => { while (!done) { const p = await bridge.update!.progress().catch(() => null); if (p?.total) onPhase({ step: 'download', progress: p.received / p.total }); await new Promise(r => setTimeout(r, 300)); } })();
    try { await bridge.update.download(asset.url, asset.sha256, asset.size); } finally { done = true; await poll; }
    onPhase({ step: 'install', progress: 1 });
    await bridge.update.install(); // the installer opens; the app closes itself
    return;
  }
  if (Platform.OS !== 'android') throw new Error('На этом устройстве обновление ставится вручную.');
  const dir = `${FileSystem.cacheDirectory}updates/`;
  await FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => {});
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const target = `${dir}INVIZENT-${version.replace(/[^0-9.]/g, '')}.apk`;
  const task = FileSystem.createDownloadResumable(asset.url, target, { cache: false }, data => {
    const total = data.totalBytesExpectedToWrite > 0 ? data.totalBytesExpectedToWrite : asset.size;
    onPhase({ step: 'download', progress: Math.min(1, data.totalBytesWritten / total) });
  });
  const result = await task.downloadAsync();
  if (!result || result.status !== 200) throw new Error('Не удалось скачать обновление. Проверь интернет.');
  try { await verifyFile(target, asset, onPhase); }
  catch (error) { await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {}); throw error; }
  onPhase({ step: 'install', progress: 1 });
  const IntentLauncher = await import('expo-intent-launcher');
  const data = await FileSystem.getContentUriAsync(target);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data, type: 'application/vnd.android.package-archive', flags: FLAG_GRANT_READ_URI_PERMISSION });
}
