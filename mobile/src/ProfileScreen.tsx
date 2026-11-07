import { StatusPicker } from './StatusPicker';
import { takeProfileEditRequest, takeStatusPickerRequest } from './statusPickerRequest';
import React, { useEffect, useRef, useState } from 'react';
import Animated, { interpolate, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProfileMediaViewer, profileMedia } from './ProfileMediaViewer';
import { PROFILE_PATTERNS, PostViewer, PostsSection, ProfilePattern, StoryRing, useProfilePosts } from './ProfilePosts';
import { PlatinaName } from './platina/PlatinaMark';
import { isBirthdayToday } from './birthday';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from './typography';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import type { Api } from './api';
import { Avatar, Button, Field, Icon, IconButton, Notice, SectionLabel, Sheet, SheetAction } from './components';
import { useTheme } from './theme';
import { GlassSurface } from './glass';
import { ThemeSettings } from './ThemeSettings';
import { StatusEmoji } from './StatusEmoji';
import { DecoratedAvatar, ProfileBanner, birthdayColors } from './platina/Decor';
import { PlatinaStudio, type PlatinaStudioHandle } from './platina/PlatinaStudio';
import { MONTHS, daysInMonth, formatBirthday, parseBirthday, birthdayValue as toBirthday } from './birthday';
import { AvatarCropper } from './photo/AvatarCropper';
import type { CropRect } from './photo/avatarCrop';
import { AnimatedEmoji } from './platina/AnimatedEmoji';
import { FloatingHeader, useBleed, useTabInset } from './tabInset';
import { setPlatinaActive } from './platina/usePlatina';
import { STATIC_STATUS_EMOJI } from './statusEmojiModel';
import type { DarkTheme, ThemeMode, User, UsernameStatus } from './types';

const AVATAR_EDGE = 1024;
type Action = 'avatar' | 'profile' | 'username' | 'emoji' | 'logout' | null;
type Props = {
  api: Api; user: User; theme: ThemeMode; darkTheme: DarkTheme;
  onTheme: (mode: ThemeMode) => void; onDarkTheme: (mode: DarkTheme) => void;
  onUser: (user: User) => void; onBack: () => void; onLogout: () => Promise<void>; onSecurity: () => void;
};
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const normalizedUsername = (value: string) => value.trim().replace(/^@/, '').toLowerCase();

// Last known account status per user: the screen opens instantly and refreshes in the background.
const statusCache = new Map<string, UsernameStatus>();

