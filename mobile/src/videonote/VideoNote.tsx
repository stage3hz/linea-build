import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { LinearTransition, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { motionEnabled } from '../motion';
import { CameraView, useCameraPermissions, useMicrophonePermissions, type CameraType } from 'expo-camera';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import { BlurView } from 'expo-blur';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Text } from '../typography';
import { Icon } from '../components';
import { useTheme } from '../theme';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { useMedia } from '../media/mediaCache';
import { ProgressRing } from '../media/MediaBubble';
import { setCenterStage } from '../media/centerStage';
import { currentVoiceRate } from '../voice/VoiceMessage';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidNoteCamera, androidNoteCameraAvailable, type AndroidNoteCameraHandle } from './androidCamera';
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

/** Full-screen recorder for a round video message. Camera and microphone are used only while it is open. */
/**
 * `hold`: Telegram mode — recording starts by itself while the finger holds the composer button,
 * `stop`/`cancel` counters come from that button, and the circle floats over the blurred chat
 * (no separate screen, so the finger's touch is not interrupted). After a lock the buttons appear.
 */
// Telegram turns Center Stage off for video messages; we start with it off and remember a change.
let centerStageWanted = false;
export type VideoHold = { stop: number; cancel: number; locked: boolean };
export function VideoNoteRecorder({ visible, onClose, onDone, hold = null }: { visible: boolean; onClose: () => void; onDone: (take: VideoNoteTake) => void; hold?: VideoHold | null }) {
  const win = useWindowDimensions();
  const t = useTheme(); const music = useMusic();
  const [camera, requestCamera] = useCameraPermissions();
  const [mic, requestMic] = useMicrophonePermissions();
  const [facing, setFacing] = useState<CameraType>('front');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const ref = useRef<CameraView>(null);
  const nativeRef = useRef<AndroidNoteCameraHandle>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Center Stage (iPhone 17 family): the front camera keeps the face in frame while you move.
  const [stage, setStage] = useState<{ supported: boolean; enabled: boolean }>({ supported: false, enabled: false });
  // The user's choice is remembered (it used to be forced on every time the recorder opened).
  useEffect(() => { if (visible) void setCenterStage(centerStageWanted).then(setStage); }, [visible]);
  const toggleStage = () => { centerStageWanted = !stage.enabled; void setCenterStage(centerStageWanted).then(setStage); };
  const started = useRef(0); const cancelled = useRef(false);
  // Pause (Telegram, hands-free): paused time is not counted in the timer, the ring or the 60 s limit.
  const [notePaused, setNotePaused] = useState(false); const pausedAt = useRef(0); const pausedTotal = useRef(0);
  const activeMs = () => Date.now() - started.current - pausedTotal.current - (pausedAt.current ? Date.now() - pausedAt.current : 0);

  useEffect(() => {
    if (!visible) { setReady(false); setRecording(false); setElapsed(0); setError(''); return; }
    music.stop();
    (async () => {
      const c = camera?.granted ? camera : await requestCamera();
      const m = mic?.granted ? mic : await requestMic();
      if (!c.granted || !m.granted) setError('Нужен доступ к камере и микрофону. Разреши их для Инвиза в настройках телефона.');
    })().catch(() => setError('Не удалось запросить доступ к камере.'));
  }, [visible]);
  useEffect(() => {
    if (!recording) return;
    if (notePaused) return;
    const timer = setInterval(() => setElapsed(activeMs()), hold ? 50 : 200); // hold: 0:04,63 like Telegram
    return () => clearInterval(timer);
  }, [recording, notePaused]);

  const finishTake = (uri: string | undefined) => {
    const durationMs = Math.min(VIDEO_NOTE_MAX_MS, activeMs());
    setRecording(false);
    if (cancelled.current || !uri) return;
    if (durationMs < 1000) { if (hold) { onClose(); return; } setError('Слишком короткое видео — запиши хотя бы секунду.'); return; }
    onDone({ uri, durationMs });
  };
  const start = async () => {
    if (recording || !ready) return;
    cancelled.current = false; setError(''); started.current = Date.now(); pausedAt.current = 0; pausedTotal.current = 0; setNotePaused(false); setElapsed(0); setRecording(true);
    if (androidNoteCameraAvailable) {
      try {
        await nativeRef.current?.startRecording(`${FileSystem.cacheDirectory}videonote-${Date.now()}.mp4`);
        limit.current = setTimeout(() => void stop(), VIDEO_NOTE_MAX_MS);
      } catch (e) { setRecording(false); setError(e instanceof Error ? e.message : 'Не удалось начать запись.'); }
      return;
    }
    if (!ref.current) { setRecording(false); return; }
    try {
      const result = await ref.current.recordAsync({ maxDuration: VIDEO_NOTE_MAX_MS / 1000 });
      finishTake(result?.uri);
    } catch (e) { setRecording(false); if (!cancelled.current) setError(e instanceof Error ? e.message : 'Не удалось записать видео.'); }
  };
  const stop = async () => {
    if (limit.current) { clearTimeout(limit.current); limit.current = undefined; }
    if (androidNoteCameraAvailable) {
      try { finishTake(await nativeRef.current?.stopRecording()); }
      catch (e) { setRecording(false); if (!cancelled.current) setError(e instanceof Error ? e.message : 'Не удалось записать видео.'); }
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
    else { pausedTotal.current += Date.now() - pausedAt.current; pausedAt.current = 0; limit.current = setTimeout(() => void stop(), Math.max(0, VIDEO_NOTE_MAX_MS - activeMs())); }
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
  // iPhone reports «ready» a moment before the first video frames reach the file output; starting at once
  // could produce a take with a black picture (audio only). A short pause, as the finger is still down anyway.
  useEffect(() => {
    if (!(visible && hold && ready && allowed && !recording && !autoStarted.current)) return;
    const timer = setTimeout(() => { if (!autoStarted.current) { autoStarted.current = true; void start(); } }, Platform.OS === 'ios' ? 450 : 150);
    return () => clearTimeout(timer);
  }, [visible, hold, ready, allowed, recording]);
  const stopSeen = useRef(hold?.stop ?? 0), cancelSeen = useRef(hold?.cancel ?? 0);
  useEffect(() => { if (!hold) return; if (hold.stop !== stopSeen.current) { stopSeen.current = hold.stop; if (recording) void stop(); else onClose(); } }, [hold?.stop]);
  useEffect(() => { if (!hold) return; if (hold.cancel !== cancelSeen.current) { cancelSeen.current = hold.cancel; cancel(); } }, [hold?.cancel]);
  const progress = Math.min(1, elapsed / VIDEO_NOTE_MAX_MS);
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
  const flip = () => { const now = Date.now(); if (now - lastFlip.current < 1000) return; lastFlip.current = now; lightFeedback(); if (recording && !FLIP_WHILE_RECORDING) return; setFlipping(true); setZoom(0); setTimeout(() => setFlipping(false), 450); if (!recording && Platform.OS !== 'ios' && !androidNoteCameraAvailable) setReady(false); setError(''); setFacing(value => value === 'front' ? 'back' : 'front'); };
  const preview = visible && allowed && androidNoteCameraAvailable ? <AndroidNoteCamera ref={nativeRef} zoom={zoom} facing={facing === 'back' ? 'back' : 'front'} {...(Platform.OS === 'ios' ? { torch: flash && facing === 'back' } : {})} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} onReady={() => setReady(true)} onCameraError={event => setError(event.nativeEvent.message || 'Камера недоступна.')} /> : visible && allowed ? <CameraView key={Platform.OS === 'ios' ? 'camera' : facing} ref={ref} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} facing={facing} mode="video" ratio="4:3" mirror={facing === 'front'} videoQuality="480p" enableTorch={flash && facing === 'back'} onCameraReady={() => setReady(true)} onMountError={event => setError(event.message || 'Камера недоступна.')} /> : null;
  // Telegram's way while the finger holds (and after a lock): the circle over the blurred chat with a
  // white progress arc around it; at the bottom the same strip as for voice — red dot, 0:04,63,
  // «‹ Влево — отмена» (after a lock: «Отмена»), the big circle on the right (under the finger; after
  // a lock it sends), and the switch-camera button above the strip on the left.
  const RING = CIRCLE + 12;
  // Telegram: the circle grows out of the record button (bottom right) into place.
  const appear = useSharedValue(0);
  useEffect(() => { appear.value = visible && hold ? (motionEnabled() ? withSpring(1, { damping: 17, stiffness: 190 }) : withTiming(1, { duration: 0 })) : 0; }, [visible, !!hold]);
  const grow = useAnimatedStyle(() => ({ opacity: Math.min(1, appear.value * 2), transform: [{ translateX: (1 - appear.value) * win.width * 0.38 }, { translateY: (1 - appear.value) * win.height * 0.42 }, { scale: 0.12 + 0.88 * appear.value }] }));
  const holdBody = <View pointerEvents="box-none" style={{ flex: 1 }}>
    {screenFlash ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#FFF6E8' }]} /> : null}
    <View pointerEvents="box-none" style={{ alignItems: 'center', paddingTop: Math.max(insets.top + 24, win.height * 0.4 - RING / 2), gap: 18 }}>
      <GestureDetector gesture={pinch}>
      <Animated.View style={[{ width: RING, height: RING, alignItems: 'center', justifyContent: 'center' }, grow]}>
        <ProgressRing progress={recording ? progress : 0} size={RING} width={4} color="#FFF" track="rgba(255,255,255,0.16)" />
        <View style={{ width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, overflow: 'hidden', backgroundColor: '#000' }}>
          {preview}
          {/* Telegram: a dark blurred circle while the camera starts, sharp once recording runs. */}
          {flipping || !recording ? <BlurView pointerEvents="none" tint="dark" intensity={flipping ? 80 : ready ? 55 : 90} style={StyleSheet.absoluteFill} /> : null}
          {zoom > 0.02 ? <View pointerEvents="none" style={{ position: 'absolute', bottom: 14, alignSelf: 'center', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.45)' }}><Text style={{ color: '#FFF', fontSize: 12, fontWeight: '700' }}>{(1 + zoom * 5).toFixed(1).replace('.', ',')}×</Text></View> : null}
        </View>
      </Animated.View>
      </GestureDetector>
      {stage.supported && facing === 'front' && showControls ? <Pressable accessibilityRole="switch" accessibilityState={{ checked: stage.enabled }} accessibilityLabel="Слежение за лицом" onPress={toggleStage} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: stage.enabled ? 'rgba(255,214,10,0.18)' : 'rgba(255,255,255,0.1)' }}><Icon name="scan-outline" size={16} color={stage.enabled ? '#FFD60A' : '#FFF'} /><Text style={{ color: stage.enabled ? '#FFD60A' : '#FFF', fontSize: 13, fontWeight: '600' }}>{stage.enabled ? 'В центре кадра' : 'Слежение выкл.'}</Text></Pressable> : null}
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
        <View pointerEvents="box-none" style={{ flex: 1, minHeight: 48, marginBottom: 10, marginRight: -62, paddingRight: 70, borderRadius: 24, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, backgroundColor: 'rgba(28,32,46,0.88)' }}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.danger, opacity: recording && Math.floor(elapsed / 600) % 2 ? .25 : 1 }} />
          <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '500', minWidth: 62, fontVariant: ['tabular-nums'] }}>{formatVoiceTimeFine(elapsed)}</Text>
          {hold?.locked ? <Pressable accessibilityRole="button" accessibilityLabel="Отменить видеосообщение" onPress={cancel} hitSlop={8} style={({ pressed }) => ({ flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .6 : 1 })}><Text style={{ color: t.accent, fontSize: 16, fontWeight: '600' }}>Отмена</Text></Pressable>
            : <Text style={{ flex: 1, textAlign: 'center', color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>‹ Влево — отмена</Text>}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Отправить видеосообщение" disabled={!hold?.locked || !recording} onPress={() => void stop()} style={({ pressed }) => ({ width: 68, height: 68, borderRadius: 34, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .8 : 1 })}>
          {!ready && allowed && !error ? <ActivityIndicator color={t.onAccent} /> : <Icon name={hold?.locked ? 'arrow-up' : 'videocam'} color={t.onAccent} size={hold?.locked ? 30 : 26} />}
        </Pressable>
      </View>
    </View>
  </View>;
  const body = <View pointerEvents={showControls ? 'auto' : 'none'} style={{ flex: 1, backgroundColor: hold ? 'transparent' : 'rgba(4,6,14,0.96)', alignItems: 'center', justifyContent: hold ? 'flex-start' : 'center', paddingTop: hold ? win.height * 0.12 : 20, gap: 26, padding: 20 }}>
      <Text style={{ color: '#FFF', fontSize: 17, fontWeight: '700' }}>{recording ? formatVoiceTime(elapsed) : 'Видеосообщение'}</Text>
      <View style={{ width: CIRCLE + 12, height: CIRCLE + 12, borderRadius: (CIRCLE + 12) / 2, padding: 6, borderWidth: 3, borderColor: recording ? t.danger : 'rgba(255,255,255,0.25)' }}>
        <View style={{ width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, overflow: 'hidden', backgroundColor: '#000' }}>
          {visible && allowed && androidNoteCameraAvailable ? <AndroidNoteCamera ref={nativeRef} facing={facing === 'back' ? 'back' : 'front'} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} onReady={() => setReady(true)} onCameraError={event => setError(event.nativeEvent.message || 'Камера недоступна.')} /> : visible && allowed ? <CameraView key={Platform.OS === 'ios' ? 'camera' : facing} ref={ref} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} facing={facing} mode="video" ratio="4:3" mirror={facing === 'front'} videoQuality="480p" onCameraReady={() => setReady(true)} onMountError={event => setError(event.message || 'Камера недоступна.')} /> : null}
        </View>
        {recording ? <View pointerEvents="none" style={{ position: 'absolute', left: 6, right: 6, bottom: -14, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' }}><View style={{ width: `${progress * 100}%`, height: 4, borderRadius: 2, backgroundColor: t.danger }} /></View> : null}
      </View>
      {stage.supported && facing === 'front' ? <Pressable accessibilityRole="switch" accessibilityState={{ checked: stage.enabled }} accessibilityLabel="Слежение за лицом" onPress={toggleStage} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: stage.enabled ? 'rgba(255,214,10,0.18)' : 'rgba(255,255,255,0.1)' }}><Icon name="scan-outline" size={16} color={stage.enabled ? '#FFD60A' : '#FFF'} /><Text style={{ color: stage.enabled ? '#FFD60A' : '#FFF', fontSize: 13, fontWeight: '600' }}>{stage.enabled ? 'В центре кадра' : 'Слежение выкл.'}</Text></Pressable> : null}
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
    <BlurView tint="dark" intensity={60} style={StyleSheet.absoluteFill} />
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.25)' }]} />
    {holdBody}
  </View> : null;
  return <Modal visible={visible} animationType="fade" onRequestClose={cancel} statusBarTranslucent>{body}</Modal>;
}

