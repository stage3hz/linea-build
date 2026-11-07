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

/** The mode in effect: before night settings existed, «Как в системе» meant following the system. */
export const effectiveNightMode = (night: NightSettings, mode: ThemeMode): NightMode => night.mode ?? (mode === 'system' ? 'system' : 'off');

/** Should the night theme be on right now by the automatic rule (no manual switch taken into account)? */
export function autoNight(night: NightSettings, mode: ThemeMode, system: 'light' | 'dark' | 'unspecified' | null | undefined, now: Date, screenBrightness: number | null): boolean {
  const kind = effectiveNightMode(night, mode);
  if (kind === 'system') return system === 'dark';
  if (kind === 'schedule') return inNightWindow(night.from, night.to, now);
  if (kind === 'auto') return screenBrightness !== null && screenBrightness <= night.brightness;
  return false;
}

/** The theme to show: the night theme at night, otherwise the chosen (day) theme. */
export function themeFor(mode: ThemeMode, darkTheme: DarkTheme, night: boolean): Exclude<ThemeMode, 'system'> {
  return night ? darkTheme : mode === 'system' ? 'light' : mode;
}
