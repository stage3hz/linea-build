import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Image, Modal, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, cancelAnimation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { motionEnabled, usePowerFeatures } from '../motion';
import { CameraView, useCameraPermissions, useMicrophonePermissions, type CameraType } from 'expo-camera';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { BlurView } from 'expo-blur';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Pressable, Text } from '../typography';
import { Icon } from '../components';
import { useTheme } from '../theme';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { useMedia } from '../media/mediaCache';
import { ProgressRing } from '../media/MediaBubble';
import { useNetworkTier } from '../network/useNetworkTier';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { NoteRing } from './NoteRing';
import { claimNoteAudio, freshTick, playedSeconds, setNoteBar, isExpanded, isNoteVisible, keepsSoundRequest, noteAutoload, noteSizes, progressStep, reduceNote, scrubFraction, onScrubBand, releaseNoteAudio, restState, subscribeVisibleNotes, timeUpdateInterval, type NoteEvent, type NoteState } from './playback';
import { setCenterStage } from '../media/centerStage';
import { currentVoiceRate, restorePlaybackSession } from '../voice/VoiceMessage';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidNoteCamera, androidNoteCameraAvailable, prewarmNoteCamera, type AndroidNoteCameraHandle } from './androidCamera';
import { resolveTake } from './take';
import { useMusic } from '../music/MusicProvider';
import { VIDEO_NOTE_MAX_MS, formatVoiceTime, formatVoiceTimeFine } from '../voice/voice';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Brightness from 'expo-brightness';
import { lightFeedback } from '../haptics';

export type VideoNoteTake = { uri: string; durationMs: number };
const BASE_CIRCLE = 300;
// iPhone: the camera input is swapped inside the running capture session, so the recording continues
// (as in Telegram). Android's CameraX rebinds the camera and would stop the file, so there it stays before recording.
// Android: our CameraX recorder (persistent recording) keeps the file going across a switch.
// iPhone: switching cameras mid-take ended the recording (the circle closed) and mixed two different
// video formats in one file, which the encryption step rejects. Switch before recording instead.
const FLIP_WHILE_RECORDING = androidNoteCameraAvailable;
// iPhone with our native camera: the view itself shows the previous take's blurred last frame while the
// camera starts and covers a flip with a short crossfade, so no JS cover or blur is drawn over it.
const NATIVE_COVER = androidNoteCameraAvailable && Platform.OS === 'ios';

/** Full-screen recorder for a round video message. Camera and microphone are used only while it is open. */
/**
 * `hold`: Telegram mode — recording starts by itself while the finger holds the composer button,
 * `stop`/`cancel` counters come from that button, and the circle floats over the blurred chat
 * (no separate screen, so the finger's touch is not interrupted). After a lock the buttons appear.
 */
