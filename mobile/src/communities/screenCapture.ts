import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ScreenQuality } from './screenShareModel';
const bridge = () => requireOptionalNativeModule<{ configure(quality:string):Promise<void>; showPicker():Promise<void>; isActive():Promise<boolean>; stop():Promise<void> }>('LineaScreen');
export async function prepareScreenCapture(quality: ScreenQuality) {
  if (Platform.OS !== 'ios') return;
  const native = bridge(); if (!native) throw new Error('Нужна новая IPA с расширением демонстрации экрана.');
  await native.configure(quality);
}
export async function confirmScreenCapture(alive: () => boolean) {
  if (Platform.OS !== 'ios') return;
  const native = bridge()!; await native.showPicker();
  for (let i = 0; i < 480 && alive(); i++) { if (await native.isActive()) return; await new Promise(resolve => setTimeout(resolve,250)); }
  throw new Error('Запуск демонстрации отменён или не подтверждён.');
}
export function endScreenCapture() { if (Platform.OS === 'ios') void bridge()?.stop().catch(() => {}); }
