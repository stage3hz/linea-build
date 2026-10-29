import type { DarkTheme, ThemeMode } from './types';

export function storedThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'black' ? value : 'system';
}

export function storedDarkTheme(value: unknown): DarkTheme {
  return value === 'black' ? 'black' : 'dark';
}

export function resolveTheme(mode: ThemeMode, darkTheme: DarkTheme, system: 'light' | 'dark' | 'unspecified' | null | undefined): Exclude<ThemeMode, 'system'> {
  return mode === 'system' ? system === 'dark' ? darkTheme : 'light' : mode;
}