export type VideoHold = { stop: number; cancel: number; locked: boolean };
export function VideoNoteRecorder({ visible, onClose, onDone, hold = null }: { visible: boolean; onClose: () => void; onDone: (take: VideoNoteTake) => void; hold?: VideoHold | null }) {
  const win = useWindowDimensions();
  const t = useTheme(); const music = useMusic();
  const [camera, requestCamera] = useCameraPermissions();
  const [mic, requestMic] = useMicrophonePermissions();
  const [facing, setFacing] = useState<CameraType>('front');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<CameraView>(null);
  const nativeRef = useRef<AndroidNoteCameraHandle>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Unmounted (the chat closed mid-take): timers are cleared and a late result never reaches onDone/onClose.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (limit.current) clearTimeout(limit.current); if (flipTimer.current) clearTimeout(flipTimer.current); limit.current = flipTimer.current = undefined; }; }, []);
  // Center Stage (iPhone front camera auto-framing) pans the crop inside the circle, so the picture
  // floats sideways; Telegram turns it off for video messages and so do we (no toggle).
  // Our native iPhone camera turns it off itself before the camera is added (doing it here, while the
  // session starts, could reconfigure the camera mid-start); only the expo-camera fallback needs this.
  useEffect(() => { if (visible && !androidNoteCameraAvailable) void setCenterStage(false); }, [visible]);
  // Android: CameraX initialised while the chat is open, before the first press.
  useEffect(() => { prewarmNoteCamera(); }, []);
  const started = useRef(0); const cancelled = useRef(false);
  // Pause (Telegram, hands-free): paused time is not counted in the timer, the ring or the 60 s limit.
  const [notePaused, setNotePaused] = useState(false); const pausedAt = useRef(0); const pausedTotal = useRef(0);
  const activeMs = () => Date.now() - started.current - pausedTotal.current - (pausedAt.current ? Date.now() - pausedAt.current : 0);

  useEffect(() => {
    if (!visible) { setReady(false); setRecording(false); setError(''); return; }
    music.stop();
    (async () => {
      const c = camera?.granted ? camera : await requestCamera();
      const m = mic?.granted ? mic : await requestMic();
      if (!c.granted || !m.granted) setError('Нужен доступ к камере и микрофону. Разреши их для Инвиза в настройках телефона.');
    })().catch(() => setError('Не удалось запросить доступ к камере.'));
  }, [visible]);
  // The 60-s ring runs as one linear animation on the UI thread (paused with the take): no per-tick renders.
  const recProgress = useSharedValue(0);
  useEffect(() => {
    if (!recording) { cancelAnimation(recProgress); recProgress.value = 0; return; }
    if (notePaused) { cancelAnimation(recProgress); return; }
    const done = Math.min(1, activeMs() / VIDEO_NOTE_MAX_MS);
    recProgress.value = done;
    recProgress.value = withTiming(1, { duration: Math.max(0, VIDEO_NOTE_MAX_MS - activeMs()), easing: Easing.linear });
  }, [recording, notePaused]);

  // The file our native recorder writes to: removed when the take is cancelled, too short or failed.
  const notePath = useRef<string | null>(null);
  const discard = (uri: string | null) => { if (uri) void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); };
  /** Ends a take: sends it, or drops it (deleting the file) — in hold mode a short or failed take simply closes the circle. */
  const finishTake = (uri: string | null | undefined, failed?: string | null) => {
    const durationMs = Math.min(VIDEO_NOTE_MAX_MS, activeMs());
    if (!alive.current) { discard(uri || notePath.current); notePath.current = null; return; }
    setRecording(false);
    const outcome = resolveTake({ uri: uri || notePath.current, durationMs, cancelled: cancelled.current, hold: !!hold, locked: !!hold?.locked, failed });
    notePath.current = null;
    if (outcome.action === 'send') { onDone({ uri: outcome.uri, durationMs }); return; }
    discard(outcome.deleteUri);
    if (outcome.action === 'error') setError(outcome.message); else if (outcome.close) onClose();
  };
  const failure = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message : fallback;
  const start = async () => {
    if (recording || !ready) return;
    cancelled.current = false; setError(''); started.current = Date.now(); pausedAt.current = 0; pausedTotal.current = 0; setNotePaused(false); setRecording(true);
    if (androidNoteCameraAvailable) {
      const path = `${FileSystem.cacheDirectory}videonote-${Date.now()}.mp4`;
      notePath.current = path;
      try {
        await nativeRef.current?.startRecording(path);
        // Count from the moment the recorder really runs (the writer takes the next camera frame).
        started.current = Date.now();
        limit.current = setTimeout(() => { if (alive.current) void stop(); }, VIDEO_NOTE_MAX_MS);
      } catch (e) { finishTake(null, failure(e, 'Не удалось начать запись.')); }
      return;
    }
    if (!ref.current) { setRecording(false); return; }
    try {
      const result = await ref.current.recordAsync({ maxDuration: VIDEO_NOTE_MAX_MS / 1000 });
      finishTake(result?.uri);
    } catch (e) { finishTake(null, failure(e, 'Не удалось записать видео.')); }
  };
  const stop = async () => {
    if (limit.current) { clearTimeout(limit.current); limit.current = undefined; }
    if (androidNoteCameraAvailable) {
      // A stop before the first frame is rejected by the native recorder (E_EMPTY / no valid data):
      // in hold mode that is a too-short take — the circle closes instead of freezing behind a blur.
      try { finishTake(await nativeRef.current?.stopRecording()); }
      catch (e) { finishTake(null, failure(e, 'Не удалось записать видео.')); }
      return;
    }
    if (recording) ref.current?.stopRecording();
  };
  const togglePause = async () => {
    if (!recording || !androidNoteCameraAvailable || !nativeRef.current?.pauseRecording) return;
    const next = !notePaused;
    try { await nativeRef.current.pauseRecording(next); } catch { return; }
    lightFeedback();
    if (next) { pausedAt.current = Date.now(); if (limit.current) { clearTimeout(limit.current); limit.current = undefined; } }
    else { pausedTotal.current += Date.now() - pausedAt.current; pausedAt.current = 0; limit.current = setTimeout(() => { if (alive.current) void stop(); }, Math.max(0, VIDEO_NOTE_MAX_MS - activeMs())); }
    setNotePaused(next);
  };
  const cancel = () => { cancelled.current = true; if (recording) void stop(); onClose(); };
  const allowed = !!camera?.granted && !!mic?.granted;
  // No webcam (common on PCs) or a camera busy in another app: say so instead of a black circle forever.
  useEffect(() => {
    if (!visible || !allowed || ready || error) return;
    const timer = setTimeout(() => setError('Камера не отвечает: проверь, что она подключена и не занята другой программой.'), 6000);
    return () => clearTimeout(timer);
  }, [visible, allowed, ready, error]);
  const autoStarted = useRef(false);
  useEffect(() => { if (!visible) autoStarted.current = false; }, [visible]);
  // Our native camera reports «ready» with its first real frame (iPhone: first upright frame; Android:
  // preview streaming), so the take starts at once and the timer runs from the first written frame.
  // expo-camera's «ready» comes a moment before frames reach the file: a short pause there.
  useEffect(() => {
    if (!(visible && hold && ready && allowed && !recording && !autoStarted.current)) return;
    const timer = setTimeout(() => { if (!autoStarted.current) { autoStarted.current = true; void start(); } }, androidNoteCameraAvailable ? 0 : Platform.OS === 'ios' ? 450 : 150);
    return () => clearTimeout(timer);
  }, [visible, hold, ready, allowed, recording]);
  const stopSeen = useRef(hold?.stop ?? 0), cancelSeen = useRef(hold?.cancel ?? 0);
  useEffect(() => { if (!hold) return; if (hold.stop !== stopSeen.current) { stopSeen.current = hold.stop; if (recording) void stop(); else onClose(); } }, [hold?.stop]);
  useEffect(() => { if (!hold) return; if (hold.cancel !== cancelSeen.current) { cancelSeen.current = hold.cancel; cancel(); } }, [hold?.cancel]);
  // No black first frame: a cover in the app's background colour until the camera shows a picture. Our
  // native camera reports ready with its first frame (no grace needed, no spinner); expo-camera's «ready»
  // comes a moment before frames reach the preview, so it keeps a short grace and a spinner.
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!ready) { setLive(false); return; }
    if (androidNoteCameraAvailable) { setLive(true); return; }
    const timer = setTimeout(() => setLive(true), Platform.OS === 'ios' ? 250 : 200);
    return () => clearTimeout(timer);
  }, [ready]);
  const cover = useSharedValue(1);
  useEffect(() => { cover.value = live ? withTiming(0, { duration: motionEnabled() ? (androidNoteCameraAvailable ? 120 : 180) : 0 }) : 1; }, [live]);
  const coverStyle = useAnimatedStyle(() => ({ opacity: cover.value }));
  const cameraCover = NATIVE_COVER ? null : <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }, coverStyle]}>{!live && allowed && !error && !androidNoteCameraAvailable ? <ActivityIndicator color="rgba(255,255,255,0.75)" /> : null}</Animated.View>;
  const getMs = () => recording ? activeMs() : 0;
  // Telegram: side = min(369, width − 24), top ≈ 40 % of the height (not above the status bar + 24).
  const CIRCLE = hold ? Math.round(Math.min(369, win.width - 24)) : BASE_CIRCLE;

  const showControls = !hold || hold.locked;
  const insets = useSafeAreaInsets();
  const lastFlip = useRef(0);
  // Pinch to zoom while recording (Telegram); a short blur hides the jump when the camera flips.
  const [zoom, setZoom] = useState(0); const zoomBase = useRef(0);
  const [flipping, setFlipping] = useState(false);
  useEffect(() => { if (!visible) setZoom(0); }, [visible]);
  const pinch = Gesture.Pinch().runOnJS(true)
    .onStart(() => { zoomBase.current = zoom; })
    .onUpdate(e => { setZoom(Math.min(1, Math.max(0, zoomBase.current + (e.scale - 1) * 0.6))); });
  const [flash, setFlash] = useState(false);
  const brightness = useRef<number | null>(null);
  // Front «flash» as in Telegram: the screen turns white and goes to full brightness while recording.
  const screenFlash = flash && facing === 'front' && recording;
  useEffect(() => {
    if (!screenFlash) { if (brightness.current !== null) { const value = brightness.current; brightness.current = null; void Brightness.setBrightnessAsync(value).catch(() => {}); } return; }
    void Brightness.getBrightnessAsync().then(value => { brightness.current = value; return Brightness.setBrightnessAsync(1); }).catch(() => {});
  }, [screenFlash]);
  useEffect(() => { if (!visible) setFlash(false); }, [visible]);
  // A flip's blur: none on iPhone with our native camera (it crossfades the last frame itself); on Android
  // it ends when the new camera streams (onNativeReady), at most 700 ms; expo-camera keeps a fixed 450 ms.
  const flip = () => { const now = Date.now(); if (now - lastFlip.current < 300) return; lastFlip.current = now; lightFeedback(); if (recording && !FLIP_WHILE_RECORDING) return; setZoom(0); if (flipTimer.current) clearTimeout(flipTimer.current); flipTimer.current = undefined; if (!NATIVE_COVER) { setFlipping(true); flipTimer.current = setTimeout(() => { flipTimer.current = undefined; setFlipping(false); }, androidNoteCameraAvailable ? 700 : 450); } if (!recording && Platform.OS !== 'ios' && !androidNoteCameraAvailable) setReady(false); setError(''); setFacing(value => value === 'front' ? 'back' : 'front'); };
  const onNativeReady = () => { setReady(true); if (flipTimer.current) { clearTimeout(flipTimer.current); flipTimer.current = undefined; setFlipping(false); } };
  const preview = visible && allowed && androidNoteCameraAvailable ? <AndroidNoteCamera ref={nativeRef} zoom={zoom} facing={facing === 'back' ? 'back' : 'front'} {...(Platform.OS === 'ios' ? { torch: flash && facing === 'back' } : {})} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} onReady={onNativeReady} onCameraError={event => setError(event.nativeEvent.message || 'Камера недоступна.')} /> : visible && allowed ? <CameraView key={Platform.OS === 'ios' ? 'camera' : facing} ref={ref} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} facing={facing} mode="video" ratio="4:3" mirror={facing === 'front'} videoQuality="480p" enableTorch={flash && facing === 'back'} onCameraReady={() => setReady(true)} onMountError={event => setError(event.message || 'Камера недоступна.')} /> : null;
  // Telegram's way while the finger holds (and after a lock): the circle over the blurred chat with a
  // white progress arc around it; at the bottom the same strip as for voice — red dot, 0:04,63,
  // «‹ Влево — отмена» (after a lock: «Отмена»), the big circle on the right (under the finger; after
  // a lock it sends), and the switch-camera button above the strip on the left.
  const RING = CIRCLE + 12;
  // The circle appears in place: a short scale-up with a fade, no flight across the screen (Telegram).
  const appear = useSharedValue(0);
  useEffect(() => { appear.value = visible && hold ? (motionEnabled() ? withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) }) : withTiming(1, { duration: 0 })) : 0; }, [visible, !!hold]);
  const grow = useAnimatedStyle(() => ({ opacity: Math.min(1, appear.value * 2), transform: [{ scale: 0.7 + 0.3 * appear.value }] }));
  const dim = useAnimatedStyle(() => ({ opacity: appear.value }));
  const holdBody = <View pointerEvents="box-none" style={{ flex: 1 }}>
    {screenFlash ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#FFF6E8' }]} /> : null}
    <View pointerEvents="box-none" style={{ alignItems: 'center', paddingTop: Math.max(insets.top + 24, win.height * 0.4 - RING / 2), gap: 18 }}>
      <GestureDetector gesture={pinch}>
      <Animated.View style={[{ width: RING, height: RING, alignItems: 'center', justifyContent: 'center' }, grow]}>
        <NoteRing progress={recProgress} size={RING} stroke={4} color="#FFF" track="rgba(255,255,255,0.16)" />
        <View style={{ width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, overflow: 'hidden', backgroundColor: t.bg }}>
          {preview}
          {/* Telegram: the live picture is sharp at once; only a camera flip hides the jump behind a short blur. */}
          {flipping ? <BlurView pointerEvents="none" tint="dark" intensity={80} style={StyleSheet.absoluteFill} /> : null}
          {cameraCover}
          {zoom > 0.02 ? <View pointerEvents="none" style={{ position: 'absolute', bottom: 14, alignSelf: 'center', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.45)' }}><Text style={{ color: '#FFF', fontSize: 12, fontWeight: '700' }}>{(1 + zoom * 5).toFixed(1).replace('.', ',')}×</Text></View> : null}
        </View>
      </Animated.View>
      </GestureDetector>
      {error ? <Text style={{ color: '#FFB4B4', fontSize: 13, textAlign: 'center', maxWidth: 320 }}>{error}</Text> : null}
    </View>
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 8, right: 8, bottom: insets.bottom + 6, gap: 10 }}>
      <View pointerEvents="box-none" style={{ flexDirection: 'row' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Сменить камеру" disabled={!showControls} onPress={flip} style={[styles.small, { opacity: recording && !FLIP_WHILE_RECORDING ? .35 : 1 }]}><Icon name="camera-reverse-outline" color="#FFF" size={21} /></Pressable>
        {facing === 'front' || Platform.OS === 'ios' ? <Pressable accessibilityRole="switch" accessibilityState={{ checked: flash }} accessibilityLabel="Вспышка" disabled={!showControls} onPress={() => { lightFeedback(); setFlash(value => !value); }} style={[styles.small, { marginLeft: 11, backgroundColor: flash ? 'rgba(255,214,10,0.28)' : 'rgba(255,255,255,0.14)' }]}><Icon name={flash ? 'flash' : 'flash-off-outline'} color={flash ? '#FFD60A' : '#FFF'} size={20} /></Pressable> : null}
              <View style={{ flex: 1 }} />
        {hold?.locked && recording && androidNoteCameraAvailable ? <Pressable accessibilityRole="button" accessibilityLabel={notePaused ? 'Продолжить запись' : 'Пауза'} onPress={() => void togglePause()} style={[styles.small, { marginRight: 13 }]}><Icon name={notePaused ? 'videocam' : 'pause'} color={notePaused ? t.danger : '#FFF'} size={20} /></Pressable> : null}
      </View>
      <View pointerEvents="box-none" style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        <View pointerEvents="box-none" style={{ flex: 1, minHeight: 48, marginBottom: 16, marginRight: -68, paddingRight: 76, borderRadius: 24, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, backgroundColor: 'rgba(28,32,46,0.88)' }}>
          <RecTimer running={recording && !notePaused} getMs={getMs} dot={t.danger} fine />
          {hold?.locked ? <Pressable accessibilityRole="button" accessibilityLabel="Отменить видеосообщение" onPress={cancel} hitSlop={8} style={({ pressed }) => ({ flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .6 : 1 })}><Text style={{ color: t.accent, fontSize: 16, fontWeight: '600' }}>Отмена</Text></Pressable>
            : <Text style={{ flex: 1, textAlign: 'center', color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>‹ Влево — отмена</Text>}
        </View>
        {/* Telegram: a big accent circle with a light ring, the icon at once (no spinner while the camera starts). */}
        <View style={{ width: 80, height: 80, alignItems: 'center', justifyContent: 'center', marginRight: -6, marginBottom: -6 }}>
          <View pointerEvents="none" style={{ position: 'absolute', width: 108, height: 108, borderRadius: 54, backgroundColor: t.accent, opacity: .22 }} />
          <Pressable accessibilityRole="button" accessibilityLabel="Отправить видеосообщение" disabled={!hold?.locked || !recording} onPress={() => void stop()} style={({ pressed }) => ({ width: 80, height: 80, borderRadius: 40, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .85 : 1 })}>
            <Icon name={hold?.locked ? 'arrow-up' : 'videocam'} color={t.onAccent} size={hold?.locked ? 34 : 30} />
          </Pressable>
        </View>
      </View>
    </View>
  </View>;
  const body = <View pointerEvents={showControls ? 'auto' : 'none'} style={{ flex: 1, backgroundColor: hold ? 'transparent' : 'rgba(4,6,14,0.96)', alignItems: 'center', justifyContent: hold ? 'flex-start' : 'center', paddingTop: hold ? win.height * 0.12 : 20, gap: 26, padding: 20 }}>
      {recording ? <RecTimer running={!notePaused} getMs={getMs} /> : <Text style={{ color: '#FFF', fontSize: 17, fontWeight: '700' }}>Видеосообщение</Text>}
      <View style={{ width: CIRCLE + 12, height: CIRCLE + 12, borderRadius: (CIRCLE + 12) / 2, padding: 6 }}>
        <NoteRing progress={recProgress} size={CIRCLE + 12} stroke={3} color={t.danger} track="rgba(255,255,255,0.25)" />
        <View style={{ width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, overflow: 'hidden', backgroundColor: t.bg }}>
          {visible && allowed && androidNoteCameraAvailable ? <AndroidNoteCamera ref={nativeRef} facing={facing === 'back' ? 'back' : 'front'} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} onReady={onNativeReady} onCameraError={event => setError(event.nativeEvent.message || 'Камера недоступна.')} /> : visible && allowed ? <CameraView key={Platform.OS === 'ios' ? 'camera' : facing} ref={ref} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} facing={facing} mode="video" ratio="4:3" mirror={facing === 'front'} videoQuality="480p" onCameraReady={() => setReady(true)} onMountError={event => setError(event.message || 'Камера недоступна.')} /> : null}
          {cameraCover}
        </View>
      </View>
      {error ? <Text style={{ color: '#FFB4B4', fontSize: 13, textAlign: 'center', maxWidth: 320 }}>{error}</Text> : <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>{recording ? (hold ? 'Нажми ■, чтобы отправить' : 'Нажми ещё раз, чтобы отправить') : 'До 60 секунд · шифруется перед отправкой'}</Text>}
      {showControls ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 34 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Отменить видеосообщение" onPress={cancel} style={styles.round}><Icon name="close" color="#FFF" size={26} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={recording ? 'Остановить и отправить' : 'Начать запись'} disabled={!allowed || !ready} onPress={() => recording ? void stop() : void start()} style={{ width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: '#FFF', alignItems: 'center', justifyContent: 'center', opacity: !allowed || !ready ? .4 : 1 }}>
          {!ready && allowed ? <ActivityIndicator color="#FFF" /> : <View style={{ width: recording ? 28 : 58, height: recording ? 28 : 58, borderRadius: recording ? 7 : 29, backgroundColor: t.danger }} />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Сменить камеру" onPress={() => { if (recording && !FLIP_WHILE_RECORDING) return; if (!recording && Platform.OS !== 'ios' && !androidNoteCameraAvailable) setReady(false); setError(''); setFacing(value => value === 'front' ? 'back' : 'front'); }} style={[styles.round, { opacity: recording && !FLIP_WHILE_RECORDING ? .3 : 1 }]}><Icon name="camera-reverse-outline" color="#FFF" size={26} /></Pressable>
      </View> : <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>‹ Влево — отмена · вверх — без рук</Text>}
    </View>;
  if (hold) return visible ? <View pointerEvents={showControls ? 'auto' : 'box-none'} style={[StyleSheet.absoluteFill, { zIndex: 50 }]}>
    {/* Never a touch target: while the finger holds the button the chat below must keep receiving it.
        Telegram dims the chat (no heavy blur), fading in with the circle. */}
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }, dim]} />
    {holdBody}
  </View> : null;
  return <Modal visible={visible} animationType="fade" onRequestClose={cancel} statusBarTranslucent>{body}</Modal>;
}

