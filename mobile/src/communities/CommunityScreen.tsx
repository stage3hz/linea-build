import { ScreenSharePanel } from './ScreenSharePanel';
import React, { useSyncExternalStore, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Share, View } from 'react-native';
import { audioPrefs, comboLabel, subscribeAudio } from '../audio/devices';
import { setPushToTalk } from '../audio/gate';
import { setOverlayNames } from '../overlay/sync';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import type { Api } from '../api';
import type { User } from '../types';
import type { MessengerStore } from '../useMessenger';
import { Avatar, Icon, IconButton, Notice, Sheet, SheetAction } from '../components';
import { GlassBackdrop, GlassSurface } from '../glass';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { StackBase, StackScreen } from '../stack';
import { ChannelChat } from './ChannelChat';
import { CommunitySettings } from './CommunitySettings';
import { CommunityAvatar, members, subscribers } from './parts';
import { PERM, can, type Community, type CommunityChannel, type VoiceMember } from './types';
import { setCommunityChannels, useChannelCounts } from './unread';
import { badgeText } from '../unreadBadge';
import { ContextMenu } from '../ContextMenu';
import { MemberMenuItems, hasMemberActions, type MemberTarget } from './MemberMenu';
import { joinVoice, leaveVoice, toggleVoiceMute, toggleVoiceSpeaker, toggleVoiceDeafen, useVoice, voiceAvailable } from './voice';
import { useTabInset } from '../tabInset';

// On a wide screen the list stays a column (like Discord / Telegram) so counters sit next to the names.
export const LIST_WIDTH = 400;
type Pushed = { kind: 'channel'; channel: CommunityChannel } | { kind: 'settings' } | null;

