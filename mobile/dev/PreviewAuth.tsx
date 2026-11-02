// Dev-only: sign-in screen and palette picker in several themes (react-native-web). Not part of the app.
import React from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeContext, palette } from '../src/theme';
import { Api } from '../src/api';
import { AuthScreen } from '../src/AuthScreen';
import { AuthBackdrop } from '../src/auth/AuthBackdrop';
import { ThemeSettings } from '../src/ThemeSettings';

const api = new Api('https://preview.invalid');
const themes = ['dark', 'amethyst', 'coffee', 'lagoon'] as const;
export default function PreviewAuth() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><ScrollView horizontal contentContainerStyle={{ gap: 12, padding: 12, backgroundColor: '#222' }}>
    {themes.map(id => <ThemeContext.Provider key={id} value={palette[id]}><View style={{ width: 390, height: 844, overflow: 'hidden', borderRadius: 24, backgroundColor: palette[id].bg }}>
      <AuthBackdrop />
      <AuthScreen api={api} onLogin={async () => {}} onChangeServer={() => {}} />
    </View></ThemeContext.Provider>)}
    <ThemeContext.Provider value={palette.amethyst}><View style={{ width: 390, height: 844, borderRadius: 24, backgroundColor: palette.amethyst.bg, padding: 16 }}>
      <ThemeSettings mode="amethyst" darkTheme="dark" onChange={() => {}} onDarkTheme={() => {}} />
    </View></ThemeContext.Provider>
  </ScrollView></SafeAreaProvider></GestureHandlerRootView>;
}
