import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { reattachEqualizer, useEqualizerOn } from './equalizer';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Directory, File as NativeFile, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { resolveStream, resolveDownload, getMusicTrack } from './api';
import type { MusicTrack } from './types';

export type RepeatMode = 'off' | 'one' | 'all';
export type MusicState = {
  current: MusicTrack | null;
  queue: MusicTrack[];
  playing: boolean;
  loading: boolean;
  position: number;
  duration: number;
  error: string;
  notice: string;
  favorites: MusicTrack[];
  saved: MusicTrack[];
  downloads: Record<string, number>;
  repeat: RepeatMode;
  shuffle: boolean;
  libraryLoading: boolean;
  importing: boolean;
  play: (track: MusicTrack, queue?: MusicTrack[]) => Promise<void>;
  togglePlayback: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  toggleFavorite: (track: MusicTrack) => Promise<void>;
  download: (track: MusicTrack) => Promise<void>;
  importFiles: () => Promise<void>;
  removeSaved: (trackId: string) => Promise<void>;
  exportSaved: (track: MusicTrack) => Promise<void>;
  clearError: () => void;
  clearNotice: () => void;
  stop: () => void;
};

const MusicContext = createContext<MusicState | null>(null);
export function useMusic() {
  const value = useContext(MusicContext);
  if (!value) throw new Error('useMusic must be used inside MusicProvider');
  return value;
}

type Playback = { playing: boolean; loaded: boolean; buffering: boolean; position: number; duration: number; finished: boolean; error: string | null };
type Engine = {
  prepare: () => Promise<void>;
  replace: (uri: string | null) => void;
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => Promise<void>;
  loop: (enabled: boolean) => void;
  metadata: (track: MusicTrack | null) => void;
};
const EMPTY_PLAYBACK: Playback = { playing: false, loaded: false, buffering: false, position: 0, duration: 0, finished: false, error: null };
const LIBRARY_KEY = 'linea.music.device-library.v1';
const MAX_FILE_SIZE = 250 * 1024 * 1024;
const MAX_TRACKS = 500;
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'caf', 'webm', 'mp4']);
const MIME_EXTENSIONS: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff' };
const EXTENSION_MIMES: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff', caf: 'audio/x-caf' };
// Serializing disk metadata across provider remounts prevents an old account's pending
// write from overwriting the newly mounted provider's device library.
let libraryIO: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = libraryIO.catch(() => undefined).then(work);
  libraryIO = result.then(() => undefined, () => undefined);
  return result;
}
function finite(value: number, fallback = 0) { return Number.isFinite(value) && value >= 0 ? value : fallback; }
function readable(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  if (error.name === 'NotAllowedError') return 'Браузер не разрешил запуск музыки. Нажми кнопку воспроизведения ещё раз.';
  return error.message.length < 280 && /[а-яё]/i.test(error.message) ? error.message : fallback;
}
function remoteUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Источник музыки вернул неподходящий адрес.');
  return url.toString();
}
function safeName(value: string, fallback = 'track.mp3') {
  return value.replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '').trim().slice(0, 150) || fallback;
}
function extension(name?: string, mime?: string) {
  const fromName = name?.split('.').pop()?.toLowerCase();
  return (fromName && AUDIO_EXTENSIONS.has(fromName) ? fromName : undefined) || MIME_EXTENSIONS[mime?.split(';')[0].toLowerCase() || ''];
}
function directory() { return new Directory(Paths.document, 'linea-music'); }
function ownedFile(name: string) {
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/i.test(name)) throw new Error('Не удалось открыть сохранённый файл.');
  return new NativeFile(directory(), name);
}
function cleanTrack(value: unknown): MusicTrack | null {
  if (!value || typeof value !== 'object') return null;
  const x = value as Partial<MusicTrack>;
  if (typeof x.id !== 'string' || !x.id || x.id.length > 180 || (x.source !== 'audius' && x.source !== 'local') || typeof x.title !== 'string' || typeof x.artist !== 'string') return null;
  const url = (input: unknown) => { try { return typeof input === 'string' ? remoteUrl(input) : undefined; } catch { return undefined; } };
  return {
    id: x.id, source: x.source, sourceId: typeof x.sourceId === 'string' ? x.sourceId.slice(0, 120) : undefined,
    title: x.title.slice(0, 300), artist: x.artist.slice(0, 250), artworkUrl: url(x.artworkUrl) || null,
    duration: finite(Number(x.duration)), genre: typeof x.genre === 'string' ? x.genre.slice(0, 100) : undefined,
    mood: typeof x.mood === 'string' ? x.mood.slice(0, 100) : undefined, sourceUrl: url(x.sourceUrl), downloadable: x.downloadable === true,
    fileName: typeof x.fileName === 'string' ? safeName(x.fileName) : undefined, mimeType: typeof x.mimeType === 'string' ? x.mimeType.slice(0, 100) : undefined,
    fileSize: typeof x.fileSize === 'number' ? finite(x.fileSize) : undefined, savedAt: typeof x.savedAt === 'string' ? x.savedAt : undefined,
  };
}
function unique(tracks: MusicTrack[]) { return [...new Map(tracks.map(track => [track.id, track])).values()].slice(0, MAX_TRACKS); }

