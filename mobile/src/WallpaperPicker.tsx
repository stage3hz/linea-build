import React, { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './typography';
import { Icon, IconButton, Notice, Sheet, SheetAction } from './components';
import { useTheme } from './theme';
import { WALLPAPERS } from './chatPreferences';
import { keepPicture, setWallpaper, useWallpaper, type WallpaperChoice } from './wallpapers';
import { useMotion } from './motion';

/** Draws a chat's wallpaper behind the messages (gradient preset or picture with blur, dim and motion). */
export function ChatWallpaper({ choice, style }: { choice: WallpaperChoice; style?: object }) {
  const t = useTheme();
  if (choice.kind === 'preset') {
    const colors = WALLPAPERS.find(item => item.id === choice.id)?.colors;
    return colors ? <LinearGradient pointerEvents="none" colors={colors as unknown as [string, string, string]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, style]} /> : null;
  }
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }, style]}>
    <MovingPicture uri={choice.uri} blur={choice.blur} motion={choice.motion} />
    {t.dark && choice.dim > 0 ? <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0,0,0,${choice.dim})` }]} /> : null}
  </View>;
}

const SHIFT = 14;
function MovingPicture({ uri, blur, motion }: { uri: string; blur: boolean; motion: boolean }) {
  const { enabled } = useMotion(); const x = useSharedValue(0), y = useSharedValue(0);
  useEffect(() => {
    if (!motion || !enabled || Platform.OS === 'web') { x.value = withSpring(0); y.value = withSpring(0); return; }
    let subscription: { remove: () => void } | null = null;
    try {
      const { DeviceMotion } = require('expo-sensors') as typeof import('expo-sensors');
      DeviceMotion.setUpdateInterval(50);
      subscription = DeviceMotion.addListener(data => {
        const r = data.rotation; if (!r) return;
        x.value = withSpring(Math.max(-1, Math.min(1, r.gamma / 0.6)) * SHIFT, { damping: 20, stiffness: 120 });
        y.value = withSpring(Math.max(-1, Math.min(1, (r.beta - 0.8) / 0.6)) * SHIFT, { damping: 20, stiffness: 120 });
      });
    } catch { /* sensors unavailable: the picture stays still */ }
    return () => subscription?.remove();
  }, [motion, enabled]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: motion ? 1.08 : 1 }] }));
  return <Animated.View style={[StyleSheet.absoluteFill, style]}><Image source={{ uri }} contentFit="cover" blurRadius={blur ? 18 : 0} style={StyleSheet.absoluteFill} transition={150} /></Animated.View>;
}

/**
 * Обои чатов: presets and «Выбрать из галереи», then a full-screen preview with sample messages,
 * blur / motion toggles and dimming for the dark theme; set for this chat or for all chats.
 */
export function WallpaperPicker({ visible, onClose, chatId }: { visible: boolean; onClose: () => void; chatId?: string }) {
  const t = useTheme(); const current = useWallpaper(chatId);
  const [draft, setDraft] = useState<WallpaperChoice | null>(null); const [target, setTarget] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (!visible) { setDraft(null); setTarget(false); setError(''); } }, [visible]);
  const pick = async () => {
    setError('');
    try {
      if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('Разреши доступ к фото в настройках устройства.'); }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
      const asset = result.canceled ? null : result.assets[0]; if (!asset) return;
      // A phone-screen-sized JPEG is enough and keeps scrolling smooth.
      const small = await ImageManipulator.manipulateAsync(asset.uri, (asset.width || 0) > 1600 ? [{ resize: { width: 1600 } }] : [], { format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 });
      setDraft({ kind: 'image', uri: small.uri, blur: false, motion: true, dim: 0.2 });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось открыть фото.'); }
  };
  const apply = async (forChat: boolean) => {
    if (!draft) return;
    let choice = draft;
    if (draft.kind === 'image' && !draft.uri.includes('/wallpapers/')) {
      const uri = await keepPicture(draft.uri); await FileSystem.deleteAsync(draft.uri, { idempotent: true }).catch(() => {});
      choice = { ...draft, uri };
    }
    setWallpaper(choice, forChat ? chatId : undefined);
    onClose();
  };
  const presetTile = (id: string, colors: readonly string[] | null) => <Pressable key={id} accessibilityRole="button" accessibilityLabel={WALLPAPERS.find(item => item.id === id)?.label} onPress={() => setDraft({ kind: 'preset', id })} style={{ width: 96, height: 160, borderRadius: 14, overflow: 'hidden', backgroundColor: t.bg, borderWidth: 3, borderColor: current.kind === 'preset' && current.id === id ? t.accent : 'transparent' }}>
    {colors ? <LinearGradient colors={colors as unknown as [string, string, string]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} /> : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.muted, fontSize: 12 }}>Как фон</Text></View>}
  </Pressable>;
  return <>
    <Sheet visible={visible && !draft} title="Обои чатов" onClose={onClose}>
      <View style={{ gap: 12 }}>
        <SheetAction icon="images-outline" label="Выбрать из галереи" onPress={() => void pick()} />
        {error ? <Notice text={error} error /> : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
          {current.kind === 'image' ? <Pressable onPress={() => setDraft(current)} style={{ width: 96, height: 160, borderRadius: 14, overflow: 'hidden', borderWidth: 3, borderColor: t.accent }}><Image source={{ uri: current.uri }} contentFit="cover" style={StyleSheet.absoluteFill} /></Pressable> : null}
          {WALLPAPERS.map(item => presetTile(item.id, item.colors))}
        </ScrollView>
        <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Обои хранятся только на этом телефоне и никуда не отправляются; собеседник их не видит.</Text>
      </View>
    </Sheet>
    {draft ? <WallpaperPreview draft={draft} onChange={setDraft} onCancel={() => setDraft(null)} onSet={() => chatId ? setTarget(true) : void apply(false)} /> : null}
    <Sheet visible={target} title="Установить обои" onClose={() => setTarget(false)}>
      <SheetAction icon="chatbubble-outline" label="Для этого чата" onPress={() => { setTarget(false); void apply(true); }} />
      <SheetAction icon="chatbubbles-outline" label="Для всех чатов" onPress={() => { setTarget(false); void apply(false); }} />
    </Sheet>
  </>;
}

function WallpaperPreview({ draft, onChange, onCancel, onSet }: { draft: WallpaperChoice; onChange: (choice: WallpaperChoice) => void; onCancel: () => void; onSet: () => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const { width } = useWindowDimensions();
  const bubble = (text: string, mine: boolean) => <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: width * 0.72, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18, backgroundColor: mine ? t.bubble : t.incoming }}><Text style={{ color: t.text, fontSize: 16, lineHeight: 21 }}>{text}</Text></View>;
  const toggle = (label: string, icon: React.ComponentProps<typeof Icon>['name'], on: boolean, flip: () => void) => <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} onPress={flip} style={{ flex: 1, height: 42, borderRadius: 21, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)' }}><Icon name={icon} size={17} color="#FFF" /><Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>{label}</Text></Pressable>;
  return <Modal visible animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ChatWallpaper choice={draft} />
      <View style={{ paddingTop: insets.top + 8, alignItems: 'center' }}><View style={{ paddingHorizontal: 16, paddingVertical: 7, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.35)' }}><Text style={{ color: '#FFF', fontSize: 15, fontWeight: '600' }}>Предпросмотр</Text></View></View>
      <View style={{ padding: 14, gap: 8, marginTop: 24 }}>
        {bubble('Как тебе новые обои?', false)}
        {bubble('Огонь, ставлю 🔥', true)}
        {bubble('Так будет выглядеть чат.', false)}
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ padding: 14, paddingBottom: insets.bottom + 14, gap: 12 }}>
        {draft.kind === 'image' ? <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {toggle('Размытие', 'water-outline', draft.blur, () => onChange({ ...draft, blur: !draft.blur }))}
            {toggle('Движение', 'phone-portrait-outline', draft.motion, () => onChange({ ...draft, motion: !draft.motion }))}
          </View>
          {t.dark ? <View style={{ gap: 6 }}><Text style={{ color: '#FFF', fontSize: 12 }}>Затемнение в тёмной теме</Text><View style={{ flexDirection: 'row', gap: 6 }}>{[0, 0.2, 0.4, 0.6].map(value => <Pressable key={value} onPress={() => onChange({ ...draft, dim: value })} style={{ flex: 1, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: draft.dim === value ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.35)' }}><Text style={{ color: '#FFF', fontSize: 13, fontWeight: '600' }}>{value === 0 ? 'Нет' : `${value * 100}%`}</Text></Pressable>)}</View></View> : null}
        </> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable accessibilityRole="button" onPress={onCancel} style={{ flex: 1, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' }}><Text style={{ color: '#FFF', fontSize: 16, fontWeight: '600' }}>Отмена</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onSet} style={{ flex: 1.4, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent }}><Text style={{ color: t.onAccent, fontSize: 16, fontWeight: '700' }}>Установить</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}


