import { useCalls } from './calls/CallProvider';
import { ProfileEffect } from './platina/Effects';
import { PlatinaName, PlatinaSeal, hasPlatina } from './platina/PlatinaMark';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Text } from './typography';
import { Avatar, Button, Icon, InsetView, IconButton, Notice, Sheet, SheetAction, type IconName } from './components';
import { ContextMenu, MenuItem } from './ContextMenu';
import { GlassStage, GlassSurface } from './glass';
import { useTheme } from './theme';
import { StatusEmoji } from './StatusEmoji';
import { DecoratedAvatar, ProfileBanner } from './platina/Decor';
import { lightFeedback } from './haptics';
import type { Api } from './api';
import type { Attachment, Chat, ReportReason, User } from './types';
import { AUTO_DELETE, autoDeleteLabel, type ChatRules, type ViewMessage } from './messageMeta';
import { SharedMedia } from './SharedMedia';

type Props = {
  api: Api; user: User | null; onClose: () => void;
  chat?: Chat | null; onMessage?: (user: User) => void;
  onMute?: (muted: boolean) => Promise<unknown>;
  onSearch?: () => void; onSecurity?: () => void; status?: string;
  /** The chat's decrypted history: shown as Медиа / Файлы / Голосовые / Ссылки tabs. */
  shared?: ViewMessage[]; onOpenAttachment?: (attachment: Attachment) => void; onWallpaper?: () => void;
  /** Encrypted chat rules (auto-delete, no copying) and «Очистить историю» for both. */
  rules?: ChatRules; onRules?: (rules: ChatRules) => void; onClear?: () => void;
};
const REASONS: { id: ReportReason; label: string }[] = [
  { id: 'spam', label: 'Спам' }, { id: 'scam', label: 'Мошенничество' }, { id: 'abuse', label: 'Оскорбления и травля' },
  { id: 'violence', label: 'Насилие' }, { id: 'sexual', label: 'Откровенный контент' }, { id: 'illegal', label: 'Незаконное' }, { id: 'other', label: 'Другое' },
];

