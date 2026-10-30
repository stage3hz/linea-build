import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Vibration, View, useWindowDimensions } from 'react-native';
import * as Crypto from 'expo-crypto';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Text } from '../typography';
import { Avatar, Icon, type IconName } from '../components';
import type { Api } from '../api';
import type { Chat, Message, User } from '../types';
import type { MessengerStore } from '../useMessenger';
import { useMusic } from '../music/MusicProvider';
import { impactFeedback, lightFeedback } from '../haptics';
import { GATHER_TIMEOUT_MS, RING_TIMEOUT_MS, callClock, keyEmoji, keyMaterial, offerIsFresh, type CallStatus } from './callModel';

// Native modules are loaded lazily: the web build and old builds without them keep working.
type WebRTC = typeof import('react-native-webrtc');
const loadRtc = (): WebRTC | null => { try { return require('react-native-webrtc'); } catch { return null; } };
const loadInCall = (): any => { try { return require('react-native-incall-manager').default; } catch { return null; } };

type CallState = {
  id: string; chat: Chat; peer: User; incoming: boolean; video: boolean; status: CallStatus;
  muted: boolean; speaker: boolean; cameraOff: boolean; startedAt: number | null; endedText: string; key: string[] | null;
  localUrl: string | null; remoteUrl: string | null; remoteSdp?: string; minimized?: boolean;
};
type CallApi = { start: (chat: Chat, video: boolean) => void; available: boolean; busy: boolean };
const CallContext = createContext<CallApi>({ start: () => {}, available: false, busy: false });
export const useCalls = () => useContext(CallContext);

