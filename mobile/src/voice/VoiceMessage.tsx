import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View, type LayoutChangeEvent } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  AudioQuality, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync,
  useAudioPlayer, useAudioPlayerStatus, useAudioRecorder, useAudioRecorderState, type RecordingOptions,
} from 'expo-audio';
import { Text } from '../typography';
import { Icon } from '../components';
import { useTheme } from '../theme';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { decryptAttachment } from '../e2ee/attachments';
import { useMusic } from '../music/MusicProvider';
import { VOICE_MAX_MS, formatVoiceTime, levelFromMetering } from './voice';

// Mono AAC at 48 kbit/s: clear speech, about 360 KB per minute.
const VOICE_RECORDING: RecordingOptions = {
  extension: '.m4a', sampleRate: 32000, numberOfChannels: 1, bitRate: 48000, isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.HIGH, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
  web: { mimeType: 'audio/webm', bitsPerSecond: 48000 },
};
const PLAYBACK_MODE = { playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix', allowsRecording: false } as const;

export type VoiceTake = { uri: string; durationMs: number };

/** Microphone recorder for one chat composer. Nothing is recorded until start() and permission. */
export function useVoiceRecorder(onLimit: () => void) {
  const recorder = useAudioRecorder(VOICE_RECORDING);
  const state = useAudioRecorderState(recorder, 100);
  const music = useMusic();
  const [active, setActive] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const limitRef = useRef(onLimit); limitRef.current = onLimit;
  const busy = useRef(false);

  useEffect(() => { if (active && state.isRecording) setLevels(previous => [...previous.slice(-39), levelFromMetering(state.metering)]); }, [active, state.isRecording, state.durationMillis, state.metering]);
  useEffect(() => { if (active && state.durationMillis >= VOICE_MAX_MS) limitRef.current(); }, [active, state.durationMillis]);
  // By the time this cleanup runs, useAudioRecorder may already have released the native
  // recorder; touching a released shared object throws and would crash the app on «Назад».
  const recordingRef = useRef(false); recordingRef.current = active;
  useEffect(() => () => {
    if (recordingRef.current) { try { void recorder.stop().catch(() => {}); } catch { /* already released */ } }
    void setAudioModeAsync(PLAYBACK_MODE).catch(() => {});
  }, [recorder]);

  const start = useCallback(async () => {
    if (busy.current || active) return;
    busy.current = true;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error('Нет доступа к микрофону. Разреши его для Инвиза в настройках телефона, чтобы записывать голосовые.');
      music.stop();
      await setAudioModeAsync({ ...PLAYBACK_MODE, allowsRecording: true, shouldPlayInBackground: false });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setLevels([]); setActive(true);
    } catch (error) {
      await setAudioModeAsync(PLAYBACK_MODE).catch(() => {});
      throw error;
    } finally { busy.current = false; }
  }, [active, music, recorder]);

  /** Stops the recording. Returns the file, or null when cancelled. */
  const finish = useCallback(async (keep: boolean): Promise<VoiceTake | null> => {
    if (!active || busy.current) return null;
    busy.current = true;
    const durationMs = Math.min(VOICE_MAX_MS, recorder.getStatus().durationMillis || state.durationMillis);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) return null;
      if (!keep) { await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); return null; }
      return { uri, durationMs };
    } finally {
      setActive(false); setLevels([]); busy.current = false;
      await setAudioModeAsync(PLAYBACK_MODE).catch(() => {});
    }
  }, [active, recorder, state.durationMillis]);

  return { active, durationMs: active ? state.durationMillis : 0, levels, start, finish };
}

export function VoiceRecordingBar({ durationMs, levels, onCancel, onSend }: { durationMs: number; levels: number[]; onCancel: () => void; onSend: () => void }) {
  const t = useTheme();
  const [blink, setBlink] = useState(true);
  useEffect(() => { const timer = setInterval(() => setBlink(value => !value), 600); return () => clearInterval(timer); }, []);
  const bars = levels.length ? levels : [0];
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Удалить запись" onPress={onCancel} style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .6 : 1 })}><Icon name="trash-outline" color={t.danger} size={22} /></Pressable>
    <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.danger, opacity: blink ? 1 : .25 }} />
    <Text style={{ color: t.text, fontSize: 15, fontWeight: '600', minWidth: 46, fontVariant: ['tabular-nums'] }}>{formatVoiceTime(durationMs)}</Text>
    <View accessibilityLabel="Уровень звука" style={{ flex: 1, height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, overflow: 'hidden' }}>
      {bars.map((level, index) => <View key={index} style={{ width: 3, borderRadius: 2, height: 4 + level * 24, backgroundColor: t.accent, opacity: .45 + level * .55 }} />)}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Отправить голосовое сообщение" onPress={onSend} style={({ pressed }) => ({ height: 44, width: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .75 : 1 })}><Icon name="arrow-up" color={t.onAccent} size={23} /></Pressable>
  </View>;
}

