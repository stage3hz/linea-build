import { Platform } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { desktopBridge } from '../desktop';

/**
 * Our own call sounds (made for Invizent, no third-party audio): «Пульс» while the other side
 * rings, «Неон» for an incoming call. Seamless loops; only one plays at a time.
 */
const SOURCES = {
  // Two ringbacks, as on a phone line, both our own «Пульс»: a lower, slower and quieter one while the call is
  // still on its way (call_connecting.wav is call_outgoing.wav played at 0.8 of its speed), the usual one once
  // the other side's phone has it (the server says how far the call got: `call.reach`).
  connecting: require('../../assets/sounds/call_connecting.wav'),
  outgoing: require('../../assets/sounds/call_outgoing.wav'),
  incoming: require('../../assets/sounds/call_incoming.wav'),
};
let player: AudioPlayer | null = null;
let generation = 0;

export async function playCallSound(kind: keyof typeof SOURCES): Promise<void> {
  stopCallSound();
  // In a browser tab nothing rings (a page may not start sound by itself). The PC app does: its window allows
  // sound without a click (desktop/main.cjs), so a call rings there too — also with the window in the tray.
  if (Platform.OS === 'web' && !desktopBridge()) return;
  const mine = generation;
  try {
    // The incoming ringtone follows the silent switch on iPhone (vibration still rings); ringback always plays.
    if (Platform.OS !== 'web') await setAudioModeAsync({ playsInSilentMode: kind !== 'incoming', shouldPlayInBackground: true, interruptionMode: 'duckOthers' }).catch(() => {});
    // The call may have been answered or ended while the audio mode was being set.
    if (mine !== generation) return;
    const next = createAudioPlayer(SOURCES[kind]);
    next.loop = true; next.volume = kind === 'incoming' ? 1 : 0.7;
    player = next; next.play();
  } catch { player = null; }
}

export function stopCallSound(): void {
  generation++;
  const current = player; player = null;
  if (!current) return;
  try { current.pause(); current.remove(); } catch { /* already released */ }
}
