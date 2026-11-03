// PC key binds the person adds themselves (Настройки → Звук и микрофон → Горячие клавиши).
// None exist by default. Press actions work over other apps via Electron globalShortcut; hold
// actions (рация, молчать) via a system keyboard hook that runs only during a voice channel/call.
import { Platform } from 'react-native';
import { desktopBridge } from '../desktop';
import { audioPrefs, BIND_ACTIONS, comboOf, subscribeAudio, type BindAction, type BindEntry } from './devices';
import { setPushToMute, setPushToTalk } from './gate';

type PressAction = Exclude<BindAction, 'ptt' | 'pushToMute'>;
const handlers = new Set<(action: PressAction) => void>();
/** Listen for press actions (voice channel, calls, app navigation each take what is theirs). */
export function onBindAction(handler: (action: PressAction) => void) { handlers.add(handler); return () => { handlers.delete(handler); }; }
const emit = (action: PressAction) => handlers.forEach(h => { try { h(action); } catch { /* one listener must not stop the rest */ } });

let started = false;
// Voice channel or call in progress: only then may the system keyboard hook run.
let talking = 0; let syncHold = () => {};
/** Voice channels and calls say when they start/end (counted, both can overlap briefly). */
export function setVoiceActive(on: boolean) { talking = Math.max(0, talking + (on ? 1 : -1)); syncHold(); }
/** While a key is being recorded in settings, keys go there instead of acting. */
export let capturing = false;
export const setCapturing = (value: boolean) => { capturing = value; if (value) { setPushToTalk(false); setPushToMute(false); } };
const lastKey = (combo: string) => combo.split('+').pop() || '';
const active = (): BindEntry[] => audioPrefs().binds.filter(b => b.enabled && b.combo);

/** Pure (tested): which binds a key press triggers. */
export function bindsFor(binds: readonly BindEntry[], combo: string): BindEntry[] { return binds.filter(b => b.enabled && b.combo === combo); }

export function startBinds() {
  if (started || Platform.OS !== 'web' || typeof window === 'undefined') return;
  started = true;
  const global = desktopBridge()?.shortcuts;
  let globalIds = new Set<string>();
  const sync = () => {
    const press = active().filter(b => !BIND_ACTIONS[b.action].hold);
    void global?.set(Object.fromEntries(press.map(b => [b.id, b.combo])))
      .then(ok => { globalIds = new Set(Object.entries(ok).filter(([, v]) => v).map(([k]) => k)); }).catch(() => { globalIds = new Set(); });
  };
  if (global?.setHold && global.onHold) {
    syncHold = () => {
      const hold = (action: 'ptt' | 'pushToMute') => active().find(b => b.action === action)?.combo;
      void global.setHold!({ active: talking > 0, ptt: hold('ptt'), pushToMute: hold('pushToMute') }).catch(() => {});
    };
    subscribeAudio(syncHold);
    global.onHold((action, down) => { if (capturing) return; if (action === 'ptt') setPushToTalk(down); else setPushToMute(down); });
  }
  if (global) {
    sync(); subscribeAudio(sync);
    global.onAction(id => { const bind = active().find(b => b.id === id); if (bind && !BIND_ACTIONS[bind.action].hold) emit(bind.action as PressAction); });
  }
  window.addEventListener('keydown', event => {
    if (capturing) return;
    const combo = comboOf(event); if (!combo) return;
    const hits = bindsFor(audioPrefs().binds, combo); if (!hits.length) return;
    event.preventDefault();
    for (const bind of hits) {
      if (bind.action === 'ptt') { if (!event.repeat) setPushToTalk(true); }
      else if (bind.action === 'pushToMute') { if (!event.repeat) setPushToMute(true); }
      // A key registered globally arrives from there; do not toggle twice.
      else if (!event.repeat && !globalIds.has(bind.id)) emit(bind.action as PressAction);
    }
  }, true);
  window.addEventListener('keyup', event => {
    for (const bind of active()) {
      if (lastKey(bind.combo) !== event.code) continue;
      if (bind.action === 'ptt') setPushToTalk(false);
      if (bind.action === 'pushToMute') setPushToMute(false);
    }
  }, true);
  window.addEventListener('blur', () => { setPushToTalk(false); setPushToMute(false); });
}
