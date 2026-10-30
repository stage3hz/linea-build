import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { motionEnabled } from '../motion';
import { CameraView, useCameraPermissions, useMicrophonePermissions, type CameraType } from 'expo-camera';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import { Text } from '../typography';
import { Icon } from '../components';
import { useTheme } from '../theme';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { useMedia } from '../media/mediaCache';
import { ProgressRing } from '../media/MediaBubble';
import { useMusic } from '../music/MusicProvider';
import { VIDEO_NOTE_MAX_MS, formatVoiceTime } from '../voice/voice';

export type VideoNoteTake = { uri: string; durationMs: number };
const CIRCLE = 300;

/** Full-screen recorder for a round video message. Camera and microphone are used only while it is open. */
export function VideoNoteRecorder({ visible, onClose, onDone }: { visible: boolean; onClose: () => void; onDone: (take: VideoNoteTake) => void }) {
  const t = useTheme(); const music = useMusic();
  const [camera, requestCamera] = useCameraPermissions();
  const [mic, requestMic] = useMicrophonePermissions();
  const [facing, setFacing] = useState<CameraType>('front');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const ref = useRef<CameraView>(null);
  const started = useRef(0); const cancelled = useRef(false);

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
    const timer = setInterval(() => setElapsed(Date.now() - started.current), 200);
    return () => clearInterval(timer);
  }, [recording]);

  const start = async () => {
    if (!ref.current || recording || !ready) return;
    cancelled.current = false; setError(''); started.current = Date.now(); setElapsed(0); setRecording(true);
    try {
      const result = await ref.current.recordAsync({ maxDuration: VIDEO_NOTE_MAX_MS / 1000 });
      const durationMs = Math.min(VIDEO_NOTE_MAX_MS, Date.now() - started.current);
      setRecording(false);
      if (cancelled.current || !result?.uri) return;
      if (durationMs < 1000) { setError('Слишком короткое видео — запиши хотя бы секунду.'); return; }
      onDone({ uri: result.uri, durationMs });
    } catch (e) { setRecording(false); if (!cancelled.current) setError(e instanceof Error ? e.message : 'Не удалось записать видео.'); }
  };
  const stop = () => { if (recording) ref.current?.stopRecording(); };
  const cancel = () => { cancelled.current = true; if (recording) ref.current?.stopRecording(); onClose(); };
  const allowed = !!camera?.granted && !!mic?.granted;
  const progress = Math.min(1, elapsed / VIDEO_NOTE_MAX_MS);

  return <Modal visible={visible} animationType="fade" onRequestClose={cancel} statusBarTranslucent>
    <View style={{ flex: 1, backgroundColor: 'rgba(4,6,14,0.96)', alignItems: 'center', justifyContent: 'center', gap: 26, padding: 20 }}>
      <Text style={{ color: '#FFF', fontSize: 17, fontWeight: '700' }}>{recording ? formatVoiceTime(elapsed) : 'Видеосообщение'}</Text>
      <View style={{ width: CIRCLE + 12, height: CIRCLE + 12, borderRadius: (CIRCLE + 12) / 2, padding: 6, borderWidth: 3, borderColor: recording ? t.danger : 'rgba(255,255,255,0.25)' }}>
        <View style={{ width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, overflow: 'hidden', backgroundColor: '#000' }}>
          {visible && allowed ? <CameraView key={facing} ref={ref} style={{ position: 'absolute', left: 0, top: -CIRCLE / 6, width: CIRCLE, height: CIRCLE * 4 / 3 }} facing={facing} mode="video" ratio="4:3" mirror={facing === 'front'} videoQuality="480p" onCameraReady={() => setReady(true)} onMountError={event => setError(event.message || 'Камера недоступна.')} /> : null}
        </View>
        {recording ? <View pointerEvents="none" style={{ position: 'absolute', left: 6, right: 6, bottom: -14, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' }}><View style={{ width: `${progress * 100}%`, height: 4, borderRadius: 2, backgroundColor: t.danger }} /></View> : null}
      </View>
      {error ? <Text style={{ color: '#FFB4B4', fontSize: 13, textAlign: 'center', maxWidth: 320 }}>{error}</Text> : <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>{recording ? 'Нажми ещё раз, чтобы отправить' : 'До 60 секунд · шифруется перед отправкой'}</Text>}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 34 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Отменить видеосообщение" onPress={cancel} style={styles.round}><Icon name="close" color="#FFF" size={26} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={recording ? 'Остановить и отправить' : 'Начать запись'} disabled={!allowed || !ready} onPress={() => recording ? stop() : void start()} style={{ width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: '#FFF', alignItems: 'center', justifyContent: 'center', opacity: !allowed || !ready ? .4 : 1 }}>
          {!ready && allowed ? <ActivityIndicator color="#FFF" /> : <View style={{ width: recording ? 28 : 58, height: recording ? 28 : 58, borderRadius: recording ? 7 : 29, backgroundColor: t.danger }} />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Сменить камеру" onPress={() => { if (recording) return; setReady(false); setError(''); setFacing(value => value === 'front' ? 'back' : 'front'); }} style={[styles.round, { opacity: recording ? .3 : 1 }]}><Icon name="camera-reverse-outline" color="#FFF" size={26} /></Pressable>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({ round: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' } });

/** Telegram circle: plays silently in a loop in the chat; a tap enlarges it and plays from the start with sound. */
function CirclePlayer({ uri, size, expanded, onToggle, onEnd }: { uri: string; size: number; expanded: boolean; onToggle: () => void; onEnd: () => void }) {
  const player = useVideoPlayer(uri, value => { value.loop = true; value.muted = true; value.audioMixingMode = 'mixWithOthers'; });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    try {
      if (expanded) { player.muted = false; player.loop = false; player.audioMixingMode = 'doNotMix'; player.currentTime = 0; player.play(); }
      else { player.muted = true; player.loop = true; player.audioMixingMode = 'mixWithOthers'; if (motionEnabled()) player.play(); else player.pause(); }
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
  const size = expanded ? Math.min(width - 36, 340) : 220;
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
