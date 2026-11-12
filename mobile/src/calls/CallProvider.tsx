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
import { CALL_BAR_HEIGHT, NETWORK_WAIT_MS, NO_CONNECTION_TEXT, callBarLayout, callBarText, callBarTone, callStatusText, ringExpiry, signalNetwork, systemCallText, type SignalNetwork } from './callStatus';
import { beginSystemCall, endSystemCall, setSystemCallHandlers, setSystemCallMuted, updateSystemCall } from './systemCall';
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
  /** Ended without a connection («Нет соединения»): the screen stays with «Повторить» instead of closing by itself. */
  retry?: boolean;
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
  // The signalling path (the messenger socket): offline, an outgoing call says «Ожидание сети…» / «Соединение…»
  // instead of «Вызов…», does not send its offer into the void, and gives up after NETWORK_WAIT_MS («Нет соединения»).
  const network = signalNetwork(store.connection, store.online);
  const networkRef = useRef<SignalNetwork>(network); networkRef.current = network;
  const networkWaiters = useRef(new Set<() => void>());
  useEffect(() => { if (network === 'online') [...networkWaiters.current].forEach(wake => wake()); }, [network]);
  const pc = useRef<any>(null); const local = useRef<any>(null); const stopGate = useRef<() => void>(() => {}); const hookOn = useRef(false);
  const seen = useRef(new Set<string>());
  const ringTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const storeRef = useRef(store); storeRef.current = store;
  const rtc = useRef<WebRTC | null>(null); if (rtc.current === null) rtc.current = loadRtc();
  // PC binds during a call: mute the microphone; «звук» turns the other person's voice off.
  useEffect(() => onBindAction(action => {
    const c = callRef.current; if (!c || c.status === 'ended') return;
    if (action === 'mute') { setMicMutedRef.current(!c.muted); return; }
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
    const id = callRef.current?.id; if (id) void endSystemCall(id);
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

  const finish = useCallback((text: string, notify?: CallEndReason, retry = false) => {
    const current = callRef.current; if (!current) return;
    // The `end` carries what both chats show as the service row (F9): how long the call lasted (from the
    // moment the media connected), whether it was video, and whether this phone placed it — all inside the ciphertext.
    // Every `end` this phone sends (here, busy, privacy) goes through the same builder (callModel.callEndMeta).
    if (notify) signal(current.chat.id, callEndMeta(current, notify));
    cleanup();
    // «Нет соединения» stays on screen (opened, if it was minimised) with «Повторить» / «Закрыть», like Telegram.
    setCall({ ...current, status: 'ended', endedText: text, localUrl: null, remoteUrl: null, retry, minimized: retry ? false : current.minimized });
    if (!retry) setTimeout(() => setCall(value => value?.id === current.id && value.status === 'ended' ? null : value), 1600);
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

  /** Resolves true once the signalling path is up, false after NETWORK_WAIT_MS or when this call is gone. */
  const waitForNetwork = (id: string) => new Promise<boolean>(resolve => {
    if (networkRef.current === 'online') { resolve(true); return; }
    const done = (ok: boolean) => { clearTimeout(timer); networkWaiters.current.delete(wake); resolve(ok && callRef.current?.id === id); };
    const wake = () => done(true);
    const timer = setTimeout(() => done(false), NETWORK_WAIT_MS);
    networkWaiters.current.add(wake);
  });

  const start = useCallback((chat: Chat, video: boolean) => {
    if (callRef.current) return;
    const id = Crypto.randomUUID(); seen.current.add(id); music.stop(); impactFeedback();
    setCall({ id, chat, peer: chat.peer, incoming: false, video, status: 'requesting', muted: false, speaker: video, cameraOff: false, startedAt: null, endedText: '', key: null, localUrl: null, remoteUrl: null });
    // iOS CallKit / Android ongoing-call notification (systemCall.ts); without it the call simply stays in the app.
    void beginSystemCall(id, chat.peer.displayName, video, systemCallText('requesting', video, false, networkRef.current));
    const noConnection = () => { if (callRef.current?.id === id) finish(NO_CONNECTION_TEXT, undefined, true); };
    void (async () => {
      try {
        // Offline: wait for the connection first (the screen says «Ожидание сети…»); nothing has been sent yet.
        if (!(await waitForNetwork(id))) { noConnection(); return; }
        // The callee decides who may ring them (Настройки → Конфиденциальность → Звонки).
        const permission = await api.callPermission(chat.peer.id).catch(() => ({ allowed: true }));
        if (!permission.allowed) { finish('Этот человек ограничил, кто может ему звонить'); return; }
        if (callRef.current?.id !== id) return;
        try { inCall.current?.start?.({ media: video ? 'video' : 'audio' }); inCall.current?.setForceSpeakerphoneOn?.(video); } catch { /* optional */ }
        const { connection, localUrl } = await prepare(video);
        patch({ localUrl });
        // Android: the ongoing-call service needs the microphone permission, granted just now on a first call.
        if (Platform.OS === 'android') void beginSystemCall(id, chat.peer.displayName, video, systemCallText('requesting', video, false, networkRef.current));
        await setLocal(connection, await connection.createOffer({}), video);
        const sdp = await gathered(connection);
        if (callRef.current?.id !== id) return;
        // The connection dropped while the offer was being prepared: an offer queued now would ring much later
        // (or never), so wait again and end with «Нет соединения» if it does not come back.
        if (!(await waitForNetwork(id))) { noConnection(); return; }
        signal(chat.id, { type: 'call', call: id, step: 'offer', video, sdp: markRestartCapable(sdp) });
        patch({ status: 'ringing' });
        void playCallSound('outgoing');
        // No answer in time: «Нет ответа» — or «Нет соединения» with «Повторить» when the connection is down.
        ringTimer.current = setTimeout(() => { if (callRef.current?.id === id && callRef.current.status === 'ringing') { const expiry = ringExpiry(networkRef.current); finish(expiry.text, 'missed', expiry.retry); } }, RING_TIMEOUT_MS);
      } catch (error) { finish(error instanceof Error ? error.message : 'Не удалось начать звонок'); }
    })();
  }, [api, music, prepare, finish]);

  const accept = useCallback(async () => {
    const current = callRef.current; if (!current || current.status !== 'incoming' || !current.remoteSdp) return;
    stopCallSound();
    try { inCall.current?.stopRingtone?.(); } catch { /* optional */ }
    Vibration.cancel(); music.stop(); lightFeedback();
    patch({ status: 'connecting' });
    // Answered in the app: from now on the phone shows it as a running call (CallKit / ongoing notification).
    void beginSystemCall(current.id, current.peer.displayName, current.video, systemCallText('connecting', current.video, false, networkRef.current));
    try {
      try { inCall.current?.start?.({ media: current.video ? 'video' : 'audio' }); inCall.current?.setForceSpeakerphoneOn?.(current.video); } catch { /* optional */ }
      const webrtc = rtc.current!;
      const { connection, localUrl } = await prepare(current.video);
      patch({ localUrl });
      if (Platform.OS === 'android') void beginSystemCall(current.id, current.peer.displayName, current.video, systemCallText('connecting', current.video, false, networkRef.current));
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
  /** Sets (not toggles) the microphone, so CallKit echoing the app's own change back cannot flip it again. */
  const setMicMuted = (muted: boolean, fromSystem = false) => {
    const c = callRef.current; if (!c || c.status === 'ended') return;
    local.current?.getAudioTracks().forEach((t: any) => { t.enabled = !muted; });
    if (c.muted !== muted) patch({ muted });
    if (!fromSystem) setSystemCallMuted(c.id, muted);
  };
  const setMicMutedRef = useRef(setMicMuted); setMicMutedRef.current = setMicMuted;
  const controls = {
    minimize: () => patch({ minimized: true }),
    restore: () => patch({ minimized: false }),
    /** «Нет соединения» → «Повторить»: the same chat, the same kind of call, a new call id. */
    retry: () => { const c = callRef.current; if (!c || c.status !== 'ended') return; callRef.current = null; setCall(null); start(c.chat, c.video); },
    close: () => { const c = callRef.current; if (c?.status === 'ended') setCall(null); },
    hangup: () => {
      const c = callRef.current; if (!c) return;
      // The reason by status (callModel.hangupOutcome): a call that never connected — ringing, or connecting after the
      // answer — is «missed» for the caller (this chat shows «Отменённый звонок»), not an answered call with no duration;
      // while requesting nothing was sent yet, so no trace is left in either chat.
      const outcome = hangupOutcome(c.status, c.incoming);
      finish(outcome.text, outcome.reason ?? undefined);
    },
    accept: () => void accept(),
    mute: () => { const c = callRef.current; if (!c) return; setMicMuted(!c.muted); lightFeedback(); },
    speaker: () => { const c = callRef.current; if (!c) return; try { inCall.current?.setForceSpeakerphoneOn?.(!c.speaker); } catch { /* optional */ } patch({ speaker: !c.speaker }); lightFeedback(); },
    camera: () => {
      const c = callRef.current; if (!c) return;
      if (!local.current?.getVideoTracks().length) { void enableVideo(); return; }
      if (!c.video) return; local.current?.getVideoTracks().forEach((t: any) => { t.enabled = c.cameraOff; }); patch({ cameraOff: !c.cameraOff }); lightFeedback(); },
    flip: () => { local.current?.getVideoTracks().forEach((t: any) => { try { t._switchCamera(); } catch { /* single camera */ } }); lightFeedback(); },
  };
  acceptRef.current = accept; hangupRef.current = controls.hangup;
  // What the system call UI may do: end the call (CallKit pill, lock screen, «Завершить» in the notification), mute it, open it.
  useEffect(() => setSystemCallHandlers({
    onEnd: id => { if (callRef.current?.id === id) hangupRef.current?.(); },
    onMute: (id, muted) => { if (callRef.current?.id === id) setMicMutedRef.current(muted, true); },
    onOpen: () => { if (callRef.current && callRef.current.status !== 'ended') patch({ minimized: false }); },
  }), []);
  // The system indicator follows the call: «Вызов…», «Ожидание сети…», then the running duration once connected.
  const systemText = call && call.status !== 'ended' ? systemCallText(call.status, call.video, call.reconnecting, network) : null;
  useEffect(() => { if (call && systemText) updateSystemCall(call.id, systemText, call.status === 'active' ? call.startedAt : null); }, [call?.id, systemText, call?.startedAt]);
  const callBack = useCallback((chatId: string, video: boolean) => { const chat = storeRef.current.chats.find(c => c.id === chatId); if (chat) start(chat, video); }, [start]);
  // Люди › Звонки and the service rows read the history from the local cache only: loaded pages plus each chat's last message.
  const history = React.useMemo(() => buildCallHistory(store.chats, store.messages, me.id), [store.chats, store.messages, me.id]);
  const value = React.useMemo<CallApi>(() => ({ start, available: !!rtc.current, busy: !!call, callBack }), [start, call, callBack]);

  return <CallContext.Provider value={value}>
    <CallBarFrame bar={call && call.minimized ? <CallBanner call={call} network={network} onPress={controls.restore} onHangup={controls.hangup} /> : null}>
      <CallHistoryContext.Provider value={history}>{children}</CallHistoryContext.Provider>
    </CallBarFrame>
    {call && !call.minimized ? <CallScreen call={call} api={api} rtc={rtc.current} network={network} {...controls} /> : null}
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

function CallScreen({ call, api, rtc, network, hangup, accept, mute, speaker, camera, flip, minimize, retry, close }: { call: CallState; api: Api; rtc: WebRTC | null; network: SignalNetwork; hangup: () => void; accept: () => void; mute: () => void; speaker: () => void; camera: () => void; flip: () => void; minimize: () => void; restore?: () => void; retry: () => void; close: () => void }) {
  const insets = useSafeAreaInsets(); const { width, height } = useWindowDimensions(); const t = useTheme();
  const [, tick] = useState(0);
  useEffect(() => { if (call.status !== 'active') return; const timer = setInterval(() => tick(v => v + 1), 1000); return () => clearInterval(timer); }, [call.status]);
  const clock = callClock(Date.now() - (call.startedAt || Date.now()));
  const reconnecting = call.status === 'active' && !!call.reconnecting;
  // Offline the status says so («Ожидание сети…» / «Соединение…») instead of «Вызов…» (callStatus.ts).
  const status = callStatusText({ status: call.status, incoming: call.incoming, video: call.video, reconnecting: call.reconnecting, startedAt: call.startedAt, endedText: call.endedText, network, now: Date.now() });
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
    {call.peer.avatarId ? <BlurImage source={{ uri: api.fileUrl(call.peer.avatarId), headers: { ...api.authHeaders }, cacheKey: `invizent-file-${call.peer.avatarId}` }} cachePolicy="memory-disk" blurRadius={60} contentFit="cover" style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.25 }] }]} />
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
      </View> : call.status === 'ended' ? (call.retry ? <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 30 }}>
        <CallButton icon="close" label="Закрыть" onPress={close} />
        <CallButton icon={call.video ? 'videocam' : 'call'} label="Повторить" onPress={retry} color="#34C759" />
      </View> : null) : <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 8 }}>
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

/**
 * Telegram iOS's active-call bar while the call is minimised: a full-width strip right under the status bar (the
 * clock, the Dynamic Island and the battery stay visible above it), the screens below move down by its height
 * (CallBarFrame). Name and status centred; tap opens the call; the round button on the right ends it.
 */
function CallBanner({ call, network, onPress, onHangup }: { call: CallState; network: SignalNetwork; onPress: () => void; onHangup: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(v => v + 1), 1000); return () => clearInterval(timer); }, []);
  const { status, clock } = callBarText({ status: call.status, incoming: call.incoming, video: call.video, reconnecting: call.reconnecting, startedAt: call.startedAt, endedText: call.endedText, network, now: Date.now() });
  const tone = callBarTone(call.status, call.reconnecting, network);
  const background = tone === 'active' ? '#2BA36B' : tone === 'trouble' ? '#D9822B' : tone === 'pending' ? '#3B6FB6' : '#6B7280';
  const text = { color: '#FFF', fontSize: 14, lineHeight: 18 } as const;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${call.peer.displayName}, ${status}${clock ? ` ${clock}` : ''}`} accessibilityHint="Вернуться к звонку"
    style={({ pressed }) => ({ height: CALL_BAR_HEIGHT, backgroundColor: background, opacity: pressed ? .85 : 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 46 })}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <Icon name={call.video ? 'videocam' : 'call'} size={14} color="#FFF" />
      <Text numberOfLines={1} style={[text, { fontWeight: '600', flexShrink: 1 }]}>{call.peer.displayName}</Text>
      <Text style={[text, { opacity: .85 }]}>·</Text>
      <Text numberOfLines={1} style={[text, { flexShrink: 0 }]}>{status}</Text>
      {clock ? <Text numberOfLines={1} style={[text, { flexShrink: 0, opacity: .85 }]}>{clock}</Text> : null}
    </View>
    {call.status !== 'ended' ? <Pressable onPress={onHangup} accessibilityRole="button" accessibilityLabel="Завершить звонок" hitSlop={8}
      style={{ position: 'absolute', right: 8, top: (CALL_BAR_HEIGHT - 26) / 2, width: 26, height: 26, borderRadius: 13, backgroundColor: '#FF3B30', alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="close" size={15} color="#FFF" />
    </Pressable> : null}
  </Pressable>;
}

/**
 * Lays the minimised call bar out under the status bar and moves everything else down by its height, on every tab
 * and screen (they are all inside). The screens that reach up under the status bar (marginTop: -insets.top) keep
 * doing so from their new top, so their headers land right under the bar. The strip above the bar is the app
 * background, so the status bar keeps its usual colour in light and dark. The frame measures where it starts on
 * screen: if it ever starts higher than the safe area (no safe-area padding above it), the bar still goes below
 * the status bar instead of over the clock and the Dynamic Island.
 */
function CallBarFrame({ bar, children }: { bar: React.ReactNode | null; children: React.ReactNode }) {
  const insets = useSafeAreaInsets(); const t = useTheme();
  const frame = useRef<View>(null); const [frameTop, setFrameTop] = useState<number | null>(null);
  const insetTop = Platform.OS === 'web' ? 0 : insets.top;
  const measure = () => { frame.current?.measureInWindow?.((_x, y) => { if (Number.isFinite(y)) setFrameTop(value => value === y ? value : y); }); };
  useEffect(() => { if (bar) measure(); }, [!!bar, insetTop]);
  const layout = callBarLayout(insetTop, frameTop);
  // The status bar strip (screen top → insetTop) in this frame's coordinates: normally all of it lies above the frame.
  const strip = layout.top + Math.min(frameTop ?? insetTop, insetTop);
  return <View ref={frame} collapsable={false} onLayout={measure} style={{ flex: 1 }}>
    <View style={{ flex: 1, paddingTop: bar ? layout.contentTop : 0 }}>{children}</View>
    {bar ? <>
      {strip > 0 ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: layout.top - strip, height: strip, backgroundColor: t.bg, zIndex: 49, elevation: 49 }} /> : null}
      <View style={{ position: 'absolute', left: 0, right: 0, top: layout.top, height: CALL_BAR_HEIGHT, zIndex: 50, elevation: 50 }}>{bar}</View>
    </> : null}
  </View>;
}
