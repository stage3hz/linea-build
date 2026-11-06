import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { GlassSurface } from '../glass';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VOICE_MAX_MS, decodeWaveform, encodeWaveform, formatVoiceTime, formatVoiceTimeFine, levelFromMetering } from './voice';

// Mono AAC at 48 kHz / 128 kbit/s: full-band, very clear voice (about 0.95 MB per minute;
// was 32 kHz / 48 kbit/s). Still encrypted before sending like any other attachment.
const VOICE_RECORDING: RecordingOptions = {
  extension: '.m4a', sampleRate: 48000, numberOfChannels: 1, bitRate: 128000, isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MAX, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
  // PC (Electron/Chromium): record straight to MP4/AAC — the same format the phones send and can
  // play. WebM/Opus was rejected as a voice message («Выбери аудиофайл…») and iPhones cannot play it.
  web: { mimeType: webVoiceMime(), bitsPerSecond: 128000 },
};
function webVoiceMime(): string {
  const recorder = (globalThis as { MediaRecorder?: { isTypeSupported?: (type: string) => boolean } }).MediaRecorder;
  for (const type of ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']) if (recorder?.isTypeSupported?.(type)) return type;
  return 'audio/webm';
}
const PLAYBACK_MODE = { playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix', allowsRecording: false } as const;

let playbackReset: ReturnType<typeof setTimeout> | undefined;
function cancelPlaybackReset() { if (playbackReset) { clearTimeout(playbackReset); playbackReset = undefined; } }
function schedulePlaybackReset(delay: number) {
  cancelPlaybackReset();
  const reset = () => { playbackReset = undefined; void setAudioModeAsync(PLAYBACK_MODE).catch(() => {}); };
  if (delay <= 0) reset(); else playbackReset = setTimeout(reset, delay);
}

export type VoiceTake = { uri: string; durationMs: number; waveform?: string };

/** Microphone recorder for one chat composer. Nothing is recorded until start() and permission. */
export function useVoiceRecorder(onLimit: () => void) {
  const recorder = useAudioRecorder(VOICE_RECORDING);
  const state = useAudioRecorderState(recorder, 100);
  const music = useMusic();
  const [active, setActive] = useState(false); const [paused, setPaused] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const samples = useRef<number[]>([]); // the whole take, for the bubble's waveform
  const limitRef = useRef(onLimit); limitRef.current = onLimit;
  const busy = useRef(false);

  useEffect(() => { if (!active || !state.isRecording) return; const level = levelFromMetering(state.metering); if (samples.current.length < 20000) samples.current.push(level); setLevels(previous => [...previous.slice(-39), level]); }, [active, state.isRecording, state.durationMillis, state.metering]);
  useEffect(() => { if (active && state.durationMillis >= VOICE_MAX_MS) limitRef.current(); }, [active, state.durationMillis]);
  // By the time this cleanup runs, useAudioRecorder may already have released the native
  // recorder; touching a released shared object throws and would crash the app on «Назад».
  const recordingRef = useRef(false); recordingRef.current = active;
  useEffect(() => () => {
    if (recordingRef.current) { try { void recorder.stop().catch(() => {}); } catch { /* already released */ } }
    schedulePlaybackReset(0);
  }, [recorder]);

  // iOS: switching the audio session between playback and recording sometimes takes ~3 s
  // (expo/expo#40531). The switch back to playback waits a little, so takes in a row skip it.
  const starting = useRef<Promise<void> | null>(null);
  const activeRef = useRef(false);
  const start = useCallback(async () => {
    if (starting.current || activeRef.current) return starting.current ?? undefined;
    const run = (async () => {
      cancelPlaybackReset();
      try {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted) throw new Error(Platform.OS === 'web' ? 'Нет доступа к микрофону. Подключи микрофон и разреши его Инвизу в «Параметры Windows → Конфиденциальность → Микрофон».' : 'Нет доступа к микрофону. Разреши его для Инвиза в настройках телефона, чтобы записывать голосовые.');
        music.stop();
        await setAudioModeAsync({ ...PLAYBACK_MODE, allowsRecording: true, shouldPlayInBackground: false });
        await recorder.prepareToRecordAsync();
        recorder.record();
        samples.current = []; setLevels([]); setPaused(false); activeRef.current = true; setActive(true);
      } catch (error) {
        schedulePlaybackReset(0);
        throw error;
      }
    })();
    starting.current = run;
    try { await run; } finally { starting.current = null; }
  }, [music, recorder]);

  /** Stops the recording. Returns the file, or null when cancelled. Released while the microphone was
   *  still starting: waits for the start, then stops — the take is never left running on its own. */
  const finish = useCallback(async (keep: boolean): Promise<VoiceTake | null> => {
    if (starting.current) { try { await starting.current; } catch { return null; } }
    if (!activeRef.current || busy.current) return null;
    busy.current = true;
    const durationMs = Math.min(VOICE_MAX_MS, recorder.getStatus().durationMillis || state.durationMillis);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) return null;
      if (!keep) { await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); return null; }
      return { uri, durationMs, waveform: encodeWaveform(samples.current) };
    } finally {
      activeRef.current = false; setActive(false); setPaused(false); setLevels([]); busy.current = false;
      schedulePlaybackReset(4000);
    }
  }, [recorder, state.durationMillis]);

  /** Pause / continue the same file (Telegram's pause while recording hands-free). */
  const togglePause = useCallback(() => {
    if (!active || busy.current) return;
    try { if (paused) { recorder.record(); setPaused(false); } else { recorder.pause(); setPaused(true); } } catch { /* recorder released */ }
  }, [active, paused, recorder]);
  return { active, paused, durationMs: active ? state.durationMillis : 0, levels, start, finish, togglePause };
}