const styles = StyleSheet.create({ round: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' }, small: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' } });

/** Recording time: its own small component ticking by itself, so the camera view and the circle do not re-render. */
function RecTimer({ running, getMs, dot, fine = false }: { running: boolean; getMs: () => number; dot?: string; fine?: boolean }) {
  const [ms, setMs] = useState(() => getMs());
  const read = useRef(getMs); read.current = getMs;
  useEffect(() => {
    setMs(read.current());
    if (!running) return;
    const timer = setInterval(() => setMs(read.current()), fine ? 50 : 250); // 0:04,63 like Telegram
    return () => clearInterval(timer);
  }, [running, fine]);
  if (!fine) return <Text style={{ color: '#FFF', fontSize: 17, fontWeight: '700' }}>{formatVoiceTime(ms)}</Text>;
  return <>
    {dot ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: dot, opacity: running && Math.floor(ms / 600) % 2 ? .25 : 1 }} /> : null}
    <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '500', minWidth: 62, fontVariant: ['tabular-nums'] }}>{formatVoiceTimeFine(ms)}</Text>
  </>;
}

// ---------------------------------------------------------------------------------------------
// Round video message in the chat (Telegram): the first frame at once, a silent loop while on screen,
// a tap plays from the start with sound and the circle grows in place with a thin ring around it.