export function MusicProvider({ children }: { children: React.ReactNode }) {
  return Platform.OS === 'web' ? <WebMusicProvider>{children}</WebMusicProvider> : <NativeMusicProvider>{children}</NativeMusicProvider>;
}

function NativeMusicProvider({ children }: { children: React.ReactNode }) {
  const player = useAudioPlayer(null, { updateInterval: 400, downloadFirst: false });
  const status = useAudioPlayerStatus(player);
  useEqualizerOn(player);
  const engine = useMemo<Engine>(() => {
    let configuration: Promise<void> | null = null;
    return {
      prepare: () => configuration ||= setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix', allowsRecording: false }).catch(error => { configuration = null; throw error; }),
      replace: uri => { player.replace(uri); reattachEqualizer(player); },
      play: async () => { player.play(); }, pause: () => player.pause(), seek: seconds => player.seekTo(seconds), loop: enabled => { player.loop = enabled; },
      metadata: track => track ? player.setActiveForLockScreen(true, { title: track.title, artist: track.artist, ...(track.artworkUrl ? { artworkUrl: track.artworkUrl } : {}) }) : player.clearLockScreenControls(),
    };
  }, [player]);
  useEffect(() => () => { try { player.pause(); player.clearLockScreenControls(); } catch { /* Hook disposal may already have released the native player. */ } }, [player]);
  const playback: Playback = { playing: status.playing, loaded: status.isLoaded, buffering: status.isBuffering, position: finite(status.currentTime), duration: finite(status.duration), finished: status.didJustFinish, error: status.error };
  return <MusicStateProvider engine={engine} playback={playback}>{children}</MusicStateProvider>;
}

