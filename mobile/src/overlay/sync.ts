// Feeds the PC overlay window: voice channel members, who speaks, who is muted. Sends only when
// something changed (at most ~8 times a second), and nothing at all while the overlay is off.
import { Platform } from 'react-native';
import { desktopBridge } from '../desktop';
import { overlayPrefs, overlayView, subscribeOverlay, type OverlayPerson } from './prefs';
import { speakingNow, unwatchAll, watchVoice } from './speaking';

type VoiceLike = { channelName: string; muted: boolean; deafened?: boolean; status: string; peers: { peer: string; userId: string; muted: boolean }[] } | null;
let getVoice: () => VoiceLike = () => null;
let names: Record<string, string> = {}; let myName = 'Ты';
let timer: ReturnType<typeof setInterval> | null = null; let last = '';
let reattach: () => void = () => {};

export function setOverlayNames(next: Record<string, string>) { names = { ...names, ...next }; }
export function setOverlaySelf(name: string) { myName = name || 'Ты'; }

/** voice.ts registers how to read its state and its tracks. */
export function connectOverlay(read: () => VoiceLike, attachAll: () => void) {
  getVoice = read; reattach = attachAll;
  if (Platform.OS !== 'web' || !desktopBridge()?.overlay) return;
  subscribeOverlay(() => { void desktopBridge()!.overlay!.configure(overlayPrefs()).catch(() => {}); if (overlayWanted()) reattach(); overlayVoiceChanged(); tick(true); });
  void desktopBridge()!.overlay!.configure(overlayPrefs()).catch(() => {});
}
export const overlayWanted = () => Platform.OS === 'web' && !!desktopBridge()?.overlay && overlayPrefs().enabled;
export function overlayTrack(peer: string, track: MediaStreamTrack | null) { if (overlayWanted()) watchVoice(peer, track); }

function tick(force = false) {
  const voice = getVoice();
  const bridge = desktopBridge()?.overlay; if (!bridge) return;
  const speaking = voice && overlayPrefs().enabled ? speakingNow() : new Set<string>();
  const people: OverlayPerson[] = voice && voice.status === 'connected' ? [
    { name: myName, speaking: !voice.muted && speaking.has('me'), muted: voice.muted, deafened: voice.deafened, me: true },
    ...voice.peers.map(p => ({ name: names[p.userId] || 'Участник', speaking: speaking.has(p.peer), muted: p.muted })),
  ] : [];
  const view = overlayView(overlayPrefs(), voice && people.length ? { channelName: voice.channelName, people } : null);
  const json = JSON.stringify(view);
  if (!force && json === last) return;
  last = json; void bridge.update(view).catch(() => {});
}

/** Runs only while the overlay is on and you are in a channel. */
export function overlayVoiceChanged() {
  const on = overlayWanted() && !!getVoice();
  if (on && !timer) timer = setInterval(() => tick(), 125);
  if (!on && timer) { clearInterval(timer); timer = null; unwatchAll(); }
  tick();
}