/** Poster frames made from the decrypted file when the message carried no thumbnail. */
const posters = new Map<string, string>();
let instances = 0;

/** The decoded video. It fills the large circle, which is only ever scaled (a transform), so the surface is never re-laid-out or recreated. */
/** How long a circle takes to grow or shrink (Telegram-like); a listen starts its sound when it has grown. */
const NOTE_GROW_MS = 200;

function NoteVideo({ uri, state, progress, onFirstFrame, onEnd, onSecond, rateHandle, seekHandle }: { uri: string; state: NoteState; progress: SharedValue<number>; onFirstFrame: () => void; onEnd: () => void; onSecond: (sec: number) => void; rateHandle: React.MutableRefObject<((rate: number) => void) | null>; seekHandle: React.MutableRefObject<NoteSeek | null> }) {
  // No progress events while it loops silently: they are switched on only for a listen (applyState).
  const player = useVideoPlayer(uri, value => { value.loop = true; value.muted = true; value.audioMixingMode = 'mixWithOthers'; value.timeUpdateEventInterval = 0; });
  const stateRef = useRef(state); const previous = useRef<NoteState | null>(null);
  stateRef.current = state;
  const last = useRef({ value: 0, at: 0 });
  // Set when a listen restarts from 0: ticks still carrying the old loop position are dropped until a fresh one arrives.
  const restartAt = useRef<number | null>(null);
  useEffect(() => {
    const before = previous.current; previous.current = state;
    if (state === 'sound' && before !== 'paused') { progress.value = 0; last.current = { value: 0, at: 0 }; restartAt.current = Date.now(); }
    // Switching the audio session to playback (doNotMix) blocks the main thread on iOS, which is also where
    // the grow animation runs: done together, the circle stalled small and then jumped. So a listen first
    // holds the first frame while the circle grows, and turns the sound on once it has grown.
    if (state === 'sound' && before !== 'paused' && motionEnabled()) {
      try { player.pause(); player.currentTime = 0; } catch { /* released */ }
      const timer = setTimeout(() => { if (stateRef.current === 'sound') { try { applyState(player, 'sound', before); } catch { /* released */ } } }, NOTE_GROW_MS);
      return () => clearTimeout(timer);
    }
    try { applyState(player, state, before); } catch { /* released */ }
  }, [player, state]);
  useEffect(() => () => { try { player.pause(); } catch { /* released */ } }, [player]);
  // The speed button in the strip under the header changes a listen that is already playing.
  useEffect(() => { rateHandle.current = rate => { try { if (stateRef.current === 'sound' || stateRef.current === 'paused') player.playbackRate = rate; } catch { /* released */ } }; return () => { rateHandle.current = null; }; }, [player]);
  const second = useRef(-1);
  // Rewind along the ring: the video stops on the frame under the finger and goes on from there on release.
  const scrubbing = useRef(false);
  useEffect(() => {
    const seek = (share: number) => {
      const duration = player.duration; if (!(duration > 0)) return;
      const time = share * duration; player.currentTime = time;
      last.current = { value: share, at: Date.now() }; restartAt.current = null;
      const whole = playedSeconds(time, duration); if (whole !== second.current) { second.current = whole; onSecond(whole); }
    };
    seekHandle.current = {
      begin: () => { scrubbing.current = true; try { player.pause(); } catch { /* released */ } },
      to: share => { try { seek(share); } catch { /* released */ } },
      end: share => { scrubbing.current = false; try { seek(share); if (stateRef.current === 'sound') player.play(); } catch { /* released */ } },
    };
    return () => { seekHandle.current = null; };
  }, [player, onSecond]);
  useEffect(() => {
    const end = player.addListener('playToEnd', () => { if (stateRef.current === 'sound') { progress.value = withTiming(1, { duration: 80 }); onEnd(); } });
    // Progress goes to a shared value (throttled): the ring moves, React does not re-render.
    const tick = player.addListener('timeUpdate', ({ currentTime }) => {
      if (stateRef.current !== 'sound' || scrubbing.current) return;
      const now = Date.now();
      if (!freshTick(restartAt.current, currentTime, now, player.playbackRate || 1)) return;
      restartAt.current = null;
      const whole = playedSeconds(currentTime, player.duration);
      if (whole !== second.current) { second.current = whole; onSecond(whole); }
      const next = progressStep(last.current, currentTime, player.duration, now);
      if (next === null) return;
      last.current = { value: next, at: now };
      progress.value = withTiming(next, { duration: 110, easing: Easing.linear });
    });
    return () => { end.remove(); tick.remove(); };
  }, [player, onEnd, onSecond]);
  return <VideoView player={player} pointerEvents="none" style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} allowsVideoFrameAnalysis={false}
    surfaceType="textureView" useExoShutter={false} onFirstFrameRender={onFirstFrame} />;
}

