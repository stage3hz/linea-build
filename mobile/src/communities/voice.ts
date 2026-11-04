import { Platform } from 'react-native';
import { audioPrefs, setAudioPrefs, subscribeAudio } from '../audio/devices';
import { gateTrack } from '../audio/gate';
import { onBindAction, setVoiceActive } from '../audio/binds';
import { playVoiceSound } from './voiceSounds';
import { connectOverlay, overlayTrack, overlayVoiceChanged } from '../overlay/sync';
import { unwatchVoice } from '../overlay/speaking';
import { SfuSession, sfuUsable } from './sfu/session';
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

export type VoicePeer = { peer: string; userId: string; muted: boolean; serverMuted?: boolean; serverDeafened?: boolean; connected: boolean; screen?: { stream: any; quality: ScreenQuality } };
export type VoiceState = {
  communityId: string; channelId: string; channelName: string; communityName: string;
  sharing: ScreenQuality | null; screenStream: any;
  /** The PC's sound goes out with the picture (false: the system gave no audio, e.g. Linux). */
  sharingAudio?: boolean;
  status: 'connecting' | 'connected'; muted: boolean; speaker: boolean;
  /** Звук выключен: nobody is heard (and, as in Discord, the microphone is off too). */
  deafened?: boolean; peers: VoicePeer[]; error: string;
  /** Set by a moderator (Discord's server mute / deafen): cannot be lifted from here. */
  serverMuted?: boolean; serverDeafened?: boolean; userId?: string;
} | null;

let state: VoiceState = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const set = (next: VoiceState) => { state = next; emit(); overlayVoiceChanged(); };
const patch = (change: Partial<NonNullable<VoiceState>>) => { if (state) set({ ...state, ...change }); };