export function CallProvider({ api, store, me, children }: { api: Api; store: MessengerStore; me: User; children: React.ReactNode }) {
  const music = useMusic();
  const [call, setCall] = useState<CallState | null>(null);
  const callRef = useRef<CallState | null>(null); callRef.current = call;
  const pc = useRef<any>(null); const local = useRef<any>(null);
  const seen = useRef(new Set<string>());
  const ringTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const storeRef = useRef(store); storeRef.current = store;
  const rtc = useRef<WebRTC | null>(null); if (rtc.current === null) rtc.current = loadRtc();
  const inCall = useRef<any>(null); if (inCall.current === null) inCall.current = loadInCall();

  const patch = (change: Partial<CallState>) => setCall(current => current ? { ...current, ...change } : current);
  const signal = (chatId: string, action: Parameters<MessengerStore['sendAction']>[1]) => storeRef.current.sendAction(chatId, action);

  const cleanup = useCallback(() => {
    if (ringTimer.current) clearTimeout(ringTimer.current);
    try { inCall.current?.stopRingtone?.(); inCall.current?.stop?.(); } catch { /* optional */ }
    Vibration.cancel();
    try { local.current?.getTracks().forEach((track: any) => track.stop()); } catch { /* released */ }
    try { pc.current?.close(); } catch { /* closed */ }
    pc.current = null; local.current = null;
  }, []);

  const finish = useCallback((text: string, notify?: 'hangup' | 'declined' | 'busy' | 'missed' | 'failed') => {
    const current = callRef.current; if (!current) return;
    if (notify) signal(current.chat.id, { type: 'call', call: current.id, step: 'end', reason: notify });
    cleanup();
    setCall({ ...current, status: 'ended', endedText: text, localUrl: null, remoteUrl: null });
    setTimeout(() => setCall(value => value?.id === current.id && value.status === 'ended' ? null : value), 1600);
  }, [cleanup]);

  const prepare = useCallback(async (video: boolean) => {
    const webrtc = rtc.current; if (!webrtc) throw new Error('Звонки появятся после установки новой сборки приложения.');
    let iceServers: any[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
    try { iceServers = (await api.callIce()).iceServers; } catch { /* public STUN only */ }
    const connection: any = new webrtc.RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' } as any);
    const stream = await webrtc.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: 'user', width: 640, height: 480, frameRate: 30 } : false } as any);
    stream.getTracks().forEach((track: any) => connection.addTrack(track, stream));
    connection.addEventListener('track', (event: any) => { const remote = event.streams?.[0]; if (remote) patch({ remoteUrl: remote.toURL() }); });
    connection.addEventListener('connectionstatechange', () => {
      const state = connection.connectionState;
      if (state === 'connected') { const c = callRef.current; if (c && c.status !== 'active') { lightFeedback(); patch({ status: 'active', startedAt: Date.now() }); } }
      else if (state === 'failed') finish('Не удалось соединиться', 'failed');
    });
    pc.current = connection; local.current = stream;
    return { connection, localUrl: video ? stream.toURL() : null };
  }, [api, finish]);

  // Non-trickle ICE: wait (briefly) until the candidates are inside the SDP, then send one message.
  const gathered = (connection: any) => new Promise<string>(resolve => {
    const done = () => resolve(connection.localDescription?.sdp || '');
    if (connection.iceGatheringState === 'complete') return done();
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    connection.addEventListener('icegatheringstatechange', () => { if (connection.iceGatheringState === 'complete') { clearTimeout(timer); done(); } });
  });

  const computeKey = async (localSdp: string, remoteSdp: string) => {
    const material = keyMaterial(localSdp, remoteSdp); if (!material) return;
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, material);
    patch({ key: keyEmoji(digest) });
  };

  const start = useCallback((chat: Chat, video: boolean) => {
    if (callRef.current) return;
    const id = Crypto.randomUUID(); seen.current.add(id); music.stop(); impactFeedback();
    setCall({ id, chat, peer: chat.peer, incoming: false, video, status: 'requesting', muted: false, speaker: video, cameraOff: false, startedAt: null, endedText: '', key: null, localUrl: null, remoteUrl: null });
    void (async () => {
      try {
        try { inCall.current?.start?.({ media: video ? 'video' : 'audio', ringback: '_DTMF_' }); inCall.current?.setForceSpeakerphoneOn?.(video); } catch { /* optional */ }
        const { connection, localUrl } = await prepare(video);
        patch({ localUrl });
        await connection.setLocalDescription(await connection.createOffer({}));
        const sdp = await gathered(connection);
        if (callRef.current?.id !== id) return;
        signal(chat.id, { type: 'call', call: id, step: 'offer', video, sdp });
        patch({ status: 'ringing' });
        ringTimer.current = setTimeout(() => { if (callRef.current?.id === id && callRef.current.status === 'ringing') finish('Нет ответа', 'missed'); }, RING_TIMEOUT_MS);
      } catch (error) { finish(error instanceof Error ? error.message : 'Не удалось начать звонок'); }
    })();
  }, [music, prepare, finish]);

  const accept = useCallback(async () => {
    const current = callRef.current; if (!current || current.status !== 'incoming' || !current.remoteSdp) return;
    try { inCall.current?.stopRingtone?.(); } catch { /* optional */ }
    Vibration.cancel(); music.stop(); lightFeedback();
    patch({ status: 'connecting' });
    try {
      try { inCall.current?.start?.({ media: current.video ? 'video' : 'audio' }); inCall.current?.setForceSpeakerphoneOn?.(current.video); } catch { /* optional */ }
      const webrtc = rtc.current!;
      const { connection, localUrl } = await prepare(current.video);
      patch({ localUrl });
      await connection.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'offer', sdp: current.remoteSdp }));
      await connection.setLocalDescription(await connection.createAnswer());
      const sdp = await gathered(connection);
      if (callRef.current?.id !== current.id) return;
      signal(current.chat.id, { type: 'call', call: current.id, step: 'answer', sdp });
      void computeKey(sdp, current.remoteSdp);
    } catch (error) { finish(error instanceof Error ? error.message : 'Не удалось ответить', 'failed'); }
  }, [music, prepare, finish]);

  // Incoming signals from the encrypted message stream.
  useEffect(() => store.onCallSignal((message: Message) => {
    const action = message.meta?.action; if (!action || action.type !== 'call') return;
    const current = callRef.current;
    if (action.step === 'offer' && current && current.id === action.call && current.status !== 'incoming' && action.sdp) {
      // Mid-call change (the other side turned the camera on): answer the new offer on the same connection.
      const webrtc = rtc.current; const connection = pc.current; if (!webrtc || !connection) return;
      if (action.video && !current.video) patch({ video: true });
      void (async () => {
        try {
          await connection.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'offer', sdp: action.sdp! }));
          await connection.setLocalDescription(await connection.createAnswer());
          const sdp = await gathered(connection);
          signal(current.chat.id, { type: 'call', call: current.id, step: 'answer', sdp });
        } catch { /* keep the call going without video */ }
      })();
      return;
    }
    if (action.step === 'offer') {
      if (!offerIsFresh(message.createdAt, Date.now(), seen.current, action.call)) return;
      seen.current.add(action.call);
      const chat = storeRef.current.chats.find(c => c.id === message.chatId); if (!chat) return;
      if (current) { signal(chat.id, { type: 'call', call: action.call, step: 'end', reason: 'busy' }); return; }
      setCall({ id: action.call, chat, peer: chat.peer, incoming: true, video: !!action.video, status: 'incoming', muted: false, speaker: !!action.video, cameraOff: false, startedAt: null, endedText: '', key: null, localUrl: null, remoteUrl: null, remoteSdp: action.sdp });
      try { inCall.current?.startRingtone?.('_DEFAULT_', [0, 600, 900], 'playback', 45); } catch { Vibration.vibrate([0, 600, 900], true); }
      ringTimer.current = setTimeout(() => { if (callRef.current?.id === action.call && callRef.current.status === 'incoming') finish('Пропущенный звонок'); }, RING_TIMEOUT_MS);
      return;
    }
    if (!current || current.id !== action.call) return;
    if (action.step === 'answer' && action.sdp && (current.status === 'active' || current.status === 'connecting') && pc.current?.signalingState === 'have-local-offer') {
      const webrtc = rtc.current; if (webrtc) void pc.current.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'answer', sdp: action.sdp })).catch(() => {});
      return;
    }
    if (action.step === 'answer' && !current.incoming && action.sdp) {
      if (ringTimer.current) clearTimeout(ringTimer.current);
      try { inCall.current?.stopRingback?.(); } catch { /* optional */ }
      patch({ status: 'connecting', remoteSdp: action.sdp });
      const webrtc = rtc.current; const connection = pc.current;
      if (webrtc && connection) void connection.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'answer', sdp: action.sdp }))
        .then(() => computeKey(connection.localDescription?.sdp || '', action.sdp!)).catch(() => finish('Не удалось соединиться', 'failed'));
      return;
    }
    if (action.step === 'end') finish(action.reason === 'declined' ? 'Звонок отклонён' : action.reason === 'busy' ? 'Собеседник занят' : action.reason === 'missed' ? 'Пропущенный звонок' : 'Звонок завершён');
  }), [store.onCallSignal, finish]);

  useEffect(() => cleanup, [cleanup]);

  // Turn the camera on during an audio call: add a video track and renegotiate (offer inside the same call).
  const enableVideo = async () => {
    const c = callRef.current; const webrtc = rtc.current; const connection = pc.current;
    if (!c || !webrtc || !connection || c.status !== 'active') return;
    try {
      const stream: any = await webrtc.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480, frameRate: 30 } } as any);
      const track = stream.getVideoTracks()[0]; if (!track) return;
      local.current?.addTrack?.(track); connection.addTrack(track, local.current || stream);
      try { inCall.current?.setForceSpeakerphoneOn?.(true); } catch { /* optional */ }
      patch({ video: true, cameraOff: false, speaker: true, localUrl: (local.current || stream).toURL() });
      await connection.setLocalDescription(await connection.createOffer({}));
      const sdp = await gathered(connection);
      signal(c.chat.id, { type: 'call', call: c.id, step: 'offer', video: true, sdp });
      lightFeedback();
    } catch { /* camera unavailable — the call goes on with audio */ }
  };
  const controls = {
    minimize: () => patch({ minimized: true }),
    restore: () => patch({ minimized: false }),
    hangup: () => { const c = callRef.current; if (!c) return; finish(c.status === 'incoming' ? 'Звонок отклонён' : 'Звонок завершён', c.status === 'incoming' ? 'declined' : 'hangup'); },
    accept: () => void accept(),
    mute: () => { const c = callRef.current; if (!c) return; local.current?.getAudioTracks().forEach((t: any) => { t.enabled = c.muted; }); patch({ muted: !c.muted }); lightFeedback(); },
    speaker: () => { const c = callRef.current; if (!c) return; try { inCall.current?.setForceSpeakerphoneOn?.(!c.speaker); } catch { /* optional */ } patch({ speaker: !c.speaker }); lightFeedback(); },
    camera: () => {
      const c = callRef.current; if (!c) return;
      if (!local.current?.getVideoTracks().length) { void enableVideo(); return; }
      if (!c.video) return; local.current?.getVideoTracks().forEach((t: any) => { t.enabled = c.cameraOff; }); patch({ cameraOff: !c.cameraOff }); lightFeedback(); },
    flip: () => { local.current?.getVideoTracks().forEach((t: any) => { try { t._switchCamera(); } catch { /* single camera */ } }); lightFeedback(); },
  };

  return <CallContext.Provider value={{ start, available: !!rtc.current, busy: !!call }}>
    {children}
    {call && !call.minimized ? <CallScreen call={call} api={api} rtc={rtc.current} {...controls} /> : null}
    {call && call.minimized ? <CallBanner call={call} onPress={controls.restore} onHangup={controls.hangup} /> : null}
  </CallContext.Provider>;
}

