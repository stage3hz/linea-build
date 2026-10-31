import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, Keyboard, Pressable, ScrollView, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, TextInput } from './typography';
import { Icon } from './components';
import { GlassSurface } from './glass';
import { DecoratedAvatar } from './platina/Decor';
import { StatusEmoji } from './StatusEmoji';
import { CommunityAvatar } from './communities/parts';
import { navigate } from './navigation';
import { useTheme } from './theme';
import { lightFeedback } from './haptics';
import type { Api } from './api';
import type { User } from './types';
import type { MessengerStore } from './useMessenger';
import type { CommunitySummary } from './communities/types';

type Scope = 'chats' | 'people' | 'channels';
const SCOPES: { id: Scope; label: string }[] = [{ id: 'chats', label: 'Чаты' }, { id: 'people', label: 'Люди' }, { id: 'channels', label: 'Каналы' }];
type Recent = { kind: 'user'; user: User } | { kind: 'community'; community: Pick<CommunitySummary, 'id' | 'name' | 'kind' | 'avatarId'> };
const RECENT_LIMIT = 15;
const recentKey = (userId: string) => `linea.recent-search.v1:${userId}`;
const recentId = (item: Recent) => item.kind === 'user' ? `u:${item.user.id}` : `c:${item.community.id}`;

/**
 * Search as in Telegram: the header and folders give way to a field with a round ✕, «Недавние»
 * (kept only on this device) while the field is empty, results by scope, scope tabs riding on
 * top of the keyboard. Dragging the list hides the keyboard but keeps search open.
 */
