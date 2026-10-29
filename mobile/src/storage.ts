import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { DarkTheme, ThemeMode } from './types';
import { storedDarkTheme, storedThemeMode } from './themePreference';

const TOKEN_KEY = 'linea.session.v1';
const SERVER_KEY = 'linea.server.v1';
const THEME_KEY = 'linea.theme.v1';
const DARK_THEME_KEY = 'linea.dark-theme.v1';

export async function readToken(): Promise<string | null> {
  if (Platform.OS === 'web') return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(TOKEN_KEY);
  return SecureStore.getItemAsync(TOKEN_KEY);
}
export async function writeToken(token: string | null) {
  if (Platform.OS === 'web') {
    if (token) sessionStorage.setItem(TOKEN_KEY, token); else sessionStorage.removeItem(TOKEN_KEY);
    return;
  }
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}
export const readServer = () => AsyncStorage.getItem(SERVER_KEY);
export const writeServer = (url: string) => AsyncStorage.setItem(SERVER_KEY, url);
export const clearServer = () => AsyncStorage.removeItem(SERVER_KEY);
export async function readTheme(): Promise<ThemeMode> {
  return storedThemeMode(await AsyncStorage.getItem(THEME_KEY));
}
export async function readDarkTheme(): Promise<DarkTheme> {
  return storedDarkTheme(await AsyncStorage.getItem(DARK_THEME_KEY));
}
// Preserve the last user choice even when several async writes overlap. A failed
// write is reported to the caller; it does not prevent a later retry from saving.
let preferenceWrite: Promise<void> = Promise.resolve();
function writePreference(key: string, value: string) {
  const pending = preferenceWrite.catch(() => {}).then(() => AsyncStorage.setItem(key, value));
  preferenceWrite = pending;
  return pending;
}
export const writeTheme = (theme: ThemeMode) => writePreference(THEME_KEY, theme);
export const writeDarkTheme = (theme: DarkTheme) => writePreference(DARK_THEME_KEY, theme);

// Tokens are never persisted with non-secret preferences or in an URL.
export function isDevelopmentHttpAllowed() {
  return typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP === '1';
}
export function normalizeServer(input: string) {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Введи полный адрес, например https://chat.example.com'); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Нужен адрес сервера без пароля, пути и параметров.');
  }
  const host = url.hostname;
  const parts = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host.split('.').map(Number) : [];
  const ipv4 = parts.length === 4 && parts.every(part => part >= 0 && part <= 255);
  const privateIpv4 = ipv4 && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  const local = host === 'localhost' || host === '[::1]' || host.endsWith('.local') || privateIpv4;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && isDevelopmentHttpAllowed())) {
    throw new Error('Для защищённого подключения нужен адрес HTTPS.');
  }
  return url.origin;
}
