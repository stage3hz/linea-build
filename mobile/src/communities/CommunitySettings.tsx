import React, { useEffect, useState } from 'react';
import { Nameplate } from '../platina/Effects';
import { DecoratedAvatar } from '../platina/Decor';
import { ActivityIndicator, Platform, Pressable, ScrollView, Switch, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import type { Api } from '../api';
import type { User } from '../types';
import { Avatar, Button, Field, Icon, IconButton, Notice, Sheet, SheetAction } from '../components';
import { GlassSurface } from '../glass';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { CommunityAvatar, KindBadge } from './parts';
import { CATEGORIES, PERM, PERM_LABELS, can, type Community, type CommunityChannel, type CommunityMember, type CommunityRole } from './types';

const ROLE_COLORS = ['#3FA9F5', '#2EE6C8', '#2FD27A', '#F5C542', '#FF7A45', '#FF4D6A', '#B18CFF', '#8A9BB8'];
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** Community settings: profile, channels and who sees them, roles and their rights, members. */
export function CommunitySettings({ api, me, community, onBack, onChanged, onLeft, onInvite }: { api: Api; me: User; community: Community; onBack: () => void; onChanged: (community: Community) => void; onLeft: () => void; onInvite: () => void }) {
  const t = useTheme();
  const [name, setName] = useState(community.name); const [description, setDescription] = useState(community.description);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [members, setMembers] = useState<CommunityMember[] | null>(null);
  const [role, setRole] = useState<CommunityRole | 'new' | null>(null); const [channel, setChannel] = useState<CommunityChannel | 'text' | 'voice' | null>(null);
  const [member, setMember] = useState<CommunityMember | null>(null); const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);
  const blog = community.kind === 'blog'; const owner = community.ownerId === me.id;
  const reload = async () => { const next = (await api.community(community.id)).community; onChanged(next); return next; };
  const loadMembers = () => { api.communityMembers(community.id).then(result => setMembers(result.members)).catch(failure => setError(message(failure, 'Не удалось загрузить участников.'))); };
  useEffect(loadMembers, [api, community.id]);
  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return; setBusy(key); setError(''); setNotice('');
    try { await work(); if (done) setNotice(done); } catch (failure) { setError(message(failure, 'Не получилось.')); } finally { setBusy(''); }
  };
  const pickAvatar = () => run('avatar', async () => {
    if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('Разреши доступ к фото в настройках устройства.'); }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1, exif: false });
    const asset = result.canceled ? null : result.assets[0]; if (!asset) return;
    const small = await ImageManipulator.manipulateAsync(asset.uri, [{ resize: { width: 512 } }], { format: ImageManipulator.SaveFormat.JPEG, compress: .86 });
    try { const uploaded = await api.upload({ uri: small.uri, name: 'community.jpg', mimeType: 'image/jpeg' }); onChanged((await api.updateCommunity(community.id, { avatarId: uploaded.id })).community); }
    finally { await FileSystem.deleteAsync(small.uri, { idempotent: true }).catch(() => {}); }
  }, 'Фото обновлено.');

  const section = (title: string, children: React.ReactNode, action?: React.ReactNode) => <View style={{ gap: 7 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}><Text style={{ flex: 1, color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 }}>{title.toUpperCase()}</Text>{action}</View>
    <GlassSurface radius={20} shadow={false} contentStyle={{ paddingVertical: 4 }}>{children}</GlassSurface>
  </View>;
  const row = (key: string, icon: React.ComponentProps<typeof Icon>['name'], label: string, value: string | undefined, onPress: () => void, color?: string) => <Pressable key={key} onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingHorizontal: 14, opacity: pressed ? .6 : 1 })}>
    <Icon name={icon} size={19} color={color || t.muted} /><Text numberOfLines={1} style={{ flex: 1, color: color || t.text, fontSize: 15 }}>{label}</Text>{value ? <Text style={{ color: t.muted, fontSize: 13 }}>{value}</Text> : null}<Icon name="chevron-forward" size={16} color={t.subtle} />
  </Pressable>;

  return <View style={{ flex: 1 }}>
    <GlassSurface lens radius={27} style={{ margin: 12, marginBottom: 6 }} contentStyle={{ padding: 8, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 60 }}>
      <IconButton name="chevron-back" label="Назад" onPress={onBack} /><Text style={{ flex: 1, color: t.text, fontSize: 19, fontWeight: '700' }}>Настройки</Text>
    </GlassSurface>
    <ScrollView contentContainerStyle={{ padding: 14, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <View style={{ alignItems: 'center', gap: 10 }}>
        <Pressable disabled={!can(community, PERM.MANAGE_COMMUNITY)} onPress={() => void pickAvatar()}><CommunityAvatar api={api} community={community} size={86} /></Pressable>
        <KindBadge kind={community.kind} category={community.category} />
      </View>
      {error ? <Notice text={error} error /> : null}{notice ? <Notice text={notice} /> : null}
      {can(community, PERM.MANAGE_COMMUNITY) ? <GlassSurface radius={20} shadow={false} contentStyle={{ padding: 16, gap: 14 }}>
        <Field label="Название" value={name} onChangeText={setName} maxLength={60} />
        <Field label="Описание" value={description} onChangeText={setDescription} maxLength={500} multiline style={{ height: 80, textAlignVertical: 'top' }} />
        {community.kind === 'blog' ? <View style={{ gap: 8 }}><Text style={{ color: t.muted, fontSize: 12, fontWeight: '600' }}>О чём канал</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{CATEGORIES.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected: community.category === item.id }} disabled={!!busy} onPress={() => void run('category', async () => onChanged((await api.updateCommunity(community.id, { category: item.id })).community))} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: community.category === item.id ? t.accent : t.surface2 }}><Text style={{ color: community.category === item.id ? t.onAccent : t.text, fontSize: 13, fontWeight: '600' }}>{item.label}</Text></Pressable>)}</View></View> : null}
        <Button label="Сохранить" loading={busy === 'save'} disabled={!name.trim() || (name === community.name && description === community.description)} onPress={() => void run('save', async () => onChanged((await api.updateCommunity(community.id, { name: name.trim(), description: description.trim() })).community), 'Сохранено.')} />
      </GlassSurface> : null}
      {can(community, PERM.INVITE) ? section('Приглашения', row('invite', 'link-outline', 'Ссылка-приглашение', undefined, onInvite)) : null}
      {!blog && can(community, PERM.MANAGE_CHANNELS) ? section('Каналы', <>
        {community.channels.map(item => row(item.id, item.kind === 'voice' ? 'volume-medium-outline' : 'chatbox-ellipses-outline', item.kind === 'text' ? `# ${item.name}` : item.name, item.roleIds.length ? 'по ролям' : undefined, () => setChannel(item)))}
        {row('new-text', 'add', 'Текстовый канал', undefined, () => setChannel('text'), t.accent)}
        {row('new-voice', 'add', 'Голосовой канал', undefined, () => setChannel('voice'), t.accent)}
      </>) : null}
      {can(community, PERM.MANAGE_ROLES) ? section('Роли', <>
        {community.roles.map(item => row(item.id, item.isDefault ? 'people-outline' : 'shield-outline', item.name, item.isDefault ? 'все' : undefined, () => setRole(item), item.isDefault ? undefined : item.color))}
        {row('new-role', 'add', 'Новая роль', undefined, () => setRole('new'), t.accent)}
      </>) : null}
      {section(blog ? 'Подписчики' : 'Участники', !members ? <ActivityIndicator color={t.accent} style={{ padding: 16 }} /> : <>{members.map(item => <Pressable key={item.user.id} disabled={!can(community, PERM.MANAGE_ROLES) && !can(community, PERM.KICK)} onPress={() => setMember(item)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, overflow: 'hidden', opacity: pressed ? .6 : 1 })}>
        <Nameplate plate={item.user.nameplate} radius={14} />
        <DecoratedAvatar user={item.user} api={api} size={36} />
        <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: (community.roles.filter(r => item.roleIds.includes(r.id)).sort((a, b) => b.position - a.position)[0]?.color) || t.text, fontSize: 15, fontWeight: '600' }}>{item.user.displayName}{item.owner ? ' 👑' : ''}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>{community.roles.filter(r => item.roleIds.includes(r.id)).map(r => r.name).join(', ') || `@${item.user.username}`}</Text></View>
      </Pressable>)}</>)}
      {section('Сообщество', owner ? row('delete', 'trash-outline', 'Удалить сообщество', undefined, () => setConfirm('delete'), t.danger) : row('leave', 'exit-outline', blog ? 'Отписаться' : 'Покинуть сервер', undefined, () => setConfirm('leave'), t.danger))}
      <Text style={{ color: t.subtle, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingHorizontal: 10 }}>Каналы и серверы не шифруются сквозным шифрованием: сообщения хранятся на сервере Инвиза. Личные чаты по-прежнему зашифрованы.</Text>
    </ScrollView>

    <RoleSheet key={role === null ? 'none' : role === 'new' ? 'new' : role.id} api={api} community={community} role={role} owner={owner} onClose={() => setRole(null)} onSaved={async () => { setRole(null); await reload(); }} />
    <ChannelSheet key={channel === null ? 'none' : typeof channel === 'string' ? channel : channel.id} api={api} community={community} channel={channel} onClose={() => setChannel(null)} onSaved={async () => { setChannel(null); await reload(); }} />
    <Sheet visible={!!member} title={member?.user.displayName || ''} onClose={() => setMember(null)}>
      {member ? <View style={{ gap: 6 }}>
        {can(community, PERM.MANAGE_ROLES) ? community.roles.filter(item => !item.isDefault).map(item => {
          const on = member.roleIds.includes(item.id);
          return <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: item.color }} /><Text style={{ flex: 1, color: t.text, fontSize: 15 }}>{item.name}</Text>
            <Switch value={on} disabled={!!busy} onValueChange={value => void run('roles', async () => {
              const next = value ? [...member.roleIds, item.id] : member.roleIds.filter(id => id !== item.id);
              const result = await api.setMemberRoles(community.id, member.user.id, next);
              setMember({ ...member, roleIds: result.roleIds }); loadMembers();
            })} trackColor={{ false: t.subtle, true: t.accent }} thumbColor="#FFF" />
          </View>;
        }) : null}
        {can(community, PERM.KICK) && !member.owner && member.user.id !== me.id ? <SheetAction icon="person-remove-outline" label="Исключить" danger onPress={() => void run('kick', async () => { await api.kickMember(community.id, member.user.id); setMember(null); loadMembers(); }, 'Участник исключён.')} /> : null}
      </View> : null}
    </Sheet>
    <Sheet visible={!!confirm} title={confirm === 'delete' ? 'Удалить сообщество?' : blog ? 'Отписаться?' : 'Покинуть сервер?'} onClose={() => setConfirm(null)}>
      <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20, marginBottom: 16 }}>{confirm === 'delete' ? 'Каналы, сообщения и приглашения удалятся у всех. Это нельзя отменить.' : 'Вернуться можно по ссылке-приглашению.'}</Text>
      <Button label={confirm === 'delete' ? 'Удалить' : 'Выйти'} danger loading={busy === 'exit'} onPress={() => void run('exit', async () => { if (confirm === 'delete') await api.deleteCommunity(community.id); else await api.leaveCommunity(community.id); setConfirm(null); onLeft(); })} />
    </Sheet>
  </View>;
}

