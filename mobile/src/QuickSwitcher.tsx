import { badgeText } from './unreadBadge';
// Ctrl+K (as in Discord / Telegram Desktop search): jump to any chat by typing part of a name.
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import type { Api } from './api';
import type { Chat } from './types';
import { Avatar, Icon } from './components';
import { MONO, Text, TextInput } from './typography';

export function QuickSwitcher({ api, chats, visible, onClose, onOpen }: { api: Api; chats: Chat[]; visible: boolean; onClose: () => void; onOpen: (chat: Chat) => void }) {
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  useEffect(() => { if (visible) { setQuery(''); setIndex(0); } }, [visible]);
  const found = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru').replace(/^@/, '');
    const list = q ? chats.filter(chat => chat.peer.displayName.toLocaleLowerCase('ru').includes(q) || (chat.peer.username || '').toLowerCase().includes(q)) : chats;
    return list.slice(0, 8);
  }, [chats, query]);
  const pick = (chat?: Chat) => { if (!chat) return; onClose(); onOpen(chat); };
  // Raycast, by its DESIGN.md (ui.gradientdeck.com/styles/raycast): Ink panel on the Void canvas, Obsidian
  // input well (radius 8), Graphite selected row, white / Ash / Smoke text, Slate/#363739 hairlines,
  // 16 pt card radius, monospaced key hints on keycaps. Ctrl/⌘ + 1…8 opens that row directly.
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  const mod = mac ? '⌘' : 'Ctrl ';
  const C = { panel: '#07080A', field: '#111214', selected: '#1B1C1E', line: '#363739', text: '#FFFFFF', muted: '#9C9C9D', hint: '#6A6B6C', key: '#111214', keyEdge: '#2F3031' };
  const Hint = ({ label }: { label: string }) => <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: C.key, borderWidth: 1, borderColor: C.keyEdge, borderTopColor: 'rgba(255,255,255,0.12)', borderBottomColor: '#000' }}><Text raw style={{ color: C.muted, fontSize: 12, fontFamily: MONO, letterSpacing: 0.2 }}>{label}</Text></View>;
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Закрыть" onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(4,5,6,0.6)', alignItems: 'center', paddingTop: 110 }}>
      <Pressable onPress={() => {}} style={{ width: 600, maxWidth: '92%', borderRadius: 16, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, overflow: 'hidden', shadowColor: '#000', shadowOpacity: .5, shadowRadius: 40, shadowOffset: { width: 0, height: 18 } }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, margin: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: C.field }}>
          <Icon name="search-outline" size={18} color={C.muted} />
          <TextInput autoFocus value={query} onChangeText={value => { setQuery(value); setIndex(0); }} placeholder="Найти чат…" placeholderTextColor={C.hint} accessibilityLabel="Быстрый переход к чату"
            onKeyPress={event => {
              const native = event.nativeEvent as { key: string; ctrlKey?: boolean; metaKey?: boolean }; const key = native.key;
              if ((native.ctrlKey || native.metaKey) && /^[1-8]$/.test(key)) { (event as unknown as { preventDefault?: () => void }).preventDefault?.(); pick(found[Number(key) - 1]); return; }
              if (key === 'ArrowDown') setIndex(i => Math.min(found.length - 1, i + 1)); else if (key === 'ArrowUp') setIndex(i => Math.max(0, i - 1)); else if (key === 'Escape') onClose();
            }}
            onSubmitEditing={() => pick(found[index])} style={{ flex: 1, color: C.text, fontSize: 18, fontWeight: '400', paddingVertical: 12 }} />
          <Hint label="esc" />
        </View>
        <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          {found.length ? found.map((chat, i) => <Pressable key={chat.id} onPress={() => pick(chat)} onHoverIn={() => setIndex(i)} accessibilityRole="button" accessibilityLabel={`Открыть чат ${chat.peer.displayName}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: i === index ? C.selected : 'transparent' }}>
            <Avatar user={chat.peer} api={api} size={30} round />
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 8 }}><Text numberOfLines={1} raw style={{ flexShrink: 1, color: C.text, fontSize: 14, fontWeight: '500', letterSpacing: 0.2 }}>{chat.peer.displayName}</Text>{chat.peer.username ? <Text numberOfLines={1} raw style={{ color: C.hint, fontSize: 13 }}>@{chat.peer.username}</Text> : null}</View>
            {chat.unreadCount ? <Text raw style={{ color: C.muted, fontSize: 12, fontFamily: MONO }}>{badgeText(chat.unreadCount)}</Text> : null}
            <Hint label={i === index ? '↵' : `${mod}${i + 1}`} />
          </Pressable>) : <Text style={{ color: C.muted, fontSize: 14, padding: 14 }}>Ничего не нашли</Text>}
        </View>
      </Pressable>
    </Pressable>
  </Modal>;
}