export function ProfileScreen({ api, user, theme, darkTheme, onTheme, onDarkTheme, onUser, onBack, onLogout, onSecurity }: Props) {
  const t = useTheme(); const [bannerWidth, setBannerWidth] = useState(0);
  const [name, setName] = useState(user.displayName), [bio, setBio] = useState(user.bio), [birthday, setBirthday] = useState<string | null>(user.birthday ?? null), [gender, setGender] = useState<'male' | 'female' | null>(user.gender ?? null), [genderSheet, setGenderSheet] = useState(false);
  const [pattern, setPattern] = useState<string | null>(user.profilePattern ?? null); const [patternSheet, setPatternSheet] = useState(false);
  const [mediaSheet, setMediaSheet] = useState<'avatar' | 'banner' | null>(null), [usernameSheet, setUsernameSheet] = useState(false), [birthdaySheet, setBirthdaySheet] = useState(false), [colorSheet, setColorSheet] = useState(false);
  const studio = useRef<PlatinaStudioHandle>(null);
  const [avatarId, setAvatarId] = useState(user.avatarId), [color, setColor] = useState(user.avatarColor);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  // «Профиль сохранён» and the like go away by themselves (they stayed at the page end under the tab bar).
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  const cached = statusCache.get(user.id) ?? null;
  const [status, setStatus] = useState<UsernameStatus | null>(cached), [statusError, setStatusError] = useState(''), [statusLoading, setStatusLoading] = useState(!cached);
  const [username, setUsername] = useState(user.username), [usernameReview, setUsernameReview] = useState<{ previous: string; next: string } | null>(null);
  const [emojiVisible, setEmojiVisible] = useState(false), [platinaVisible, setPlatinaVisible] = useState(false), [logoutVisible, setLogoutVisible] = useState(false);
  const [action, setAction] = useState<Action>(null), actionRef = useRef<Action>(null);
  const [copied, setCopied] = useState(''), copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false), generation = useRef(0), statusGeneration = useRef(0);
  const current = useRef({ api, id: user.id }); current.current = { api, id: user.id };
  const live = (version: number) => mounted.current && generation.current === version && current.current.api === api && current.current.id === user.id;
  const begin = (next: Exclude<Action, null>) => { if (actionRef.current) return null; actionRef.current = next; setAction(next); setError(''); setNotice(''); return generation.current; };
  const finish = (version: number) => { if (live(version)) { actionRef.current = null; setAction(null); } };

  const loadStatus = async (resetDraft = false) => {
    const version = generation.current, request = ++statusGeneration.current;
    if (!live(version)) return;
    if (!statusCache.has(user.id)) setStatusLoading(true); setStatusError('');
    try {
      const next = await api.usernameStatus();
      if (!live(version) || request !== statusGeneration.current) return;
      if (next.accountId !== user.id) throw new Error('Сервер вернул настройки другого аккаунта.');
      statusCache.set(user.id, next); setStatus(next); setPlatinaActive(user.id, next.platina.active); if (resetDraft) setUsername(next.username);
    } catch (failure) { if (live(version) && request === statusGeneration.current) setStatusError(errorMessage(failure, 'Не удалось получить настройки имени и статуса.')); }
    finally { if (live(version) && request === statusGeneration.current) setStatusLoading(false); }
  };

  useEffect(() => {
    mounted.current = true; generation.current++; actionRef.current = null; setAction(null);
    setName(user.displayName); setBio(user.bio); setAvatarId(user.avatarId); setColor(user.avatarColor);
    setStatus(statusCache.get(user.id) ?? null); setError(''); setNotice(''); setUsernameReview(null); setEmojiVisible(false);
    void loadStatus(true);
    const listener = AppState.addEventListener('change', state => { if (state === 'active' && !actionRef.current) void loadStatus(); });
    return () => { mounted.current = false; generation.current++; statusGeneration.current++; listener.remove(); if (copyTimer.current) clearTimeout(copyTimer.current); };
    // A new API/session owns a new operation scope; ordinary User updates must
    // not overwrite an unfinished local edit in this same session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, user.id]);

  useEffect(() => {
    if (!status?.platina.active || !status.platina.expiresAt) return;
    const left = Date.parse(status.platina.expiresAt) - Date.now();
    if (!Number.isFinite(left) || left <= 0) return;
    const timer = setTimeout(() => { if (!actionRef.current) void loadStatus(); }, Math.min(left + 1, 2_147_483_647));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, status]);

  const copy = async (value: string, label: string) => {
    const version = generation.current;
    try { await Clipboard.setStringAsync(value); if (!live(version)) return; setCopied(label); if (copyTimer.current) clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => { if (live(version)) setCopied(''); }, 1800); }
    catch (failure) { if (live(version)) setError(errorMessage(failure, 'Не удалось скопировать.')); }
  };
  // Like Telegram: pick any photo, then our own round cropper (move / zoom) shows exactly what the
  // avatar will be. The system square cropper had no round preview and little control.
  const [cropSource, setCropSource] = useState<{ uri: string; width: number; height: number } | null>(null);
  const pickAvatar = async () => {
    setError('');
    try {
      if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('Разреши доступ к фотографиям в настройках телефона.'); }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1, exif: false, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
      if (result.canceled) return;
      const asset = result.assets[0]; if (!asset) return;
      if (asset.width && asset.height) { setCropSource({ uri: asset.uri, width: asset.width, height: asset.height }); return; }
      // Size unknown (rare): decode once to learn it.
      const probe = await ImageManipulator.manipulateAsync(asset.uri, [], { format: ImageManipulator.SaveFormat.JPEG, compress: 0.95 });
      setCropSource({ uri: probe.uri, width: probe.width, height: probe.height });
    } catch (failure) { setError(errorMessage(failure, 'Не удалось выбрать фото.')); }
  };
  /**
   * Telegram-style: tap the avatar or the banner → a photo, a GIF or a video up to 10 s. A still photo
   * of the avatar goes through the round cropper; a GIF stays animated; a video (and any banner) is a
   * Platina decoration handled by PlatinaStudio's uploader.
   */
  const pickMedia = async (kind: 'avatar' | 'banner', video: boolean) => {
    setMediaSheet(null); setError(''); setNotice('');
    try {
      if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('Разреши доступ к фото и видео в настройках телефона.'); }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: video ? ['videos'] : ['images'], allowsEditing: video, ...(video ? { aspect: kind === 'banner' ? [3, 2] as [number, number] : [1, 1] as [number, number] } : {}), videoMaxDuration: 10, quality: 1, exif: false,
        videoExportPreset: ImagePicker.VideoExportPreset.H264_960x540, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (asset.type === 'video' && (asset.duration || 0) > 10_500) throw new Error('Видео — не длиннее 10 секунд.');
      const gif = asset.type !== 'video' && (asset.mimeType === 'image/gif' || /\.gif$/i.test(asset.fileName || asset.uri));
      if (kind === 'banner') { if (asset.type === 'video' || gif) await studio.current?.upload('banner', asset); else studio.current?.preview(asset); return; }
      if (asset.type === 'video') { await studio.current?.upload('avatar', asset); return; }
      if (gif) {
        const version = begin('avatar'); if (version === null) return;
        try {
          const attachment = await api.upload({ uri: asset.uri, name: 'avatar.gif', mimeType: 'image/gif', size: asset.fileSize });
          if (attachment.size > 4 * 1024 * 1024) throw new Error('GIF больше 4 МБ. Выбери покороче.');
          const saved = await api.profile({ avatarId: attachment.id }); if (!live(version)) return;
          setAvatarId(attachment.id); onUser(saved.user); setNotice('Фото профиля обновлено.');
        } catch (failure) { if (live(version)) setError(errorMessage(failure, 'Не удалось сохранить GIF.')); }
        finally { finish(version); }
        return;
      }
      if (asset.width && asset.height) { setCropSource({ uri: asset.uri, width: asset.width, height: asset.height }); return; }
      const probe = await ImageManipulator.manipulateAsync(asset.uri, [], { format: ImageManipulator.SaveFormat.JPEG, compress: 0.95 });
      setCropSource({ uri: probe.uri, width: probe.width, height: probe.height });
    } catch (failure) { setError(errorMessage(failure, 'Не удалось выбрать файл.')); }
  };
  const removeMedia = async (kind: 'avatar' | 'banner') => {
    setMediaSheet(null);
    const version = begin('avatar'); if (version === null) return;
    try {
      const saved = await api.profile(kind === 'avatar' ? { avatarId: null, avatarVideoId: null } : { bannerId: null, bannerPreset: null });
      if (!live(version)) return; if (kind === 'avatar') setAvatarId(null); onUser(saved.user);
    } catch (failure) { if (live(version)) setError(errorMessage(failure, 'Не удалось убрать.')); }
    finally { finish(version); }
  };
  const applyAvatar = async (crop: CropRect) => {
    const source = cropSource; setCropSource(null); if (!source) return;
    const version = begin('avatar'); if (version === null) return;
    try {
      // Crop to the circle's square, then an avatar-sized JPEG (also decodes HEIC); the usual sanitizing pipeline follows.
      const edge = Math.min(AVATAR_EDGE, crop.width);
      const small = await ImageManipulator.manipulateAsync(source.uri, [{ crop }, { resize: { width: edge, height: edge } }], { format: ImageManipulator.SaveFormat.JPEG, compress: 0.86 });
      let attachment;
      try { attachment = await api.upload({ uri: small.uri, name: 'avatar.jpg', mimeType: 'image/jpeg' }); }
      finally { await FileSystem.deleteAsync(small.uri, { idempotent: true }).catch(() => {}); }
      if (!live(version)) return;
      if (!attachment.mimeType.startsWith('image/')) throw new Error('Для профиля нужна фотография.');
      if (attachment.size > 4 * 1024 * 1024) throw new Error('После обработки фото больше 4 МБ. Выбери изображение меньшего размера.');
      // Like Telegram: the new photo is applied right away, no separate «Сохранить».
      const saved = await api.profile({ displayName: (name.trim() || user.displayName), bio: bio.trim(), avatarColor: color, avatarId: attachment.id });
      if (!live(version)) return;
      setAvatarId(attachment.id); onUser(saved.user); setNotice('Фото профиля обновлено.');
    } catch (failure) { if (live(version)) setError(errorMessage(failure, 'Не удалось сохранить фото.')); }
    finally { finish(version); }
  };
  // Telegram: the profile is shown read-only; «Изм.» opens the editor (✕ discards the draft, ✓ saves).
  const [editing, setEditing] = useState(takeProfileEditRequest);
  const wantsPicker = useRef(takeStatusPickerRequest());
  const [pickerOpen, setPickerOpen] = useState(false), [pickerY, setPickerY] = useState(260);
  useEffect(() => { if (wantsPicker.current && status) { wantsPicker.current = false; setPickerY(headerHeight + 230); setPickerOpen(true); } }, [status]);
  const save = async (): Promise<boolean> => {
    if (!name.trim()) { setError('Имя не может быть пустым.'); return false; }
    const version = begin('profile'); if (version === null) return false;
    try { const result = await api.profile({ displayName: name.trim(), bio: bio.trim(), birthday, gender, avatarColor: color, avatarId, profilePattern: pattern }); if (!live(version)) return false; onUser(result.user); setNotice('Профиль сохранён.'); return true; }
    catch (failure) { if (live(version)) setError(errorMessage(failure, 'Не удалось сохранить профиль.')); return false; }
    finally { finish(version); }
  };
  const changed = name.trim() !== user.displayName || bio.trim() !== user.bio || birthday !== (user.birthday ?? null) || gender !== (user.gender ?? null) || avatarId !== user.avatarId || color !== user.avatarColor || pattern !== (user.profilePattern ?? null);
  const cancelEdit = () => {
    if (busy) return;
    setName(user.displayName); setBio(user.bio); setBirthday(user.birthday ?? null); setGender(user.gender ?? null); setAvatarId(user.avatarId); setColor(user.avatarColor); setPattern(user.profilePattern ?? null); if (status) setUsername(status.username);
    setError(''); setNotice(''); setEditing(false);
  };
  const finishEdit = async () => {
    if (busy) return;
    // Every field counts (birthday, gender and the pattern were missed before: changing only them did not save).
    const unchanged = !changed;
    if (unchanged || await save()) setEditing(false);
  };
  const reviewUsername = () => {
    const next = normalizedUsername(username); setError(''); setNotice('');
    if (!/^[a-z0-9_]{3,24}$/.test(next)) { setError('Имя пользователя: от 3 до 24 символов a–z, 0–9 и подчёркивание.'); return; }
    if (!status || !status.canChangeUsername || statusLoading || statusError || next === status.username) return;
    // The input sheet closes first: the confirmation opened underneath it and could not be pressed.
    setUsernameSheet(false); setTimeout(() => setUsernameReview({ previous: status.username, next }), 350);
  };
  const applyUsername = async () => {
    const review = usernameReview;
    if (!review || !status || !status.canChangeUsername || statusLoading || statusError) return;
    if (review.previous !== status.username) { setUsernameReview(null); setError('Имя уже изменилось. Проверь новый вариант ещё раз.'); return; }
    const version = begin('username'); if (version === null) return;
    statusGeneration.current++;
    try { const result = await api.changeUsername(review.next); if (!live(version)) return; if (result.user.id !== user.id || result.status.accountId !== user.id) throw new Error('Сервер вернул настройки другого аккаунта.'); setStatus(result.status); setUsername(result.status.username); onUser(result.user); setUsernameReview(null); setNotice('Публичное имя изменено. Логин для входа остался прежним.'); }
    catch (failure) { if (live(version)) { setError(errorMessage(failure, 'Не удалось изменить имя пользователя.')); setUsernameReview(null); void loadStatus(); } }
    finally { finish(version); }
  };
  const applyEmoji = async (selected: string | null) => {
    if (!status || statusLoading || statusError || (selected !== null && !status.canSetStatusEmoji)) return;
    const version = begin('emoji'); if (version === null) return;
    statusGeneration.current++;
    try { const result = await api.changeStatusEmoji(selected); if (!live(version)) return; if (result.user.id !== user.id || result.status.accountId !== user.id) throw new Error('Сервер вернул настройки другого аккаунта.'); setStatus(result.status); onUser(result.user); setEmojiVisible(false); setNotice(selected ? 'Статус обновлён.' : 'Статус убран.'); }
    catch (failure) { if (live(version)) { setError(errorMessage(failure, 'Не удалось изменить статус.')); setEmojiVisible(false); void loadStatus(); } }
    finally { finish(version); }
  };
  const logout = async () => { const version = begin('logout'); if (version === null) return; try { await onLogout(); } catch (failure) { if (live(version)) { setLogoutVisible(false); setError(errorMessage(failure, 'Не удалось выйти.')); } } finally { finish(version); } };

  const busy = action !== null;
  const publicName = status?.username || user.username;
  const permanent = status?.platina.active === true && status.platina.permanent === true && status.platina.expiresAt === null;
  const previewUser: User = { ...user, displayName: name || user.displayName, avatarId, avatarColor: color, ...(status ? { statusEmoji: status.statusEmoji, statusEmojiExpiresAt: status.statusEmoji ? status.platina.expiresAt : null, statusEmojiPermanent: Boolean(status.statusEmoji && permanent) } : {}) };
  const ready = status !== null && !statusLoading && !statusError;
  const [headerHeight, setHeaderHeight] = useState(92); const tabInset = useTabInset(); const bleed = useBleed();
  // Telegram «Мой профиль»: scrolling up, the photo shrinks towards the top and fades; the name settles
  // small in the middle of the top row.
  const topInset = useSafeAreaInsets().top; const [heroBottom, setHeroBottom] = useState(220); const [viewer, setViewer] = useState<number | null>(null);
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({ onScroll: e => { scrollY.value = e.contentOffset.y; }, onEndDrag: e => { if (e.contentOffset.y < -110) runOnJS(pullOpen)(); } });
  const avatarShrink = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(scrollY.value, [-160, 0, 150], [-40, 0, -70], 'clamp') }, { scale: interpolate(scrollY.value, [-160, 0, 150], [1.5, 1, 0.3], 'clamp') }], opacity: interpolate(scrollY.value, [50, 140], [1, 0], 'clamp') }));
  const titleFade = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [heroBottom - 60, heroBottom - 30], [0, 1], 'clamp'), transform: [{ translateY: interpolate(scrollY.value, [heroBottom - 60, heroBottom - 30], [8, 0], 'clamp') }] }));
  // The backdrop comes up together with the small title (it lagged and the title sat on the big name).
  const barFade = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [heroBottom - 80, heroBottom - 40], [0, 0.96], 'clamp') }));
  function pullOpen() { if (!editing && profileMedia(previewUser).length) setViewer(0); }
  // Telegram: the top of the profile is the plain background (or the banner); only on the birthday it
  // turns festive (blue / pink / bright).
  const hasBanner = Boolean(user.bannerId || user.bannerPreset);
  const birthdayToday = isBirthdayToday(user.birthday ?? null); const festive = birthdayColors(user.gender ?? null);
  const tinted = !hasBanner && birthdayToday;
  // Telegram «Публикации» / «Истории»; the avatar gets the story ring and opens the stories.
  const posts = useProfilePosts(api, user.id); const stories = posts.data?.stories ?? [];
  const [storyOpen, setStoryOpen] = useState(false); const { width: screenWidth } = useWindowDimensions();
  const emojiChoices = status?.statusEmojiChoices.filter(emoji => (STATIC_STATUS_EMOJI as readonly string[]).includes(emoji)) || [];
  const expiry = status?.platina.expiresAt && Number.isFinite(Date.parse(status.platina.expiresAt)) ? new Date(status.platina.expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: 'transparent' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    {editing ? <FloatingHeader onHeight={setHeaderHeight}>
    <GlassSurface material="regular" radius={27} style={{ marginHorizontal: 14, marginTop: 12, marginBottom: 2 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 9, minHeight: 68 }}><IconButton name="close" label="Отменить изменения" onPress={cancelEdit}/><Text style={{ fontSize: 20, fontWeight: '700', letterSpacing: -.5, color: t.text, flex: 1, textAlign: 'center' }}>Изменить</Text><Pressable accessibilityRole="button" accessibilityLabel="Сохранить" disabled={busy} onPress={() => void finishEdit()} style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: busy ? .5 : pressed ? .8 : 1 })}>{action === 'profile' ? <ActivityIndicator color={t.onAccent}/> : <Icon name="checkmark" size={24} color={t.onAccent}/>}</Pressable></GlassSurface>
    </FloatingHeader> : <View pointerEvents="box-none" style={{ position: 'absolute', top: Platform.OS === 'web' ? 0 : -topInset, left: 0, right: 0, zIndex: 10, paddingTop: (Platform.OS === 'web' ? 0 : topInset) + 8 }}>
      {/* Telegram «Мой профиль»: no bar — a round back button, «Изм.» on the right; scrolled up, the name
          and «в сети» settle small in the middle on a fading backdrop. */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: -12, backgroundColor: t.bg }, barFade]} />
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 10, minHeight: 52 }}>
        <IconButton name="chevron-back" label="Назад" onPress={onBack}/>
        <Animated.View pointerEvents="none" style={[{ flex: 1, alignItems: 'center' }, titleFade]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' }}><Text raw numberOfLines={1} style={{ color: t.text, fontSize: 16, fontWeight: '700', flexShrink: 1 }}>{user.displayName}</Text><StatusEmoji user={previewUser} size={15}/></View>
          <Text style={{ color: t.muted, fontSize: 12 }}>в сети</Text>
        </Animated.View>
        <Pressable accessibilityRole="button" accessibilityLabel="Изменить профиль" onPress={() => { setEditing(true); setNotice(''); setError(''); }} style={({ pressed }) => ({ height: 44, paddingHorizontal: 17, borderRadius: 22, backgroundColor: tinted ? 'rgba(0,0,0,0.28)' : t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: tinted ? 'rgba(255,255,255,0.18)' : t.glassBorder, justifyContent: 'center', opacity: pressed ? .7 : 1 })}><Text style={{ color: tinted ? '#FFF' : t.text, fontSize: 16, fontWeight: '600' }}>Изм.</Text></Pressable>
      </View>
    </View>}
    <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} keyboardShouldPersistTaps="handled" style={bleed.style} contentInsetAdjustmentBehavior="never" scrollIndicatorInsets={{ top: editing ? headerHeight : 0, bottom: tabInset + bleed.bottom }} contentContainerStyle={{ padding: 17, paddingTop: editing ? headerHeight + 8 : 60 + 8, paddingBottom: 36 + tabInset + bleed.bottom, maxWidth: 600, width: '100%', alignSelf: 'center', gap: 17 }}>
      {!editing ? <>
      {/* The top sits on the profile's colour (or banner), as others see it; it stretches when pulled down. */}
      <View pointerEvents="none" style={{ position: 'absolute', top: -700, left: 0, right: 0, height: 700 + 68 + heroBottom + 14, overflow: 'hidden' }}>
        {tinted ? <LinearGradient colors={birthdayToday ? [festive[0], festive[1]] : [shade(user.avatarColor, 0.15), shade(user.avatarColor, -0.12)]} style={StyleSheet.absoluteFill}/> : null}
        {hasBanner ? <View onLayout={event => setBannerWidth(Math.round(event.nativeEvent.layout.width))} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 68 + heroBottom + 14 }}>{bannerWidth ? <ProfileBanner user={user} api={api} height={68 + heroBottom + 14} width={bannerWidth}/> : null}</View> : null}
        <ProfilePattern emoji={user.profilePattern} width={Math.min(600, screenWidth)} height={700 + 68 + heroBottom + 14} cx={Math.min(600, screenWidth) / 2} cy={700 + 68 + (stories.length ? 64 : 58)}/>
      </View>
      <View onLayout={event => setHeroBottom(Math.round(event.nativeEvent.layout.height))} style={{ alignItems: 'center', gap: 6, paddingBottom: 6 }}>
        <Animated.View style={avatarShrink}><Pressable disabled={!stories.length && !profileMedia(previewUser).length} onPress={() => stories.length ? setStoryOpen(true) : setViewer(0)} accessibilityRole="button" accessibilityLabel={stories.length ? 'Истории' : 'Фото и видео профиля'}><StoryRing active={stories.length > 0} size={116}><DecoratedAvatar user={previewUser} api={api} size={116} animated round/></StoryRing></Pressable></Animated.View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, alignSelf: 'stretch', marginTop: 10, paddingHorizontal: 16 }}><PlatinaName user={previewUser} onDark={tinted} numberOfLines={2} style={{ flexShrink: 1, color: tinted ? '#FFFFFF' : t.text, fontSize: 26, fontWeight: '800', letterSpacing: -.6, textAlign: 'center' }}/><Pressable accessibilityRole="button" accessibilityLabel="Сменить статус рядом с именем" hitSlop={10} disabled={!ready || !status?.platina.active && !status?.statusEmoji} onPress={event => { setPickerY(event.nativeEvent.pageY); setPickerOpen(true); }}><StatusEmoji user={previewUser} size={22} animated/></Pressable></View>
        <Text style={{ color: tinted ? 'rgba(255,255,255,0.78)' : t.muted, fontSize: 15 }}>в сети</Text>
        {birthdayToday ? <View style={{ marginTop: 4, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: tinted ? 'rgba(255,255,255,0.22)' : t.accentSoft }}><Text style={{ color: tinted ? '#FFF' : t.text, fontSize: 13, fontWeight: '700' }}>🎉 Сегодня день рождения</Text></View> : null}
      </View>
      <View style={{ marginTop: 14, borderRadius: 22, backgroundColor: t.dark ? '#1C1C1E' : '#FFFFFF', overflow: 'hidden' }}>
        <InfoRow label="имя пользователя" value={copied === 'username' ? 'Скопировано' : `@${publicName}`} accent onPress={() => void copy(`@${publicName}`, 'username')} hint="Нажми, чтобы скопировать"/>
        {user.birthday ? <InfoRow label="день рождения" value={formatBirthday(user.birthday)} divider/> : null}
        {user.bio ? <InfoRow label="о себе" value={user.bio} divider/> : null}
      </View>
      <PostsSection api={api} own data={posts.data} onChanged={() => void posts.reload()} width={Math.min(600, screenWidth) - 34}/>
      {error ? <Notice text={error} error/> : null}{notice ? <Notice text={notice}/> : null}
      </> : <>
      {/* Edit, as Telegram's «Изм.»: ✓ saves, ✕ discards. The banner and the avatar are tapped to change
          (photo, GIF or a video up to 10 s); below — about, name and @username, birthday, colour, decorations. */}
      <View style={{ alignItems: 'center' }}>
        <Pressable disabled={busy} onPress={() => setMediaSheet('banner')} accessibilityRole="button" accessibilityLabel="Изменить баннер" onLayout={event => setBannerWidth(Math.round(event.nativeEvent.layout.width))}
          style={{ alignSelf: 'stretch', height: 150, borderRadius: 24, overflow: 'hidden', backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
          {(user.bannerId || user.bannerPreset) && bannerWidth ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}><ProfileBanner user={user} api={api} height={150} width={bannerWidth}/></View> : <View style={{ alignItems: 'center', gap: 4 }}><Icon name="image-outline" size={24} color={t.muted}/><Text style={{ color: t.muted, fontSize: 13 }}>Баннер</Text></View>}
          <View style={{ position: 'absolute', right: 12, top: 12, width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}><Icon name="camera-outline" size={18} color="#FFF"/></View>
        </Pressable>
        <Pressable disabled={busy} onPress={() => setMediaSheet('avatar')} accessibilityRole="button" accessibilityLabel="Изменить фото профиля" style={{ marginTop: -52, padding: 5, borderRadius: 60, backgroundColor: t.bg }}>
          <DecoratedAvatar user={previewUser} api={api} size={96} animated/>
          <View style={{ position: 'absolute', bottom: 2, right: 2, width: 32, height: 32, backgroundColor: t.accent, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.bg }}><Icon name="camera-outline" size={16} color={t.onAccent}/></View>
        </Pressable>
        <Pressable disabled={busy} onPress={() => setMediaSheet('avatar')} accessibilityRole="button" style={{ padding: 6 }}><Text style={{ color: t.accent, fontSize: 15, fontWeight: '600' }}>{action === 'avatar' ? 'Загружаем…' : 'Изменить фотографию'}</Text></Pressable>
        <Text style={{ color: t.muted, fontSize: 12 }}>Фото, GIF или видео до 10 секунд</Text>
      </View>
      {error ? <Notice text={error} error/> : null}{notice ? <Notice text={notice}/> : null}
      <View style={{ gap: 6 }}>
        <Field value={bio} onChangeText={value => { setBio(value); setNotice(''); }} editable={!busy} maxLength={160} multiline placeholder="О себе" style={{ minHeight: 48, textAlignVertical: 'top' }}/>
        <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 14 }}>Несколько слов о себе — например, чем занимаешься. Видно в профиле.</Text>
      </View>
      <View style={{ gap: 6 }}>
        <Field value={name} onChangeText={value => { setName(value); setNotice(''); }} editable={!busy} maxLength={50} placeholder="Имя"/>
        <GlassSurface material="regular" radius={22} contentStyle={{ paddingVertical: 2 }}>
          <EditRow icon="at" color="#5E7CE8" label="Имя пользователя" value={status ? `@${status.username}` : ''} onPress={() => setUsernameSheet(true)} disabled={!status}/>
        </GlassSurface>
      </View>
      <GlassSurface material="regular" radius={22} contentStyle={{ paddingVertical: 2 }}>
        <EditRow icon="gift" color="#3D8EF2" label="День рождения" value={formatBirthday(birthday) || 'Не указан'} onPress={() => setBirthdaySheet(true)}/>
        <EditRow icon="person" color="#8E6CE0" label="Пол" value={gender === 'male' ? 'Мужской' : gender === 'female' ? 'Женский' : 'Не указан'} onPress={() => setGenderSheet(true)}/>
        <EditRow icon="color-palette" color="#22A6A0" label="Персональный цвет" swatch={color} onPress={() => setColorSheet(true)}/>
        <EditRow icon="sparkles" color="#E0791E" label="Узор фона" value={pattern ?? "Нет"} onPress={() => setPatternSheet(true)}/>
      </GlassSurface>
      <View style={{ gap: 8 }}>
        <SectionLabel>Рамки и анимации</SectionLabel>
        <GlassSurface material="regular" radius={22} contentStyle={{ padding: 16, gap: 14 }}>
          <PlatinaStudio ref={studio} compact api={api} user={user} active={ready && status.platina.active} onUser={onUser}/>
        </GlassSurface>
      </View>
      </>}
    </Animated.ScrollView>
    <Sheet visible={usernameReview !== null} title="Изменить публичное имя?" onClose={() => { if (!busy) setUsernameReview(null); }}><View style={{ gap: 18 }}><Text style={{ color: t.text, fontSize: 19, fontWeight: '600' }}>@{usernameReview?.previous} → @{usernameReview?.next}</Text><Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>Логин для входа «{status?.loginName}», ID аккаунта и ключи переписки останутся прежними. Старое публичное имя перестанет вести на твой профиль.</Text><Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{status?.freeChangeAvailable ? 'Эта смена использует единственную бесплатную смену публичного имени.' : 'Эта смена доступна, пока Platina активна.'}</Text><Button label="Подтвердить смену имени" loading={action === 'username'} disabled={busy || !ready || !status?.canChangeUsername} onPress={() => void applyUsername()}/></View></Sheet>
    <Sheet visible={emojiVisible} title="Статус рядом с именем" onClose={() => { if (!busy) setEmojiVisible(false); }}><View style={{ gap: 18 }}><Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Выбранный эмодзи виден возле твоего имени в чатах. С Platina по умолчанию там значок Platina 💎, его можно заменить любым эмодзи; эмодзи анимированы.</Text>{!status?.canSetStatusEmoji ? <Notice text="Для выбора и замены статуса нужна активная Platina. Убрать статус можно в любой момент."/> : null}<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{emojiChoices.map(emoji => <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`Выбрать статус ${emoji}`} accessibilityState={{ disabled: busy || !status?.canSetStatusEmoji, selected: status?.statusEmoji === emoji }} disabled={busy || !ready || !status?.canSetStatusEmoji} onPress={() => void applyEmoji(emoji)} style={{ width: 56, height: 56, borderRadius: 19, borderWidth: 1, borderColor: status?.statusEmoji === emoji ? t.accent : t.border, backgroundColor: status?.statusEmoji === emoji ? t.accentSoft : t.glassClear, opacity: status?.canSetStatusEmoji ? 1 : .45, alignItems: 'center', justifyContent: 'center' }}><AnimatedEmoji emoji={emoji} size={34} /></Pressable>)}</View><Button label={status?.platina.active ? 'Вернуть значок Platina' : 'Убрать статус'} secondary disabled={busy || !ready || !status?.statusEmoji} loading={action === 'emoji'} onPress={() => void applyEmoji(null)}/></View></Sheet>
    <Sheet visible={platinaVisible} title="Что даёт Platina" onClose={() => setPlatinaVisible(false)}><View style={{ gap: 16 }}><Text style={{ color: t.text, fontSize: 14, lineHeight: 22 }}>Анимированный аватар (видео до 10 с), анимированные рамки, живой баннер профиля, анимированные эмодзи-статусы и большие эмодзи в чатах, семь цветовых тем, скрытие времени захода и отчётов о прочтении, дополнительные смены публичного имени. Доступ подтверждает сервер.</Text><Text style={{ color: t.muted, fontSize: 13, lineHeight: 21 }}>Покупка подписки в приложении пока не подключена: Platina выдаёт администратор сервера.</Text><Text style={{ color: t.muted, fontSize: 13, lineHeight: 21 }}>Анимации эмодзи — Noto Emoji Animation (Google), лицензия CC BY 4.0.</Text></View></Sheet>
    <Sheet visible={logoutVisible} title="Выйти из Инвиза?" onClose={() => { if (!busy) setLogoutVisible(false); }}><Text style={{ color: t.muted, fontSize: 15, lineHeight: 22, marginBottom: 22 }}>Сеанс на этом устройстве завершится. Для следующего входа понадобятся логин, пароль и слово подтверждения. Публичное имя может отличаться от логина.</Text><Button label="Выйти" danger onPress={() => void logout()} loading={action === 'logout'}/></Sheet>
  <Sheet visible={mediaSheet !== null} title={mediaSheet === 'banner' ? 'Баннер профиля' : 'Фото профиля'} onClose={() => setMediaSheet(null)}><View style={{ gap: 10 }}>
    <Button label={mediaSheet === 'banner' ? 'Фото или GIF' : 'Выбрать фото или GIF'} icon="image-outline" disabled={busy || (mediaSheet === 'banner' && !status?.platina.active)} onPress={() => void pickMedia(mediaSheet || 'avatar', false)}/>
    <Button label="Видео до 10 секунд" secondary icon="videocam-outline" disabled={busy || !status?.platina.active} onPress={() => void pickMedia(mediaSheet || 'avatar', true)}/>
    {(mediaSheet === 'avatar' ? avatarId || user.avatarVideoId : user.bannerId || user.bannerPreset) ? <Button label="Убрать" danger secondary icon="trash-outline" disabled={busy} onPress={() => void removeMedia(mediaSheet || 'avatar')}/> : null}
    {!status?.platina.active ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{mediaSheet === 'banner' ? 'Баннер и видео доступны с Platina.' : 'Видео-аватар доступен с Platina.'}</Text> : null}
  </View></Sheet>
  <Sheet visible={usernameSheet} title="Имя пользователя" onClose={() => { if (!busy) setUsernameSheet(false); }}>{status ? <View style={{ gap: 14 }}>
    <Field label="Публичное имя пользователя" value={username} onChangeText={value => { setUsername(value); setNotice(''); }} autoCapitalize="none" autoCorrect={false} maxLength={25} editable={!busy && ready && status.canChangeUsername} placeholder="@username"/>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{status.freeChangeAvailable ? (status.platina.active ? 'Доступна бесплатная смена имени, а с твоей Platina — и дополнительные.' : 'Доступна одна бесплатная смена имени. После неё дополнительные смены доступны с Platina.') : status.canChangeUsername ? 'Бесплатная смена уже использована. Сейчас дополнительные смены доступны с Platina.' : 'Бесплатная смена уже использована. Для новой смены нужна активная Platina.'}</Text>
    <Button label="Изменить публичное имя" secondary icon="at-outline" disabled={busy || !ready || !status.canChangeUsername || normalizedUsername(username) === status.username} onPress={reviewUsername}/>
  </View> : null}</Sheet>
  <Sheet visible={genderSheet} title="Пол" onClose={() => setGenderSheet(false)}><View style={{ gap: 4 }}>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginBottom: 8 }}>Нужен только для оформления в день рождения: синее или розовое. Можно не указывать.</Text>
    {([['male', 'Мужской'], ['female', 'Женский'], [null, 'Не указан']] as const).map(([value, label]) => <SheetAction key={label} icon={gender === value ? 'checkmark-circle' : 'ellipse-outline'} label={label} selected={gender === value} onPress={() => { setGender(value); setGenderSheet(false); }}/>)}
  </View></Sheet>
  <BirthdaySheet visible={birthdaySheet} value={birthday} onClose={() => setBirthdaySheet(false)} onDone={value => { setBirthday(value); setBirthdaySheet(false); setNotice(''); }}/>
  <Sheet visible={patternSheet} title="Узор фона" onClose={() => setPatternSheet(false)}><View style={{ gap: 14 }}>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>Значок, которым усыпан фон вокруг твоего фото в профиле, как в Telegram.</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
      <Pressable accessibilityRole="radio" accessibilityLabel="Без узора" accessibilityState={{ checked: pattern === null }} onPress={() => setPattern(null)} style={{ width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, borderWidth: 2, borderColor: pattern === null ? t.accent : 'transparent' }}><Icon name="close" size={20} color={t.muted}/></Pressable>
      {PROFILE_PATTERNS.map(value => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={value} accessibilityState={{ checked: pattern === value }} onPress={() => setPattern(value)} style={{ width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, borderWidth: 2, borderColor: pattern === value ? t.accent : 'transparent' }}><Text style={{ fontSize: 24 }}>{value}</Text></Pressable>)}
    </View>
    <Button label="Готово" onPress={() => setPatternSheet(false)}/>
  </View></Sheet>
  <Sheet visible={colorSheet} title="Персональный цвет" onClose={() => setColorSheet(false)}><View style={{ gap: 14 }}>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>Этим цветом тебя видят в чатах у других, пока нет фото.</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{['#596FE8','#4088C7','#9271C3','#B78358','#AD6C8C','#667FA4','#3FA37C','#D0644E'].map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: color.toUpperCase() === value.toUpperCase() }} onPress={() => setColor(value)} style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: value, alignItems: 'center', justifyContent: 'center', borderWidth: color.toUpperCase() === value.toUpperCase() ? 3 : 0, borderColor: t.text }}>{color.toUpperCase() === value.toUpperCase() ? <Icon name="checkmark" size={20} color="#FFF"/> : null}</Pressable>)}</View>
    <Button label="Готово" onPress={() => setColorSheet(false)}/>
  </View></Sheet>
  <StatusPicker visible={pickerOpen} anchorY={pickerY} choices={emojiChoices} current={status?.statusEmoji ?? null} platina={!!status?.platina.active} canSet={!!status?.canSetStatusEmoji} busy={busy}
    onPick={emoji => { setPickerOpen(false); void applyEmoji(emoji); }} onClose={() => setPickerOpen(false)} />
  {cropSource ? <AvatarCropper uri={cropSource.uri} width={cropSource.width} height={cropSource.height} onCancel={() => setCropSource(null)} onDone={crop => void applyAvatar(crop)} /> : null}
    {storyOpen && stories.length ? <PostViewer api={api} items={stories} start={0} story onClose={() => setStoryOpen(false)}/> : null}
    {viewer !== null ? <ProfileMediaViewer api={api} user={previewUser} start={viewer} onClose={() => setViewer(null)}/> : null}
  </KeyboardAvoidingView>;
}

