import React, { useCallback, useEffect, useState } from 'react';
import { ProfileEffect } from './platina/Effects';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Switch, View, useWindowDimensions, Linking } from 'react-native';
import { MONO, Text } from './typography';
import { requestStatusPicker } from './statusPickerRequest';
import * as FileSystem from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import type { Api, Privacy } from './api';
import { Avatar, Icon, IconButton, Notice, type IconName } from './components';
import { GlassBackdrop, GlassSurface } from './glass';
import { useTheme, formatSize } from './theme';
import { ThemeSettings } from './ThemeSettings';
import { useMotion } from './motion';
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
import { AudioSettings } from './audio/AudioSettings';
import { OverlaySettings } from './overlay/OverlaySettings';
import { lightFeedback } from './haptics';
import { LANGUAGES, getLanguage, setLanguage, tr, useLanguage } from './i18n';
import { fileLimits, type FileLimits } from './e2ee/attachments';

type Section = 'root' | 'appearance' | 'privacy' | 'data' | 'language' | 'folders' | 'power' | 'audio' | 'overlay';
type Props = {
  api: Api; user: User; theme: ThemeMode; darkTheme: DarkTheme;
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
    const title = current === 'overlay' ? 'Оверлей' : current === 'audio' ? 'Звук и микрофон' : current === 'appearance' ? 'Оформление' : current === 'privacy' ? 'Конфиденциальность' : current === 'data' ? 'Данные и память' : current === 'language' ? 'Язык' : current === 'folders' ? 'Папки с чатами' : current === 'power' ? 'Энергосбережение' : 'Настройки';
    if (current === 'root') return <Root {...props} onBack={onBack} open={open} />;
    return <Page title={title} backLabel="Назад" onBack={onBack}>
      {current === 'appearance' ? <Appearance {...props} open={open} /> : current === 'privacy' ? <PrivacySection api={props.api} /> : current === 'language' ? <LanguageSection /> : current === 'folders' ? <FoldersSection api={props.api} user={props.user} chats={props.chats || []} /> : current === 'power' ? <Group label="Анимации"><MotionSettings /></Group> : current === 'audio' ? <AudioSettings /> : current === 'overlay' ? <OverlaySettings /> : <DataSection api={props.api} />}
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
    <ScrollView style={bleed.style} contentInsetAdjustmentBehavior="never" scrollIndicatorInsets={{ top: headerHeight, bottom: tabInset + bleed.bottom }} contentContainerStyle={{ padding: 14, paddingTop: headerHeight + 4, gap: 16, paddingBottom: 30 + tabInset + bleed.bottom, width: '100%', maxWidth: 680, alignSelf: 'center' }}>{children}</ScrollView>
    <FloatingHeader onHeight={setHeaderHeight}>
    <GlassSurface lens radius={27} style={{ margin: 12, marginBottom: 7 }} contentStyle={{ padding: 8, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 60 }}>
      <IconButton name="chevron-back" label={backLabel} onPress={onBack} />
      <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>{title}</Text>
    </GlassSurface>
    </FloatingHeader>
  </View>;
}

function Group({ children, label }: { children: React.ReactNode; label?: string }) {
  const t = useTheme(); const language = useLanguage();
  return <View style={{ gap: 7 }}>
    {label ? <Text raw style={{ color: t.muted, fontSize: 11, fontWeight: t.black ? '500' : '700', letterSpacing: 1.2, paddingHorizontal: 8 }}>{tr(label, language).toUpperCase()}</Text> : null}
    {/* «Чёрная» (Linear): a flat card one step lighter than the page, hairline rows — no glass, no white outline. */}
    {t.black ? <View style={{ borderRadius: 12, overflow: 'hidden', backgroundColor: t.glassOpaque, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>
      {React.Children.toArray(children).filter(Boolean).map((child, index) => <View key={index} style={index ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border, marginLeft: 57 } : null}><View style={index ? { marginLeft: -57 } : null}>{child}</View></View>)}
    </View> : <GlassSurface radius={20} shadow={false} contentStyle={{ paddingVertical: 2, overflow: 'hidden', borderRadius: 20 }}>{children}</GlassSurface>}
  </View>;
}

function Item({ icon, color, label, value, onPress, danger = false }: { icon: IconName; color: string; label: string; value?: string; onPress: () => void; danger?: boolean }) {
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

function Toggle({ label, description, value, onChange, disabled = false, badge }: { label: string; description: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean; badge?: string }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 }}>
    <View style={{ flex: 1, gap: 3 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Text style={{ color: t.text, fontSize: 15 }}>{label}</Text>{badge ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: t.accentSoft }}><Icon name="lock-closed" size={10} color={t.accent} /><Text style={{ color: t.accent, fontSize: 11, fontWeight: '700' }}>{badge}</Text></View> : null}</View><Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{description}</Text></View>
    <Switch accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onChange} trackColor={{ false: t.subtle, true: t.accent }} thumbColor="#FFF" />
  </View>;
}

