import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { formatBirthday } from './birthday';
import { useCalls } from './calls/CallProvider';
import { ProfileEffect } from './platina/Effects';
import { PlatinaName, PlatinaSeal, hasPlatina } from './platina/PlatinaMark';
import React, { useEffect, useState } from 'react';
import { useTabInset } from './tabInset';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
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
import { refreshFriendRequests } from './friendRequests';
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
  const calls = useCalls(); const { width } = useWindowDimensions(); const tabInset = useTabInset();
  const t = useTheme();
  const [contact, setContact] = useState<boolean | null>(null);
  const [pendingRequest, setPendingRequest] = useState<'incoming' | 'outgoing' | null>(null);
  const [fresh, setFresh] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Telegram: pulling the profile down enlarges the photo; scrolling up shrinks it away.
  const scrollY = useSharedValue(0);
  // Telegram: the top of the profile — avatar, name, status, buttons — sits on the person's own colour.
  const [heroBottom, setHeroBottom] = useState(0); const topInset = useSafeAreaInsets().top;
  const heroColor = useAnimatedStyle(() => ({ transform: [{ translateY: Math.min(0, -scrollY.value) }], height: topInset + 56 + heroBottom + 34 + Math.max(0, -scrollY.value) }));
  const onScroll = useAnimatedScrollHandler(e => { scrollY.value = e.contentOffset.y; });
  const avatarStretch = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(scrollY.value, [-160, 0, 120], [1.6, 1, 0.75], 'clamp') }, { translateY: interpolate(scrollY.value, [-160, 0], [-40, 0], 'clamp') }], opacity: interpolate(scrollY.value, [0, 140], [1, 0.4], 'clamp') }));
  const [menu, setMenu] = useState(false); const [menuAt, setMenuAt] = useState<{ x?: number; y: number }>({ y: 90 }); const [sheet, setSheet] = useState<'ttl' | 'clear' | 'block' | 'report' | null>(null);
  const [blocked, setBlocked] = useState(false); const [reason, setReason] = useState<ReportReason | null>(null);
  useEffect(() => {
    setContact(null); setPendingRequest(null); setFresh(null); setError(''); setNotice('');
    if (!user) return;
    let live = true;
    api.userProfile(user.id).then(result => { if (live) { setContact(result.isContact); setPendingRequest(result.friendRequest ?? null); setFresh(result.user); setBlocked(!!result.blocked); } }).catch(e => { if (live) setError(e instanceof Error ? e.message : 'Не удалось загрузить профиль.'); });
    return () => { live = false; };
  }, [api, user?.id]);
  if (!user) return null;
  const shown = fresh || user;
  const tinted = !shown.bannerId && !shown.bannerPreset;
  const muted = !!chat?.settings?.muted;
  const toggleContact = async () => {
    if (contact === null || busy) return;
    setBusy(true); setError(''); lightFeedback();
    try {
      if (contact) { await api.removeContact(shown.id); setContact(false); setNotice('Удалён из друзей'); }
      else if (pendingRequest === 'outgoing') { await api.dropFriendRequest(shown.id); setPendingRequest(null); setNotice('Заявка отменена'); }
      else if (pendingRequest === 'incoming') { await api.acceptFriend(shown.id); setPendingRequest(null); setContact(true); setNotice('Теперь вы друзья'); }
      else { const r = await api.addContact(shown.id); if (r.status === 'requested') { setPendingRequest('outgoing'); setNotice('Заявка отправлена'); } else { setContact(true); setNotice('Теперь вы друзья'); } }
      void refreshFriendRequests(api);
    }
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
  const copy = async () => { await Clipboard.setStringAsync(`@${shown.username}`); lightFeedback(); setNotice('Имя пользователя скопировано'); setTimeout(() => setNotice(current => current === 'Имя пользователя скопировано' ? '' : current), 2000); };
  const actions: { icon: IconName; label: string; onPress: (e?: { nativeEvent?: { pageX?: number; pageY?: number } }) => void; active?: boolean; loading?: boolean }[] = [
    ...(onMessage ? [{ icon: 'chatbubble' as IconName, label: 'Написать', onPress: () => { onClose(); onMessage(shown); } }] : []),
    ...(chat && calls.available ? [{ icon: 'call' as IconName, label: 'Звонок', onPress: () => { onClose(); calls.start(chat, false); } }, { icon: 'videocam' as IconName, label: 'Видео', onPress: () => { onClose(); calls.start(chat, true); } }] : []),
    ...(chat ? [] : [{ icon: (contact ? 'person-remove' : pendingRequest === 'outgoing' ? 'time-outline' : pendingRequest === 'incoming' ? 'person-add' : 'person-add') as IconName, label: contact ? 'В друзьях' : pendingRequest === 'outgoing' ? 'Заявка' : pendingRequest === 'incoming' ? 'Принять' : 'В друзья', onPress: () => void toggleContact(), active: !!contact || pendingRequest === 'incoming', loading: contact === null }]),
    ...(onMute && chat ? [{ icon: (muted ? 'notifications-off' : 'notifications') as IconName, label: muted ? 'Без звука' : 'Звук', onPress: () => void toggleMute(), active: muted }] : []),
    // Telegram's row: call · video · sound · search · more.
    ...(onSearch ? [{ icon: 'search' as IconName, label: 'Поиск', onPress: () => { onClose(); onSearch(); } }] : []),
    { icon: 'ellipsis-horizontal' as IconName, label: 'Ещё', onPress: e => { lightFeedback(); const n = e?.nativeEvent; setMenuAt(n?.pageY ? { x: n.pageX, y: n.pageY } : { y: 90 }); setMenu(true); } },
  ];
  const toggleBlock = async () => {
    setBusy(true); setError('');
    try { if (blocked) await api.unblock(shown.id); else { await api.block(shown.id); setContact(false); setPendingRequest(null); void refreshFriendRequests(api); } setBlocked(!blocked); setNotice(blocked ? 'Разблокирован' : 'Заблокирован: он не сможет тебе писать и звонить'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не получилось.'); } finally { setBusy(false); setSheet(null); }
  };
  const sendReport = async () => {
    if (!reason) return;
    setBusy(true); setError('');
    try { await api.report({ userId: shown.id }, reason); setNotice('Жалоба отправлена. Спасибо!'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отправить жалобу.'); } finally { setBusy(false); setSheet(null); setReason(null); }
  };
  const current = rules || { ttl: 0, noCopy: false };
  // PC / wide windows: a centred card over the dimmed app, like Telegram Desktop and Discord
  // (a full-window page there looked like a different app). Phones keep the full-screen page.
  const card = width >= 760;
  const cardWidth = Math.min(560, width - 48);
  return <Modal visible transparent={card} animationType={card ? 'fade' : 'slide'} presentationStyle={card ? 'overFullScreen' : 'fullScreen'} onRequestClose={onClose}>
    {card ? <Pressable accessibilityRole="button" accessibilityLabel="Закрыть профиль" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }]} /> : null}
    <View pointerEvents="box-none" style={card ? { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 } : { flex: 1 }}>
    <View style={card ? { width: cardWidth, height: '88%', maxHeight: 860, borderRadius: 22, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 30 } : { flex: 1 }}>
    <GlassStage>{tinted && heroBottom ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' }, heroColor]}><LinearGradient colors={[shade(shown.avatarColor, 0.15), shade(shown.avatarColor, -0.12)]} style={StyleSheet.absoluteFill} /></Animated.View> : null}{shown.bannerId || shown.bannerPreset ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 260 }}><ProfileBanner user={shown} api={api} height={260} /></View> : null}<InsetView style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6 }}>
        <IconButton name="chevron-back" label="Назад" onPress={onClose} />
        {/* No title, as in Telegram: over a banner the dark «Профиль» was unreadable. */}
        <View style={{ flex: 1 }} />
        <IconButton name="ellipsis-horizontal" label="Ещё" onPress={() => { lightFeedback(); setMenuAt({ y: 90 }); setMenu(true); }} />
      </View>
      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={{ padding: 18, paddingBottom: 18 + tabInset, gap: 16, alignItems: 'center', width: '100%', maxWidth: 680, alignSelf: 'center' }}>
        <View onLayout={e => setHeroBottom(Math.round(e.nativeEvent.layout.y + e.nativeEvent.layout.height))} style={{ alignSelf: 'stretch', alignItems: 'center', gap: 16 }}>
        <Animated.View style={avatarStretch}><DecoratedAvatar user={shown} api={api} size={128} animated /></Animated.View>
        <View style={{ alignItems: 'center', gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '100%', paddingHorizontal: 16 }}><PlatinaName user={shown} style={{ flexShrink: 1, color: tinted ? '#FFFFFF' : t.text, fontSize: 26, fontWeight: '800', letterSpacing: -.6 }} /><StatusEmoji user={shown} size={22} animated /></View>
          {status ? <Text style={{ color: tinted ? 'rgba(255,255,255,0.78)' : status === 'в сети' ? t.accent : t.muted, fontSize: 14 }}>{status}</Text> : <Pressable onPress={() => void copy()} accessibilityRole="button" accessibilityLabel="Скопировать имя пользователя"><Text style={{ color: t.accent, fontSize: 15 }}>@{shown.username}</Text></Pressable>}
          {hasPlatina(shown) ? <PlatinaSeal owner={shown} /> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 10, alignSelf: 'stretch', justifyContent: 'center' }}>
          {actions.map(action => <Pressable key={action.label} accessibilityRole="button" onPress={e => action.onPress(e)} disabled={action.loading || busy} style={({ pressed }) => ({ flex: 1, maxWidth: 120, opacity: pressed ? .7 : 1 })}>
            {tinted ? <View style={{ alignItems: 'center', gap: 6, paddingVertical: 12, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.18)' }}>
              {action.loading ? <ActivityIndicator size="small" color="#FFF" /> : <Icon name={action.icon} size={22} color="#FFF" />}
              <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '600' }}>{action.label.toLowerCase()}</Text>
            </View> : <GlassSurface radius={18} shadow={false} contentStyle={{ alignItems: 'center', gap: 6, paddingVertical: 12 }}>
              {action.loading ? <ActivityIndicator size="small" color={t.accent} /> : <Icon name={action.icon} size={22} color={action.active ? t.accent : t.text} />}
              <Text style={{ color: action.active ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{action.label}</Text>
            </GlassSurface>}
          </Pressable>)}
        </View>
        </View>
        {notice ? <Text style={{ color: t.accent, fontSize: 13 }}>{notice}</Text> : null}
        {error ? <View style={{ alignSelf: 'stretch' }}><Notice text={error} error /></View> : null}
        <GlassSurface radius={20} shadow={false} style={{ alignSelf: 'stretch' }} contentStyle={{ padding: 16, gap: 14 }}>
          <Pressable onPress={() => void copy()} onLongPress={() => void copy()} accessibilityRole="button" accessibilityLabel={`Имя пользователя @${shown.username}. Нажми, чтобы скопировать`} style={({ pressed }) => ({ gap: 3, opacity: pressed ? .6 : 1 })}><Text style={{ color: t.muted, fontSize: 13 }}>имя пользователя</Text><Text raw style={{ color: t.accent, fontSize: 16 }}>@{shown.username}</Text></Pressable>
          {shown.bio ? <View style={{ gap: 3 }}><Text style={{ color: t.muted, fontSize: 13 }}>о себе</Text><Text raw style={{ color: t.text, fontSize: 16, lineHeight: 22 }}>{shown.bio}</Text></View> : null}
          {shown.birthday ? <View style={{ gap: 3 }}><Text style={{ color: t.muted, fontSize: 13 }}>день рождения</Text><Text raw style={{ color: t.text, fontSize: 16 }}>{formatBirthday(shown.birthday)}</Text></View> : null}
          <Pressable disabled={!onSecurity} onPress={() => { onClose(); onSecurity?.(); }} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Icon name="lock-closed" size={14} color={t.accent} /><Text style={{ color: t.muted, fontSize: 12, flex: 1 }}>Переписка защищена сквозным шифрованием{onSecurity ? ' · проверить устройства' : ''}</Text>{onSecurity ? <Icon name="chevron-forward" size={14} color={t.muted} /> : null}</Pressable>
        </GlassSurface>
        {shared && onOpenAttachment ? <SharedMedia messages={shared} onOpen={attachment => { onClose(); setTimeout(() => onOpenAttachment(attachment), 250); }} /> : null}
      </Animated.ScrollView>
    </InsetView>{/* Discord-style profile effect over the top while the profile is open. */}<ProfileEffect effect={shown.profileEffect} width={card ? cardWidth : width} height={420} /></GlassStage>
    </View></View>
    <ContextMenu visible={menu} y={menuAt.y} x={menuAt.x} mine onClose={() => setMenu(false)}>
      {chat && contact !== null ? <MenuItem icon={contact ? 'person-remove-outline' : 'person-add-outline'} label={contact ? 'Удалить из друзей' : pendingRequest === 'outgoing' ? 'Отменить заявку' : pendingRequest === 'incoming' ? 'Принять в друзья' : 'Добавить в друзья'} onPress={() => { setMenu(false); void toggleContact(); }} /> : null}
      {chat && onRules ? <MenuItem icon="timer-outline" label={`Автоудаление · ${autoDeleteLabel(current.ttl)}`} onPress={() => { setMenu(false); setSheet('ttl'); }} /> : null}
      {chat && onRules ? <MenuItem icon={current.noCopy ? 'lock-closed' : 'lock-open-outline'} label={current.noCopy ? 'Разрешить пересылку и копирование' : 'Запретить пересылку и копирование'} onPress={() => { setMenu(false); lightFeedback(); onRules({ ...current, noCopy: !current.noCopy }); setNotice(current.noCopy ? 'Копирование снова разрешено' : 'Копировать и пересылать сообщения этого чата теперь нельзя обоим'); }} /> : null}
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

/** Lighter (amount > 0) or darker (< 0) version of a #RRGGBB colour, for the profile header tint. */
function shade(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#596FE8';
  const n = parseInt(m[1], 16); const mix = (c: number) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}
