import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, PanResponder, Platform, Pressable, StyleSheet, View, type GestureResponderEvent, useWindowDimensions } from 'react-native';
import { Text } from '../typography';
import { LinearGradient } from 'expo-linear-gradient';
import { Button, Icon, IconButton, Notice } from '../components';
import { GlassSurface } from '../glass';
import { useTheme } from '../theme';
import { useMusic } from './MusicProvider';
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

export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const music = useMusic(), t = useTheme();
  const swipe = useSwipeDown(music.stop);
  if (!music.current) return null;
  const progress = music.duration > 0 ? Math.min(1, music.position / music.duration) : 0;
  return <Animated.View {...swipe.handlers} style={swipe.style} accessibilityHint="Смахни вниз, чтобы остановить музыку и убрать плеер" accessibilityActions={[{ name: 'escape', label: 'Убрать плеер' }]} onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'escape') music.stop(); }}><GlassSurface radius={24} material="regular" style={{ marginHorizontal: 12, marginBottom: 8, maxWidth: 720, width: 'auto', alignSelf: 'stretch' }} contentStyle={{ padding: 9, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 9, overflow: 'hidden', borderRadius: 24 }}>
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Открыть плеер: ${music.current.title}, ${music.current.artist}`} style={{ flex: 1, minHeight: 48, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11 }}>
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
export function TopPlayerBar({ onOpen }: { onOpen: () => void }) {
  const music = useMusic(), t = useTheme();
  if (!music.current) return null;
  const progress = music.duration > 0 ? Math.min(1, music.position / music.duration) : 0;
  return <GlassSurface radius={18} material="regular" shadow={false} style={{ marginHorizontal: 12 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, paddingLeft: 4, paddingRight: 2 }}>
    <IconButton name={music.playing ? 'pause' : 'play'} label={music.playing ? 'Пауза' : 'Слушать'} onPress={() => void music.togglePlayback()} size={18} color={t.accent} style={{ width: 36, height: 40 }} />
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Открыть плеер: ${music.current.title}, ${music.current.artist}`} style={{ flex: 1, minWidth: 0, paddingHorizontal: 4 }}>
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

export function PlayerControls({ compact = false, onOpen }: { compact?: boolean; onOpen?: () => void } = {}) {
  const music = useMusic(), t = useTheme(); const [showQueue, setShowQueue] = useState(false); const { width } = useWindowDimensions();
  if (compact && onOpen) return <MiniPlayer onOpen={onOpen} />;
  const track = music.current;
  if (!track) return <View style={{ alignItems: 'center', gap: 15, paddingVertical: 30 }}><Icon name="musical-notes-outline" color={t.accent} size={42} /><Text style={{ color: t.text, fontSize: 19, fontWeight: '600' }}>Выбери музыку для своего дня</Text><Text style={{ color: t.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' }}>Найди трек или добавь аудиофайлы с устройства.</Text></View>;
  const favorite = music.favorites.some(item => item.id === track.id), downloading = Object.prototype.hasOwnProperty.call(music.downloads, track.id);
  const repeatLabel = music.repeat === 'one' ? 'Повтор одного трека' : music.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен';
  return <View style={{ gap: 21, paddingBottom: 5 }}>
    <View style={{ alignItems: 'center', paddingVertical: 4 }}><View style={{ borderRadius: 34, shadowColor: '#000', shadowOpacity: .35, shadowRadius: 22, shadowOffset: { width: 0, height: 12 } }}><TrackArtwork track={track} size={Math.min(353, width - 48)} /></View></View>
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
      <Button secondary icon={track.source === 'local' ? 'share-outline' : 'open-outline'} label={track.source === 'local' ? Platform.OS === 'web' ? 'Сохранить файл' : 'Поделиться файлом' : 'Скачать через Audius'} loading={downloading} disabled={track.source === 'audius' && !track.downloadable} onPress={() => void music.download(track)} />
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingHorizontal: 5 }}>{track.source === 'local' ? 'Твой файл остаётся на устройстве и не отправляется на сервер.' : track.downloadable ? 'Откроется скачивание в сервисе. Файл можно добавить в приложение через «Добавить файлы».' : 'Автор не открыл скачивание этого трека.'}</Text>
    </View>
    <GlassSurface radius={20} shadow={false} contentStyle={{ padding: 7 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={showQueue ? 'Свернуть очередь' : 'Показать очередь'} accessibilityState={{ expanded: showQueue }} onPress={() => setShowQueue(value => !value)} style={{ minHeight: 47, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 9, gap: 11 }}><Icon name="list-outline" size={20} color={t.accent} /><Text style={{ flex: 1, color: t.text, fontSize: 14, fontWeight: '600' }}>Очередь · {music.queue.length}</Text><Icon name={showQueue ? 'chevron-up' : 'chevron-down'} size={16} color={t.muted} /></Pressable>
      {showQueue ? music.queue.map(item => <Pressable key={item.id} onPress={() => void music.play(item, music.queue)} accessibilityRole="button" accessibilityLabel={`Включить: ${item.title}, ${item.artist}`} accessibilityState={{ selected: item.id === track.id }} style={({ pressed }) => ({ minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 9, paddingVertical: 8, gap: 10, borderRadius: 14, backgroundColor: pressed || item.id === track.id ? t.accentSoft : 'transparent' })}><TrackArtwork track={item} size={36} /><View style={{ flex: 1, gap: 3 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{item.title}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 11 }}>{item.artist}</Text></View>{item.id === track.id ? <Icon name={music.playing ? 'volume-medium-outline' : 'pause-outline'} size={17} color={t.accent} /> : null}</Pressable>) : null}
    </GlassSurface>
  </View>;
}
