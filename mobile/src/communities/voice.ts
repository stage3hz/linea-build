import { Platform } from 'react-native';
import { audioPrefs, callAudio, callAudioKey, setAudioPrefs, subscribeAudio } from '../audio/devices';
import { gateTrack } from '../audio/gate';
import { applyStudio } from '../audio/studioSound';
import { onBindAction, setVoiceActive } from '../audio/binds';
import { playVoiceSound } from './voiceSounds';
import { connectOverlay, overlayTrack, overlayVoiceChanged } from '../overlay/sync';
import { unwatchVoice } from '../overlay/speaking';
import { SfuSession, sfuUsable } from './sfu/session';
import { authText, checkAuth } from './voiceAuth';
import { prepareScreenCapture, confirmScreenCapture, endScreenCapture } from './screenCapture';
import { useSyncExternalStore } from 'react';
import type { Api } from '../api';
import type { MessengerStore } from '../useMessenger';
import { SCREEN_QUALITIES, screenControl, screenQuality, stereoScreenAudio, type ScreenQuality } from './screenShareModel';
import { GATHER_TIMEOUT_MS } from '../calls/callModel';
import { DISCONNECT_GRACE_MS, LINK_UP, POLITE_EXTRA_MS, linkNext, markRestartCapable, remoteRestart, restartCapable, sameFingerprints, stripRestartMarker, voiceRestartOfferer, type Link, type LinkInput } from '../calls/reconnect';
import { onNetworkChange } from '../network/netChange';

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
// End-to-end check of every connection (voiceAuth.ts): until the other side's Signal note matches
// the DTLS fingerprints we negotiated, nothing private goes to them or is played from them.
let selfPeer: string | null = null;
const peerInfo = new Map<string, { userId: string; device: string | null }>();
const verified = new Set<string>();
const authSdp = new Map<string, { local: string; remote: string; connection: any }>();
const pendingNotes = new Map<string, any>();
const pendingKeys = new Map<string, { keyId: number; raw: Uint8Array }>();
const micSenders = new Map<string, any>();
const authTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTH_TIMEOUT_MS = 20_000;
const REFUSED = 'Не удалось подтвердить шифрование с участником — соединение с ним отключено.';
function sendKey(channel: any) { if (shareKey && channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'screenKey', keyId: shareKey.id, key: b64(shareKey.raw) })); }
// `sfu`: opens legacy-layout SFU frames (PC apps up to 0.14.13 send only to peers saying this);
// `lk`: opens «lk» frames (frameCrypto.ts) — PCs and phones whose WebRTC build has a FrameCryptor.
function sendCaps(channel: any) { if (channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'caps', sfu: Platform.OS === 'web' && !!sfuSession, lk: !!sfuSession })); }
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
        if (extra.lk === true && sfuSession) {
          sfuPeers.add(peer);
          // Already sharing: this viewer now gets the picture from the server — stop the direct copy.
          if (screenStream && shareKey && verified.has(peer)) { sendKey(channel); void screenSenders.get(peer)?.replaceTrack(null).catch(() => {}); void screenAudioSenders.get(peer)?.replaceTrack(null).catch(() => {}); }
        }
        return;
      }
      if (extra?.type === 'screenKey' && Number.isInteger(extra.keyId) && extra.keyId >= 0 && extra.keyId < 256 && typeof extra.key === 'string' && extra.key.length <= 44) {
        try {
          const raw = unb64(extra.key);
          if (raw.length === 16) { if (verified.has(peer)) void sfuSession?.setPeerKey(peer, extra.keyId, raw); else pendingKeys.set(peer, { keyId: extra.keyId, raw }); }
        } catch { /* bad key */ }
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


let ownDevice: string | null = null;
/** WebCrypto where there is one (PC); expo-crypto on phones. */
const randomBytes = (n: number): Uint8Array => {
  const web = (globalThis as any).crypto;
  return web?.getRandomValues ? web.getRandomValues(new Uint8Array(n)) : require('expo-crypto').getRandomBytes(n);
};
let sharingViaSfu = false;

/** A direct copy of the screen (and the PC's sound) for one verified peer. */
async function serveScreen(peer: string) {
  const stream = screenStream, quality = state?.sharing;
  if (!stream || !quality) return;
  const preset = SCREEN_QUALITIES[quality];
  const sender = screenSenders.get(peer), track = stream.getVideoTracks()[0];
  if (sender && track) {
    await sender.replaceTrack(track);
    const parameters = sender.getParameters();
    if (parameters.encodings?.length) { parameters.encodings[0].maxBitrate = preset.maxBitrate; parameters.encodings[0].maxFramerate = 60; await sender.setParameters(parameters); }
  }
  const sound = stream.getAudioTracks?.()[0], soundSender = screenAudioSenders.get(peer);
  if (sound && soundSender) {
    await soundSender.replaceTrack(sound);
    const parameters = soundSender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = SCREEN_AUDIO_BITRATE;
    await soundSender.setParameters(parameters).catch(() => {});
  }
}

function unverify(peer: string) {
  forgetLink(peer);
  verified.delete(peer); authSdp.delete(peer); pendingNotes.delete(peer); pendingKeys.delete(peer); micSenders.delete(peer);
  const timer = authTimers.get(peer); if (timer) clearTimeout(timer); authTimers.delete(peer);
}

function refuse(peer: string) {
  if (!state) return;
  drop(peer, true);
  patch({ error: REFUSED });
}

/**
 * Both SDPs of the connection are known: send our note (sealed for the peer's device) and check
 * theirs. Runs alongside ICE/DTLS, so it adds no round trip before the call starts.
 */
function startAuth(peer: string, connection: any, localSdp: string, remoteSdp: string) {
  if (connections.get(peer) !== connection || !state || !selfPeer) return;
  authSdp.set(peer, { local: localSdp, remote: remoteSdp, connection });
  const channelId = state.channelId, self = selfPeer, info = peerInfo.get(peer);
  authTimers.set(peer, setTimeout(() => { if (connections.get(peer) === connection && !verified.has(peer)) refuse(peer); }, AUTH_TIMEOUT_MS));
  if (!info?.device) return; // the timer refuses it: an app without the check, or the server hid the device
  void (async () => {
    const crypto = await storeRef!.cryptoRuntime.get();
    let note;
    try { note = await crypto.sealNote(info.userId, info.device!, authText(channelId, self, peer, localSdp, remoteSdp)); }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); note = await crypto.sealNote(info.userId, info.device!, authText(channelId, self, peer, localSdp, remoteSdp)); }
    if (connections.get(peer) === connection) storeRef?.sendSocket({ type: 'voice.auth', to: peer, note });
  })().catch(() => { if (connections.get(peer) === connection) refuse(peer); });
  const waiting = pendingNotes.get(peer); pendingNotes.delete(peer);
  if (waiting) void verifyNote(peer, waiting);
}

