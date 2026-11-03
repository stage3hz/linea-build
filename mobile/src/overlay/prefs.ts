// In-game overlay (PC): off until the person switches it on in Настройки → Оверлей.
export type OverlayCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
export type OverlayPrefs = { enabled: boolean; corner: OverlayCorner; onlySpeaking: boolean; opacity: number };
const KEY = 'invizent.overlay.v1';
const DEFAULTS: OverlayPrefs = { enabled: false, corner: 'topLeft', onlySpeaking: false, opacity: 0.9 };
const CORNERS: OverlayCorner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
let prefs = DEFAULTS;
try {
  const v = JSON.parse(globalThis.localStorage?.getItem(KEY) || 'null');
  if (v && typeof v === 'object') prefs = {
    enabled: v.enabled === true, corner: CORNERS.includes(v.corner) ? v.corner : DEFAULTS.corner,
    onlySpeaking: v.onlySpeaking === true, opacity: Number.isFinite(v.opacity) ? Math.min(1, Math.max(0.3, v.opacity)) : DEFAULTS.opacity,
  };
} catch { /* defaults */ }
const listeners = new Set<() => void>();
export const overlayPrefs = () => prefs;
export function setOverlayPrefs(change: Partial<OverlayPrefs>) {
  prefs = { ...prefs, ...change };
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs)); } catch { /* not saved */ }
  listeners.forEach(l => l());
}
export function subscribeOverlay(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export type OverlayPerson = { name: string; speaking: boolean; muted: boolean; deafened?: boolean; me?: boolean };
export type OverlayView = { channel: string; people: OverlayPerson[] } | null;

/** Pure (tested): what the overlay shows. Nothing (null) when off or not in a voice channel. */
export function overlayView(p: OverlayPrefs, voice: { channelName: string; people: OverlayPerson[] } | null): OverlayView {
  if (!p.enabled || !voice) return null;
  const people = p.onlySpeaking ? voice.people.filter(x => x.speaking) : voice.people;
  return { channel: voice.channelName.slice(0, 60), people: people.slice(0, 12).map(x => ({ ...x, name: x.name.slice(0, 32) })) };
}
