// Local, per-device chat preferences (not sent to the server).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type TextSize = 'small' | 'medium' | 'large' | 'xlarge';
export const TEXT_SIZES: { id: TextSize; label: string; fontSize: number; lineHeight: number }[] = [
  { id: 'small', label: 'Мелкий', fontSize: 13, lineHeight: 19 },
  { id: 'medium', label: 'Обычный', fontSize: 15, lineHeight: 22 },
  { id: 'large', label: 'Крупный', fontSize: 17, lineHeight: 24 },
  { id: 'xlarge', label: 'Очень крупный', fontSize: 20, lineHeight: 28 },
];
export type ChatPreferences = { textSize: TextSize; sendTyping: boolean };
const KEY = 'linea.chat-preferences.v1';
const DEFAULTS: ChatPreferences = { textSize: 'medium', sendTyping: true };

let current: ChatPreferences = DEFAULTS;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export function parsePreferences(raw: string | null): ChatPreferences {
  if (!raw) return DEFAULTS;
  try {
    const value = JSON.parse(raw);
    return {
      textSize: TEXT_SIZES.some(size => size.id === value?.textSize) ? value.textSize : DEFAULTS.textSize,
      sendTyping: typeof value?.sendTyping === 'boolean' ? value.sendTyping : DEFAULTS.sendTyping,
    };
  } catch { return DEFAULTS; }
}

let loaded: Promise<void> | null = null;
function load() {
  if (!loaded) loaded = AsyncStorage.getItem(KEY).then(raw => { current = parsePreferences(raw); emit(); }).catch(() => {});
  return loaded;
}

export function getChatPreferences(): ChatPreferences { void load(); return current; }
export function setChatPreferences(change: Partial<ChatPreferences>) {
  current = { ...current, ...change };
  emit();
  void AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
}
export function useChatPreferences(): ChatPreferences {
  void load();
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => current, () => current);
}
export const textMetrics = (size: TextSize) => TEXT_SIZES.find(item => item.id === size) ?? TEXT_SIZES[1];