// HTMLAudioElement.play() returns a Promise. Keeping it here lets the web preview
// report autoplay restrictions instead of exposing an unhandled promise rejection.
function WebMusicProvider({ children }: { children: React.ReactNode }) {
  const [playback, setPlayback] = useState<Playback>(EMPTY_PLAYBACK);
  const media = useRef<HTMLAudioElement | null>(null);
  const cleanup = useRef<() => void>(() => undefined);
  const engine = useMemo<Engine>(() => {
    const controller: Engine = {
      prepare: async () => undefined,
      replace: uri => {
        cleanup.current();
        const old = media.current; media.current = null;
        if (old) { old.pause(); old.removeAttribute('src'); old.load(); }
        setPlayback(EMPTY_PLAYBACK);
        if (!uri) return;
        const audio = new Audio(); media.current = audio; audio.preload = 'metadata';
        const update = () => {
          if (media.current !== audio) return;
          setPlayback({ playing: !audio.paused && !audio.ended, loaded: audio.readyState >= 1, buffering: !audio.paused && audio.readyState < 3, position: finite(audio.currentTime), duration: finite(audio.duration), finished: audio.ended, error: audio.error ? 'Не удалось воспроизвести аудио. Проверь соединение или выбери другой файл.' : null });
          if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
            navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
            if (Number.isFinite(audio.duration) && audio.duration > 0) try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: 1, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* Optional browser API. */ }
          }
        };
        const events = ['loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'timeupdate', 'durationchange', 'waiting', 'stalled', 'ended', 'error', 'seeked'];
        events.forEach(event => audio.addEventListener(event, update));
        cleanup.current = () => events.forEach(event => audio.removeEventListener(event, update));
        audio.src = uri; audio.load();
      },
      play: async () => { if (media.current) await media.current.play(); },
      pause: () => media.current?.pause(),
      seek: async seconds => { if (media.current) media.current.currentTime = seconds; },
      loop: enabled => { if (media.current) media.current.loop = enabled; },
      metadata: track => {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
        const session = navigator.mediaSession;
        try {
          session.metadata = track && typeof MediaMetadata !== 'undefined' ? new MediaMetadata({ title: track.title, artist: track.artist, artwork: track.artworkUrl ? [{ src: track.artworkUrl }] : [] }) : null;
          if (!track) session.playbackState = 'none';
          session.setActionHandler('play', track ? () => { void controller.play().catch(() => setPlayback(value => ({ ...value, error: 'Нажми воспроизведение в приложении, чтобы продолжить.' }))); } : null);
          session.setActionHandler('pause', track ? () => controller.pause() : null);
          session.setActionHandler('seekto', track ? event => { if (typeof event.seekTime === 'number') void controller.seek(event.seekTime); } : null);
        } catch { /* Media Session support varies by browser. */ }
      },
    };
    return controller;
  }, []);
  useEffect(() => () => { cleanup.current(); if (media.current) { media.current.pause(); media.current.removeAttribute('src'); media.current.load(); media.current = null; } engine.metadata(null); }, [engine]);
  return <MusicStateProvider engine={engine} playback={playback}>{children}</MusicStateProvider>;
}

