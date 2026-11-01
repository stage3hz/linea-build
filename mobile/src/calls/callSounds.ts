import { Platform } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

/**
 * Our own call sounds (made for Invizent, no third-party audio): «Пульс» while the other side
 * rings, «Неон» for an incoming call. Seamless loops; only one plays at a time.
 */
const SOURCES = {
  outgoing: require('../../assets/sounds/call_outgoing.wav'),
  incoming: require('../../assets/sounds/call_incoming.wav'),
};
let player: AudioPlayer | null = null;
let generation = 0;

export async function playCallSound(kind: keyof typeof SOURCES): Promise<void> {
  stopCallSound();
  if (Platform.OS === 'web') return;
  const mine = generation;
  try {
    // The incoming ringtone follows the silent switch on iPhone (vibration still rings); ringback always plays.
    await setAudioModeAsync({ playsInSilentMode: kind === 'outgoing', shouldPlayInBackground: true, interruptionMode: 'duckOthers' }).catch(() => {});
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