export function VoiceRecordingBar({ durationMs, levels, onCancel, onSend, holding = false, cancelProgress = 0, paused = false, onPause, floating = false }: { durationMs: number; levels: number[]; onCancel: () => void; onSend: () => void; holding?: boolean; cancelProgress?: number; paused?: boolean; onPause?: () => void; floating?: boolean }) {
  const t = useTheme();
  const [blink, setBlink] = useState(true);
  useEffect(() => { const timer = setInterval(() => setBlink(value => !value), 600); return () => clearInterval(timer); }, []);
  const level = levels.at(-1) || 0;
  const dot = <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: paused ? t.muted : t.danger, opacity: paused || blink ? 1 : .25 }} />;
  const time = <Text style={{ color: t.text, fontSize: 15, fontWeight: '500', minWidth: 62, fontVariant: ['tabular-nums'] }}>{formatVoiceTimeFine(durationMs)}</Text>;
  // As in Telegram. Holding: red dot, 0:01,62 and «‹ Влево — отмена» that follows the finger.
  if (holding) return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingLeft: 12 }}>
    {dot}{time}
    <Text style={{ flex: 1, textAlign: 'center', color: t.muted, fontSize: 14, opacity: 1 - cancelProgress, transform: [{ translateX: -cancelProgress * 40 }] }}>‹ Влево — отмена</Text>
  </View>;
  // Locked in a chat, as in Telegram: a glass strip with dot, 0:04,63, «Отмена» and pause, the composer
  // keeps its height; a big send circle (52) in the record button's place breathes with the voice.
  if (floating) return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    <GlassSurface lens material="regular" radius={20} style={{ flex: 1 }} contentStyle={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 4 }}>
      {dot}{time}
      <Pressable accessibilityRole="button" accessibilityLabel="Отменить запись" onPress={onCancel} hitSlop={8} style={({ pressed }) => ({ flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .6 : 1 })}><Text style={{ color: t.accent, fontSize: 16, fontWeight: '600' }}>Отмена</Text></Pressable>
      {onPause ? <Pressable accessibilityRole="button" accessibilityLabel={paused ? 'Продолжить запись' : 'Пауза'} onPress={onPause} hitSlop={6} style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, opacity: pressed ? .6 : 1 })}><Icon name={paused ? 'mic' : 'pause'} size={17} color={paused ? t.danger : t.text} /></Pressable> : null}
    </GlassSurface>
    <View style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ position: 'absolute', width: 52, height: 52, borderRadius: 26, backgroundColor: t.accent, opacity: paused ? 0 : .22, transform: [{ scale: 1 + level * .4 }] }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Отправить голосовое сообщение" onPress={onSend} hitSlop={6} style={({ pressed }) => ({ position: 'absolute', height: 52, width: 52, borderRadius: 26, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .8 : 1 })}><Icon name="arrow-up" color={t.onAccent} size={27} /></Pressable>
    </View>
  </View>;
  // Elsewhere (Saved): one row — dot, time, «Отмена», pause and the send circle.
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50, paddingLeft: 10 }}>
    {dot}{time}
    <Pressable accessibilityRole="button" accessibilityLabel="Отменить запись" onPress={onCancel} style={({ pressed }) => ({ flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .6 : 1 })}><Text style={{ color: t.accent, fontSize: 16, fontWeight: '600' }}>Отмена</Text></Pressable>
    {onPause ? <Pressable accessibilityRole="button" accessibilityLabel={paused ? 'Продолжить запись' : 'Пауза'} onPress={onPause} style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, opacity: pressed ? .6 : 1 })}><Icon name={paused ? 'mic' : 'pause'} size={19} color={paused ? t.danger : t.text} /></Pressable> : null}
    <View style={{ width: 54, height: 54, alignItems: 'center', justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ position: 'absolute', width: 54, height: 54, borderRadius: 27, backgroundColor: t.accent, opacity: paused ? 0 : .22, transform: [{ scale: 1 + level * .45 }] }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Отправить голосовое сообщение" onPress={onSend} style={({ pressed }) => ({ height: 50, width: 50, borderRadius: 25, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .75 : 1 })}><Icon name="arrow-up" color={t.onAccent} size={25} /></Pressable>
    </View>
  </View>;
}

