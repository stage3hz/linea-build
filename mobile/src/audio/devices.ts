// PC version: which microphone and which speakers/headphones Инвиз uses (calls, voice channels,
// voice messages). '' = follow the system default. Phones route audio themselves (Bluetooth,
// wired headset, earpiece/speaker toggle in a call).
export type AudioPrefs = {
  input: string; output: string;
  /** Browser noise suppression on the microphone (on/off, nothing else is processed). */
  noiseSuppression: boolean;
  /** Echo cancellation: off by default (the sound goes as the PC gives it); turn on for speakers. */
  echoCancellation: boolean;
  /** «Студийный звук (тест)»: EQ preset on the outgoing microphone in calls and voice rooms (PC only for now, studioSound.ts). */
  studioSound: boolean;
  /** always · activity (opens above `threshold`, dBFS -100…0) · ptt (рация: speak while a key is held). */
  inputMode: InputMode; threshold: number;
  /** Binds the person added themselves (none by default, like everything here — off until switched on). */
  binds: BindEntry[];
};
export type InputMode = 'always' | 'activity' | 'ptt';
/**
 * What a bind can do. Discord's set (Push to Talk, Push to Mute, Toggle Mute, Toggle Deafen,
 * Toggle VAD, Switch to / Disconnect from Voice Channel…) plus Инвиз's own.
 * `hold`: active while the keys are held (works inside Инвиз); otherwise a press (works globally).
 */
export const BIND_ACTIONS = {
  ptt: { label: 'Рация — говорить, пока зажато', hold: true },
  pushToMute: { label: 'Молчать, пока зажато', hold: true },
  mute: { label: 'Микрофон: выключить / включить', hold: false },
  deafen: { label: 'Звук собеседников: выключить / включить', hold: false },
  toggleVoiceMode: { label: 'Переключить «Голосом» ↔ «Рация»', hold: false },
  screenShare: { label: 'Демонстрация экрана: начать / остановить', hold: false },
  disconnect: { label: 'Выйти из голосового канала', hold: false },
  rejoin: { label: 'Вернуться в последний голосовой канал', hold: false },
  answerCall: { label: 'Принять входящий звонок', hold: false },
  endCall: { label: 'Отклонить / завершить звонок', hold: false },
  quickSwitcher: { label: 'Быстрый переход к чату', hold: false },
} as const;
export type BindAction = keyof typeof BIND_ACTIONS;
export type BindEntry = { id: string; action: BindAction; combo: string; enabled: boolean };
/** Short release delay so the last syllable is not cut when the key is let go (as in Discord). */
export const PTT_RELEASE_MS = 200;
export type AudioDevice = { id: string; label: string };