type Library = { saved: MusicTrack[]; favorites: MusicTrack[]; names: Record<string, string>; audiusIds: string[] };
function MusicStateProvider({ children, engine, playback }: { children: React.ReactNode; engine: Engine; playback: Playback }) {
  const [current, setCurrent] = useState<MusicTrack | null>(null);
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  const [favorites, setFavorites] = useState<MusicTrack[]>([]);
  const [saved, setSaved] = useState<MusicTrack[]>([]);
  const [downloads, setDownloads] = useState<Record<string, number>>({});
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [shuffle, setShuffle] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [notice, setNotice] = useState('');
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const life = useRef(0), active = useRef(false), playGeneration = useRef(0), sourceReady = useRef(false);
  const currentRef = useRef<MusicTrack | null>(null), queueRef = useRef<MusicTrack[]>([]), repeatRef = useRef<RepeatMode>('off'), shuffleRef = useRef(false);
  const library = useRef<Library>({ saved: [], favorites: [], names: {}, audiusIds: [] });
  const boot = useRef<Promise<void>>(Promise.resolve());
  const pendingDownloads = useRef(new Map<string, AbortController>());
  const objectUrls = useRef(new Set<string>());
  const importing = useRef(false), playbackRef = useRef(playback), history = useRef<string[]>([]);
  const shuffleVisited = useRef(new Set<string>());
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  playbackRef.current = playback;
  const valid = useCallback((epoch: number) => active.current && life.current === epoch, []);
  const publish = useCallback((value: Library) => { library.current = value; setSaved(value.saved); setFavorites(value.favorites); }, []);
  const cancelStartTimer = useCallback(() => { if (startTimer.current) clearTimeout(startTimer.current); startTimer.current = null; }, []);

  useEffect(() => {
    const epoch = ++life.current; active.current = true;
    boot.current = serialized(async () => {
      const raw = await AsyncStorage.getItem(LIBRARY_KEY);
      const parsed = raw ? JSON.parse(raw) as { version?: number; saved?: { track?: unknown; file?: unknown }[]; favorites?: unknown[]; audiusFavoriteIds?: unknown[] } : {};
      if (parsed.version && parsed.version !== 1) throw new Error('Не удалось прочитать музыкальную библиотеку.');
      const next: Library = { saved: [], favorites: [], names: {}, audiusIds: [...new Set((Array.isArray(parsed.audiusFavoriteIds) ? parsed.audiusFavoriteIds : []).filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)))].slice(0, MAX_TRACKS) };
      if (Platform.OS !== 'web') {
        const folder = directory(); folder.create({ intermediates: true, idempotent: true });
        for (const entry of Array.isArray(parsed.saved) ? parsed.saved.slice(0, MAX_TRACKS) : []) {
          const track = cleanTrack(entry.track);
          if (!track || track.source !== 'local' || typeof entry.file !== 'string') continue;
          try {
            const file = ownedFile(entry.file);
            if (!file.exists || file.size <= 0) continue;
            next.names[track.id] = entry.file;
            next.saved.push({ ...track, localUri: file.uri, fileSize: file.size });
          } catch { /* Stale or invalid file records are excluded from the library. */ }
        }
        for (const file of folder.list()) if (file instanceof NativeFile && /^[a-f0-9-]{36}\.partial$/i.test(file.name)) try { file.delete(); } catch { /* A later launch may clean an interrupted transfer. */ }
      }
      next.favorites = unique((Array.isArray(parsed.favorites) ? parsed.favorites : []).map(cleanTrack).filter((track): track is MusicTrack => !!track).flatMap(track => {
        const local = next.saved.find(item => item.id === track.id);
        return local ? [local] : [];
      }));
      if (valid(epoch)) publish(next);
    }).catch(error => { if (valid(epoch)) setOperationError(readable(error, 'Не удалось открыть музыку на этом устройстве.')); }).finally(() => { if (valid(epoch)) setLibraryLoading(false); });
    // Only provider IDs are persisted. Provider metadata is refreshed into memory.
    void boot.current.then(async () => {
      if (!valid(epoch)) return;
      const ids = [...library.current.audiusIds]; let failed = false;
      for (let index = 0; index < ids.length; index += 4) {
        if (!valid(epoch)) return;
        const results = await Promise.allSettled(ids.slice(index, index + 4).map(getMusicTrack));
        if (!valid(epoch)) return;
        failed ||= results.some(result => result.status === 'rejected');
        await serialized(async () => {
          if (!valid(epoch)) return;
          const currentLibrary = library.current;
          const restored = results.flatMap(result => result.status === 'fulfilled' && result.value.sourceId && currentLibrary.audiusIds.includes(result.value.sourceId) ? [result.value] : []);
          publish({ ...currentLibrary, favorites: unique([...currentLibrary.favorites, ...restored]) });
        });
      }
      if (failed && valid(epoch)) setNotice('Часть избранного Audius сейчас недоступна. Локальная музыка остаётся на устройстве.');
    });
    return () => {
      active.current = false; life.current++; playGeneration.current++; cancelStartTimer();
      pendingDownloads.current.forEach(controller => controller.abort()); pendingDownloads.current.clear();
      try { engine.pause(); engine.metadata(null); } catch { /* Native player may already be released. */ }
      objectUrls.current.forEach(uri => URL.revokeObjectURL(uri)); objectUrls.current.clear();
    };
  }, [cancelStartTimer, engine, publish, valid]);

  const commit = useCallback(async (change: (value: Library) => Library, epoch: number) => {
    await boot.current;
    return serialized(async () => {
      if (!valid(epoch)) return false;
      const next = change(library.current);
      const storedSaved = Platform.OS === 'web' ? [] : next.saved.filter(track => next.names[track.id]).map(track => ({ track: cleanTrack(track), file: next.names[track.id] }));
      const storedFavorites = Platform.OS === 'web' ? [] : next.favorites.filter(track => track.source === 'local').map(cleanTrack);
      await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify({ version: 1, saved: storedSaved, favorites: storedFavorites, audiusFavoriteIds: next.audiusIds }));
      if (valid(epoch)) publish(next);
      return true;
    });
  }, [publish, valid]);

  const stop = useCallback(() => {
    playGeneration.current++; sourceReady.current = false; cancelStartTimer(); currentRef.current = null; queueRef.current = []; history.current = []; shuffleVisited.current.clear();
    try { engine.pause(); engine.metadata(null); engine.replace(null); } catch { /* Stop remains safe during teardown. */ }
    setCurrent(null); setQueue([]); setResolving(false); setPlaybackError('');
  }, [cancelStartTimer, engine]);

  const play = useCallback(async (track: MusicTrack, items?: MusicTrack[]) => {
    const epoch = life.current, generation = ++playGeneration.current;
    cancelStartTimer(); setPlaybackError(''); setOperationError(''); setResolving(true); sourceReady.current = false;
    try { engine.pause(); engine.metadata(null); engine.replace(null); } catch { /* The next source will replace a failed one. */ }
    const prior = currentRef.current;
    const nextQueue = unique(items?.length ? items : queueRef.current.some(item => item.id === track.id) ? queueRef.current : [track]);
    if (!nextQueue.some(item => item.id === track.id)) nextQueue.unshift(track);
    if (nextQueue.length !== queueRef.current.length || nextQueue.some((item, index) => item.id !== queueRef.current[index]?.id)) { history.current = []; shuffleVisited.current.clear(); }
    if (prior && prior.id !== track.id) history.current = [...history.current.slice(-99), prior.id];
    shuffleVisited.current.add(track.id);
    currentRef.current = track; setCurrent(track);
    queueRef.current = nextQueue; setQueue(nextQueue);
    try {
      await boot.current;
      if (!valid(epoch) || generation !== playGeneration.current) return;
      await engine.prepare();
      let uri: string;
      const owned = library.current.saved.find(item => item.id === track.id);
      if (owned?.localUri) {
        if (Platform.OS !== 'web') {
          const file = ownedFile(library.current.names[track.id]);
          if (!file.exists) throw new Error('Файл больше не доступен на устройстве. Импортируй его ещё раз.');
          uri = file.uri;
        } else {
          if (!objectUrls.current.has(owned.localUri)) throw new Error('Этот файл был временным. Выбери его на устройстве ещё раз.');
          uri = owned.localUri;
        }
        track = owned;
      } else {
        if (track.source === 'local') throw new Error('Файл не найден. Импортируй его с устройства ещё раз.');
        uri = remoteUrl((await resolveStream(track)).uri);
      }
      if (!valid(epoch) || generation !== playGeneration.current) return;
      currentRef.current = track; setCurrent(track);
      engine.replace(uri); engine.loop(repeatRef.current === 'one'); engine.metadata(track); sourceReady.current = true;
      setResolving(false);
      startTimer.current = setTimeout(() => {
        if (valid(epoch) && generation === playGeneration.current && !playbackRef.current.loaded) {
          engine.pause(); sourceReady.current = false; setPlaybackError('Трек загружается слишком долго. Проверь соединение и попробуй ещё раз.');
        }
      }, 30000);
      await engine.play();
    } catch (error) {
      if (valid(epoch) && generation === playGeneration.current) {
        cancelStartTimer(); setResolving(false); if (!(error instanceof Error && error.name === 'NotAllowedError')) sourceReady.current = false; setPlaybackError(readable(error, 'Не удалось включить трек. Проверь соединение и попробуй ещё раз.'));
        try { engine.pause(); } catch { /* Player may have failed while loading. */ }
      }
    }
  }, [cancelStartTimer, engine, valid]);

  const togglePlayback = useCallback(async () => {
    if (!currentRef.current) return;
    if (!sourceReady.current) { await play(currentRef.current, queueRef.current); return; }
    const epoch = life.current, generation = playGeneration.current;
    setPlaybackError('');
    try {
      if (playbackRef.current.playing) { engine.pause(); return; }
      if (playbackRef.current.finished) await engine.seek(0);
      if (!valid(epoch) || generation !== playGeneration.current) return;
      engine.metadata(currentRef.current); await engine.play();
    } catch (error) { if (valid(epoch) && generation === playGeneration.current) setPlaybackError(readable(error, 'Не удалось продолжить воспроизведение.')); }
  }, [engine, play, valid]);

  const seek = useCallback(async (seconds: number) => {
    if (!sourceReady.current || !Number.isFinite(seconds)) return;
    const epoch = life.current, generation = playGeneration.current;
    try { await engine.seek(Math.min(Math.max(0, seconds), playbackRef.current.duration || currentRef.current?.duration || Math.max(0, seconds))); }
    catch { if (valid(epoch) && generation === playGeneration.current) setPlaybackError('Не удалось перемотать трек. Попробуй ещё раз.'); }
  }, [engine, valid]);

  const next = useCallback(async () => {
    const items = queueRef.current, selected = currentRef.current;
    if (!selected || !items.length) return;
    const index = items.findIndex(track => track.id === selected.id);
    let target: MusicTrack | undefined;
    if (shuffleRef.current && items.length > 1) {
      let alternatives = items.filter(track => !shuffleVisited.current.has(track.id));
      if (!alternatives.length && repeatRef.current === 'all') { shuffleVisited.current = new Set([selected.id]); alternatives = items.filter(track => track.id !== selected.id); }
      target = alternatives[Math.floor(Math.random() * alternatives.length)];
    } else target = items[index + 1] || (repeatRef.current === 'all' ? items[0] : undefined);
    if (target) await play(target, items);
    else { engine.pause(); if (active.current) setNotice('Очередь закончилась. Выбери следующий трек.'); }
  }, [engine, play]);
  const nextRef = useRef(next); nextRef.current = next;
  const previous = useCallback(async () => {
    if (!currentRef.current) return;
    if (playbackRef.current.position > 3) { await seek(0); return; }
    const items = queueRef.current, index = items.findIndex(track => track.id === currentRef.current?.id);
    const previousId = shuffleRef.current ? history.current.pop() : undefined;
    const target = (previousId ? items.find(track => track.id === previousId) : undefined) || items[index - 1] || (repeatRef.current === 'all' ? items[items.length - 1] : undefined);
    if (target) { await play(target, items); if (shuffleRef.current) history.current.pop(); }
    else await seek(0);
  }, [play, seek]);

  useEffect(() => { if (playback.loaded) cancelStartTimer(); }, [cancelStartTimer, playback.loaded]);
  useEffect(() => { if (playback.error && sourceReady.current) { cancelStartTimer(); sourceReady.current = false; setResolving(false); setPlaybackError(readable(new Error(playback.error), 'Не удалось воспроизвести трек. Попробуй другой источник.')); } }, [cancelStartTimer, playback.error]);
  useEffect(() => { if (playback.finished && sourceReady.current && repeatRef.current !== 'one') void nextRef.current(); }, [playback.finished]);

  const toggleRepeat = useCallback(() => { const value: RepeatMode = repeatRef.current === 'off' ? 'all' : repeatRef.current === 'all' ? 'one' : 'off'; repeatRef.current = value; setRepeat(value); engine.loop(value === 'one'); }, [engine]);
  const toggleShuffle = useCallback(() => { shuffleRef.current = !shuffleRef.current; setShuffle(shuffleRef.current); history.current = []; shuffleVisited.current = new Set(currentRef.current ? [currentRef.current.id] : []); }, []);

  const toggleFavorite = useCallback(async (track: MusicTrack) => {
    const epoch = life.current;
    try { await commit(value => {
      const present = value.favorites.some(item => item.id === track.id);
      const audiusIds = track.source === 'audius' && track.sourceId ? present ? value.audiusIds.filter(id => id !== track.sourceId) : [...new Set([track.sourceId, ...value.audiusIds])].slice(0, MAX_TRACKS) : value.audiusIds;
      return { ...value, audiusIds, favorites: present ? value.favorites.filter(item => item.id !== track.id) : unique([value.saved.find(item => item.id === track.id) || track, ...value.favorites]) };
    }, epoch); }
    catch { if (valid(epoch)) setOperationError('Не удалось сохранить избранное на этом устройстве.'); }
  }, [commit, valid]);

  const importFiles = useCallback(async () => {
    if (importing.current) return;
    importing.current = true; const epoch = life.current; setIsImporting(true);
    setOperationError(''); setNotice('');
    try {
      // The picker must open synchronously from a tap, before awaiting storage, on web.
      const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', multiple: true, copyToCacheDirectory: true, base64: false });
      if (result.canceled || !valid(epoch)) return;
      await boot.current;
      let imported = 0;
      for (const asset of result.assets) {
        if (!valid(epoch)) break;
        if (library.current.saved.length >= MAX_TRACKS) throw new Error('В библиотеке уже 500 файлов. Удали ненужные и попробуй снова.');
        const ext = extension(asset.name, asset.mimeType);
        if (!ext || (asset.mimeType && !asset.mimeType.startsWith('audio/') && asset.mimeType !== 'application/octet-stream')) throw new Error('Выбери аудиофайл: MP3, M4A, WAV, FLAC или другой поддерживаемый формат.');
        if ((asset.size || 0) > MAX_FILE_SIZE) throw new Error('Можно импортировать файлы размером до 250 МБ.');
        const id = `local:${randomUUID()}`, fileName = safeName(asset.name, `audio.${ext}`), storageName = `${randomUUID()}.${ext}`;
        let uri = '', completed: NativeFile | undefined, temp: NativeFile | undefined, committed = false;
        try {
          let size = asset.size;
          if (Platform.OS === 'web') {
            if (!asset.file) throw new Error('Браузер не передал аудиофайл. Выбери его ещё раз.');
            uri = URL.createObjectURL(asset.file); objectUrls.current.add(uri); size = asset.file.size;
          } else {
            const source = new NativeFile(asset.uri); size = source.size;
            if (size <= 0 || size > MAX_FILE_SIZE) throw new Error('Аудиофайл пустой или больше 250 МБ.');
            temp = new NativeFile(directory(), `${randomUUID()}.partial`); await source.copy(temp);
            if (!valid(epoch)) continue;
            completed = ownedFile(storageName); await temp.move(completed); temp = undefined; uri = completed.uri;
          }
          const track: MusicTrack = { id, source: 'local', title: fileName.replace(/\.[^.]+$/, ''), artist: 'На этом устройстве', artworkUrl: null, duration: 0, downloadable: true, localUri: uri, fileName, mimeType: asset.mimeType?.startsWith('audio/') ? asset.mimeType : EXTENSION_MIMES[ext], fileSize: size, savedAt: new Date().toISOString() };
          committed = await commit(value => ({ ...value, saved: [track, ...value.saved], names: { ...value.names, [id]: storageName } }), epoch);
          if (committed) imported++;
        } finally {
          if (temp?.exists) try { temp.delete(); } catch { /* Removable at next launch. */ }
          if (!committed) {
            if (completed?.exists) try { completed.delete(); } catch { /* Do not expose incomplete imports in the index. */ }
            if (uri && Platform.OS === 'web') { URL.revokeObjectURL(uri); objectUrls.current.delete(uri); }
          }
        }
      }
      if (valid(epoch) && imported) setNotice(Platform.OS === 'web' ? `Добавлено файлов: ${imported}. В браузере они доступны до перезагрузки страницы или выхода. На сервер файлы не отправляются.` : `Добавлено файлов: ${imported}. Музыка сохранена только на этом устройстве.`);
    } catch (error) { if (valid(epoch)) setOperationError(readable(error, 'Не удалось импортировать аудиофайл. Проверь свободное место и попробуй ещё раз.')); }
    finally { importing.current = false; if (valid(epoch)) setIsImporting(false); }
  }, [commit, valid]);

  const exportSaved = useCallback(async (track: MusicTrack) => {
    const epoch = life.current; setOperationError('');
    try {
      await boot.current;
      if (!valid(epoch)) return;
      const item = library.current.saved.find(value => value.id === track.id);
      if (!item?.localUri) throw new Error('Файл не сохранён на этом устройстве.');
      if (Platform.OS === 'web') {
        if (!objectUrls.current.has(item.localUri)) throw new Error('Временный файл больше недоступен. Импортируй его ещё раз.');
        const anchor = document.createElement('a'); anchor.href = item.localUri; anchor.download = safeName(item.fileName || `${item.title}.mp3`); anchor.rel = 'noopener'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
        setNotice('Файл передан браузеру для сохранения.');
      } else {
        const file = ownedFile(library.current.names[item.id]);
        if (!file.exists) throw new Error('Сохранённый файл не найден.');
        if (!await Sharing.isAvailableAsync()) throw new Error('На этом устройстве недоступно меню отправки файлов.');
        if (!valid(epoch)) return;
        await Sharing.shareAsync(file.uri, { mimeType: item.mimeType || 'audio/mpeg', dialogTitle: item.title });
      }
    } catch (error) { if (valid(epoch)) setOperationError(readable(error, 'Не удалось открыть меню сохранения файла.')); }
  }, [valid]);

  const removeSaved = useCallback(async (trackId: string) => {
    const epoch = life.current; setOperationError('');
    try {
      await boot.current;
      if (!valid(epoch)) return;
      pendingDownloads.current.get(trackId)?.abort();
      const item = library.current.saved.find(track => track.id === trackId);
      if (!item) return;
      if (currentRef.current?.id === trackId) stop();
      const storageName = library.current.names[trackId];
      if (Platform.OS !== 'web' && storageName) { const file = ownedFile(storageName); if (file.exists) file.delete(); }
      if (Platform.OS === 'web' && item.localUri) { URL.revokeObjectURL(item.localUri); objectUrls.current.delete(item.localUri); }
      const change = (value: Library): Library => { const names = { ...value.names }; delete names[trackId]; return { ...value, names, saved: value.saved.filter(track => track.id !== trackId), favorites: value.favorites.filter(track => track.id !== trackId) }; };
      try { await commit(change, epoch); }
      catch (error) { if (valid(epoch)) publish(change(library.current)); throw error; }
      queueRef.current = queueRef.current.filter(track => track.id !== trackId); setQueue(queueRef.current);
    } catch (error) { if (valid(epoch)) setOperationError(readable(error, 'Не удалось удалить файл из библиотеки. Попробуй ещё раз.')); }
  }, [commit, publish, stop, valid]);

  const download = useCallback(async (track: MusicTrack) => {
    if (track.source === 'local') { await exportSaved(track); return; }
    const epoch = life.current;
    if (pendingDownloads.current.has(track.id)) return;
    const controller = new AbortController(); pendingDownloads.current.set(track.id, controller);
    setDownloads(value => ({ ...value, [track.id]: -1 })); setOperationError('');
    let external: Window | null = null;
    controller.signal.addEventListener('abort', () => { if (external && !external.closed) external.close(); external = null; }, { once: true });
    try {
      if (Platform.OS === 'web') {
        // Reserve a new tab during the user gesture; async permission checks would
        // otherwise make browsers silently block the later window.open().
        external = window.open('about:blank', '_blank');
        if (!external) throw new Error('Браузер заблокировал окно скачивания. Разреши всплывающие окна и попробуй ещё раз.');
        external.opener = null;
        external.document.title = 'Подготовка скачивания — Audius';
        external.document.body.textContent = 'Проверяем доступность скачивания через Audius…';
      }
      // Remote provider permissions are re-evaluated by the adapter on every tap.
      // Audius API audio is deliberately never persisted in the local file library.
      const media = await resolveDownload(track);
      if (!valid(epoch) || controller.signal.aborted) return;
      const url = remoteUrl(media.uri);
      if (external) { external.location.replace(url); external = null; }
      else await Linking.openURL(url);
      if (valid(epoch)) setNotice('Скачивание открыто через Audius. Сохранённый файл можно добавить сюда через «Добавить файлы».');
    } catch (error) { if (valid(epoch) && !controller.signal.aborted) setOperationError(readable(error, 'Не удалось открыть страницу для скачивания.')); }
    finally { if (external && !external.closed) external.close(); if (pendingDownloads.current.get(track.id) === controller) pendingDownloads.current.delete(track.id); if (valid(epoch)) setDownloads(value => { const next = { ...value }; delete next[track.id]; return next; }); }
  }, [exportSaved, valid]);

  const value = useMemo<MusicState>(() => ({
    current, queue, favorites, saved, downloads, repeat, shuffle, libraryLoading, importing: isImporting,
    playing: !!current && sourceReady.current && playback.playing,
    loading: resolving || (!!current && sourceReady.current && !playbackError && (!playback.loaded || playback.buffering)),
    position: current && sourceReady.current ? finite(playback.position) : 0,
    duration: current && sourceReady.current ? finite(playback.duration) || current.duration : current?.duration || 0,
    error: operationError || playbackError, notice,
    play, togglePlayback, next, previous, seek, toggleRepeat, toggleShuffle, toggleFavorite, download, importFiles, removeSaved, exportSaved,
    clearError: () => { setOperationError(''); setPlaybackError(''); }, clearNotice: () => setNotice(''), stop,
  }), [current, queue, favorites, saved, downloads, repeat, shuffle, libraryLoading, isImporting, playback, resolving, playbackError, operationError, notice, play, togglePlayback, next, previous, seek, toggleRepeat, toggleShuffle, toggleFavorite, download, importFiles, removeSaved, exportSaved, stop]);
  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
}
