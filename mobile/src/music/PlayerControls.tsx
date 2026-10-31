import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent, useWindowDimensions, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MusicAmbient, type AmbientTone } from './MusicAmbient';
import { Image as BlurImage } from 'expo-image';
import { EqualizerScreen } from './EqualizerScreen';
import { Text } from '../typography';
import { LinearGradient } from 'expo-linear-gradient';
import { Button, Icon, IconButton, Notice } from '../components';
import { GlassSurface } from '../glass';
import { useTheme } from '../theme';
import { useMusic } from './MusicProvider';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { lightFeedback } from '../haptics';
import type { MusicTrack } from './types';

export function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const value = Math.floor(seconds), minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, '0')}`;
}

export function TrackArtwork({ track, size = 48 }: { track: MusicTrack; size?: number }) {
  const t = useTheme(); const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [track.id, track.artworkUrl]);
  const radius = Math.max(12, Math.min(36, size * .23));
  return <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: t.accentSoft, borderWidth: 1, borderColor: t.glassBorder }}>
    {track.artworkUrl && !failed ? <Image source={{ uri: track.artworkUrl }} accessibilityLabel={`Обложка: ${track.title}`} style={{ width: '100%', height: '100%' }} resizeMode="cover" onError={() => setFailed(true)} /> : <LinearGradient colors={t.dark ? ['#253E70', '#38334F', '#172844'] : ['#CDDEFF', '#E1DCF6', '#AECBF3']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <View pointerEvents="none" style={{ position: 'absolute', width: size * .95, height: size * .95, borderWidth: 1, borderColor: t.glassHighlight, borderRadius: size, transform: [{ translateX: size * .24 }, { translateY: size * .22 }] }} />
      <Icon name={track.source === 'local' ? 'musical-note' : 'musical-notes'} size={Math.max(22, size * .31)} color={t.dark ? '#C5D9FF' : '#4569A5'} />
    </LinearGradient>}
  </View>;
}

function PlaybackButton({ large = false }: { large?: boolean }) {
  const music = useMusic(), t = useTheme(); const size = large ? 72 : 46;
  // VK / Apple Music: in the full player the play/pause is a large bare glyph, no disc.
  if (large) return <Pressable accessibilityRole="button" accessibilityLabel={music.loading ? 'Загрузка. Повторить воспроизведение' : music.playing ? 'Приостановить' : 'Воспроизвести'} onPress={() => void music.togglePlayback()} hitSlop={10} style={({ pressed }) => ({ width: 72, height: 72, alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? .96 : 1 }] })}>
    {music.loading ? <ActivityIndicator color={t.text} /> : <Icon name={music.playing ? 'pause' : 'play'} size={52} color={t.text} />}
  </Pressable>;
  return <Pressable accessibilityRole="button" accessibilityLabel={music.loading ? 'Загрузка. Повторить воспроизведение' : music.playing ? 'Приостановить' : 'Воспроизвести'} accessibilityState={{ busy: music.loading }} onPress={() => void music.togglePlayback()} style={({ pressed }) => ({ width: size, height: size, minWidth: 44, minHeight: 44, borderRadius: size / 2, transform: [{ scale: pressed ? .95 : 1 }] })}>
    <GlassSurface radius={size / 2} material="clear" interactive shadow={large} style={{ width: size, height: size }} contentStyle={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <LinearGradient pointerEvents="none" colors={t.accentGradient} style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
      {music.loading ? <ActivityIndicator color={t.onAccent} /> : <Icon name={music.playing ? 'pause' : 'play'} size={large ? 30 : 23} color={t.onAccent} />}
    </GlassSurface>
  </Pressable>;
}

/** Swipe the mini player down to stop the music and hide it. */
function useSwipeDown(onDismiss: () => void) {
  const offset = useRef(new Animated.Value(0)).current;
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  const responder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.3,
    onMoveShouldSetPanResponderCapture: (_e, g) => g.dy > 12 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
    onPanResponderMove: (_e, g) => offset.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 45 || g.vy > 0.9) Animated.timing(offset, { toValue: 160, duration: 160, useNativeDriver: true }).start(() => { dismiss.current(); offset.setValue(0); });
      else Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start(),
  })).current;
  const style = { transform: [{ translateY: offset }], opacity: offset.interpolate({ inputRange: [0, 140], outputRange: [1, 0], extrapolate: 'clamp' }) };
  return { handlers: responder.panHandlers, style };
}

export function MiniPlayer(_props: { onOpen?: () => void }) {
  const music = useMusic(), t = useTheme();
  const swipe = useSwipeDown(music.stop);
  if (!music.current) return null;
  const progress = music.duration > 0 ? Math.min(1, music.position / music.duration) : 0;
  return <Animated.View {...swipe.handlers} style={swipe.style} accessibilityHint="Смахни вниз, чтобы остановить музыку и убрать плеер" accessibilityActions={[{ name: 'escape', label: 'Убрать плеер' }]} onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'escape') music.stop(); }}><GlassSurface radius={24} material="regular" style={{ marginHorizontal: 12, marginBottom: 8, maxWidth: 720, width: 'auto', alignSelf: 'stretch' }} contentStyle={{ padding: 9, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 9, overflow: 'hidden', borderRadius: 24 }}>
    <Pressable onPress={openFullPlayer} accessibilityRole="button" accessibilityLabel={`Открыть плеер: ${music.current.title}, ${music.current.artist}`} style={{ flex: 1, minHeight: 48, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11 }}>
      <TrackArtwork track={music.current} size={46} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text numberOfLines={1} style={{ color: t.text, fontSize: 14, fontWeight: '700' }}>{music.current.title}</Text>
        <Text numberOfLines={1} style={{ color: music.error ? t.danger : t.muted, fontSize: 12 }}>{music.error ? 'Есть сообщение · открыть' : music.loading ? 'Загружаем трек…' : music.current.artist}</Text>
      </View>
    </Pressable>
    <IconButton name="play-skip-back" label="Предыдущий трек или начало текущего" onPress={() => void music.previous()} size={20} style={{ width: 36, height: 44 }} />
    <PlaybackButton />
    <IconButton name="play-skip-forward" label="Следующий трек" onPress={() => void music.next()} size={20} disabled={music.queue.length < 2} style={{ width: 36, height: 44 }} />
    <IconButton name="close" label="Закрыть плеер и остановить музыку" onPress={music.stop} size={20} color={t.muted} style={{ width: 34, height: 44 }} />
    <View pointerEvents="none" style={{ position: 'absolute', bottom: 0, left: 15, right: 15, height: 2, backgroundColor: t.border }}><View style={{ height: 2, width: `${progress * 100}%`, backgroundColor: t.accent }} /></View>
  </GlassSurface></Animated.View>;
}

/** Telegram-style player strip shown under the chat header while music plays. */
export function TopPlayerBar(_props: { onOpen?: () => void }) {
  const music = useMusic(), t = useTheme();
  if (!music.current) return null;
  const progress = music.duration > 0 ? Math.min(1, music.position / music.duration) : 0;
  return <GlassSurface lens radius={18} material="regular" shadow={false} style={{ marginHorizontal: 12 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, paddingLeft: 4, paddingRight: 2 }}>
    <IconButton name={music.playing ? 'pause' : 'play'} label={music.playing ? 'Пауза' : 'Слушать'} onPress={() => void music.togglePlayback()} size={18} color={t.accent} style={{ width: 36, height: 40 }} />
    <Pressable onPress={openFullPlayer} accessibilityRole="button" accessibilityLabel={`Открыть плеер: ${music.current.title}, ${music.current.artist}`} style={{ flex: 1, minWidth: 0, paddingHorizontal: 4 }}>
      <Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{music.current.title}<Text style={{ color: t.muted, fontWeight: '400' }}>{`  ${music.current.artist}`}</Text></Text>
    </Pressable>
    <IconButton name="close" label="Закрыть плеер и остановить музыку" onPress={music.stop} size={18} color={t.muted} style={{ width: 36, height: 40 }} />
    <View pointerEvents="none" style={{ position: 'absolute', bottom: 0, left: 14, right: 14, height: 2, borderRadius: 1, backgroundColor: t.border }}><View style={{ height: 2, borderRadius: 1, width: `${progress * 100}%`, backgroundColor: t.accent }} /></View>
  </GlassSurface>;
}

function SeekBar() {
  const music = useMusic(), t = useTheme(); const [width, setWidth] = useState(0), [drag, setDrag] = useState<number | null>(null);
  const dragValue = useRef<number | null>(null);
  useEffect(() => { setDrag(null); dragValue.current = null; }, [music.current?.id]);
  const duration = music.duration, shown = drag ?? music.position, ratio = duration > 0 ? Math.min(1, Math.max(0, shown / duration)) : 0;
  const update = (event: GestureResponderEvent) => {
    if (!duration || !width) return;
    const value = Math.max(0, Math.min(width, event.nativeEvent.locationX)) / width * duration;
    dragValue.current = value; setDrag(value);
  };
  const finish = () => { const value = dragValue.current; dragValue.current = null; setDrag(null); if (value !== null) void music.seek(value); };
  return <View style={{ gap: 0 }}>
    <View accessible accessibilityRole="adjustable" accessibilityLabel="Позиция воспроизведения" accessibilityValue={{ min: 0, max: Math.round(duration || 0), now: Math.round(shown), text: `${formatAudioTime(shown)} из ${duration > 0 ? formatAudioTime(duration) : 'неизвестной длительности'}` }} accessibilityActions={[{ name: 'increment', label: 'Вперёд на 10 секунд' }, { name: 'decrement', label: 'Назад на 10 секунд' }]} onAccessibilityAction={event => void music.seek(music.position + (event.nativeEvent.actionName === 'increment' ? 10 : -10))}
      onLayout={event => setWidth(event.nativeEvent.layout.width)} onStartShouldSetResponder={() => duration > 0} onMoveShouldSetResponder={() => duration > 0} onResponderGrant={update} onResponderMove={update} onResponderRelease={finish} onResponderTerminate={() => { dragValue.current = null; setDrag(null); }} onResponderTerminationRequest={() => false}
      style={{ minHeight: 44, justifyContent: 'center', ...(Platform.OS === 'web' ? { cursor: duration > 0 ? 'pointer' : 'default' } as object : {}) }}>
      <View pointerEvents="none" style={{ height: drag !== null ? 7 : 5, borderRadius: 5, backgroundColor: t.border, overflow: 'hidden' }}><View style={{ width: `${ratio * 100}%`, height: '100%', borderRadius: 5, backgroundColor: t.accent }} /></View>
      <View pointerEvents="none" style={{ position: 'absolute', left: Math.max(0, Math.min(Math.max(0, width - 12), ratio * width - 6)), width: 12, height: 12, borderRadius: 6, backgroundColor: t.accent, borderWidth: 2, borderColor: t.glassOpaque, opacity: duration > 0 ? 1 : .35 }} />
    </View>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 }}><Text style={{ color: t.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{formatAudioTime(shown)}</Text><Text style={{ color: t.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{duration > 0 ? formatAudioTime(duration) : '—:—'}</Text></View>
  </View>;
}

/**
 * Cover of the full player: swipe left / right to change the track, swipe down to collapse
 * the player (as in the VK and Apple Music players). UI thread.
 */
function SwipeArtwork({ track, size, onCollapse }: { track: MusicTrack; size: number; onCollapse?: () => void }) {
  const music = useMusic();
  const x = useSharedValue(0), y = useSharedValue(0);
  const change = (direction: number) => { lightFeedback(); if (direction < 0) void music.next(); else void music.previous(); };
  const collapse = () => onCollapse?.();
  const canNext = music.queue.length > 1;
  useEffect(() => { x.value = 0; y.value = 0; }, [track.id]);
  const horizontal = Gesture.Pan().activeOffsetX([-12, 12]).failOffsetY([-12, 12])
    .onUpdate(event => { x.value = event.translationX; })
    .onEnd(event => {
      const go = Math.abs(event.translationX) > size * 0.28 || Math.abs(event.velocityX) > 800;
      if (go && canNext) {
        const direction = event.translationX < 0 ? -1 : 1;
        x.value = withTiming(direction * size * 1.2, { duration: 180, easing: Easing.out(Easing.quad) }, done => { if (done) { runOnJS(change)(direction); x.value = -direction * size * 0.4; x.value = withSpring(0, { damping: 18, stiffness: 220 }); } });
      } else x.value = withSpring(0, { damping: 18, stiffness: 260 });
    });
  const vertical = Gesture.Pan().enabled(!!onCollapse).activeOffsetY(14).failOffsetX([-14, 14])
    .onUpdate(event => { y.value = Math.max(0, event.translationY); })
    .onEnd(event => {
      if (event.translationY > 110 || event.velocityY > 900) { runOnJS(collapse)(); }
      y.value = withSpring(0, { damping: 18, stiffness: 260 });
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }], opacity: 1 - Math.min(0.5, Math.abs(x.value) / size * 0.6) }));
  return <GestureDetector gesture={Gesture.Race(horizontal, vertical)}>
    <Reanimated.View style={style}><TrackArtwork track={track} size={size} /></Reanimated.View>
  </GestureDetector>;
}

export function PlayerControls({ compact = false, onOpen, onCollapse }: { compact?: boolean; onOpen?: () => void; onCollapse?: () => void } = {}) {
  const music = useMusic(), t = useTheme(); const [showQueue, setShowQueue] = useState(false); const { width } = useWindowDimensions();
  if (compact && onOpen) return <MiniPlayer onOpen={onOpen} />;
  const track = music.current;
  if (!track) return <View style={{ alignItems: 'center', gap: 15, paddingVertical: 30 }}><Icon name="musical-notes-outline" color={t.accent} size={42} /><Text style={{ color: t.text, fontSize: 19, fontWeight: '600' }}>Выбери музыку для своего дня</Text><Text style={{ color: t.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' }}>Найди трек или добавь аудиофайлы с устройства.</Text></View>;
  const favorite = music.favorites.some(item => item.id === track.id), downloading = Object.prototype.hasOwnProperty.call(music.downloads, track.id);
  const repeatLabel = music.repeat === 'one' ? 'Повтор одного трека' : music.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен';
  return <View style={{ gap: 21, paddingBottom: 5 }}>
    <View style={{ alignItems: 'center', paddingVertical: 4 }}><View style={{ borderRadius: 34, shadowColor: '#000', shadowOpacity: .35, shadowRadius: 22, shadowOffset: { width: 0, height: 12 } }}><SwipeArtwork track={track} size={Math.min(353, width - 48)} onCollapse={onCollapse} /></View></View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1, gap: 6 }}><Text numberOfLines={2} style={{ color: t.text, fontSize: 20, lineHeight: 25, fontWeight: '700', letterSpacing: -.3 }}>{track.title}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 14, lineHeight: 19 }}>{track.artist}</Text><Text style={{ color: t.subtle, fontSize: 11, letterSpacing: .5 }}>{track.source === 'audius' ? 'AUDIUS · ОНЛАЙН' : Platform.OS === 'web' ? 'ЛОКАЛЬНЫЙ ФАЙЛ · ДО ПЕРЕЗАГРУЗКИ' : 'НА ЭТОМ УСТРОЙСТВЕ'}</Text></View>
      <IconButton name={favorite ? 'heart' : 'heart-outline'} label={favorite ? 'Убрать из избранного' : 'Добавить в избранное'} color={favorite ? t.accent : t.text} onPress={() => void music.toggleFavorite(track)} />
    </View>
    <SeekBar />
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <IconButton name="shuffle" label={music.shuffle ? 'Случайный порядок включён' : 'Включить случайный порядок'} color={music.shuffle ? t.accent : t.subtle} onPress={music.toggleShuffle} size={21} />
      <IconButton name="play-skip-back" label="Предыдущий трек или начало текущего" onPress={() => void music.previous()} size={32} color={t.text} />
      <PlaybackButton large />
      <IconButton name="play-skip-forward" label="Следующий трек" onPress={() => void music.next()} size={32} color={t.text} disabled={music.queue.length < 2} />
      <View><IconButton name="repeat" label={`${repeatLabel}. Изменить`} color={music.repeat !== 'off' ? t.accent : t.subtle} onPress={music.toggleRepeat} size={22} />{music.repeat === 'one' ? <View pointerEvents="none" style={{ position: 'absolute', bottom: 4, right: 3, width: 14, height: 14, borderRadius: 7, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 9, fontWeight: '800', color: t.onAccent }}>1</Text></View> : null}</View>
    </View>
    {music.error ? <View style={{ gap: 6 }}><Notice text={music.error} error /><Pressable onPress={music.clearError} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}><Text style={{ color: t.accent, fontWeight: '600', fontSize: 13 }}>Понятно</Text></Pressable></View> : null}
    {music.notice ? <View style={{ gap: 5 }}><Notice text={music.notice} /><Pressable onPress={music.clearNotice} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}><Text style={{ color: t.accent, fontWeight: '600', fontSize: 13 }}>Закрыть сообщение</Text></Pressable></View> : null}
    <View style={{ gap: 9 }}>
      {track.source === 'soundcloud' ? <Button secondary icon="open-outline" label="Открыть в SoundCloud" disabled={!track.sourceUrl} onPress={() => { if (track.sourceUrl) void Linking.openURL(track.sourceUrl).catch(() => undefined); }} /> : <Button secondary icon={track.source === 'local' ? 'share-outline' : 'open-outline'} label={track.source === 'local' ? Platform.OS === 'web' ? 'Сохранить файл' : 'Поделиться файлом' : 'Скачать через Audius'} loading={downloading} disabled={track.source === 'audius' && !track.downloadable} onPress={() => void music.download(track)} />}
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingHorizontal: 5 }}>{track.source === 'local' ? 'Твой файл остаётся на устройстве и не отправляется на сервер.' : track.source === 'soundcloud' ? 'Трек и автор — на SoundCloud. Скачивание и офлайн для SoundCloud недоступны.' : track.downloadable ? 'Откроется скачивание в сервисе. Файл можно добавить в приложение через «Добавить файлы».' : 'Автор не открыл скачивание этого трека.'}</Text>
    </View>
    <GlassSurface radius={20} shadow={false} contentStyle={{ padding: 7 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={showQueue ? 'Свернуть очередь' : 'Показать очередь'} accessibilityState={{ expanded: showQueue }} onPress={() => setShowQueue(value => !value)} style={{ minHeight: 47, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 9, gap: 11 }}><Icon name="list-outline" size={20} color={t.accent} /><Text style={{ flex: 1, color: t.text, fontSize: 14, fontWeight: '600' }}>Очередь · {music.queue.length}</Text><Icon name={showQueue ? 'chevron-up' : 'chevron-down'} size={16} color={t.muted} /></Pressable>
      {showQueue ? music.queue.map(item => <Pressable key={item.id} onPress={() => void music.play(item, music.queue)} accessibilityRole="button" accessibilityLabel={`Включить: ${item.title}, ${item.artist}`} accessibilityState={{ selected: item.id === track.id }} style={({ pressed }) => ({ minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 9, paddingVertical: 8, gap: 10, borderRadius: 14, backgroundColor: pressed || item.id === track.id ? t.accentSoft : 'transparent' })}><TrackArtwork track={item} size={36} /><View style={{ flex: 1, gap: 3 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{item.title}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 11 }}>{item.artist}</Text></View>{item.id === track.id ? <Icon name={music.playing ? 'volume-medium-outline' : 'pause-outline'} size={17} color={t.accent} /> : null}</Pressable>) : null}
    </GlassSurface>
  </View>;
}

/**
 * Full-screen player laid out like VK Музыка: cover across the width, title with «в любимое»
 * and «ещё», a row of action chips, thin seek bar, controls, and «Очередь · N | Текст» at the
 * bottom. The page itself never moves under the finger; only a swipe down that starts on the
 * top bar or the cover collapses it (the cover alone swipes left/right between tracks).
 */
export function FullPlayer({ visible, onClose, onSource }: { visible: boolean; onClose: () => void; onSource?: (url: string) => void }) {
  const music = useMusic(), t = useTheme(); const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets(); const [panel, setPanel] = useState<'queue' | 'lyrics' | null>(null); const [eqOpen, setEqOpen] = useState(false);
  useEffect(() => { if (visible) setPanel(null); }, [visible]);
  const close = () => onClose();
  // Collapse only on a clear, mostly vertical drag; no live movement of the page.
  // One gesture object per detector (a gesture cannot be attached twice).
  const collapseGesture = () => Gesture.Pan().activeOffsetY(30).failOffsetX([-20, 20])
    .onEnd(event => { if (event.translationY > 90 || event.velocityY > 900) runOnJS(close)(); });
  const collapseTop = collapseGesture(), collapseCover = collapseGesture();
  const track = music.current;
  if (!visible || !track) return null;
  const favorite = music.favorites.some(item => item.id === track.id), downloading = Object.prototype.hasOwnProperty.call(music.downloads, track.id);
  const repeatLabel = music.repeat === 'one' ? 'Повтор одного трека' : music.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен';
  const cover = Math.round(Math.min(width - 56, height * 0.44, 460));
  const tone: AmbientTone = t.black ? 'black' : t.dark ? 'dark' : 'light';
  const soft = t.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';
  const chip = (icon: React.ComponentProps<typeof Icon>['name'], label: string | null, onPress: () => void, disabled = false, loading = false) => <Pressable key={icon + (label || '')} accessibilityRole="button" accessibilityLabel={label || icon} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 7, height: 40, paddingHorizontal: label ? 14 : 0, width: label ? undefined : 48, justifyContent: 'center', borderRadius: 12, backgroundColor: soft, opacity: disabled ? .4 : pressed ? .6 : 1 })}>
    {loading ? <ActivityIndicator size="small" color={t.text} /> : <Icon name={icon} size={19} color={t.text} />}{label ? <Text style={{ color: t.text, fontSize: 15, fontWeight: '500' }}>{label}</Text> : null}
  </Pressable>;
  return <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={{ flex: 1, overflow: 'hidden', backgroundColor: t.bg }}>
        {/* Like VK: the page takes the colour of the cover (blurred), otherwise the cold ambient. */}
        {track.artworkUrl ? <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <BlurImage source={{ uri: track.artworkUrl }} blurRadius={70} contentFit="cover" style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.3 }] }]} transition={250} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.4)' }]} />
        </View> : <MusicAmbient width={width} height={height} tone={tone} />}
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <GestureDetector gesture={collapseTop}>
            <View style={{ flexDirection: 'row', alignItems: 'center', height: 52, paddingHorizontal: 8 }}>
              <IconButton name="chevron-down" label="Свернуть плеер" onPress={onClose} color={t.text} size={26} />
              <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 16, fontWeight: '500' }} numberOfLines={1}>{track.source === 'local' ? 'Мои файлы' : 'Сейчас играет'}</Text>
              {track.sourceUrl && onSource ? <IconButton name="arrow-redo-outline" label="Открыть страницу трека" onPress={() => onSource(track.sourceUrl!)} color={t.text} size={23} /> : <View style={{ width: 44 }} />}
            </View>
          </GestureDetector>
          <GestureDetector gesture={collapseCover}>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><SwipeArtwork track={track} size={cover} /></View>
          </GestureDetector>
          <View style={{ paddingHorizontal: 16, gap: 18, paddingBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ flex: 1, gap: 4 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 22, fontWeight: '700', letterSpacing: -.3 }}>{track.title}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 15 }}>{track.artist}</Text></View>
              <Pressable accessibilityRole="button" accessibilityLabel={favorite ? 'Убрать из любимого' : 'В любимое'} onPress={() => void music.toggleFavorite(track)} style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, backgroundColor: favorite ? t.text : soft, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .7 : 1 })}><Icon name={favorite ? 'checkmark' : 'add'} size={24} color={favorite ? t.bg : t.text} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Ещё" onPress={() => setPanel('queue')} style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, backgroundColor: soft, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .7 : 1 })}><Icon name="ellipsis-horizontal" size={22} color={t.text} /></Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }} style={{ flexGrow: 0, marginHorizontal: -16 }}>
              {track.source === 'soundcloud' ? null : chip(track.source === 'local' ? 'share-outline' : 'download-outline', null, () => void music.download(track), track.source === 'audius' && !track.downloadable, downloading)}
              {chip(favorite ? 'heart' : 'heart-outline', favorite ? 'В любимом' : 'В любимое', () => void music.toggleFavorite(track))}
              {chip('shuffle', music.shuffle ? 'Перемешано' : 'Перемешать', music.toggleShuffle)}
              {chip('options-outline', 'Эквалайзер', () => setEqOpen(true))}
            </ScrollView>
            <SeekBar />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6 }}>
              <IconButton name="shuffle" label={music.shuffle ? 'Случайный порядок включён' : 'Включить случайный порядок'} color={music.shuffle ? t.accent : t.muted} onPress={music.toggleShuffle} size={26} />
              <IconButton name="play-skip-back" label="Предыдущий трек или начало текущего" onPress={() => void music.previous()} size={36} color={t.text} />
              <PlaybackButton large />
              <IconButton name="play-skip-forward" label="Следующий трек" onPress={() => void music.next()} size={36} color={t.text} disabled={music.queue.length < 2} />
              <IconButton name="repeat" label={`${repeatLabel}. Изменить`} color={music.repeat !== 'off' ? t.accent : t.muted} onPress={music.toggleRepeat} size={26} />
            </View>
            {music.error ? <Pressable onPress={music.clearError}><Notice text={music.error} error /></Pressable> : music.notice ? <Pressable onPress={music.clearNotice}><Notice text={music.notice} /></Pressable> : null}
          </View>
          {/* VK: «Очередь · N | Текст» on a raised panel at the bottom. */}
          <View style={{ flexDirection: 'row', height: 64 + insets.bottom, paddingBottom: insets.bottom, borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: t.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)' }}>
            <Pressable accessibilityRole="button" onPress={() => setPanel('queue')} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Очередь</Text><View style={{ minWidth: 22, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: soft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.muted, fontSize: 12 }}>{music.queue.length}</Text></View></Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPanel('lyrics')} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Текст</Text></Pressable>
          </View>
        </View>
        {panel ? <View style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end' }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPanel(null)} accessibilityLabel="Закрыть"><View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} /></Pressable>
          <View style={{ maxHeight: height * 0.66, backgroundColor: t.dark ? '#141A26' : '#F4F7FC', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, paddingBottom: insets.bottom + 8 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.subtle, alignSelf: 'center', marginBottom: 8 }} />
            <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 6 }}>{(['queue', 'lyrics'] as const).map(item => <Pressable key={item} onPress={() => setPanel(item)} style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: panel === item ? t.text : 'transparent' }}><Text style={{ color: panel === item ? t.text : t.muted, fontSize: 15, fontWeight: '600' }}>{item === 'queue' ? `Очередь · ${music.queue.length}` : 'Текст'}</Text></Pressable>)}</View>
            {panel === 'queue' ? <ScrollView contentContainerStyle={{ paddingHorizontal: 10 }}>{music.queue.map(item => <Pressable key={item.id} onPress={() => void music.play(item, music.queue)} accessibilityRole="button" accessibilityLabel={`Включить: ${item.title}, ${item.artist}`} accessibilityState={{ selected: item.id === track.id }} style={({ pressed }) => ({ minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 11, borderRadius: 12, backgroundColor: pressed || item.id === track.id ? t.accentSoft : 'transparent' })}><TrackArtwork track={item} size={44} /><View style={{ flex: 1, gap: 2 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{item.title}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>{item.artist}</Text></View>{item.id === track.id ? <Icon name={music.playing ? 'volume-medium-outline' : 'pause-outline'} size={17} color={t.accent} /> : null}</Pressable>)}</ScrollView>
              : <View style={{ padding: 24, alignItems: 'center', gap: 8 }}><Icon name="document-text-outline" size={34} color={t.subtle} /><Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Текста пока нет</Text><Text style={{ color: t.muted, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>Каталог Audius не передаёт тексты песен, поэтому показать текст этого трека нельзя.</Text></View>}
          </View>
        </View> : null}
      </View>
      <EqualizerScreen visible={eqOpen} onClose={() => setEqOpen(false)} />
    </GestureHandlerRootView>
  </Modal>;
}

// One full player for the whole app: any mini player opens it, it shows above the tabs.
let fullOpen = false; const fullListeners = new Set<() => void>();
export function openFullPlayer() { fullOpen = true; fullListeners.forEach(listener => listener()); }
function closeFullPlayer() { fullOpen = false; fullListeners.forEach(listener => listener()); }
export function FullPlayerHost({ onSource }: { onSource?: (url: string) => void }) {
  const [, force] = useState(0);
  useEffect(() => { const listener = () => force(value => value + 1); fullListeners.add(listener); return () => { fullListeners.delete(listener); }; }, []);
  return <FullPlayer visible={fullOpen} onClose={closeFullPlayer} onSource={onSource} />;
}