type NoteSeek = { begin: () => void; to: (share: number) => void; end: (share: number) => void };

function applyState(player: VideoPlayer, state: NoteState, before: NoteState | null) {
  player.timeUpdateEventInterval = timeUpdateInterval(state);
  if (state === 'sound') {
    player.muted = false; player.loop = false; player.audioMixingMode = 'doNotMix'; player.playbackRate = currentVoiceRate();
    if (before !== 'paused') player.currentTime = 0;
    player.play(); return;
  }
  if (state === 'paused') { player.pause(); return; }
  // Back in the chat: silent, looping, from the first frame (after a listen) — or still on the first frame.
  player.playbackRate = 1; player.muted = true; player.loop = true; player.audioMixingMode = 'mixWithOthers';
  if (before === 'sound' || before === 'paused') player.currentTime = 0;
  if (state === 'muted') player.play(); else player.pause();
}

/** Mounted only while a circle plays with sound: music stops, and music that starts again takes the sound back. */
function MusicGuard({ onInterrupt }: { onInterrupt: () => void }) {
  const music = useMusic();
  const stop = useRef(music.stop); stop.current = music.stop;
  useEffect(() => { stop.current(); }, []);
  // Music that starts after the circle took the sound (stopped → playing) takes it back.
  const stopped = useRef(!music.playing);
  useEffect(() => { if (!music.playing) stopped.current = true; else if (stopped.current) onInterrupt(); }, [music.playing, onInterrupt]);
  return null;
}