async function verifyNote(peer: string, note: any) {
  const auth = authSdp.get(peer), info = peerInfo.get(peer);
  if (!auth || !info || !state || !selfPeer || verified.has(peer)) return;
  const expected = { channelId: state.channelId, self: selfPeer, peer, localSdp: auth.local, remoteSdp: auth.remote };
  let ok = false;
  try {
    // The note must come from the device the server named for this person.
    if (note?.senderDeviceId !== info.device) throw new Error('device');
    const text = await storeRef!.cryptoRuntime.get().then(crypto => crypto.openNote(info.userId, note));
    ok = checkAuth(text, expected);
  } catch { ok = false; }
  if (connections.get(peer) !== auth.connection) return;
  if (!ok) { refuse(peer); return; }
  verified.add(peer);
  const timer = authTimers.get(peer); if (timer) clearTimeout(timer); authTimers.delete(peer);
  onVerified(peer);
}

/** The connection is proven end to end: sound both ways, the screen and its frame keys. */
function onVerified(peer: string) {
  applyAudio();
  const mic = local?.getAudioTracks?.()[0];
  if (mic) void micSenders.get(peer)?.replaceTrack(mic).catch(() => {});
  const key = pendingKeys.get(peer); pendingKeys.delete(peer);
  if (key) void sfuSession?.setPeerKey(peer, key.keyId, key.raw);
  if (screenStream && state?.sharing) {
    if (sharingViaSfu && sfuPeers.has(peer)) sendKey(controls.get(peer));
    else void serveScreen(peer).catch(() => {});
  }
}