const KEY = 'invizent.audio.v1';
const listeners = new Set<() => void>();
const sinks = new Set<HTMLMediaElement>();
const DEFAULTS: AudioPrefs = { input: '', output: '', noiseSuppression: true, echoCancellation: false, studioSound: false, inputMode: 'activity', threshold: -50, binds: [] };
const BIND = /^((Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z0-9]{1,20}$/;
function validBind(b: any): b is BindEntry {
  return !!b && typeof b.id === 'string' && /^[a-z0-9]{1,16}$/.test(b.id) && Object.hasOwn(BIND_ACTIONS, b.action)
    && typeof b.combo === 'string' && (b.combo === '' || BIND.test(b.combo)) && typeof b.enabled === 'boolean';
}
let prefs: AudioPrefs = DEFAULTS;
function parsePrefs(saved: any): AudioPrefs | null {
  if (!saved || typeof saved !== 'object') return null;
  return {
    input: typeof saved.input === 'string' ? saved.input : '', output: typeof saved.output === 'string' ? saved.output : '',
    noiseSuppression: typeof saved.noiseSuppression === 'boolean' ? saved.noiseSuppression : DEFAULTS.noiseSuppression,
    echoCancellation: typeof saved.echoCancellation === 'boolean' ? saved.echoCancellation : DEFAULTS.echoCancellation,
    studioSound: typeof saved.studioSound === 'boolean' ? saved.studioSound : DEFAULTS.studioSound,
    inputMode: ['always', 'activity', 'ptt'].includes(saved.inputMode) ? saved.inputMode : saved.activation === false ? 'always' : DEFAULTS.inputMode,
    binds: Array.isArray(saved.binds) ? saved.binds.filter(validBind).slice(0, 50) : [],
    threshold: Number.isFinite(saved.threshold) ? Math.max(-100, Math.min(0, saved.threshold)) : DEFAULTS.threshold,
  };
}
// PC (Electron / browser): localStorage, read at once. Phones have none: the call switch «Шумоподавление»
// (Настройки › Уведомления и звуки › Звонки) is kept in AsyncStorage, loaded lazily (native module, absent in tests).
const webStorage = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
const asyncStorage = (): any => { try { return require('@react-native-async-storage/async-storage').default; } catch { return null; } };
let touched = false;
try {
  const storage = webStorage();
  if (storage) prefs = parsePrefs(JSON.parse(storage.getItem(KEY) || 'null')) || DEFAULTS;
  else void Promise.resolve(asyncStorage()?.getItem(KEY)).then((raw: string | null | undefined) => {
    const saved = raw ? parsePrefs(JSON.parse(raw)) : null;
    if (saved && !touched) { prefs = saved; for (const l of listeners) l(); }
  }).catch(() => { /* defaults */ });
} catch { /* defaults */ }

export const audioPrefs = () => prefs;
export function setAudioPrefs(next: Partial<AudioPrefs>) {
  prefs = { ...prefs, ...next }; touched = true;
  try {
    const storage = webStorage();
    if (storage) storage.setItem(KEY, JSON.stringify(prefs));
    else void Promise.resolve(asyncStorage()?.setItem(KEY, JSON.stringify(prefs))).catch(() => {});
  } catch { /* not saved */ }
  for (const el of sinks) void applySink(el);
  for (const l of listeners) l();
}
export function subscribeAudio(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/**
 * Microphone request with the chosen device; `ideal` so an unplugged mic falls back to the default.
 * The processing switches fill in only what the caller did not set itself (a call asks for its own, see callAudio).
 */
export function micConstraint(base: boolean | MediaTrackConstraints = true): boolean | MediaTrackConstraints {
  if (!base) return base;
  // The sound goes as the PC gives it: no automatic gain; only what the person switched on.
  return { noiseSuppression: prefs.noiseSuppression, echoCancellation: prefs.echoCancellation, autoGainControl: false,
    ...(typeof base === 'object' ? base : {}), ...(prefs.input ? { deviceId: { ideal: prefs.input } } : {}) };
}

/**
 * The microphone of a 1:1 call, on every platform: noise suppression as switched (on by default), echo
 * cancellation and automatic gain like Telegram. Phones always cancel echo (earpiece / loudspeaker; the native
 * WebRTC audio processing does NS/AEC/AGC); the PC keeps «Эхоподавление» from Настройки › Звук и микрофон.
 */
export function callAudio(phone: boolean): MediaTrackConstraints {
  return { noiseSuppression: prefs.noiseSuppression, echoCancellation: phone ? true : prefs.echoCancellation, autoGainControl: true };
}
/** What a live call re-acquires its microphone for when it changes. */
export const callAudioKey = (phone: boolean) => `${phone ? '' : prefs.input}|${prefs.noiseSuppression}|${phone ? true : prefs.echoCancellation}|${!phone && prefs.studioSound}`;

/** Every element that plays other people's voices follows the chosen output. */
export async function applySink(el: HTMLMediaElement) {
  sinks.add(el);
  const setSinkId = (el as any).setSinkId;
  if (typeof setSinkId !== 'function') return;
  try { await setSinkId.call(el, prefs.output || ''); } catch { try { await setSinkId.call(el, ''); } catch { /* keep default */ } }
}
export function releaseSink(el: HTMLMediaElement) { sinks.delete(el); }

/** Name of the Windows default device: Chromium lists it as «Default - Realtek…» / «По умолчанию - …». */
export function defaultName(label: string | undefined): string {
  return (label || '').replace(/^(Default|По умолчанию|Communications|Связь)\s*[-–—:]\s*/i, '').trim();
}

export async function listAudioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[]; named: boolean; defaultInput: string; defaultOutput: string }> {
  const all = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind: MediaDeviceKind) => all.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Микрофон' : 'Устройство вывода'} ${i + 1}` }));
  const def = (kind: MediaDeviceKind) => defaultName(all.find(d => d.kind === kind && d.deviceId === 'default')?.label);
  // Browsers hide device names until the microphone was allowed once.
  return { inputs: pick('audioinput'), outputs: pick('audiooutput'), named: all.some(d => !!d.label), defaultInput: def('audioinput'), defaultOutput: def('audiooutput') };
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
