// Telegram-style mini profile: tap a name or avatar (channel messages, the chat header) and a
// compact card opens — banner, avatar, name, @username, about, and the two obvious actions.
// On PC it pops up next to the click; on phones it rises from the bottom.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
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
import { lightFeedback } from './haptics';
import { refreshFriendRequests } from './friendRequests';
import type { ChatRules } from './messageMeta';

/** Personal chat (Telegram: tap the name): calls, attachments and the chat's own switches. */
export type ChatQuick = {
  onCall?: (video: boolean) => void; onAttachments: () => void;
  rules: ChatRules; onRules: (rules: ChatRules) => void;
};

const CARD_WIDTH = 320;

export function MiniProfile({ api, user, me, at, status, onClose, onOpenProfile, inChat = false, quick }: {
  api: Api; user: User | null; me: string; at?: { x: number; y: number } | null; status?: string;
  onClose: () => void; onOpenProfile?: () => void; inChat?: boolean; quick?: ChatQuick;
}) {
  const t = useTheme(); const win = useWindowDimensions();
  const [contact, setContact] = useState<boolean | null>(null); const [request, setRequest] = useState<'incoming' | 'outgoing' | null>(null);
  const [blocked, setBlocked] = useState(false); const [busy, setBusy] = useState(false); const [note, setNote] = useState(''); const [confirmBlock, setConfirmBlock] = useState(false);
  useEffect(() => {
    if (!quick || !user) return; let live = true;
    api.userProfile(user.id).then(r => { if (live) { setContact(r.isContact); setRequest(r.friendRequest ?? null); setBlocked(!!r.blocked); } }).catch(() => { if (live) setContact(false); });
    return () => { live = false; };
  }, [api, user?.id, !!quick]);
  if (!user) return null;
  const run = async (job: () => Promise<string>) => { if (busy) return; setBusy(true); setNote(''); lightFeedback(); try { setNote(await job()); } catch (e) { setNote(e instanceof Error ? e.message : 'Не получилось.'); } finally { setBusy(false); } };
  const friend = () => run(async () => {
    if (contact) { await api.removeContact(user.id); setContact(false); void refreshFriendRequests(api); return 'Удалён из друзей'; }
    if (request === 'outgoing') { await api.dropFriendRequest(user.id); setRequest(null); return 'Заявка отменена'; }
    if (request === 'incoming') { await api.acceptFriend(user.id); setRequest(null); setContact(true); void refreshFriendRequests(api); return 'Теперь вы друзья'; }
    const r = await api.addContact(user.id); if (r.status === 'requested') { setRequest('outgoing'); return 'Заявка отправлена'; } setContact(true); return 'Теперь вы друзья';
  });
  const block = () => { if (!blocked && !confirmBlock) { setConfirmBlock(true); return; } setConfirmBlock(false); void run(async () => {
    if (blocked) { await api.unblock(user.id); setBlocked(false); return 'Разблокирован'; }
    await api.block(user.id); setBlocked(true); setContact(false); setRequest(null); void refreshFriendRequests(api); return 'Заблокирован: он не сможет писать и звонить';
  }); };
  const row = (icon: IconName, label: string, onPress: () => void, opts: { danger?: boolean; on?: boolean; hint?: string } = {}) =>
    <Pressable key={label} onPress={onPress} disabled={busy} accessibilityRole={opts.on === undefined ? 'button' : 'switch'} accessibilityState={opts.on === undefined ? undefined : { checked: opts.on }} accessibilityLabel={label}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 48, opacity: pressed ? .6 : 1 })}>
      <Icon name={icon} size={20} color={opts.danger ? t.danger : t.text} />
      <View style={{ flex: 1, paddingVertical: 8 }}><Text style={{ color: opts.danger ? t.danger : t.text, fontSize: 15, fontWeight: '600' }}>{label}</Text>{opts.hint ? <Text style={{ color: t.muted, fontSize: 12 }}>{opts.hint}</Text> : null}</View>
      {opts.on !== undefined ? <View style={{ width: 44, height: 26, borderRadius: 13, padding: 3, backgroundColor: opts.on ? t.accent : t.surface2, alignItems: opts.on ? 'flex-end' : 'flex-start' }}><View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFF' }} /></View> : null}
    </Pressable>;
  const tile = (icon: IconName, label: string, onPress: () => void) =>
    <Pressable key={label} onPress={() => { onClose(); onPress(); }} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => ({ flex: 1, alignItems: 'center', gap: 5, paddingVertical: 11, borderRadius: 14, backgroundColor: t.surface2, opacity: pressed ? .7 : 1 })}>
      <Icon name={icon} size={21} color={t.accent} /><Text style={{ color: t.text, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </Pressable>;
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
    {/* No banner: a quiet strip tinted by the person's colour (a full-strength block looked crude). */}
    <View style={{ height: banner ? 84 : 56, overflow: 'hidden', backgroundColor: menuSurface(t) }}>
      {banner ? <ProfileBanner user={user} api={api} height={84} width={wide ? CARD_WIDTH : Math.min(win.width, 520)} /> : <View style={{ flex: 1, backgroundColor: user.avatarColor || t.accent, opacity: 0.18 }} />}
    </View>
    <View style={{ paddingHorizontal: 16, paddingBottom: 16, marginTop: -36, gap: 4 }}>
      <Pressable disabled={!onOpenProfile} onPress={() => { onClose(); onOpenProfile?.(); }} accessibilityRole="button" accessibilityLabel="Открыть полный профиль" style={{ alignSelf: 'flex-start', padding: 4, borderRadius: 44, backgroundColor: menuSurface(t) }}><DecoratedAvatar user={user} api={api} size={72} animated /></Pressable>
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
      {quick ? <>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          {quick.onCall ? tile('call', 'Звонок', () => quick.onCall!(false)) : null}
          {quick.onCall ? tile('videocam', 'Видео', () => quick.onCall!(true)) : null}
          {tile('images', 'Вложения', quick.onAttachments)}
        </View>
        <View style={{ marginTop: 10, borderRadius: 14, backgroundColor: t.surface2, overflow: 'hidden' }}>
          {contact === null ? <View style={{ minHeight: 48, justifyContent: 'center' }}><ActivityIndicator color={t.accent} /></View>
            : row(contact ? 'person-remove-outline' : request === 'outgoing' ? 'time-outline' : 'person-add-outline', contact ? 'Удалить из друзей' : request === 'outgoing' ? 'Отменить заявку' : request === 'incoming' ? 'Принять в друзья' : 'Добавить в друзья', () => void friend())}
          {row(quick.rules.noCopy ? 'lock-closed-outline' : 'lock-open-outline', 'Запретить пересылку и копирование', () => { lightFeedback(); quick.onRules({ ...quick.rules, noCopy: !quick.rules.noCopy }); setNote(quick.rules.noCopy ? 'Копирование и пересылка снова разрешены' : 'Теперь копировать и пересылать сообщения этого чата нельзя обоим'); }, { on: quick.rules.noCopy, hint: 'Для обоих в этом чате' })}
          {row(blocked ? 'hand-left-outline' : 'remove-circle-outline', blocked ? 'Разблокировать' : confirmBlock ? 'Нажми ещё раз, чтобы заблокировать' : 'Заблокировать', block, { danger: !blocked })}
        </View>
        {note ? <Text style={{ color: t.muted, fontSize: 13, marginTop: 8, textAlign: 'center' }}>{note}</Text> : null}
        {onOpenProfile ? <View style={{ flexDirection: 'row', marginTop: 10 }}>{action('person-circle-outline', 'Открыть профиль', onOpenProfile)}</View> : null}
      </> : actions.length ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>{actions}</View> : null}
    </View>
  </View>;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: wide ? 'transparent' : 'rgba(0,0,0,0.45)' }]} onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" />
    {wide && at ? <View style={{ position: 'absolute', left, top }}>{card}</View>
      : <View pointerEvents="box-none" style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: 'center', padding: 12 }}>{card}</View>}
  </Modal>;
}
