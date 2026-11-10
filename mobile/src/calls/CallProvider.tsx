import { networkTier } from '../network/quality';
import { audioPrefs, callAudio, callAudioKey, subscribeAudio } from '../audio/devices';
import { onNetworkChange } from '../network/netChange';
import { gateTrack } from '../audio/gate';
import { applyStudio } from '../audio/studioSound';
import { onBindAction, setVoiceActive } from '../audio/binds';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { playCallSound, stopCallSound } from './callSounds';
import { Modal, Platform, Pressable, StyleSheet, Vibration, View, useWindowDimensions } from 'react-native';
import * as Crypto from 'expo-crypto';
import { MusicAmbient } from '../music/MusicAmbient';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as BlurImage } from 'expo-image';
import { useTheme } from '../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Text } from '../typography';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeDismissView, useSwipeDismiss } from '../swipeDismiss';
import { Avatar, Icon, type IconName } from '../components';
import type { Api } from '../api';
import type { Chat, Message, User } from '../types';
import type { MessengerStore } from '../useMessenger';
import { useMusic } from '../music/MusicProvider';
import { setCenterStage } from '../media/centerStage';
import { holdConnection } from '../connectionHold';
import { impactFeedback, lightFeedback } from '../haptics';
import { GATHER_TIMEOUT_MS, RING_TIMEOUT_MS, SEND_BITRATE, callClock, callEndMeta, economySdp, hangupOutcome, incomingAlert, keyEmoji, keyMaterial, offerIsFresh, type CallEndReason, type CallStatus } from './callModel';
import { buildCallHistory, type CallRecord } from './callLog';
import { DISCONNECT_GRACE_MS, LINK_UP, POLITE_EXTRA_MS, linkNext, linkShowsReconnecting, markRestartCapable, remoteRestart, restartAnswerFits, restartCapable, sameFingerprints, stripRestartMarker, type Link, type LinkInput } from './reconnect';
import { onAnswerFromNotification } from '../notifications/desktopNotify';
import { getNotificationPrefs } from '../notifications/prefs';

// Native modules are loaded lazily: the web build and old builds without them keep working.
type WebRTC = typeof import('react-native-webrtc');
const loadRtc = (): WebRTC | null => { try { return require('react-native-webrtc'); } catch { return null; } };
const loadInCall = (): any => { try { return require('react-native-incall-manager').default; } catch { return null; } };

type CallState = {
  id: string; chat: Chat; peer: User; incoming: boolean; video: boolean; status: CallStatus;
  muted: boolean; speaker: boolean; cameraOff: boolean; startedAt: number | null; endedText: string; key: string[] | null;
  localUrl: string | null; remoteUrl: string | null; remoteSdp?: string; minimized?: boolean;
  /** «Восстановление связи…»: the media dropped mid-call and an ICE restart is under way (the clock keeps running). */
  reconnecting?: boolean;
};
/** The microphone of a call: phones always cancel echo, everyone gets noise suppression (switchable) and AGC. */
const PHONE = Platform.OS !== 'web';
/** PC: «Студийный звук (тест)» — the EQ'd microphone goes out instead of the raw one (studioSound.ts). */
const withStudio = (stream: any) => !PHONE && audioPrefs().studioSound ? applyStudio(stream) : stream;
type CallApi = { start: (chat: Chat, video: boolean) => void; available: boolean; busy: boolean;
  /** «Перезвонить» from a call row: the chat is looked up by id (the row knows no Chat object). */
  callBack: (chatId: string, video: boolean) => void };
const CallContext = createContext<CallApi>({ start: () => {}, available: false, busy: false, callBack: () => {} });
export const useCalls = () => useContext(CallContext);
/** История звонков (F9): every finished call this device knows of, from the decrypted message cache, newest first. */
const CallHistoryContext = createContext<CallRecord[]>([]);
export const useCallHistory = () => useContext(CallHistoryContext);

/**
 * Sets our SDP with economy voice on slow links (EDGE/3G): the other phone sends us less, and our
 * own audio sender is capped. Measured link speed decides (src/network/quality.ts).
 */
async function setLocal(connection: any, description: { type: string; sdp: string }, _video: boolean) {
  const tier = networkTier();
  await connection.setLocalDescription({ type: description.type, sdp: economySdp(description.sdp, tier) });
  const cap = SEND_BITRATE[tier];
  if (!cap) return;
  for (const sender of connection.getSenders?.() || []) {
    if (sender.track?.kind !== 'audio' || !sender.getParameters || !sender.setParameters) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = cap;
      await sender.setParameters(params);
    } catch { /* older WebRTC builds: the SDP limit above still applies */ }
  }
}