/** A community: Discord-style channel list for game servers, the post feed for blogs. */
export function CommunityScreen({ api, me, store, communityId, onBack, onOpenInvite, onLeft }: { api: Api; me: User; store: MessengerStore; communityId: string; onBack: () => void; onOpenInvite: (code: string) => void; onLeft: () => void }) {
  const tabInset = useTabInset();
  const t = useTheme(); const insets = useSafeAreaInsets(); const voice = useVoice();
  const audioMode = useSyncExternalStore(subscribeAudio, () => audioPrefs().inputMode, () => 'activity');
  const [community, setCommunity] = useState<Community | null>(null); const [error, setError] = useState('');
  const [people, setPeople] = useState<Record<string, User>>({}); const [pushed, setPushed] = useState<Pushed>(null);
  const [inviteOpen, setInviteOpen] = useState(false); const [inviteLink, setInviteLink] = useState(''); const [copied, setCopied] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [memberMenu, setMemberMenu] = useState<(MemberTarget & { x?: number; y: number }) | null>(null);
  const progress = useSharedValue(1);

  const load = useCallback(async () => {
    try { const next = (await api.community(communityId)).community; setCommunity(next); setCommunityChannels(next.id, next.channels); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось открыть.'); }
  }, [api, communityId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.communityMembers(communityId).then(result => { setPeople(Object.fromEntries(result.members.map(item => [item.user.id, item.user]))); setOverlayNames(Object.fromEntries(result.members.map(item => [item.user.id, item.user.displayName]))); }).catch(() => {}); }, [api, communityId]);
  useEffect(() => store.onSocket(data => {
    if (data.communityId !== communityId && data.community?.id !== communityId) return;
    if (data.type === 'community.channels' || data.type === 'community') void load();
    else if (data.type === 'community.removed') onLeft();
    else if (data.type === 'voice.state') setCommunity(current => current ? { ...current, channels: current.channels.map(item => item.id === data.channelId ? { ...item, voice: data.members as VoiceMember[] } : item) } : current);
  }), [store, communityId, load, onLeft]);

  const blog = community?.kind === 'blog';
  const groups = useMemo(() => {
    const map = new Map<string, CommunityChannel[]>();
    for (const item of community?.channels || []) { const key = item.category || (item.kind === 'voice' ? 'Голосовые каналы' : 'Текстовые каналы'); map.set(key, [...(map.get(key) || []), item]); }
    return [...map.entries()];
  }, [community?.channels]);

  const invite = async () => {
    if (!community) return;
    try { const { invite } = await api.createInvite(community.id); setInviteLink(api.inviteUrl(invite.code)); setInviteOpen(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось создать ссылку.'); }
  };
  const enterVoice = async (channel: CommunityChannel) => {
    if (!community) return; setVoiceError('');
    if (voice?.channelId === channel.id) return;
    try { await joinVoice(api, store, { communityId: community.id, communityName: community.name, channelId: channel.id, channelName: channel.name, userId: me.id }); }
    catch (failure) { setVoiceError(failure instanceof Error ? failure.message : 'Не удалось подключиться.'); }
  };

  const header = (title: string, subtitle: string, back: () => void, right?: React.ReactNode) => <GlassSurface lens radius={27} style={{ margin: 12, marginBottom: 6 }} contentStyle={{ padding: 8, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 60 }}>
    <IconButton name="chevron-back" label="Назад" onPress={back} />
    {community ? <CommunityAvatar api={api} community={community} size={38} /> : null}
    <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>{title}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>{subtitle}</Text></View>
    {right}
  </GlassSurface>;

  if (!community) return <View style={{ flex: 1 }}>{header('Загрузка…', '', onBack)}{error ? <View style={{ padding: 14 }}><Notice text={error} error onRetry={() => void load()} /></View> : <ActivityIndicator color={t.accent} style={{ marginTop: 40 }} />}</View>;
  const count = blog ? subscribers(community.memberCount) : members(community.memberCount);
  const tools = <>
    {can(community, PERM.INVITE) ? <IconButton name="person-add-outline" label="Пригласить" onPress={() => void invite()} /> : null}
    <IconButton name="settings-outline" label="Настройки" onPress={() => setPushed({ kind: 'settings' })} />
  </>;

  const root = blog ? <View style={{ flex: 1 }}>
    {header(community.name, count, onBack, tools)}
    {community.channels[0] ? <ChannelChat api={api} me={me} store={store} community={community} channel={community.channels[0]} onOpenInvite={onOpenInvite} /> : null}
  </View> : <View style={{ flex: 1 }}>
    {header(community.name, count, onBack, tools)}
    {error ? <View style={{ paddingHorizontal: 12 }}><Notice text={error} error /></View> : null}
    {voiceError ? <View style={{ paddingHorizontal: 12 }}><Notice text={voiceError} error /></View> : null}
    <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 30 + insets.bottom + tabInset, gap: 16, width: '100%', maxWidth: LIST_WIDTH }}>
      {community.description ? <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20, paddingHorizontal: 6 }}>{community.description}</Text> : null}
      {groups.map(([category, channels]) => <View key={category} style={{ gap: 4 }}>
        <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 8, paddingBottom: 2 }}>{category.toUpperCase()}</Text>
        {channels.map(channel => {
          const inside = voice?.channelId === channel.id;
          const locked = channel.roleIds.length > 0;
          return <View key={channel.id}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${channel.kind === 'voice' ? 'Голосовой' : 'Текстовый'} канал ${channel.name}`} onPress={() => channel.kind === 'voice' ? void enterVoice(channel) : setPushed({ kind: 'channel', channel })}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 10, borderRadius: 12, backgroundColor: inside ? 'rgba(47,210,122,0.12)' : pressed ? t.accentSoft : 'transparent' })}>
              <Icon name={channel.kind === 'voice' ? 'volume-medium' : 'chatbox-ellipses-outline'} size={19} color={inside ? '#2FD27A' : t.muted} />
              {channel.kind === 'text' ? <TextChannelLabel channel={channel} locked={locked} /> : <><Text numberOfLines={1} style={{ flex: 1, color: inside ? '#2FD27A' : t.text, fontSize: 16, fontWeight: inside ? '700' : '500' }}>{channel.name}</Text>{locked ? <Icon name="lock-closed" size={13} color={t.subtle} /> : null}</>}
              {channel.kind === 'voice' && channel.voice?.length ? <Text style={{ color: t.muted, fontSize: 12 }}>{channel.voice.length}/12</Text> : null}
            </Pressable>
            {channel.kind === 'voice' && channel.voice?.length ? <View style={{ paddingLeft: 40, gap: 4, paddingBottom: 4 }}>{channel.voice.map(item => {
              const person = people[item.userId];
              const target: MemberTarget = { userId: item.userId, name: person?.displayName || 'Участник', serverMuted: item.serverMuted, serverDeafened: item.serverDeafened, inVoice: true };
              const actions = hasMemberActions(community, me.id, item.userId);
              return <Pressable key={item.userId} disabled={!actions} onPress={(e: any) => setMemberMenu({ ...target, y: e.nativeEvent.pageY, x: Platform.OS === 'web' ? e.nativeEvent.pageX : undefined })}
                accessibilityRole={actions ? 'button' : undefined} accessibilityLabel={actions ? `Действия: ${target.name}` : undefined}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 8, paddingVertical: 2, paddingHorizontal: 4, backgroundColor: pressed ? t.accentSoft : 'transparent' })}>
                {person ? <Avatar user={person} api={api} size={24} /> : <View style={{ width: 24, height: 24, borderRadius: 9, backgroundColor: t.surface2 }} />}
                <Text numberOfLines={1} style={{ flex: 1, color: t.muted, fontSize: 14 }}>{target.name}{item.userId === me.id ? ' (ты)' : ''}</Text>
                {item.serverDeafened ? <Icon name="volume-mute" size={14} color={t.danger} /> : null}
                {item.serverMuted ? <Icon name="mic-off" size={14} color={t.danger} /> : item.muted ? <Icon name="mic-off" size={14} color={t.subtle} /> : null}
              </Pressable>;
            })}</View> : null}
          </View>;
        })}
      </View>)}
      {voice && voice.communityId === community.id ? <GlassSurface radius={20} shadow={false} contentStyle={{ padding: 14, gap: 12 }}>
        <Text style={{ color: '#2FD27A', fontSize: 14, fontWeight: '700' }}>{voice.status === 'connected' ? `Ты в канале «${voice.channelName}»` : 'Подключение…'}</Text>
        <ScreenSharePanel people={people}/>
        {Platform.OS === 'web' && audioMode === 'ptt' && voice.status === 'connected' ? <PushToTalkButton /> : null}
        {voice.status === 'connected' && !voice.peers.length ? <Text style={{ color: t.muted, fontSize: 13 }}>Пока никого — позови друзей.</Text> : null}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <VoiceButton icon={voice.muted ? 'mic-off' : 'mic'} label={voice.muted ? 'Микрофон выкл.' : 'Микрофон'} active={!voice.muted} onPress={toggleVoiceMute} />
          <VoiceButton icon={voice.deafened ? 'volume-mute' : 'headset'} label={voice.deafened ? 'Звук выкл.' : 'Звук'} active={!voice.deafened} onPress={toggleVoiceDeafen} />
          {Platform.OS !== 'web' ? <VoiceButton icon={voice.speaker ? 'volume-high' : 'ear'} label={voice.speaker ? 'Динамик' : 'Телефон'} active={voice.speaker} onPress={toggleVoiceSpeaker} /> : null}
          <VoiceButton icon="call" label="Выйти" danger onPress={leaveVoice} />
        </View>
      </GlassSurface> : null}
      {!voiceAvailable() ? <Text style={{ color: t.subtle, fontSize: 12, textAlign: 'center' }}>Голосовые каналы работают в приложении Android/iPhone.</Text> : null}
    </ScrollView>
  </View>;

  const child = pushed?.kind === 'channel' ? <View style={{ flex: 1 }}>
    {header(`# ${pushed.channel.name}`, pushed.channel.topic || community.name, () => setPushed(null))}
    <ChannelChat api={api} me={me} store={store} community={community} channel={community.channels.find(item => item.id === pushed.channel.id) || pushed.channel} onOpenInvite={onOpenInvite} />
  </View> : pushed?.kind === 'settings' ? <CommunitySettings api={api} me={me} community={community} onBack={() => setPushed(null)} onChanged={setCommunity} onLeft={onLeft} onInvite={() => void invite()} /> : null;

  return <View style={{ flex: 1 }}>
    <StackBase progress={progress} covered={!!pushed}>{root}</StackBase>
    {pushed ? <StackScreen key={pushed.kind === 'channel' ? pushed.channel.id : 'settings'} progress={progress} onBack={() => setPushed(null)}>{() => <View style={{ flex: 1 }}><Backdrop />{child}</View>}</StackScreen> : null}
    {community ? <ContextMenu visible={!!memberMenu} y={memberMenu?.y || 0} x={memberMenu?.x} onClose={() => setMemberMenu(null)} preview={memberMenu?.name}>
      {memberMenu ? <MemberMenuItems api={api} community={community} me={me.id} target={memberMenu} onDone={() => setMemberMenu(null)} onError={setVoiceError} /> : null}
    </ContextMenu> : null}
    <Sheet visible={inviteOpen} title="Пригласить" onClose={() => { setInviteOpen(false); setCopied(false); }}>
      <View style={{ gap: 12 }}>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>Ссылка открывается и вне мессенджера: в браузере появится страница с кнопкой «Открыть в Инвиз». В чатах Инвиза ссылка показывается баннером с кнопкой «Принять приглашение».</Text>
        <Pressable onPress={() => { void Clipboard.setStringAsync(inviteLink); setCopied(true); }} style={{ padding: 13, borderRadius: 14, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border }}><Text selectable style={{ color: t.accent, fontSize: 14 }}>{inviteLink}</Text></Pressable>
        <SheetAction icon={copied ? 'checkmark' : 'copy-outline'} label={copied ? 'Скопировано' : 'Скопировать ссылку'} onPress={() => { void Clipboard.setStringAsync(inviteLink); setCopied(true); }} />
        <SheetAction icon="share-outline" label="Поделиться…" onPress={() => void Share.share({ message: inviteLink })} />
        <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 4 }}>ОТПРАВИТЬ В ЧАТ</Text>
        {store.chats.slice(0, 8).map(chat => <SheetAction key={chat.id} icon="paper-plane-outline" label={chat.peer.displayName} onPress={() => { store.send(chat.id, inviteLink, null); setInviteOpen(false); }} />)}
      </View>
    </Sheet>
  </View>;
}

