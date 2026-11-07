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
