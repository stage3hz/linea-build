import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Api } from '../api';
import type { User } from '../types';
import type { MessengerStore } from '../useMessenger';
import { Button, Empty, Field, Icon, IconButton, Notice, Sheet } from '../components';
import { GlassBackdrop, GlassSurface } from '../glass';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { StackBase, StackScreen } from '../stack';
import { CommunityScreen } from './CommunityScreen';
import { CommunityAvatar, members, subscribers } from './parts';
import { CATEGORIES, inviteCodeFrom, type CategoryId, type CommunityKind, type CommunitySummary } from './types';
import { InviteCard } from './InviteCard';

/**
 * «Каналы» tab: the user's game servers and blogs, create a new one (choose the type, as in
 * Discord's «create server» flow), or join by an invite link.
 */
export function CommunitiesScreen({ api, me, store, openId, onOpenInvite, onOpened, createSignal = 0 }: { api: Api; me: User; store: MessengerStore; createSignal?: number; openId: string | null; onOpenInvite: (code: string) => void; onOpened: (id: string | null) => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets();
  const [list, setList] = useState<CommunitySummary[] | null>(null); const [error, setError] = useState('');
  const [create, setCreate] = useState<CommunityKind | 'choose' | null>(null); const [join, setJoin] = useState(false);
  const progress = useSharedValue(1);
  const load = useCallback(() => { api.communities().then(result => { setList(result.communities); setError(''); }).catch(failure => setError(failure instanceof Error ? failure.message : 'Не удалось загрузить.')); }, [api]);
  useEffect(load, [load]);
  useEffect(() => { if (createSignal) setCreate('choose'); }, [createSignal]);
  useEffect(() => store.onSocket(data => {
    if (data.type === 'community' && data.community) setList(current => current ? current.some(item => item.id === data.community.id) ? current.map(item => item.id === data.community.id ? data.community : item) : [data.community, ...current] : current);
    else if (data.type === 'community.removed') setList(current => current?.filter(item => item.id !== data.communityId) || current);
    else if (data.type === 'community.message') setList(current => current?.map(item => item.id === data.communityId ? { ...item, lastMessage: data.message } : item) || current);
  }), [store]);
  useEffect(() => { if (openId) load(); }, [openId, load]);

  const servers = (list || []).filter(item => item.kind === 'server'), blogs = (list || []).filter(item => item.kind === 'blog');
  const rows: ({ header: string } | CommunitySummary)[] = [...(servers.length ? [{ header: 'Игровые серверы' }, ...servers] : []), ...(blogs.length ? [{ header: 'Каналы' }, ...blogs] : [])];

  return <View style={{ flex: 1 }}>
    <StackBase progress={progress} covered={!!openId}>
      <View style={{ flex: 1 }}>
        <GlassSurface material="clear" radius={27} style={{ marginHorizontal: 14, marginTop: 12 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 9, minHeight: 64 }}>
          <View style={{ flex: 1, paddingLeft: 6 }}><Text style={{ fontSize: 22, fontWeight: '700', color: t.text }}>Каналы</Text><Text style={{ fontSize: 12, color: t.muted }}>Игровые серверы и каналы</Text></View>
          <IconButton name="link-outline" label="Вступить по ссылке" onPress={() => setJoin(true)} />
          <Pressable accessibilityRole="button" accessibilityLabel="Создать" onPress={() => setCreate('choose')} style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Icon name="add" color={t.onAccent} size={24} /></Pressable>
        </GlassSurface>
        {error ? <View style={{ padding: 14 }}><Notice text={error} error onRetry={load} /></View> : null}
        {!list ? <ActivityIndicator color={t.accent} style={{ marginTop: 40 }} /> : <FlatList data={rows} keyExtractor={item => 'header' in item ? item.header : item.id} contentContainerStyle={{ padding: 12, paddingBottom: 30 + insets.bottom, flexGrow: 1 }}
          ListEmptyComponent={<View style={{ flex: 1, justifyContent: 'center' }}><Empty icon="planet-outline" title="Свои места для своих" description="Создай игровой сервер с текстовыми и голосовыми каналами или стандартный канал — блог, новости, музыку, что угодно." action={<Button label="Создать" icon="add" onPress={() => setCreate('choose')} />} /></View>}
          renderItem={({ item }) => 'header' in item ? <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 6 }}>{item.header.toUpperCase()}</Text> :
            <Pressable onPress={() => onOpened(item.id)} accessibilityRole="button" style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8, borderRadius: 16, backgroundColor: pressed ? t.accentSoft : 'transparent' })}>
              <CommunityAvatar api={api} community={item} size={54} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text numberOfLines={1} style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{item.name}</Text>
                <Text numberOfLines={1} style={{ color: t.muted, fontSize: 14 }}>{item.lastMessage?.text || item.description || (item.kind === 'blog' ? subscribers(item.memberCount) : members(item.memberCount))}</Text>
              </View>
              {item.muted ? <Icon name="volume-mute" size={14} color={t.subtle} /> : null}
            </Pressable>} />}
      </View>
    </StackBase>
    {openId ? <StackScreen key={openId} progress={progress} onBack={() => onOpened(null)}>{back => <View style={{ flex: 1 }}><Backdrop /><CommunityScreen api={api} me={me} store={store} communityId={openId} onBack={back} onOpenInvite={onOpenInvite} onLeft={() => { onOpened(null); load(); }} /></View>}</StackScreen> : null}
    <CreateSheet api={api} mode={create} onMode={setCreate} onCreated={id => { setCreate(null); load(); onOpened(id); }} />
    <JoinSheet api={api} visible={join} onClose={() => setJoin(false)} onOpenInvite={code => { setJoin(false); onOpenInvite(code); }} />
  </View>;
}

