// PC version: which microphone and which speakers/headphones Инвиз uses (calls, voice channels,
// voice messages). '' = follow the system default. Phones route audio themselves (Bluetooth,
// wired headset, earpiece/speaker toggle in a call).
export type AudioPrefs = {
  input: string; output: string;
  /** Browser noise suppression on the microphone (on/off, nothing else is processed). */
  noiseSuppression: boolean;
  /** Echo cancellation: off by default (the sound goes as the PC gives it); turn on for speakers. */
  echoCancellation: boolean;
  /** always · activity (opens above `threshold`, dBFS -100…0) · ptt (рация: speak while a key is held). */
  inputMode: InputMode; threshold: number;
  /** Key combos (KeyboardEvent.code with modifiers, e.g. "Ctrl+Shift+KeyM"); '' = not set. */
  binds: Binds;
};
export type InputMode = 'always' | 'activity' | 'ptt';
export type BindAction = 'mute' | 'deafen' | 'ptt';
export type Binds = Record<BindAction, string>;
/** Short release delay so the last syllable is not cut when the key is let go (as in Discord). */
export const PTT_RELEASE_MS = 200;
export type AudioDevice = { id: string; label: string };

const KEY = 'invizent.audio.v1';
const listeners = new Set<() => void>();
const sinks = new Set<HTMLMediaElement>();
const DEFAULTS: AudioPrefs = { input: '', output: '', noiseSuppression: true, echoCancellation: false, inputMode: 'activity', threshold: -50, binds: { mute: 'Ctrl+Shift+KeyM', deafen: 'Ctrl+Shift+KeyD', ptt: '' } };
const BIND = /^((Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z0-9]{1,20}$/;
let prefs: AudioPrefs = DEFAULTS;
try {
  const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) || 'null');
  if (saved && typeof saved === 'object') prefs = {
    input: typeof saved.input === 'string' ? saved.input : '', output: typeof saved.output === 'string' ? saved.output : '',
    noiseSuppression: typeof saved.noiseSuppression === 'boolean' ? saved.noiseSuppression : DEFAULTS.noiseSuppression,
    echoCancellation: typeof saved.echoCancellation === 'boolean' ? saved.echoCancellation : DEFAULTS.echoCancellation,
    inputMode: ['always', 'activity', 'ptt'].includes(saved.inputMode) ? saved.inputMode : saved.activation === false ? 'always' : DEFAULTS.inputMode,
    binds: Object.fromEntries((['mute', 'deafen', 'ptt'] as const).map(k => [k, typeof saved.binds?.[k] === 'string' && (saved.binds[k] === '' || BIND.test(saved.binds[k])) ? saved.binds[k] : DEFAULTS.binds[k]])) as Binds,
    threshold: Number.isFinite(saved.threshold) ? Math.max(-100, Math.min(0, saved.threshold)) : DEFAULTS.threshold,
  };
} catch { /* defaults */ }

export const audioPrefs = () => prefs;
export function setAudioPrefs(next: Partial<AudioPrefs>) {
  prefs = { ...prefs, ...next };
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs)); } catch { /* not saved */ }
  for (const el of sinks) void applySink(el);
  for (const l of listeners) l();
}
export function subscribeAudio(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Microphone request with the chosen device; `ideal` so an unplugged mic falls back to the default. */
export function micConstraint(base: boolean | MediaTrackConstraints = true): boolean | MediaTrackConstraints {
  if (!base) return base;
  // The sound goes as the PC gives it: no automatic gain; only what the person switched on.
  return { ...(typeof base === 'object' ? base : {}), ...(prefs.input ? { deviceId: { ideal: prefs.input } } : {}),
    noiseSuppression: prefs.noiseSuppression, echoCancellation: prefs.echoCancellation, autoGainControl: false };
}

/** Every element that plays other people's voices follows the chosen output. */
export async function applySink(el: HTMLMediaElement) {
  sinks.add(el);
  const setSinkId = (el as any).setSinkId;
  if (typeof setSinkId !== 'function') return;
  try { await setSinkId.call(el, prefs.output || ''); } catch { try { await setSinkId.call(el, ''); } catch { /* keep default */ } }
}
export function releaseSink(el: HTMLMediaElement) { sinks.delete(el); }

export async function listAudioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[]; named: boolean }> {
  const all = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind: MediaDeviceKind) => all.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Микрофон' : 'Устройство вывода'} ${i + 1}` }));
  // Browsers hide device names until the microphone was allowed once.
  return { inputs: pick('audioinput'), outputs: pick('audiooutput'), named: all.some(d => !!d.label) };
}

/** "Ctrl+Shift+KeyM" for a key press (modifier keys alone are not a bind). */
export function comboOf(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (!e.code || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) return null;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', e.code].filter(Boolean).join('+');
}
/** Readable label: "Ctrl+Shift+M", "Пробел", "Мышь 4"… */
export function comboLabel(combo: string): string {
  if (!combo) return 'Не назначено';
  return combo.split('+').map(part => part === 'Space' ? 'Пробел' : part.startsWith('Key') ? part.slice(3) : part.startsWith('Digit') ? part.slice(5) : part === 'Backquote' ? 'Ё' : part).join('+');
}