// ---- Automatic reconnection of a verified peer (calls/reconnect.ts) ---------------------------------------
// A verified connection that drops gets an ICE restart through the same voice.signal path. The server strips
// every field but kind/sdp, so a restart is recognised by its DTLS fingerprints: an offer with exactly the
// fingerprints this connection was verified with (voiceAuth) is a restart of it; anything else is a new
// connection and goes through the full check again. The certificate of a connection does not change on an
// ICE restart, so the verification stays valid; a restart answer with other fingerprints is refused. Only
// peers whose SDP says they understand restarts get one (older apps would start over and be refused).
const links = new Map<string, { link: Link; timer?: ReturnType<typeof setTimeout>; pendingAt?: number }>();
function forgetLink(peer: string) { const entry = links.get(peer); if (entry?.timer) clearTimeout(entry.timer); links.delete(peer); }

const gatheredAgain = (connection: any) => new Promise<string>(resolve => {
  const onChange = () => { if (connection.iceGatheringState === 'complete') done(); };
  const done = () => { clearTimeout(timer); connection.removeEventListener?.('icegatheringstatechange', onChange); resolve(connection.localDescription?.sdp || ''); };
  const timer = setTimeout(done, GATHER_TIMEOUT_MS);
  connection.addEventListener('icegatheringstatechange', onChange);
});

function feedLink(peer: string, connection: any, input: LinkInput) {
  if (!state || !selfPeer || connections.get(peer) !== connection || !verified.has(peer)) return;
  const entry = links.get(peer) || { link: LINK_UP };
  const polite = !voiceRestartOfferer(selfPeer, peer);
  const step = linkNext(entry.link, input, Date.now(), { graceMs: DISCONNECT_GRACE_MS + (polite ? POLITE_EXTRA_MS : 0) });
  if (entry.timer) clearTimeout(entry.timer);
  entry.link = step.link;
  entry.timer = step.wakeAt === null ? undefined : setTimeout(() => feedLink(peer, connection, { kind: 'timer' }), Math.max(0, step.wakeAt - Date.now()));
  links.set(peer, entry);
  if (step.end) peerUpdate(peer, { connected: false }); // as before: shown as not connected, still in the room
  if (step.restart) void restartPeer(peer, connection);
}

async function restartPeer(peer: string, connection: any) {
  const auth = authSdp.get(peer), entry = links.get(peer);
  if (!auth || !entry || !restartCapable(auth.remote) || (connection.signalingState !== 'stable' && connection.signalingState !== 'have-local-offer')) return;
  entry.pendingAt = Date.now();
  try {
    const fresh = gatheredAgain(connection);
    const offer = await connection.createOffer({ iceRestart: true } as any);
    await connection.setLocalDescription({ type: offer.type, sdp: stereoScreenAudio(offer.sdp) });
    const sdp = await fresh;
    if (connections.get(peer) !== connection) return;
    storeRef?.sendSocket({ type: 'voice.signal', to: peer, data: { kind: 'offer', sdp: markRestartCapable(sdp) } });
  } catch { /* the next attempt is on the timer */ }
}

