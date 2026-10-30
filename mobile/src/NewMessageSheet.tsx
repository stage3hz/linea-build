import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, SectionList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, TextInput } from './typography';
import { Avatar, Icon, IconButton, Notice, type IconName } from './components';
import { useTheme } from './theme';
import { StatusEmoji } from './StatusEmoji';
import { navigate } from './navigation';
import type { Api } from './api';
import type { Chat, User } from './types';

/**
 * «Написать сообщение» (Telegram's compose sheet): search, «Создать канал», «Найти по нику»,
 * then friends grouped by first letter. Picking a person opens (or creates) the chat.
 */
export function NewMessageSheet({ api, visible, onClose, onOpen, onFindPeople }: { api: Api; visible: boolean; onClose: () => void; onOpen: (chat: Chat) => void; onFindPeople: () => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets();
  const [friends, setFriends] = useState<User[] | null>(null); const [found, setFound] = useState<User[]>([]);
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState('');
  useEffect(() => { if (!visible) { setQuery(''); setError(''); return; } api.contacts().then(result => setFriends(result.users)).catch(() => setFriends([])); }, [visible, api]);
  useEffect(() => {
    const needle = query.trim(); if (needle.length < 2) { setFound([]); return; }
    let alive = true; const timer = setTimeout(() => { api.users(needle).then(result => { if (alive) setFound(result.users); }).catch(() => {}); }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, api]);
  const sections = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const list = (friends || []).filter(user => !needle || `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(needle));
    const extra = found.filter(user => !list.some(item => item.id === user.id));
    const groups = new Map<string, User[]>();
    for (const user of list) { const letter = (user.displayName.trim()[0] || '#').toLocaleUpperCase(); groups.set(letter, [...(groups.get(letter) || []), user]); }
    const result = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'ru')).map(([title, data]) => ({ title, data }));
    if (extra.length) result.push({ title: 'Поиск по нику', data: extra });
    return result;
  }, [friends, found, query]);
  const open = async (user: User) => {
    setBusy(user.id); setError('');
    try { const { chat } = await api.createChat(user.id); onClose(); onOpen(chat); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось открыть чат.'); } finally { setBusy(null); }
  };
  const action = (icon: IconName, label: string, onPress: () => void) => <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 46, paddingHorizontal: 18, opacity: pressed ? .6 : 1 })}><Icon name={icon} size={22} color={t.accent} /><Text style={{ color: t.accent, fontSize: 16 }}>{label}</Text></Pressable>;
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, height: 52 }}>
        <IconButton name="close" label="Закрыть" onPress={onClose} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 17, fontWeight: '600', marginRight: 44 }}>Написать сообщение</Text>
      </View>
      <View style={{ marginHorizontal: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, borderRadius: 12, paddingHorizontal: 10, backgroundColor: t.surface2 }}>
        <Icon name="search" size={17} color={t.muted} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Поиск" placeholderTextColor={t.muted} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, color: t.text, fontSize: 16, paddingVertical: 6 }} />
      </View>
      {error ? <View style={{ paddingHorizontal: 14 }}><Notice text={error} error /></View> : null}
      <SectionList sections={sections} keyExtractor={item => item.id} stickySectionHeadersEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        ListHeaderComponent={query.trim() ? null : <View style={{ paddingVertical: 4 }}>
          {action('megaphone-outline', 'Создать канал', () => { onClose(); navigate({ to: 'channels', create: true }); })}
          {action('person-add-outline', 'Найти по нику', () => { onClose(); onFindPeople(); })}
        </View>}
        ListEmptyComponent={friends === null ? <ActivityIndicator color={t.accent} style={{ marginTop: 30 }} /> : <Text style={{ color: t.muted, textAlign: 'center', marginTop: 30, paddingHorizontal: 30 }}>{query.trim().length >= 2 ? 'Никого не нашли.' : 'Друзей пока нет. Найди человека по нику.'}</Text>}
        renderSectionHeader={({ section }) => <View style={{ backgroundColor: t.bg, paddingHorizontal: 18, paddingVertical: 5 }}><Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>{section.title}</Text></View>}
        renderItem={({ item }) => <Pressable onPress={() => void open(item)} disabled={!!busy} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 7, backgroundColor: pressed ? t.accentSoft : 'transparent' })}>
          <Avatar user={item} api={api} size={40} />
          <View style={{ flex: 1 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 16, fontWeight: '500', flexShrink: 1 }}>{item.displayName}</Text><StatusEmoji user={item} size={14} /></View><Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>@{item.username}</Text></View>
          {busy === item.id ? <ActivityIndicator color={t.accent} /> : null}
        </Pressable>} />
    </View>
  </Modal>;
}
