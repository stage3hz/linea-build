import { useCalls } from './calls/CallProvider';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Text } from './typography';
import { Avatar, Icon, InsetView, IconButton, Notice, type IconName } from './components';
import { GlassStage, GlassSurface } from './glass';
import { useTheme } from './theme';
import { StatusEmoji } from './StatusEmoji';
import { DecoratedAvatar, ProfileBanner } from './platina/Decor';
import { lightFeedback } from './haptics';
import type { Api } from './api';
import type { Chat, User } from './types';

type Props = {
  api: Api; user: User | null; onClose: () => void;
  chat?: Chat | null; onMessage?: (user: User) => void;
  onMute?: (muted: boolean) => Promise<unknown>;
  onSearch?: () => void; onSecurity?: () => void; status?: string;
};

/** Full-screen profile like in Telegram: big photo, name, @username, bio, actions. */
export function UserProfile({ api, user, onClose, chat, onMessage, onMute, onSearch, onSecurity, status }: Props) {
  const calls = useCalls();
  const t = useTheme();
  const [contact, setContact] = useState<boolean | null>(null);
  const [fresh, setFresh] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setContact(null); setFresh(null); setError(''); setNotice('');
    if (!user) return;
    let live = true;
    api.userProfile(user.id).then(result => { if (live) { setContact(result.isContact); setFresh(result.user); } }).catch(e => { if (live) setError(e instanceof Error ? e.message : 'Не удалось загрузить профиль.'); });
    return () => { live = false; };
  }, [api, user?.id]);
  if (!user) return null;
  const shown = fresh || user;
  const muted = !!chat?.settings?.muted;
  const toggleContact = async () => {
    if (contact === null || busy) return;
    setBusy(true); setError(''); lightFeedback();
    try { if (contact) await api.removeContact(shown.id); else await api.addContact(shown.id); setContact(!contact); setNotice(contact ? 'Удалён из друзей' : 'Добавлен в друзья'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить список друзей.'); }
    finally { setBusy(false); }
  };
  const toggleMute = async () => {
    if (!onMute || busy) return;
    setBusy(true); setError(''); lightFeedback();
    try { await onMute(!muted); setNotice(muted ? 'Звук включён' : 'Уведомления выключены'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить уведомления.'); }
    finally { setBusy(false); }
  };
  const copy = async () => { await Clipboard.setStringAsync(`@${shown.username}`); setNotice('Имя пользователя скопировано'); };
  const actions: { icon: IconName; label: string; onPress: () => void; active?: boolean; loading?: boolean }[] = [
    ...(onMessage ? [{ icon: 'chatbubble' as IconName, label: 'Написать', onPress: () => { onClose(); onMessage(shown); } }] : []),
    ...(chat && calls.available ? [{ icon: 'call' as IconName, label: 'Звонок', onPress: () => { onClose(); calls.start(chat, false); } }, { icon: 'videocam' as IconName, label: 'Видео', onPress: () => { onClose(); calls.start(chat, true); } }] : []),
    { icon: contact ? 'person-remove' : 'person-add', label: contact ? 'В друзьях' : 'В друзья', onPress: () => void toggleContact(), active: !!contact, loading: contact === null },
    ...(onMute && chat ? [{ icon: (muted ? 'notifications-off' : 'notifications') as IconName, label: muted ? 'Без звука' : 'Звук', onPress: () => void toggleMute(), active: muted }] : []),
    ...(onSearch ? [{ icon: 'search' as IconName, label: 'Поиск', onPress: () => { onClose(); onSearch(); } }] : []),
  ];
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <GlassStage>{shown.bannerId || shown.bannerPreset ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 260 }}><ProfileBanner user={shown} api={api} height={260} /></View> : null}<InsetView style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6 }}>
        <IconButton name="chevron-back" label="Назад" onPress={onClose} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 16, fontWeight: '700', marginRight: 44 }}>Профиль</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 18, gap: 16, alignItems: 'center' }}>
        <DecoratedAvatar user={shown} api={api} size={128} animated />
        <View style={{ alignItems: 'center', gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Text style={{ color: t.text, fontSize: 26, fontWeight: '800', letterSpacing: -.6 }}>{shown.displayName}</Text><StatusEmoji user={shown} size={22} animated /></View>
          {status ? <Text style={{ color: status === 'в сети' ? t.accent : t.muted, fontSize: 14 }}>{status}</Text> : <Pressable onPress={() => void copy()} accessibilityRole="button" accessibilityLabel="Скопировать имя пользователя"><Text style={{ color: t.accent, fontSize: 15 }}>@{shown.username}</Text></Pressable>}
        </View>
        <View style={{ flexDirection: 'row', gap: 10, alignSelf: 'stretch', justifyContent: 'center' }}>
          {actions.map(action => <Pressable key={action.label} accessibilityRole="button" onPress={action.onPress} disabled={action.loading || busy} style={({ pressed }) => ({ flex: 1, maxWidth: 120, opacity: pressed ? .7 : 1 })}>
            <GlassSurface radius={18} shadow={false} contentStyle={{ alignItems: 'center', gap: 6, paddingVertical: 12 }}>
              {action.loading ? <ActivityIndicator size="small" color={t.accent} /> : <Icon name={action.icon} size={22} color={action.active ? t.accent : t.text} />}
              <Text style={{ color: action.active ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{action.label}</Text>
            </GlassSurface>
          </Pressable>)}
        </View>
        {notice ? <Text style={{ color: t.accent, fontSize: 13 }}>{notice}</Text> : null}
        {error ? <View style={{ alignSelf: 'stretch' }}><Notice text={error} error /></View> : null}
        <GlassSurface radius={20} shadow={false} style={{ alignSelf: 'stretch' }} contentStyle={{ padding: 16, gap: 14 }}>
          {shown.bio ? <View style={{ gap: 4 }}><Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{shown.bio}</Text><Text style={{ color: t.muted, fontSize: 12 }}>О себе</Text></View> : null}
          <View style={{ gap: 4 }}><Text style={{ color: t.accent, fontSize: 15 }}>@{shown.username}</Text><Text style={{ color: t.muted, fontSize: 12 }}>Имя пользователя</Text></View>
          <Pressable disabled={!onSecurity} onPress={() => { onClose(); onSecurity?.(); }} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Icon name="lock-closed" size={14} color={t.accent} /><Text style={{ color: t.muted, fontSize: 12, flex: 1 }}>Переписка защищена сквозным шифрованием{onSecurity ? ' · проверить устройства' : ''}</Text>{onSecurity ? <Icon name="chevron-forward" size={14} color={t.muted} /> : null}</Pressable>
        </GlassSurface>
      </ScrollView>
    </InsetView></GlassStage>
  </Modal>;
}
