import type { DarkTheme, ThemeMode } from './types';
import { isPaletteId } from './themes/palettes';

export function storedThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'black' || isPaletteId(value) ? value : 'system';
}

export function storedDarkTheme(value: unknown): DarkTheme {
  return value === 'black' || isPaletteId(value) ? value : 'dark';
}

export function resolveTheme(mode: ThemeMode, darkTheme: DarkTheme, system: 'light' | 'dark' | 'unspecified' | null | undefined): Exclude<ThemeMode, 'system'> {
  return mode === 'system' ? system === 'dark' ? darkTheme : 'light' : mode;
}
