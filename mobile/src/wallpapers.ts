// Chat wallpapers: a preset gradient or the user's own picture, for all chats or one chat.
// Stored only on this device (pictures in the app's documents folder); never sent anywhere.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { WALLPAPERS, getChatPreferences } from './chatPreferences';

export type WallpaperChoice =
  | { kind: 'preset'; id: string }
  | { kind: 'image'; uri: string; blur: boolean; motion: boolean; dim: number };
type Store = { global: WallpaperChoice | null; chats: Record<string, WallpaperChoice> };

const KEY = 'linea.wallpapers.v1';
let state: Store = { global: null, chats: {} };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
let loaded: Promise<void> | null = null;

export function parseWallpapers(raw: string | null): Store {
  try {
    const value = raw ? JSON.parse(raw) : null;
    const valid = (item: any): WallpaperChoice | null => {
      if (item?.kind === 'preset' && typeof item.id === 'string' && WALLPAPERS.some(preset => preset.id === item.id)) return { kind: 'preset', id: item.id };
      if (item?.kind === 'image' && typeof item.uri === 'string' && item.uri.startsWith('file://')) return { kind: 'image', uri: item.uri, blur: item.blur === true, motion: item.motion === true, dim: [0, 0.2, 0.4, 0.6].includes(item.dim) ? item.dim : 0.2 };
      return null;
    };
    const chats: Record<string, WallpaperChoice> = {};
    for (const [id, item] of Object.entries(value?.chats || {})) { const choice = valid(item); if (choice && /^[0-9a-f-]{36}$/i.test(id)) chats[id] = choice; }
    return { global: valid(value?.global), chats };
  } catch { return { global: null, chats: {} }; }
}

function load() { if (!loaded) loaded = AsyncStorage.getItem(KEY).then(raw => { state = parseWallpapers(raw); emit(); }).catch(() => {}); return loaded; }
function save(next: Store) {
  const before = new Set(files(state)); state = next; emit();
  void AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
  // Delete pictures no wallpaper uses any more.
  const after = new Set(files(next));
  for (const uri of before) if (!after.has(uri)) void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}
const files = (store: Store) => [store.global, ...Object.values(store.chats)].flatMap(item => item?.kind === 'image' ? [item.uri] : []);

/** The wallpaper of a chat: its own, else the global one, else the preset from preferences. */
export function useWallpaper(chatId?: string): WallpaperChoice {
  void load();
  const store = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
  return (chatId && store.chats[chatId]) || store.global || { kind: 'preset', id: getChatPreferences().wallpaper };
}
export function chatHasOwnWallpaper(chatId: string) { return !!state.chats[chatId]; }

/** Copies a picked picture into the app's own folder (the gallery copy may disappear). */
export async function keepPicture(uri: string): Promise<string> {
  const dir = `${FileSystem.documentDirectory}wallpapers/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const target = `${dir}${Crypto.randomUUID()}.jpg`;
  await FileSystem.copyAsync({ from: uri, to: target });
  return target;
}

export function setWallpaper(choice: WallpaperChoice | null, chatId?: string) {
  void load().then(() => {
    if (chatId) { const chats = { ...state.chats }; if (choice) chats[chatId] = choice; else delete chats[chatId]; save({ ...state, chats }); }
    else save({ ...state, global: choice });
  });
}