export function ChatSearch({ api, me, store, onClose, onSaved }: { api: Api; me: User; store: MessengerStore; onClose: () => void; onSaved: () => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets();
  const [query, setQuery] = useState(''); const [scope, setScope] = useState<Scope>('chats');
  const [recent, setRecent] = useState<Recent[]>([]);
  const [people, setPeople] = useState<User[] | null>(null); const [communities, setCommunities] = useState<CommunitySummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const input = useRef<React.ElementRef<typeof TextInput>>(null);

  useEffect(() => { AsyncStorage.getItem(recentKey(me.id)).then(raw => { try { const list = JSON.parse(raw || '[]'); if (Array.isArray(list)) setRecent(list.slice(0, RECENT_LIMIT)); } catch { /* ignore a damaged list */ } }).catch(() => {}); }, [me.id]);
  useEffect(() => { const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; }); return () => sub.remove(); }, [onClose]);
  useEffect(() => {
    if (scope !== 'people' || needle.length < 2) { setPeople(null); return; }
    let alive = true; const timer = setTimeout(() => { api.users(needle).then(result => { if (alive) setPeople(result.users); }).catch(() => { if (alive) setPeople([]); }); }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [api, needle, scope]);
  useEffect(() => { if (scope === 'channels' && communities === null) api.communities().then(result => setCommunities(result.communities)).catch(() => setCommunities([])); }, [api, scope, communities]);

  const remember = (item: Recent) => setRecent(current => {
    const next = [item, ...current.filter(entry => recentId(entry) !== recentId(item))].slice(0, RECENT_LIMIT);
    void AsyncStorage.setItem(recentKey(me.id), JSON.stringify(next)).catch(() => {});
    return next;
  });
  const clearRecent = () => { lightFeedback(); setRecent([]); void AsyncStorage.removeItem(recentKey(me.id)).catch(() => {}); };
  const openUser = async (user: User) => {
    remember({ kind: 'user', user });
    const existing = store.chats.find(chat => chat.peer.id === user.id);
    if (existing) { onClose(); store.selectChat(existing); return; }
    setBusy(user.id);
    setError('');
    try { const { chat } = await api.createChat(user.id); onClose(); store.selectChat(chat); } catch (e) { setError(`${e instanceof Error ? e.message : 'Не удалось открыть чат.'} Нажми ещё раз, чтобы повторить.`); } finally { setBusy(null); }
  };
  const openCommunity = (community: Pick<CommunitySummary, 'id' | 'name' | 'kind' | 'avatarId'>) => {
    remember({ kind: 'community', community: { id: community.id, name: community.name, kind: community.kind, avatarId: community.avatarId } });
    onClose(); navigate({ to: 'channels', communityId: community.id });
  };

  type Row = { key: string; title: string; sub: string; user?: User; community?: Pick<CommunitySummary, 'id' | 'name' | 'kind' | 'avatarId'>; saved?: boolean; onPress: () => void };
  const rows: Row[] = useMemo(() => {
    if (!needle) return recent.map(item => item.kind === 'user'
      ? { key: recentId(item), title: item.user.displayName, sub: `@${item.user.username}`, user: item.user, onPress: () => void openUser(item.user) }
      : { key: recentId(item), title: item.community.name, sub: item.community.kind === 'blog' ? 'канал' : 'сервер', community: item.community, onPress: () => openCommunity(item.community) });
    if (scope === 'chats') {
      const list: Row[] = 'избранное'.includes(needle) ? [{ key: 'saved', title: 'Избранное', sub: 'Заметки и сохранённое', saved: true, onPress: () => { onClose(); onSaved(); } }] : [];
      for (const chat of store.chats) if (`${chat.peer.displayName} ${chat.peer.username}`.toLocaleLowerCase().includes(needle)) list.push({ key: chat.id, title: chat.peer.displayName, sub: `@${chat.peer.username}`, user: chat.peer, onPress: () => void openUser(chat.peer) });
      return list;
    }
    if (scope === 'people') return (people || []).filter(user => user.id !== me.id).map(user => ({ key: user.id, title: user.displayName, sub: `@${user.username}`, user, onPress: () => void openUser(user) }));
    return (communities || []).filter(item => item.name.toLocaleLowerCase().includes(needle)).map(item => ({ key: item.id, title: item.name, sub: item.kind === 'blog' ? `канал · ${item.memberCount} подписч.` : `сервер · ${item.memberCount} участн.`, community: item, onPress: () => openCommunity(item) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, scope, recent, store.chats, people, communities, me.id]);

  const loading = !!needle && ((scope === 'people' && needle.length >= 2 && people === null) || (scope === 'channels' && communities === null));
  const empty = needle ? (scope === 'people' && needle.length < 2 ? 'Введи хотя бы 2 буквы ника.' : 'Ничего не нашли.') : 'Здесь появятся чаты и каналы, которые ты открывал из поиска.';

  return <View style={{ flex: 1 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10 }}>
      <GlassSurface material="regular" radius={22} shadow={false} style={{ flex: 1 }} contentStyle={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13 }}>
        <Icon name="search-outline" size={19} color={t.muted} />
        <TextInput ref={input} autoFocus value={query} onChangeText={setQuery} placeholder="Поиск" placeholderTextColor={t.muted} selectionColor={t.accent} autoCapitalize="none" autoCorrect={false} returnKeyType="search" accessibilityLabel="Поиск" style={{ flex: 1, color: t.text, fontSize: 17, paddingVertical: 8 }} />
        {query ? <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Стереть" hitSlop={8}><Icon name="close-circle" size={18} color={t.muted} /></Pressable> : null}
      </GlassSurface>
      <GlassSurface material="regular" radius={22} shadow={false} interactive contentStyle={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Pressable onPress={() => { Keyboard.dismiss(); onClose(); }} accessibilityRole="button" accessibilityLabel="Закрыть поиск" hitSlop={6} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={22} color={t.text} /></Pressable>
      </GlassSurface>
    </View>
    {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.danger, fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 }}>{error}</Text> : null}
    <FlatList data={rows} keyExtractor={row => row.key} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" alwaysBounceVertical contentContainerStyle={{ paddingBottom: 90 + insets.bottom, flexGrow: 1 }}
      ListHeaderComponent={!needle && rows.length ? <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6 }}>
        <Text style={{ flex: 1, color: t.muted, fontSize: 13, fontWeight: '600', letterSpacing: .3 }}>НЕДАВНИЕ</Text>
        <Pressable onPress={clearRecent} accessibilityRole="button" hitSlop={8}><Text style={{ color: t.accent, fontSize: 14 }}>Очистить</Text></Pressable>
      </View> : null}
      ListEmptyComponent={loading ? <ActivityIndicator color={t.accent} style={{ marginTop: 30 }} /> : <Text style={{ color: t.muted, textAlign: 'center', marginTop: 40, paddingHorizontal: 40, fontSize: 14, lineHeight: 20 }}>{empty}</Text>}
      renderItem={({ item }) => <Pressable onPress={item.onPress} disabled={!!busy} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 7, backgroundColor: pressed ? t.accentSoft : 'transparent' })}>
        {item.user ? <DecoratedAvatar user={item.user} api={api} size={44} /> : item.community ? <CommunityAvatar api={api} community={item.community} size={44} /> : <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Icon name="bookmark" size={20} color={t.onAccent} /></View>}
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 16, fontWeight: '600', flexShrink: 1 }}>{item.title}</Text>{item.user ? <StatusEmoji user={item.user} size={14} /> : null}</View>
          <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>{item.sub}</Text>
        </View>
        {busy && item.user && busy === item.user.id ? <ActivityIndicator color={t.accent} /> : null}
      </Pressable>} />
    {/* Scope tabs ride on top of the keyboard, as in Telegram. */}
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 8 }}>
      <View style={{ alignItems: 'center' }}>
        <GlassSurface material="regular" radius={21} contentStyle={{ flexDirection: 'row', padding: 4 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 2 }}>
            {SCOPES.map(item => <Pressable key={item.id} onPress={() => { lightFeedback(); setScope(item.id); }} accessibilityRole="tab" accessibilityState={{ selected: scope === item.id }} style={{ paddingHorizontal: 16, height: 34, borderRadius: 17, justifyContent: 'center', backgroundColor: scope === item.id ? t.accentSoft : 'transparent' }}>
              <Text style={{ color: scope === item.id ? t.text : t.muted, fontSize: 14, fontWeight: scope === item.id ? '700' : '500' }}>{item.label}</Text>
            </Pressable>)}
          </ScrollView>
        </GlassSurface>
      </View>
    </KeyboardStickyView>
  </View>;
}