function Backdrop() {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={{ position: 'absolute', top: -insets.top, bottom: -insets.bottom, left: 0, right: 0 }}><GlassBackdrop /></View>;
}

function CreateSheet({ api, mode, onMode, onCreated }: { api: Api; mode: CommunityKind | 'choose' | null; onMode: (mode: CommunityKind | 'choose' | null) => void; onCreated: (id: string) => void }) {
  const t = useTheme(); const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [category, setCategory] = useState<CategoryId>('blog'); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (mode === null) { setName(''); setDescription(''); setCategory('blog'); setError(''); } }, [mode]);
  const option = (kind: CommunityKind, icon: React.ComponentProps<typeof Icon>['name'], title: string, text: string) => <Pressable accessibilityRole="button" onPress={() => onMode(kind)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 18, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, opacity: pressed ? .7 : 1 })}>
    <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={24} color={t.accent} /></View>
    <View style={{ flex: 1, gap: 3 }}><Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{title}</Text><Text style={{ color: t.muted, fontSize: 13, lineHeight: 18 }}>{text}</Text></View>
    <Icon name="chevron-forward" size={18} color={t.subtle} />
  </Pressable>;
  const submit = async () => {
    if (mode !== 'server' && mode !== 'blog') return;
    setBusy(true); setError('');
    try { const { community } = await api.createCommunity({ kind: mode, name: name.trim(), description: description.trim(), ...(mode === 'blog' ? { category } : {}) }); onCreated(community.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось создать.'); } finally { setBusy(false); }
  };
  return <Sheet visible={mode !== null} title={mode === 'choose' ? 'Что создаём?' : mode === 'server' ? 'Игровой сервер' : 'Стандартный канал'} onClose={() => onMode(null)}>
    {mode === 'choose' ? <View style={{ gap: 10 }}>
      {option('server', 'game-controller-outline', 'Игровой', 'Как в Discord: текстовые и голосовые каналы, роли, закрытые каналы для своих.')}
      {option('blog', 'megaphone-outline', 'Стандартный', 'Обычный канал: блог, новости, музыка и не только. Публикуешь ты и авторы, подписчики читают.')}
    </View> : <View style={{ gap: 14 }}>
      <Field label="Название" value={name} onChangeText={setName} maxLength={60} placeholder={mode === 'server' ? 'Например, Клан «Север»' : 'Например, Заметки Стейджа'} />
      <Field label="Описание" value={description} onChangeText={setDescription} maxLength={500} multiline style={{ height: 76, textAlignVertical: 'top' }} placeholder="Необязательно" />
      {mode === 'blog' ? <View style={{ gap: 8 }}><Text style={{ color: t.muted, fontSize: 12, fontWeight: '600' }}>О чём канал</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{CATEGORIES.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected: category === item.id }} onPress={() => setCategory(item.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: category === item.id ? t.accent : t.surface2 }}><Icon name={item.icon} size={15} color={category === item.id ? t.onAccent : t.text} /><Text style={{ color: category === item.id ? t.onAccent : t.text, fontSize: 13, fontWeight: '600' }}>{item.label}</Text></Pressable>)}</View></View> : null}
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{mode === 'server' ? 'Сразу появятся каналы #общий и #новости, голосовые «Общий» и «Игра» и роль «Модератор». Всё можно поменять.' : 'Ссылкой-приглашением можно делиться в чатах и вне мессенджера.'} Сообщения в каналах не шифруются сквозным шифрованием.</Text>
      {error ? <Notice text={error} error /> : null}
      <Button label="Создать" loading={busy} disabled={!name.trim()} onPress={() => void submit()} />
      <Pressable onPress={() => onMode('choose')} style={{ alignSelf: 'center', padding: 6 }}><Text style={{ color: t.accent, fontSize: 13 }}>Другой тип</Text></Pressable>
    </View>}
  </Sheet>;
}

function JoinSheet({ api, visible, onClose, onOpenInvite }: { api: Api; visible: boolean; onClose: () => void; onOpenInvite: (code: string) => void }) {
  const t = useTheme(); const [link, setLink] = useState('');
  const code = inviteCodeFrom(link) || (/^[A-Za-z0-9]{6,16}$/.test(link.trim()) ? link.trim() : null);
  useEffect(() => { if (!visible) setLink(''); }, [visible]);
  return <Sheet visible={visible} title="Вступить по ссылке" onClose={onClose}>
    <View style={{ gap: 14 }}>
      <Field label="Ссылка или код" value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} placeholder="https://…/i/Ab3dEf9h" />
      {code ? <InviteCard api={api} code={code} onOpen={onOpenInvite} /> : <Text style={{ color: t.muted, fontSize: 12 }}>Вставь приглашение, которое тебе прислали.</Text>}
    </View>
  </Sheet>;
}


