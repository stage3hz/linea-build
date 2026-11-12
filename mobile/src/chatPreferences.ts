// Local, per-device chat preferences (not sent to the server).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type TextSize = 'small' | 'medium' | 'large' | 'xlarge';
export const TEXT_SIZES: { id: TextSize; label: string; fontSize: number; lineHeight: number }[] = [
  // «Обычный» = Telegram for iPhone default (17 pt text, 22 pt line).
  { id: 'small', label: 'Мелкий', fontSize: 15, lineHeight: 20 },
  { id: 'medium', label: 'Обычный', fontSize: 17, lineHeight: 22 },
  { id: 'large', label: 'Крупный', fontSize: 19, lineHeight: 25 },
  { id: 'xlarge', label: 'Очень крупный', fontSize: 22, lineHeight: 28 },
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
export type NightMode = 'system' | 'off' | 'schedule' | 'auto';
/** Telegram «Энергосбережение»: what keeps playing while power saving is not active. */
export type PowerFeature = 'video' | 'gif' | 'stickers' | 'emoji';
export type ChatPreferences = {
  textSize: TextSize; sendTyping: boolean; animations: AnimationMode; lowBattery: number; bubbleRadius: number; wallpaper: Wallpaper;
  /** Night theme switching (Telegram «Ночная тема»); null = as before: follow the system when the theme is «Как в системе». */
  nightMode: NightMode | null; nightFrom: string; nightTo: string; nightBrightness: number;
  /** «Ночной режим» switched by hand: overrides the automatic choice until it changes by itself. */
  nightForced: boolean | null; nightForcedAt: boolean | null;
  /** Power saving: 0 = never by battery, 1 = always on, otherwise the battery level (0..1) below which it turns on. */
  autoplayVideo: boolean; autoplayGif: boolean; animatedStickers: boolean; animatedEmoji: boolean;
  /** «Пиксельный след» under the finger / cursor (src/PixelTrail.tsx); also off whenever animations are off. */
  pixelTrail: boolean;
  /** «Снег» (PC): falling snow and drifts on bubbles, bars and the window. */
  snow: boolean;
};
const KEY = 'linea.chat-preferences.v1';
const DEFAULTS: ChatPreferences = { textSize: 'medium', sendTyping: true, animations: 'auto', lowBattery: 0.25, bubbleRadius: 20, wallpaper: 'none', nightMode: null, nightFrom: '22:00', nightTo: '07:00', nightBrightness: 0.25, nightForced: null, nightForcedAt: null, autoplayVideo: true, autoplayGif: true, animatedStickers: true, animatedEmoji: true, pixelTrail: true, snow: true };

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
      // 0 (never), 1 (always) or a level 0.05..0.95; the older stepped values are kept as they are.
      lowBattery: typeof value?.lowBattery === 'number' && value.lowBattery >= 0 && value.lowBattery <= 1 ? Math.round(value.lowBattery * 100) / 100 : DEFAULTS.lowBattery,
      bubbleRadius: [8, 14, 20].includes(value?.bubbleRadius) ? value.bubbleRadius : DEFAULTS.bubbleRadius,
      wallpaper: WALLPAPERS.some(item => item.id === value?.wallpaper) ? value.wallpaper : DEFAULTS.wallpaper,
      nightMode: ['system', 'off', 'schedule', 'auto'].includes(value?.nightMode) ? value.nightMode : null,
      nightFrom: typeof value?.nightFrom === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.nightFrom) ? value.nightFrom : DEFAULTS.nightFrom,
      nightTo: typeof value?.nightTo === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.nightTo) ? value.nightTo : DEFAULTS.nightTo,
      nightBrightness: typeof value?.nightBrightness === 'number' && value.nightBrightness > 0 && value.nightBrightness < 1 ? value.nightBrightness : DEFAULTS.nightBrightness,
      nightForced: typeof value?.nightForced === 'boolean' ? value.nightForced : null,
      nightForcedAt: typeof value?.nightForcedAt === 'boolean' ? value.nightForcedAt : null,
      autoplayVideo: typeof value?.autoplayVideo === 'boolean' ? value.autoplayVideo : true,
      autoplayGif: typeof value?.autoplayGif === 'boolean' ? value.autoplayGif : true,
      animatedStickers: typeof value?.animatedStickers === 'boolean' ? value.animatedStickers : true,
      animatedEmoji: typeof value?.animatedEmoji === 'boolean' ? value.animatedEmoji : true,
      pixelTrail: typeof value?.pixelTrail === 'boolean' ? value.pixelTrail : DEFAULTS.pixelTrail,
      snow: typeof value?.snow === 'boolean' ? value.snow : DEFAULTS.snow,
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
