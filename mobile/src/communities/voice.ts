import { Platform } from 'react-native';
import { prepareScreenCapture, confirmScreenCapture, endScreenCapture } from './screenCapture';
import { useSyncExternalStore } from 'react';
import type { Api } from '../api';
import type { MessengerStore } from '../useMessenger';
import { SCREEN_QUALITIES, screenControl, screenQuality, stereoScreenAudio, type ScreenQuality } from './screenShareModel';
import { GATHER_TIMEOUT_MS } from '../calls/callModel';

/**
 * Voice channels (up to 12 people): a full mesh of WebRTC audio connections. Every pair has
 * its own DTLS-SRTP session (TURN relays the packets when a direct path fails); the server
 * only forwards the SDP offer/answer between people in the same room. The connection stays
 * up while the user moves around the app, as in Discord.
 */
type WebRTC = typeof import('react-native-webrtc');
const loadRtc = (): WebRTC | null => { try { return require('react-native-webrtc'); } catch { return null; } };
const loadInCall = (): any => { try { return require('react-native-incall-manager').default; } catch { return null; } };

export type VoicePeer = { peer: string; userId: string; muted: boolean; connected: boolean; screen?: { stream: any; quality: ScreenQuality } };
export type VoiceState = {
  communityId: string; channelId: string; channelName: string; communityName: string;
  sharing: ScreenQuality | null; screenStream: any;
  /** The PC's sound goes out with the picture (false: the system gave no audio, e.g. Linux). */
  sharingAudio?: boolean;
  status: 'connecting' | 'connected'; muted: boolean; speaker: boolean; peers: VoicePeer[]; error: string;
} | null;

let state: VoiceState = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const set = (next: VoiceState) => { state = next; emit(); };
const patch = (change: Partial<NonNullable<VoiceState>>) => { if (state) set({ ...state, ...change }); };

let rtc: WebRTC | null = null; let inCall: any = null;
let local: any = null; let unsubscribe: (() => void) | null = null; let storeRef: MessengerStore | null = null;
let iceServers: any[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
const connections = new Map<string, any>();
const screenSenders = new Map<string, any>();
/** Second audio slot per peer: the sound of the shared PC (not the microphone). */
const screenAudioSenders = new Map<string, any>();
const SCREEN_AUDIO_BITRATE = 128_000;
const controls = new Map<string, any>();
const remoteScreens = new Map<string, any>();
function releaseRemoteScreen(peer: string) {
  const stream = remoteScreens.get(peer); remoteScreens.delete(peer);
  stream?.release?.(false); // The peer connection owns the remote track.
}
let screenStream: any = null;
let pendingScreenStream: any = null;
let shareGeneration = 0;
let capturePending = false;
const releasedStreams = new WeakSet<object>();
function releaseLocalStream(stream: any) {
  if (!stream || releasedStreams.has(stream)) return;
  releasedStreams.add(stream);
  try { stream.getTracks().forEach((track: any) => track.stop()); }
  finally { stream.release?.(); }
}
function sendScreenState(channel: any) {
  if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'screen', active: !!state?.sharing, quality: state?.sharing || '720p60' }));
}
function bindControl(peer: string, channel: any) {
  if (channel.label !== 'screen-control') return;
  controls.set(peer, channel);
  channel.addEventListener('open', () => sendScreenState(channel));
  channel.addEventListener('message', (event: any) => {
    if (controls.get(peer) !== channel) return;
    const message = screenControl(event.data);
    if (!message) return;
    const stream = remoteScreens.get(peer);
    peerUpdate(peer, { screen: message.active && stream ? { stream, quality: message.quality } : undefined });
    // Keep the announced state until the negotiated video track arrives.
    channel.screenState = message;
  });
}


export const voiceAvailable = () => { if (!rtc) rtc = loadRtc(); return !!rtc; };
export function useVoice(): VoiceState {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
}

const gathered = (connection: any) => new Promise<string>(resolve => {
  const done = () => resolve(connection.localDescription?.sdp || '');
  if (connection.iceGatheringState === 'complete') return done();
  const timer = setTimeout(done, GATHER_TIMEOUT_MS);
  connection.addEventListener('icegatheringstatechange', () => { if (connection.iceGatheringState === 'complete') { clearTimeout(timer); done(); } });
});