/** An offer for a verified connection with the same fingerprints: answer it on that connection. True if handled. */
async function acceptRestart(from: string, sdp: string): Promise<boolean> {
  const connection = connections.get(from), auth = authSdp.get(from);
  if (!connection || !auth || !verified.has(from) || !selfPeer || !sameFingerprints(sdp, auth.remote)) return false;
  const decision = remoteRestart({ gen: 1, lastRemoteGen: 0, signalingState: connection.signalingState, polite: !voiceRestartOfferer(selfPeer, from), fingerprintsMatch: true, pendingAgeMs: Date.now() - (links.get(from)?.pendingAt ?? 0) });
  if (decision === 'ignore-glare') return true; // ours wins: they answer it
  try {
    if (decision === 'rollback-and-answer') await connection.setLocalDescription({ type: 'rollback', sdp: '' });
    await connection.setRemoteDescription(new rtc!.RTCSessionDescription({ type: 'offer', sdp: stripRestartMarker(sdp) }));
    const fresh = gatheredAgain(connection);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription({ type: answer.type, sdp: stereoScreenAudio(answer.sdp) });
    const local = await fresh;
    if (connections.get(from) !== connection) return true;
    // Our certificate did not change either; if it somehow did, the verification no longer holds.
    if (!sameFingerprints(local, auth.local)) { refuse(from); return true; }
    storeRef?.sendSocket({ type: 'voice.signal', to: from, data: { kind: 'answer', sdp: markRestartCapable(local) } });
  } catch { /* they retry */ }
  return true;
}

