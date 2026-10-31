// Chat folders as in Telegram: tabs above the chat list ("Все", "Непрочитанные"
// and folders the user makes from chosen chats). Folders are kept on this
// device only; the server does not learn how chats are grouped.
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { GlassSurface } from './glass';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text, TextInput } from './typography';
import { Avatar, Button, Icon, Sheet, SheetAction } from './components';
import { useTheme } from './theme';
import { lightFeedback } from './haptics';
import type { Api } from './api';
import type { Chat } from './types';

export type ChatFolder = { id: string; name: string; chatIds: string[] };
export type FolderFilter = 'all' | 'unread' | string;

const key = (userId: string) => `linea.folders.v1:${userId}`;
const valid = (value: unknown): value is ChatFolder[] => Array.isArray(value) && value.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.chatIds));

export function useChatFolders(userId: string) {
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  useEffect(() => { let live = true; AsyncStorage.getItem(key(userId)).then(raw => { if (!live || !raw) return; try { const list = JSON.parse(raw); if (valid(list)) setFolders(list.slice(0, 20)); } catch { /* broken entry is ignored */ } }).catch(() => {}); return () => { live = false; }; }, [userId]);
  const save = (next: ChatFolder[]) => { setFolders(next); void AsyncStorage.setItem(key(userId), JSON.stringify(next)).catch(() => {}); };
  return {
    folders,
    upsert: (folder: ChatFolder) => save(folders.some(item => item.id === folder.id) ? folders.map(item => item.id === folder.id ? folder : item) : [...folders, folder]),
    remove: (id: string) => save(folders.filter(item => item.id !== id)),
  };
}

export function matchesFolder(chat: Chat, filter: FolderFilter, folders: ChatFolder[]) {
  if (filter === 'all') return true;
  if (filter === 'unread') return chat.unreadCount > 0;
  return !!folders.find(folder => folder.id === filter)?.chatIds.includes(chat.id);
}

export function FolderTabs({ folders, filter, unread, onChange, onCreate, onEdit }: { folders: ChatFolder[]; filter: FolderFilter; unread: number; onChange: (filter: FolderFilter) => void; onCreate: () => void; onEdit: (folder: ChatFolder) => void }) {
  const t = useTheme();
  const tabs: { id: FolderFilter; label: string; folder?: ChatFolder; badge?: number }[] = [{ id: 'all', label: 'Все' }, { id: 'unread', label: 'Непрочитанные', badge: unread }, ...folders.map(folder => ({ id: folder.id, label: folder.name, folder }))];
  // Telegram: one glass bar across the screen; tabs share it equally while they fit, then scroll.
  const fits = tabs.length <= 3;
  const items = <>
    {tabs.map(tab => { const active = filter === tab.id; return <Pressable key={tab.id} onPress={() => { lightFeedback(); onChange(tab.id); }} onLongPress={tab.folder ? () => onEdit(tab.folder!) : undefined} accessibilityRole="tab" accessibilityState={{ selected: active }} style={{ flex: fits ? 1 : undefined, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 14, height: 32, borderRadius: 16, backgroundColor: active ? (t.dark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.85)') : 'transparent' }}>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{ flexShrink: 1, color: t.text, fontSize: 14, fontWeight: active ? '700' : '500' }}>{tab.label}</Text>
      {tab.badge ? <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent }}><Text style={{ color: t.onAccent, fontSize: 10, fontWeight: '700' }}>{tab.badge > 99 ? '99+' : tab.badge}</Text></View> : null}
    </Pressable>; })}
    <Pressable onPress={onCreate} accessibilityRole="button" accessibilityLabel="Новая папка" hitSlop={4} style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}><Icon name="add" size={18} color={t.muted} /></Pressable>
  </>;
  return <GlassSurface lens material="regular" radius={20} shadow={false} style={{ marginHorizontal: 16, marginBottom: 8 }} contentStyle={{ height: 40, justifyContent: 'center' }}>
    {fits ? <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 2 }}>{items}</View>
      : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 4, gap: 2, alignItems: 'center' }}>{items}</ScrollView>}
  </GlassSurface>;
}

export function FolderEditor({ visible, folder, chats, api, onClose, onSave, onDelete }: { visible: boolean; folder: ChatFolder | null; chats: Chat[]; api: Api; onClose: () => void; onSave: (folder: ChatFolder) => void; onDelete: (id: string) => void }) {
  const t = useTheme();
  const [name, setName] = useState(''); const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => { if (visible) { setName(folder?.name || ''); setPicked(folder?.chatIds || []); } }, [visible, folder?.id]);
  const ready = name.trim().length > 0 && picked.length > 0;
  return <Sheet visible={visible} title={folder ? 'Папка' : 'Новая папка'} onClose={onClose}>
    <View style={{ gap: 12 }}>
      <TextInput value={name} onChangeText={setName} maxLength={24} placeholder="Название, например «Работа»" placeholderTextColor={t.muted} style={{ color: t.text, fontSize: 15, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border }} />
      <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 }}>ЧАТЫ В ПАПКЕ</Text>
      {chats.map(chat => { const on = picked.includes(chat.id); return <Pressable key={chat.id} onPress={() => setPicked(current => on ? current.filter(id => id !== chat.id) : [...current, chat.id])} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 }}>
        <Avatar user={chat.peer} api={api} size={38} /><Text style={{ flex: 1, color: t.text, fontSize: 15 }}>{chat.peer.displayName}</Text><Icon name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? t.accent : t.subtle} />
      </Pressable>; })}
      <Button label="Сохранить" icon="folder-outline" disabled={!ready} onPress={() => onSave({ id: folder?.id || `f${Date.now().toString(36)}`, name: name.trim(), chatIds: picked })} />
      {folder ? <SheetAction icon="trash-outline" label="Удалить папку" description="Чаты останутся во «Всех»" danger onPress={() => onDelete(folder.id)} /> : null}
    </View>
  </Sheet>;
}
