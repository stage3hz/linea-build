import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ProfileEffect } from './platina/Effects';
import { ActivityIndicator, PanResponder, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions, Linking } from 'react-native';
import { MONO, Text } from './typography';
import { requestProfileEdit, requestStatusPicker } from './statusPickerRequest';
import * as FileSystem from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import type { Api } from './api';
import { Avatar, Button, Icon, IconButton, Notice, Sheet, ThemeSwitch, type IconName } from './components';
import { GlassBackdrop, GlassSurface } from './glass';
import { useTheme, formatSize, palette } from './theme';
import { DAY_STATE, type NightState } from './nightTheme';
import { effectiveNightMode, nightModesFor, themeFor, type NightMode } from './themePreference';
import { PALETTES } from './themes/palettes';
import { THEME_NAMES, ThemeSettings } from './ThemeSettings';
import { useMotion, usePowerFeatures, usePowerState } from './motion';
import type { AnimationMode } from './motionPolicy';
import { AppIconPicker } from './AppIconPicker';
import { StatusEmoji } from './StatusEmoji';
import { TEXT_SIZES, WALLPAPERS, setChatPreferences, textMetrics, useChatPreferences } from './chatPreferences';
import { LinearGradient } from 'expo-linear-gradient';
import { clearDecryptedAttachmentCache } from './e2ee/attachments';
import { clearPhotoCache } from './photo/pipeline';
import { clearVideoCache } from './media/pipeline';
import type { Chat, DarkTheme, ThemeMode, User } from './types';
import { FolderEditor, useChatFolders, type ChatFolder } from './ChatFolders';
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StackBase, StackScreen } from './stack';
import { currentEndpoint } from './servers/pool';
import { FloatingHeader, useBleed, useTabInset } from './tabInset';
import { WallpaperPicker } from './WallpaperPicker';
import { DecoratedAvatar, ProfileBanner } from './platina/Decor';
import { PlatinaGem, PlatinaName, PlatinaSeal, hasPlatina, openPlatinaShowcase } from './platina/PlatinaMark';
import { usePlatina } from './platina/usePlatina';
import { CallPrivacy } from './privacy/CallPrivacy';
import { LAST_SEEN_MODES, lastSeenSummary, listsFor } from './privacy/lastSeenModel';
import { changePrivacy, lastSeenModeOf, loadLastSeenRules, loadPrivacy, setLastSeenRule, usePrivacy } from './privacy/privacyStore';
import { AudioSettings } from './audio/AudioSettings';
import { OverlaySettings } from './overlay/OverlaySettings';
import { lightFeedback } from './haptics';
import { LANGUAGES, getLanguage, setLanguage, tr, useLanguage } from './i18n';
import { fileLimits, type FileLimits } from './e2ee/attachments';
import { PasscodeRow, PasscodeSection } from './lock/PasscodeSettings';
import { NotificationsSection } from './notifications/NotificationsSection';
import { isMuted } from './notifications/model';

type Section = 'root' | 'appearance' | 'night' | 'privacy' | 'lastSeen' | 'lastSeenAllow' | 'lastSeenDeny' | 'passcode' | 'data' | 'language' | 'folders' | 'power' | 'audio' | 'overlay' | 'notifications';
type Props = {
  api: Api; user: User; theme: ThemeMode; darkTheme: DarkTheme;
  /** From the one `useNightState` in App: the night theme on screen, the rule's own verdict and whether it is known yet (dev previews leave it out: day). */
  nightState?: NightState;
  onTheme: (mode: ThemeMode) => void; onDarkTheme: (mode: DarkTheme) => void;
  onBack: () => void; onProfile: () => void; onSecurity: () => void; onMusic: () => void; onLogout: () => Promise<void>;
  chats?: Chat[];
};

/** Settings hub: profile on top, grouped sections below. */
export function SettingsScreen(props: Props) {
  // A real stack like Telegram: every opened section is its own entry and back removes exactly one
  // (Оформление › Энергосбережение › back returns to Оформление, not to the settings root).
  const [stack, setStack] = useState<Section[]>([]);
  const open = (next: Section) => setStack(current => current[current.length - 1] === next || current.length >= 3 ? current : [...current, next]);
  const pop = (depth: number) => setStack(current => current.slice(0, depth));
  const p0 = useSharedValue(1), p1 = useSharedValue(1), p2 = useSharedValue(1);
  const levels = [p0, p1, p2];
  const page = (current: Section, onBack: () => void) => {
    const title = current === 'night' ? 'Ночная тема' : current === 'overlay' ? 'Оверлей' : current === 'audio' ? 'Звук и микрофон' : current === 'appearance' ? 'Оформление' : current === 'privacy' ? 'Конфиденциальность' : current === 'lastSeen' ? 'Время захода' : current === 'lastSeenAllow' ? 'Всегда показывать' : current === 'lastSeenDeny' ? 'Никогда не показывать' : current === 'passcode' ? 'Код-пароль' : current === 'data' ? 'Данные и память' : current === 'language' ? 'Язык' : current === 'folders' ? 'Папки с чатами' : current === 'power' ? 'Энергосбережение' : current === 'notifications' ? 'Уведомления и звуки' : 'Настройки';
    if (current === 'root') return <Root {...props} onBack={onBack} open={open} />;
    return <Page title={title} backLabel="Назад" onBack={onBack}>
      {current === 'appearance' ? <Appearance {...props} open={open} /> : current === 'night' ? <NightSettings {...props} /> : current === 'privacy' ? <PrivacySection api={props.api} open={open} /> : current === 'lastSeen' ? <LastSeenSection api={props.api} open={open} /> : current === 'lastSeenAllow' || current === 'lastSeenDeny' ? <LastSeenExceptions api={props.api} user={props.user} chats={props.chats || []} rule={current === 'lastSeenAllow' ? 'allow' : 'deny'} /> : current === 'passcode' ? <PasscodeSection /> : current === 'language' ? <LanguageSection /> : current === 'folders' ? <FoldersSection api={props.api} user={props.user} chats={props.chats || []} /> : current === 'power' ? <Group><MotionSettings /></Group> : current === 'audio' ? <AudioSettings /> : current === 'overlay' ? <OverlaySettings /> : current === 'notifications' ? <NotificationsSection api={props.api} chats={props.chats || []} /> : <DataSection api={props.api} />}
    </Page>;
  };
  // Each level slides in over the previous one, which shifts aside and dims (StackBase) and closes
  // with the same swipe to the right as chats.
  const level = (index: number): React.ReactNode => {
    if (index >= stack.length) return null;
    const covered = index + 1 < stack.length;
    return <StackScreen key={`${index}-${stack[index]}`} progress={levels[index]} onBack={() => pop(index)}>{back => <View style={{ flex: 1 }}>
      <StackBase progress={levels[index + 1] || levels[index]} covered={covered}><View style={{ flex: 1 }}><PageBackdrop />{page(stack[index], back)}</View></StackBase>
      {level(index + 1)}
    </View>}</StackScreen>;
  };
  // overflow hidden only on desktop: there the root list slides aside under the section and must not paint
  // over the chat list. On phones the pages reach under the status bar and the home indicator.
  return <View style={{ flex: 1, overflow: Platform.OS === 'web' ? 'hidden' : 'visible' }}>
    <StackBase progress={p0} covered={stack.length > 0}>{page('root', props.onBack)}</StackBase>
    {level(0)}
  </View>;
}

