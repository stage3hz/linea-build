// The call as the phone itself shows it (modules/linea-call):
// - iOS: CallKit reports the call (an outgoing call, and an incoming one once it is answered in the app), so iOS shows
//   the green call pill / Dynamic Island indicator with the duration while the app is in the background, and the
//   call can be ended or muted from there. No PushKit and no 'voip' background mode: CallKit is only used for a
//   call that is already running in the app, which needs neither. Recents are off (the call never reaches the
//   system call log or iCloud).
// - Android: an ongoing-call foreground service (type microphone) with a notification «Имя · Звонок · 0:42» and
//   «Завершить»; it also keeps the microphone working while the app is in the background (Android 11+ silences a
//   background microphone without one). A tap opens the call.
// Everything is optional: a build without the module, a refused CallKit request or a foreground service the system
// does not allow leave the call exactly as it was before (it runs in the app, without the system indicator).
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { tr } from '../i18n';

type Subscription = { remove(): void };
type NativeCall = {
  supported(): boolean;
  /** iOS: CXStartCallAction; Android: starts the foreground service. Resolves false when the system refused it. */
  start(id: string, name: string, video: boolean, text: string, endLabel: string, channelName: string): Promise<boolean>;
  /** iOS: reports «connected» once (`connectedAt` > 0); Android: updates the notification text and chronometer. */
  update(id: string, text: string, connectedAt: number): Promise<void>;
  setMuted(id: string, muted: boolean): Promise<void>;
  end(id: string): Promise<void>;
  addListener(event: 'end' | 'mute' | 'audio' | 'open', listener: (event: { id?: string; muted?: boolean; active?: boolean }) => void): Subscription;
};

const native = Platform.OS === 'ios' || Platform.OS === 'android' ? (() => { try { return requireOptionalNativeModule<NativeCall>('LineaCall'); } catch { return null; } })() : null;
const available = (() => { try { return !!native?.supported(); } catch { return false; } })();

// ---- iOS: WebRTC audio waits for CallKit -------------------------------------------------------------------------
// CallKit activates the audio session itself (didActivate). Until then the WebRTC audio engine is held
// (AudioDeviceModule.setEngineAvailability(none), LiveKit's form of RTCAudioSession.useManualAudio/isAudioEnabled);
// on didActivate WebRTC is told the session is active and the engine is released. If didActivate never comes, the
// engine is released anyway after AUDIO_FALLBACK_MS, so a CallKit problem can delay the audio, never silence it.
const AUDIO_FALLBACK_MS = 2500;
type Rtc = { AudioDeviceModule?: { setEngineAvailability(a: { isInputAvailable: boolean; isOutputAvailable: boolean }): Promise<void> }; RTCAudioSession?: { audioSessionDidActivate(): void; audioSessionDidDeactivate(): void } };
const rtc = (): Rtc | null => { try { return require('react-native-webrtc'); } catch { return null; } };
let held = false; let fallback: ReturnType<typeof setTimeout> | undefined;
async function holdAudio(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const adm = rtc()?.AudioDeviceModule; if (!adm?.setEngineAvailability) return;
  try { await adm.setEngineAvailability({ isInputAvailable: false, isOutputAvailable: false }); held = true; } catch { held = false; return; }
  if (fallback) clearTimeout(fallback);
  fallback = setTimeout(() => { void releaseAudio(); }, AUDIO_FALLBACK_MS);
}
async function releaseAudio(): Promise<void> {
  if (fallback) { clearTimeout(fallback); fallback = undefined; }
  if (!held) return; held = false;
  try { await rtc()?.AudioDeviceModule?.setEngineAvailability({ isInputAvailable: true, isOutputAvailable: true }); } catch { /* the engine keeps its last state */ }
}

let current: string | null = null;
let latest: { text: string; connectedAt: number } = { text: '', connectedAt: 0 };
let subscriptions: Subscription[] = [];
type Handlers = { onEnd: (id: string) => void; onMute: (id: string, muted: boolean) => void; onOpen: () => void };
let handlers: Handlers | null = null;

function listen() {
  if (!native || subscriptions.length) return;
  try {
    subscriptions = [
      native.addListener('end', e => { if (e.id && e.id === current) { current = null; void releaseAudio(); handlers?.onEnd(e.id); } }),
      native.addListener('mute', e => { if (e.id && e.id === current && typeof e.muted === 'boolean') handlers?.onMute(e.id, e.muted); }),
      native.addListener('open', () => handlers?.onOpen()),
      native.addListener('audio', e => {
        const session = rtc()?.RTCAudioSession;
        try { if (e.active) session?.audioSessionDidActivate(); else session?.audioSessionDidDeactivate(); } catch { /* older WebRTC */ }
        if (e.active) void releaseAudio();
      }),
    ];
  } catch { subscriptions = []; }
}

/** CallProvider registers what the system UI may do to the call (end it, mute it, open it). */
export function setSystemCallHandlers(next: Handlers | null): () => void {
  handlers = next; if (next) listen();
  return () => { if (handlers === next) handlers = null; };
}

export const systemCallAvailable = () => available;

/** The call is running in the app: show it to the phone. Never throws; false means the system indicator is not shown. */
export async function beginSystemCall(id: string, name: string, video: boolean, text: string): Promise<boolean> {
  if (!native || !available) return false;
  if (current === id) return true; // already shown (or being started)
  if (current && current !== id) await endSystemCall(current);
  listen(); current = id; latest = { text, connectedAt: 0 };
  await holdAudio();
  // The call may have ended while the audio engine was being held: start nothing.
  if (current !== id) { await releaseAudio(); return false; }
  let ok = false;
  try { ok = await native.start(id, name || tr('Собеседник'), video, tr(text), tr('Завершить звонок'), tr('Текущий звонок')); } catch { ok = false; }
  if (!ok) { if (current === id) { current = null; await releaseAudio(); } return false; }
  // Ended while the system was starting it: end it there too.
  if (current !== id) { native.end(id).catch(() => {}); return false; }
  // A status change that came in while it was starting.
  if (latest.text !== text || latest.connectedAt) native.update(id, tr(latest.text), latest.connectedAt).catch(() => {});
  return true;
}

/** Status text and duration (connectedAt: ms since epoch when the media connected, 0 before). */
export function updateSystemCall(id: string, text: string, connectedAt: number | null): void {
  if (!native || current !== id) return;
  latest = { text, connectedAt: connectedAt || 0 };
  native.update(id, tr(text), connectedAt || 0).catch(() => {});
}

export function setSystemCallMuted(id: string, muted: boolean): void {
  if (!native || current !== id) return;
  native.setMuted(id, muted).catch(() => {});
}

export async function endSystemCall(id: string): Promise<void> {
  if (!native || current !== id) return;
  current = null;
  await releaseAudio();
  try { await native.end(id); } catch { /* already gone */ }
}