type VoicePlayback = {
  activeId: string | null; loadingId: string | null; failedId: string | null; playing: boolean; position: number; duration: number; error: string;
  toggle: (attachment: Attachment) => void; seek: (attachment: Attachment, fraction: number) => void;
};
const VoiceContext = createContext<VoicePlayback | null>(null);

/** One shared player per chat screen: starting a voice message stops the previous one and the music. */
export function VoicePlaybackProvider({ api, children }: { api: Api; children: React.ReactNode }) {
  const player = useAudioPlayer(null, { updateInterval: 150 });
  const status = useAudioPlayerStatus(player);
  const music = useMusic();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [failedId, setFailedId] = useState<string | null>(null);
  const files = useRef(new Map<string, { uri: string; dispose: () => Promise<void> }>());
  const request = useRef(0);

  useEffect(() => () => { request.current++; try { player.pause(); } catch { /* released with the hook */ } for (const file of files.current.values()) void file.dispose().catch(() => {}); files.current.clear(); }, [player]);
  useEffect(() => { if (status.didJustFinish) { try { player.pause(); void player.seekTo(0); } catch { /* ignore */ } } }, [status.didJustFinish, player]);

  const toggle = useCallback((attachment: Attachment) => {
    if (activeId === attachment.id && !loadingId && failedId !== attachment.id) { if (status.playing) player.pause(); else { music.stop(); player.play(); } return; }
    const ticket = ++request.current;
    setError(''); setFailedId(null); setLoadingId(attachment.id); setActiveId(attachment.id);
    try { player.pause(); } catch { /* nothing playing */ }
    void (async () => {
      try {
        let file = files.current.get(attachment.id);
        if (!file) { file = await decryptAttachment(api, attachment); files.current.set(attachment.id, file); }
        if (ticket !== request.current) return;
        await setAudioModeAsync(PLAYBACK_MODE).catch(() => {});
        music.stop();
        player.replace({ uri: file.uri });
        player.play();
      } catch (e) {
        if (ticket === request.current) { setError(e instanceof Error ? e.message : 'Не удалось воспроизвести голосовое.'); setFailedId(attachment.id); }
      } finally { if (ticket === request.current) setLoadingId(null); }
    })();
  }, [activeId, loadingId, failedId, status.playing, player, music, api]);

  const seek = useCallback((attachment: Attachment, fraction: number) => {
    if (activeId !== attachment.id || loadingId) return;
    const duration = status.duration || (attachment.media?.durationMs || 0) / 1000;
    if (duration > 0) void player.seekTo(Math.max(0, Math.min(1, fraction)) * duration);
  }, [activeId, loadingId, status.duration, player]);

  const value: VoicePlayback = { activeId, loadingId, failedId, playing: status.playing, position: status.currentTime || 0, duration: status.duration || 0, error, toggle, seek };
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function VoiceBubble({ attachment, mine }: { attachment: Attachment; mine: boolean }) {
  const t = useTheme();
  const voice = useContext(VoiceContext);
  const [width, setWidth] = useState(1);
  if (!voice) return null;
  const active = voice.activeId === attachment.id;
  const loading = voice.loadingId === attachment.id;
  const total = (active && voice.duration ? voice.duration * 1000 : 0) || attachment.media?.durationMs || 0;
  const position = active ? voice.position * 1000 : 0;
  const progress = total > 0 ? Math.min(1, position / total) : 0;
  const playing = active && voice.playing;
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, width: 230 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={playing ? 'Пауза' : 'Прослушать голосовое сообщение'} onPress={() => voice.toggle(attachment)} style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .75 : 1 })}>
      {loading ? <ActivityIndicator size="small" color={t.onAccent} /> : <Icon name={playing ? 'pause' : 'play'} color={t.onAccent} size={20} />}
    </Pressable>
    <View style={{ flex: 1, gap: 6 }}>
      <Pressable accessibilityRole="adjustable" accessibilityLabel="Перемотка" disabled={!active} onLayout={(event: LayoutChangeEvent) => setWidth(Math.max(1, event.nativeEvent.layout.width))} onPress={event => voice.seek(attachment, event.nativeEvent.locationX / width)} style={{ height: 18, justifyContent: 'center' }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: mine ? 'rgba(127,140,170,0.35)' : t.border, overflow: 'hidden' }}>
          <View style={{ width: `${progress * 100}%`, height: 4, borderRadius: 2, backgroundColor: t.accent }} />
        </View>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Icon name="mic" size={12} color={t.muted} />
        <Text style={{ color: t.muted, fontSize: 11, fontVariant: ['tabular-nums'] }}>{active && position > 0 ? `${formatVoiceTime(position)} / ${formatVoiceTime(total)}` : formatVoiceTime(total)}</Text>
      </View>
      {voice.failedId === attachment.id && voice.error ? <Text style={{ color: t.danger, fontSize: 11 }}>{voice.error}</Text> : null}
    </View>
  </View>;
}