function Backdrop() {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={{ position: 'absolute', top: -insets.top, bottom: -insets.bottom, left: 0, right: 0 }}><GlassBackdrop /></View>;
}

/** Рация on screen: hold to talk (same as the bound key). */
function PushToTalkButton() {
  const t = useTheme(); const [down, setDown] = useState(false);
  const press = (value: boolean) => { setDown(value); setPushToTalk(value); };
  useEffect(() => () => setPushToTalk(false), []);
  const key = audioPrefs().binds.find(b => b.enabled && b.action === 'ptt' && b.combo)?.combo || '';
  return <Pressable accessibilityRole="button" accessibilityLabel="Рация: удерживай, чтобы говорить" onPressIn={() => press(true)} onPressOut={() => press(false)}
    style={{ alignItems: 'center', paddingVertical: 14, borderRadius: 16, backgroundColor: down ? '#2FD27A' : 'rgba(127,127,127,0.16)' }}>
    <Text style={{ color: down ? '#062B16' : t.text, fontWeight: '700' }}>{down ? 'Тебя слышно…' : `Удерживай, чтобы говорить${key ? ` · ${comboLabel(key)}` : ''}`}</Text>
  </Pressable>;
}

function VoiceButton({ icon, label, onPress, active = false, danger = false }: { icon: React.ComponentProps<typeof Icon>['name']; label: string; onPress: () => void; active?: boolean; danger?: boolean }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ flex: 1, alignItems: 'center', gap: 6, paddingVertical: 10, borderRadius: 14, backgroundColor: danger ? t.danger : active ? t.accentSoft : t.surface2, opacity: pressed ? .7 : 1 })}>
    <Icon name={icon} size={20} color={danger ? '#FFF' : active ? t.accent : t.text} />
    <Text style={{ color: danger ? '#FFF' : t.text, fontSize: 12, fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}


/** Text channel name as in Discord: bold with a dot while unread, a counter pill for @mentions. */
function TextChannelLabel({ channel, locked }: { channel: CommunityChannel; locked: boolean }) {
  const t = useTheme(); const { unread, mentions } = useChannelCounts(channel.id);
  return <>
    {unread ? <View accessibilityElementsHidden importantForAccessibility="no" style={{ position: 'absolute', left: -2, width: 5, height: 9, borderRadius: 3, backgroundColor: t.text }} /> : null}
    <Text numberOfLines={1} accessibilityLabel={`${channel.name}${unread ? `, непрочитанных: ${unread}` : ''}${mentions ? `, упоминаний: ${mentions}` : ''}`} style={{ flexShrink: 1, color: unread ? t.text : t.muted, fontSize: 16, fontWeight: unread ? '700' : '500' }}>{`# ${channel.name}`}</Text>
    {locked ? <Icon name="lock-closed" size={13} color={t.subtle} /> : null}
    {/* The counter sits right after the name, where the eye already is. */}
    {mentions ? <View style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.onAccent, fontSize: 11, fontWeight: '800' }}>{badgeText(mentions)}</Text></View> : null}
    <View style={{ flex: 1 }} />
  </>;
}
