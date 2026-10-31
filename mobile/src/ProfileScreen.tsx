import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Text } from './typography';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import type { Api } from './api';
import { Avatar, Button, Field, Icon, IconButton, Notice, SectionLabel, Sheet } from './components';
import { useTheme } from './theme';
import { GlassSurface } from './glass';
import { ThemeSettings } from './ThemeSettings';
import { PlatinaWordmark } from './PlatinaWordmark';
import { StatusEmoji } from './StatusEmoji';
import { DecoratedAvatar, ProfileBanner } from './platina/Decor';
import { PlatinaStudio } from './platina/PlatinaStudio';
import { AnimatedEmoji } from './platina/AnimatedEmoji';
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
  const [name, setName] = useState(user.displayName), [bio, setBio] = useState(user.bio);
  const [avatarId, setAvatarId] = useState(user.avatarId), [color, setColor] = useState(user.avatarColor);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
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
  const pickAvatar = async () => {
    const version = begin('avatar'); if (version === null) return;
    try {
      if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!live(version)) return; if (!permission.granted) throw new Error('Разреши доступ к фотографиям в настройках устройства.'); }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1, exif: false, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
      if (!live(version) || result.canceled) return;
      const asset = result.assets[0]; if (!asset) return;
      // Camera photos are 12–48 MP; a full-size PNG exceeds the 4 MiB avatar limit.
      // Downscale to an avatar-sized JPEG first (also decodes HEIC), then run the usual sanitizing pipeline.
      const edge = Math.max(asset.width || 0, asset.height || 0);
      const resize = edge > AVATAR_EDGE ? [{ resize: (asset.width || 0) >= (asset.height || 0) ? { width: AVATAR_EDGE } : { height: AVATAR_EDGE } }] : [];
      const small = await ImageManipulator.manipulateAsync(asset.uri, resize, { format: ImageManipulator.SaveFormat.JPEG, compress: 0.86 });
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
    } catch (failure) { if (live(version)) setError(errorMessage(failure, 'Не удалось выбрать фото.')); }
    finally { finish(version); }
  };
  const save = async () => {
    if (!name.trim()) { setError('Имя не может быть пустым.'); return; }
    const version = begin('profile'); if (version === null) return;
    try { const result = await api.profile({ displayName: name.trim(), bio: bio.trim(), avatarColor: color, avatarId }); if (!live(version)) return; onUser(result.user); setNotice('Профиль сохранён.'); }
    catch (failure) { if (live(version)) setError(errorMessage(failure, 'Не удалось сохранить профиль.')); }
    finally { finish(version); }
  };
  const reviewUsername = () => {
    const next = normalizedUsername(username); setError(''); setNotice('');
    if (!/^[a-z0-9_]{3,24}$/.test(next)) { setError('Имя пользователя: от 3 до 24 символов a–z, 0–9 и подчёркивание.'); return; }
    if (!status || !status.canChangeUsername || statusLoading || statusError || next === status.username) return;
    setUsernameReview({ previous: status.username, next });
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
  const changed = name.trim() !== user.displayName || bio.trim() !== user.bio || avatarId !== user.avatarId || color !== user.avatarColor;
  const publicName = status?.username || user.username;
  const permanent = status?.platina.active === true && status.platina.permanent === true && status.platina.expiresAt === null;
  const previewUser: User = { ...user, displayName: name || user.displayName, avatarId, avatarColor: color, ...(status ? { statusEmoji: status.statusEmoji, statusEmojiExpiresAt: status.statusEmoji ? status.platina.expiresAt : null, statusEmojiPermanent: Boolean(status.statusEmoji && permanent) } : {}) };
  const ready = status !== null && !statusLoading && !statusError;
  const emojiChoices = status?.statusEmojiChoices.filter(emoji => (STATIC_STATUS_EMOJI as readonly string[]).includes(emoji)) || [];
  const expiry = status?.platina.expiresAt && Number.isFinite(Date.parse(status.platina.expiresAt)) ? new Date(status.platina.expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: 'transparent' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <GlassSurface material="clear" radius={27} style={{ marginHorizontal: 14, marginTop: 12, marginBottom: 2 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 9, minHeight: 68 }}><IconButton name="chevron-back" label="Назад" onPress={onBack}/><Text style={{ fontSize: 20, fontWeight: '700', letterSpacing: -.5, color: t.text, flex: 1 }}>Твой Инвиз</Text><View style={{ paddingRight: 10 }}><Icon name="person-circle-outline" color={t.muted} size={24}/></View></GlassSurface>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 17, paddingBottom: 36, maxWidth: 600, width: '100%', alignSelf: 'center', gap: 17 }}>
      <GlassSurface material="clear" radius={30} contentStyle={{ alignItems: 'center', gap: 11, paddingHorizontal: 20, paddingTop: 25, paddingBottom: 23 }}>
        {/* Clipped to the card's top corners and sized to the card: a fixed 600 pt banner ran past its right edge. */}
        {user.bannerId || user.bannerPreset ? <View pointerEvents="none" onLayout={event => setBannerWidth(Math.round(event.nativeEvent.layout.width))} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 120, overflow: 'hidden', borderTopLeftRadius: 30, borderTopRightRadius: 30 }}>{bannerWidth ? <ProfileBanner user={user} api={api} height={120} width={bannerWidth}/> : null}</View> : null}
        <Pressable disabled={busy} onPress={() => void pickAvatar()} accessibilityRole="button" accessibilityLabel="Изменить фото профиля" style={{ position: 'relative', padding: 6, marginBottom: 5, borderRadius: 39, borderWidth: 1, borderColor: t.glassBorder, backgroundColor: t.glassClear }}><DecoratedAvatar user={previewUser} api={api} size={88} animated/><View style={{ position: 'absolute', bottom: 0, right: -2, width: 33, height: 33, backgroundColor: t.accent, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.glassOpaque }}><Icon name="camera-outline" size={17} color={t.onAccent}/></View></Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '100%' }}><Text style={{ color: t.text, fontSize: 24, fontWeight: '700', letterSpacing: -.6, textAlign: 'center', flexShrink: 1 }}>{user.displayName}</Text><StatusEmoji user={previewUser} size={21} animated/></View>
        <Pressable onPress={() => void copy(`@${publicName}`, 'username')} accessibilityRole="button" accessibilityLabel="Скопировать имя пользователя" style={{ flexDirection: 'row', gap: 7, alignItems: 'center', paddingHorizontal: 13, paddingVertical: 8, borderRadius: 16, backgroundColor: t.accentSoft }}><Text style={{ color: t.accent, fontSize: 13, fontWeight: '600' }}>{copied === 'username' ? 'Скопировано' : `@${publicName}`}</Text><Icon name={copied === 'username' ? 'checkmark' : 'copy-outline'} size={13} color={t.accent}/></Pressable>
        {action === 'avatar' ? <Text style={{ color: t.muted, fontSize: 12 }}>Подготавливаем фото…</Text> : avatarId ? <Pressable disabled={busy} onPress={() => { setAvatarId(null); setNotice(''); }} style={{ padding: 6 }}><Text style={{ color: t.muted, fontSize: 12 }}>Убрать фото</Text></Pressable> : null}
      </GlassSurface>
      {error ? <Notice text={error} error/> : null}{notice ? <Notice text={notice}/> : null}
      <GlassSurface material="regular" radius={28} contentStyle={{ padding: 20, gap: 15 }}>
        <SectionLabel>Имя и вход</SectionLabel>
        {statusLoading ? <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><ActivityIndicator size="small" color={t.accent}/><Text style={{ color: t.muted, fontSize: 12 }}>Проверяем настройки аккаунта…</Text></View> : null}
        {statusError ? <Notice text={statusError} error onRetry={() => void loadStatus()}/> : null}
        {status ? <>
          <ReadOnlyValue label="Логин для входа" value={status.loginName} onCopy={() => void copy(status.loginName, 'login')} copied={copied === 'login'}/>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Логин нужен только для входа и никому не показывается. Публичное имя ниже — отдельное.</Text>
          <LoginChange api={api} onChanged={loginName => setStatus(current => current ? { ...current, loginName } : current)}/>
          <ReadOnlyValue label="ID аккаунта" value={status.accountId} onCopy={() => void copy(status.accountId, 'id')} copied={copied === 'id'} small/>
          <Field label="Публичное имя пользователя" value={username} onChangeText={value => { setUsername(value); setNotice(''); }} autoCapitalize="none" autoCorrect={false} maxLength={25} editable={!busy && ready && status.canChangeUsername} placeholder="@username"/>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{status.freeChangeAvailable ? 'Доступна одна бесплатная смена имени. После неё дополнительные смены доступны с Platina.' : status.canChangeUsername ? 'Бесплатная смена уже использована. Сейчас дополнительные смены доступны с Platina.' : 'Бесплатная смена уже использована. Для новой смены нужна активная Platina.'}</Text>
          <Button label="Изменить публичное имя" secondary icon="at-outline" disabled={busy || !ready || !status.canChangeUsername || normalizedUsername(username) === status.username} onPress={reviewUsername}/>
        </> : null}
      </GlassSurface>
      <GlassSurface material="regular" radius={28} contentStyle={{ padding: 20, gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><View style={{ flex: 1, minWidth: 0 }}><PlatinaWordmark/></View><Text style={{ color: t.muted, fontSize: 12, flexShrink: 0, maxWidth: '45%' }}>{!ready ? 'Проверяем…' : permanent ? 'Бессрочно' : status.platina.active ? 'Активна' : 'Не активна'}</Text></View>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>{ready && status.platina.active ? `Анимированные аватар, рамка, баннер и эмодзи, скрытие «в сети» и прочтения, дополнительные смены имени.${permanent ? ' Для этого аккаунта Platina действует без срока окончания.' : expiry ? ` Действует до ${expiry}.` : ''}` : 'Анимированные аватар, рамки, баннер и эмодзи, скрытие времени захода и прочтения, дополнительные смены имени.'}</Text>
        <Button label="Статус рядом с именем" secondary icon="happy-outline" disabled={busy || !ready} onPress={() => setEmojiVisible(true)}/>
        <PlatinaStudio api={api} user={user} active={ready && status.platina.active} onUser={onUser}/>
        <Pressable onPress={() => setPlatinaVisible(true)} accessibilityRole="button" style={{ paddingVertical: 5 }}><Text style={{ color: t.accent, fontSize: 12, fontWeight: '600' }}>Что даёт Platina</Text></Pressable>
      </GlassSurface>
      <GlassSurface material="regular" radius={28} contentStyle={{ padding: 20 }}>
        <SectionLabel>Личный профиль</SectionLabel><View style={{ gap: 18 }}>
          <Field label="Имя" value={name} onChangeText={value => { setName(value); setNotice(''); }} editable={!busy} maxLength={50} placeholder="Твоё имя"/>
          <Field label="О себе" value={bio} onChangeText={value => { setBio(value); setNotice(''); }} editable={!busy} maxLength={160} multiline placeholder="Несколько слов о тебе" style={{ height: 90, textAlignVertical: 'top' }}/>
          {!avatarId ? <View style={{ gap: 11 }}><Text style={{ color: t.muted, fontSize: 12 }}>Цвет аватара</Text><View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>{['#596FE8','#4088C7','#9271C3','#B78358','#AD6C8C','#667FA4'].map(value => <Pressable key={value} disabled={busy} onPress={() => { setColor(value); setNotice(''); }} accessibilityRole="radio" accessibilityState={{ selected: color === value }} accessibilityLabel={`Цвет ${value}`} style={{ width: 35, height: 35, borderRadius: 15, backgroundColor: value, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.glassBorder }}>{color === value ? <Icon name="checkmark" size={20} color="#FFF"/> : null}</Pressable>)}</View></View> : null}
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Фото профиля очищается от метаданных; итоговый размер — до 4 МБ. HDR-фото пока не поддерживается и не переводится незаметно в SDR.</Text>
          <Button label="Сохранить изменения" onPress={() => void save()} loading={action === 'profile'} disabled={!changed || busy}/>
        </View>
      </GlassSurface>
      <GlassSurface material="regular" radius={28} contentStyle={{ padding: 20 }}><SectionLabel>Оформление</SectionLabel><ThemeSettings mode={theme} darkTheme={darkTheme} onChange={onTheme} onDarkTheme={onDarkTheme}/></GlassSurface>
      <GlassSurface material="clear" radius={27} contentStyle={{ padding: 20, gap: 13 }}><SectionLabel>Аккаунт</SectionLabel><Button label="Безопасность и устройства" secondary icon="shield-checkmark-outline" onPress={onSecurity}/><Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Пароль, два секретных слова и действующие сеансы.</Text><Button label="Выйти из аккаунта" danger icon="log-out-outline" disabled={busy} onPress={() => setLogoutVisible(true)}/></GlassSurface>
      <Text style={{ textAlign: 'center', color: t.subtle, fontSize: 11, lineHeight: 18, paddingTop: 5 }}>Инвиз{'\n'}Новые личные сообщения шифруются на устройстве.{'\n'}Сверяй коды устройств в разделе «Защита чата».</Text>
    </ScrollView>
    <Sheet visible={usernameReview !== null} title="Изменить публичное имя?" onClose={() => { if (!busy) setUsernameReview(null); }}><View style={{ gap: 18 }}><Text style={{ color: t.text, fontSize: 19, fontWeight: '600' }}>@{usernameReview?.previous} → @{usernameReview?.next}</Text><Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>Логин для входа «{status?.loginName}», ID аккаунта и ключи переписки останутся прежними. Старое публичное имя перестанет вести на твой профиль.</Text><Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{status?.freeChangeAvailable ? 'Эта смена использует единственную бесплатную смену публичного имени.' : 'Эта смена доступна, пока Platina активна.'}</Text><Button label="Подтвердить смену имени" loading={action === 'username'} disabled={busy || !ready || !status?.canChangeUsername} onPress={() => void applyUsername()}/></View></Sheet>
    <Sheet visible={emojiVisible} title="Статус рядом с именем" onClose={() => { if (!busy) setEmojiVisible(false); }}><View style={{ gap: 18 }}><Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Выбранный эмодзи виден возле твоего имени в чатах. По умолчанию статус пустой. С Platina эмодзи анимированы.</Text>{!status?.canSetStatusEmoji ? <Notice text="Для выбора и замены статуса нужна активная Platina. Убрать статус можно в любой момент."/> : null}<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{emojiChoices.map(emoji => <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`Выбрать статус ${emoji}`} accessibilityState={{ disabled: busy || !status?.canSetStatusEmoji, selected: status?.statusEmoji === emoji }} disabled={busy || !ready || !status?.canSetStatusEmoji} onPress={() => void applyEmoji(emoji)} style={{ width: 56, height: 56, borderRadius: 19, borderWidth: 1, borderColor: status?.statusEmoji === emoji ? t.accent : t.border, backgroundColor: status?.statusEmoji === emoji ? t.accentSoft : t.glassClear, opacity: status?.canSetStatusEmoji ? 1 : .45, alignItems: 'center', justifyContent: 'center' }}><AnimatedEmoji emoji={emoji} size={34} /></Pressable>)}</View><Button label="Убрать статус" secondary disabled={busy || !ready} loading={action === 'emoji'} onPress={() => void applyEmoji(null)}/></View></Sheet>
    <Sheet visible={platinaVisible} title="Что даёт Platina" onClose={() => setPlatinaVisible(false)}><View style={{ gap: 16 }}><Text style={{ color: t.text, fontSize: 14, lineHeight: 22 }}>Анимированный аватар (видео до 10 с), анимированные рамки, живой баннер профиля, анимированные эмодзи-статусы и большие эмодзи в чатах, скрытие времени захода и отчётов о прочтении, дополнительные смены публичного имени. Доступ подтверждает сервер.</Text><Text style={{ color: t.muted, fontSize: 13, lineHeight: 21 }}>Покупка подписки в приложении пока не подключена: Platina выдаёт администратор сервера.</Text><Text style={{ color: t.muted, fontSize: 13, lineHeight: 21 }}>Анимации эмодзи — Noto Emoji Animation (Google), лицензия CC BY 4.0.</Text></View></Sheet>
    <Sheet visible={logoutVisible} title="Выйти из Инвиза?" onClose={() => { if (!busy) setLogoutVisible(false); }}><Text style={{ color: t.muted, fontSize: 15, lineHeight: 22, marginBottom: 22 }}>Сеанс на этом устройстве завершится. Для следующего входа понадобятся логин, пароль и слово подтверждения. Публичное имя может отличаться от логина.</Text><Button label="Выйти" danger onPress={() => void logout()} loading={action === 'logout'}/></Sheet>
  </KeyboardAvoidingView>;
}

