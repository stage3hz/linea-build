import type { SignalBridge } from './types';
export const signalAvailable = false;
export function getSignalBridge(): SignalBridge {
  throw new Error('Сквозное шифрование доступно в установленном приложении для Android и iPhone. Веб-версия не отправляет сообщения.');
}