// PC overlay (Настройки → Оверлей): reads the channel state; watches each person's microphone.
const overlayMics = new Set<string>();
// SFU (many viewers, PC): session with the server, which peers can watch through it, the share key.
let sfuSession: SfuSession | null = null;
const sfuScreens = new Map<string, any>();
const sfuPeers = new Set<string>();
let shareKey: { raw: Uint8Array; id: number } | null = null; let shareKeyId = 0;
const b64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
function sendKey(channel: any) { if (shareKey && channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'screenKey', keyId: shareKey.id, key: b64(shareKey.raw) })); }
function sendCaps(channel: any) { if (channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'caps', sfu: !!sfuSession })); }
function attachOverlay() {
  if (local) overlayTrack('me', local.getAudioTracks()[0]);
  for (const [peer, connection] of connections) {
    const mic = (connection.getReceivers?.() || []).find((r: any) => r.track?.kind === 'audio')?.track;
    if (mic) overlayTrack(peer, mic);
  }
}
connectOverlay(() => state && { channelName: state.channelName, muted: state.muted, deafened: state.deafened, status: state.status, peers: state.peers }, () => attachOverlay());

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
  channel.addEventListener('open', () => { sendScreenState(channel); sendCaps(channel); });
  channel.addEventListener('message', (event: any) => {
    if (controls.get(peer) !== channel) return;
    // SFU: the peer can watch through the server; its share keys arrive only over this channel.
    if (typeof event.data === 'string' && event.data.length <= 512) {
      let extra: any = null; try { extra = JSON.parse(event.data); } catch { /* not ours */ }
      if (extra?.type === 'caps') {
        if (extra.sfu === true && sfuSession) {
          sfuPeers.add(peer);
          // Already sharing: this viewer now gets the picture from the server — stop the direct copy.
          if (screenStream && shareKey) { sendKey(channel); void screenSenders.get(peer)?.replaceTrack(null).catch(() => {}); void screenAudioSenders.get(peer)?.replaceTrack(null).catch(() => {}); }
        }
        return;
      }
      if (extra?.type === 'screenKey' && Number.isInteger(extra.keyId) && extra.keyId >= 0 && extra.keyId < 256 && typeof extra.key === 'string' && extra.key.length <= 44) {
        try { const raw = unb64(extra.key); if (raw.length === 16) void sfuSession?.setPeerKey(peer, extra.keyId, raw); } catch { /* bad key */ }
        return;
      }
    }
    const message = screenControl(event.data);
    if (!message) return;
    const stream = remoteScreens.get(peer) || sfuScreens.get(peer);
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
    if (event.track?.kind === 'audio' && !audible(peer)) event.track.enabled = false;
    // The first audio track of a person is their microphone (the PC-sound slot comes after it).
    if (event.track?.kind === 'audio' && !overlayMics.has(peer)) { overlayMics.add(peer); overlayTrack(peer, event.track); }
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

function drop(peer: string, quiet = false) {
  overlayMics.delete(peer); unwatchVoice(peer); sfuPeers.delete(peer); sfuScreens.delete(peer); sfuSession?.forget(peer);
  if (!quiet && state?.peers.some(item => item.peer === peer)) playVoiceSound('leave');
  try { connections.get(peer)?.close(); } catch { /* closed */ }
  connections.delete(peer);
  screenSenders.delete(peer); screenAudioSenders.delete(peer); controls.delete(peer); releaseRemoteScreen(peer);
  if (state) patch({ peers: state.peers.filter(item => item.peer !== peer) });
}

async function handle(data: any) {
  if (!state) return;
  if (sfuSession?.handle(data)) return;
  if (data.type === 'voice.joined' && data.channelId === state.channelId) {
    playVoiceSound('join');
    if (data.sfu === true && Platform.OS === 'web' && sfuUsable() && !sfuSession) {
      const session = new SfuSession(message => !!storeRef?.sendSocket(message), (peer, stream) => {
        if (!state) return;
        if (!stream) { sfuScreens.delete(peer); peerUpdate(peer, { screen: undefined }); return; }
        const wrapped = new rtc!.MediaStream(stream.getTracks() as any); sfuScreens.set(peer, wrapped);
        const announced = controls.get(peer)?.screenState;
        peerUpdate(peer, { screen: { stream: wrapped, quality: announced?.quality || '1080p60' } });
      });
      sfuSession = session;
      void session.start().then(() => controls.forEach(sendCaps)).catch(() => { if (sfuSession === session) { session.close(); sfuSession = null; } });
    }
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
        if (!state.peers.some(item => item.peer === from)) { playVoiceSound('join'); patch({ peers: [...state.peers, { peer: from, userId: data.userId, muted: false, connected: false }] }); }
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
    // Mute flags of everyone in the room, including a moderator's server mute / deafen.
    const byUser = new Map<string, any>(); for (const item of data.members) byUser.set(item.userId, item);
    const mine = state.userId ? byUser.get(state.userId) : null;
    const serverMuted = !!mine?.serverMuted, serverDeafened = !!mine?.serverDeafened;
    if (serverMuted && !state.muted) toggleVoiceMute();
    patch({ serverMuted, serverDeafened, peers: state.peers.map(item => { const m = byUser.get(item.userId); return m ? { ...item, muted: !!m.muted, serverMuted: !!m.serverMuted, serverDeafened: !!m.serverDeafened } : item; }) });
    applyAudio();
  } else if (data.type === 'voice.kicked' && data.channelId === state.channelId) cleanup('');
  else if (data.type === 'error' && state.status === 'connecting') { cleanup(''); set(null); }
  else if (data.type === 'ready' && state) {
    // The socket reconnected: the server forgot us, join again.
    stopVoiceScreen();
    const current = state; connections.forEach((_c, peer) => drop(peer, true));
    patch({ status: 'connecting', peers: [] });
    storeRef?.sendSocket({ type: 'voice.join', communityId: current.communityId, channelId: current.channelId, muted: current.muted });
  }
}

function cleanup(error: string) {
  stopVoiceScreen();
  connections.forEach(connection => { try { connection.close(); } catch { /* closed */ } });
  connections.clear(); screenSenders.clear(); screenAudioSenders.clear(); controls.clear(); remoteScreens.forEach((_stream, peer) => releaseRemoteScreen(peer));
  stopGate(); stopGate = () => {};
  sfuSession?.close(); sfuSession = null; sfuPeers.clear(); sfuScreens.clear(); shareKey = null;
  if (voiceHookOn) { voiceHookOn = false; setVoiceActive(false); }
  try { releaseLocalStream(local); } catch { /* released */ }
  local = null; unsubscribe?.(); unsubscribe = null;
  try { inCall?.stop?.(); } catch { /* optional */ }
  set(error && state ? { ...state, error } : null);
}

export async function joinVoice(api: Api, store: MessengerStore, target: { communityId: string; communityName: string; channelId: string; channelName: string; userId?: string }) {
  if (!voiceAvailable()) throw new Error('Голосовые каналы работают в приложении Android/iPhone.');
  if (state?.channelId === target.channelId) return;
  lastJoin = [api, store, target];
  if (state) leaveVoice();
  try { iceServers = (await api.callIce()).iceServers; } catch { /* public STUN only */ }
  local = await rtc!.mediaDevices.getUserMedia({ audio: true, video: false } as any);
  // PC: voice activation (Настройки → Звук и микрофон).
  if (Platform.OS === 'web') { stopGate = gateTrack(local.getAudioTracks()[0], () => !!state?.muted); setVoiceActive(true); voiceHookOn = true; overlayTrack('me', local.getAudioTracks()[0]); }
  if (!inCall) inCall = loadInCall();
  try { inCall?.start?.({ media: 'audio' }); inCall?.setForceSpeakerphoneOn?.(true); } catch { /* optional */ }
  storeRef = store;
  unsubscribe = store.onSocket(data => { void handle(data); });
  set({ ...target, sharing: null, screenStream: null, status: 'connecting', muted: false, deafened: false, speaker: true, peers: [], error: '' });
  if (!store.sendSocket({ type: 'voice.join', communityId: target.communityId, channelId: target.channelId })) { cleanup(''); throw new Error('Нет соединения с сервером.'); }
}

export function leaveVoice() {
  if (!state) return;
  playVoiceSound('leave');
  storeRef?.sendSocket({ type: 'voice.leave' });
  cleanup('');
}

export function toggleVoiceMute() {
  if (!state) return;
  const muted = !state.muted;
  if (!muted && state.serverMuted) { patch({ error: 'Модератор отключил тебе микрофон на этом сервере.' }); return; }
  try { local?.getAudioTracks().forEach((track: any) => { track.enabled = !muted; }); } catch { /* no track */ }
  storeRef?.sendSocket({ type: 'voice.mute', muted });
  patch({ muted });
}

/** Turn off the sound of everyone in the channel (and your microphone); press again to restore. */
let mutedBeforeDeafen = false;
export function toggleVoiceDeafen() {
  if (!state) return;
  const deafened = !state.deafened;
  if (!deafened && state.serverDeafened) { patch({ error: 'Модератор отключил тебе звук на этом сервере.' }); return; }
  state = { ...state, deafened };
  applyDeafen(deafened);
  if (deafened) { mutedBeforeDeafen = state.muted; if (!state.muted) toggleVoiceMute(); }
  else if (!mutedBeforeDeafen && state.muted) toggleVoiceMute();
  patch({ deafened });
}
function applyDeafen(_deafened: boolean) { applyAudio(); }
/** Whether this peer's audio plays: not while I'm deafened (by myself or a moderator), nor when they are server-muted. */
function audible(peer: string) {
  if (!state || state.deafened || state.serverDeafened) return false;
  return !state.peers.find(item => item.peer === peer)?.serverMuted;
}
function applyAudio() {
  for (const [peer, connection] of connections.entries()) for (const receiver of connection.getReceivers?.() || []) if (receiver.track?.kind === 'audio') receiver.track.enabled = audible(peer);
}

export function toggleVoiceSpeaker() {
  if (!state) return;
  const speaker = !state.speaker;
  try { inCall?.setForceSpeakerphoneOn?.(speaker); } catch { /* optional */ }
  patch({ speaker });
}

// PC: a different microphone picked in Настройки → Звук и микрофон takes effect at once,
// without leaving the channel (the old track is swapped in every connection).
if (Platform.OS === 'web') subscribeAudio(() => { void switchMicrophone(); });
// Binds (Настройки → Звук и микрофон): mute and deafen while in a channel.
let lastJoin: Parameters<typeof joinVoice> | null = null;
onBindAction(action => {
  if (action === 'rejoin') { if (!state && lastJoin) void joinVoice(...lastJoin).catch(() => {}); return; }
  if (action === 'toggleVoiceMode') { setAudioPrefs({ inputMode: audioPrefs().inputMode === 'ptt' ? 'activity' : 'ptt' }); return; }
  if (!state) return;
  if (action === 'mute') toggleVoiceMute();
  else if (action === 'deafen') toggleVoiceDeafen();
  else if (action === 'disconnect') leaveVoice();
  else if (action === 'screenShare') { if (state.sharing) stopVoiceScreen(); else void startVoiceScreen('1080p60').catch(() => {}); }
});
let lastInput = `${audioPrefs().input}|${audioPrefs().noiseSuppression}|${audioPrefs().echoCancellation}`;
let stopGate: () => void = () => {};
let voiceHookOn = false;
async function switchMicrophone() {
  const p = audioPrefs(); const input = `${p.input}|${p.noiseSuppression}|${p.echoCancellation}`;
  if (input === lastInput) return; lastInput = input;
  if (!state || !local || !rtc) return;
  const old = local.getAudioTracks()[0]; if (!old) return;
  const fresh = await rtc.mediaDevices.getUserMedia({ audio: true, video: false } as any).catch(() => null);
  if (!fresh || !state) { fresh?.getTracks().forEach((t: any) => t.stop()); return; }
  const track = fresh.getAudioTracks()[0]; track.enabled = !state.muted;
  for (const connection of connections.values()) for (const sender of connection.getSenders?.() || []) if (sender.track === old) await sender.replaceTrack(track).catch(() => {});
  try { local.removeTrack?.(old); local.addTrack?.(track); } catch { /* stream wrapper */ }
  stopGate(); stopGate = gateTrack(track, () => !!state?.muted);
  old.stop();
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
    // Through the SFU: one sealed upload for all PC viewers; direct copies only for the rest.
    let viaSfu = false;
    if (sfuSession) {
      try {
        shareKeyId = (shareKeyId + 1) % 256; shareKey = { raw: crypto.getRandomValues(new Uint8Array(16)), id: shareKeyId };
        controls.forEach((channel, peer) => { if (sfuPeers.has(peer)) sendKey(channel); });
        await sfuSession.publish(track, stream.getAudioTracks?.()[0] || null, shareKey.raw, shareKey.id, preset.maxBitrate);
        viaSfu = true;
      } catch { viaSfu = false; }
    }
    for (const [peer, sender] of [...screenSenders.entries()]) {
      if (viaSfu && sfuPeers.has(peer)) continue;
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
      for (const [peer, sender] of [...screenAudioSenders.entries()]) {
        if (viaSfu && sfuPeers.has(peer)) continue;
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
    // «Отмена» in the source picker is not an error: Chromium reports it as a refused/invalid capture.
    const text = String((error as Error)?.message || error);
    if ((error as Error)?.name === 'NotAllowedError' || (error as Error)?.name === 'AbortError' || /Invalid capture constraints/i.test(text)) return;
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
  void sfuSession?.unpublish(); shareKey = null;
  patch({ sharing: null, screenStream: null, sharingAudio: false });
  controls.forEach(sendScreenState);
  releaseLocalStream(previous);
}