export function CallProvider({ api, store, me, children }: { api: Api; store: MessengerStore; me: User; children: React.ReactNode }) {
  const music = useMusic();
  const [call, setCall] = useState<CallState | null>(null);
  const callRef = useRef<CallState | null>(null); callRef.current = call;
  // A live call keeps the messenger socket open in the background (connectionHold): its signalling and the server's presence go through it.
  const live = !!call && call.status !== 'ended';
  useEffect(() => (live ? holdConnection('call') : undefined), [live]);
  const pc = useRef<any>(null); const local = useRef<any>(null); const stopGate = useRef<() => void>(() => {}); const hookOn = useRef(false);
  const seen = useRef(new Set<string>());
  const ringTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const storeRef = useRef(store); storeRef.current = store;
  const rtc = useRef<WebRTC | null>(null); if (rtc.current === null) rtc.current = loadRtc();
  // PC binds during a call: mute the microphone; «звук» turns the other person's voice off.
  useEffect(() => onBindAction(action => {
    const c = callRef.current; if (!c || c.status === 'ended') return;
    if (action === 'mute') { local.current?.getAudioTracks().forEach((t: any) => { t.enabled = c.muted; }); patch({ muted: !c.muted }); return; }
    if (action === 'deafen') { for (const receiver of pc.current?.getReceivers?.() || []) if (receiver.track?.kind === 'audio') receiver.track.enabled = !receiver.track.enabled; return; }
    if (action === 'answerCall' && c.status === 'incoming') { void acceptRef.current?.(); return; }
    if (action === 'endCall') hangupRef.current?.();
  }), []);
  const acceptRef = useRef<(() => Promise<void>) | null>(null); const hangupRef = useRef<(() => void) | null>(null);
  // PC: «Ответить» on the system notification (F11) accepts the call that is ringing in that chat, nothing else.
  useEffect(() => onAnswerFromNotification(chatId => {
    const c = callRef.current;
    if (c?.status === 'incoming' && c.chat.id === chatId) void acceptRef.current?.();
  }), []);
  // «Шумоподавление» (Настройки › Уведомления и звуки › Звонки; on the PC also the microphone and echo switches in
  // Звук и микрофон) takes effect at once during a call: a fresh microphone track with the new processing replaces the
  // old one in the sender (replaceTrack: no renegotiation, nothing is signalled). Mute stays as it was.
  useEffect(() => {
    let last = callAudioKey(PHONE);
    return subscribeAudio(() => {
      const input = callAudioKey(PHONE); if (input === last) return; last = input;
      const connection = pc.current, stream = local.current, webrtc = rtc.current;
      const old = stream?.getAudioTracks?.()[0]; if (!connection || !old || !webrtc) return;
      void webrtc.mediaDevices.getUserMedia({ audio: callAudio(PHONE), video: false } as any).then(withStudio).then(async (fresh: any) => {
        const track = fresh.getAudioTracks()[0];
        if (!track || pc.current !== connection) { fresh.getTracks?.().forEach((t: any) => t.stop()); return; }
        track.enabled = old.enabled;
        for (const sender of connection.getSenders?.() || []) if (sender.track === old) await sender.replaceTrack(track).catch(() => {});
        try { stream.removeTrack?.(old); stream.addTrack?.(track); } catch { /* wrapper */ }
        if (Platform.OS === 'web') { stopGate.current(); stopGate.current = gateTrack(track, () => !!callRef.current?.muted); }
        old.stop();
      }).catch(() => {});
    });
  }, []);
  const inCall = useRef<any>(null); if (inCall.current === null) inCall.current = loadInCall();

  const patch = (change: Partial<CallState>) => setCall(current => current ? { ...current, ...change } : current);
  const signal = (chatId: string, action: Parameters<MessengerStore['sendAction']>[1]) => storeRef.current.sendAction(chatId, action);

  // Automatic reconnection (reconnect.ts): the link state machine, its timer and the ICE-restart numbering.
  const link = useRef<Link>(LINK_UP); const linkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Our last restart number, the one we wait an answer for, and the newest one the peer sent. */
  const restartGen = useRef(0); const pendingGen = useRef<number | null>(null); const pendingAt = useRef(0); const lastRemoteGen = useRef(0);
  const restarting = useRef(false);
  const resetLink = () => {
    if (linkTimer.current) clearTimeout(linkTimer.current);
    linkTimer.current = undefined; link.current = LINK_UP; restartGen.current = 0; pendingGen.current = null; lastRemoteGen.current = 0; restarting.current = false;
  };

  const cleanup = useCallback(() => {
    resetLink();
    stopGate.current(); stopGate.current = () => {};
    if (hookOn.current) { hookOn.current = false; setVoiceActive(false); }
    if (ringTimer.current) clearTimeout(ringTimer.current);
    stopCallSound();
    try { inCall.current?.stopRingtone?.(); inCall.current?.stop?.(); } catch { /* optional */ }
    Vibration.cancel();
    try { local.current?.getTracks().forEach((track: any) => track.stop()); } catch { /* released */ }
    try { pc.current?.close(); } catch { /* closed */ }
    pc.current = null; local.current = null;
  }, []);

  const finish = useCallback((text: string, notify?: CallEndReason) => {
    const current = callRef.current; if (!current) return;
    // The `end` carries what both chats show as the service row (F9): how long the call lasted (from the
    // moment the media connected), whether it was video, and whether this phone placed it — all inside the ciphertext.
    // Every `end` this phone sends (here, busy, privacy) goes through the same builder (callModel.callEndMeta).
    if (notify) signal(current.chat.id, callEndMeta(current, notify));
    cleanup();
    setCall({ ...current, status: 'ended', endedText: text, localUrl: null, remoteUrl: null });
    setTimeout(() => setCall(value => value?.id === current.id && value.status === 'ended' ? null : value), 1600);
  }, [cleanup]);

  const prepare = useCallback(async (video: boolean) => {
    const webrtc = rtc.current; if (!webrtc) throw new Error('Звонки появятся после установки новой сборки приложения.');
    let iceServers: any[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
    try { iceServers = (await api.callIce()).iceServers; } catch { /* public STUN only */ }
    const connection: any = new webrtc.RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' } as any);
    if (video) await setCenterStage(true);
    // Noise suppression, echo cancellation and automatic gain (the native WebRTC audio processing on phones).
    const stream = withStudio(await webrtc.mediaDevices.getUserMedia({ audio: callAudio(PHONE), video: video ? { facingMode: 'user', width: 640, height: 480, frameRate: 30 } : false } as any));
    stream.getTracks().forEach((track: any) => connection.addTrack(track, stream));
    connection.addEventListener('track', (event: any) => { const remote = event.streams?.[0]; if (remote) patch({ remoteUrl: remote.toURL() }); });
    connection.addEventListener('connectionstatechange', () => {
      if (pc.current !== connection) return;
      const state = connection.connectionState; const c = callRef.current;
      if (state === 'connected' && c && c.status !== 'active') { resetLink(); lightFeedback(); patch({ status: 'active', startedAt: Date.now() }); return; }
      // Once the call is up, a drop is not the end: «Восстановление связи…», ICE restarts, «Связь потеряна» after 30 s.
      if (c?.status === 'active') { feedLinkRef.current({ kind: 'state', state }); return; }
      if (state === 'failed') finish('Не удалось соединиться', 'failed');
    });
    resetLink();
    pc.current = connection; local.current = stream;
    if (Platform.OS === 'web') { stopGate.current(); stopGate.current = gateTrack(stream.getAudioTracks()[0], () => !!callRef.current?.muted); if (!hookOn.current) { hookOn.current = true; setVoiceActive(true); } }
    return { connection, localUrl: video ? stream.toURL() : null };
  }, [api, finish]);

  // Non-trickle ICE: wait (briefly) until the candidates are inside the SDP, then send one message.
  const gathered = (connection: any) => new Promise<string>(resolve => {
    const done = () => resolve(connection.localDescription?.sdp || '');
    if (connection.iceGatheringState === 'complete') return done();
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    connection.addEventListener('icegatheringstatechange', () => { if (connection.iceGatheringState === 'complete') { clearTimeout(timer); done(); } });
  });

  // After an ICE restart the gathering starts over: wait for that new round (listener set before setLocalDescription).
  const gatheredAgain = (connection: any) => new Promise<string>(resolve => {
    const onChange = () => { if (connection.iceGatheringState === 'complete') done(); };
    const done = () => { clearTimeout(timer); connection.removeEventListener?.('icegatheringstatechange', onChange); resolve(connection.localDescription?.sdp || ''); };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    connection.addEventListener('icegatheringstatechange', onChange);
  });

  /** ICE restart offer, numbered, inside the same Signal-encrypted signalling as the first SDP (non-trickle). */
  const sendRestart = async () => {
    const c = callRef.current, connection = pc.current;
    if (!c || !connection || c.status !== 'active' || restarting.current) return;
    // An older app on the other side does not know the `restart` step: ICE may still recover by itself.
    if (!restartCapable(c.remoteSdp)) return;
    restarting.current = true;
    try {
      const gen = ++restartGen.current; pendingGen.current = gen; pendingAt.current = Date.now();
      const fresh = gatheredAgain(connection);
      await setLocal(connection, await connection.createOffer({ iceRestart: true }), c.video);
      const sdp = await fresh;
      if (callRef.current?.id !== c.id || pc.current !== connection || pendingGen.current !== gen) return;
      signal(c.chat.id, { type: 'call', call: c.id, step: 'restart', gen, sdp: markRestartCapable(sdp) });
    } catch { /* the next attempt is on the timer */ } finally { restarting.current = false; }
  };

  /** One input into the reconnect state machine (connection state, network change, timer). */
  const feedLink = (input: LinkInput) => {
    const c = callRef.current; if (!c || c.status !== 'active' || !pc.current) return;
    // The caller acts first; the callee waits a little longer, so usually only one restart offer is in flight.
    const step = linkNext(link.current, input, Date.now(), { graceMs: DISCONNECT_GRACE_MS + (c.incoming ? POLITE_EXTRA_MS : 0) });
    link.current = step.link;
    if (linkTimer.current) clearTimeout(linkTimer.current);
    linkTimer.current = step.wakeAt === null ? undefined : setTimeout(() => feedLinkRef.current({ kind: 'timer' }), Math.max(0, step.wakeAt - Date.now()));
    const showing = linkShowsReconnecting(step.link);
    if (!!c.reconnecting !== showing) patch({ reconnecting: showing });
    if (step.recovered) lightFeedback();
    if (step.end) { finish('Связь потеряна', 'failed'); return; }
    if (step.restart) void sendRestart();
  };
  const feedLinkRef = useRef(feedLink); feedLinkRef.current = feedLink;
  // Wi-Fi ↔ LTE or a new IP during a call: restart ICE at once instead of waiting for the old path to time out.
  useEffect(() => (live ? onNetworkChange(() => feedLinkRef.current({ kind: 'network' })) : undefined), [live]);

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
        // The callee decides who may ring them (Настройки → Конфиденциальность → Звонки).
        const permission = await api.callPermission(chat.peer.id).catch(() => ({ allowed: true }));
        if (!permission.allowed) { finish('Этот человек ограничил, кто может ему звонить'); return; }
        if (callRef.current?.id !== id) return;
        try { inCall.current?.start?.({ media: video ? 'video' : 'audio' }); inCall.current?.setForceSpeakerphoneOn?.(video); } catch { /* optional */ }
        const { connection, localUrl } = await prepare(video);
        patch({ localUrl });
        await setLocal(connection, await connection.createOffer({}), video);
        const sdp = await gathered(connection);
        if (callRef.current?.id !== id) return;
        signal(chat.id, { type: 'call', call: id, step: 'offer', video, sdp: markRestartCapable(sdp) });
        patch({ status: 'ringing' });
        void playCallSound('outgoing');
        ringTimer.current = setTimeout(() => { if (callRef.current?.id === id && callRef.current.status === 'ringing') finish('Нет ответа', 'missed'); }, RING_TIMEOUT_MS);
      } catch (error) { finish(error instanceof Error ? error.message : 'Не удалось начать звонок'); }
    })();
  }, [api, music, prepare, finish]);

  const accept = useCallback(async () => {
    const current = callRef.current; if (!current || current.status !== 'incoming' || !current.remoteSdp) return;
    stopCallSound();
    try { inCall.current?.stopRingtone?.(); } catch { /* optional */ }
    Vibration.cancel(); music.stop(); lightFeedback();
    patch({ status: 'connecting' });
    try {
      try { inCall.current?.start?.({ media: current.video ? 'video' : 'audio' }); inCall.current?.setForceSpeakerphoneOn?.(current.video); } catch { /* optional */ }
      const webrtc = rtc.current!;
      const { connection, localUrl } = await prepare(current.video);
      patch({ localUrl });
      await connection.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'offer', sdp: stripRestartMarker(current.remoteSdp) }));
      await setLocal(connection, await connection.createAnswer(), current.video);
      const sdp = await gathered(connection);
      if (callRef.current?.id !== current.id) return;
      signal(current.chat.id, { type: 'call', call: current.id, step: 'answer', sdp: markRestartCapable(sdp) });
      void computeKey(sdp, current.remoteSdp);
    } catch (error) { finish(error instanceof Error ? error.message : 'Не удалось ответить', 'failed'); }
  }, [music, prepare, finish]);

  // Incoming signals from the encrypted message stream.
  const ring = (chat: Chat, action: { call: string; video?: boolean; sdp?: string }, _message: Message) => {
    // Busy: the same `end` as a hang-up (video, caller: false), so the caller's chat says «Собеседник занят» and ours a missed call.
    if (callRef.current) { signal(chat.id, callEndMeta({ id: action.call, video: !!action.video, incoming: true, startedAt: null }, 'busy')); return; }
    setCall({ id: action.call, chat, peer: chat.peer, incoming: true, video: !!action.video, status: 'incoming', muted: false, speaker: !!action.video, cameraOff: false, startedAt: null, endedText: '', key: null, localUrl: null, remoteUrl: null, remoteSdp: action.sdp });
    // Настройки › Уведомления и звуки › Звонки (F2): «Без мелодии» rings silently, «Вибрация» off keeps the phone still.
    const alert = incomingAlert(getNotificationPrefs().calls);
    if (alert.sound) void playCallSound('incoming');
    if (alert.vibrate) Vibration.vibrate([0, 600, 900], true);
    ringTimer.current = setTimeout(() => { if (callRef.current?.id === action.call && callRef.current.status === 'incoming') finish('Пропущенный звонок'); }, RING_TIMEOUT_MS);
  };
  useEffect(() => store.onCallSignal((message: Message) => {
    const action = message.meta?.action; if (!action || action.type !== 'call') return;
    const current = callRef.current;
    if (action.step === 'offer' && current && current.id === action.call && current.status !== 'incoming' && action.sdp) {
      // Mid-call change (the other side turned the camera on): answer the new offer on the same connection.
      const webrtc = rtc.current; const connection = pc.current; if (!webrtc || !connection) return;
      if (action.video && !current.video) patch({ video: true });
      void (async () => {
        try {
          await connection.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'offer', sdp: stripRestartMarker(action.sdp!) }));
          await setLocal(connection, await connection.createAnswer(), true);
          const sdp = await gathered(connection);
          signal(current.chat.id, { type: 'call', call: current.id, step: 'answer', sdp: markRestartCapable(sdp) });
        } catch { /* keep the call going without video */ }
      })();
      return;
    }
    if (action.step === 'offer') {
      if (!offerIsFresh(message.createdAt, Date.now(), seen.current, action.call)) return;
      seen.current.add(action.call);
      const chat = storeRef.current.chats.find(c => c.id === message.chatId); if (!chat) return;
      // A modified client could skip the server check; this phone still never rings for a caller it must not.
      void api.callPermission(message.senderId, 'incoming').then(({ allowed }) => {
        if (!allowed) signal(chat.id, callEndMeta({ id: action.call, video: !!action.video, incoming: true, startedAt: null }, 'declined'));
        else ring(chat, action, message);
      }).catch(() => ring(chat, action, message));
      return;
    }

    if (!current || current.id !== action.call) return;
    // ICE restart from the other side (reconnect.ts): numbered, so a late or repeated one is ignored; the DTLS
    // fingerprints must be the ones of this call (the key emoji stay valid); glare: the caller's offer wins.
    if (action.step === 'restart' && action.sdp && action.gen && (current.status === 'active' || current.status === 'connecting')) {
      const webrtc = rtc.current; const connection = pc.current; if (!webrtc || !connection) return;
      const gen = action.gen, offer = stripRestartMarker(action.sdp);
      const decision = remoteRestart({ gen, lastRemoteGen: lastRemoteGen.current, signalingState: connection.signalingState, polite: current.incoming, fingerprintsMatch: sameFingerprints(offer, current.remoteSdp || ''), pendingAgeMs: Date.now() - pendingAt.current });
      if (decision !== 'answer' && decision !== 'rollback-and-answer') return;
      lastRemoteGen.current = gen;
      void (async () => {
        try {
          if (decision === 'rollback-and-answer') { pendingGen.current = null; await connection.setLocalDescription({ type: 'rollback', sdp: '' }); }
          await connection.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'offer', sdp: offer }));
          const fresh = gatheredAgain(connection);
          await setLocal(connection, await connection.createAnswer(), current.video);
          const sdp = await fresh;
          if (callRef.current?.id !== current.id || pc.current !== connection) return;
          signal(current.chat.id, { type: 'call', call: current.id, step: 'restart-answer', gen, sdp: markRestartCapable(sdp) });
        } catch { /* the other side retries with a newer number */ }
      })();
      return;
    }
    if (action.step === 'restart-answer' && action.sdp && action.gen) {
      const webrtc = rtc.current; const connection = pc.current; if (!webrtc || !connection) return;
      const answer = stripRestartMarker(action.sdp);
      if (!restartAnswerFits({ gen: action.gen, pendingGen: pendingGen.current, signalingState: connection.signalingState, fingerprintsMatch: sameFingerprints(answer, current.remoteSdp || '') })) return;
      pendingGen.current = null;
      void connection.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'answer', sdp: answer })).catch(() => {});
      return;
    }
    if (action.step === 'answer' && action.sdp && (current.status === 'active' || current.status === 'connecting') && pc.current?.signalingState === 'have-local-offer') {
      const webrtc = rtc.current; if (webrtc) void pc.current.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'answer', sdp: stripRestartMarker(action.sdp) })).catch(() => {});
      return;
    }
    if (action.step === 'answer' && !current.incoming && action.sdp) {
      if (ringTimer.current) clearTimeout(ringTimer.current);
      stopCallSound();
      try { inCall.current?.stopRingback?.(); } catch { /* optional */ }
      patch({ status: 'connecting', remoteSdp: action.sdp });
      const webrtc = rtc.current; const connection = pc.current;
      if (webrtc && connection) void connection.setRemoteDescription(new webrtc.RTCSessionDescription({ type: 'answer', sdp: stripRestartMarker(action.sdp) }))
        .then(() => computeKey(connection.localDescription?.sdp || '', action.sdp!)).catch(() => finish('Не удалось соединиться', 'failed'));
      return;
    }
    if (action.step === 'end') finish(action.reason === 'declined' ? 'Звонок отклонён' : action.reason === 'busy' ? 'Собеседник занят' : action.reason === 'missed' ? 'Пропущенный звонок' : 'Звонок завершён');
  }), [store.onCallSignal, finish, api]);

  useEffect(() => cleanup, [cleanup]);

  // Turn the camera on during an audio call: add a video track and renegotiate (offer inside the same call).
  const enableVideo = async () => {
    const c = callRef.current; const webrtc = rtc.current; const connection = pc.current;
    if (!c || !webrtc || !connection || c.status !== 'active') return;
    try {
      await setCenterStage(true);
      const stream: any = await webrtc.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480, frameRate: 30 } } as any);
      const track = stream.getVideoTracks()[0]; if (!track) return;
      local.current?.addTrack?.(track); connection.addTrack(track, local.current || stream);
      try { inCall.current?.setForceSpeakerphoneOn?.(true); } catch { /* optional */ }
      patch({ video: true, cameraOff: false, speaker: true, localUrl: (local.current || stream).toURL() });
      await setLocal(connection, await connection.createOffer({}), true);
      const sdp = await gathered(connection);
      signal(c.chat.id, { type: 'call', call: c.id, step: 'offer', video: true, sdp: markRestartCapable(sdp) });
      lightFeedback();
    } catch { /* camera unavailable — the call goes on with audio */ }
  };
  const controls = {
    minimize: () => patch({ minimized: true }),
    restore: () => patch({ minimized: false }),
    hangup: () => {
      const c = callRef.current; if (!c) return;
      // The reason by status (callModel.hangupOutcome): a call that never connected — ringing, or connecting after the
      // answer — is «missed» for the caller (this chat shows «Отменённый звонок»), not an answered call with no duration;
      // while requesting nothing was sent yet, so no trace is left in either chat.
      const outcome = hangupOutcome(c.status, c.incoming);
      finish(outcome.text, outcome.reason ?? undefined);
    },
    accept: () => void accept(),
    mute: () => { const c = callRef.current; if (!c) return; local.current?.getAudioTracks().forEach((t: any) => { t.enabled = c.muted; }); patch({ muted: !c.muted }); lightFeedback(); },
    speaker: () => { const c = callRef.current; if (!c) return; try { inCall.current?.setForceSpeakerphoneOn?.(!c.speaker); } catch { /* optional */ } patch({ speaker: !c.speaker }); lightFeedback(); },
    camera: () => {
      const c = callRef.current; if (!c) return;
      if (!local.current?.getVideoTracks().length) { void enableVideo(); return; }
      if (!c.video) return; local.current?.getVideoTracks().forEach((t: any) => { t.enabled = c.cameraOff; }); patch({ cameraOff: !c.cameraOff }); lightFeedback(); },
    flip: () => { local.current?.getVideoTracks().forEach((t: any) => { try { t._switchCamera(); } catch { /* single camera */ } }); lightFeedback(); },
  };
  acceptRef.current = accept; hangupRef.current = controls.hangup;
  const callBack = useCallback((chatId: string, video: boolean) => { const chat = storeRef.current.chats.find(c => c.id === chatId); if (chat) start(chat, video); }, [start]);
  // Люди › Звонки and the service rows read the history from the local cache only: loaded pages plus each chat's last message.
  const history = React.useMemo(() => buildCallHistory(store.chats, store.messages, me.id), [store.chats, store.messages, me.id]);
  const value = React.useMemo<CallApi>(() => ({ start, available: !!rtc.current, busy: !!call, callBack }), [start, call, callBack]);

  return <CallContext.Provider value={value}>
    <CallHistoryContext.Provider value={history}>{children}</CallHistoryContext.Provider>
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
  const insets = useSafeAreaInsets(); const { width, height } = useWindowDimensions(); const t = useTheme();
  const [, tick] = useState(0);
  useEffect(() => { if (call.status !== 'active') return; const timer = setInterval(() => tick(v => v + 1), 1000); return () => clearInterval(timer); }, [call.status]);
  const clock = callClock(Date.now() - (call.startedAt || Date.now()));
  const reconnecting = call.status === 'active' && !!call.reconnecting;
  const status = call.status === 'requesting' ? 'Запрос…' : call.status === 'ringing' ? 'Вызов…' : call.status === 'incoming' ? (call.video ? 'Входящий видеозвонок' : 'Входящий звонок') : call.status === 'connecting' ? 'Соединение…' : reconnecting ? 'Восстановление связи…' : call.status === 'active' ? clock : call.endedText;
  const View_ = rtc?.RTCView as any;
  const showVideo = call.video && call.remoteUrl && View_;
  // Telegram: pull the call screen down to minimise it (the same as the chevron); not while it rings in
  // or has ended. Transparent so the chat shows underneath while it is pulled.
  const canMinimize = call.status !== 'incoming' && call.status !== 'ended';
  const swipe = useSwipeDismiss({ onDismiss: minimize, enabled: canMinimize });
  return <Modal visible transparent animationType="slide" onRequestClose={() => {}} statusBarTranslucent supportedOrientations={['portrait']}>
    <GestureHandlerRootView style={{ flex: 1 }}><SwipeDismissView swipe={swipe} style={{ flex: 1, overflow: 'hidden', backgroundColor: '#000' }}>
    {/* Like Telegram / iOS: the background is the other person's avatar, heavily blurred and dimmed.
        Without a photo — their avatar colour over the app's deep-blue background. */}
    <MusicAmbient width={width} height={height} tone={t.black ? 'black' : 'dark'} still />
    {call.peer.avatarId ? <BlurImage source={{ uri: api.fileUrl(call.peer.avatarId), headers: { Authorization: `Bearer ${api.token}` }, cacheKey: `invizent-file-${call.peer.avatarId}` }} cachePolicy="memory-disk" blurRadius={60} contentFit="cover" style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.25 }] }]} />
      : <LinearGradient colors={[`${call.peer.avatarColor || '#4B73BB'}CC`, `${call.peer.avatarColor || '#4B73BB'}55`, 'rgba(0,0,0,0)']} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />}
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.32)' }]} />
    {showVideo ? <View_ streamURL={call.remoteUrl} objectFit="cover" style={StyleSheet.absoluteFill} /> : null}
    <View style={{ flex: 1, paddingTop: insets.top + 10, paddingBottom: insets.bottom + 24 }}>
      {canMinimize ? <Pressable onPress={minimize} accessibilityRole="button" accessibilityLabel="Свернуть звонок" hitSlop={10} style={{ position: 'absolute', left: 16, top: insets.top + 6, zIndex: 3, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.2)', alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-down" size={24} color="#FFF" /></Pressable> : null}
      <View style={{ alignItems: 'center', minHeight: 34 }}>
        {call.key ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.18)' }}><Icon name="lock-closed" size={13} color="#FFF" /><Text style={{ color: '#FFF', fontSize: 15, letterSpacing: 2 }}>{call.key.join(' ')}</Text></View> : <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>🔒 Звонок защищён сквозным шифрованием</Text>}
      </View>
      {showVideo ? <View style={{ flex: 1 }} /> : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <View style={{ alignItems: 'center', justifyContent: 'center', width: 170, height: 170 }}><Pulse size={140} active={call.status === 'ringing' || call.status === 'incoming' || call.status === 'requesting'} /><View style={{ borderRadius: 70, overflow: 'hidden' }}><Avatar user={call.peer} api={api} size={130} /></View></View>
        <Text style={{ color: '#FFF', fontSize: 28, fontWeight: '700' }}>{call.peer.displayName}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16 }}>{status}</Text>
        {reconnecting ? <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>{clock}</Text> : null}
      </View>}
      {showVideo ? <View style={{ alignItems: 'center', marginBottom: 14 }}><Text style={{ color: '#FFF', fontSize: 18, fontWeight: '700' }}>{call.peer.displayName}</Text><Text style={{ color: 'rgba(255,255,255,0.85)' }}>{status}{reconnecting ? ` · ${clock}` : ''}</Text></View> : null}
      {call.video && call.localUrl && View_ && !call.cameraOff ? <Pressable onPress={flip} style={{ position: 'absolute', right: 16, top: insets.top + 56, width: width * .28, height: width * .28 * 4 / 3, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' }}><View_ streamURL={call.localUrl} objectFit="cover" mirror zOrder={1} style={{ flex: 1 }} /></Pressable> : null}
      {call.status === 'incoming' ? <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 30 }}>
        <CallButton icon="close" label="Отклонить" onPress={hangup} color="#FF3B30" />
        <CallButton icon={call.video ? 'videocam' : 'call'} label="Ответить" onPress={accept} color="#34C759" />
      </View> : call.status === 'ended' ? null : <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 8 }}>
        <CallButton icon="volume-high" label="Динамик" onPress={speaker} active={call.speaker} />
        <CallButton icon={call.video && !call.cameraOff ? 'videocam' : 'videocam-off'} label="Видео" onPress={camera} active={call.video && !call.cameraOff} />
        {call.video && !call.cameraOff ? <CallButton icon="camera-reverse" label="Повернуть" onPress={flip} /> : null}
        <CallButton icon={call.muted ? 'mic-off' : 'mic'} label={call.muted ? 'Звук выкл' : 'Убрать звук'} onPress={mute} active={call.muted} />
        <CallButton icon="close" label="Завершить" onPress={hangup} color="#FF3B30" />
      </View>}
    </View>
    </SwipeDismissView></GestureHandlerRootView>
  </Modal>;
}