function PageBackdrop() {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={{ position: 'absolute', top: -insets.top, bottom: -insets.bottom, left: 0, right: 0 }}><GlassBackdrop /></View>;
}

function Page({ title, backLabel, onBack, children }: { title: string; backLabel: string; onBack: () => void; children: React.ReactNode }) {
  const t = useTheme(); const tabInset = useTabInset(); const [headerHeight, setHeaderHeight] = useState(84); const bleed = useBleed();
  // The list scrolls under the glass header and tab bar (blurred), as in Telegram — no hard cut edges.
  return <View style={{ flex: 1 }}>
    <ScrollView style={bleed.style} contentInsetAdjustmentBehavior="never" scrollIndicatorInsets={{ top: headerHeight, bottom: tabInset + bleed.bottom }} contentContainerStyle={{ padding: 14, paddingTop: headerHeight + 16, gap: 16, paddingBottom: 30 + tabInset + bleed.bottom, width: '100%', maxWidth: 680, alignSelf: 'center' }}>{children}</ScrollView>
    <FloatingHeader onHeight={setHeaderHeight}>
    <GlassSurface lens radius={27} style={{ margin: 12, marginBottom: 7 }} contentStyle={{ padding: 8, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 60 }}>
      <IconButton name="chevron-back" label={backLabel} onPress={onBack} />
      <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>{title}</Text>
    </GlassSurface>
    </FloatingHeader>
  </View>;
}

export function Group({ children, label }: { children: React.ReactNode; label?: string }) {
  const t = useTheme(); const language = useLanguage();
  return <View style={{ gap: 7 }}>
    {label ? <Text raw style={{ color: t.muted, fontSize: 11, fontWeight: t.black ? '500' : '700', letterSpacing: 1.2, paddingHorizontal: 8 }}>{tr(label, language).toUpperCase()}</Text> : null}
    {/* «Чёрная» (Linear): a flat card one step lighter than the page, hairline rows — no glass, no white outline. */}
    {t.black ? <View style={{ borderRadius: 12, overflow: 'hidden', backgroundColor: t.glassOpaque, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>
      {React.Children.toArray(children).filter(Boolean).map((child, index) => <View key={index} style={index ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border, marginLeft: 57 } : null}><View style={index ? { marginLeft: -57 } : null}>{child}</View></View>)}
    </View> : <GlassSurface radius={20} shadow={false} contentStyle={{ paddingVertical: 2, overflow: 'hidden', borderRadius: 20 }}>{children}</GlassSurface>}
  </View>;
}

export function Item({ icon, color, label, value, onPress, danger = false }: { icon: IconName; color: string; label: string; value?: string; onPress: () => void; danger?: boolean }) {
  const t = useTheme();
  const iconScale = useSharedValue(1); const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: iconScale.value }] }));
  return <Pressable accessibilityRole="button" onPress={onPress} onPressIn={() => { iconScale.value = withSpring(.82, { damping: 14, stiffness: 420 }); }} onPressOut={() => { iconScale.value = withSpring(1, { damping: 9, stiffness: 260 }); }} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 13, minHeight: 48, paddingHorizontal: 14, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
    {/* Telegram: the coloured icon squishes under the finger and springs back. */}
    <Animated.View style={[{ width: 30, height: 30, borderRadius: 8, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }, iconStyle]}><Icon name={icon} size={17} color="#FFF" /></Animated.View>
    <Text style={{ flex: 1, color: danger ? t.danger : t.text, fontSize: 15 }}>{label}</Text>
    {value ? <Text style={{ color: t.muted, fontSize: 13 }}>{value}</Text> : null}
    {!danger ? <Icon name="chevron-forward" size={17} color={t.subtle} /> : null}
  </Pressable>;
}

export function Toggle({ label, description, value, onChange, disabled = false, badge }: { label: string; description: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean; badge?: string }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 }}>
    <View style={{ flex: 1, gap: 3 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Text style={{ color: t.text, fontSize: 15 }}>{label}</Text>{badge ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: t.accentSoft }}><Icon name="lock-closed" size={10} color={t.accent} /><Text style={{ color: t.accent, fontSize: 11, fontWeight: '700' }}>{badge}</Text></View> : null}</View>{description ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{description}</Text> : null}</View>
    <ThemeSwitch accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onChange} />
  </View>;
}