function RoleSheet({ api, community, role, owner, onClose, onSaved }: { api: Api; community: Community; role: CommunityRole | 'new' | null; owner: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useTheme(); const current = role && role !== 'new' ? role : null;
  const [name, setName] = useState(current?.name || ''); const [color, setColor] = useState(current?.color || ROLE_COLORS[0]); const [perms, setPerms] = useState(current?.perms ?? (PERM.SEND | PERM.VOICE));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const labels = PERM_LABELS.filter(item => community.kind === 'blog' ? !item.server : !item.blog).filter(item => owner || item.bit !== PERM.ADMIN);
  const save = async () => {
    setBusy(true); setError('');
    try { if (current) await api.updateRole(community.id, current.id, { ...(current.isDefault ? {} : { name: name.trim(), color }), perms }); else await api.createRole(community.id, { name: name.trim() || 'Новая роль', color, perms }); onSaved(); }
    catch (failure) { setError(message(failure, 'Не удалось сохранить роль.')); } finally { setBusy(false); }
  };
  return <Sheet visible={role !== null} title={current ? (current.isDefault ? `Права: ${current.name}` : 'Роль') : 'Новая роль'} onClose={onClose}>
    <View style={{ gap: 12 }}>
      {!current?.isDefault ? <><Field label="Название" value={name} onChangeText={setName} maxLength={32} placeholder="Например, Ветераны" />
        <View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap' }}>{ROLE_COLORS.map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: color === value }} onPress={() => setColor(value)} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: value, borderWidth: 3, borderColor: color === value ? t.text : 'transparent' }} />)}</View></> : <Text style={{ color: t.muted, fontSize: 13 }}>Эти права есть у всех участников.</Text>}
      {labels.map(item => <View key={item.bit} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 10 }}>
        <Text style={{ flex: 1, color: t.text, fontSize: 15 }}>{item.label}</Text>
        <Switch value={(perms & item.bit) !== 0} onValueChange={value => setPerms(current => value ? current | item.bit : current & ~item.bit)} trackColor={{ false: t.subtle, true: t.accent }} thumbColor="#FFF" />
      </View>)}
      {error ? <Notice text={error} error /> : null}
      <Button label="Сохранить" loading={busy} onPress={() => void save()} />
      {current && !current.isDefault ? <Button label="Удалить роль" danger secondary disabled={busy} onPress={() => void (async () => { setBusy(true); try { await api.deleteRole(community.id, current.id); onSaved(); } catch (failure) { setError(message(failure, 'Не удалось удалить.')); } finally { setBusy(false); } })()} /> : null}
    </View>
  </Sheet>;
}

