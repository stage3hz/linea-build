import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../typography';
import { Icon, type IconName } from '../components';
import { GlassSurface } from '../glass';
import { lightFeedback } from '../haptics';
import { MusicAmbient } from '../music/MusicAmbient';
import type { Api } from '../api';
import type { User } from '../types';
import { DecoratedAvatar, ProfileBanner } from './Decor';
import { PLATINUM, PlatinaName, PlatinaSeal, onPlatinaShowcase } from './PlatinaMark';
import { usePlatina } from './usePlatina';
import { ProfileEffect } from './Effects';

const PERKS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'videocam', title: 'Живой аватар', text: 'Видео до 10 секунд вместо фото' },
  { icon: 'ellipse-outline', title: 'Рамки', text: 'Платиновая и ещё шесть анимированных' },
  { icon: 'image', title: 'Живой баннер', text: 'Фото, видео или анимация над профилем' },
  { icon: 'sparkles', title: 'Эффект профиля', text: 'Снег, искры, лепестки — когда открывают твой профиль' },
  { icon: 'albums', title: 'Табличка', text: 'Фон за именем в чатах и списках участников' },
  { icon: 'diamond', title: 'Платиновое имя и печать', text: 'Видно в чатах, каналах и на серверах' },
  { icon: 'happy', title: 'Анимированные эмодзи', text: 'Статус у имени и большие эмодзи в чатах' },
  { icon: 'eye-off', title: 'Невидимка', text: 'Скрыть время захода и прочтения' },
  { icon: 'at', title: 'Смена ника', text: 'Дополнительные смены @имени' },
];

/**
 * «Вот так будешь выглядеть ты»: the viewer's own profile already dressed in Platina, then
 * what it includes. Opens from any seal or platinum name, and from Settings.
 */
export function PlatinaShowcaseHost({ api, me, onCustomize }: { api: Api; me: User; onCustomize: () => void }) {
  const [open, setOpen] = useState<{ owner?: Pick<User, 'id' | 'displayName'> } | null>(null);
  useEffect(() => onPlatinaShowcase(owner => setOpen({ owner })), []);
  const active = usePlatina(api, me.id);
  const t = { text: '#EEF1F6', muted: '#8B93A3' };
  const insets = useSafeAreaInsets(); const { width } = useWindowDimensions();
  const [note, setNote] = useState(false);
  useEffect(() => { if (!open) setNote(false); }, [open]);
  const dressed: User = { ...me, seal: 'platina', avatarFrame: me.avatarFrame || 'platinum', profileEffect: me.profileEffect || 'sparks' };
  const other = open?.owner && open.owner.id !== me.id ? open.owner : null;
  const cardWidth = Math.min(width - 32, 520);
  return <Modal visible={!!open} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setOpen(null)} statusBarTranslucent>
    <View style={{ flex: 1, backgroundColor: '#06070A' }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 60, paddingBottom: insets.bottom + 40, alignItems: 'center' }}>
        {other ? <Text style={{ color: t.muted, fontSize: 13, marginBottom: 12 }}>У {other.displayName} — Platina. А вот так будешь выглядеть ты:</Text> : <Text style={{ color: t.muted, fontSize: 13, marginBottom: 12 }}>Так твой профиль увидят другие</Text>}
        {/* The preview: the viewer's own profile in Platina. */}
        <View style={{ width: cardWidth, borderRadius: 26, overflow: 'hidden', backgroundColor: '#101217' }}>
          <View style={{ height: 120 }}>
            {me.bannerId || me.bannerPreset ? <ProfileBanner user={me} api={api} height={120} width={cardWidth} /> : <MusicAmbient width={cardWidth} height={120} tone="deep" />}
            <LinearGradient colors={['transparent', '#101217']} locations={[0.4, 1]} style={StyleSheet.absoluteFill} />
            <ProfileEffect effect={dressed.profileEffect} width={cardWidth} height={200} />
          </View>
          <View style={{ marginTop: -46, paddingHorizontal: 18, paddingBottom: 18 }}>
            <View style={{ alignSelf: 'flex-start', padding: 5, borderRadius: 60, backgroundColor: '#101217' }}><DecoratedAvatar user={dressed} api={api} size={78} animated /></View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}><PlatinaName user={dressed} style={{ fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }} /></View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}><Text style={{ color: t.muted, fontSize: 14 }}>@{me.username}</Text><PlatinaSeal onPress={() => {}} /></View>
          </View>
        </View>
        <View style={{ width: cardWidth, marginTop: 28, alignItems: 'center' }}>
          <PlatinaName user={{ displayName: 'Инвиз Platina', seal: 'platina' }} style={{ fontSize: 30, fontWeight: '800', letterSpacing: -0.6 }} />
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8, paddingHorizontal: 12 }}>Профиль, который заметят. Всё, что ниже, и всё, что появится дальше.</Text>
        </View>
        <View style={{ width: cardWidth, marginTop: 22, borderRadius: 20, backgroundColor: '#101217', paddingVertical: 6 }}>
          {PERKS.map((perk, index) => <View key={perk.title} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 11, borderTopWidth: index ? StyleSheet.hairlineWidth : 0, borderTopColor: 'rgba(255,255,255,0.08)' }}>
            <View style={{ width: 34, height: 34, borderRadius: 11, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
              <LinearGradient colors={PLATINUM as unknown as [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              <Icon name={perk.icon} size={17} color="#1A1F2A" />
            </View>
            <View style={{ flex: 1 }}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{perk.title}</Text><Text style={{ color: t.muted, fontSize: 12.5, marginTop: 2 }}>{perk.text}</Text></View>
          </View>)}
        </View>
        <Pressable accessibilityRole="button" onPress={() => { lightFeedback(); if (active) { setOpen(null); onCustomize(); } else setNote(true); }} style={({ pressed }) => ({ width: cardWidth, height: 54, borderRadius: 18, overflow: 'hidden', marginTop: 24, alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? .96 : 1 }] })}>
          <LinearGradient colors={['#E9EDF3', '#FFFFFF', '#BCC5D3', '#F6F8FB']} start={{ x: 0, y: 0.3 }} end={{ x: 1, y: 0.7 }} style={StyleSheet.absoluteFill} />
          <Text style={{ color: '#12151C', fontSize: 16, fontWeight: '800' }}>{active ? 'Настроить оформление' : 'Попробовать Platina'}</Text>
        </Pressable>
        {note ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 12, width: cardWidth }}>Покупка в приложении скоро появится. Сейчас Platina выдаёт администратор сервера.</Text>
          : <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center', marginTop: 10 }}>{active ? 'Platina уже активна' : 'Отменить можно в любой момент'}</Text>}
      </ScrollView>
      <View style={{ position: 'absolute', top: insets.top + 8, right: 16 }}>
        <GlassSurface radius={22} shadow={false} interactive contentStyle={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={() => setOpen(null)} hitSlop={6} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={22} color="#FFF" /></Pressable>
        </GlassSurface>
      </View>
    </View>
  </Modal>;
}
