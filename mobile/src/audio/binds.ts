// PC key binds: mute, deafen (also while a game is in front, via Electron) and рация (hold a key
// to talk — inside Инвиз). Assigned in Настройки → Звук и микрофон.
import { Platform } from 'react-native';
import { desktopBridge } from '../desktop';
import { audioPrefs, comboOf, subscribeAudio } from './devices';
import { setPushToTalk } from './gate';

type Action = 'mute' | 'deafen';
const handlers = new Set<(action: Action) => void>();
export function onBindAction(handler: (action: Action) => void) { handlers.add(handler); return () => { handlers.delete(handler); }; }
const emit = (action: Action) => handlers.forEach(h => { try { h(action); } catch { /* one listener must not stop the rest */ } });

let started = false;
/** While a bind is being assigned in settings, keys go there instead of acting. */
export let capturing = false;
export const setCapturing = (value: boolean) => { capturing = value; if (value) setPushToTalk(false); };
const lastKey = (combo: string) => combo.split('+').pop() || '';

export function startBinds() {
  if (started || Platform.OS !== 'web' || typeof window === 'undefined') return;
  started = true;
  const global = desktopBridge()?.shortcuts;
  const sync = () => {
    const { mute, deafen } = audioPrefs().binds;
    // With global keys registered, the same keys inside the window come from there (no double toggle).
    void global?.set({ mute, deafen }).then(ok => { globalOk = ok; }).catch(() => { globalOk = {}; });
  };
  let globalOk: Record<string, boolean> = {};
  if (global) { sync(); subscribeAudio(sync); global.onAction(action => emit(action as Action)); }
  window.addEventListener('keydown', event => {
    if (capturing) return;
    const combo = comboOf(event); if (!combo) return;
    const { binds } = audioPrefs();
    if (binds.ptt && combo === binds.ptt) { if (!event.repeat) setPushToTalk(true); event.preventDefault(); return; }
    for (const action of ['mute', 'deafen'] as const) if (binds[action] && combo === binds[action]) { event.preventDefault(); if (!globalOk[action] && !event.repeat) emit(action); return; }
  }, true);
  window.addEventListener('keyup', event => { const { ptt } = audioPrefs().binds; if (ptt && event.code === lastKey(ptt)) setPushToTalk(false); }, true);
  window.addEventListener('blur', () => setPushToTalk(false));
}
