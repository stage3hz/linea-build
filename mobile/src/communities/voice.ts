import { useSyncExternalStore } from 'react';
import type { Api } from '../api';
import type { MessengerStore } from '../useMessenger';
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

export type VoicePeer = { peer: string; userId: string; muted: boolean; connected: boolean };
export type VoiceState = {
  communityId: string; channelId: string; channelName: string; communityName: string;
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

function connectionFor(peer: string) {
  const connection: any = new rtc!.RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' } as any);
  local?.getTracks().forEach((track: any) => connection.addTrack(track, local));
  connection.addEventListener('connectionstatechange', () => {
    const value = connection.connectionState;
    if (value === 'connected') peerUpdate(peer, { connected: true });
    else if (value === 'failed' || value === 'closed') peerUpdate(peer, { connected: false });
  });
  connections.set(peer, connection);
  return connection;
}

function drop(peer: string) {
  try { connections.get(peer)?.close(); } catch { /* closed */ }
  connections.delete(peer);
  if (state) patch({ peers: state.peers.filter(item => item.peer !== peer) });
}

async function handle(data: any) {
  if (!state) return;
  if (data.type === 'voice.joined' && data.channelId === state.channelId) {
    patch({ status: 'connected', peers: (data.peers || []).map((item: any) => ({ peer: item.peer, userId: item.userId, muted: !!item.muted, connected: false })) });
    // The newcomer calls everyone already in the room.
    for (const item of data.peers || []) {
      try {
        const connection = connectionFor(item.peer);
        await connection.setLocalDescription(await connection.createOffer({ offerToReceiveAudio: true } as any));
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
        await connection.setLocalDescription(await connection.createAnswer());
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
    const current = state; connections.forEach((_c, peer) => drop(peer));
    patch({ status: 'connecting', peers: [] });
    storeRef?.sendSocket({ type: 'voice.join', communityId: current.communityId, channelId: current.channelId, muted: current.muted });
  }
}

function cleanup(error: string) {
  connections.forEach(connection => { try { connection.close(); } catch { /* closed */ } });
  connections.clear();
  try { local?.getTracks().forEach((track: any) => track.stop()); } catch { /* released */ }
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
  set({ ...target, status: 'connecting', muted: false, speaker: true, peers: [], error: '' });
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
