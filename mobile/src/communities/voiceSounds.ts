// Short chimes in voice channels: rising when someone (or you) joins, falling when someone leaves —
// nobody walks in silently. Our own synthesized sounds (assets/sounds/voice_*.wav). On the PC
// they play on the speakers/headphones chosen in Настройки → Звук и микрофон.
import { Platform } from 'react-native';
import { createAudioPlayer } from 'expo-audio';
import { Asset } from 'expo-asset';
import { applySink, releaseSink } from '../audio/devices';

const SOURCES = { join: require('../../assets/sounds/voice_join.wav'), leave: require('../../assets/sounds/voice_leave.wav') };
let lastAt = 0;

export function playVoiceSound(kind: keyof typeof SOURCES) {
  // Several people at once (a whole team joining): one chime, not a burst.
  const now = Date.now(); if (now - lastAt < 250) return; lastAt = now;
  try {
    if (Platform.OS === 'web') {
      const el = new Audio(Asset.fromModule(SOURCES[kind]).uri); el.volume = 0.6;
      void applySink(el).then(() => el.play()).catch(() => {});
      el.addEventListener('ended', () => releaseSink(el), { once: true });
      return;
    }
    const player = createAudioPlayer(SOURCES[kind]); player.volume = 0.6; player.play();
    setTimeout(() => { try { player.remove(); } catch { /* released */ } }, 1500);
  } catch { /* a missing sound never breaks the channel */ }
}
