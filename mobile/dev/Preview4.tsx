// Dev-only: equalizer screen preview (react-native-web). Not part of the app.
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeContext, palette } from '../src/theme';
import { MusicProvider } from '../src/music/MusicProvider';
import { EqualizerScreen } from '../src/music/EqualizerScreen';
import { setEqProfile } from '../src/music/equalizer';
setEqProfile('speaker', { mode: 'custom', low: 6, mid: -6, high: 6 });
export default function Preview() {
  return <SafeAreaProvider><ThemeContext.Provider value={palette.dark}><MusicProvider><EqualizerScreen visible onClose={() => {}} /></MusicProvider></ThemeContext.Provider></SafeAreaProvider>;
}
