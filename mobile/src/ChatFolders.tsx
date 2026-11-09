// Chat folders as in Telegram: tabs above the chat list ("Все", "Непрочитанные"
// and folders the user makes from chosen chats). Folders are kept on this
// device only; the server does not learn how chats are grouped.
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { animMs } from './motion';
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

// One shared copy per account: the chat list tabs and Settings → Chat folders stay in sync.
const shared = new Map<string, { folders: ChatFolder[]; loaded: boolean; listeners: Set<(folders: ChatFolder[]) => void> }>();
function entry(userId: string) {
  let item = shared.get(userId);
  if (!item) {
    item = { folders: [], loaded: false, listeners: new Set() }; shared.set(userId, item);
    const current = item;
    AsyncStorage.getItem(key(userId)).then(raw => {
      if (!raw) return; try { const list = JSON.parse(raw); if (valid(list)) { current.folders = list.slice(0, 20); current.listeners.forEach(listener => listener(current.folders)); } } catch { /* broken entry is ignored */ }
    }).catch(() => {}).finally(() => { current.loaded = true; });
  }
  return item;
}

export function useChatFolders(userId: string) {
  const store = entry(userId);
  const [folders, setFolders] = useState<ChatFolder[]>(store.folders);
  useEffect(() => { const listener = (next: ChatFolder[]) => setFolders(next); store.listeners.add(listener); setFolders(store.folders); return () => { store.listeners.delete(listener); }; }, [store]);
  const save = (next: ChatFolder[]) => { store.folders = next; store.listeners.forEach(listener => listener(next)); void AsyncStorage.setItem(key(userId), JSON.stringify(next)).catch(() => {}); };
  return {
    folders,
    upsert: (folder: ChatFolder) => save(store.folders.some(item => item.id === folder.id) ? store.folders.map(item => item.id === folder.id ? folder : item) : [...store.folders, folder]),
    remove: (id: string) => save(store.folders.filter(item => item.id !== id)),
    /** Telegram lets you drag folders; here a folder moves one place up or down. */
    move: (id: string, delta: -1 | 1) => { const list = [...store.folders]; const from = list.findIndex(item => item.id === id), to = from + delta; if (from < 0 || to < 0 || to >= list.length) return; [list[from], list[to]] = [list[to], list[from]]; save(list); },
  };
}

/** `marked`: chats marked unread by hand on this device (src/markedUnread.ts); Telegram lists them in «Непрочитанные». */
export function matchesFolder(chat: Chat, filter: FolderFilter, folders: ChatFolder[], marked?: ReadonlySet<string>) {
  if (filter === 'all') return true;
  if (filter === 'unread') return chat.unreadCount > 0 || !!marked?.has(chat.id);
  return !!folders.find(folder => folder.id === filter)?.chatIds.includes(chat.id);
}

/** The tabs in order: «Все», «Непрочитанные», then the user's folders (a swipe on the list walks them). */
export function folderTabIds(folders: ChatFolder[]): FolderFilter[] {
  return ['all', 'unread', ...folders.map(folder => folder.id)];
}

/**
 * `position` is the fractional index of the shown tab: the chat list drives it while a swipe is
 * in progress, so the highlight slides with the finger as in Telegram. Without it the highlight
 * moves to a tapped tab by itself.
 */
export function FolderTabs({ folders, filter, unread, onChange, onCreate, onEdit, position }: { folders: ChatFolder[]; filter: FolderFilter; unread: number; onChange: (filter: FolderFilter) => void; onCreate: () => void; onEdit: (folder: ChatFolder) => void; position?: SharedValue<number> }) {
  const t = useTheme();
  const tabs: { id: FolderFilter; label: string; folder?: ChatFolder; badge?: number }[] = [{ id: 'all', label: 'Все' }, { id: 'unread', label: 'Непрочитанные', badge: unread }, ...folders.map(folder => ({ id: folder.id, label: folder.name, folder }))];
  const activeIndex = Math.max(0, tabs.findIndex(tab => tab.id === filter));
  const own = useSharedValue(activeIndex);
  const pos = position || own;
  useEffect(() => { if (!position) own.value = withTiming(activeIndex, { duration: animMs(220), easing: Easing.out(Easing.cubic) }); }, [activeIndex, own, position]);
  // Where each tab sits, for the sliding highlight (UI thread) and to scroll a long bar to the active tab.
  const layouts = useSharedValue<{ x: number; w: number }[]>([]);
  const jsLayouts = useRef<{ x: number; w: number }[]>([]);
  const onTabLayout = (index: number) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout; const next = jsLayouts.current.slice(0, tabs.length); next[index] = { x, w: width }; jsLayouts.current = next; layouts.value = next.slice();
  };
  const scroll = useRef<ScrollView>(null);
  useEffect(() => { const at = jsLayouts.current[activeIndex]; if (at) scroll.current?.scrollTo({ x: Math.max(0, at.x - 40), animated: animMs(1) > 0 }); }, [activeIndex]);
  const highlight = useAnimatedStyle(() => {
    const list = layouts.value; const p = Math.max(0, Math.min(list.length - 1, pos.value)); const i = Math.floor(p), f = p - i;
    const a = list[i], b = list[Math.min(i + 1, list.length - 1)] || a;
    if (!a || !b) return { opacity: 0 };
    return { opacity: 1, width: a.w + (b.w - a.w) * f, transform: [{ translateX: a.x + (b.x - a.x) * f }] };
  });
  // Telegram: one glass bar across the screen; tabs share it equally while they fit, then scroll.
  // …only when the names are short too: a long folder name squeezed «Все» down to «В..».
  const fits = tabs.length <= 3 && tabs.reduce((sum, tab) => sum + Array.from(tab.label).length, 0) <= 24;
  const items = <>
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 4, height: 32, borderRadius: 16, backgroundColor: t.dark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.85)' }, highlight]} />
    {tabs.map((tab, index) => { const active = filter === tab.id; return <Pressable key={tab.id} onLayout={onTabLayout(index)} onPress={() => { lightFeedback(); onChange(tab.id); }} onLongPress={tab.folder ? () => onEdit(tab.folder!) : undefined} accessibilityRole="tab" accessibilityState={{ selected: active }} style={{ flexGrow: fits ? 1 : 0, flexShrink: fits ? 1 : 0, flexBasis: 'auto', minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12, height: 32, borderRadius: 16 }}>
      <Text numberOfLines={1} maxFontSizeMultiplier={1.15} style={{ flexShrink: 1, color: t.text, fontSize: 14, fontWeight: active ? '700' : '500' }}>{tab.label}</Text>
      {tab.badge ? <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent }}><Text maxFontSizeMultiplier={1} style={{ color: t.onAccent, fontSize: 11, fontWeight: '700' }}>{tab.badge > 99 ? '99+' : tab.badge}</Text></View> : null}
    </Pressable>; })}
    <Pressable onPress={onCreate} accessibilityRole="button" accessibilityLabel="Новая папка" hitSlop={4} style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}><Icon name="add" size={18} color={t.muted} /></Pressable>
  </>;
  return <GlassSurface lens material="regular" radius={20} shadow={false} style={{ marginHorizontal: 16, marginBottom: 8 }} contentStyle={{ height: 40, justifyContent: 'center' }}>
    {fits ? <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 2, height: 40 }}>{items}</View>
      : <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 4, gap: 2, alignItems: 'center', height: 40 }}>{items}</ScrollView>}
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