const styles = StyleSheet.create({ round: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' }, small: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' } });

/** Telegram circle: plays silently in a loop in the chat; a tap enlarges it and plays from the start with sound. */
function CirclePlayer({ uri, size, expanded, onToggle, onEnd }: { uri: string; size: number; expanded: boolean; onToggle: () => void; onEnd: () => void }) {
  const player = useVideoPlayer(uri, value => { value.loop = true; value.muted = true; value.audioMixingMode = 'mixWithOthers'; });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    try {
      if (expanded) { player.muted = false; player.loop = false; player.audioMixingMode = 'doNotMix'; player.playbackRate = currentVoiceRate(); player.currentTime = 0; player.play(); }
      else { player.playbackRate = 1; player.muted = true; player.loop = true; player.audioMixingMode = 'mixWithOthers'; if (motionEnabled()) player.play(); else player.pause(); }
    } catch { /* released */ }
  }, [player, expanded]);
  useEffect(() => () => { try { player.pause(); } catch { /* released */ } }, [player]);
  useEffect(() => { const sub = player.addListener('playToEnd', onEnd); return () => sub.remove(); }, [player, onEnd]);
  useEffect(() => { if (!expanded) return; const timer = setInterval(() => { try { if (player.duration > 0) setProgress(player.currentTime / player.duration); } catch { /* released */ } }, 200); return () => clearInterval(timer); }, [player, expanded]);
  return <Pressable onPress={() => { if (!expanded) onToggle(); else if (isPlaying) player.pause(); else player.play(); }} onLongPress={expanded ? onToggle : undefined} accessibilityRole="button" accessibilityLabel={expanded ? 'Пауза или продолжить' : 'Смотреть видеосообщение со звуком'} style={{ width: size, height: size }}>
    <VideoView player={player} style={{ width: size, height: size }} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} />
    {expanded ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: size / 2, borderWidth: 3, borderColor: 'rgba(255,255,255,0.18)' }]}><View style={{ position: 'absolute', left: 0, right: 0, bottom: 14, alignItems: 'center' }}><View style={{ width: size * .45, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)' }}><View style={{ width: `${progress * 100}%`, height: 3, borderRadius: 2, backgroundColor: '#FFF' }} /></View></View></View>
      : <View pointerEvents="none" style={{ position: 'absolute', right: 18, bottom: 18, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(10,20,35,0.6)', alignItems: 'center', justifyContent: 'center' }}><Icon name="volume-mute" color="#FFF" size={14} /></View>}
    {expanded && !isPlaying ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}><Icon name="play" color="#FFF" size={40} /></View> : null}
  </Pressable>;
}

/** Round bubble: shows the encrypted thumbnail; a tap decrypts and plays with sound. */
export function VideoNoteBubble({ api, attachment }: { api: Api; attachment: Attachment }) {
  const music = useMusic(); const { width } = useWindowDimensions();
  // Circles are small, so they load by themselves (as in Telegram) and play silently in the chat.
  const media = useMedia(api, attachment, attachment.size <= 8 * 1024 * 1024);
  const [expanded, setExpanded] = useState(false);
  const size = expanded ? Math.min(width - 20, 404) : 212; // Telegram: grows to min(404, width − 20) while playing
  const thumb = useMemo(() => attachment.preview ? `data:${attachment.preview.mimeType};base64,${attachment.preview.base64}` : null, [attachment.preview]);
  const collapse = useCallback(() => setExpanded(false), []);
  const toggle = useCallback(() => setExpanded(value => { if (!value) music.stop(); return !value; }), [music]);
  const load = () => {
    if (media.status === 'loading') { media.cancel(); return; }
    void media.start().then(() => { music.stop(); setExpanded(true); }).catch(() => {});
  };
  return <View style={{ alignItems: 'center', gap: 5 }}>
    <Animated.View layout={LinearTransition.duration(220)} style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: '#11162A' }}>
      {media.status === 'ready' && media.uri ? <CirclePlayer uri={media.uri} size={size} expanded={expanded} onToggle={toggle} onEnd={collapse} /> : <Pressable accessibilityRole="button" accessibilityLabel="Воспроизвести видеосообщение" onPress={load} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(10,20,35,0.6)', alignItems: 'center', justifyContent: 'center' }}>{media.status === 'loading' ? <><ProgressRing progress={media.progress} size={52} /><Icon name="close" size={22} color="#FFF" /></> : <Icon name={media.status === 'error' ? 'refresh' : 'play'} size={24} color="#FFF" />}</View>
      </Pressable>}
    </Animated.View>
    <Text style={{ color: 'rgba(160,170,200,0.9)', fontSize: 11 }}>{formatVoiceTime(attachment.media?.durationMs || 0)}</Text>
    {media.status === 'error' && media.error ? <Text style={{ color: '#FF8A8A', fontSize: 11, maxWidth: size }}>{media.error}</Text> : null}
  </View>;
}
