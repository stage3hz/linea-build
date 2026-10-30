// Dev-only visual check of Platina decoration and the tab bar (react-native-web). Not part of the app.
import React from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeContext, palette } from '../src/theme';
import { GlassStage } from '../src/glass';
import { Api } from '../src/api';
import { MessengerTabs } from '../src/ChatListScreen';
import { PlatinaStudio } from '../src/platina/PlatinaStudio';
import { DecoratedAvatar, FRAMES, ProfileBanner } from '../src/platina/Decor';
import type { User } from '../src/types';
import { MusicProvider } from '../src/music/MusicProvider';

const user: User = { id: 'u', username: 'stage', displayName: 'Stage', bio: '', avatarColor: '#4088C7', avatarId: null, createdAt: '', statusEmoji: '💎', statusEmojiExpiresAt: null, statusEmojiPermanent: true, avatarFrame: 'aurora', bannerPreset: 'glacier', avatarVideoId: null, bannerId: null, bannerKind: null };
export default function Preview() {
  const api = new Api('https://example.invalid', 'token');
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><ThemeContext.Provider value={palette.dark}><GlassStage><MusicProvider>
    <ScrollView contentContainerStyle={{ width: 390, gap: 18, paddingBottom: 30 }}>
      <View style={{ height: 160 }}><ProfileBanner user={user} api={api} height={160} width={390} /></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 22, padding: 20 }}>{FRAMES.map(f => <DecoratedAvatar key={f.id} user={{ ...user, avatarFrame: f.id }} api={api} size={60} animated />)}</View>
      <View style={{ padding: 16 }}><PlatinaStudio api={api} user={user} active onUser={() => {}} /></View>
      <MessengerTabs onProfile={() => {}} onNewChat={() => {}} onMusic={() => {}} onAI={() => {}} onChats={() => {}} activeTab="chats" />
    </ScrollView>
  </MusicProvider></GlassStage></ThemeContext.Provider></SafeAreaProvider></GestureHandlerRootView>;
}
