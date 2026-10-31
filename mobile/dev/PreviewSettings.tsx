import React from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeContext, palette } from '../src/theme';
import { GlassStage } from '../src/glass';
import { Api } from '../src/api';
import { SettingsScreen } from '../src/SettingsScreen';
import { PlatinaShowcaseHost } from '../src/platina/PlatinaShowcase';
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const plat = params.get('p') === '1';
class FakeApi extends Api { usernameStatus = async () => ({ accountId: 'me', platina: { active: plat, expiresAt: '2027-01-15T00:00:00Z' } } as any); }
const user: any = { id: 'me', displayName: 'stage', username: 'stage', bio: '', avatarColor: '#5B7CFA', avatarId: null, createdAt: '', statusEmoji: '🌊', ...(plat ? { seal: 'platina', bannerPreset: 'deep' } : {}) };
export default function Preview() {
  const api = new FakeApi('https://example.invalid', 'token');
  const noop = () => {};
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><ThemeContext.Provider value={palette.dark}><GlassStage><View style={{ flex: 1, paddingTop: 50 }}>
    <SettingsScreen api={api} user={user} theme="dark" darkTheme="dark" onTheme={noop} onDarkTheme={noop} onBack={noop} onProfile={noop} onSecurity={noop} onMusic={noop} onLogout={async () => {}} />
    <PlatinaShowcaseHost api={api} me={user} onCustomize={noop} />
  </View></GlassStage></ThemeContext.Provider></SafeAreaProvider></GestureHandlerRootView>;
}
