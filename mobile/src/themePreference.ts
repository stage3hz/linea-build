import type { DarkTheme, ThemeMode } from './types';
import { isPaletteId } from './themes/palettes';

export function storedThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'black' || value === 'graphite' || isPaletteId(value) ? value : 'system';
}

export function storedDarkTheme(value: unknown): DarkTheme {
  return value === 'black' || value === 'graphite' || isPaletteId(value) ? value : 'dark';
}

export function resolveTheme(mode: ThemeMode, darkTheme: DarkTheme, system: 'light' | 'dark' | 'unspecified' | null | undefined): Exclude<ThemeMode, 'system'> {
  return mode === 'system' ? system === 'dark' ? darkTheme : 'light' : mode;
}

/**
 * Palettes belong to Platina. Without it a saved palette is shown as the regular
 * dark theme; the saved choice itself is kept, so it comes back when Platina does.
 */
export function withPlatina<T extends ThemeMode | DarkTheme>(value: T, platina: boolean): T | 'dark' {
  return !platina && isPaletteId(value) ? 'dark' : value;
}

// ---- Night theme (Telegram «Ночная тема») ----
export type NightMode = 'system' | 'off' | 'schedule' | 'auto';
export type NightSettings = { mode: NightMode | null; from: string; to: string; brightness: number };

/** Minutes since midnight of «HH:MM». */
const minutes = (value: string) => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };

/** True inside the window from `from` to `to` (it may cross midnight, e.g. 22:00–07:00). */
export function inNightWindow(from: string, to: string, now: Date): boolean {
  const a = minutes(from), b = minutes(to), x = now.getHours() * 60 + now.getMinutes();
  if (a === b) return false;
  return a < b ? x >= a && x < b : x >= a || x < b;
}

/** Screen brightness can be read on the phone only (expo-brightness has no web implementation). */
export const brightnessAvailable = (platform: string): boolean => platform !== 'web';

/** The night modes a platform can offer: «Автоматически» (by brightness) only where brightness is readable. */
export const nightModesFor = (platform: string): NightMode[] => brightnessAvailable(platform) ? ['system', 'off', 'schedule', 'auto'] : ['system', 'off', 'schedule'];

/**
 * The mode in effect: before night settings existed, «Как в системе» meant following the system.
 * «Автоматически» saved where brightness cannot be read (the PC) falls back to following the system.
 */
export const effectiveNightMode = (night: NightSettings, mode: ThemeMode, platform = 'ios'): NightMode => {
  const kind = night.mode ?? (mode === 'system' ? 'system' : 'off');
  return kind === 'auto' && !brightnessAvailable(platform) ? 'system' : kind;
};

/** Should the night theme be on right now by the automatic rule (no manual switch taken into account)? */
export function autoNight(night: NightSettings, mode: ThemeMode, system: 'light' | 'dark' | 'unspecified' | null | undefined, now: Date, screenBrightness: number | null, platform = 'ios'): boolean {
  const kind = effectiveNightMode(night, mode, platform);
  if (kind === 'system') return system === 'dark';
  if (kind === 'schedule') return inNightWindow(night.from, night.to, now);
  if (kind === 'auto') return screenBrightness !== null && screenBrightness <= night.brightness;
  return false;
}

/**
 * The manual «Ночной режим» switch (`forced`, taken when the rule said `forcedAt`) holds until the
 * automatic rule changes by itself. `auto` is null while the rule has no input yet (the brightness is
 * not read on the first frame): an unknown value must not count as a change.
 */
export function manualNightExpired(forced: boolean | null, forcedAt: boolean | null, auto: boolean | null): boolean {
  return forced !== null && forcedAt !== null && auto !== null && auto !== forcedAt;
}

/** The theme to show: the night theme at night, otherwise the chosen (day) theme. */
export function themeFor(mode: ThemeMode, darkTheme: DarkTheme, night: boolean): Exclude<ThemeMode, 'system'> {
  return night ? darkTheme : mode === 'system' ? 'light' : mode;
}

export const isDarkTheme = (value: ThemeMode): value is DarkTheme => value !== 'system' && value !== 'light';

/**
 * A tap on a theme card in «Оформление» (Telegram): the tapped theme is what the screen shows next.
 * At night a dark card becomes the night theme (the day choice is kept for the morning); «Светлая»
 * turns the night mode off by hand, as the «Ночной режим» switch would. By day the card is the day theme.
 */
export function themeTapPlan(value: ThemeMode, night: boolean): { mode?: ThemeMode; darkTheme?: DarkTheme; nightOff: boolean } {
  if (!night) return { mode: value, nightOff: false };
  return isDarkTheme(value) ? { darkTheme: value, nightOff: false } : { mode: value, nightOff: true };
}
