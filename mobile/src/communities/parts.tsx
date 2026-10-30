import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { Api } from '../api';
import { AuthImage, Icon } from '../components';
import { Text } from '../typography';
import { useTheme } from '../theme';
import type { CommunityKind } from './types';

const PALETTE = [['#2C5BD6', '#1AA889'], ['#3FA9F5', '#0D3480'], ['#0B6450', '#2EE6C8'], ['#1B3B78', '#4F8CFF'], ['#0A4E8A', '#1593B8'], ['#16316A', '#7FC8E8']];
const hash = (value: string) => { let h = 0; for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0; return Math.abs(h); };

/** Community picture: the uploaded image, or a cold gradient with initials (rounded square, as in Discord). */
export function CommunityAvatar({ api, community, size = 48 }: { api: Api; community: { id: string; name: string; avatarId: string | null; kind: CommunityKind }; size?: number }) {
  const radius = size * 0.32;
  if (community.avatarId) return <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden' }}><AuthImage api={api} id={community.avatarId} style={{ width: size, height: size }} /></View>;
  const colors = PALETTE[hash(community.id) % PALETTE.length];
  const initials = community.name.trim().split(/\s+/).slice(0, 2).map(word => word[0] || '').join('').toUpperCase() || '#';
  return <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
    <LinearGradient colors={colors as [string, string]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
    <Text style={{ color: '#FFF', fontSize: size * 0.34, fontWeight: '700' }}>{initials}</Text>
    <View style={{ position: 'absolute', right: 2, bottom: 2, width: size * 0.3, height: size * 0.3, borderRadius: size * 0.15, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}><Icon name={community.kind === 'blog' ? 'megaphone' : 'game-controller'} size={size * 0.17} color="#FFF" /></View>
  </View>;
}

export function KindBadge({ kind }: { kind: CommunityKind }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: t.accentSoft }}>
    <Icon name={kind === 'blog' ? 'megaphone-outline' : 'game-controller-outline'} size={11} color={t.accent} />
    <Text style={{ color: t.accent, fontSize: 11, fontWeight: '700' }}>{kind === 'blog' ? 'Блог' : 'Сервер'}</Text>
  </View>;
}

export const members = (count: number) => {
  const mod10 = count % 10, mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'участник' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'участника' : 'участников';
  return `${count} ${word}`;
};
export const subscribers = (count: number) => {
  const mod10 = count % 10, mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'подписчик' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'подписчика' : 'подписчиков';
  return `${count} ${word}`;
};

export { inviteCodeFrom } from './types';
