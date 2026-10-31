import React, { useState } from 'react';
import { EffectSwatch, NAMEPLATES, Nameplate, PROFILE_EFFECTS } from './Effects';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import type { Api } from '../api';
import type { User } from '../types';
import { Button, Icon, Notice, Sheet } from '../components';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { BANNERS, DecoratedAvatar, FRAMES, HERO_RATIO, ProfileBanner } from './Decor';
import { PlatinaName, PlatinaSeal, hasPlatina } from './PlatinaMark';
import { MusicAmbient, type AmbientTone } from '../music/MusicAmbient';
import { StatusEmoji } from '../StatusEmoji';

const VIDEO_LIMIT = 8 * 1024 * 1024;
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/**
 * Platina decoration editor: animated avatar (short video), frame and banner, with a live
 * preview. Without Platina everything is visible but locked; the server enforces the same.
 */
export function PlatinaStudio({ api, user, active, onUser }: { api: Api; user: User; active: boolean; onUser: (user: User) => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState(''); const [done, setDone] = useState('');
  const apply = async (key: string, change: Parameters<Api['profile']>[0], ok: string) => {
    if (!active || busy) return; setBusy(key); setError(''); setDone('');
    try { const result = await api.profile(change); onUser(result.user); setDone(ok); }
    catch (failure) { setError(message(failure, 'Не удалось сохранить оформление.')); }
    finally { setBusy(null); }
  };
  type Picked = ImagePicker.ImagePickerAsset;
  const [pending, setPending] = useState<Picked | null>(null);
  const pick = async (kind: 'avatar' | 'banner') => {
    if (!active || busy) return; setError(''); setDone('');
    try {
      if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('Разреши доступ к фото и видео в настройках телефона.'); }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: kind === 'avatar' ? ['videos'] : ['images', 'videos'], allowsEditing: true,
        // The banner is shown about 3:2 at the top of the profile, so it is cropped the same way.
        ...(kind === 'banner' ? { aspect: [3, 2] as [number, number] } : { aspect: [1, 1] as [number, number] }),
        videoMaxDuration: 10, quality: 0.8, exif: false,
        videoExportPreset: ImagePicker.VideoExportPreset.H264_960x540,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (asset.type === 'video' && (asset.duration || 0) > 10_500) throw new Error('Видео — не длиннее 10 секунд.');
      // A banner is shown on the profile preview first; it is uploaded only after «Установить».
      if (kind === 'banner') { setPending(asset); return; }
      await upload(kind, asset);
    } catch (failure) { setError(message(failure, 'Не удалось выбрать файл.')); }
  };
  const upload = async (kind: 'avatar' | 'banner', asset: Picked) => {
    setError(''); setDone('');
    try {
      const video = asset.type === 'video';
      setBusy(kind);
      let uploaded;
      if (video) uploaded = await api.upload({ uri: asset.uri, name: 'profile.mp4', mimeType: asset.mimeType || 'video/mp4', size: asset.fileSize });
      else {
        // A banner needs no more than ~1500 px across; this also keeps it under the 4 MB profile limit.
        const small = await ImageManipulator.manipulateAsync(asset.uri, (asset.width || 0) > 1500 ? [{ resize: { width: 1500 } }] : [], { format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 });
        try { uploaded = await api.upload({ uri: small.uri, name: 'banner.jpg', mimeType: 'image/jpeg' }); }
        finally { await FileSystem.deleteAsync(small.uri, { idempotent: true }).catch(() => {}); }
      }
      if (video && uploaded.size > VIDEO_LIMIT) throw new Error('После обработки видео больше 8 МБ. Выбери ролик короче.');
      const saved = await api.profile(kind === 'avatar' ? { avatarVideoId: uploaded.id } : { bannerId: uploaded.id });
      onUser(saved.user); setDone(kind === 'avatar' ? 'Анимированный аватар установлен.' : 'Баннер обновлён.');
    } catch (failure) { setError(message(failure, 'Не удалось загрузить файл.')); }
    finally { setBusy(null); }
  };
  return <View style={{ gap: 16 }}>
    {/* Live preview: exactly the head of your profile (banner, avatar, name, @username). */}
    <ProfileHero api={api} user={user} />
    {!active ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 14, backgroundColor: t.accentSoft }}><Icon name="lock-closed" size={15} color={t.accent} /><Text style={{ flex: 1, color: t.text, fontSize: 13, lineHeight: 18 }}>Оформление доступно с Platina.</Text></View> : null}
    {error ? <Notice text={error} error /> : null}{done ? <Notice text={done} /> : null}

    <Section title="Анимированный аватар" hint="Короткое видео до 10 секунд. Играет без звука в профиле и в шапке чата.">
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Button label={user.avatarVideoId ? 'Заменить видео' : 'Выбрать видео'} secondary icon="videocam-outline" loading={busy === 'avatar'} disabled={!active || !!busy} onPress={() => void pick('avatar')} /></View>
        {user.avatarVideoId ? <View style={{ flex: 1 }}><Button label="Убрать" secondary icon="trash-outline" disabled={!active || !!busy} onPress={() => void apply('avatar-off', { avatarVideoId: null }, 'Видео убрано.')} /></View> : null}
      </View>
    </Section>

    <Section title="Рамка аватара" hint="Медленно переливается вокруг фото.">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 4, paddingHorizontal: 2 }}>
        <Choice label="Нет" selected={!user.avatarFrame} disabled={!active || !!busy} onPress={() => void apply('frame', { avatarFrame: null }, 'Рамка убрана.')}>
          <View style={{ width: 52, height: 52, borderRadius: 19, borderWidth: 1, borderStyle: 'dashed', borderColor: t.subtle }} />
        </Choice>
        {FRAMES.map(frame => <Choice key={frame.id} label={frame.label} selected={user.avatarFrame === frame.id} disabled={!active || !!busy} onPress={() => void apply('frame', { avatarFrame: frame.id }, `Рамка «${frame.label}».`)}>
          <View style={{ padding: 4 }}><DecoratedAvatar user={{ ...user, avatarFrame: frame.id, avatarVideoId: null }} api={api} size={44} animated={user.avatarFrame === frame.id} /></View>
        </Choice>)}
      </ScrollView>
    </Section>

    <Section title="Баннер профиля" hint="Живой фон над аватаром — или своё фото или видео.">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 4, paddingHorizontal: 2 }}>
        <Choice label="Нет" selected={!user.bannerId && !user.bannerPreset} disabled={!active || !!busy} onPress={() => void apply('banner', { bannerId: null, bannerPreset: null }, 'Баннер убран.')}>
          <View style={{ width: 84, height: 46, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: t.subtle }} />
        </Choice>
        {BANNERS.map(banner => <Choice key={banner.id} label={banner.label} selected={!user.bannerId && user.bannerPreset === banner.id} disabled={!active || !!busy} onPress={() => void apply('banner', { bannerId: null, bannerPreset: banner.id }, `Баннер «${banner.label}».`)}>
          <View style={{ width: 84, height: 46, borderRadius: 12, overflow: 'hidden' }}><MusicAmbient width={84} height={46} tone={banner.id as AmbientTone} still /></View>
        </Choice>)}
      </ScrollView>
      <Button label={user.bannerId ? 'Заменить своё фото или видео' : 'Своё фото или видео'} secondary icon="image-outline" loading={busy === 'banner'} disabled={!active || !!busy} onPress={() => void pick('banner')} />
    </Section>

    <Section title="Эффект профиля" hint="Играет поверх твоего профиля, когда его открывают.">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 4, paddingHorizontal: 2 }}>
        <Choice label="Нет" selected={!user.profileEffect} disabled={!active || !!busy} onPress={() => void apply('effect', { profileEffect: null }, 'Эффект убран.')}>
          <View style={{ width: 56, height: 56, borderRadius: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: t.subtle }} />
        </Choice>
        {PROFILE_EFFECTS.map(effect => <Choice key={effect.id} label={effect.label} selected={user.profileEffect === effect.id} disabled={!active || !!busy} onPress={() => void apply('effect', { profileEffect: effect.id }, `Эффект «${effect.label}».`)}>
          <EffectSwatch effect={effect.id} />
        </Choice>)}
      </ScrollView>
    </Section>

    <Section title="Табличка" hint="Фон за твоим именем в списке чатов и участников серверов.">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 4, paddingHorizontal: 2 }}>
        <Choice label="Нет" selected={!user.nameplate} disabled={!active || !!busy} onPress={() => void apply('plate', { nameplate: null }, 'Табличка убрана.')}>
          <View style={{ width: 120, height: 40, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: t.subtle }} />
        </Choice>
        {NAMEPLATES.map(plate => <Choice key={plate.id} label={plate.label} selected={user.nameplate === plate.id} disabled={!active || !!busy} onPress={() => void apply('plate', { nameplate: plate.id }, `Табличка «${plate.label}».`)}>
          <View style={{ width: 120, height: 40, borderRadius: 12, overflow: 'hidden', backgroundColor: t.surface2, justifyContent: 'center', paddingLeft: 10 }}><Nameplate plate={plate.id} radius={12} /><Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{user.displayName}</Text></View>
        </Choice>)}
      </ScrollView>
    </Section>
    <Sheet visible={!!pending} title="Так будет выглядеть профиль" onClose={() => { if (busy !== 'banner') setPending(null); }}>
      {pending ? <View style={{ gap: 12 }}>
        <ProfileHero api={api} user={user} local={{ uri: pending.uri, video: pending.type === 'video' }} />
        <Button label="Установить баннер" icon="checkmark" loading={busy === 'banner'} disabled={!!busy} onPress={() => { const asset = pending; void upload('banner', asset).then(() => setPending(null)); }} />
        <Button label="Выбрать другое" secondary icon="image-outline" disabled={!!busy} onPress={() => { setPending(null); setTimeout(() => void pick('banner'), 350); }} />
      </View> : null}
    </Sheet>
  </View>;
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  const t = useTheme();
  return <View style={{ gap: 9 }}>
    <View style={{ gap: 3 }}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{title}</Text><Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{hint}</Text></View>
    {children}
  </View>;
}