export const callsSupported = Platform.OS !== 'web';

/** Telegram-style strip while the call is minimized: tap to return, the app stays usable. */
function CallBanner({ call, onPress, onHangup }: { call: CallState; onPress: () => void; onHangup: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(v => v + 1), 1000); return () => clearInterval(timer); }, []);
  const status = call.status === 'active' ? (call.reconnecting ? `Восстановление связи… ${callClock(Date.now() - (call.startedAt || Date.now()))}` : callClock(Date.now() - (call.startedAt || Date.now()))) : call.status === 'ended' ? call.endedText : 'Соединение…';
  return <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50 }}>
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Вернуться к звонку: ${call.peer.displayName}, ${status}`} style={{ marginHorizontal: 10, marginTop: 2, height: 36, borderRadius: 18, backgroundColor: call.status === 'active' && !call.reconnecting ? '#2BA36B' : call.reconnecting ? '#D9822B' : '#3B6FB6', flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 4, gap: 8, shadowColor: '#000', shadowOpacity: .25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }}>
      <Icon name={call.video ? 'videocam' : 'call'} size={16} color="#FFF" />
      <Text numberOfLines={1} style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}>{call.peer.displayName} · {status}</Text>
      <Pressable onPress={onHangup} accessibilityRole="button" accessibilityLabel="Завершить звонок" hitSlop={6} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: '#FF3B30', alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={16} color="#FFF" /></Pressable>
    </Pressable>
  </View>;
}