type VoicePlayback = {
  activeId: string | null; loadingId: string | null; failedId: string | null; playing: boolean; position: number; duration: number; error: string;
  toggle: (attachment: Attachment) => void; seek: (attachment: Attachment, fraction: number) => void;
  rate: number; cycleRate: () => void;
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
  // Speed of voice and video messages (Telegram: 1× → 1.5× → 2×), remembered for the session.
  const [rate, setRate] = useState(voiceRate);
  const [toast, setToast] = useState(''); const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { try { player.setPlaybackRate(rate); } catch { /* not loaded yet */ } }, [rate, player, activeId, loadingId]);
  const cycleRate = useCallback(() => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1; voiceRate = next; setRate(next);
    setToast(next === 1 ? 'Звук будет проигрываться с обычной скоростью.' : `Звук будет проигрываться в ${next === 1.5 ? '1,5' : '2'} раза быстрее.`);
    if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, [rate]);

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
        cancelPlaybackReset(); await setAudioModeAsync(PLAYBACK_MODE).catch(() => {});
        music.stop();
        player.replace({ uri: file.uri });
        try { player.setPlaybackRate(voiceRate); } catch { /* applied by the effect */ }
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

  const value: VoicePlayback = { activeId, loadingId, failedId, playing: status.playing, position: status.currentTime || 0, duration: status.duration || 0, error, toggle, seek, rate, cycleRate };
  return <VoiceContext.Provider value={value}>{children}{toast ? <RateToast text={toast} rate={rate} /> : null}</VoiceContext.Provider>;
}

let voiceRate = 1;
/** The chosen speed also plays round video messages (as in Telegram). */
export const currentVoiceRate = () => voiceRate;