/** Full-screen profile like in Telegram: big photo, name, @username, bio, actions. */
export function UserProfile({ api, user, onClose, chat, onMessage, onMute, onSearch, onSecurity, status, shared, onOpenAttachment, onWallpaper, rules, onRules, onClear }: Props) {
  const calls = useCalls(); const { width } = useWindowDimensions();
  const t = useTheme();
  const [contact, setContact] = useState<boolean | null>(null);
  const [fresh, setFresh] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState(false); const [sheet, setSheet] = useState<'ttl' | 'clear' | 'block' | 'report' | null>(null);
  const [blocked, setBlocked] = useState(false); const [reason, setReason] = useState<ReportReason | null>(null);
  useEffect(() => {
    setContact(null); setFresh(null); setError(''); setNotice('');
    if (!user) return;
    let live = true;
    api.userProfile(user.id).then(result => { if (live) { setContact(result.isContact); setFresh(result.user); setBlocked(!!result.blocked); } }).catch(e => { if (live) setError(e instanceof Error ? e.message : 'Не удалось загрузить профиль.'); });
    return () => { live = false; };
  }, [api, user?.id]);
  if (!user) return null;
  const shown = fresh || user;
  const muted = !!chat?.settings?.muted;
  const toggleContact = async () => {
    if (contact === null || busy) return;
    setBusy(true); setError(''); lightFeedback();
    try { if (contact) await api.removeContact(shown.id); else await api.addContact(shown.id); setContact(!contact); setNotice(contact ? 'Удалён из друзей' : 'Добавлен в друзья'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить список друзей.'); }
    finally { setBusy(false); }
  };
  const toggleMute = async () => {
    if (!onMute || busy) return;
    setBusy(true); setError(''); lightFeedback();
    try { await onMute(!muted); setNotice(muted ? 'Звук включён' : 'Уведомления выключены'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить уведомления.'); }
    finally { setBusy(false); }
  };
  const copy = async () => { await Clipboard.setStringAsync(`@${shown.username}`); setNotice('Имя пользователя скопировано'); };
  const actions: { icon: IconName; label: string; onPress: () => void; active?: boolean; loading?: boolean }[] = [
    ...(onMessage ? [{ icon: 'chatbubble' as IconName, label: 'Написать', onPress: () => { onClose(); onMessage(shown); } }] : []),
    ...(chat && calls.available ? [{ icon: 'call' as IconName, label: 'Звонок', onPress: () => { onClose(); calls.start(chat, false); } }, { icon: 'videocam' as IconName, label: 'Видео', onPress: () => { onClose(); calls.start(chat, true); } }] : []),
    { icon: contact ? 'person-remove' : 'person-add', label: contact ? 'В друзьях' : 'В друзья', onPress: () => void toggleContact(), active: !!contact, loading: contact === null },
    ...(onMute && chat ? [{ icon: (muted ? 'notifications-off' : 'notifications') as IconName, label: muted ? 'Без звука' : 'Звук', onPress: () => void toggleMute(), active: muted }] : []),
  ];
  const toggleBlock = async () => {
    setBusy(true); setError('');
    try { if (blocked) await api.unblock(shown.id); else await api.block(shown.id); setBlocked(!blocked); setNotice(blocked ? 'Разблокирован' : 'Заблокирован: он не сможет тебе писать и звонить'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не получилось.'); } finally { setBusy(false); setSheet(null); }
  };
  const sendReport = async () => {
    if (!reason) return;
    setBusy(true); setError('');
    try { await api.report({ userId: shown.id }, reason); setNotice('Жалоба отправлена. Спасибо!'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отправить жалобу.'); } finally { setBusy(false); setSheet(null); setReason(null); }
  };
  const current = rules || { ttl: 0, noCopy: false };
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <GlassStage>{shown.bannerId || shown.bannerPreset ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 260 }}><ProfileBanner user={shown} api={api} height={260} /></View> : null}<InsetView style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6 }}>
        <IconButton name="chevron-back" label="Назад" onPress={onClose} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 16, fontWeight: '700' }}>Профиль</Text>
        <IconButton name="ellipsis-horizontal" label="Ещё" onPress={() => { lightFeedback(); setMenu(true); }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 18, gap: 16, alignItems: 'center' }}>
        <DecoratedAvatar user={shown} api={api} size={128} animated />
        <View style={{ alignItems: 'center', gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><PlatinaName user={shown} style={{ color: t.text, fontSize: 26, fontWeight: '800', letterSpacing: -.6 }} /><StatusEmoji user={shown} size={22} animated /></View>
          {status ? <Text style={{ color: status === 'в сети' ? t.accent : t.muted, fontSize: 14 }}>{status}</Text> : <Pressable onPress={() => void copy()} accessibilityRole="button" accessibilityLabel="Скопировать имя пользователя"><Text style={{ color: t.accent, fontSize: 15 }}>@{shown.username}</Text></Pressable>}
          {hasPlatina(shown) ? <PlatinaSeal owner={shown} /> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 10, alignSelf: 'stretch', justifyContent: 'center' }}>
          {actions.map(action => <Pressable key={action.label} accessibilityRole="button" onPress={action.onPress} disabled={action.loading || busy} style={({ pressed }) => ({ flex: 1, maxWidth: 120, opacity: pressed ? .7 : 1 })}>
            <GlassSurface radius={18} shadow={false} contentStyle={{ alignItems: 'center', gap: 6, paddingVertical: 12 }}>
              {action.loading ? <ActivityIndicator size="small" color={t.accent} /> : <Icon name={action.icon} size={22} color={action.active ? t.accent : t.text} />}
              <Text style={{ color: action.active ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{action.label}</Text>
            </GlassSurface>
          </Pressable>)}
        </View>
        {notice ? <Text style={{ color: t.accent, fontSize: 13 }}>{notice}</Text> : null}
        {error ? <View style={{ alignSelf: 'stretch' }}><Notice text={error} error /></View> : null}
        <GlassSurface radius={20} shadow={false} style={{ alignSelf: 'stretch' }} contentStyle={{ padding: 16, gap: 14 }}>
          {shown.bio ? <View style={{ gap: 4 }}><Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{shown.bio}</Text><Text style={{ color: t.muted, fontSize: 12 }}>О себе</Text></View> : null}
          <View style={{ gap: 4 }}><Text style={{ color: t.accent, fontSize: 15 }}>@{shown.username}</Text><Text style={{ color: t.muted, fontSize: 12 }}>Имя пользователя</Text></View>
          <Pressable disabled={!onSecurity} onPress={() => { onClose(); onSecurity?.(); }} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Icon name="lock-closed" size={14} color={t.accent} /><Text style={{ color: t.muted, fontSize: 12, flex: 1 }}>Переписка защищена сквозным шифрованием{onSecurity ? ' · проверить устройства' : ''}</Text>{onSecurity ? <Icon name="chevron-forward" size={14} color={t.muted} /> : null}</Pressable>
        </GlassSurface>
        {shared && onOpenAttachment ? <SharedMedia messages={shared} onOpen={attachment => { onClose(); setTimeout(() => onOpenAttachment(attachment), 250); }} /> : null}
      </ScrollView>
    </InsetView>{/* Discord-style profile effect over the top while the profile is open. */}<ProfileEffect effect={shown.profileEffect} width={width} height={420} /></GlassStage>
    <ContextMenu visible={menu} y={90} mine onClose={() => setMenu(false)}>
      {chat && onRules ? <MenuItem icon="timer-outline" label={`Автоудаление · ${autoDeleteLabel(current.ttl)}`} onPress={() => { setMenu(false); setSheet('ttl'); }} /> : null}
      {chat && onRules ? <MenuItem icon={current.noCopy ? 'lock-closed' : 'lock-open-outline'} label={current.noCopy ? 'Разрешить копирование' : 'Запретить копирование'} onPress={() => { setMenu(false); lightFeedback(); onRules({ ...current, noCopy: !current.noCopy }); setNotice(current.noCopy ? 'Копирование снова разрешено' : 'Копировать и пересылать сообщения этого чата теперь нельзя обоим'); }} /> : null}
      {onWallpaper ? <MenuItem icon="image-outline" label="Обои" onPress={() => { setMenu(false); onClose(); onWallpaper(); }} /> : null}
      {onSearch ? <MenuItem icon="search-outline" label="Поиск" onPress={() => { setMenu(false); onClose(); onSearch(); }} /> : null}
      {chat && onClear ? <MenuItem separated icon="trash-bin-outline" label="Очистить историю" onPress={() => { setMenu(false); setSheet('clear'); }} /> : null}
      <MenuItem separated={!(chat && onClear)} icon={blocked ? 'hand-left-outline' : 'remove-circle-outline'} label={blocked ? 'Разблокировать' : 'Заблокировать'} danger={!blocked} onPress={() => { setMenu(false); if (blocked) void toggleBlock(); else setSheet('block'); }} />
      <MenuItem icon="warning-outline" label="Пожаловаться" danger onPress={() => { setMenu(false); setSheet('report'); }} />
    </ContextMenu>
    <Sheet visible={sheet === 'ttl'} title="Автоудаление" onClose={() => setSheet(null)}>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginBottom: 6 }}>Новые сообщения в этом чате удалятся у вас обоих через выбранное время. Собеседник увидит, что автоудаление включено.</Text>
      {AUTO_DELETE.map(ttl => <SheetAction key={ttl} icon={current.ttl === ttl ? 'checkmark-circle' : 'ellipse-outline'} label={ttl ? autoDeleteLabel(ttl) : 'Выключено'} selected={current.ttl === ttl} onPress={() => { setSheet(null); if (ttl !== current.ttl && onRules) { lightFeedback(); onRules({ ...current, ttl }); setNotice(ttl ? `Автоудаление: ${autoDeleteLabel(ttl)}` : 'Автоудаление выключено'); } }} />)}
    </Sheet>
    <Sheet visible={sheet === 'clear'} title="Очистить историю?" onClose={() => setSheet(null)}>
      <SheetAction icon="trash-outline" label="Удалить у обоих" description={`Все сообщения исчезнут у тебя и у ${shown.displayName}. Вернуть не получится.`} danger onPress={() => { setSheet(null); onClear?.(); setNotice('История очищена у обоих'); }} />
    </Sheet>
    <Sheet visible={sheet === 'block'} title={`Заблокировать ${shown.displayName}?`} onClose={() => setSheet(null)}>
      <SheetAction icon="remove-circle-outline" label="Заблокировать" description="Он не сможет писать и звонить тебе, пока ты не разблокируешь. Список — в Безопасности." danger onPress={() => void toggleBlock()} />
    </Sheet>
    <Sheet visible={sheet === 'report'} title="Пожаловаться" onClose={() => { setSheet(null); setReason(null); }}>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginBottom: 6 }}>Переписка зашифрована: модератор увидит только причину и профиль, но не сообщения.</Text>
      {REASONS.map(item => <SheetAction key={item.id} icon={reason === item.id ? 'checkmark-circle' : 'ellipse-outline'} label={item.label} selected={reason === item.id} onPress={() => setReason(item.id)} />)}
      <View style={{ marginTop: 8 }}><Button label="Отправить жалобу" disabled={!reason || busy} loading={busy} onPress={() => void sendReport()} /></View>
    </Sheet>
  </Modal>;
}