function peerUpdate(peer: string, change: Partial<VoicePeer>) {
  if (!state) return;
  patch({ peers: state.peers.map(item => item.peer === peer ? { ...item, ...change } : item) });
}

function connectionFor(peer: string, initiator = false) {
  releaseRemoteScreen(peer); controls.delete(peer); peerUpdate(peer, { screen: undefined });
  const connection: any = new rtc!.RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' } as any);
  // Reserve a video slot before the first SDP exchange. Screen start/stop only replaces
  // this track, so simultaneous shares never tear down audio or race renegotiations.
  const video = connection.addTransceiver('video', { direction: 'sendrecv' });
  screenSenders.set(peer, video.sender);
  if (screenStream) void video.sender.replaceTrack(screenStream.getVideoTracks()[0]);
  if (initiator) bindControl(peer, connection.createDataChannel('screen-control'));
  connection.addEventListener('datachannel', (event: any) => bindControl(peer, event.channel));
  connection.addEventListener('track', (event: any) => {
    if (connections.get(peer) !== connection || event.track.kind !== 'video') return;
    releaseRemoteScreen(peer);
    const stream = new rtc!.MediaStream([event.track]);
    remoteScreens.set(peer, stream);
    const announced = controls.get(peer)?.screenState;
    if (announced?.active) peerUpdate(peer, { screen: { stream, quality: announced.quality } });
  });
  local?.getTracks().forEach((track: any) => connection.addTrack(track, local));
  // Reserved after the microphone so addTrack never lands in it. Sharing only swaps its track.
  const sound = connection.addTransceiver('audio', { direction: 'sendrecv' });
  screenAudioSenders.set(peer, sound.sender);
  if (screenStream?.getAudioTracks?.()[0]) void sound.sender.replaceTrack(screenStream.getAudioTracks()[0]);
  connection.addEventListener('connectionstatechange', () => {
    if (connections.get(peer) !== connection) return;
    const value = connection.connectionState;
    if (value === 'connected') {
      peerUpdate(peer, { connected: true });
      if (state?.sharing && screenStream) {
        const sender = screenSenders.get(peer), preset = SCREEN_QUALITIES[state.sharing];
        void (async () => {
          const parameters = sender.getParameters();
          if (!parameters.encodings?.length) parameters.encodings = [{}];
          parameters.encodings[0].maxBitrate = preset.maxBitrate; parameters.encodings[0].maxFramerate = 60;
          await sender.setParameters(parameters);
        })().catch(() => { if (state?.sharing && connections.get(peer) === connection) patch({ error: 'Не удалось настроить демонстрацию для нового участника.' }); });
      }
    }
    else if (value === 'failed' || value === 'closed') peerUpdate(peer, { connected: false });
  });
  connections.set(peer, connection);
  return connection;
}

function drop(peer: string) {
  try { connections.get(peer)?.close(); } catch { /* closed */ }
  connections.delete(peer);
  screenSenders.delete(peer); screenAudioSenders.delete(peer); controls.delete(peer); releaseRemoteScreen(peer);
  if (state) patch({ peers: state.peers.filter(item => item.peer !== peer) });
}