function Pulse({ size, active }: { size: number; active: boolean }) {
  const v = useSharedValue(0);
  useEffect(() => { v.value = active ? withRepeat(withTiming(1, { duration: 1400, easing: Easing.out(Easing.quad) }), -1, false) : 0; }, [active]);
  const style = useAnimatedStyle(() => ({ opacity: active ? 0.45 * (1 - v.value) : 0, transform: [{ scale: 1 + v.value * 0.35 }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: 'rgba(255,255,255,0.35)' }, style]} />;
}

function CallButton({ icon, label, onPress, active = false, color }: { icon: IconName; label: string; onPress: () => void; active?: boolean; color?: string }) {
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => ({ alignItems: 'center', gap: 7, opacity: pressed ? .7 : 1, width: 76 })}>
    <View style={{ width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center', backgroundColor: color || (active ? '#FFFFFF' : 'rgba(255,255,255,0.22)') }}><Icon name={icon} size={27} color={color ? '#FFF' : active ? '#1B2440' : '#FFF'} /></View>
    <Text style={{ color: '#FFF', fontSize: 12 }}>{label}</Text>
  </Pressable>;
}

function CallScreen({ call, api, rtc, hangup, accept, mute, speaker, camera, flip, minimize }: { call: CallState; api: Api; rtc: WebRTC | null; hangup: () => void; accept: () => void; mute: () => void; speaker: () => void; camera: () => void; flip: () => void; minimize: () => void; restore?: () => void }) {
  const insets = useSafeAreaInsets(); const { width } = useWindowDimensions();
  const [, tick] = useState(0);
  useEffect(() => { if (call.status !== 'active') return; const timer = setInterval(() => tick(v => v + 1), 1000); return () => clearInterval(timer); }, [call.status]);
  const status = call.status === 'requesting' ? 'Запрос…' : call.status === 'ringing' ? 'Вызов…' : call.status === 'incoming' ? (call.video ? 'Входящий видеозвонок' : 'Входящий звонок') : call.status === 'connecting' ? 'Соединение…' : call.status === 'active' ? callClock(Date.now() - (call.startedAt || Date.now())) : call.endedText;
  const View_ = rtc?.RTCView as any;
  const showVideo = call.video && call.remoteUrl && View_;
  return <Modal visible transparent={false} animationType="slide" onRequestClose={() => {}} statusBarTranslucent supportedOrientations={['portrait']}>
    <LinearGradient colors={call.status === 'active' ? ['#2C8C6E', '#3B6FB6', '#5A55B8'] : ['#5B5FD6', '#6E59C9', '#8A5BC8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
    {showVideo ? <View_ streamURL={call.remoteUrl} objectFit="cover" style={StyleSheet.absoluteFill} /> : null}
    <View style={{ flex: 1, paddingTop: insets.top + 10, paddingBottom: insets.bottom + 24 }}>
      {call.status !== 'incoming' && call.status !== 'ended' ? <Pressable onPress={minimize} accessibilityRole="button" accessibilityLabel="Свернуть звонок" hitSlop={10} style={{ position: 'absolute', left: 16, top: insets.top + 6, zIndex: 3, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.2)', alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-down" size={24} color="#FFF" /></Pressable> : null}
      <View style={{ alignItems: 'center', minHeight: 34 }}>
        {call.key ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.18)' }}><Icon name="lock-closed" size={13} color="#FFF" /><Text style={{ color: '#FFF', fontSize: 15, letterSpacing: 2 }}>{call.key.join(' ')}</Text></View> : <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>🔒 Звонок защищён сквозным шифрованием</Text>}
      </View>
      {showVideo ? <View style={{ flex: 1 }} /> : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <View style={{ alignItems: 'center', justifyContent: 'center', width: 170, height: 170 }}><Pulse size={140} active={call.status === 'ringing' || call.status === 'incoming' || call.status === 'requesting'} /><View style={{ borderRadius: 70, overflow: 'hidden' }}><Avatar user={call.peer} api={api} size={130} /></View></View>
        <Text style={{ color: '#FFF', fontSize: 28, fontWeight: '700' }}>{call.peer.displayName}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16 }}>{status}</Text>
      </View>}
      {showVideo ? <View style={{ alignItems: 'center', marginBottom: 14 }}><Text style={{ color: '#FFF', fontSize: 18, fontWeight: '700' }}>{call.peer.displayName}</Text><Text style={{ color: 'rgba(255,255,255,0.85)' }}>{status}</Text></View> : null}
      {call.video && call.localUrl && View_ && !call.cameraOff ? <Pressable onPress={flip} style={{ position: 'absolute', right: 16, top: insets.top + 56, width: width * .28, height: width * .28 * 4 / 3, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' }}><View_ streamURL={call.localUrl} objectFit="cover" mirror zOrder={1} style={{ flex: 1 }} /></Pressable> : null}
      {call.status === 'incoming' ? <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 30 }}>
        <CallButton icon="close" label="Отклонить" onPress={hangup} color="#FF3B30" />
        <CallButton icon={call.video ? 'videocam' : 'call'} label="Ответить" onPress={accept} color="#34C759" />
      </View> : call.status === 'ended' ? null : <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 8 }}>
        <CallButton icon="volume-high" label="Динамик" onPress={speaker} active={call.speaker} />
        <CallButton icon={call.video && !call.cameraOff ? 'videocam' : 'videocam-off'} label="Видео" onPress={camera} active={call.video && !call.cameraOff} />
        <CallButton icon={call.muted ? 'mic-off' : 'mic'} label={call.muted ? 'Звук выкл' : 'Убрать звук'} onPress={mute} active={call.muted} />
        <CallButton icon="close" label="Завершить" onPress={hangup} color="#FF3B30" />
      </View>}
    </View>
  </Modal>;
}

export const callsSupported = Platform.OS !== 'web';

/** Telegram-style strip while the call is minimized: tap to return, the app stays usable. */
function CallBanner({ call, onPress, onHangup }: { call: CallState; onPress: () => void; onHangup: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(v => v + 1), 1000); return () => clearInterval(timer); }, []);
  const status = call.status === 'active' ? callClock(Date.now() - (call.startedAt || Date.now())) : call.status === 'ended' ? call.endedText : 'Соединение…';
  return <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50 }}>
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Вернуться к звонку: ${call.peer.displayName}, ${status}`} style={{ marginHorizontal: 10, marginTop: 2, height: 36, borderRadius: 18, backgroundColor: call.status === 'active' ? '#2BA36B' : '#3B6FB6', flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 4, gap: 8, shadowColor: '#000', shadowOpacity: .25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }}>
      <Icon name={call.video ? 'videocam' : 'call'} size={16} color="#FFF" />
      <Text numberOfLines={1} style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}>{call.peer.displayName} · {status}</Text>
      <Pressable onPress={onHangup} accessibilityRole="button" accessibilityLabel="Завершить звонок" hitSlop={6} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: '#FF3B30', alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={16} color="#FFF" /></Pressable>
    </Pressable>
  </View>;
}
