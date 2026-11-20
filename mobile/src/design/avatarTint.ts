// The colour of a person's light. Someone with a photo glows in the colour of that photo (its average colour,
// made a little more vivid); someone without one glows in the colour they chose for their letter avatar.
// The picture's colour is worked out once per picture, on the device, and remembered: uploaded files never
// change, so the file id is a stable key.
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image as ExpoImage } from 'expo-image';
import type { Api } from '../api';
import { peerTint } from './peerLight';

const KEY = 'linea.avatar-tint.v1', LIMIT = 400, GREY = '';
const known = new Map<string, string>();
const busy = new Set<string>();
/** Pictures that could not be read in this run (no network, an unreadable format): not retried until the next start, never saved. */
const failed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0, loaded = false, saveTimer: ReturnType<typeof setTimeout> | undefined;
const changed = () => { version++; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

void AsyncStorage.getItem(KEY).then(text => {
  try { for (const [id, color] of Object.entries(JSON.parse(text || '{}') as Record<string, string>)) if (typeof color === 'string' && !known.has(id)) known.set(id, color); } catch { /* start empty */ }
  loaded = true; changed();
}).catch(() => { loaded = true; });

function remember(id: string, color: string) {
  known.set(id, color);
  if (known.size > LIMIT) known.delete(known.keys().next().value as string);
  changed();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void AsyncStorage.setItem(KEY, JSON.stringify(Object.fromEntries(known))).catch(() => {}); }, 1500);
}

const BASE83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
/** The average colour stored in a blurhash (its DC component, characters 2…5). */
export function blurhashAverage(hash: string): [number, number, number] | null {
  if (hash.length < 6) return null;
  let value = 0;
  for (const char of hash.slice(2, 6)) { const digit = BASE83.indexOf(char); if (digit < 0) return null; value = value * 83 + digit; }
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * A picture's average colour as a light: the hue is kept, the colour is made vivid enough to read as a glow
 * and neither too dark nor washed out. A picture with no colour of its own (black and white) gives '' and
 * the person's chosen colour is used instead.
 */
export function vividTint([r, g, b]: [number, number, number]): string {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2, d = max - min;
  if (d < 0.06) return GREY;
  const sat = d / (1 - Math.abs(2 * l - 1) || 1);
  const R = r / 255, G = g / 255, B = b / 255;
  const hue = max === R ? ((G - B) / d + 6) % 6 * 60 : max === G ? ((B - R) / d + 2) * 60 : ((R - G) / d + 4) * 60;
  const s = Math.min(0.85, Math.max(0.5, sat * 1.5)), light = Math.min(0.62, Math.max(0.46, l));
  const a = s * Math.min(light, 1 - light);
  const part = (n: number) => { const k = (n + hue / 30) % 12; return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return '#' + part(0) + part(8) + part(4);
}

async function averageOnWeb(api: Api, id: string): Promise<[number, number, number] | null> {
  const response = await fetch(api.fileUrl(id), { headers: { ...api.authHeaders } });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
  const context = canvas.getContext('2d'); if (!context) return null;
  context.drawImage(bitmap, 0, 0, 8, 8);
  const data = context.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  const count = data.length / 4;
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

async function averageOnPhone(api: Api, id: string): Promise<[number, number, number] | null> {
  const picture = await ExpoImage.loadAsync({ uri: api.fileUrl(id), headers: { ...api.authHeaders }, cacheKey: `invizent-file-${id}` } as any);
  try { const hash = await ExpoImage.generateBlurhashAsync(picture, [1, 1]); return hash ? blurhashAverage(hash) : null; }
  finally { try { (picture as { release?: () => void }).release?.(); } catch { /* released */ } }
}

function work(api: Api, id: string) {
  if (busy.has(id) || known.has(id) || failed.has(id) || !loaded) return;
  busy.add(id);
  void (Platform.OS === 'web' ? averageOnWeb(api, id) : averageOnPhone(api, id))
    .then(rgb => remember(id, rgb ? vividTint(rgb) : GREY))
    // No network or a format that cannot be read: asked again next time the app starts, not in a loop now.
    .catch(() => { failed.add(id); })
    .finally(() => { busy.delete(id); });
}

type Person = { avatarId?: string | null; avatarColor?: string | null };
/** The colour of this person's light right now; starts the one-time work on their picture when needed. */
export function tintOf(api: Api, person: Person, fallback = '#8A8F98'): string {
  const own = peerTint(person.avatarColor, fallback);
  if (!person.avatarId) return own;
  const found = known.get(person.avatarId);
  if (found === undefined) { work(api, person.avatarId); return own; }
  return found || own;
}
/** Re-renders the caller when a picture's colour becomes known; read colours with `tintOf`. */
export const useAvatarTints = () => useSyncExternalStore(subscribe, () => version, () => version);
