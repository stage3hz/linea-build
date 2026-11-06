// «Переслать» like Telegram: a full-screen list — ✕, title, «Выбрать»; search; folder tabs; Saved
// Messages and the chats with their avatars. A tap opens that chat with the forward waiting above the
// input; «Выбрать» picks several chats and sends at once, with an optional comment.
import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, TextInput } from '../typography';
import { Avatar, Icon } from '../components';
import { useTheme } from '../theme';
import type { Api } from '../api';
import type { Chat } from '../types';
import { matchesFolder, useChatFolders, type FolderFilter } from '../ChatFolders';

/** null = «Избранное» (Saved Messages, stored only on this device). */
export type ForwardTarget = Chat | null;

export function ForwardPicker({ visible, api, userId, chats, count, onClose, onPick, onSendMany }: {
  visible: boolean; api: Api; userId: string; chats: Chat[]; count: number;
  onClose: () => void; onPick: (target: ForwardTarget) => void; onSendMany: (targets: ForwardTarget[], comment: string) => void;
}) {
  const t = useTheme(); const insets = useSafeAreaInsets();
  const { folders } = useChatFolders(userId);
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState<FolderFilter>('all');
  const [selecting, setSelecting] = useState(false); const [picked, setPicked] = useState<Set<string>>(new Set()); const [comment, setComment] = useState('');
  const close = () => { setQuery(''); setFilter('all'); setSelecting(false); setPicked(new Set()); setComment(''); onClose(); };
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = chats.filter(chat => matchesFolder(chat, filter, folders) && (!q || chat.peer.displayName.toLowerCase().includes(q) || chat.peer.username.toLowerCase().includes(q)));
    const saved = filter === 'all' && (!q || 'избранное'.includes(q));
    return [...(saved ? ['saved' as const] : []), ...list];
  }, [chats, filter, folders, q]);
  const key = (row: 'saved' | Chat) => row === 'saved' ? 'saved' : row.id;
  const toggle = (id: string) => setPicked(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const tap = (row: 'saved' | Chat) => { if (selecting) { toggle(key(row)); return; } const target = row === 'saved' ? null : row; close(); onPick(target); };
  const send = () => {
    const targets = [...picked].map(id => id === 'saved' ? null : chats.find(chat => chat.id === id)).filter((target): target is ForwardTarget => target !== undefined);
    const text = comment.trim(); close(); onSendMany(targets, text);
  };
  const tabs: { id: FolderFilter; label: string }[] = [{ id: 'all', label: 'Все чаты' }, ...folders.map(folder => ({ id: folder.id, label: folder.name }))];

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: 52 }}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}><Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={close} hitSlop={8} style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, opacity: pressed ? .7 : 1 })}><Icon name="close" size={24} color={t.text} /></Pressable></View>
        <Text numberOfLines={1} style={{ textAlign: 'center', color: t.text, fontSize: 17, fontWeight: '700' }}>{count > 1 ? `Переслать (${count})` : 'Переслать'}</Text>
        <View style={{ flex: 1, alignItems: 'flex-end' }}><Pressable accessibilityRole="button" onPress={() => { setSelecting(value => !value); setPicked(new Set()); }} hitSlop={8} style={({ pressed }) => ({ height: 44, paddingHorizontal: 16, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, opacity: pressed ? .7 : 1 })}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{selecting ? 'Отмена' : 'Выбрать'}</Text></Pressable></View>
      </View>
      <View style={{ paddingHorizontal: 16, gap: 10, paddingTop: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, borderRadius: 20, paddingHorizontal: 14, backgroundColor: t.surface2 }}>
          <Icon name="search" size={17} color={t.muted} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Поиск" placeholderTextColor={t.muted} autoCorrect={false} autoCapitalize="none" style={{ flex: 1, color: t.text, fontSize: 16, paddingVertical: 0 }} />
        </View>
        {tabs.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {tabs.map(tab => { const on = filter === tab.id; return <Pressable key={tab.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setFilter(tab.id)} style={{ paddingHorizontal: 14, height: 34, borderRadius: 17, justifyContent: 'center', backgroundColor: on ? t.surface2 : 'transparent', borderWidth: 1, borderColor: on ? 'transparent' : t.border }}><Text style={{ color: on ? t.text : t.muted, fontSize: 14, fontWeight: '600' }}>{tab.label}</Text></Pressable>; })}
        </ScrollView> : null}
      </View>
      <FlatList data={rows} keyExtractor={key} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 6, paddingBottom: insets.bottom + (selecting ? 110 : 20) }}
        ListEmptyComponent={<Text style={{ color: t.muted, textAlign: 'center', marginTop: 40 }}>Ничего не найдено</Text>}
        renderItem={({ item }) => { const id = key(item); const on = picked.has(id); return <Pressable accessibilityRole="button" accessibilityLabel={item === 'saved' ? 'Избранное' : item.peer.displayName} accessibilityState={selecting ? { checked: on } : undefined} onPress={() => tap(item)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: pressed ? t.surface2 : 'transparent' })}>
          {item === 'saved' ? <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Icon name="bookmark" size={22} color={t.onAccent} /></View> : <Avatar user={item.peer} api={api} size={46} round />}
          <View style={{ flex: 1, borderBottomWidth: 1, borderBottomColor: t.border, paddingVertical: 12 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 17 }}>{item === 'saved' ? 'Избранное' : item.peer.displayName}</Text></View>
          {selecting ? <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: on ? 0 : 1.5, borderColor: t.muted, backgroundColor: on ? t.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{on ? <Icon name="checkmark" size={16} color={t.onAccent} /> : null}</View> : null}
        </Pressable>; }} />
      {selecting ? <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingTop: 10, paddingBottom: insets.bottom + 10, flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: t.bg, borderTopWidth: 1, borderTopColor: t.border }}>
        <View style={{ flex: 1, minHeight: 40, maxHeight: 120, borderRadius: 20, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: t.surface2 }}>
          <TextInput value={comment} onChangeText={setComment} placeholder="Комментарий" placeholderTextColor={t.muted} multiline maxLength={4000} style={{ color: t.text, fontSize: 16, paddingVertical: 9 }} />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Отправить в ${picked.size}`} disabled={!picked.size} onPress={send} style={({ pressed }) => ({ height: 40, minWidth: 40, paddingHorizontal: picked.size > 1 ? 12 : 0, borderRadius: 20, backgroundColor: t.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, opacity: !picked.size ? .4 : pressed ? .8 : 1 })}><Icon name="arrow-up" size={22} color={t.onAccent} />{picked.size > 1 ? <Text style={{ color: t.onAccent, fontWeight: '700' }}>{picked.size}</Text> : null}</Pressable>
      </View> : null}
    </View>
  </Modal>;
}
