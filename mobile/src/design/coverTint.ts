// The colours of the light under the tab bar while music plays: three colours taken from the track's cover,
// left to right. Worked out once per track on the device and remembered; a track without a cover (or a cover
// that cannot be read) has none and the bar keeps its calm light.
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image as ExpoImage } from 'expo-image';
import { vividTint } from './avatarTint';

export type Glow = [string, string, string];
const KEY = 'linea.cover-tint.v1', LIMIT = 200;
const known = new Map<string, Glow | null>();
const busy = new Set<string>(), failed = new Set<string>(), listeners = new Set<() => void>();
let version = 0, loaded = false, saveTimer: ReturnType<typeof setTimeout> | undefined;
const changed = () => { version++; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const isColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

void AsyncStorage.getItem(KEY).then(text => {
  try { for (const [id, glow] of Object.entries(JSON.parse(text || '{}') as Record<string, unknown>)) if (!known.has(id)) known.set(id, Array.isArray(glow) && glow.length === 3 && glow.every(isColor) ? glow as Glow : null); } catch { /* start empty */ }
  loaded = true; changed();
}).catch(() => { loaded = true; changed(); });

function remember(id: string, glow: Glow | null) {
  known.set(id, glow);
  if (known.size > LIMIT) known.delete(known.keys().next().value as string);
  changed();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void AsyncStorage.setItem(KEY, JSON.stringify(Object.fromEntries(known))).catch(() => {}); }, 1500);
}

const BASE83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
const decode83 = (text: string) => { let value = 0; for (const char of text) { const digit = BASE83.indexOf(char); if (digit < 0) return -1; value = value * 83 + digit; } return value; };
const toLinear = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const toSrgb = (v: number) => { const x = Math.max(0, Math.min(1, v)); return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255); };
const signedSquare = (v: number) => Math.sign(v) * v * v;

/**
 * The colours of a blurhash with one row of components, read at `count` evenly spaced places from left to right
 * (the blurhash format: an average colour plus cosine terms, summed in linear light).
 */
export function blurhashRow(hash: string, count: number): [number, number, number][] | null {
  if (hash.length < 6) return null;
  const size = decode83(hash[0]); if (size < 0) return null;
  const nx = size % 9 + 1, ny = Math.floor(size / 9) + 1;
  if (ny !== 1 || hash.length !== 4 + 2 * nx) return null;
  const quant = decode83(hash[1]), dc = decode83(hash.slice(2, 6)); if (quant < 0 || dc < 0) return null;
  const max = (quant + 1) / 166;
  const terms: [number, number, number][] = [[toLinear((dc >> 16) & 255), toLinear((dc >> 8) & 255), toLinear(dc & 255)]];
  for (let i = 1; i < nx; i++) {
    const value = decode83(hash.slice(4 + i * 2, 6 + i * 2)); if (value < 0) return null;
    terms.push([signedSquare((Math.floor(value / 361) - 9) / 9) * max, signedSquare((Math.floor(value / 19) % 19 - 9) / 9) * max, signedSquare((value % 19 - 9) / 9) * max]);
  }
  return Array.from({ length: count }, (_, place) => {
    const x = (place + 0.5) / count; let r = 0, g = 0, b = 0;
    terms.forEach((term, i) => { const basis = Math.cos(Math.PI * i * x); r += term[0] * basis; g += term[1] * basis; b += term[2] * basis; });
    return [toSrgb(r), toSrgb(g), toSrgb(b)] as [number, number, number];
  });
}

/** Three cover colours as lights; a cover with no colour of its own (black and white) gives null. */
export function glowOf(colors: [number, number, number][]): Glow | null {
  const vivid = colors.map(vividTint);
  const first = vivid.find(Boolean); if (!first || vivid.length !== 3) return null;
  return vivid.map(color => color || first) as Glow;
}

async function onWeb(url: string): Promise<[number, number, number][] | null> {
  const picture = new Image(); picture.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => { picture.onload = () => resolve(); picture.onerror = () => reject(new Error('cover')); picture.src = url; });
  const canvas = document.createElement('canvas'); canvas.width = 3; canvas.height = 1;
  const context = canvas.getContext('2d'); if (!context) return null;
  context.drawImage(picture, 0, 0, 3, 1);
  const data = context.getImageData(0, 0, 3, 1).data;
  return [0, 1, 2].map(i => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]] as [number, number, number]);
}
async function onPhone(url: string): Promise<[number, number, number][] | null> {
  const picture = await ExpoImage.loadAsync({ uri: url });
  try { const hash = await ExpoImage.generateBlurhashAsync(picture, [3, 1]); return hash ? blurhashRow(hash, 3) : null; }
  finally { try { (picture as { release?: () => void }).release?.(); } catch { /* released */ } }
}

type Cover = { id: string; artworkUrl?: string | null } | null | undefined;
/** The cover's three colours, or null while unknown / when there is no cover; starts the one-time work when needed. */
export function coverGlow(track: Cover): Glow | null {
  if (!track?.artworkUrl || !/^https:\/\//i.test(track.artworkUrl)) return null;
  const id = track.id, found = known.get(id);
  if (found !== undefined) return found;
  if (loaded && !busy.has(id) && !failed.has(id)) {
    busy.add(id);
    void (Platform.OS === 'web' ? onWeb(track.artworkUrl) : onPhone(track.artworkUrl))
      .then(colors => remember(id, colors ? glowOf(colors) : null))
      .catch(() => { failed.add(id); })
      .finally(() => { busy.delete(id); });
  }
  return null;
}
/** Re-renders the caller when a cover's colours become known; read them with `coverGlow`. */
export const useCoverTints = () => useSyncExternalStore(subscribe, () => version, () => version);
