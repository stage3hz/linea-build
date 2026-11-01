import { desktopBridge } from '../desktop';
import type { SignalBridge } from './types';
export const signalAvailable = !!desktopBridge();
export function getSignalBridge(): SignalBridge {
  const desktop = desktopBridge(); if (desktop) return desktop.signal;
  throw new Error('Сквозное шифрование доступно в установленном приложении для Android и iPhone. Веб-версия не отправляет сообщения.');
}