async function handle(data: any) {
  if (!state) return;
  if (data.type === 'voice.joined' && data.channelId === state.channelId) {
    patch({ status: 'connected', peers: (data.peers || []).map((item: any) => ({ peer: item.peer, userId: item.userId, muted: !!item.muted, connected: false })) });
    // The newcomer calls everyone already in the room.
    for (const item of data.peers || []) {
      try {
        const connection = connectionFor(item.peer, true);
        const offer = await connection.createOffer({ offerToReceiveAudio: true } as any);
        await connection.setLocalDescription({ type: offer.type, sdp: stereoScreenAudio(offer.sdp) });
        const sdp = await gathered(connection);
        storeRef?.sendSocket({ type: 'voice.signal', to: item.peer, data: { kind: 'offer', sdp } });
      } catch { drop(item.peer); }
    }
  } else if (data.type === 'voice.signal' && data.channelId === state.channelId && data.data) {
    const from = data.from as string;
    if (data.data.kind === 'offer') {
      try {
        if (!state.peers.some(item => item.peer === from)) patch({ peers: [...state.peers, { peer: from, userId: data.userId, muted: false, connected: false }] });
        try { connections.get(from)?.close(); } catch { /* replaced */ }
        const connection = connectionFor(from);
        await connection.setRemoteDescription(new rtc!.RTCSessionDescription({ type: 'offer', sdp: data.data.sdp }));
        const answer = await connection.createAnswer();
        await connection.setLocalDescription({ type: answer.type, sdp: stereoScreenAudio(answer.sdp) });
        const sdp = await gathered(connection);
        storeRef?.sendSocket({ type: 'voice.signal', to: from, data: { kind: 'answer', sdp } });
      } catch { drop(from); }
    } else if (data.data.kind === 'answer') {
      const connection = connections.get(from);
      if (connection && connection.signalingState === 'have-local-offer') { try { await connection.setRemoteDescription(new rtc!.RTCSessionDescription({ type: 'answer', sdp: data.data.sdp })); } catch { drop(from); } }
    }
  } else if (data.type === 'voice.left' && typeof data.peer === 'string') drop(data.peer);
  else if (data.type === 'voice.state' && data.channelId === state.channelId && Array.isArray(data.members)) {
    // Mute flags of everyone in the room.
    const muted = new Map<string, boolean>(); for (const item of data.members) muted.set(item.userId, !!item.muted);
    patch({ peers: state.peers.map(item => muted.has(item.userId) ? { ...item, muted: muted.get(item.userId)! } : item) });
  } else if (data.type === 'voice.kicked' && data.channelId === state.channelId) cleanup('');
  else if (data.type === 'error' && state.status === 'connecting') { cleanup(''); set(null); }
  else if (data.type === 'ready' && state) {
    // The socket reconnected: the server forgot us, join again.
    stopVoiceScreen();
    const current = state; connections.forEach((_c, peer) => drop(peer));
    patch({ status: 'connecting', peers: [] });
    storeRef?.sendSocket({ type: 'voice.join', communityId: current.communityId, channelId: current.channelId, muted: current.muted });
  }
}

function cleanup(error: string) {
  stopVoiceScreen();
  connections.forEach(connection => { try { connection.close(); } catch { /* closed */ } });
  connections.clear(); screenSenders.clear(); screenAudioSenders.clear(); controls.clear(); remoteScreens.forEach((_stream, peer) => releaseRemoteScreen(peer));
  try { releaseLocalStream(local); } catch { /* released */ }
  local = null; unsubscribe?.(); unsubscribe = null;
  try { inCall?.stop?.(); } catch { /* optional */ }
  set(error && state ? { ...state, error } : null);
}

export async function joinVoice(api: Api, store: MessengerStore, target: { communityId: string; communityName: string; channelId: string; channelName: string }) {
  if (!voiceAvailable()) throw new Error('Голосовые каналы работают в приложении Android/iPhone.');
  if (state?.channelId === target.channelId) return;
  if (state) leaveVoice();
  try { iceServers = (await api.callIce()).iceServers; } catch { /* public STUN only */ }
  local = await rtc!.mediaDevices.getUserMedia({ audio: true, video: false } as any);
  if (!inCall) inCall = loadInCall();
  try { inCall?.start?.({ media: 'audio' }); inCall?.setForceSpeakerphoneOn?.(true); } catch { /* optional */ }
  storeRef = store;
  unsubscribe = store.onSocket(data => { void handle(data); });
  set({ ...target, sharing: null, screenStream: null, status: 'connecting', muted: false, speaker: true, peers: [], error: '' });
  if (!store.sendSocket({ type: 'voice.join', communityId: target.communityId, channelId: target.channelId })) { cleanup(''); throw new Error('Нет соединения с сервером.'); }
}

export function leaveVoice() {
  if (!state) return;
  storeRef?.sendSocket({ type: 'voice.leave' });
  cleanup('');
}

