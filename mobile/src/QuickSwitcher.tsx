import { badgeText } from './unreadBadge';
// Ctrl+K (as in Discord / Telegram Desktop search): jump to any chat by typing part of a name.
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import type { Api } from './api';
import type { Chat } from './types';
import { Avatar, Icon } from './components';
import { Text, TextInput } from './typography';
import { useTheme } from './theme';

export function QuickSwitcher({ api, chats, visible, onClose, onOpen }: { api: Api; chats: Chat[]; visible: boolean; onClose: () => void; onOpen: (chat: Chat) => void }) {
  const t = useTheme();
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  useEffect(() => { if (visible) { setQuery(''); setIndex(0); } }, [visible]);
  const found = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru').replace(/^@/, '');
    const list = q ? chats.filter(chat => chat.peer.displayName.toLocaleLowerCase('ru').includes(q) || (chat.peer.username || '').toLowerCase().includes(q)) : chats;
    return list.slice(0, 8);
  }, [chats, query]);
  const pick = (chat?: Chat) => { if (!chat) return; onClose(); onOpen(chat); };
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Закрыть" onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.38)', alignItems: 'center', paddingTop: 110 }}>
      <Pressable onPress={() => {}} style={{ width: 560, maxWidth: '92%', borderRadius: 18, backgroundColor: t.glassOpaque, borderWidth: 1, borderColor: t.border, overflow: 'hidden', shadowColor: '#000', shadowOpacity: .3, shadowRadius: 30, shadowOffset: { width: 0, height: 14 } }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderColor: t.border }}>
          <Icon name="search-outline" size={19} color={t.muted} />
          <TextInput autoFocus value={query} onChangeText={value => { setQuery(value); setIndex(0); }} placeholder="Куда перейти? Имя или @имя" placeholderTextColor={t.muted} accessibilityLabel="Быстрый переход к чату"
            onKeyPress={event => { const key = event.nativeEvent.key; if (key === 'ArrowDown') setIndex(i => Math.min(found.length - 1, i + 1)); else if (key === 'ArrowUp') setIndex(i => Math.max(0, i - 1)); else if (key === 'Escape') onClose(); }}
            onSubmitEditing={() => pick(found[index])} style={{ flex: 1, color: t.text, fontSize: 17, paddingVertical: 16 }} />
          <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700' }}>ESC</Text>
        </View>
        {found.length ? found.map((chat, i) => <Pressable key={chat.id} onPress={() => pick(chat)} onHoverIn={() => setIndex(i)} accessibilityRole="button" accessibilityLabel={`Открыть чат ${chat.peer.displayName}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: i === index ? t.accentSoft : 'transparent' }}>
          <Avatar user={chat.peer} api={api} size={34} round />
          <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{chat.peer.displayName}</Text>{chat.peer.username ? <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>@{chat.peer.username}</Text> : null}</View>
          {chat.unreadCount ? <View style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.onAccent, fontSize: 11, fontWeight: '800' }}>{badgeText(chat.unreadCount)}</Text></View> : null}
          {i === index ? <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700' }}>ENTER</Text> : null}
        </Pressable>) : <Text style={{ color: t.muted, fontSize: 14, padding: 18 }}>Ничего не нашли</Text>}
      </Pressable>
    </Pressable>
  </Modal>;
}
