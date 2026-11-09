import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { isBirthdayToday } from './birthday';
import { birthdayColors } from './platina/Decor';
import { Confetti } from './effects';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useCalls } from './calls/CallProvider';
import { ProfileEffect } from './platina/Effects';
import { PlatinaName, PlatinaSeal, hasPlatina } from './platina/PlatinaMark';
import React, { useEffect, useRef, useState } from 'react';
import { useTabInset } from './tabInset';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, interpolate, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { ProfileMediaViewer, profileMedia } from './ProfileMediaViewer';
import { PostViewer, PostsSection, ProfilePattern, StoryRing, useProfilePosts } from './ProfilePosts';
import { ProfileInfoCard } from './ProfileInfo';
import * as Clipboard from 'expo-clipboard';
import { Text } from './typography';
import { Avatar, Bouncy, Button, Icon, InsetView, IconButton, Notice, Sheet, SheetAction, type IconName } from './components';
import { ContextMenu, MenuItem } from './ContextMenu';
import { GlassStage, GlassSurface } from './glass';
import { useTheme } from './theme';
import { StatusEmoji } from './StatusEmoji';
import { DecoratedAvatar, ProfileBanner } from './platina/Decor';
import { lightFeedback } from './haptics';
import { motionEnabled } from './motion';
import { backSwipeIntent, shouldGoBack } from './media/swipeMath';
import type { Api } from './api';
import type { Attachment, Chat, ReportReason, User } from './types';
import { AUTO_DELETE, autoDeleteLabel, type ChatRules, type ViewMessage } from './messageMeta';
import { refreshFriendRequests } from './friendRequests';
import { SharedMedia } from './SharedMedia';
import { useBackStrip } from './backStrip';
import { stripBlocksBack } from './listSwipes';
import { MuteSheet } from './notifications/MuteSheet';
import { isMuted, muteUntilLabel } from './notifications/model';

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
  const onScroll = useAnimatedScrollHandler({ onScroll: e => { scrollY.value = e.contentOffset.y; }, onEndDrag: e => { if (e.contentOffset.y < -110) runOnJS(openViewer)(); } });
  // Scrolling up, the photo shrinks, rises towards the top edge (the Dynamic Island) and darkens away, as in
  // Telegram; pulling down enlarges it, and a long pull opens the photos and videos full screen.
  const avatarStretch = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(scrollY.value, [-160, 0, 150], [-40, 0, -70], 'clamp') }, { scale: interpolate(scrollY.value, [-160, 0, 150], [1.6, 1, 0.22], 'clamp') }], opacity: interpolate(scrollY.value, [60, 150], [1, 0], 'clamp') }));
  const avatarDim = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [20, 130], [0, 0.85], 'clamp') }));
  const [viewer, setViewer] = useState<number | null>(null);
  // Their «Публикации» / «Истории» (friends only); the avatar ring opens the stories.
  const posts = useProfilePosts(api, user?.id); const stories = posts.data?.stories ?? []; const [storyOpen, setStoryOpen] = useState(false);
  // Telegram: the profile pushes in from the right and the avatar grows out of the chat header; «Назад»
  // slides it back out.
  const slide = useSharedValue(width); const grow = useSharedValue(0.35);
  useEffect(() => { slide.value = withTiming(0, { duration: 280, easing: Easing.out(Easing.cubic) }); grow.value = withSpring(1, { damping: 16, stiffness: 180 }); }, []);
  const pushIn = useAnimatedStyle(() => ({ transform: [{ translateX: slide.value }] }));
  const avatarIn = useAnimatedStyle(() => ({ transform: [{ scale: grow.value }], opacity: Math.min(1, grow.value * 1.6) }));
  // Telegram: swipe right anywhere on the profile to go back (it follows the finger), with the same
  // direction lock as the chat stack (src/stack.tsx): it takes over once the move is right and mostly
  // sideways (2:1), and lets go of a vertical one so the profile still scrolls. Wide windows show a
  // centred card that closes with a tap outside it, so no swipe there.
  // A drag that starts on the shared media tab strip while it is scrolled away from its start scrolls the
  // strip back instead (from the very edge the back swipe still wins), see stripBlocksBack.
  const swipeStart = useSharedValue({ x: 0, y: 0, local: 0 }); const mediaStrip = useBackStrip();
  const motion = motionEnabled();
  const edgeSwipe = Gesture.Pan().enabled(width < 760).manualActivation(true)
    .onTouchesDown((event, manager) => { const touch = event.changedTouches[0]; if (!touch || event.numberOfTouches > 1) { manager.fail(); return; } swipeStart.value = { x: touch.absoluteX, y: touch.absoluteY, local: touch.x }; })
    .onTouchesMove((event, manager) => {
      const touch = event.changedTouches[0]; if (!touch) return;
      if (stripBlocksBack(mediaStrip.touching.value === 1, mediaStrip.offset.value, swipeStart.value.local)) { manager.fail(); return; }
      const intent = backSwipeIntent(touch.absoluteX - swipeStart.value.x, touch.absoluteY - swipeStart.value.y);
      if (intent === 'activate') manager.activate(); else if (intent === 'fail') manager.fail();
    })
    .onUpdate(e => { slide.value = Math.max(0, e.translationX); })
    .onEnd(e => {
      if (shouldGoBack(e.translationX, e.velocityX, width)) {
        runOnJS(lightFeedback)();
        if (!motion) { slide.value = width; runOnJS(onClose)(); return; }
        slide.value = withTiming(width, { duration: Math.max(90, 200 * (1 - slide.value / width)), easing: Easing.out(Easing.cubic) }, done => { if (done) runOnJS(onClose)(); });
      } else slide.value = motion ? withSpring(0, { damping: 20, stiffness: 260 }) : 0;
    })
    .onFinalize(() => { mediaStrip.touching.value = 0; });
  const back = () => { if (width >= 760) { onClose(); return; } slide.value = withTiming(width, { duration: 220, easing: Easing.in(Easing.cubic) }, done => { if (done) runOnJS(onClose)(); }); };
  const [menu, setMenu] = useState(false); const [menuAt, setMenuAt] = useState<{ x?: number; y: number }>({ y: 90 }); const [sheet, setSheet] = useState<'ttl' | 'clear' | 'block' | 'report' | 'unfriend' | 'mute' | null>(null);
  const [blocked, setBlocked] = useState(false); const [reason, setReason] = useState<ReportReason | null>(null);
  const [copied, setCopied] = useState(false); const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    setContact(null); setPendingRequest(null); setFresh(null); setError(''); setNotice('');
    if (!user) return;
    let live = true;
    api.userProfile(user.id).then(result => { if (live) { setContact(result.isContact); setPendingRequest(result.friendRequest ?? null); setFresh(result.user); setBlocked(!!result.blocked); } }).catch(e => { if (live) setError(e instanceof Error ? e.message : 'Не удалось загрузить профиль.'); });
    return () => { live = false; };
  }, [api, user?.id]);
  if (!user) return null;
  const shown = fresh || user;
  function openViewer() { if (stories.length) { setStoryOpen(true); return; } if (profileMedia(shown).length) { lightFeedback(); setViewer(0); } }
  // Their birthday: a festive header — blue (male), pink (female) or bright — a greeting line and confetti.
  const birthdayToday = isBirthdayToday(shown.birthday);
  const festive = birthdayColors(shown.gender);
  // Telegram: the header is the plain background (or the banner); coloured only on the birthday.
  const tinted = !shown.bannerId && !shown.bannerPreset && birthdayToday;
  // Compared with the clock: a mute «до 18:30» is over at 18:30 even before the chat list refreshed.
  const muted = isMuted(chat?.settings);
  const toggleContact = async () => {
    if (contact === null || busy) return;
    setBusy(true); setError(''); lightFeedback();
    try {
      if (contact) { await api.removeContact(shown.id); setContact(false); setNotice('Удалён из друзей'); }
      else if (pendingRequest === 'outgoing') { await api.dropFriendRequest(shown.id); setPendingRequest(null); setNotice('Заявка отменена'); }
      else if (pendingRequest === 'incoming') { await api.acceptFriend(shown.id); setPendingRequest(null); setContact(true); setNotice('Теперь вы друзья'); }
      else { const r = await api.addContact(shown.id); if (r.status === 'requested') { setPendingRequest('outgoing'); setNotice('Заявка отправлена'); } else { setContact(true); setNotice('Теперь вы друзья'); } }
      void refreshFriendRequests(api);
      // Posts, stories and gifts are for friends: their visibility changes with this.
      void posts.reload();
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить список друзей.'); }
    finally { setBusy(false); }
  };
  const toggleMute = async () => {
    if (!onMute || busy) return;
    setBusy(true); setError(''); lightFeedback();
    try { await onMute(!muted); setNotice(muted ? 'Звук включён' : 'Звук выключен навсегда'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить уведомления.'); }
    finally { setBusy(false); }
  };
  // Telegram «Выкл. звук»: the sheet's choice. «Навсегда» goes through onMute (the store updates at once);
  // a timed mute goes to the chat settings route, and the server tells this and every other device over the socket.
  const muteFor = async (until: string | null) => {
    if (!chat || busy) return;
    setSheet(null); setBusy(true); setError(''); lightFeedback();
    try {
      if (until === null && onMute) await onMute(true); else await api.chatSettings(chat.id, until === null ? { muted: true } : { mutedUntil: until });
      setNotice(`Звук выключен ${muteUntilLabel(until)}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить уведомления.'); }
    finally { setBusy(false); }
  };
  // As on the own profile: the row itself reads «Скопировано» for a moment.
  const copy = async () => { await Clipboard.setStringAsync(`@${shown.username}`); lightFeedback(); setCopied(true); if (copyTimer.current) clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1800); };
  const actions: { icon: IconName; label: string; sublabel?: string; onPress: (e?: { nativeEvent?: { pageX?: number; pageY?: number } }) => void; active?: boolean; loading?: boolean }[] = [
    ...(onMessage ? [{ icon: 'chatbubble' as IconName, label: 'Написать', onPress: () => { onClose(); onMessage(shown); } }] : []),
    ...(chat && calls.available ? [{ icon: 'call' as IconName, label: 'Звонок', onPress: () => { onClose(); calls.start(chat, false); } }, { icon: 'videocam' as IconName, label: 'Видео', onPress: () => { onClose(); calls.start(chat, true); } }] : []),
    ...(chat ? [] : [{ icon: (contact ? 'person-remove' : pendingRequest === 'outgoing' ? 'time-outline' : pendingRequest === 'incoming' ? 'person-add' : 'person-add') as IconName, label: contact ? 'В друзьях' : pendingRequest === 'outgoing' ? 'Заявка' : pendingRequest === 'incoming' ? 'Принять' : 'В друзья', onPress: () => { if (contact) setSheet('unfriend'); else void toggleContact(); }, active: !!contact || pendingRequest === 'incoming', loading: contact === null }]),
    ...(onMute && chat ? [{ icon: (muted ? 'notifications-off' : 'notifications') as IconName, label: muted ? 'Без звука' : 'Звук', sublabel: muted ? muteUntilLabel(chat.settings?.mutedUntil) : undefined, onPress: () => { if (muted) void toggleMute(); else { lightFeedback(); setSheet('mute'); } }, active: muted }] : []),
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
  return <Modal visible transparent animationType={card ? 'fade' : 'none'} presentationStyle="overFullScreen" onRequestClose={back} statusBarTranslucent>
    {card ? <Pressable accessibilityRole="button" accessibilityLabel="Закрыть профиль" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }]} /> : null}
    <GestureHandlerRootView style={{ flex: 1 }}><GestureDetector gesture={edgeSwipe}><Animated.View pointerEvents="box-none" style={[card ? { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 } : { flex: 1, backgroundColor: t.bg }, card ? null : pushIn]}>
    <View style={card ? { width: cardWidth, height: '88%', maxHeight: 860, borderRadius: 22, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 30 } : { flex: 1 }}>
    <GlassStage>{tinted && heroBottom ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' }, heroColor]}><LinearGradient colors={birthdayToday ? [festive[0], festive[1]] : [shade(shown.avatarColor, 0.15), shade(shown.avatarColor, -0.12)]} style={StyleSheet.absoluteFill} /></Animated.View> : null}{/* PC: the banner is as wide as the card, not the window (it was cut off at the card's edge). */}{shown.bannerId || shown.bannerPreset ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 260 }}><ProfileBanner user={shown} api={api} height={260} width={card ? cardWidth : width} /></View> : null}<InsetView style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6 }}>
        <IconButton name="chevron-back" label="Назад" onPress={back} />
        {/* No title, as in Telegram: over a banner the dark «Профиль» was unreadable. */}
        <View style={{ flex: 1 }} />
        <IconButton name="ellipsis-horizontal" label="Ещё" onPress={() => { lightFeedback(); setMenuAt({ y: 90 }); setMenu(true); }} />
      </View>
      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={{ padding: 18, paddingBottom: 18 + tabInset, gap: 16, alignItems: 'center', width: '100%', maxWidth: 680, alignSelf: 'center' }}>
        <View onLayout={e => setHeroBottom(Math.round(e.nativeEvent.layout.y + e.nativeEvent.layout.height))} style={{ alignSelf: 'stretch', alignItems: 'center', gap: 16 }}>
        {/* Telegram: the chosen emoji pattern around the photo. */}
        {shown.profilePattern ? <View pointerEvents="none" style={{ position: 'absolute', left: -18, right: -18, top: -90, height: 90 + Math.max(220, heroBottom) }}><ProfilePattern emoji={shown.profilePattern} width={(card ? cardWidth : Math.min(680, width))} height={90 + Math.max(220, heroBottom)} cx={(card ? cardWidth : Math.min(680, width)) / 2} cy={90 + (stories.length ? 64 : 58)} /></View> : null}
        <Animated.View style={avatarStretch}><Pressable accessibilityRole="button" accessibilityLabel={stories.length ? 'Истории' : 'Фото и видео профиля'} disabled={!stories.length && !profileMedia(shown).length} onPress={openViewer}><Animated.View style={avatarIn}><StoryRing active={stories.length > 0} size={116}><DecoratedAvatar user={shown} api={api} size={116} animated round /></StoryRing></Animated.View><Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 58, backgroundColor: '#000' }, avatarDim]} /></Pressable></Animated.View>
        <View style={{ alignItems: 'center', gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, alignSelf: 'stretch', paddingHorizontal: 16 }}><PlatinaName user={shown} onDark={tinted} numberOfLines={2} style={{ flexShrink: 1, textAlign: 'center', color: tinted ? '#FFFFFF' : t.text, fontSize: 26, fontWeight: '800', letterSpacing: -.6 }} /><StatusEmoji user={shown} size={22} animated /></View>
          {/* Telegram: only the presence under the name; @username lives in the card below (it was shown twice). */}
          {status ? <Text style={{ color: tinted ? 'rgba(255,255,255,0.78)' : status === 'в сети' ? t.accent : t.muted, fontSize: 15 }}>{status}</Text> : null}
          {birthdayToday ? <View style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: tinted ? 'rgba(255,255,255,0.22)' : t.accentSoft }}><Text style={{ color: tinted ? '#FFF' : t.text, fontSize: 13, fontWeight: '700' }}>🎉 Сегодня день рождения</Text></View> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 10, alignSelf: 'stretch', justifyContent: 'center' }}>
          {actions.map(action => <Bouncy key={action.label} scaleTo={.9} accessibilityRole="button" onPress={e => action.onPress(e)} disabled={action.loading || busy} style={{ flex: 1, maxWidth: 120 }}>
            {tinted ? <View style={{ alignItems: 'center', gap: 6, paddingVertical: 12, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.18)' }}>
              {action.loading ? <ActivityIndicator size="small" color="#FFF" /> : <Icon name={action.icon} size={22} color="#FFF" />}
              <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '600' }}>{action.label.toLowerCase()}</Text>
              {action.sublabel ? <Text numberOfLines={1} maxFontSizeMultiplier={1.2} style={{ color: 'rgba(255,255,255,0.8)', fontSize: 10, marginTop: -3 }}>{action.sublabel}</Text> : null}
            </View> : <GlassSurface radius={18} shadow={false} contentStyle={{ alignItems: 'center', gap: 6, paddingVertical: 12 }}>
              {action.loading ? <ActivityIndicator size="small" color={t.accent} /> : <Icon name={action.icon} size={22} color={action.active ? t.accent : t.text} />}
              <Text style={{ color: action.active ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{action.label}</Text>
              {action.sublabel ? <Text numberOfLines={1} maxFontSizeMultiplier={1.2} style={{ color: t.muted, fontSize: 10, marginTop: -3 }}>{action.sublabel}</Text> : null}
            </GlassSurface>}
          </Bouncy>)}
        </View>
        </View>
        {notice ? <Text style={{ color: t.accent, fontSize: 13 }}>{notice}</Text> : null}
        {error ? <View style={{ alignSelf: 'stretch' }}><Notice text={error} error /></View> : null}
        {/* The same card as on the person's own profile (ProfileInfo.tsx). */}
        <ProfileInfoCard username={shown.username} birthday={shown.birthday} bio={shown.bio} copied={copied} onCopy={() => void copy()} style={{ alignSelf: 'stretch' }}>
          <Pressable disabled={!onSecurity} onPress={() => { onClose(); onSecurity?.(); }} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Icon name="lock-closed" size={14} color={t.accent} /><Text style={{ color: t.muted, fontSize: 12, flex: 1 }}>Переписка защищена сквозным шифрованием{onSecurity ? ' · проверить устройства' : ''}</Text>{onSecurity ? <Icon name="chevron-forward" size={14} color={t.muted} /> : null}</Pressable>
        </ProfileInfoCard>
        <View style={{ alignSelf: 'stretch' }}><PostsSection api={api} own={false} userId={shown.id} data={posts.data} onChanged={() => void posts.reload()} width={(card ? cardWidth : Math.min(680, width)) - 36} /></View>
        {shared && onOpenAttachment ? <SharedMedia messages={shared} backStrip={mediaStrip} onOpen={attachment => { onClose(); setTimeout(() => onOpenAttachment(attachment), 250); }} /> : null}
      </Animated.ScrollView>
    </InsetView>{/* Discord-style profile effect over the top while the profile is open. */}<ProfileEffect effect={shown.profileEffect} width={card ? cardWidth : width} height={420} /></GlassStage>
    </View></Animated.View></GestureDetector></GestureHandlerRootView>
    <ContextMenu visible={menu} y={menuAt.y} x={menuAt.x} mine onClose={() => setMenu(false)}>
      {chat && contact !== null ? <MenuItem icon={contact ? 'person-remove-outline' : 'person-add-outline'} label={contact ? 'Удалить из друзей' : pendingRequest === 'outgoing' ? 'Отменить заявку' : pendingRequest === 'incoming' ? 'Принять в друзья' : 'Добавить в друзья'} onPress={() => { setMenu(false); if (contact) setSheet('unfriend'); else void toggleContact(); }} /> : null}
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
    <MuteSheet visible={sheet === 'mute'} title={shown.displayName} current={chat?.settings} onClose={() => setSheet(null)} onMute={until => void muteFor(until)} onUnmute={() => { setSheet(null); void toggleMute(); }} />
    <Sheet visible={sheet === 'clear'} title="Очистить историю?" onClose={() => setSheet(null)}>
      <SheetAction icon="trash-outline" label="Удалить у обоих" description={`Все сообщения исчезнут у тебя и у ${shown.displayName}. Вернуть не получится.`} danger onPress={() => { setSheet(null); onClear?.(); setNotice('История очищена у обоих'); }} />
    </Sheet>
    {/* Removing a friend was one tap on «В друзьях»; now it asks first. */}
    <Sheet visible={sheet === 'unfriend'} title={`Удалить ${shown.displayName} из друзей?`} onClose={() => setSheet(null)}>
      <SheetAction icon="person-remove-outline" label="Удалить из друзей" description="Публикации, истории и подарки друг друга вы больше не увидите. Заявку можно отправить снова." danger onPress={() => { setSheet(null); void toggleContact(); }} />
    </Sheet>
    <Sheet visible={sheet === 'block'} title={`Заблокировать ${shown.displayName}?`} onClose={() => setSheet(null)}>
      <SheetAction icon="remove-circle-outline" label="Заблокировать" description="Он не сможет писать и звонить тебе, пока ты не разблокируешь. Список — в Безопасности." danger onPress={() => void toggleBlock()} />
    </Sheet>
    <Sheet visible={sheet === 'report'} title="Пожаловаться" onClose={() => { setSheet(null); setReason(null); }}>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginBottom: 6 }}>Переписка зашифрована: модератор увидит только причину и профиль, но не сообщения.</Text>
      {REASONS.map(item => <SheetAction key={item.id} icon={reason === item.id ? 'checkmark-circle' : 'ellipse-outline'} label={item.label} selected={reason === item.id} onPress={() => setReason(item.id)} />)}
      <View style={{ marginTop: 8 }}><Button label="Отправить жалобу" disabled={!reason || busy} loading={busy} onPress={() => void sendReport()} /></View>
    </Sheet>
    {birthdayToday ? <View pointerEvents="none" style={StyleSheet.absoluteFill}><Confetti colors={[...festive, '#FFFFFF', '#FFD86B']} /></View> : null}
    {storyOpen && stories.length ? <PostViewer api={api} items={stories} start={0} story onClose={() => setStoryOpen(false)} /> : null}
    {viewer !== null ? <ProfileMediaViewer api={api} user={shown} start={viewer} onClose={() => setViewer(null)} /> : null}
  </Modal>;
}

/** Lighter (amount > 0) or darker (< 0) version of a #RRGGBB colour, for the profile header tint. */
function shade(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#596FE8';
  const n = parseInt(m[1], 16); const mix = (c: number) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}