function Root({ api, user, onBack, onProfile, onSecurity, onMusic, onLogout, open }: Props & { open: (section: Section) => void }) {
  const tabInset = useTabInset();
  const language = useLanguage();
  const folders = useChatFolders(user.id);
  const t = useTheme(); const preferences = useChatPreferences(); const insets = useSafeAreaInsets(); const { width } = useWindowDimensions();
  const version = Constants.expoConfig?.version || '';
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
        <GlassSurface radius={22} shadow={false} interactive contentStyle={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Pressable accessibilityRole="button" accessibilityLabel="Назад" onPress={onBack} hitSlop={6} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-back" size={22} color={t.text} /></Pressable></GlassSurface>
        <GlassSurface radius={22} shadow={false} interactive contentStyle={{ height: 44, paddingHorizontal: 16, justifyContent: 'center' }}><Pressable accessibilityRole="button" onPress={onProfile} hitSlop={6}><Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Изм.</Text></Pressable></GlassSurface>
      </View>
    </View>
    {/* Same column as the list below (on a wide PC window the head used to hug the left edge). */}
    <View style={{ marginTop: -58, paddingHorizontal: 20, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Мой профиль" onPress={onProfile} style={{ alignSelf: 'flex-start', padding: 5, borderRadius: 40, backgroundColor: t.bg }}>
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
        <Item icon="color-palette" color="#25A69A" label="Оформление" value={textMetrics(preferences.textSize).label} onPress={() => open('appearance')} />
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

function Appearance({ api, user, theme, darkTheme, onTheme, onDarkTheme, open }: Props & { open?: (section: Section) => void }) {
  const t = useTheme(); const active = usePlatina(api, user.id); const preferences = useChatPreferences(); const metrics = textMetrics(preferences.textSize);
  const [wallpaperOpen, setWallpaperOpen] = useState(false);
  return <>
    <Group label="Тема"><View style={{ padding: 14 }}><ThemeSettings mode={theme} darkTheme={darkTheme} onChange={onTheme} onDarkTheme={onDarkTheme} platina={active} onLocked={() => openPlatinaShowcase()} /></View></Group>
    {Platform.OS === 'ios' ? <Group label="Иконка приложения"><AppIconPicker /></Group> : null}
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

function PrivacySection({ api }: { api: Api }) {
  const t = useTheme(); const preferences = useChatPreferences();
  const [privacy, setPrivacy] = useState<Privacy | null>(null); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [platina, setPlatina] = useState(false);
  const load = useCallback(() => { setError(''); api.privacy().then(result => { setPrivacy(result.privacy); setPlatina(result.platina === true); }).catch(e => setError(e instanceof Error ? e.message : 'Не удалось загрузить настройки.')); }, [api]);
  useEffect(load, [load]);
  const change = async (patch: Partial<Privacy>) => {
    if (!privacy || saving) return;
    const previous = privacy; setPrivacy({ ...privacy, ...patch }); setSaving(true); setError('');
    try { const result = await api.updatePrivacy(patch); setPrivacy(result.privacy); setPlatina(result.platina === true); }
    catch (e) { setPrivacy(previous); setError(e instanceof Error ? e.message : 'Не удалось сохранить.'); }
    finally { setSaving(false); }
  };
  return <>
    {error ? <Notice text={error} error onRetry={privacy ? undefined : load} /> : null}
    <Group label="На сервере">
      {!privacy ? <ActivityIndicator color={t.accent} style={{ padding: 20 }} /> : <>
        <Toggle label="Новые разговоры" description="Кто ещё не писал тебе, сможет начать чат. Выключи, чтобы писали только те, с кем переписка уже есть." value={privacy.allowNewChats} disabled={saving} onChange={value => void change({ allowNewChats: value })} />
        <Toggle label="Фото профиля для других" description="Если выключить, собеседники и поиск увидят цветной аватар вместо фото." value={privacy.showAvatar} disabled={saving} onChange={value => void change({ showAvatar: value })} />
        <Toggle label="Время захода и «в сети»" badge={platina ? undefined : 'Platina'} description={platina ? 'Взаимно: если скрыть, ты тоже не увидишь, когда собеседник был в сети.' : 'Скрывать время захода можно с Platina.'} value={privacy.showLastSeen !== false} disabled={saving || !platina} onChange={value => void change({ showLastSeen: value })} />
        <Toggle label="Отчёты о прочтении" badge={platina ? undefined : 'Platina'} description={platina ? 'Взаимно: если выключить, ты тоже не увидишь, прочитали ли твои сообщения.' : 'Скрывать прочтение можно с Platina.'} value={privacy.readReceipts} disabled={saving || !platina} onChange={value => void change({ readReceipts: value })} />
      </>}
    </Group>
    <Group label="Звонки">
      {!privacy ? <ActivityIndicator color={t.accent} style={{ padding: 20 }} /> : <CallPrivacy api={api} mode={privacy.calls || 'everyone'} disabled={saving} onMode={calls => void change({ calls })} />}
    </Group>
    <Group label="На этом устройстве">
      <Toggle label="Показывать «печатает…»" description="Собеседник видит, что ты набираешь сообщение." value={preferences.sendTyping} onChange={value => setChatPreferences({ sendTyping: value })} />
    </Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 6 }}>Содержимое сообщений, ответы, реакции, правки и закрепления шифруются на устройстве. Сервер видит только служебные данные: кто, кому и когда.</Text>
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

/** Files on the server: how much of the account's storage is used (2 GB, 15 GB with Platina). */
function ServerStorage({ api }: { api: Api }) {
  const t = useTheme(); const [limits, setLimits] = useState<FileLimits | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { let alive = true; fileLimits(api).then(value => { if (alive) setLimits(value); }).catch(() => { if (alive) setFailed(true); }); return () => { alive = false; }; }, [api]);
  const fraction = limits ? Math.min(1, limits.usedBytes / Math.max(1, limits.storageBytes)) : 0;
  return <Group label="Файлы на сервере">
    <View style={{ padding: 16, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="cloud-outline" size={22} color={t.accent} /><Text style={{ flex: 1, color: t.text, fontSize: 15 }}>Использовано</Text>{limits ? <Text raw style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{storageLabel(limits.usedBytes)} / {storageLabel(limits.storageBytes)}</Text> : failed ? <Text style={{ color: t.muted, fontSize: 13 }}>Недоступно</Text> : <ActivityIndicator color={t.accent} size="small" />}</View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)', overflow: 'hidden' }}><View style={{ width: `${Math.round(fraction * 100)}%`, height: 6, borderRadius: 3, backgroundColor: fraction > .9 ? t.danger : t.accent }} /></View>
      {limits ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{limits.platina ? 'С Platina: файлы до 5 ГБ, всего 15 ГБ.' : 'Без Platina: файлы до 100 МБ, всего 2 ГБ. С Platina — до 5 ГБ на файл и 15 ГБ всего.'}</Text> : null}
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

function MotionSettings() {
  const t = useTheme(); const preferences = useChatPreferences(); const motion = useMotion();
  const options: { id: AnimationMode; label: string }[] = [{ id: 'auto', label: 'Авто' }, { id: 'on', label: 'Всегда' }, { id: 'off', label: 'Выкл' }];
  return <View style={{ padding: 14, gap: 10 }}>
    <View style={{ flexDirection: 'row', gap: 7 }}>{options.map(option => {
      const selected = preferences.animations === option.id;
      return <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => setChatPreferences({ animations: option.id })} style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 15, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><Text style={{ color: selected ? t.accent : t.text, fontSize: 13, fontWeight: '600' }}>{option.label}</Text></Pressable>;
    })}</View>
    {preferences.animations === 'auto' ? <View style={{ gap: 7 }}><Text style={{ color: t.muted, fontSize: 12 }}>Энергосбережение: выключать при заряде</Text><View style={{ flexDirection: 'row', gap: 7 }}>{[0, 0.15, 0.27, 0.4].map(level => {
      const selected = preferences.lowBattery === level;
      return <Pressable key={level} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => setChatPreferences({ lowBattery: level })} style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 13, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><Text style={{ color: selected ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{level ? `≤ ${Math.round(level * 100)}%` : 'Никогда'}</Text></Pressable>;
    })}</View></View> : null}
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{motion.reason}</Text>
  </View>;
}