export function toggleVoiceMute() {
  if (!state) return;
  const muted = !state.muted;
  try { local?.getAudioTracks().forEach((track: any) => { track.enabled = !muted; }); } catch { /* no track */ }
  storeRef?.sendSocket({ type: 'voice.mute', muted });
  patch({ muted });
}

export function toggleVoiceSpeaker() {
  if (!state) return;
  const speaker = !state.speaker;
  try { inCall?.setForceSpeakerphoneOn?.(speaker); } catch { /* optional */ }
  patch({ speaker });
}

/** Explicit system consent is requested for every new capture; never resumed automatically. */
export async function startVoiceScreen(quality: ScreenQuality) {
  const preset = SCREEN_QUALITIES[screenQuality(quality)];
  if (!state || state.status !== 'connected') throw new Error('Сначала подключись к голосовому каналу.');
  if (capturePending || screenStream) throw new Error('Демонстрация уже запускается или включена.');
  const generation = ++shareGeneration; capturePending = true;
  let stream: any;
  try {
    await prepareScreenCapture(quality);
    // PC: the sound of the whole computer, whatever is shown (a screen, a window or a game) —
    // not only the shared window. restrictOwnAudio (Chromium 140+, Windows/macOS) leaves out
    // Инвиз's own sound, so the channel never hears itself back. Phones: picture only for now.
    stream = await rtc!.mediaDevices.getDisplayMedia({
      video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: 60, max: 60 } },
      audio: Platform.OS === 'web' ? { channelCount: 2, restrictOwnAudio: true, suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      ...(Platform.OS === 'web' ? { systemAudio: 'include', windowAudio: 'system' } : {}),
    } as any);
    if (generation !== shareGeneration || !state) { releaseLocalStream(stream); return; }
    pendingScreenStream = stream;
    await confirmScreenCapture(() => generation === shareGeneration && !!state);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Система не предоставила видеодорожку экрана.');
    await track.applyConstraints({ width: preset.width, height: preset.height, frameRate: 60 });
    if (generation !== shareGeneration || !state) { releaseLocalStream(stream); return; }
    screenStream = stream; pendingScreenStream = null;
    track.addEventListener('ended', () => { if (screenStream === stream) stopVoiceScreen(); });
    patch({ sharing: quality, screenStream: stream, error: '' });
    for (const sender of [...screenSenders.values()]) {
      if (![...screenSenders.values()].includes(sender)) continue;
      if (generation !== shareGeneration || !state) throw new Error('Запуск отменён.');
      await sender.replaceTrack(track);
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) continue;
      parameters.encodings[0].maxBitrate = preset.maxBitrate;
      parameters.encodings[0].maxFramerate = 60;
      await sender.setParameters(parameters);
    }
    const sound = stream.getAudioTracks?.()[0];
    if (sound) {
      try { sound.contentHint = 'music'; } catch { /* optional */ }
      for (const sender of [...screenAudioSenders.values()]) {
        if (generation !== shareGeneration || !state) break;
        await sender.replaceTrack(sound);
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = SCREEN_AUDIO_BITRATE;
        await sender.setParameters(parameters).catch(() => {});
      }
    }
    patch({ sharingAudio: !!sound });
    if (generation !== shareGeneration || !state) { releaseLocalStream(stream); return; }
    controls.forEach(sendScreenState);
  } catch (error) {
    releaseLocalStream(stream);
    stopVoiceScreen();
    throw error;
  } finally { capturePending = false; }
}
export function stopVoiceScreen() {
  ++shareGeneration;
  endScreenCapture();
  const previous = screenStream; screenStream = null;
  const pending = pendingScreenStream; pendingScreenStream = null;
  releaseLocalStream(pending);
  screenSenders.forEach(sender => { void sender.replaceTrack(null).catch(() => {}); });
  screenAudioSenders.forEach(sender => { void sender.replaceTrack(null).catch(() => {}); });
  patch({ sharing: null, screenStream: null, sharingAudio: false });
  controls.forEach(sendScreenState);
  releaseLocalStream(previous);
}
