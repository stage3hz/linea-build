import { requireOptionalNativeModule } from 'expo-modules-core';
import type { SignalBridge } from './types';
const bridge = requireOptionalNativeModule<SignalBridge>('LineaSignal');
export const signalAvailable = bridge !== null;
export function getSignalBridge(): SignalBridge {
  if (!bridge) throw new Error('Эта сборка не содержит модуль шифрования. Установи полную версию приложения; отправка открытого текста отключена.');
  return bridge;
}
