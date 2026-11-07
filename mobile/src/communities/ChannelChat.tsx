import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { linkify } from '../linkify';
import { MiniProfile } from '../MiniProfile';
import { PlatinaGem, PlatinaName, hasPlatina } from '../platina/PlatinaMark';
import { ActivityIndicator, FlatList, Platform, Pressable, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Clipboard from 'expo-clipboard';
import type { Api } from '../api';
import type { User } from '../types';
import type { MessengerStore } from '../useMessenger';
import { AuthImage, Avatar, Icon, IconButton, Notice, Sheet, SheetAction } from '../components';
import { Text, TextInput } from '../typography';
import { useTheme, formatSize } from '../theme';
import { KeyboardSafeView } from '../keyboard';
import { useTabInset } from '../tabInset';
import { lightFeedback } from '../haptics';
import * as FileSystem from 'expo-file-system/legacy';
import { previewDocument } from '../media/documentPreview';
import { PERM, can, type Community, type CommunityChannel, type CommunityMessage } from './types';
import { InviteCard } from './InviteCard';
import { ContextMenu, MenuItem, menuSurface } from '../ContextMenu';
import { REACTIONS } from '../messageMeta';
import { mentionsUser, setViewingChannel } from './unread';
import { inviteCodeFrom, withoutInviteLink } from './types';

const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/**
 * A text channel: Discord-style list (avatar, name in role colour, time, text) for game
 * servers; a post feed (large cards, the channel's picture and name as author) for blogs.
 */
export function ChannelChat({ api, me, store, community, channel, onOpenInvite }: { api: Api; me: User; store: MessengerStore; community: Community; channel: CommunityChannel; onOpenInvite: (code: string) => void }) {
  const t = useTheme(); const tabInset = useTabInset();
  const [messages, setMessages] = useState<CommunityMessage[]>([]); const [users, setUsers] = useState<Record<string, User>>({});
  const [hasMore, setHasMore] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [text, setText] = useState(''); const [sending, setSending] = useState(false); const [reply, setReply] = useState<CommunityMessage | null>(null);
  const [editing, setEditing] = useState<CommunityMessage | null>(null); const [menu, setMenu] = useState<CommunityMessage | null>(null); const [menuAt, setMenuAt] = useState<{ x?: number; y: number }>({ y: 0 }); const [hover, setHover] = useState<number | null>(null); const [mini, setMini] = useState<{ user: User; at: { x: number; y: number } } | null>(null); const [attach, setAttach] = useState(false);
  const [roleColors, setRoleColors] = useState<Record<string, string>>({});
  const blog = community.kind === 'blog';
  const canWrite = can(community, blog ? PERM.POST : PERM.SEND);
  const canModerate = can(community, PERM.MANAGE_MESSAGES);
  const loadingMore = useRef(false);
  // «Ответить» / «Изменить» put the cursor in the input right away.
  const input = useRef<React.ElementRef<typeof TextInput>>(null);

  const absorb = (list: User[]) => setUsers(current => { const next = { ...current }; for (const user of list) next[user.id] = user; return next; });
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const result = await api.channelMessages(community.id, channel.id); setMessages(result.messages); absorb(result.users); setHasMore(result.hasMore); if (result.messages.length) void api.readChannel(community.id, channel.id, result.messages[result.messages.length - 1].id).catch(() => {}); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить сообщения.'); }
    finally { setLoading(false); }
  }, [api, community.id, channel.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (reply || editing) setTimeout(() => input.current?.focus(), 250); }, [reply?.id, editing?.id]);
  // After the connection comes back: fetch what arrived meanwhile (merged, no duplicates), clear the
  // «no connection» notice and send what was queued offline. Before, the channel kept the gap until reopened.
  const [queued, setQueued] = useState<{ key: string; text: string; replyTo?: number }[]>([]);
  const queuedRef = useRef(queued); queuedRef.current = queued;
  const flushing = useRef(false);
  const flush = useCallback(async () => {
    if (flushing.current) return; flushing.current = true;
    try {
      while (queuedRef.current.length) {
        const item = queuedRef.current[0];
        const result = await api.sendChannelMessage(community.id, channel.id, { text: item.text, ...(item.replyTo ? { replyTo: item.replyTo } : {}) });
        setMessages(current => current.some(m => m.id === result.message.id) ? current : [...current, result.message]);
        queuedRef.current = queuedRef.current.slice(1); setQueued(queuedRef.current);
      }
    } catch { /* still offline: tried again on the next reconnect */ } finally { flushing.current = false; }
  }, [api, community.id, channel.id]);
  const lastConnection = useRef(store.connection);
  useEffect(() => {
    const was = lastConnection.current; lastConnection.current = store.connection;
    if (store.connection !== 'connected' || was === 'connected') return;
    api.channelMessages(community.id, channel.id).then(result => {
      absorb(result.users); setError('');
      setMessages(current => { const all = new Map(current.map(m => [m.id, m])); for (const m of result.messages) all.set(m.id, m); return [...all.values()].sort((a, b) => a.id - b.id); });
    }).catch(() => {});
    void flush();
  }, [store.connection, api, community.id, channel.id, flush]);
  // While this channel is open its new messages are read as they arrive (no badge bump).
  useEffect(() => { setViewingChannel(channel.id); return () => setViewingChannel(null); }, [channel.id]);
  // Role colours for author names (Discord: the highest coloured role).
  useEffect(() => {
    if (blog) return;
    api.communityMembers(community.id).then(result => {
      const roles = [...community.roles].filter(role => !role.isDefault).sort((a, b) => b.position - a.position);
      const map: Record<string, string> = {};
      for (const member of result.members) { const top = roles.find(role => member.roleIds.includes(role.id)); if (top) map[member.user.id] = top.color; absorb([member.user]); }
      setRoleColors(map);
    }).catch(() => {});
  }, [api, community.id, community.roles, blog]);
  useEffect(() => store.onSocket(data => {
    if (data.communityId !== community.id) return;
    if (data.type === 'community.message' && data.message?.channelId === channel.id) {
      if (data.user) absorb([data.user]);
      setMessages(current => current.some(item => item.id === data.message.id) ? current.map(item => item.id === data.message.id ? data.message : item) : [...current, data.message]);
      if (!data.edited) void api.readChannel(community.id, channel.id, data.message.id).catch(() => {});
    } else if (data.type === 'community.message.deleted' && data.channelId === channel.id) setMessages(current => current.filter(item => item.id !== data.messageId));
  }), [store, community.id, channel.id, api]);

  const older = async () => {
    if (!hasMore || loadingMore.current || !messages.length) return;
    loadingMore.current = true;
    try { const result = await api.channelMessages(community.id, channel.id, messages[0].id); absorb(result.users); setMessages(current => [...result.messages, ...current]); setHasMore(result.hasMore); }
    catch { /* try again on next scroll */ } finally { loadingMore.current = false; }
  };
  const send = async () => {
    const value = text.trim(); if (!value || sending) return;
    setSending(true); setError('');
    try {
      if (editing) { const result = await api.editChannelMessage(community.id, channel.id, editing.id, value); setMessages(current => current.map(item => item.id === result.message.id ? result.message : item)); setEditing(null); }
      else if (store.connection !== 'connected') {
        // Offline: queue it (shown as «ожидает отправки») instead of leaving it in the field.
        const item = { key: `${Date.now()}-${Math.random()}`, text: value, ...(reply ? { replyTo: reply.id } : {}) };
        queuedRef.current = [...queuedRef.current, item]; setQueued(queuedRef.current); setReply(null);
      }
      else { const result = await api.sendChannelMessage(community.id, channel.id, { text: value, ...(reply ? { replyTo: reply.id } : {}) }); setMessages(current => current.some(item => item.id === result.message.id) ? current : [...current, result.message]); setReply(null); }
      setText(''); lightFeedback();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отправить.'); }
    finally { setSending(false); }
  };
  const upload = async (kind: 'media' | 'file') => {
    setAttach(false); setError('');
    try {
      let file: { uri: string; name: string; mimeType: string; size?: number } | null = null;
      if (kind === 'media') {
        if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('Разреши доступ к фото в настройках устройства.'); }
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.9, exif: false, videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
        const asset = result.canceled ? null : result.assets[0];
        if (asset) file = { uri: asset.uri, name: asset.fileName || (asset.type === 'video' ? 'video.mp4' : 'photo.jpg'), mimeType: asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'), size: asset.fileSize };
      } else {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
        const asset = result.canceled ? null : result.assets[0];
        if (asset) file = { uri: asset.uri, name: asset.name, mimeType: asset.mimeType || 'application/octet-stream', size: asset.size };
      }
      if (!file) return;
      setSending(true);
      const uploaded = await api.uploadChannelFile(file);
      const result = await api.sendChannelMessage(community.id, channel.id, { attachmentId: uploaded.id, ...(text.trim() ? { text: text.trim() } : {}) });
      setMessages(current => current.some(item => item.id === result.message.id) ? current : [...current, result.message]); setText('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отправить файл.'); }
    finally { setSending(false); }
  };
  const remove = async (message: CommunityMessage) => {
    setMenu(null);
    try { await api.deleteChannelMessage(community.id, channel.id, message.id); setMessages(current => current.filter(item => item.id !== message.id)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось удалить.'); }
  };

  const menuBg = menuSurface(t);
  const react = async (message: CommunityMessage, emoji: string) => {
    setMenu(null); lightFeedback();
    try { const result = await api.reactChannelMessage(community.id, channel.id, message.id, emoji); setMessages(current => current.map(item => item.id === message.id ? result.message : item)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось поставить реакцию.'); }
  };
  const openMenu = (message: CommunityMessage, y: number, x?: number) => { setMenuAt({ x, y }); setMenu(message); };
  const data = useMemo(() => [...messages].reverse(), [messages]);
  const byId = useMemo(() => new Map(messages.map(item => [item.id, item])), [messages]);
  const render = ({ item, index }: { item: CommunityMessage; index: number }) => {
    const older = data[index + 1];
    const author = users[item.senderId];
    const grouped = !blog && older && older.senderId === item.senderId && Date.parse(item.createdAt) - Date.parse(older.createdAt) < 7 * 60_000;
    const newDay = !older || new Date(older.createdAt).toDateString() !== new Date(item.createdAt).toDateString();
    const replied = item.replyTo ? byId.get(item.replyTo) : null;
    // Discord: a message that mentions you or answers you stands out.
    const forMe = item.senderId !== me.id && (mentionsUser(item.text, me.username) || replied?.senderId === me.id);
    const invite = inviteCodeFrom(item.text); const shownText = invite ? withoutInviteLink(item.text) : item.text;
    const body = <>
      {replied ? <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', marginBottom: 3 }}><Icon name="return-down-forward" size={13} color={t.subtle} /><Text numberOfLines={1} style={{ flex: 1, color: t.muted, fontSize: 13 }}><Text style={{ fontWeight: '600', color: t.muted }}>{users[replied.senderId]?.displayName || 'Участник'}</Text> {replied.text || 'Вложение'}</Text></View> : null}
      {shownText ? <Text selectable style={{ color: t.text, fontSize: blog ? 16 : 15.5, lineHeight: blog ? 23 : 21 }}>{linkify(shownText, t.accent)}{item.editedAt ? <Text style={{ color: t.subtle, fontSize: 11 }}> (изм.)</Text> : null}</Text> : null}
      {item.attachment ? <ChannelAttachment api={api} attachment={item.attachment} wide={blog} /> : null}
      {invite ? <View style={{ marginTop: 6 }}><InviteCard api={api} code={invite} onOpen={onOpenInvite} /></View> : null}
      {item.reactions?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>{item.reactions.map(r => { const mine = r.userIds.includes(me.id); return <Pressable key={r.emoji} onPress={() => void react(item, r.emoji)} accessibilityRole="button" accessibilityLabel={`${r.emoji} ${r.count}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, height: 26, borderRadius: 13, backgroundColor: mine ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: mine ? t.accent : t.border }}><Text raw style={{ fontSize: 14 }}>{r.emoji}</Text><Text style={{ color: mine ? t.accent : t.muted, fontSize: 12, fontWeight: '600' }}>{r.count}</Text></Pressable>; })}</View> : null}
    </>;
    return <View>
      {newDay ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 12, paddingHorizontal: 14 }}><View style={{ flex: 1, height: 1, backgroundColor: t.border }} /><Text style={{ color: t.muted, fontSize: 11, fontWeight: '600' }}>{day(item.createdAt)}</Text><View style={{ flex: 1, height: 1, backgroundColor: t.border }} /></View> : null}
      <ChannelRow onContext={(x, y) => openMenu(item, y, x)} onHover={on => setHover(on ? item.id : current => current === item.id ? null : current)} toolbar={hover === item.id && Platform.OS === 'web' ? <View style={{ position: 'absolute', top: -16, right: 14, zIndex: 3, flexDirection: 'row', borderRadius: 10, padding: 2, backgroundColor: menuBg, borderWidth: 1, borderColor: t.border }}>{['👍', '❤️', '😂'].map(e => <Pressable key={e} onPress={() => void react(item, e)} accessibilityLabel={`Реакция ${e}`} style={{ width: 30, height: 28, alignItems: 'center', justifyContent: 'center' }}><Text raw style={{ fontSize: 16 }}>{e}</Text></Pressable>)}{canWrite ? <Pressable onPress={() => setReply(item)} accessibilityLabel="Ответить" style={{ width: 30, height: 28, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-undo-outline" size={17} color={t.text} /></Pressable> : null}<Pressable onPress={(e: any) => openMenu(item, e.nativeEvent.pageY, e.nativeEvent.pageX)} accessibilityLabel="Ещё" style={{ width: 30, height: 28, alignItems: 'center', justifyContent: 'center' }}><Icon name="ellipsis-horizontal" size={17} color={t.text} /></Pressable></View> : null}>
      <Pressable onLongPress={(e: any) => { lightFeedback(); openMenu(item, e.nativeEvent.pageY); }} delayLongPress={350} style={({ pressed }) => ({ backgroundColor: pressed ? t.accentSoft : forMe ? 'rgba(245,197,66,0.10)' : 'transparent', borderLeftWidth: forMe ? 2 : 0, borderLeftColor: '#F5C542' })}>
        {blog ? <View style={{ marginHorizontal: 12, marginVertical: 6, padding: 14, borderRadius: 18, backgroundColor: t.incoming, gap: 6 }}>
          {body}
          <Text style={{ color: t.subtle, fontSize: 11, alignSelf: 'flex-end' }}>{time(item.createdAt)}</Text>
        </View> : <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingTop: grouped ? 1 : 10, paddingBottom: 2 }}>
          <View style={{ width: 40 }}>{!grouped && author ? <Pressable onPress={(e: any) => setMini({ user: author, at: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY } })} accessibilityRole="button" accessibilityLabel={`Профиль ${author.displayName}`}><Avatar user={author} api={api} size={40} /></Pressable> : null}</View>
          <View style={{ flex: 1, gap: 2 }}>
            {!grouped ? <Pressable disabled={!author} onPress={(e: any) => author && setMini({ user: author, at: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY } })} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, alignSelf: 'flex-start' }}>{author && hasPlatina(author) && !roleColors[item.senderId] ? <PlatinaName user={author} animated={false} style={{ flexShrink: 1, fontSize: 15, fontWeight: '700' }} /> : <Text numberOfLines={1} style={{ flexShrink: 1, color: roleColors[item.senderId] || t.text, fontSize: 15, fontWeight: '700' }}>{author?.displayName || 'Участник'}</Text>}{author && hasPlatina(author) ? <PlatinaGem size={10} /> : null}{item.senderId === community.ownerId ? <Icon name="ribbon" size={13} color="#F5C542" /> : null}<Text style={{ color: t.subtle, fontSize: 11 }}>{time(item.createdAt)}</Text></Pressable> : null}
            {body}
          </View>
        </View>}
      </Pressable>
      </ChannelRow>
    </View>;
  };

  return <KeyboardSafeView bottomInset={tabInset} style={{ flex: 1 }}>
    {error ? <View style={{ padding: 10 }}><Notice text={error} error onRetry={messages.length ? undefined : () => void load()} /></View> : null}
    {loading && !messages.length ? <ActivityIndicator color={t.accent} style={{ marginTop: 40 }} /> :
      <FlatList keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} keyboardShouldPersistTaps="handled" inverted data={data} keyExtractor={item => String(item.id)} renderItem={render} onEndReached={() => void older()} onEndReachedThreshold={0.4} contentContainerStyle={{ paddingVertical: 8, flexGrow: 1 }}
        ListEmptyComponent={<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, transform: [{ scaleY: -1 }] }}><Icon name={blog ? 'megaphone-outline' : 'chatbubbles-outline'} size={40} color={t.subtle} /><Text style={{ color: t.text, fontSize: 18, fontWeight: '700', marginTop: 10 }}>{blog ? 'Пока нет публикаций' : `Это начало #${channel.name}`}</Text><Text style={{ color: t.muted, fontSize: 14, textAlign: 'center', marginTop: 4 }}>{blog ? (canWrite ? 'Напиши первый пост — его увидят все подписчики.' : 'Новые посты появятся здесь.') : 'Напиши что-нибудь, чтобы начать разговор.'}</Text></View>} />}
    {canWrite ? <View style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: 8, gap: 6 }}>
      {queued.map(item => <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-end', maxWidth: '85%', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: t.surface2, opacity: .75 }}><Icon name="time-outline" size={14} color={t.muted} /><Text numberOfLines={2} style={{ flexShrink: 1, color: t.text, fontSize: 14 }}>{item.text}</Text><Text style={{ color: t.muted, fontSize: 11 }}>ожидает отправки</Text></View>)}
      {reply || editing ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}><Icon name={editing ? 'create-outline' : 'return-down-forward'} size={16} color={t.accent} /><Text numberOfLines={1} style={{ flex: 1, color: t.muted, fontSize: 13 }}>{editing ? 'Редактирование' : `Ответ ${users[reply!.senderId]?.displayName || ''}: ${reply!.text || 'вложение'}`}</Text><IconButton name="close" label="Отменить" size={18} onPress={() => { setReply(null); if (editing) { setEditing(null); setText(''); } }} /></View> : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
        {!editing ? <IconButton name="add-circle" label="Прикрепить" color={t.muted} onPress={() => setAttach(true)} /> : null}
        <View style={{ flex: 1, minHeight: 40, borderRadius: 20, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, paddingHorizontal: 14, justifyContent: 'center' }}>
          <TextInput ref={input} value={text} onChangeText={setText} multiline onKeyPress={e => { if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !(e.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey) { e.preventDefault(); void send(); } }} placeholder={blog ? 'Новая публикация' : `Написать в #${channel.name}`} placeholderTextColor={t.subtle} style={{ color: t.text, fontSize: 16, maxHeight: 140, paddingVertical: 9 }} />
        </View>
        {sending ? <ActivityIndicator color={t.accent} style={{ width: 40, height: 40 }} /> : <IconButton name="arrow-up-circle" label="Отправить" color={text.trim() ? t.accent : t.subtle} size={34} disabled={!text.trim()} onPress={() => void send()} />}
      </View>
    </View> : <View style={{ padding: 14, alignItems: 'center' }}><Text style={{ color: t.muted, fontSize: 13 }}>{blog ? 'Публикуют только авторы канала.' : 'В этом канале нельзя писать.'}</Text></View>}
    <Sheet visible={attach} title="Прикрепить" onClose={() => setAttach(false)}>
      <SheetAction icon="images-outline" label="Фото или видео" onPress={() => void upload('media')} />
      <SheetAction icon="document-outline" label="Файл" onPress={() => void upload('file')} />
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, marginTop: 8 }}>Каналы не шифруются сквозным шифрованием: файл увидят все, у кого есть доступ к каналу.</Text>
    </Sheet>
    <ContextMenu visible={!!menu} y={menuAt.y} x={menuAt.x} onClose={() => setMenu(null)} preview={menu?.text || menu?.attachment?.name || ''} mine={menu?.senderId === me.id}
      reactions={menu ? REACTIONS.slice(0, 7).map(emoji => ({ emoji, chosen: !!menu.reactions?.some(r => r.emoji === emoji && r.userIds.includes(me.id)) })) : undefined} onReact={emoji => { if (menu) void react(menu, emoji); }}>
      {menu && canWrite ? <MenuItem icon="arrow-undo-outline" label="Ответить" onPress={() => { setReply(menu); setMenu(null); }} /> : null}
      {menu?.text ? <MenuItem icon="copy-outline" label="Скопировать" onPress={() => { void Clipboard.setStringAsync(menu.text); setMenu(null); }} /> : null}
      {menu && menu.senderId === me.id && menu.text ? <MenuItem icon="create-outline" label="Изменить" onPress={() => { setEditing(menu); setText(menu.text); setMenu(null); }} /> : null}
      {menu && (menu.senderId === me.id || canModerate) ? <MenuItem icon="trash-outline" label="Удалить" danger separated onPress={() => void remove(menu)} /> : null}
    </ContextMenu>
    <MiniProfile api={api} user={mini?.user || null} me={me.id} at={mini?.at} onClose={() => setMini(null)} />
  </KeyboardSafeView>;
}

function ChannelAttachment({ api, attachment, wide }: { api: Api; attachment: NonNullable<CommunityMessage['attachment']>; wide: boolean }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  // Channel files are plain (not E2EE): download once into the cache and open in the system viewer.
  const open = async () => {
    if (busy || Platform.OS === 'web') return; setBusy(true);
    try {
      const folder = `${FileSystem.cacheDirectory}channel-files/${attachment.id}/`;
      const target = `${folder}${attachment.name.replace(/[\\/:*?"<>|]/g, '_') || 'file'}`;
      const info = await FileSystem.getInfoAsync(target);
      if (!info.exists) { await FileSystem.makeDirectoryAsync(folder, { intermediates: true }); await FileSystem.downloadAsync(api.fileUrl(attachment.id), target, { headers: { Authorization: `Bearer ${api.token}` } }); }
      await previewDocument(target, attachment.mimeType);
    } catch { /* stays tappable */ } finally { setBusy(false); }
  };
  if (attachment.mimeType.startsWith('image/')) return <Pressable onPress={() => void open()} style={{ marginTop: 4 }}><AuthImage api={api} id={attachment.id} style={{ width: wide ? '100%' as never : 240, height: wide ? 240 : 180, borderRadius: 12 }} /></Pressable>;
  return <Pressable onPress={() => void open()} style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, backgroundColor: t.surface2, maxWidth: 300 }}>
    <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}>{busy ? <ActivityIndicator color={t.accent} /> : <Icon name={attachment.mimeType.startsWith('video/') ? 'videocam' : 'document'} color={t.accent} size={20} />}</View>
    <View style={{ flex: 1 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{attachment.name}</Text><Text style={{ color: t.muted, fontSize: 12 }}>{formatSize(attachment.size)}</Text></View>
  </Pressable>;
}

/** One channel message row; on PC a right click opens the menu at the cursor and hovering shows a toolbar. */
function ChannelRow({ onContext, onHover, toolbar, children }: { onContext: (x: number, y: number) => void; onHover: (on: boolean) => void; toolbar: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<View>(null);
  const handlers = useRef({ onContext, onHover }); handlers.current = { onContext, onHover };
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = ref.current as unknown as HTMLElement | null; if (!node?.addEventListener) return;
    const menu = (e: MouseEvent) => { e.preventDefault(); handlers.current.onContext(e.clientX, e.clientY); };
    const enter = () => handlers.current.onHover(true), leave = () => handlers.current.onHover(false);
    node.addEventListener('contextmenu', menu); node.addEventListener('mouseenter', enter); node.addEventListener('mouseleave', leave);
    return () => { node.removeEventListener('contextmenu', menu); node.removeEventListener('mouseenter', enter); node.removeEventListener('mouseleave', leave); };
  }, []);
  return <View ref={ref}>{toolbar}{children}</View>;
}