const noSubscription = () => () => {};

/**
 * Round bubble: the encrypted thumbnail at once; downloads by itself (network/power tiers), loops silently
 * while its list reports it on screen; a tap plays with sound.
 * `scope` — the list it lives in (videonote/playback: setVisibleNotes); without one it counts as on screen.
 * `side` — the edge it is anchored to (own messages on the right): it grows away from that edge and the
 * bottom, never sideways. `maxSide` — the real width of its row, so the large circle never overflows it.
 */
export function VideoNoteBubble({ api, attachment, onLongPress, scope = null, side = 'left', maxSide }: { api: Api; attachment: Attachment; onLongPress?: (pageY: number) => void; scope?: string | null; side?: 'left' | 'right'; maxSide?: number }) {
  const t = useTheme(); const { width } = useWindowDimensions();
  const features = usePowerFeatures(); const tier = useNetworkTier();
  const media = useMedia(api, attachment, noteAutoload(attachment.size, tier, features.video));
  const key = useRef(`note${++instances}`).current; // the context-menu preview is a second copy of the same message
  const subscribe = useCallback((listener: () => void) => scope ? subscribeVisibleNotes(listener, scope) : noSubscription(), [scope]);
  const visible = useSyncExternalStore(subscribe, () => isNoteVisible(attachment.id, scope), () => !scope);
  const ready = media.status === 'ready' && !!media.uri;
  const ctx = { ready, autoplay: features.video && motionEnabled(), visible };
  const ctxRef = useRef(ctx); ctxRef.current = ctx;
  const [state, setState] = useState<NoteState>(() => restState(ctx));
  const dispatch = useCallback((event: NoteEvent) => setState(value => reduceNote(value, event, ctxRef.current)), []);
  useEffect(() => { dispatch({ type: 'sync' }); }, [ready, ctx.autoplay, visible]);
  const expanded = isExpanded(state);
  const interrupt = useCallback(() => dispatch({ type: 'interrupt' }), [dispatch]);
  const ended = useCallback(() => dispatch({ type: 'end' }), [dispatch]);
  // Seconds played, under the circle while it is listened to (Telegram); a new listen counts from 0.
  const [elapsed, setElapsed] = useState(0);
  const rateHandle = useRef<((rate: number) => void) | null>(null);
  const toggleListen = useCallback(() => dispatch({ type: 'tap' }), [dispatch]);
  const seekHandle = useRef<NoteSeek | null>(null);
  const [scrub, setScrub] = useState(false);
  const scrubBegin = useCallback(() => { setScrub(true); seekHandle.current?.begin(); }, []);
  const scrubTo = useCallback((share: number) => seekHandle.current?.to(share), []);
  const scrubEnd = useCallback((share: number) => { seekHandle.current?.end(share); setScrub(false); }, []);
  const applyRate = useCallback((rate: number) => rateHandle.current?.(rate), []);
  useEffect(() => {
    if (state === 'sound' || state === 'paused') setNoteBar(key, { key, attachmentId: attachment.id, playing: state === 'sound', toggle: toggleListen, close: interrupt, applyRate });
    else { setNoteBar(key, null); setElapsed(0); }
  }, [state]);
  useEffect(() => () => setNoteBar(key, null), []);
  // One circle with sound at a time; voice messages call interruptNoteAudio() before they play.
  useEffect(() => { if (state === 'sound') { restorePlaybackSession(); claimNoteAudio(key, interrupt); } else if (!expanded) releaseNoteAudio(key); }, [state]);
  useEffect(() => () => releaseNoteAudio(key), []);

  // A tap before the file is there: download and decrypt first, then play with sound from the start.
  const wantSound = useRef(false);
  useEffect(() => { if (ready && wantSound.current) { wantSound.current = false; dispatch({ type: 'tap' }); } }, [ready]);
  // A download that failed or was cancelled (here or elsewhere) drops the wish: a later automatic load stays silent.
  useEffect(() => { if (!keepsSoundRequest(media.status)) wantSound.current = false; }, [media.status]);
  const tap = () => {
    if (!ready) {
      // Telegram: a tap while it loads asks to play when ready; a second tap cancels the download.
      if (media.status === 'loading' && wantSound.current) { wantSound.current = false; media.cancel(); return; }
      wantSound.current = true;
      if (media.status !== 'loading') void media.start().catch(() => { wantSound.current = false; });
      return;
    }
    dispatch({ type: 'tap' });
  };

  // Poster: the thumbnail that came inside the encrypted message, else a frame from the decrypted file.
  const [made, setMade] = useState(() => posters.get(attachment.id) ?? null);
  const thumb = useMemo(() => attachment.preview ? `data:${attachment.preview.mimeType};base64,${attachment.preview.base64}` : made, [attachment.preview, made]);
  useEffect(() => {
    if (attachment.preview || made || !ready || !media.uri || Platform.OS === 'web') return;
    let alive = true;
    void VideoThumbnails.getThumbnailAsync(media.uri, { time: 0, quality: .6 }).then(frame => { posters.set(attachment.id, frame.uri); if (alive) setMade(frame.uri); }).catch(() => {});
    return () => { alive = false; };
  }, [ready, media.uri]);

  // The cover (poster, or a neutral placeholder when there is none — web, no thumbnail) stays above the
  // video until the player has drawn its first frame, after every mount: a circle is never black.
  const [frame, setFrame] = useState(false);
  const mountVideo = ready && (visible || expanded);
  useEffect(() => { if (!mountVideo) setFrame(false); }, [mountVideo]);
  const covered = !(frame && mountVideo);
  const posterOpacity = useSharedValue(1);
  useEffect(() => { posterOpacity.value = covered ? 1 : withTiming(0, { duration: motionEnabled() ? 120 : 0 }); }, [covered]);
  const posterStyle = useAnimatedStyle(() => ({ opacity: posterOpacity.value }));
  const firstFrame = useCallback(() => setFrame(true), []);

  // Telegram: grows in place to min(404, row width). The layout changes once per transition (the slot
  // takes the large size when it opens and gives it back after it has shrunk); in between only a
  // transform runs on the UI thread, anchored at the bottom corner on the message's side, so the circle
  // never moves sideways and the inverted list is not re-laid-out every frame.
  const { collapsed, big, scale: small } = noteSizes(maxSide ?? width - 20);
  const [open, setOpen] = useState(expanded); // the slot is large (and the ring mounted) while expanded or shrinking back
  if (expanded && !open) setOpen(true);
  const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const closed = useCallback(() => { if (!expandedRef.current) setOpen(false); }, []);
  const grow = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    const target = expanded ? 1 : 0;
    if (!motionEnabled() || grow.value === target) { cancelAnimation(grow); grow.value = target; if (!expanded) setOpen(false); return; }
    grow.value = withTiming(target, { duration: NOTE_GROW_MS, easing: Easing.out(Easing.cubic) }, finished => { if (finished && target === 0) runOnJS(closed)(); });
  }, [expanded]);
  const visualStyle = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(grow.value, [0, 1], [small, 1]) }] }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: grow.value }));
  const progress = useSharedValue(0);
  const slot = open ? big : collapsed;
  // Telegram: a drag along the ring rewinds. It starts on the ring band after a few points of movement,
  // so a tap still pauses and a drag from the middle still scrolls the chat.
  const knob = useSharedValue(0); const scrubStart = useSharedValue({ x: 0, y: 0, on: false }); const sent = useSharedValue(0); const live = useSharedValue(false);
  const rewind = useMemo(() => Gesture.Pan().enabled(expanded && open).manualActivation(true)
    .onTouchesDown((event, manager) => {
      const touch = event.allTouches[0];
      if (event.numberOfTouches !== 1 || !touch || !onScrubBand(touch.x, touch.y, big)) { scrubStart.value = { x: 0, y: 0, on: false }; manager.fail(); return; }
      scrubStart.value = { x: touch.x, y: touch.y, on: true };
    })
    .onTouchesMove((event, manager) => {
      const touch = event.allTouches[0]; const from = scrubStart.value;
      if (!touch || !from.on) return;
      if (Math.hypot(touch.x - from.x, touch.y - from.y) > 8) manager.activate();
    })
    .onStart(event => { live.value = true; cancelAnimation(progress); const share = scrubFraction(event.x, event.y, big, null); progress.value = share; sent.value = share; knob.value = withTiming(1, { duration: 120 }); runOnJS(scrubBegin)(); runOnJS(scrubTo)(share); })
    .onUpdate(event => {
      const share = scrubFraction(event.x, event.y, big, progress.value); progress.value = share;
      if (Math.abs(share - sent.value) >= 0.01) { sent.value = share; runOnJS(scrubTo)(share); }
    })
    .onFinalize(() => { if (!live.value) return; live.value = false; knob.value = withTiming(0, { duration: 160 }); runOnJS(scrubEnd)(progress.value); }),
  [expanded, open, big]);
  const knobStyle = useAnimatedStyle(() => {
    const angle = progress.value * 2 * Math.PI, r = big / 2 - 1.5;
    return { opacity: knob.value, transform: [{ translateX: big / 2 + r * Math.sin(angle) - 7 }, { translateY: big / 2 - r * Math.cos(angle) - 7 }] };
  });
  const right = side === 'right';

  const loading = media.status === 'loading';
  return <View style={{ alignSelf: right ? 'flex-end' : 'flex-start', alignItems: right ? 'flex-end' : 'flex-start' }}>
    <GestureDetector gesture={rewind}><Pressable onPress={tap} onLongPress={onLongPress ? event => onLongPress(event.nativeEvent.pageY) : undefined} delayLongPress={400} style={{ width: slot, height: slot }}
      accessibilityRole="button" accessibilityLabel={state === 'sound' ? 'Пауза' : state === 'paused' ? 'Продолжить' : 'Смотреть видеосообщение со звуком'}>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', bottom: 0, [right ? 'right' : 'left']: 0, width: big, height: big, transformOrigin: right ? 'right bottom' : 'left bottom' } as object, visualStyle]}>
        <View style={[StyleSheet.absoluteFill, { borderRadius: big / 2, overflow: 'hidden', backgroundColor: t.surface2 }]}>
          {mountVideo && media.uri ? <NoteVideo uri={media.uri} state={state} progress={progress} onFirstFrame={firstFrame} onEnd={ended} onSecond={setElapsed} rateHandle={rateHandle} seekHandle={seekHandle} /> : null}
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, posterStyle]}>
            {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} />
              : <View style={[StyleSheet.absoluteFill, { backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }]}><Icon name="videocam" size={Math.round(big * .14)} color={t.muted} /></View>}
          </Animated.View>
          {scrub ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.28)' }]} /> : null}
        </View>
        {/* Thin ring at the circle's edge, clockwise from 12 o'clock: mounted only while open or shrinking back. */}
        {open ? <NoteRing progress={progress} size={big} stroke={3} color={t.accent} track="transparent" style={ringStyle} /> : null}
        {open ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: .3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3 }, knobStyle]} /> : null}
      </Animated.View>
      {!ready ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(10,20,35,0.55)', alignItems: 'center', justifyContent: 'center' }}>
          {loading ? <><ProgressRing progress={media.progress} size={44} /><Icon name="close" size={20} color="#FFF" /></> : <Icon name={media.status === 'error' ? 'refresh' : 'arrow-down'} size={22} color="#FFF" />}
        </View>
      </View> : null}
      {state === 'paused' || scrub ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}><View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(10,20,35,0.45)', alignItems: 'center', justifyContent: 'center' }}><Icon name="play" size={26} color="#FFF" /></View></View> : null}
      {/* Telegram: the length in a small pill at the lower left, a small speaker-off mark while it loops silently. */}
      {open && expanded ? <View pointerEvents="none" style={{ position: 'absolute', left: 6, bottom: 6, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.42)' }}>
        <Text style={{ color: '#FFFFFF', fontSize: 12, fontVariant: ['tabular-nums'] }}>{formatVoiceTime(elapsed * 1000)}</Text>
      </View> : null}
      {!open ? <View pointerEvents="none" style={{ position: 'absolute', left: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.42)' }}>
        <Text style={{ color: '#FFFFFF', fontSize: 11 }}>{formatVoiceTime(attachment.media?.durationMs || 0)}</Text>
        {ready ? <Icon name="volume-mute" color="#FFF" size={11} /> : null}
      </View> : null}
    </Pressable></GestureDetector>
    {expanded ? <MusicGuard onInterrupt={interrupt} /> : null}
    {media.status === 'error' && media.error ? <Text style={{ color: t.danger, fontSize: 11, maxWidth: collapsed }}>{media.error}</Text> : null}
  </View>;
}
