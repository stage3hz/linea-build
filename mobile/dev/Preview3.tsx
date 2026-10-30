// Dev-only visual check of channels (react-native-web, mocked API). Not part of the app.
import React from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeContext, palette } from '../src/theme';
import { GlassStage } from '../src/glass';
import { Api } from '../src/api';
import { MusicProvider } from '../src/music/MusicProvider';
import { CommunityScreen } from '../src/communities/CommunityScreen';
import { ChannelChat } from '../src/communities/ChannelChat';
import { InviteCard } from '../src/communities/InviteCard';

const u = (id: string, name: string, color: string) => ({ id, username: name.toLowerCase(), displayName: name, bio: '', avatarColor: color, avatarId: null, createdAt: '' });
const me = u('me', 'Stage', '#4088C7'), bob = u('bob', 'Ростикс', '#2EA37A'), eve = u('eve', 'Тим', '#B78358');
const roles = [{ id: 'r0', name: 'Участники', color: '#8A9BB8', position: 0, perms: 112, isDefault: true }, { id: 'r1', name: 'Модератор', color: '#3FA9F5', position: 10, perms: 512, isDefault: false }];
const community: any = { id: 'c1', kind: 'server', name: 'Клан Север', description: 'Катаем по вечерам', avatarId: null, ownerId: 'me', createdAt: '', memberCount: 14, isMember: true, perms: 1023, lastMessage: null, muted: false, roles, myRoleIds: [],
  channels: [
    { id: 't1', kind: 'text', name: 'общий', topic: '', category: 'Текстовые каналы', position: 0, roleIds: [], lastMessageId: 3 },
    { id: 't2', kind: 'text', name: 'штаб', topic: '', category: 'Текстовые каналы', position: 1, roleIds: ['r1'], lastMessageId: 0 },
    { id: 'v1', kind: 'voice', name: 'Общий', topic: '', category: 'Голосовые каналы', position: 0, roleIds: [], lastMessageId: 0, voice: [{ userId: 'bob', muted: false }, { userId: 'eve', muted: true }] },
    { id: 'v2', kind: 'voice', name: 'Игра', topic: '', category: 'Голосовые каналы', position: 1, roleIds: [], lastMessageId: 0, voice: [] },
  ] };
const at = (m: number) => new Date(Date.UTC(2026, 9, 30, 18, m)).toISOString();
class MockApi extends Api {
  community = async () => ({ community });
  communityMembers = async () => ({ members: [{ user: me, roleIds: [], owner: true, joinedAt: '' }, { user: bob, roleIds: ['r1'], owner: false, joinedAt: '' }, { user: eve, roleIds: [], owner: false, joinedAt: '' }] }) as any;
  channelMessages = async () => ({ messages: [
    { id: 1, channelId: 't1', senderId: 'bob', text: 'Кто сегодня в катку?', attachment: null, replyTo: null, createdAt: at(1), editedAt: null },
    { id: 2, channelId: 't1', senderId: 'bob', text: 'В 21:00 заходим в войс', attachment: null, replyTo: null, createdAt: at(2), editedAt: null },
    { id: 3, channelId: 't1', senderId: 'me', text: 'Я буду', attachment: null, replyTo: 1, createdAt: at(5), editedAt: null },
  ], users: [me, bob], hasMore: false });
  invite = async () => ({ code: 'Ab3dEf9hKm', community: { id: 'c1', kind: 'server' as const, name: 'Клан Север', description: '', avatarId: null, memberCount: 14 }, isMember: false });
  communityMe = async () => ({ community } as any);
}
const store: any = { onSocket: () => () => {}, sendSocket: () => true, chats: [], send: () => {} };
export default function Preview() {
  const api = new MockApi('https://example.invalid', 'token');
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><ThemeContext.Provider value={palette.dark}><GlassStage><MusicProvider>
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ width: 390, height: 760 }}><CommunityScreen api={api} me={me} store={store} communityId="c1" onBack={() => {}} onOpenInvite={() => {}} onLeft={() => {}} /></View>
      <View style={{ width: 390, height: 760 }}><ChannelChat api={api} me={me} store={store} community={community} channel={community.channels[0]} onOpenInvite={() => {}} /></View>
      <View style={{ width: 320, padding: 20 }}><InviteCard api={api} code="Ab3dEf9hKm" onOpen={() => {}} /></View>
    </View>
  </MusicProvider></GlassStage></ThemeContext.Provider></SafeAreaProvider></GestureHandlerRootView>;
}
