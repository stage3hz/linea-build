import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeContext, palette } from '../src/theme';
import { GlassStage } from '../src/glass';
import { Api } from '../src/api';
import { ChatSearch } from '../src/ChatSearch';
const u = (id: string, displayName: string, username: string) => ({ id, displayName, username, avatarId: null } as any);
const store: any = { chats: [{ id: 'c1', peer: u('u1', 'hillroi', 'hillroi') }], selectChat() {} };
export default function Preview() {
  const api = new Api('https://example.invalid', 'token');
  return <GestureHandlerRootView style={{ flex: 1 }}><KeyboardProvider><SafeAreaProvider><ThemeContext.Provider value={palette.dark}><GlassStage>
    <ChatSearch api={api} me={u('me', 'Я', 'me')} store={store} onClose={() => {}} onSaved={() => {}} />
  </GlassStage></ThemeContext.Provider></SafeAreaProvider></KeyboardProvider></GestureHandlerRootView>;
}