function ReadOnlyValue({ label, value, onCopy, copied, small = false }: { label: string; value: string; onCopy: () => void; copied: boolean; small?: boolean }) {
  const t = useTheme();
  return <View style={{ gap: 7 }}><Text style={{ color: t.muted, fontSize: 11, fontWeight: '600' }}>{label}</Text><Pressable onPress={onCopy} accessibilityRole="button" accessibilityLabel={`Скопировать ${label.toLowerCase()}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 9, padding: 13, borderRadius: 15, backgroundColor: t.glassClear, borderWidth: 1, borderColor: t.border }}><Text selectable style={{ flex: 1, color: t.text, fontSize: small ? 12 : 15 }}>{copied ? 'Скопировано' : value}</Text><Icon name={copied ? 'checkmark' : 'copy-outline'} size={16} color={t.muted}/></Pressable></View>;
}

/** Change the private sign-in login (password + confirmation word required; other devices are signed out). */

function EditRow({ icon, color, label, value, swatch, onPress, disabled = false }: { icon: React.ComponentProps<typeof Icon>['name']; color: string; label: string; value?: string; swatch?: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={value ? `${label}: ${value}` : label} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 13, minHeight: 48, paddingHorizontal: 14, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent', opacity: disabled ? .5 : 1 })}>
    <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={17} color="#FFF"/></View>
    <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 15 }}>{label}</Text>
    {value ? <Text raw numberOfLines={1} style={{ color: t.muted, fontSize: 14, maxWidth: '40%' }}>{value}</Text> : null}
    {swatch ? <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: swatch }}/> : null}
    <Icon name="chevron-forward" size={17} color={t.subtle}/>
  </Pressable>;
}

/** Birthday like Telegram: day and month, the year optional («2 мар» or «2 мар 1999»). */
function BirthdaySheet({ visible, value, onClose, onDone }: { visible: boolean; value: string | null; onClose: () => void; onDone: (value: string | null) => void }) {
  const t = useTheme(); const thisYear = new Date().getFullYear();
  const initial = parseBirthday(value);
  const [month, setMonth] = useState(initial?.month ?? 1), [day, setDay] = useState(initial?.day ?? 1), [year, setYear] = useState(initial?.year ? String(initial.year) : '');
  useEffect(() => { if (visible) { const b = parseBirthday(value); setMonth(b?.month ?? 1); setDay(b?.day ?? 1); setYear(b?.year ? String(b.year) : ''); } }, [visible]);
  const y = /^\d{4}$/.test(year) ? Number(year) : null;
  const yearError = year && (!y || y < 1900 || y > thisYear) ? `Год — от 1900 до ${thisYear}` : '';
  const max = daysInMonth(month, y); const shownDay = Math.min(day, max);
  return <Sheet visible={visible} title="День рождения" onClose={onClose}><View style={{ gap: 14 }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>{MONTHS.map((label, index) => { const on = month === index + 1; return <Pressable key={label} onPress={() => setMonth(index + 1)} style={{ paddingHorizontal: 12, height: 34, borderRadius: 17, justifyContent: 'center', backgroundColor: on ? t.accent : t.surface2 }}><Text style={{ color: on ? t.onAccent : t.text, fontSize: 14, fontWeight: on ? '700' : '500' }}>{label}</Text></Pressable>; })}</ScrollView>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{Array.from({ length: max }, (_, i) => i + 1).map(d => { const on = shownDay === d; return <Pressable key={d} onPress={() => setDay(d)} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : 'transparent' }}><Text style={{ color: on ? t.onAccent : t.text, fontSize: 15, fontWeight: on ? '700' : '500' }}>{d}</Text></Pressable>; })}</View>
    <Field label="Год (необязательно)" value={year} onChangeText={text => setYear(text.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" placeholder="Например, 1999" error={yearError || undefined}/>
    <Text style={{ color: t.muted, fontSize: 13 }}>Видят только друзья: {formatBirthday(toBirthday({ day: shownDay, month, year: y }))}</Text>
    <Button label="Готово" disabled={!!yearError} onPress={() => onDone(toBirthday({ day: shownDay, month, year: y }))}/>
    {value ? <Button label="Убрать день рождения" secondary danger onPress={() => onDone(null)}/> : null}
  </View></Sheet>;
}

/** A Telegram profile info row: a small grey label above the value. */
function InfoRow({ label, value, accent = false, divider = false, onPress, hint }: { label: string; value: string; accent?: boolean; divider?: boolean; onPress?: () => void; hint?: string }) {
  const t = useTheme();
  return <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : 'text'} accessibilityLabel={`${label}: ${value}`} accessibilityHint={hint} style={({ pressed }) => ({ paddingHorizontal: 16, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
    {divider ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border }}/> : null}
    <View style={{ paddingVertical: 11, gap: 2 }}><Text style={{ color: t.muted, fontSize: 14 }}>{label}</Text><Text raw selectable={!onPress} style={{ color: accent ? t.accent : t.text, fontSize: 17, lineHeight: 23 }}>{value}</Text></View>
  </Pressable>;
}

/** Lighter (amount > 0) or darker (< 0) version of a #RRGGBB colour, for the profile header tint. */
function shade(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#596FE8';
  const n = parseInt(m[1], 16); const mix = (c: number) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}