/** Telegram-like hint at the top when the speed changes. */
function RateToast({ text, rate }: { text: string; rate: number }) {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 64, left: 12, right: 12, alignItems: 'center' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: 'rgba(20,24,36,0.92)' }}>
      <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1.5, borderColor: '#FFF' }}><Text style={{ color: '#FFF', fontSize: 11, fontWeight: '800' }}>{rate === 1.5 ? '1,5×' : `${rate}×`}</Text></View>
      <Text style={{ color: '#FFF', fontSize: 14, flexShrink: 1 }}>{text}</Text>
    </View>
  </View>;
}

// Telegram's voice bubble: play button, the take's waveform (played part bright, tap or drag to seek),
// time under it, speed while playing. Messages without a waveform (older apps) show even low bars.
export function VoiceBubble({ attachment, mine }: { attachment: Attachment; mine: boolean }) {
  const t = useTheme();
  const voice = useContext(VoiceContext);
  const [width, setWidth] = useState(1);
  const bars = React.useMemo(() => decodeWaveform(attachment.media?.waveform) || Array.from({ length: 48 }, () => .12), [attachment.media?.waveform]);
  if (!voice) return null;
  const active = voice.activeId === attachment.id;
  const loading = voice.loadingId === attachment.id;
  const total = (active && voice.duration ? voice.duration * 1000 : 0) || attachment.media?.durationMs || 0;
  const position = active ? voice.position * 1000 : 0;
  const progress = total > 0 ? Math.min(1, position / total) : 0;
  const playing = active && voice.playing;
  // Not playing yet: start on release, so a scroll that begins on the bubble does not start playback.
  const seekAt = (x: number) => { if (active) voice.seek(attachment, x / width); };
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, width: 240 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={playing ? 'Пауза' : 'Прослушать голосовое сообщение'} onPress={() => voice.toggle(attachment)} style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .75 : 1 })}>
      {loading ? <ActivityIndicator size="small" color={t.onAccent} /> : <Icon name={playing ? 'pause' : 'play'} color={t.onAccent} size={21} />}
    </Pressable>
    <View style={{ flex: 1, gap: 4 }}>
      <View accessibilityRole="adjustable" accessibilityLabel="Перемотка голосового" onLayout={(event: LayoutChangeEvent) => setWidth(Math.max(1, event.nativeEvent.layout.width))}
        onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => active} onResponderGrant={event => seekAt(event.nativeEvent.locationX)} onResponderRelease={() => { if (!active) voice.toggle(attachment); }} onResponderMove={event => { if (active) voice.seek(attachment, event.nativeEvent.locationX / width); }}
        style={{ height: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {bars.map((value, index) => <View key={index} style={{ width: 2.5, borderRadius: 2, height: Math.max(2.5, value * 22), backgroundColor: (index + .5) / bars.length <= progress ? t.accent : (mine ? 'rgba(127,140,170,0.45)' : t.muted), opacity: (index + .5) / bars.length <= progress ? 1 : .55 }} />)}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: t.muted, fontSize: 11, fontVariant: ['tabular-nums'] }}>{active && position > 0 ? formatVoiceTime(position) : formatVoiceTime(total)}</Text>
        {active ? <Pressable accessibilityRole="button" accessibilityLabel={`Скорость ${voice.rate}×. Изменить`} onPress={voice.cycleRate} hitSlop={8} style={{ marginLeft: 'auto', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: voice.rate !== 1 ? t.accent : (mine ? 'rgba(127,140,170,0.3)' : t.surface2) }}><Text style={{ color: voice.rate !== 1 ? t.onAccent : t.text, fontSize: 11, fontWeight: '800' }}>{voice.rate === 1.5 ? '1,5×' : `${voice.rate}×`}</Text></Pressable> : null}
      </View>
      {voice.failedId === attachment.id && voice.error ? <Text style={{ color: t.danger, fontSize: 11 }}>{voice.error}</Text> : null}
    </View>
  </View>;
}