// Wi-Fi ↔ LTE or a new IP while in a room: restart ICE with every verified peer at once.
let stopNetwork: (() => void) | null = null;

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
  unverify(peer);
  const connection: any = new rtc!.RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' } as any);
  // Reserve a video slot before the first SDP exchange. Screen start/stop only replaces
  // this track, so simultaneous shares never tear down audio or race renegotiations.
  const video = connection.addTransceiver('video', { direction: 'sendrecv' });
  screenSenders.set(peer, video.sender); // the screen goes in once the connection is verified
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
  // The microphone's slot is negotiated now, but the sound goes in only once the connection is verified.
  local?.getTracks().forEach((track: any) => {
    const sender = connection.addTrack(track, local);
    if (track.kind === 'audio') { micSenders.set(peer, sender); void sender.replaceTrack(null).catch(() => {}); }
  });
  // Reserved after the microphone so addTrack never lands in it. Sharing only swaps its track.
  const sound = connection.addTransceiver('audio', { direction: 'sendrecv' });
  screenAudioSenders.set(peer, sound.sender);
  connection.addEventListener('connectionstatechange', () => {
    if (connections.get(peer) !== connection) return;
    const value = connection.connectionState;
    feedLink(peer, connection, { kind: 'state', state: value });
    if (value === 'connected') {
      peerUpdate(peer, { connected: true });
      if (state?.sharing && screenStream && verified.has(peer)) {
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
  unverify(peer); peerInfo.delete(peer);
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
    selfPeer = typeof data.self === 'string' ? data.self : null;
    for (const item of data.peers || []) peerInfo.set(item.peer, { userId: item.userId, device: typeof item.device === 'string' ? item.device : null });
    if (data.sfu === true && sfuUsable(rtc) && !sfuSession) {
      const session = new SfuSession(message => !!storeRef?.sendSocket(message), (peer, stream) => {
        if (!state) return;
        if (!stream) { sfuScreens.delete(peer); peerUpdate(peer, { screen: undefined }); return; }
        const wrapped = new rtc!.MediaStream(stream.getTracks() as any); sfuScreens.set(peer, wrapped);
        const announced = controls.get(peer)?.screenState;
        peerUpdate(peer, { screen: { stream: wrapped, quality: announced?.quality || '1080p60' } });
      }, rtc);
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
        storeRef?.sendSocket({ type: 'voice.signal', to: item.peer, data: { kind: 'offer', sdp: markRestartCapable(sdp) } });
      } catch { drop(item.peer); }
    }
  } else if (data.type === 'voice.signal' && data.channelId === state.channelId && data.data) {
    const from = data.from as string;
    if (data.data.kind === 'offer' && typeof data.data.sdp === 'string' && await acceptRestart(from, data.data.sdp)) return;
    if (data.data.kind === 'offer') peerInfo.set(from, { userId: data.userId, device: typeof data.device === 'string' ? data.device : null });
    if (data.data.kind === 'offer') {
      try {
        if (!state.peers.some(item => item.peer === from)) { playVoiceSound('join'); patch({ peers: [...state.peers, { peer: from, userId: data.userId, muted: false, connected: false }] }); }
        try { connections.get(from)?.close(); } catch { /* replaced */ }
        const connection = connectionFor(from);
        await connection.setRemoteDescription(new rtc!.RTCSessionDescription({ type: 'offer', sdp: stripRestartMarker(data.data.sdp) }));
        const answer = await connection.createAnswer();
        await connection.setLocalDescription({ type: answer.type, sdp: stereoScreenAudio(answer.sdp) });
        const sdp = await gathered(connection);
        storeRef?.sendSocket({ type: 'voice.signal', to: from, data: { kind: 'answer', sdp: markRestartCapable(sdp) } });
        startAuth(from, connection, sdp, data.data.sdp);
      } catch { drop(from); }
    } else if (data.data.kind === 'answer') {
      const connection = connections.get(from);
      if (connection && connection.signalingState === 'have-local-offer') {
        // The answer to an ICE restart of a verified connection: same fingerprints or refused.
        const auth = verified.has(from) ? authSdp.get(from) : undefined;
        if (auth) {
          if (!sameFingerprints(data.data.sdp, auth.remote)) { refuse(from); return; }
          try { await connection.setRemoteDescription(new rtc!.RTCSessionDescription({ type: 'answer', sdp: stripRestartMarker(data.data.sdp) })); } catch { /* the next attempt is on the timer */ }
          return;
        }
        try { await connection.setRemoteDescription(new rtc!.RTCSessionDescription({ type: 'answer', sdp: stripRestartMarker(data.data.sdp) })); } catch { drop(from); return; }
        startAuth(from, connection, connection.localDescription?.sdp || '', data.data.sdp);
      }
    }
  } else if (data.type === 'voice.auth' && data.channelId === state.channelId && typeof data.from === 'string' && data.note) {
    if (authSdp.has(data.from)) void verifyNote(data.from, data.note); else pendingNotes.set(data.from, data.note);
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
    storeRef?.sendSocket({ type: 'voice.join', communityId: current.communityId, channelId: current.channelId, muted: current.muted, device: ownDevice });
  }
}

function cleanup(error: string) {
  stopVoiceScreen();
  connections.forEach(connection => { try { connection.close(); } catch { /* closed */ } });
  connections.clear(); screenSenders.clear(); screenAudioSenders.clear(); controls.clear(); remoteScreens.forEach((_stream, peer) => releaseRemoteScreen(peer));
  stopGate(); stopGate = () => {};
  sfuSession?.close(); sfuSession = null; sfuPeers.clear(); sfuScreens.clear(); shareKey = null;
  authTimers.forEach(timer => clearTimeout(timer)); authTimers.clear();
  links.forEach(entry => { if (entry.timer) clearTimeout(entry.timer); }); links.clear();
  stopNetwork?.(); stopNetwork = null;
  verified.clear(); authSdp.clear(); pendingNotes.clear(); pendingKeys.clear(); micSenders.clear(); peerInfo.clear(); selfPeer = null; sharingViaSfu = false;
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
  // Our encryption device: the others seal their connection notes for exactly this device.
  const crypto = await store.cryptoRuntime.get(); await crypto.initialize();
  const device = crypto.deviceId;
  if (!device) throw new Error('Шифрование ещё не готово. Попробуй ещё раз.');
  local = withStudio(await rtc!.mediaDevices.getUserMedia({ audio: micRequest(), video: false } as any));
  // PC: voice activation (Настройки → Звук и микрофон).
  if (Platform.OS === 'web') { stopGate = gateTrack(local.getAudioTracks()[0], () => !!state?.muted); setVoiceActive(true); voiceHookOn = true; overlayTrack('me', local.getAudioTracks()[0]); }
  if (!inCall) inCall = loadInCall();
  try { inCall?.start?.({ media: 'audio' }); inCall?.setForceSpeakerphoneOn?.(true); } catch { /* optional */ }
  storeRef = store;
  unsubscribe = store.onSocket(data => { void handle(data); });
  stopNetwork?.(); stopNetwork = onNetworkChange(() => connections.forEach((connection, peer) => feedLink(peer, connection, { kind: 'network' })));
  set({ ...target, sharing: null, screenStream: null, status: 'connecting', muted: false, deafened: false, speaker: true, peers: [], error: '' });
  ownDevice = device;
  if (!store.sendSocket({ type: 'voice.join', communityId: target.communityId, channelId: target.channelId, device })) { cleanup(''); throw new Error('Нет соединения с сервером.'); }
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
  if (!state || state.deafened || state.serverDeafened || !verified.has(peer)) return false;
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
// without leaving the channel (the old track is swapped in every connection). Phones: «Шумоподавление»
// (Настройки › Уведомления и звуки › Звонки) the same way; the native audio processing does the work.
subscribeAudio(() => { void switchMicrophone(); });
/** PC: the room keeps the sound as the PC gives it (Звук и микрофон); phones: the call processing with the switch. */
const micRequest = () => Platform.OS === 'web' ? true : callAudio(true);
const micKey = () => Platform.OS === 'web' ? `${audioPrefs().input}|${audioPrefs().noiseSuppression}|${audioPrefs().echoCancellation}|${audioPrefs().studioSound}` : callAudioKey(true);
/** PC: «Студийный звук (тест)» swaps the raw microphone for the EQ'd one (the gate and mute act on that track). */
const withStudio = (stream: any) => Platform.OS === 'web' && audioPrefs().studioSound ? applyStudio(stream) : stream;
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
let lastInput = micKey();
let stopGate: () => void = () => {};
let voiceHookOn = false;
async function switchMicrophone() {
  const input = micKey();
  if (input === lastInput) return; lastInput = input;
  if (!state || !local || !rtc) return;
  const old = local.getAudioTracks()[0]; if (!old) return;
  const fresh = await rtc.mediaDevices.getUserMedia({ audio: micRequest(), video: false } as any).then(withStudio).catch(() => null);
  if (!fresh || !state) { fresh?.getTracks().forEach((t: any) => t.stop()); return; }
  const track = fresh.getAudioTracks()[0]; track.enabled = !state.muted;
  for (const connection of connections.values()) for (const sender of connection.getSenders?.() || []) if (sender.track === old) await sender.replaceTrack(track).catch(() => {});
  try { local.removeTrack?.(old); local.addTrack?.(track); } catch { /* stream wrapper */ }
  if (Platform.OS === 'web') { stopGate(); stopGate = gateTrack(track, () => !!state?.muted); }
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
    // The LiveKit build's getDisplayMedia() declares no parameters (phones ignore them; size and fps
    // are set by applyConstraints below); browsers need them, so the call keeps passing them.
    stream = await (rtc!.mediaDevices as any).getDisplayMedia({
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
    // Through the SFU: one sealed upload for all SFU viewers; direct copies only for the rest.
    // Frame keys and direct copies go only to verified connections; the others get theirs on verification.
    let viaSfu = false;
    if (sfuSession) {
      try {
        // Key index 0..15: the FrameCryptor's key ring (frameCrypto.ts LK_KEY_RING); a new key per share.
        shareKeyId = (shareKeyId + 1) % 16; shareKey = { raw: randomBytes(16), id: shareKeyId };
        controls.forEach((channel, peer) => { if (sfuPeers.has(peer) && verified.has(peer)) sendKey(channel); });
        await sfuSession.publish(track, stream.getAudioTracks?.()[0] || null, shareKey.raw, shareKey.id, preset.maxBitrate);
        viaSfu = true;
      } catch { viaSfu = false; }
    }
    sharingViaSfu = viaSfu;
    const sound = stream.getAudioTracks?.()[0];
    if (sound) { try { sound.contentHint = 'music'; } catch { /* optional */ } }
    for (const peer of [...screenSenders.keys()]) {
      if (generation !== shareGeneration || !state) throw new Error('Запуск отменён.');
      if (!verified.has(peer) || (viaSfu && sfuPeers.has(peer))) continue;
      await serveScreen(peer);
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
  void sfuSession?.unpublish(); shareKey = null; sharingViaSfu = false;
  patch({ sharing: null, screenStream: null, sharingAudio: false });
  controls.forEach(sendScreenState);
  releaseLocalStream(previous);
}