function ReadOnlyValue({ label, value, onCopy, copied, small = false }: { label: string; value: string; onCopy: () => void; copied: boolean; small?: boolean }) {
  const t = useTheme();
  return <View style={{ gap: 7 }}><Text style={{ color: t.muted, fontSize: 11, fontWeight: '600' }}>{label}</Text><Pressable onPress={onCopy} accessibilityRole="button" accessibilityLabel={`Скопировать ${label.toLowerCase()}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 9, padding: 13, borderRadius: 15, backgroundColor: t.glassClear, borderWidth: 1, borderColor: t.border }}><Text selectable style={{ flex: 1, color: t.text, fontSize: small ? 12 : 15 }}>{copied ? 'Скопировано' : value}</Text><Icon name={copied ? 'checkmark' : 'copy-outline'} size={16} color={t.muted}/></Pressable></View>;
}

/** Change the private sign-in login (password + confirmation word required; other devices are signed out). */
function LoginChange({ api, onChanged }: { api: Api; onChanged: (loginName: string) => void }) {
  const [open, setOpen] = useState(false); const [login, setLogin] = useState(''); const [password, setPassword] = useState(''); const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState('');
  const next = login.trim().replace(/^@/, '').toLowerCase();
  const valid = /^[a-z0-9_]{3,24}$/.test(next) && password.length > 0;
  const submit = async () => {
    if (!valid || busy) return; setBusy(true); setError('');
    try { const result = await api.changeLoginName(next, password, word || undefined); onChanged(result.loginName); setDone(`Логин изменён на ${result.loginName}. Другие устройства вышли из аккаунта.`); setOpen(false); setPassword(''); setWord(''); setLogin(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сменить логин.'); }
    finally { setBusy(false); }
  };
  return <>
    <Button label="Сменить логин" secondary icon="key-outline" onPress={() => { setError(''); setDone(''); setOpen(true); }}/>
    {done ? <Notice text={done}/> : null}
    <Sheet visible={open} title="Новый логин для входа" onClose={() => { if (!busy) setOpen(false); }}>
      <View style={{ gap: 14 }}>
        <Field label="Новый логин" value={login} onChangeText={setLogin} autoCapitalize="none" autoCorrect={false} maxLength={25} placeholder="латиница, цифры, _" editable={!busy}/>
        <Field label="Текущий пароль" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" editable={!busy}/>
        <Field label="Слово подтверждения" value={word} onChangeText={setWord} autoCapitalize="none" autoCorrect={false} editable={!busy}/>
        {error ? <Notice text={error} error/> : null}
        <Button label="Сменить логин" icon="checkmark" loading={busy} disabled={!valid || busy} onPress={() => void submit()}/>
      </View>
    </Sheet>
  </>;
}
