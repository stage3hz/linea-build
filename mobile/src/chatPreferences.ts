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
import type { AnimationMode } from './motionPolicy';
/** Chat backgrounds (Настройки → Оформление → Обои чатов). Colours are drawn over the app background. */
export const WALLPAPERS = [
  { id: 'none', label: 'Как фон', colors: null },
  { id: 'aurora', label: 'Аврора', colors: ['#0E2A47', '#1B3F6B', '#3A2A63'] },
  { id: 'night', label: 'Ночь', colors: ['#05060B', '#0B1020', '#121A33'] },
  { id: 'mint', label: 'Мята', colors: ['#0D3B3A', '#145650', '#1E3B5A'] },
  { id: 'sunset', label: 'Закат', colors: ['#3B1838', '#5A2440', '#2A1E4A'] },
  { id: 'violet', label: 'Фиолет', colors: ['#3A2D8F', '#5B3FB8', '#2B5BB5'] },
] as const;
export type Wallpaper = typeof WALLPAPERS[number]['id'];
export type { AnimationMode };
export type ChatPreferences = { textSize: TextSize; sendTyping: boolean; animations: AnimationMode; lowBattery: number; bubbleRadius: number; wallpaper: Wallpaper };
const KEY = 'linea.chat-preferences.v1';
const DEFAULTS: ChatPreferences = { textSize: 'medium', sendTyping: true, animations: 'auto', lowBattery: 0.27, bubbleRadius: 20, wallpaper: 'none' };

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
      animations: value?.animations === 'on' || value?.animations === 'off' ? value.animations : 'auto',
      lowBattery: [0, 0.15, 0.27, 0.4].includes(value?.lowBattery) ? value.lowBattery : DEFAULTS.lowBattery,
      bubbleRadius: [8, 14, 20].includes(value?.bubbleRadius) ? value.bubbleRadius : DEFAULTS.bubbleRadius,
      wallpaper: WALLPAPERS.some(item => item.id === value?.wallpaper) ? value.wallpaper : DEFAULTS.wallpaper,
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