function Root({ api, user, theme, darkTheme, nightState = DAY_STATE, onBack, onProfile, onSecurity, onMusic, onLogout, open, chats }: Props & { open: (section: Section) => void }) {
  const tabInset = useTabInset();
  const mutedChats = (chats || []).filter(chat => isMuted(chat.settings)).length;
  // The row names the theme on screen (the night theme at night), not the day choice behind it.
  const { night } = nightState;
  const language = useLanguage();
  const folders = useChatFolders(user.id);
  const t = useTheme(); const preferences = useChatPreferences(); const insets = useSafeAreaInsets(); const { width } = useWindowDimensions();
  const commit = String((Constants.expoConfig?.extra as { commit?: string } | undefined)?.commit || '');
  const version = `${Constants.expoConfig?.version || ''}${commit ? ` (${commit})` : ''}`;
  const active = usePlatina(api, user.id);
  const [until, setUntil] = useState<string | null>(null);
  useEffect(() => { let alive = true; api.usernameStatus().then(status => { if (!alive) return; const p = status.platina; setUntil(p.permanent ? 'Бессрочно' : p.expiresAt ? `Активна до ${new Date(p.expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : 'Активна'); }).catch(() => {}); return () => { alive = false; }; }, [api, user.id]);
  const bannerHeight = 200 + insets.top;
  const hasBanner = !!(user.bannerId || user.bannerPreset);
  // Telegram: pulling the list down stretches the header picture and keeps it at the top of the screen
  // (no empty strip above it). Grows by the pull distance, scaled around its centre, shifted up by half.
  const pull = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler(e => { pull.value = Math.min(0, e.contentOffset.y); });
  const stretch = useAnimatedStyle(() => ({ transform: [{ translateY: pull.value / 2 }, { scale: 1 - pull.value / bannerHeight }] }));
  // The scroll view itself starts under the status bar (the screen sits in a SafeAreaView): a negative
  // margin on its content was clipped by the scroll view, leaving a strip above the banner on iPhone.
  return <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} style={{ marginTop: -insets.top, marginBottom: Platform.OS === 'web' ? 0 : -insets.bottom }} contentContainerStyle={{ paddingBottom: 30 + tabInset + (Platform.OS === 'web' ? 0 : insets.bottom) }} showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="never">
    {/* Telegram's settings head with Discord's banner: the banner runs under the status bar. */}
    <View style={{ height: bannerHeight }}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, stretch]}>{hasBanner ? <ProfileBanner user={user} api={api} height={bannerHeight} width={width} /> : <LinearGradient colors={t.dark ? ['rgba(96,124,190,0.34)', 'rgba(150,120,200,0.14)', 'transparent'] : ['rgba(120,150,230,0.30)', 'rgba(190,170,240,0.16)', 'transparent']} start={{ x: 0.1, y: 0 }} end={{ x: 0.7, y: 1 }} style={StyleSheet.absoluteFill} />}</Animated.View>
      <ProfileEffect effect={user.profileEffect} width={width} height={bannerHeight + 140} />
      <View style={{ position: 'absolute', top: insets.top + 6, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' }}>
        {/* Settings is a tab root (Telegram): no back button; the space keeps «Изм.» on the right. */}
        <View style={{ width: 44, height: 44 }} />
        <GlassSurface radius={22} shadow={false} interactive contentStyle={{ height: 44, paddingHorizontal: 16, justifyContent: 'center' }}><Pressable accessibilityRole="button" onPress={() => { requestProfileEdit(); onProfile(); }} hitSlop={6}><Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Изм.</Text></Pressable></GlassSurface>
      </View>
    </View>
    {/* Same column as the list below (on a wide PC window the head used to hug the left edge). */}
    <View style={{ marginTop: -58, paddingHorizontal: 20, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Мой профиль" onPress={onProfile} style={{ alignSelf: 'flex-start', padding: 5 }}>
        <DecoratedAvatar user={user} api={api} size={100} animated />
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <PlatinaName user={user} numberOfLines={2} style={{ color: t.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Сменить статус рядом с именем" hitSlop={10} onPress={() => { requestStatusPicker(); onProfile(); }}><StatusEmoji user={user} size={22} animated /></Pressable>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 }}>
        <Text style={{ color: t.muted, fontSize: 15 }}>@{user.username}</Text>
        {hasPlatina(user) ? <PlatinaSeal owner={user} onPress={() => openPlatinaShowcase()} /> : null}
      </View>
    </View>
    <View style={{ paddingHorizontal: 16, paddingTop: 18, gap: 14, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      {/* With Platina the seal next to the name already says it (tap it for details): no second banner here. */}
      {active || hasPlatina(user) ? null : <PlatinaOffer />}
      {/* Grouped like Telegram: you, how it looks, privacy & data, the PC's sound, help. No duplicates
          (Музыка has its own tab; animations live only under Энергосбережение). */}
      <Group>
        <Item icon="person" color="#E2574C" label="Мой профиль" onPress={onProfile} />
      </Group>
      <Group>
        {/* Telegram's red bell, right after the profile; the row says how many chats are quiet right now. */}
        <Item icon="notifications" color="#E0453A" label="Уведомления и звуки" value={mutedChats ? `Без звука: ${mutedChats}` : undefined} onPress={() => open('notifications')} />
        <Item icon="color-palette" color="#25A69A" label="Оформление" value={THEME_NAMES[themeFor(theme, darkTheme, night)]} onPress={() => open('appearance')} />
        <Item icon="folder" color="#3D8BFD" label="Папки с чатами" value={folders.folders.length ? String(folders.folders.length) : undefined} onPress={() => open('folders')} />
        <Item icon="battery-half" color="#F0A030" label="Энергосбережение и анимации" onPress={() => open('power')} />
        <Item icon="language" color="#7B61FF" label="Язык" value={LANGUAGES.find(item => item.id === language)?.native} onPress={() => open('language')} />
      </Group>
      <Group>
        <Item icon="lock-closed" color="#8C62E8" label="Конфиденциальность" onPress={() => open('privacy')} />
        <Item icon="shield-checkmark" color="#34A853" label="Безопасность и устройства" onPress={onSecurity} />
        <Item icon="server" color="#E39A3B" label="Данные и память" onPress={() => open('data')} />
      </Group>
      {Platform.OS === 'web' ? <Group>
        <Item icon="mic" color="#E5467A" label="Звук и микрофон" onPress={() => open('audio')} />
        <Item icon="game-controller" color="#5865F2" label="Оверлей в играх" onPress={() => open('overlay')} />
      </Group> : null}
      <Group>
        <Item icon="help-buoy" color="#2AA9E0" label="Помощь и поддержка" onPress={() => { void Linking.openURL(`${currentEndpoint()}/support`).catch(() => {}); }} />
      </Group>
      <Group>
        <Item icon="log-out-outline" color="#D9534F" label="Выйти из аккаунта" danger onPress={() => void onLogout()} />
      </Group>
      {/* «Чёрная» (Linear): the technical line in a monospaced face, quiet grey. */}
      {t.black ? <Text raw style={{ color: t.subtle, fontSize: 12, textAlign: 'center', fontFamily: MONO, letterSpacing: -0.15 }}>INVIZENT {version} · e2ee · signal</Text>
        : <Text style={{ color: t.muted, fontSize: 11, textAlign: 'center' }}>Инвиз {version} · переписка защищена сквозным шифрованием</Text>}
    </View>
  </Animated.ScrollView>;
}

/** For accounts without Platina: one calm card, never a shouting banner. */
function PlatinaOffer() {
  const t = useTheme();
  return <GlassSurface radius={22} shadow={false} contentStyle={{ padding: 16 }}>
    <PlatinaName user={{ displayName: 'ИНВИЗ PLATINA', seal: 'platina' }} style={{ fontSize: 11, fontWeight: '800', letterSpacing: 2.4 }} />
    <Text style={{ color: t.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3, lineHeight: 23, marginTop: 8 }}>Твой профиль —{'\n'}заметнее любого другого</Text>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginTop: 6 }}>Живой баннер и аватар, платиновое имя, рамки, невидимка и всё, что выйдет дальше.</Text>
    <Pressable accessibilityRole="button" onPress={() => { lightFeedback(); openPlatinaShowcase(); }} style={({ pressed }) => ({ height: 46, borderRadius: 15, overflow: 'hidden', marginTop: 14, alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? .96 : 1 }] })}>
      <LinearGradient colors={['#E9EDF3', '#FFFFFF', '#BCC5D3', '#F6F8FB']} start={{ x: 0, y: 0.3 }} end={{ x: 1, y: 0.7 }} style={StyleSheet.absoluteFill} />
      <Text style={{ color: '#12151C', fontSize: 15, fontWeight: '800' }}>Попробовать Platina</Text>
    </Pressable>
  </GlassSurface>;
}

function Appearance({ api, user, theme, darkTheme, nightState = DAY_STATE, onTheme, onDarkTheme, open }: Props & { open?: (section: Section) => void }) {
  const t = useTheme(); const active = usePlatina(api, user.id); const preferences = useChatPreferences(); const metrics = textMetrics(preferences.textSize);
  const [wallpaperOpen, setWallpaperOpen] = useState(false);
  return <>
    <Group label="Тема"><View style={{ padding: 14 }}><ThemeSettings mode={theme} darkTheme={darkTheme} nightState={nightState} onChange={value => { if (preferences.nightMode === null) setChatPreferences({ nightMode: theme === 'system' ? 'system' : 'off' }); onTheme(value); }} onDarkTheme={onDarkTheme} platina={active} onLocked={() => openPlatinaShowcase()} /></View></Group>
    {nightState.night && themeFor(theme, darkTheme, false) !== darkTheme ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 8, marginTop: -6 }}>{`Включён ночной режим. Дневная тема «${THEME_NAMES[themeFor(theme, darkTheme, false)]}» вернётся, когда он выключится.`}</Text> : null}
    {/* Telegram: «Ночной режим» switches now; «Ночная тема» — when it switches by itself and which theme. */}
    <Group>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 }}>
        <Text style={{ flex: 1, color: t.text, fontSize: 15 }}>Ночной режим</Text>
        {/* Disabled until the rule has its input (the brightness is read a moment after mount): a tap then would stamp a premature `nightForcedAt`. */}
        <ThemeSwitch accessibilityLabel="Ночной режим" value={nightState.night} disabled={!nightState.known} onValueChange={value => setChatPreferences({ nightForced: value, nightForcedAt: nightState.auto })} />
      </View>
      <Item icon="moon" color="#5856D6" label="Ночная тема" value={NIGHT_LABELS[effectiveNightMode({ mode: preferences.nightMode, from: preferences.nightFrom, to: preferences.nightTo, brightness: preferences.nightBrightness }, theme, Platform.OS)]} onPress={() => open?.('night')} />
    </Group>
    {Platform.OS === 'ios' ? <Group label="Иконка приложения"><AppIconPicker /></Group> : null}
    <Group><Toggle label="Пиксельный след" description="Сетка пикселей подсвечивается под пальцем и курсором: белая в тёмной теме, чёрная в светлой" value={preferences.pixelTrail} onChange={value => setChatPreferences({ pixelTrail: value })} /></Group>
    {Platform.OS === 'web' ? <Group><Toggle label="Снег" description="Снег падает в окне, ложится на сообщения, панели и верх окна; курсор его смахивает" value={preferences.snow} onChange={value => setChatPreferences({ snow: value })} /></Group> : null}
    <Group label="Обои чатов"><Item icon="image" color="#2EA37A" label="Обои чатов" value="Выбрать" onPress={() => setWallpaperOpen(true)} /></Group>
    <WallpaperPicker visible={wallpaperOpen} onClose={() => setWallpaperOpen(false)} />
    <Group label="Углы сообщений"><View style={{ padding: 14, flexDirection: 'row', gap: 7 }}>{([[8, 'Острые'], [14, 'Средние'], [20, 'Круглые']] as const).map(([value, label]) => {
      const selected = preferences.bubbleRadius === value;
      return <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => setChatPreferences({ bubbleRadius: value })} style={{ flex: 1, alignItems: 'center', gap: 8, paddingVertical: 10, borderRadius: 15, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><View style={{ width: 46, height: 22, borderRadius: value, borderBottomRightRadius: Math.min(6, value), backgroundColor: t.bubble }} /><Text style={{ color: selected ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{label}</Text></Pressable>;
    })}</View></Group>
    <Group label="Размер текста в чатах">
      <View style={{ padding: 14, gap: 12 }}>
        <View style={{ alignSelf: 'flex-start', maxWidth: '85%', backgroundColor: t.incoming, borderRadius: 20, borderBottomLeftRadius: 7, paddingHorizontal: 12, paddingVertical: 9 }}><Text style={{ color: t.text, fontSize: metrics.fontSize, lineHeight: metrics.lineHeight }}>Привет! Так будет выглядеть текст сообщений.</Text></View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{TEXT_SIZES.map(size => {
          const selected = size.id === preferences.textSize;
          return <Pressable key={size.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => setChatPreferences({ textSize: size.id })} style={{ paddingHorizontal: 13, paddingVertical: 9, borderRadius: 15, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><Text style={{ color: selected ? t.accent : t.text, fontSize: 13, fontWeight: '600' }}>{size.label}</Text></Pressable>;
        })}</View>
      </View>
    </Group>
  </>;
}

const NIGHT_LABELS: Record<NightMode, string> = { system: 'Системная', off: 'Выключена', schedule: 'По расписанию', auto: 'Автоматически' };
const NIGHT_THEMES: DarkTheme[] = ['dark', 'black', 'graphite'];

/** Telegram «Смена темы ночью»: when (system / never / by schedule / by screen brightness) and which night theme.
 *  «От заката до восхода» is left out: it needs the location, which the app does not ask for. */
function NightSettings({ api, user, theme, darkTheme, onDarkTheme }: Props) {
  const t = useTheme(); const preferences = useChatPreferences(); const platina = usePlatina(api, user.id);
  const settings = { mode: preferences.nightMode, from: preferences.nightFrom, to: preferences.nightTo, brightness: preferences.nightBrightness };
  const kind = effectiveNightMode(settings, theme, Platform.OS);
  const [editing, setEditing] = useState<'nightFrom' | 'nightTo' | null>(null);
  const choose = (mode: NightMode) => setChatPreferences({ nightMode: mode, nightForced: null, nightForcedAt: null });
  const themes = [...NIGHT_THEMES, ...(platina ? PALETTES.map(p => p.id) : [])] as DarkTheme[];
  return <>
    {/* «Автоматически» (by the screen brightness) is offered only where the brightness can be read: not on the PC. */}
    <Group>{nightModesFor(Platform.OS).map(mode => <Pressable key={mode} accessibilityRole="radio" accessibilityState={{ selected: kind === mode }} onPress={() => choose(mode)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 50, backgroundColor: pressed ? 'rgba(127,127,127,0.1)' : 'transparent' })}>
      <View style={{ width: 22 }}>{kind === mode ? <Icon name="checkmark" size={20} color={t.accent} /> : null}</View>
      <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>{NIGHT_LABELS[mode]}</Text>
    </Pressable>)}</Group>
    {kind === 'schedule' ? <Group label="Время использования">
      <Item icon="moon" color="#5856D6" label="Начало" value={preferences.nightFrom} onPress={() => setEditing('nightFrom')} />
      <Item icon="sunny" color="#F5A623" label="Конец" value={preferences.nightTo} onPress={() => setEditing('nightTo')} />
    </Group> : null}
    {kind === 'auto' ? <Group label="Порог яркости"><View style={{ padding: 14, gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 7 }}>{[0.1, 0.25, 0.4, 0.6].map(level => { const on = Math.abs(preferences.nightBrightness - level) < 0.01; return <Pressable key={level} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => setChatPreferences({ nightBrightness: level })} style={{ flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 13, backgroundColor: on ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: on ? t.accent : t.border }}><Text style={{ color: on ? t.accent : t.text, fontSize: 14, fontWeight: on ? '700' : '500' }}>{`${Math.round(level * 100)}%`}</Text></Pressable>; })}</View>
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{`Ночная тема включится, когда яркость экрана опустится до ${Math.round(preferences.nightBrightness * 100)}% и ниже.`}</Text>
    </View></Group> : null}
    {kind === 'system' ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 8 }}>Ночная тема включается вместе с тёмным оформлением iPhone или Android.</Text> : null}
    <Group label="Выбранная ночная тема"><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 14, gap: 12 }}>
      {themes.map(id => { const p = palette[id]; const on = darkTheme === id; return <Pressable key={id} accessibilityRole="radio" accessibilityLabel={THEME_NAMES[id]} accessibilityState={{ selected: on }} onPress={() => onDarkTheme(id)} style={{ alignItems: 'center', gap: 8 }}>
        <View style={{ width: 112, height: 72, borderRadius: 16, padding: 10, gap: 8, backgroundColor: p.bg, borderWidth: on ? 2.5 : 1, borderColor: on ? t.accent : t.border, justifyContent: 'center' }}>
          <View style={{ width: '62%', height: 13, borderRadius: 7, backgroundColor: p.incoming }} />
          <View style={{ alignSelf: 'flex-end', width: '58%', height: 13, borderRadius: 7, backgroundColor: p.bubble }} />
        </View>
        <Text style={{ color: on ? t.accent : t.text, fontSize: 13, fontWeight: on ? '700' : '500' }}>{THEME_NAMES[id]}</Text>
      </Pressable>; })}
    </ScrollView></Group>
    <Sheet visible={editing !== null} title={editing === 'nightTo' ? 'Конец' : 'Начало'} onClose={() => setEditing(null)}>
      {editing ? <TimePicker value={preferences[editing]} onDone={value => { setChatPreferences({ [editing]: value, nightForced: null, nightForcedAt: null }); setEditing(null); }} /> : null}
    </Sheet>
  </>;
}

function TimePicker({ value, onDone }: { value: string; onDone: (value: string) => void }) {
  const t = useTheme(); const [h, m] = value.split(':'); const [hour, setHour] = useState(h); const [minute, setMinute] = useState(m);
  const chip = (label: string, on: boolean, press: () => void) => <Pressable key={label} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={press} style={{ width: 52, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : t.surface2 }}><Text style={{ color: on ? t.onAccent : t.text, fontSize: 15, fontWeight: on ? '700' : '500' }}>{label}</Text></Pressable>;
  return <View style={{ gap: 14 }}>
    <Text style={{ color: t.text, fontSize: 28, fontWeight: '700', textAlign: 'center' }}>{`${hour}:${minute}`}</Text>
    <Text style={{ color: t.muted, fontSize: 12 }}>Часы</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map(x => chip(x, x === hour, () => setHour(x)))}</View>
    <Text style={{ color: t.muted, fontSize: 12 }}>Минуты</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{['00', '15', '30', '45'].map(x => chip(x, x === minute, () => setMinute(x)))}</View>
    <Button label="Готово" onPress={() => onDone(`${hour}:${minute}`)} />
  </View>;
}

function PrivacySection({ api, open }: { api: Api; open: (section: Section) => void }) {
  const t = useTheme(); const preferences = useChatPreferences(); const language = useLanguage();
  // Shared with the «Время захода» pages (privacy/privacyStore): a change there shows here at once.
  const { privacy, platina, rules, saving, error } = usePrivacy(api, { rules: true, fresh: true });
  const change = (patch: Parameters<typeof changePrivacy>[1]) => void changePrivacy(api, patch);
  return <>
    {error ? <Notice text={error} error onRetry={privacy ? undefined : () => loadPrivacy(api)} /> : null}
    {/* Telegram: the device lock sits first on the privacy screen. */}
    <Group label="Безопасность"><PasscodeRow onPress={() => open('passcode')} /></Group>
    <Group label="На сервере">
      {!privacy ? <ActivityIndicator color={t.accent} style={{ padding: 20 }} /> : <>
        <Item icon="time" color="#30B0C7" label="Время захода" value={lastSeenSummary(lastSeenModeOf(privacy), rules, text => tr(text, language))} onPress={() => open('lastSeen')} />
        <Toggle label="Новые разговоры" description="Кто ещё не писал тебе, сможет начать чат. Выключи, чтобы писали только те, с кем переписка уже есть." value={privacy.allowNewChats} disabled={saving} onChange={value => change({ allowNewChats: value })} />
        <Toggle label="Фото профиля для других" description="Если выключить, собеседники и поиск увидят цветной аватар вместо фото." value={privacy.showAvatar} disabled={saving} onChange={value => change({ showAvatar: value })} />
        {/* Not in Telegram's private chats: hides the checkmarks themselves (both ways), a Platina extra. «Время прочтения» is on the «Время захода» page. */}
        <Toggle label="Отчёты о прочтении" badge={platina ? undefined : 'Platina'} description={platina ? 'Взаимно: если выключить, ты тоже не увидишь, прочитали ли твои сообщения.' : 'Скрывать прочтение можно с Platina.'} value={privacy.readReceipts} disabled={saving || !platina} onChange={value => change({ readReceipts: value })} />
      </>}
    </Group>
    <Group label="Звонки">
      {!privacy ? <ActivityIndicator color={t.accent} style={{ padding: 20 }} /> : <CallPrivacy api={api} mode={privacy.calls || 'everyone'} disabled={saving} onMode={calls => change({ calls })} />}
    </Group>
    <Group label="На этом устройстве">
      <Toggle label="Показывать «печатает…»" description="Собеседник видит, что ты набираешь сообщение." value={preferences.sendTyping} onChange={value => setChatPreferences({ sendTyping: value })} />
    </Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 6 }}>Содержимое сообщений, ответы, реакции, правки и закрепления шифруются на устройстве. Сервер видит только служебные данные: кто, кому и когда.</Text>
  </>;
}

/** «Время захода», Telegram's screen: who sees it, the two exception lists, «Скрывать время прочтения». */
function LastSeenSection({ api, open }: { api: Api; open: (section: Section) => void }) {
  const t = useTheme();
  const { privacy, platina, rules, saving, error, rulesError } = usePrivacy(api, { rules: true });
  if (!privacy) return error ? <Notice text={error} error onRetry={() => loadPrivacy(api)} /> : <ActivityIndicator color={t.accent} style={{ padding: 20 }} />;
  const mode = lastSeenModeOf(privacy), lists = listsFor(mode);
  const count = (users?: unknown[]) => users ? (users.length ? String(users.length) : 'Добавить') : '';
  // Telegram shows «Скрывать время прочтения» once the time is hidden from anyone.
  const hidesFromSomeone = mode !== 'everyone' || !!rules?.deny.length;
  const foot = { color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 8, marginTop: -8 } as const;
  return <>
    {error ? <Notice text={error} error /> : null}
    <Group label="Кто видит, когда я в сети">
      {LAST_SEEN_MODES.map(item => {
        const selected = item.value === mode;
        return <Pressable key={item.value} accessibilityRole="radio" accessibilityLabel={tr(item.label)} accessibilityState={{ selected, disabled: saving }} disabled={saving} onPress={() => { if (selected) return; lightFeedback(); void changePrivacy(api, { lastSeen: item.value }); }}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingHorizontal: 16, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
          <Text style={{ flex: 1, color: t.text, fontSize: 15 }}>{item.label}</Text>
          {selected ? <Icon name="checkmark" size={20} color={t.accent} /> : null}
        </Pressable>;
      })}
    </Group>
    <Text style={foot}>Без подписки Platina вы не будете видеть появление в сети и время последнего захода пользователей, от которых скрыли свои. Вместо точного времени будет видно примерное значение (недавно, на этой неделе, в этом месяце).</Text>
    {rulesError ? <Notice text={rulesError} error onRetry={() => loadLastSeenRules(api)} /> : null}
    <Group label="Исключения">
      {lists.allow ? <Item icon="checkmark-circle" color="#34C759" label="Всегда показывать" value={count(rules?.allow)} onPress={() => open('lastSeenAllow')} /> : null}
      {lists.deny ? <Item icon="remove-circle" color="#FF3B30" label="Никогда не показывать" value={count(rules?.deny)} onPress={() => open('lastSeenDeny')} /> : null}
    </Group>
    <Text style={foot}>Вы можете добавить пользователей в список исключений из настроек выше.</Text>
    {hidesFromSomeone ? <>
      <Group><Toggle label="Скрывать время прочтения" description="" value={privacy.hideReadTime === true} disabled={saving} onChange={value => void changePrivacy(api, { hideReadTime: value })} /></Group>
      <Text style={foot}>Не показывать время прочтения сообщений пользователям, от которых вы скрыли время захода. Если включить, их время прочтения тоже будет скрыто от вас. Отметки о прочтении при этом остаются. Подписчики Platina видят время прочтения, даже если скрыли своё.</Text>
      <Group><Item icon="diamond" color="#8E8E93" label="Подписчик Platina" value={platina ? 'Активна' : undefined} onPress={() => { lightFeedback(); openPlatinaShowcase(); }} /></Group>
      <Text style={foot}>{platina ? 'С Platina вы видите время захода и прочтения других пользователей, даже если скрыли свои.' : 'Оформите Platina, чтобы видеть время захода и прочтения других пользователей, даже если скрыли свои.'}</Text>
    </> : null}
  </>;
}

/** «Всегда показывать» / «Никогда не показывать»: friends and chat partners to pick from, or anyone by @login. */
function LastSeenExceptions({ api, user, chats, rule }: { api: Api; user: User; chats: Chat[]; rule: 'allow' | 'deny' }) {
  const t = useTheme();
  const { rules, rulesError } = usePrivacy(api, { rules: true });
  const [friends, setFriends] = useState<User[]>([]);
  const [query, setQuery] = useState(''); const [found, setFound] = useState<User[]>([]); const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { let alive = true; api.contacts().then(result => { if (alive) setFriends(result.users); }).catch(() => {}); return () => { alive = false; }; }, [api]);
  // Global search follows the app's rules (an exact @login, or four letters and more); people from chats
  // and friends are filtered on the device.
  const needle = query.trim().replace(/^@/, '').toLowerCase();
  useEffect(() => {
    setFound([]);
    if (needle.length < 2 || (!query.trim().startsWith('@') && needle.length < 4)) return;
    let alive = true;
    const timer = setTimeout(() => { api.users(query.trim()).then(result => { if (alive) setFound(result.users); }).catch(() => {}); }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [api, query, needle]);
  const listed = rules?.[rule] || [];
  const inList = new Set(listed.map(item => item.id));
  const candidates = useMemo(() => {
    const seen = new Set<string>(), out: User[] = [];
    for (const person of [...friends, ...chats.map(chat => chat.peer), ...found]) {
      if (!person || person.id === user.id || seen.has(person.id)) continue;
      seen.add(person.id); out.push(person);
    }
    return out;
  }, [friends, chats, found, user.id]);
  const matches = candidates.filter(person => !inList.has(person.id) && (!needle || person.displayName.toLowerCase().includes(needle) || (person.username || '').toLowerCase().includes(needle))).slice(0, 50);
  const toggle = async (person: User, add: boolean) => {
    if (busy) return; setBusy(person.id); lightFeedback();
    try { await setLastSeenRule(api, person.id, add ? rule : null); if (add) setQuery(''); } catch { /* shown as rulesError */ } finally { setBusy(null); }
  };
  const row = (person: User, add: boolean) => <Pressable key={person.id} accessibilityRole="button" accessibilityLabel={`${tr(add ? 'Добавить в список' : 'Убрать из списка')}: ${person.displayName}`} disabled={!!busy} onPress={() => void toggle(person, add)}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingHorizontal: 14, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
    <Avatar user={person} api={api} size={36} round />
    <View style={{ flex: 1, minWidth: 0 }}><Text raw numberOfLines={1} style={{ color: t.text, fontSize: 15 }}>{person.displayName}</Text>{person.username ? <Text raw numberOfLines={1} style={{ color: t.muted, fontSize: 12.5 }}>{`@${person.username}`}</Text> : null}</View>
    {busy === person.id ? <ActivityIndicator size="small" color={t.accent} /> : <Icon name={add ? 'add-circle' : 'close-circle'} size={22} color={add ? t.accent : t.muted} />}
  </Pressable>;
  return <>
    {rulesError ? <Notice text={rulesError} error onRetry={() => loadLastSeenRules(api)} /> : null}
    <Group label={rule === 'allow' ? 'Всегда показывать' : 'Никогда не показывать'}>
      {!rules ? <ActivityIndicator color={t.accent} style={{ padding: 20 }} /> : listed.length ? listed.map(person => row(person, false)) : <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, padding: 16 }}>Список пуст. Выбери людей ниже.</Text>}
    </Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 8, marginTop: -8 }}>{rule === 'allow' ? 'Эти люди всегда будут видеть время вашего захода, независимо от настроек выше.' : 'Эти люди никогда не будут видеть время вашего захода, независимо от настроек выше.'}</Text>
    <Group label="Добавить пользователей">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 14 }}>
        <Icon name="search" size={18} color={t.muted} />
        <TextInput value={query} onChangeText={setQuery} placeholder={tr('Имя или @логин')} placeholderTextColor={t.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="search" maxLength={60}
          accessibilityLabel={tr('Поиск людей')} style={{ flex: 1, color: t.text, fontSize: 15, paddingVertical: 10 }} />
        {query ? <Pressable accessibilityRole="button" accessibilityLabel={tr('Очистить')} onPress={() => setQuery('')} hitSlop={8}><Icon name="close-circle" size={18} color={t.muted} /></Pressable> : null}
      </View>
      {matches.map(person => row(person, true))}
      {!matches.length ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 16, paddingBottom: 14 }}>{needle ? 'Никого не нашли. Введи точный @логин.' : 'Здесь появятся друзья и люди из твоих чатов.'}</Text> : null}
    </Group>
  </>;
}

async function directorySize(uri: string, depth = 0): Promise<number> {
  if (depth > 5) return 0;
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return 0;
  if (!info.isDirectory) return info.size || 0;
  let total = 0;
  for (const name of await FileSystem.readDirectoryAsync(uri)) total += await directorySize(`${uri.replace(/\/?$/, '/')}${name}`, depth + 1).catch(() => 0);
  return total;
}

/** Telegram-like folder list: create, rename, pick chats, reorder. Kept only on this device. */
function FoldersSection({ api, user, chats }: { api: Api; user: User; chats: Chat[] }) {
  const t = useTheme(); const folders = useChatFolders(user.id);
  const [editor, setEditor] = useState<{ folder: ChatFolder | null } | null>(null);
  return <>
    <Group label="Мои папки">
      {folders.folders.length ? folders.folders.map((folder, index) => <View key={folder.id} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 54, paddingLeft: 14, paddingRight: 6 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={folder.name} onPress={() => setEditor({ folder })} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54 }}>
          <Icon name="folder-outline" size={21} color={t.accent} />
          <View style={{ flex: 1 }}><Text raw numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{folder.name}</Text><Text raw style={{ color: t.muted, fontSize: 12 }}>{folder.chatIds.length}</Text></View>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Выше" disabled={index === 0} onPress={() => folders.move(folder.id, -1)} hitSlop={6} style={{ padding: 8, opacity: index === 0 ? .3 : 1 }}><Icon name="chevron-up" size={18} color={t.muted} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Ниже" disabled={index === folders.folders.length - 1} onPress={() => folders.move(folder.id, 1)} hitSlop={6} style={{ padding: 8, opacity: index === folders.folders.length - 1 ? .3 : 1 }}><Icon name="chevron-down" size={18} color={t.muted} /></Pressable>
      </View>) : <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, padding: 16 }}>Папок пока нет. Создай папку — она появится вкладкой над списком чатов.</Text>}
    </Group>
    <Group><Item icon="add" color="#3D8BFD" label="Создать папку" onPress={() => setEditor({ folder: null })} /></Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 8 }}>Папки хранятся только на этом устройстве; сервер не знает, как ты группируешь чаты.</Text>
    <FolderEditor visible={!!editor} folder={editor?.folder || null} chats={chats} api={api} onClose={() => setEditor(null)} onSave={folder => { folders.upsert(folder); setEditor(null); }} onDelete={id => { folders.remove(id); setEditor(null); }} />
  </>;
}

/** Telegram-like language list: the choice applies at once and is kept on this device. */
function LanguageSection() {
  const t = useTheme(); const language = useLanguage();
  return <>
    <Group label="Язык интерфейса">
      {LANGUAGES.map(item => {
        const selected = item.id === language;
        return <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => { lightFeedback(); setLanguage(item.id); }} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
          <View style={{ flex: 1, gap: 2 }}><Text raw style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{item.native}</Text><Text raw style={{ color: t.muted, fontSize: 13 }}>{item.name}</Text></View>
          {selected ? <Icon name="checkmark" size={20} color={t.accent} /> : null}
        </Pressable>;
      })}
    </Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 8 }}>Язык меняется только в интерфейсе. Сообщения и имена остаются как есть.</Text>
  </>;
}

const GB = 1024 ** 3;
const storageLabel = (bytes: number) => bytes >= GB ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1).replace('.0', '')} ${getLanguage() === 'en' ? 'GB' : 'ГБ'}` : formatSize(bytes);

/** Files on the server: how much of the account's storage is used (20 GB, 40 GB with Platina). */
function ServerStorage({ api }: { api: Api }) {
  const t = useTheme(); const [limits, setLimits] = useState<FileLimits | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { let alive = true; fileLimits(api).then(value => { if (alive) setLimits(value); }).catch(() => { if (alive) setFailed(true); }); return () => { alive = false; }; }, [api]);
  const fraction = limits ? Math.min(1, limits.usedBytes / Math.max(1, limits.storageBytes)) : 0;
  return <Group label="Файлы на сервере">
    <View style={{ padding: 16, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="cloud-outline" size={22} color={t.accent} /><Text style={{ flex: 1, color: t.text, fontSize: 15 }}>Использовано</Text>{limits ? <Text raw style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{storageLabel(limits.usedBytes)} / {storageLabel(limits.storageBytes)}</Text> : failed ? <Text style={{ color: t.muted, fontSize: 13 }}>Недоступно</Text> : <ActivityIndicator color={t.accent} size="small" />}</View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)', overflow: 'hidden' }}><View style={{ width: `${Math.round(fraction * 100)}%`, height: 6, borderRadius: 3, backgroundColor: fraction > .9 ? t.danger : t.accent }} /></View>
      {limits ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{limits.platina ? 'Видео до 10 ГБ, файлы до 4 ГБ (Platina), всего 40 ГБ.' : 'Видео до 10 ГБ, файлы до 2 ГБ, всего 20 ГБ. С Platina — файлы до 4 ГБ и 40 ГБ всего.'}</Text> : null}
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Зашифрованные вложения из личных чатов. Сервер не может их прочитать.</Text>
    </View>
  </Group>;
}

function DataSection({ api }: { api: Api }) {
  const t = useTheme(); const [size, setSize] = useState<number | null>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState('');
  const measure = useCallback(() => { setSize(null); const dir = FileSystem.cacheDirectory; if (!dir) { setSize(0); return; } directorySize(dir).then(setSize).catch(() => setSize(0)); }, []);
  useEffect(measure, [measure]);
  const clear = async () => {
    setBusy(true); setDone('');
    try {
      await Promise.allSettled([clearDecryptedAttachmentCache(), clearPhotoCache(), clearVideoCache(), Image.clearDiskCache(), Image.clearMemoryCache()]);
      setDone('Кэш очищен. Переписка, ключи шифрования и твои музыкальные файлы не затронуты.');
    } finally { setBusy(false); measure(); }
  };
  return <>
    <ServerStorage api={api} />
    <Group label="Кэш на этом устройстве">
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="server-outline" size={22} color={t.accent} /><Text style={{ flex: 1, color: t.text, fontSize: 15 }}>Временные файлы</Text>{size === null ? <ActivityIndicator color={t.accent} size="small" /> : <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{formatSize(size)}</Text>}</View>
        <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Расшифрованные для просмотра вложения, обработанные фото и видео, миниатюры. Всё это можно скачать и расшифровать заново.</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void clear()} style={({ pressed }) => ({ minHeight: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accentSoft, borderWidth: 1, borderColor: t.border, opacity: busy ? .5 : pressed ? .7 : 1 })}>{busy ? <ActivityIndicator color={t.accent} /> : <Text style={{ color: t.accent, fontSize: 14, fontWeight: '700' }}>Очистить кэш</Text>}</Pressable>
        {done ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{done}</Text> : null}
      </View>
    </Group>
  </>;
}

const POWER_STEPS = [0, ...Array.from({ length: 19 }, (_, i) => (i + 1) / 20), 1];

/** Telegram «Энергосбережение»: a slider Выкл. … «При заряде менее N%» … Вкл., then the heavy processes. */
function MotionSettings() {
  const t = useTheme(); const preferences = useChatPreferences(); const motion = useMotion(); const features = usePowerFeatures(); const power = usePowerState(); const en = useLanguage() === 'en';
  const [width, setWidth] = useState(0);
  const index = Math.max(0, POWER_STEPS.findIndex(step => Math.abs(step - preferences.lowBattery) < 0.026));
  const value = POWER_STEPS[index];
  const at = (x: number) => { const i = Math.round(Math.max(0, Math.min(1, x / Math.max(1, width))) * (POWER_STEPS.length - 1)); if (POWER_STEPS[i] !== preferences.lowBattery) setChatPreferences({ lowBattery: POWER_STEPS[i] }); };
  const pan = useMemo(() => PanResponder.create({ onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true, onStartShouldSetPanResponderCapture: () => true, onPanResponderTerminationRequest: () => false, onPanResponderGrant: e => at(e.nativeEvent.locationX), onPanResponderMove: e => at(e.nativeEvent.locationX) }), [width, preferences.lowBattery]);
  const share = index / (POWER_STEPS.length - 1);
  const label = value <= 0 ? 'Выключен' : value >= 1 ? 'Включён всегда' : en ? `Below ${Math.round(value * 100)}% battery` : `При заряде менее ${Math.round(value * 100)}%`;
  const rows: { key: 'autoplayVideo' | 'autoplayGif' | 'animatedStickers' | 'animatedEmoji'; icon: IconName; color: string; title: string; text: string }[] = [
    { key: 'autoplayVideo', icon: 'videocam', color: '#F0544F', title: 'Автозапуск видео', text: 'Кружки и видео в чатах сами играют без звука, видео-аватары двигаются.' },
    { key: 'autoplayGif', icon: 'images', color: '#F5A623', title: 'Автозапуск GIF', text: 'GIF в чатах, на аватарах и баннерах проигрываются сами.' },
    { key: 'animatedStickers', icon: 'happy', color: '#34C759', title: 'Анимированные стикеры', text: 'Большие эмодзи в сообщениях двигаются.' },
    { key: 'animatedEmoji', icon: 'sparkles', color: '#2BB5B8', title: 'Анимированные эмодзи', text: 'Эмодзи-статусы рядом с именем двигаются.' },
  ];
  return <View style={{ paddingVertical: 6 }}>
    <View style={{ paddingHorizontal: 14, paddingTop: 8, gap: 10 }}>
      <Text style={{ color: t.muted, fontSize: 12 }}>{en ? `Power saving (${features.saving ? 'on' : 'off'})` : `Режим энергосбережения (${features.saving ? 'вкл.' : 'выкл.'})`}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ color: t.muted, fontSize: 13 }}>Выкл.</Text>
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 15, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>Вкл.</Text>
      </View>
      <View accessibilityRole="adjustable" accessibilityLabel="Режим энергосбережения" accessibilityValue={{ text: label }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={e => { const i = Math.max(0, Math.min(POWER_STEPS.length - 1, index + (e.nativeEvent.actionName === 'increment' ? 1 : -1))); setChatPreferences({ lowBattery: POWER_STEPS[i] }); }}
        onLayout={e => setWidth(e.nativeEvent.layout.width)} {...pan.panHandlers} style={{ height: 34, justifyContent: 'center' }}>
        <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: t.border }}><View style={{ width: `${share * 100}%`, height: 4, borderRadius: 2, backgroundColor: t.accent }} /></View>
        <View pointerEvents="none" style={{ position: 'absolute', left: Math.max(0, share * width - 14), width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFF', shadowColor: '#000', shadowOpacity: .2, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 3 }} />
      </View>
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{value <= 0 ? 'Не включается сам по заряду (только в системном режиме энергосбережения).' : value >= 1 ? 'Все ресурсоёмкие процессы выключены.' : en ? `Turn all resource-intensive processes off below ${Math.round(value * 100)}% battery${power.level !== null ? ` (now ${Math.round(power.level * 100)}%)` : ''}.` : `Автоматически отключать все ресурсоёмкие процессы при заряде менее ${Math.round(value * 100)}%${power.level !== null ? ` (сейчас ${Math.round(power.level * 100)}%)` : ''}.`}</Text>
    </View>
    <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 14, paddingTop: 18, paddingBottom: 4 }}>РЕСУРСОЁМКИЕ ПРОЦЕССЫ</Text>
    {rows.map(row => <PowerRow key={row.key} icon={row.icon} color={row.color} title={row.title} text={row.text} value={preferences[row.key]} onChange={v => setChatPreferences({ [row.key]: v })} />)}
    <PowerRow icon="color-wand" color="#3E8BFF" title="Анимации интерфейса" text="Плавные переходы, рамки и эффекты профиля." value={preferences.animations !== 'off'} onChange={v => setChatPreferences({ animations: v ? 'auto' : 'off' })} />
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8 }}>{motion.reason}</Text>
  </View>;
}

function PowerRow({ icon, color, title, text, value, onChange }: { icon: IconName; color: string; title: string; text: string; value: boolean; onChange: (value: boolean) => void }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 }}>
    <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={17} color="#FFF" /></View>
    <View style={{ flex: 1, gap: 2 }}><Text style={{ color: t.text, fontSize: 15 }}>{title}</Text><Text style={{ color: t.muted, fontSize: 12, lineHeight: 16 }}>{text}</Text></View>
    <ThemeSwitch accessibilityLabel={title} value={value} onValueChange={onChange} />
  </View>;
}
