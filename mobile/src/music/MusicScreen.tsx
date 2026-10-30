import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Linking, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { MusicAmbient } from './MusicAmbient';
import { Text, TextInput } from '../typography';
import { LinearGradient } from 'expo-linear-gradient';
import { Button, Empty, Icon, IconButton, Notice, Sheet, SheetAction, type IconName } from '../components';
import { GlassSurface } from '../glass';
import { useTheme } from '../theme';
import { MUSIC_MOODS, searchMusic } from './api';
import { useMusic } from './MusicProvider';
import { MiniPlayer, PlayerControls } from './PlayerControls';
import type { MusicTrack } from './types';

type Section = 'catalog' | 'favorites' | 'saved';
const sections: { id: Section; label: string }[] = [
  { id: 'catalog', label: 'Главная' },
  { id: 'favorites', label: 'Любимое' },
  { id: 'saved', label: 'Мои файлы' },
];

const CATALOG_TTL = 10 * 60 * 1000;
const catalogCache = new Map<string, { at: number; tracks: MusicTrack[]; nextOffset: number | null }>();

export function MusicScreen({ onBack }: { onBack: () => void }) {
  const screen = useWindowDimensions();
  const t = useTheme();
  const music = useMusic();
  const [section, setSection] = useState<Section>('catalog');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [mood, setMood] = useState<string | undefined>();
  const [downloadableOnly, setDownloadableOnly] = useState(true);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [infoOpen, setInfoOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [actionTrack, setActionTrack] = useState<MusicTrack | null>(null);
  const generation = useRef(0);
  const paginationBusy = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 450);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    const request = ++generation.current;
    paginationBusy.current = false;
    setLoadingMore(false);
    if (section !== 'catalog') { setLoading(false); return; }
    // Switching moods is instant for anything seen in the last minutes; otherwise the old
    // list stays on screen until the new one arrives (no empty «Ищем музыку…» flash).
    const cacheKey = `${query}|${mood}|${downloadableOnly}`;
    const cached = catalogCache.get(cacheKey);
    setError('');
    if (cached && Date.now() - cached.at < CATALOG_TTL) { setTracks(cached.tracks); setNextOffset(cached.nextOffset); setLoading(false); return () => { generation.current++; }; }
    setLoading(true);
    searchMusic({ query, mood, downloadableOnly, limit: 24, offset: 0 })
      .then(result => {
        if (generation.current !== request) return;
        catalogCache.set(cacheKey, { at: Date.now(), tracks: result.tracks, nextOffset: result.nextOffset });
        setTracks(result.tracks); setNextOffset(result.nextOffset);
      })
      .catch(reason => {
        if (generation.current === request) setError(reason instanceof Error ? reason.message : 'Не удалось найти музыку.');
      })
      .finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current++; };
  }, [section, query, mood, downloadableOnly, revision]);

  const more = async () => {
    if (nextOffset === null || loading || paginationBusy.current) return;
    paginationBusy.current = true; setLoadingMore(true); setError('');
    const request = generation.current;
    try {
      const result = await searchMusic({ query, mood, downloadableOnly, limit: 24, offset: nextOffset });
      if (generation.current !== request) return;
      setTracks(previous => {
        const known = new Set(previous.map(track => track.id));
        return [...previous, ...result.tracks.filter(track => !known.has(track.id))];
      });
      setNextOffset(result.nextOffset);
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить следующие треки.');
    } finally {
      if (generation.current === request) { paginationBusy.current = false; setLoadingMore(false); }
    }
  };

  const rows = useMemo(() => {
    if (section === 'catalog') return tracks;
    const source = section === 'favorites' ? music.favorites : music.saved;
    const needle = query.toLocaleLowerCase();
    return needle ? source.filter(track => `${track.title} ${track.artist}`.toLocaleLowerCase().includes(needle)) : source;
  }, [section, tracks, music.favorites, music.saved, query]);

  const openLink = (url: string) => {
    void Linking.openURL(url).catch(() => {
      if (Platform.OS === 'web') setError('Не удалось открыть ссылку. Проверь настройки браузера.');
      else Alert.alert('Ссылка не открылась', 'Попробуй ещё раз.');
    });
  };
  const begin = (track: MusicTrack) => { void music.play(track, rows); };
  const favoriteIds = new Set(music.favorites.map(track => track.id));
  const emptyTitle = section === 'saved' ? 'Свой звук' : section === 'favorites' ? 'Любимое будет здесь' : nextOffset !== null ? 'Посмотрим следующую страницу' : 'Попробуем другой запрос';
  const emptyDescription = section === 'saved'
    ? Platform.OS === 'web' ? 'Выбери аудиофайлы с устройства. В этой вкладке браузера они доступны до перезагрузки.' : 'Добавь аудиофайлы с устройства. Они останутся здесь и не загрузятся на сервер мессенджера.'
    : section === 'favorites' ? 'Нажми на сердечко рядом с понравившимся треком.'
    : nextOffset !== null ? 'На этой странице нет треков с выбранным доступом. Нажми «Показать ещё» или измени фильтры.'
    : 'Измени название или настроение. Каталог Audius отличается от других музыкальных сервисов.';
  const action = (fn: (track: MusicTrack) => void) => {
    if (actionTrack) fn(actionTrack);
    setActionTrack(null);
  };

  // Full-screen page instead of a modal sheet: on Android the modal + blur
  // combination hid the controls behind a translucent shadow box.
  if (playerOpen && music.current) return <View style={{ flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
    <MusicAmbient width={screen.width} height={screen.height} />
    <GlassSurface radius={27} style={{ margin: 12, marginBottom: 6 }} contentStyle={{ minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}>
      <IconButton name="chevron-down" label="Свернуть плеер" onPress={() => setPlayerOpen(false)} />
      <Text style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: '700' }}>Сейчас играет</Text>
    </GlassSurface>
    <ScrollView contentContainerStyle={{ padding: 18, paddingTop: 10, paddingBottom: 30, gap: 8 }}>
      <PlayerControls />
      {music.current.sourceUrl ? <SheetAction icon="open-outline" label="Страница автора и трека" description="Открыть в Audius" onPress={() => openLink(music.current!.sourceUrl!)} /> : null}
    </ScrollView>
  </View>;
  return <View style={{ flex: 1, width: '100%', maxWidth: 980, alignSelf: 'center' }}>

    <FlatList
      data={rows}
      keyExtractor={track => track.id}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 20, flexGrow: 1 }}
      ListHeaderComponent={<View style={{ gap: 16, paddingBottom: 12 }}>
        {/* VK-style top: animated cold-colour background, title, tabs and the mix button; scrolls away with the list. */}
        <View style={{ marginHorizontal: -18, height: section === 'catalog' && !query ? Math.min(430, screen.height * .5) : 132, paddingTop: 6 }}>
          <MusicAmbient width={screen.width} height={section === 'catalog' && !query ? Math.min(430, screen.height * .5) : 132} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 }}>
            <IconButton name="chevron-back" label="Вернуться к мессенджеру" onPress={onBack} color="#FFF" />
            <Text style={{ flex: 1, color: '#FFF', fontSize: 22, fontWeight: '700', letterSpacing: -.4 }}>Музыка</Text>
            <IconButton name="add" label="Добавить аудиофайлы" disabled={music.importing} onPress={() => void music.importFiles()} color="#FFF" />
            <IconButton name="information-outline" label="О музыкальном разделе" onPress={() => setInfoOpen(true)} color="#FFF" />
          </View>
          <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 14, marginTop: 6 }}>
            {sections.map(item => { const on = section === item.id; return <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setSection(item.id)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 12, backgroundColor: on ? '#FFFFFF' : 'transparent' }}>
              <Text style={{ color: on ? '#0A1529' : '#DCE6F7', fontSize: 16, fontWeight: on ? '700' : '600' }}>{item.label}</Text>
            </Pressable>; })}
          </View>
          {section === 'catalog' && !query ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 9, paddingBottom: 10 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Слушать микс" disabled={!rows.length} onPress={() => rows[0] && begin(rows[0])} style={({ pressed }) => ({ width: 80, height: 80, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? .96 : 1 }], opacity: rows.length ? 1 : .6 })}>
              <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}><View style={{ marginLeft: 3 }}><Icon name="play" size={26} color="#0A1529" /></View></View>
            </Pressable>
            <Text style={{ color: '#FFF', fontSize: 21, fontWeight: '700' }}>Слушать микс</Text>
            <Text style={{ color: '#D2DEF2', fontSize: 14 }}>{mood ? `Настроение: ${MUSIC_MOODS.find(item => item.apiMood === mood)?.label || ''}` : 'Новые имена и любимый звук'}</Text>
          </View> : null}
        </View>

        <GlassSurface radius={21} shadow={false} contentStyle={{ minHeight: 51, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}>
          <Icon name="search-outline" size={20} color={t.muted} />
          <TextInput accessibilityLabel="Поиск музыки" value={input} onChangeText={setInput} onSubmitEditing={() => setQuery(input.trim())} returnKeyType="search" autoCorrect={false} keyboardAppearance={t.dark ? 'dark' : 'light'} placeholder={section === 'saved' ? 'Поиск в моих файлах' : 'Трек или исполнитель'} placeholderTextColor={t.muted} selectionColor={t.accent} style={{ flex: 1, minWidth: 0, color: t.text, fontSize: 15, paddingVertical: 14 }} />
          {input ? <Pressable accessibilityRole="button" accessibilityLabel="Очистить поиск музыки" onPress={() => { setInput(''); setQuery(''); }} style={{ minHeight: 44, minWidth: 32, alignItems: 'center', justifyContent: 'center' }}><Icon name="close-circle" size={19} color={t.muted} /></Pressable> : null}
        </GlassSurface>

        {section === 'catalog' ? <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 2 }}>
            <MoodChip label="Любое" icon="sparkles-outline" selected={!mood} onPress={() => setMood(undefined)} />
            {MUSIC_MOODS.filter(item => item.apiMood).map(item => <MoodChip key={item.id} label={item.label} icon={item.icon as IconName} selected={mood === item.apiMood} onPress={() => setMood(mood === item.apiMood ? undefined : item.apiMood)} />)}
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <Text style={{ color: t.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 }}>{query ? 'РЕЗУЛЬТАТЫ' : 'ОТКРОЙ ДЛЯ СЕБЯ'}</Text>
            <Pressable accessibilityRole="switch" accessibilityLabel="Только треки с разрешённым скачиванием" accessibilityState={{ checked: downloadableOnly }} onPress={() => setDownloadableOnly(value => !value)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon name={downloadableOnly ? 'checkmark-circle' : 'ellipse-outline'} color={downloadableOnly ? t.accent : t.muted} size={19} />
              <Text style={{ color: downloadableOnly ? t.accent : t.muted, fontSize: 12, fontWeight: '600' }}>Можно скачать</Text>
            </Pressable>
          </View>
        </> : <View style={{ gap: 8 }}>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{section === 'saved' ? Platform.OS === 'web' ? 'В браузере добавленные файлы доступны до перезагрузки. На Android и iPhone они сохраняются в приложении для офлайн-прослушивания.' : 'Твои файлы на этом устройстве. Добавляй аудио через «+» и слушай без интернета.' : 'Треки, которые ты отметил сердцем. Для воспроизведения Audius нужен интернет.'}</Text>
        </View>}
        {music.error ? <Notice text={music.error} error /> : null}
        {music.notice ? <Notice text={music.notice} /> : null}
        {music.libraryLoading && section !== 'catalog' ? <ActivityIndicator color={t.accent} style={{ paddingVertical: 20 }} /> : null}
        {error && section === 'catalog' ? <Notice text={error} error onRetry={() => setRevision(value => value + 1)} /> : null}
        {loading && section === 'catalog' ? tracks.length ? <ActivityIndicator size="small" color={t.accent} style={{ paddingVertical: 6 }} /> : <View style={{ paddingVertical: 28, alignItems: 'center', gap: 11 }}><ActivityIndicator color={t.accent} /><Text style={{ color: t.muted, fontSize: 12 }}>Ищем музыку…</Text></View> : null}
      </View>}
      renderItem={({ item }) => <TrackRow track={item} active={music.current?.id === item.id} playing={music.current?.id === item.id && music.playing} favorite={favoriteIds.has(item.id)} onPlay={() => music.current?.id === item.id ? music.togglePlayback() : begin(item)} onFavorite={() => music.toggleFavorite(item)} onMore={() => setActionTrack(item)} />}
      ListEmptyComponent={(section === 'catalog' ? !loading && !error : !music.libraryLoading) ? <Empty icon={section === 'saved' ? 'folder-open-outline' : section === 'favorites' ? 'heart-outline' : 'musical-notes-outline'} title={emptyTitle} description={emptyDescription} action={section === 'saved' ? <Button label="Добавить файлы" icon="add" loading={music.importing} onPress={() => void music.importFiles()} /> : undefined} /> : null}
      ListFooterComponent={<View style={{ gap: 15, paddingTop: 12 }}>
        {section === 'catalog' && nextOffset !== null && !loading ? <Button secondary label="Показать ещё" loading={loadingMore} onPress={() => void more()} /> : null}
        {section === 'catalog' && rows.length > 0 ? <Text style={{ color: t.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', paddingHorizontal: 12 }}>Музыка предоставлена авторами через Audius.{ '\n' }Скачивание — через сервис, когда автор его разрешил.</Text> : null}
      </View>}
    />

    {music.current ? <MiniPlayer onOpen={() => setPlayerOpen(true)} /> : null}


    <Sheet visible={!!actionTrack} title={actionTrack?.title || 'Трек'} onClose={() => setActionTrack(null)}>
      {actionTrack ? <>
        <Text style={{ color: t.muted, fontSize: 13, marginBottom: 8 }}>{actionTrack.artist}</Text>
        <SheetAction icon="play" label="Слушать" onPress={() => action(begin)} />
        <SheetAction icon={favoriteIds.has(actionTrack.id) ? 'heart-dislike-outline' : 'heart-outline'} label={favoriteIds.has(actionTrack.id) ? 'Убрать из любимого' : 'В любимое'} onPress={() => action(track => music.toggleFavorite(track))} />
        {actionTrack.source === 'audius' && actionTrack.downloadable ? <SheetAction icon="download-outline" label="Скачать через Audius" description="Откроется официальная загрузка трека" onPress={() => action(track => { void music.download(track); })} /> : null}
        {actionTrack.sourceUrl ? <SheetAction icon="open-outline" label="Открыть источник" description="Автор, трек и условия использования" onPress={() => action(track => openLink(track.sourceUrl!))} /> : null}
        {actionTrack.source === 'local' ? <>
          <SheetAction icon="share-outline" label="Поделиться файлом" onPress={() => action(track => { void music.exportSaved(track); })} />
          <SheetAction icon="trash-outline" label="Убрать из приложения" description="Исходный файл на устройстве сохранится" danger onPress={() => action(track => { void music.removeSaved(track.id); })} />
        </> : null}
      </> : null}
    </Sheet>

    <Sheet visible={infoOpen} title="О музыке" onClose={() => setInfoOpen(false)}>
      <View style={{ gap: 13 }}>
        <Text style={{ color: t.text, fontSize: 14, lineHeight: 22 }}>Здесь доступны публичные треки Audius, которые авторы открыли для сторонних плееров. Инвиз не добавляет рекламу. Доступность и качество записи определяет источник; это не полный каталог Яндекс Музыки или SoundCloud.</Text>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Кнопка скачивания открывает официальный адрес Audius и появляется только при разрешении автора. Потоки не сохраняются в постоянный кэш приложения. Для личного офлайн-прослушивания можно добавить свои аудиофайлы через «+».</Text>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>При поиске и прослушивании Audius получает запросы и сетевые данные соединения. Токен мессенджера туда не отправляется. Импортированные файлы остаются на устройстве.</Text>
        <Text style={{ color: t.muted, fontSize: 11, lineHeight: 17 }}>Музыка принадлежит указанным авторам. Учитывай лицензию конкретного трека; для материалов Audius может применяться Open Music License или отдельная лицензия автора.</Text>
      </View>
      <SheetAction icon="document-text-outline" label="Условия Audius API" onPress={() => openLink('https://audius.co/documents/ApiTerms.pdf')} />
      <SheetAction icon="shield-checkmark-outline" label="Конфиденциальность Audius" onPress={() => openLink('https://audius.co/documents/PrivacyPolicy.pdf')} />
      <SheetAction icon="musical-note-outline" label="Open Music License" onPress={() => openLink('https://audius.org/open-music-license.pdf')} />
    </Sheet>
  </View>;
}

function MoodChip({ label, icon, selected, onPress }: { label: string; icon: IconName; selected: boolean; onPress: () => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={{ minHeight: 62, minWidth: 100, paddingHorizontal: 16, paddingVertical: 11, gap: 5, justifyContent: 'center', borderRadius: 21, borderWidth: 1, borderColor: selected ? t.accent : t.glassBorder, backgroundColor: selected ? t.accentSoft : t.glassClear }}>
    <Icon name={icon} size={18} color={selected ? t.accent : t.muted} />
    <Text style={{ color: selected ? t.accent : t.text, fontSize: 11, fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}

function TrackArtwork({ track }: { track: MusicTrack }) {
  const t = useTheme(); const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [track.artworkUrl]);
  return <View style={{ width: 53, height: 53, borderRadius: 17, overflow: 'hidden', borderWidth: 1, borderColor: t.glassBorder }}>
    {track.artworkUrl && !failed ? <Image source={{ uri: track.artworkUrl }} style={{ width: '100%', height: '100%' }} onError={() => setFailed(true)} accessibilityLabel={`Обложка ${track.title}`} /> : <LinearGradient colors={t.accentGradient} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Icon name="musical-note" color={t.onAccent} size={25} /></LinearGradient>}
  </View>;
}

function TrackRow({ track, active, playing, favorite, onPlay, onFavorite, onMore }: { track: MusicTrack; active: boolean; playing: boolean; favorite: boolean; onPlay: () => void; onFavorite: () => void; onMore: () => void }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 9, paddingHorizontal: 7, marginBottom: 4, borderRadius: 22, backgroundColor: active ? t.accentSoft : 'transparent', borderWidth: 1, borderColor: active ? t.glassBorder : 'transparent' }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${playing ? 'Пауза' : 'Слушать'}: ${track.title}, ${track.artist}`} onPress={onPlay} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 55 }}>
      <View><TrackArtwork track={track} />{active ? <View style={{ position: 'absolute', bottom: -2, right: -2, width: 23, height: 23, borderRadius: 12, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.bg }}><Icon name={playing ? 'pause' : 'play'} size={11} color={t.onAccent} /></View> : null}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <Text numberOfLines={1} style={{ color: active ? t.accent : t.text, fontSize: 14, fontWeight: '700' }}>{track.title}</Text>
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>{track.artist}</Text>
        <Text style={{ color: t.subtle, fontSize: 9, fontWeight: '600', letterSpacing: .2 }}>{track.source === 'local' ? 'НА УСТРОЙСТВЕ' : 'AUDIUS'}{track.duration > 0 ? ` · ${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, '0')}` : ''}</Text>
      </View>
    </Pressable>
    <IconButton name={favorite ? 'heart' : 'heart-outline'} label={favorite ? `Убрать из любимого: ${track.title}` : `В любимое: ${track.title}`} color={favorite ? t.accent : t.muted} size={19} onPress={onFavorite} />
    <IconButton name="ellipsis-horizontal" label={`Действия: ${track.title}`} color={t.muted} size={19} onPress={onMore} />
  </View>;
}