function Choice({ label, selected, disabled, onPress, children }: { label: string; selected: boolean; disabled: boolean; onPress: () => void; children: React.ReactNode }) {
  const t = useTheme();
  return <Pressable accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ alignItems: 'center', gap: 6, opacity: disabled && !selected ? .55 : pressed ? .7 : 1 })}>
    <View style={{ padding: 3, borderRadius: 18, borderWidth: 2, borderColor: selected ? t.accent : 'transparent' }}>{children}</View>
    <Text style={{ color: selected ? t.accent : t.muted, fontSize: 11, fontWeight: selected ? '700' : '500' }}>{label}</Text>
  </Pressable>;
}

/** The top of a profile as others see it (same proportions as Settings): banner with soft edges, avatar, name. */
function ProfileHero({ api, user, local }: { api: Api; user: User; local?: { uri: string; video: boolean } }) {
  const t = useTheme(); const [width, setWidth] = useState(0);
  const scale = width / 393, height = Math.round(width * HERO_RATIO);
  const banner = local || user.bannerId || user.bannerPreset;
  return <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ borderRadius: 24, overflow: 'hidden', backgroundColor: t.bg, borderWidth: 1, borderColor: t.border }}>
    {width ? <>
      <View style={{ height }}>{banner ? <ProfileBanner user={user} api={api} height={height} width={width} local={local} /> : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.muted, fontSize: 12 }}>Без баннера</Text></View>}</View>
      <View style={{ marginTop: -58 * scale, paddingHorizontal: 20 * scale, paddingBottom: 16 * scale }}>
        <View style={{ alignSelf: 'flex-start', padding: 5 * scale, borderRadius: 40 * scale, backgroundColor: t.bg }}><DecoratedAvatar user={user} api={api} size={Math.round(100 * scale)} animated /></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 * scale, marginTop: 10 * scale }}>
          <PlatinaName user={user} style={{ color: t.text, fontSize: 26 * scale, fontWeight: '800', letterSpacing: -0.5 }} />
          <StatusEmoji user={user} size={Math.round(22 * scale)} animated />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 * scale }}>
          <Text style={{ color: t.muted, fontSize: 15 * scale }}>@{user.username}</Text>
          {hasPlatina(user) ? <PlatinaSeal size="sm" owner={user} /> : null}
        </View>
      </View>
    </> : <View style={{ height: 260 }} />}
  </View>;
}
