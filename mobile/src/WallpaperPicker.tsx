import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './typography';
import { Icon, IconButton, Notice, Sheet, SheetAction } from './components';
import { useTheme } from './theme';
import { WALLPAPERS } from './chatPreferences';
import { keepPicture, setWallpaper, useWallpaper, type WallpaperChoice } from './wallpapers';
import { useMotion } from './motion';
import { SnowBackLayer } from './SnowPhone';
import { PixelTrailLayer } from './PixelTrail';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { clampFit, coverSize } from './wallpaperFit';
import { SwipeDismissView, useSwipeDismiss } from './swipeDismiss';

/** Draws a chat's wallpaper behind the messages (gradient preset or picture with blur, dim and motion).
 *  `trail`: «Пиксельный след» is drawn over the wallpaper (the chat itself; not the picker's small preview) — the
 *  wallpaper covers the app backdrop, which carries the trail everywhere else. */
export function ChatWallpaper({ choice, style, trail = false, live }: { choice: WallpaperChoice; style?: object; trail?: boolean; /** The preview: the fit follows the fingers. */ live?: LiveFit }) {
  const t = useTheme();
  if (choice.kind === 'preset') {
    const colors = WALLPAPERS.find(item => item.id === choice.id)?.colors;
    if (!colors) return null;
    // The presets are all dark gradients: white tiles whatever the theme.
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <LinearGradient pointerEvents="none" colors={colors as unknown as [string, string, string]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {trail ? <><PixelTrailLayer ink="#FFFFFF" /><SnowBackLayer/></> : null}
    </View>;
  }
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }, style]}>
    <MovingPicture uri={choice.uri} blur={choice.blur} motion={choice.motion} aspect={choice.aspect || 0} fit={choice} live={live} />
    {t.dark && choice.dim > 0 ? <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0,0,0,${choice.dim})` }]} /> : null}
    {trail ? <><PixelTrailLayer /><SnowBackLayer/></> : null}
  </View>;
}

const SHIFT = 14;
type LiveFit = { zoom: SharedValue<number>; fx: SharedValue<number>; fy: SharedValue<number> };
function MovingPicture({ uri, blur, motion, aspect, fit, live }: { uri: string; blur: boolean; motion: boolean; aspect: number; fit: { zoom?: number; fx?: number; fy?: number }; live?: LiveFit }) {
  const { enabled } = useMotion(); const x = useSharedValue(0), y = useSharedValue(0);
  // The picture is drawn at the size that covers the area, then zoomed and moved as the user fitted it
  // (wallpaperFit.ts); the limits are applied for this area's own size, so no edge ever shows.
  const [area, setArea] = useState({ width: 0, height: 0 });
  const ownZoom = useSharedValue(fit.zoom ?? 1), ownX = useSharedValue(fit.fx ?? 0), ownY = useSharedValue(fit.fy ?? 0);
  useEffect(() => { ownZoom.value = fit.zoom ?? 1; ownX.value = fit.fx ?? 0; ownY.value = fit.fy ?? 0; }, [fit.zoom, fit.fx, fit.fy]);
  const zoom = live?.zoom ?? ownZoom, fx = live?.fx ?? ownX, fy = live?.fy ?? ownY;
  const cover = area.width && area.height ? coverSize(aspect, area.width, area.height) : null;
  const placed = useAnimatedStyle(() => {
    const fitted = clampFit({ zoom: zoom.value, fx: fx.value, fy: fy.value }, aspect, area.width, area.height);
    return { transform: [{ translateX: fitted.fx * area.width }, { translateY: fitted.fy * area.height }, { scale: fitted.zoom }] };
  }, [aspect, area.width, area.height]);
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
  return <Animated.View onLayout={event => { const { width, height } = event.nativeEvent.layout; if (width !== area.width || height !== area.height) setArea({ width, height }); }} style={[StyleSheet.absoluteFill, style]}>
    <Animated.View style={[cover ? { position: 'absolute', left: (area.width - cover.width) / 2, top: (area.height - cover.height) / 2, width: cover.width, height: cover.height } : StyleSheet.absoluteFill, placed]}>
      <Image source={{ uri }} contentFit="cover" blurRadius={blur ? 18 : 0} style={StyleSheet.absoluteFill} transition={150} />
    </Animated.View>
  </Animated.View>;
}

/**
 * Обои чатов: presets and «Выбрать из галереи», then a full-screen preview with sample messages,
 * blur / motion toggles and dimming for the dark theme; set for this chat or for all chats.
 */
export function WallpaperPicker({ visible, onClose, chatId }: { visible: boolean; onClose: () => void; chatId?: string }) {
  const t = useTheme(); const current = useWallpaper(chatId);
  const [draft, setDraft] = useState<WallpaperChoice | null>(null); const [target, setTarget] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (!visible) { setDraft(null); setTarget(false); setError(''); } }, [visible]);
  // The list of wallpapers and the preview are two native windows, and iOS shows a new one only after the previous
  // has gone: opened in the same moment, the preview never appeared (a picture was chosen and nothing happened).
  // So one closes first, then the other opens — `stage` is which of them may be on screen.
  const [stage, setStage] = useState<'list' | 'preview'>('list');
  const wanted = draft ? 'preview' : 'list';
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (stage === wanted) return;
    // The window reports that it has gone (see Sheet's onClosed); the timer is for where it does not.
    settle.current = setTimeout(() => setStage(wanted), Platform.OS === 'web' ? 0 : 450);
    return () => { if (settle.current) clearTimeout(settle.current); };
  }, [stage, wanted]);
  const pick = async () => {
    setError('');
    try {
      if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('Разреши доступ к фото в настройках устройства.'); }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
      const asset = result.canceled ? null : result.assets[0]; if (!asset) return;
      // A phone-screen-sized JPEG is enough and keeps scrolling smooth.
      const small = await ImageManipulator.manipulateAsync(asset.uri, (asset.width || 0) > 1600 ? [{ resize: { width: 1600 } }] : [], { format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 });
      setDraft({ kind: 'image', uri: small.uri, blur: false, motion: true, dim: 0.2, aspect: small.width > 0 && small.height > 0 ? small.width / small.height : 0, zoom: 1, fx: 0, fy: 0 });
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
    <Sheet visible={visible && !draft && stage === 'list'} title="Обои чатов" onClose={onClose} onClosed={() => { if (draft) setStage('preview'); }}>
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
    {draft && stage === 'preview' ? <WallpaperPreview draft={draft} onChange={setDraft} onCancel={() => setDraft(null)} onSet={() => chatId ? setTarget(true) : void apply(false)} /> : null}
    <Sheet visible={target} title="Установить обои" onClose={() => setTarget(false)}>
      <SheetAction icon="chatbubble-outline" label="Для этого чата" onPress={() => { setTarget(false); void apply(true); }} />
      <SheetAction icon="chatbubbles-outline" label="Для всех чатов" onPress={() => { setTarget(false); void apply(false); }} />
    </Sheet>
  </>;
}

function WallpaperPreview({ draft, onChange, onCancel, onSet }: { draft: WallpaperChoice; onChange: (choice: WallpaperChoice) => void; onCancel: () => void; onSet: () => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const { width, height } = useWindowDimensions();
  // Your own picture is fitted with the fingers: drag it to choose the part that shows, pinch to zoom.
  const image = draft.kind === 'image' ? draft : null;
  const aspect = image?.aspect || 0;
  const zoom = useSharedValue(image?.zoom ?? 1), fx = useSharedValue(image?.fx ?? 0), fy = useSharedValue(image?.fy ?? 0);
  const from = useSharedValue({ zoom: 1, fx: 0, fy: 0 });
  const latest = useRef({ draft, onChange }); latest.current = { draft, onChange };
  const keep = (z: number, x: number, y: number) => { const now = latest.current; if (now.draft.kind === 'image') now.onChange({ ...now.draft, zoom: z, fx: x, fy: y }); };
  const drag = Gesture.Pan().maxPointers(2)
    .onStart(() => { from.value = { zoom: zoom.value, fx: fx.value, fy: fy.value }; })
    .onUpdate(event => { const fitted = clampFit({ zoom: zoom.value, fx: from.value.fx + event.translationX / width, fy: from.value.fy + event.translationY / height }, aspect, width, height); fx.value = fitted.fx; fy.value = fitted.fy; })
    .onEnd(() => { runOnJS(keep)(zoom.value, fx.value, fy.value); });
  const startZoom = useSharedValue(1);
  const pinch = Gesture.Pinch()
    .onStart(() => { startZoom.value = zoom.value; })
    .onUpdate(event => { const fitted = clampFit({ zoom: startZoom.value * event.scale, fx: fx.value, fy: fy.value }, aspect, width, height); zoom.value = fitted.zoom; fx.value = fitted.fx; fy.value = fitted.fy; })
    .onEnd(() => { runOnJS(keep)(zoom.value, fx.value, fy.value); });
  const fitting = Gesture.Simultaneous(drag, pinch);
  const bubble = (text: string, mine: boolean) => <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: width * 0.72, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18, backgroundColor: mine ? t.bubble : t.incoming }}><Text style={{ color: t.text, fontSize: 16, lineHeight: 21 }}>{text}</Text></View>;
  const toggle = (label: string, icon: React.ComponentProps<typeof Icon>['name'], on: boolean, flip: () => void) => <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} onPress={flip} style={{ flex: 1, height: 42, borderRadius: 21, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)' }}><Icon name={icon} size={17} color="#FFF" /><Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>{label}</Text></Pressable>;
  // The preview slides up full screen: pull it down to cancel, like Telegram's. Transparent so the
  // screen underneath shows while it is pulled.
  // (Not while a picture is being fitted: there a drag moves the picture.)
  const swipe = useSwipeDismiss({ onDismiss: onCancel, enabled: !image });
  return <Modal visible transparent animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
    <GestureHandlerRootView style={{ flex: 1 }}><SwipeDismissView swipe={swipe} style={{ flex: 1, overflow: 'hidden', backgroundColor: t.bg }}>
      <ChatWallpaper choice={draft} live={image ? { zoom, fx, fy } : undefined} />
      {image ? <GestureDetector gesture={fitting}><View style={StyleSheet.absoluteFill} /></GestureDetector> : null}
      <View style={{ paddingTop: insets.top + 8, alignItems: 'center' }}><View style={{ paddingHorizontal: 16, paddingVertical: 7, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.35)' }}><Text style={{ color: '#FFF', fontSize: 15, fontWeight: '600' }}>Предпросмотр</Text></View></View>
      <View pointerEvents="none" style={{ padding: 14, gap: 8, marginTop: 24 }}>
        {bubble('Как тебе новые обои?', false)}
        {bubble('Огонь, ставлю 🔥', true)}
        {bubble('Так будет выглядеть чат.', false)}
      </View>
      <View pointerEvents="none" style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 10 }}>{image ? <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.35)' }}><Text style={{ color: '#FFF', fontSize: 12 }}>Двигай фото пальцем, масштаб — двумя</Text></View> : null}</View>
      <View style={{ padding: 14, paddingBottom: insets.bottom + 14, gap: 12 }}>
        {draft.kind === 'image' ? <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {toggle('Размытие', 'water-outline', draft.blur, () => onChange({ ...draft, blur: !draft.blur }))}
            {Platform.OS === 'web' ? null : toggle('Движение', 'phone-portrait-outline', draft.motion, () => onChange({ ...draft, motion: !draft.motion }))}
          </View>
          {t.dark ? <View style={{ gap: 6 }}><Text style={{ color: '#FFF', fontSize: 12 }}>Затемнение в тёмной теме</Text><View style={{ flexDirection: 'row', gap: 6 }}>{[0, 0.2, 0.4, 0.6].map(value => <Pressable key={value} onPress={() => onChange({ ...draft, dim: value })} style={{ flex: 1, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: draft.dim === value ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.35)' }}><Text style={{ color: '#FFF', fontSize: 13, fontWeight: '600' }}>{value === 0 ? 'Нет' : `${value * 100}%`}</Text></Pressable>)}</View></View> : null}
        </> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable accessibilityRole="button" onPress={onCancel} style={{ flex: 1, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' }}><Text style={{ color: '#FFF', fontSize: 16, fontWeight: '600' }}>Отмена</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onSet} style={{ flex: 1.4, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent }}><Text style={{ color: t.onAccent, fontSize: 16, fontWeight: '700' }}>Установить</Text></Pressable>
        </View>
      </View>
    </SwipeDismissView></GestureHandlerRootView>
  </Modal>;
}


