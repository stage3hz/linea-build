// Telegram-style mini profile: tap a name or avatar (channel messages, the chat header) and a
// compact card opens — banner, avatar, name, @username, about, and the two obvious actions.
// On PC it pops up next to the click; on phones it rises from the bottom.
import React from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { Api } from './api';
import type { User } from './types';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';
import { menuSurface } from './ContextMenu';
import { DecoratedAvatar, ProfileBanner } from './platina/Decor';
import { PlatinaName, PlatinaSeal, hasPlatina } from './platina/PlatinaMark';
import { StatusEmoji } from './StatusEmoji';
import { navigate } from './navigation';

const CARD_WIDTH = 320;

export function MiniProfile({ api, user, me, at, status, onClose, onOpenProfile, inChat = false }: {
  api: Api; user: User | null; me: string; at?: { x: number; y: number } | null; status?: string;
  onClose: () => void; onOpenProfile?: () => void; inChat?: boolean;
}) {
  const t = useTheme(); const win = useWindowDimensions();
  if (!user) return null;
  const wide = win.width >= 700, self = user.id === me;
  const banner = !!(user.bannerId || user.bannerPreset);
  const left = wide && at ? Math.max(12, Math.min(at.x, win.width - CARD_WIDTH - 12)) : undefined;
  const top = wide && at ? Math.max(12, Math.min(at.y, win.height - 360)) : undefined;
  const action = (icon: IconName, label: string, onPress: () => void, primary = false) =>
    <Pressable key={label} onPress={() => { onClose(); onPress(); }} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => ({ flex: 1, minHeight: 44, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: primary ? t.accent : t.surface2, opacity: pressed ? 0.75 : 1 })}>
      <Icon name={icon} size={18} color={primary ? '#FFFFFF' : t.text} /><Text style={{ color: primary ? '#FFFFFF' : t.text, fontSize: 14, fontWeight: '700' }}>{label}</Text>
    </Pressable>;
  const actions = [
    !self && !inChat ? action('chatbubble-outline', 'Написать', () => navigate({ to: 'chat', userId: user.id }), true) : null,
    onOpenProfile ? action('person-circle-outline', 'Профиль', onOpenProfile, inChat || self) : null,
  ].filter(Boolean);
  const card = <View style={{ width: wide ? CARD_WIDTH : '100%', maxWidth: 520, borderRadius: 22, overflow: 'hidden', backgroundColor: menuSurface(t), borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 22, shadowOffset: { width: 0, height: 10 } }}>
    <View style={{ height: 84, overflow: 'hidden', backgroundColor: user.avatarColor || t.accentSoft }}>
      {banner ? <ProfileBanner user={user} api={api} height={84} width={wide ? CARD_WIDTH : Math.min(win.width, 520)} /> : <View style={{ flex: 1, backgroundColor: user.avatarColor || t.accent, opacity: 0.55 }} />}
    </View>
    <View style={{ paddingHorizontal: 16, paddingBottom: 16, marginTop: -36, gap: 4 }}>
      <View style={{ alignSelf: 'flex-start', padding: 4, borderRadius: 44, backgroundColor: menuSurface(t) }}><DecoratedAvatar user={user} api={api} size={72} animated /></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
        {hasPlatina(user) ? <PlatinaName user={user} style={{ flexShrink: 1, fontSize: 20, fontWeight: '800' }} /> : <Text numberOfLines={1} style={{ flexShrink: 1, color: t.text, fontSize: 20, fontWeight: '800' }}>{user.displayName}</Text>}
        <StatusEmoji user={user} size={18} animated />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text selectable style={{ color: t.muted, fontSize: 14 }}>@{user.username}</Text>
        {hasPlatina(user) ? <PlatinaSeal size="sm" owner={user} /> : null}
      </View>
      {status ? <Text style={{ color: t.muted, fontSize: 13 }}>{status}</Text> : null}
      {user.bio ? <Text raw selectable numberOfLines={4} style={{ color: t.text, fontSize: 14, lineHeight: 20, marginTop: 8 }}>{user.bio}</Text> : null}
      {actions.length ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>{actions}</View> : null}
    </View>
  </View>;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: wide ? 'transparent' : 'rgba(0,0,0,0.45)' }]} onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" />
    {wide && at ? <View style={{ position: 'absolute', left, top }}>{card}</View>
      : <View pointerEvents="box-none" style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: 'center', padding: 12 }}>{card}</View>}
  </Modal>;
}
