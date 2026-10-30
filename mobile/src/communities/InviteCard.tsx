import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import type { Api } from '../api';
import { Icon } from '../components';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { CommunityAvatar, KindBadge, members, subscribers } from './parts';
import type { InvitePreview } from './types';

const cache = new Map<string, Promise<InvitePreview | null>>();
const preview = (api: Api, code: string) => {
  let pending = cache.get(code);
  if (!pending) { pending = api.invite(code).catch(() => null); cache.set(code, pending); setTimeout(() => cache.delete(code), 60_000); }
  return pending;
};

/**
 * Invite banner shown under a message with an invite link (as Telegram shows a channel
 * card): picture, name, members and «Принять приглашение» / «Открыть».
 */
export function InviteCard({ api, code, onOpen }: { api: Api; code: string; onOpen: (code: string) => void }) {
  const t = useTheme(); const [info, setInfo] = useState<InvitePreview | null | undefined>(undefined);
  useEffect(() => { let alive = true; void preview(api, code).then(value => { if (alive) setInfo(value); }); return () => { alive = false; }; }, [api, code]);
  if (info === undefined) return <View style={{ padding: 12, borderRadius: 14, backgroundColor: t.surface2, alignItems: 'center', minWidth: 220 }}><ActivityIndicator color={t.accent} /></View>;
  if (info === null) return <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: 14, backgroundColor: t.surface2, minWidth: 220 }}><Icon name="link-outline" size={18} color={t.subtle} /><Text style={{ color: t.muted, fontSize: 13 }}>Приглашение недействительно</Text></View>;
  const community = info.community;
  return <View style={{ borderRadius: 16, backgroundColor: t.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderWidth: 1, borderColor: t.border, padding: 12, gap: 10, minWidth: 230, maxWidth: 300 }}>
    <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: .6 }}>{community.kind === 'blog' ? 'ПРИГЛАШЕНИЕ В КАНАЛ' : 'ПРИГЛАШЕНИЕ НА СЕРВЕР'}</Text>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
      <CommunityAvatar api={api} community={community} size={48} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{community.name}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><KindBadge kind={community.kind} /><Text style={{ color: t.muted, fontSize: 12 }}>{community.kind === 'blog' ? subscribers(community.memberCount) : members(community.memberCount)}</Text></View>
      </View>
    </View>
    <Pressable accessibilityRole="button" onPress={() => onOpen(code)} style={({ pressed }) => ({ height: 38, borderRadius: 10, backgroundColor: info.isMember ? t.surface2 : '#2FA36B', alignItems: 'center', justifyContent: 'center', opacity: pressed ? .75 : 1 })}>
      <Text style={{ color: info.isMember ? t.text : '#FFF', fontSize: 14, fontWeight: '700' }}>{info.isMember ? 'Открыть' : 'Принять приглашение'}</Text>
    </Pressable>
  </View>;
}