function ChannelSheet({ api, community, channel, onClose, onSaved }: { api: Api; community: Community; channel: CommunityChannel | 'text' | 'voice' | null; onClose: () => void; onSaved: () => void }) {
  const t = useTheme(); const current = channel && typeof channel !== 'string' ? channel : null; const kind = current?.kind || (channel === 'voice' ? 'voice' : 'text');
  const [name, setName] = useState(current?.name || ''); const [topic, setTopic] = useState(current?.topic || ''); const [roleIds, setRoleIds] = useState<string[]>(current?.roleIds || []);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { if (current) await api.updateChannel(community.id, current.id, { name: name.trim(), topic: topic.trim(), roleIds }); else await api.createChannel(community.id, { kind, name: name.trim(), topic: topic.trim(), roleIds }); onSaved(); }
    catch (failure) { setError(message(failure, 'Не удалось сохранить канал.')); } finally { setBusy(false); }
  };
  return <Sheet visible={channel !== null} title={current ? 'Канал' : kind === 'voice' ? 'Новый голосовой канал' : 'Новый текстовый канал'} onClose={onClose}>
    <View style={{ gap: 12 }}>
      <Field label="Название" value={name} onChangeText={setName} maxLength={40} placeholder={kind === 'voice' ? 'Например, Катка' : 'например, мемы'} />
      {kind === 'text' ? <Field label="Тема" value={topic} onChangeText={setTopic} maxLength={200} placeholder="О чём этот канал" /> : null}
      <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>КТО ВИДИТ</Text>
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Ничего не выбрано — канал видят все участники. Выбери роли, чтобы сделать канал закрытым.</Text>
      {community.roles.filter(item => !item.isDefault).map(item => <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: item.color }} /><Text style={{ flex: 1, color: t.text, fontSize: 15 }}>{item.name}</Text>
        <Switch value={roleIds.includes(item.id)} onValueChange={value => setRoleIds(current => value ? [...current, item.id] : current.filter(id => id !== item.id))} trackColor={{ false: t.subtle, true: t.accent }} thumbColor="#FFF" />
      </View>)}
      {error ? <Notice text={error} error /> : null}
      <Button label={current ? 'Сохранить' : 'Создать'} loading={busy} disabled={!name.trim()} onPress={() => void save()} />
      {current ? <Button label="Удалить канал" danger secondary disabled={busy} onPress={() => void (async () => { setBusy(true); try { await api.deleteChannel(community.id, current.id); onSaved(); } catch (failure) { setError(message(failure, 'Не удалось удалить.')); } finally { setBusy(false); } })()} /> : null}
    </View>
  </Sheet>;
}
