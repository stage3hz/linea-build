// Screen sharing through the SFU (server/src/sfu.js). The sharer uploads one copy; every frame is
// sealed with the share key before it leaves the device, and viewers open frames only with keys
// received over their verified peer-to-peer channels (voiceAuth.ts). The server never sees a picture.
//
// Two ways to seal/open frames, same bytes (frameCrypto.ts, layout «lk»):
//  • PC (Chromium, Electron): insertable streams + WebCrypto (frameCrypto.ts);
//  • phone: the native FrameCryptor of the WebRTC build, when it has one
//    (@livekit/react-native-webrtc: RTCFrameCryptorFactory). The stock react-native-webrtc 124 has
//    none — phones then keep getting a direct copy over the mesh (voice.ts decides).
import { Platform } from 'react-native';
import { LK_KEY_RING, LK_SALT, deriveLkKey, frameCryptoSupported, importKey, openAnyFrame, sealFrameLk, transformFrames, type PeerFrameKeys } from './frameCrypto';

type Send = (message: Record<string, unknown>) => boolean;
type RemoteScreen = (peer: string, stream: MediaStream | null) => void;

/** The native FrameCryptor API of the WebRTC module, or null (stock react-native-webrtc). */
export function nativeFrameKit(rtc: any): any | null {
  const factory = rtc?.RTCFrameCryptorFactory;
  return factory && typeof factory.createDefaultKeyProvider === 'function' && typeof factory.createFrameCryptorForRtpReceiver === 'function' && typeof factory.createFrameCryptorForRtpSender === 'function' ? rtc : null;
}
/** Can this device take part in SFU screen sharing (open and seal «lk» frames)? */
export const sfuUsable = (rtc?: any) => Platform.OS === 'web' ? typeof window !== 'undefined' && frameCryptoSupported() : !!nativeFrameKit(rtc);

/** Frame sealing on one platform. Keys are by person; key index 0..15 (LK_KEY_RING). */
interface Cipher {
  setPeerKey(peer: string, keyId: number, raw: Uint8Array): Promise<void>;
  openReceiver(peer: string, receiver: any, kind: 'audio' | 'video'): Promise<() => void>;
  sealSender(sender: any, kind: 'audio' | 'video', raw: Uint8Array, keyIndex: number): Promise<() => void>;
  forget(peer: string): void;
  close(): void;
}

class WebCipher implements Cipher {
  private keys = new Map<string, PeerFrameKeys>();
  async setPeerKey(peer: string, keyId: number, raw: Uint8Array) {
    const entry = this.keys.get(peer) || { lk: new Map(), legacy: new Map() };
    // Apps up to 0.14.13 seal in the legacy layout with the raw key; current ones in «lk».
    entry.legacy.set(keyId, await importKey(raw)); if (entry.legacy.size > 4) entry.legacy.delete(entry.legacy.keys().next().value as number);
    if (keyId < LK_KEY_RING) entry.lk.set(keyId, await deriveLkKey(raw));
    this.keys.set(peer, entry);
  }
  async openReceiver(peer: string, receiver: any, kind: 'audio' | 'video') {
    transformFrames(receiver, data => openAnyFrame(this.keys.get(peer), kind, data));
    return () => {};
  }
  async sealSender(sender: any, kind: 'audio' | 'video', raw: Uint8Array, keyIndex: number) {
    const key = await deriveLkKey(raw);
    const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    transformFrames(sender, data => sealFrameLk(key, keyIndex, kind, data, random));
    return () => {};
  }
  forget(peer: string) { this.keys.delete(peer); }
  close() { this.keys.clear(); }
}

const SELF = 'self';
class NativeCipher implements Cipher {
  private provider: any;
  constructor(private readonly rtc: any) {
    this.provider = rtc.RTCFrameCryptorFactory.createDefaultKeyProvider({
      sharedKey: false, ratchetSalt: LK_SALT, ratchetWindowSize: 0, failureTolerance: -1,
      keyRingSize: LK_KEY_RING, discardFrameWhenCryptorNotReady: true,
      keyDerivationAlgorithm: rtc.RTCKeyDerivationAlgorithm?.HKDF ?? 1,
    });
  }
  async setPeerKey(peer: string, keyId: number, raw: Uint8Array) {
    if (keyId >= LK_KEY_RING || peer === SELF) return; // a legacy-layout key: such a sharer sends phones a direct copy
    await this.provider.setKey(peer, raw, keyId);
  }
  private async cryptor(create: () => any, keyIndex?: number) {
    const cryptor = create();
    if (keyIndex !== undefined) await cryptor.setKeyIndex(keyIndex);
    if (!(await cryptor.setEnabled(true))) { void cryptor.dispose().catch(() => {}); throw new Error('frame cryptor'); }
    return () => { void cryptor.dispose().catch(() => {}); };
  }
  async openReceiver(peer: string, receiver: any) {
    return this.cryptor(() => this.rtc.RTCFrameCryptorFactory.createFrameCryptorForRtpReceiver(peer, receiver, 0 /* AES-GCM */, this.provider));
  }
  async sealSender(sender: any, _kind: 'audio' | 'video', raw: Uint8Array, keyIndex: number) {
    await this.provider.setKey(SELF, raw, keyIndex);
    return this.cryptor(() => this.rtc.RTCFrameCryptorFactory.createFrameCryptorForRtpSender(SELF, sender, 0 /* AES-GCM */, this.provider), keyIndex);
  }
  forget(_peer: string) { /* keys are replaced on the next share; the provider goes with the session */ }
  close() { void this.provider?.dispose?.().catch(() => {}); }
}

export class SfuSession {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private device: any = null;
  private recv: any = null;
  private sendTransport: any = null;
  private producers: { producer: any; release: () => void }[] = [];
  private streams = new Map<string, MediaStream>();
  private consumers = new Map<string, { peer: string; consumer: any; release: () => void }>();
  private closed = false;
  private readonly cipher: Cipher;
  private readonly web = Platform.OS === 'web';

  /** `rtc`: the WebRTC module on phones (its FrameCryptor and classes); unused on PC. */
  constructor(private readonly send: Send, private readonly onRemote: RemoteScreen, private readonly rtc?: any) {
    this.cipher = this.web ? new WebCipher() : new NativeCipher(nativeFrameKit(rtc));
  }

  private request<T = any>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Сервер не ответил.')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ type: 'sfu', id, op, ...payload })) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Нет соединения с сервером.')); }
    });
  }

  /** WebSocket messages for this session. Returns true when handled. */
  handle(data: any): boolean {
    if (data?.type === 'sfu.reply') {
      const p = this.pending.get(data.id); if (!p) return true;
      this.pending.delete(data.id); clearTimeout(p.timer);
      if (data.ok) p.resolve(data.data); else p.reject(new Error(data.error || 'Ошибка сервера демонстрации.'));
      return true;
    }
    if (data?.type === 'sfu.producer' && typeof data.peer === 'string' && typeof data.producerId === 'string') { void this.consume(data.peer, data.producerId).catch(() => {}); return true; }
    if (data?.type === 'sfu.closed' && typeof data.consumerId === 'string') { this.dropConsumer(data.consumerId); return true; }
    return false;
  }

  async start() {
    const { Device } = await import('mediasoup-client');
    if (!this.web) {
      // mediasoup-client's ReactNative106 handler uses the WebRTC classes as globals.
      const g = globalThis as any;
      for (const name of ['RTCPeerConnection', 'RTCRtpTransceiver', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCSessionDescription', 'RTCIceCandidate', 'MediaStream', 'MediaStreamTrack']) if (!g[name] && this.rtc?.[name]) g[name] = this.rtc[name];
    }
    this.device = this.web ? new Device() : new Device({ handlerName: 'ReactNative106' });
    const { rtpCapabilities } = await this.request('caps');
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });
    this.recv = await this.transport('recv');
    const { producers } = await this.request<{ producers: { peer: string; producerId: string }[] }>('producers');
    for (const p of producers) void this.consume(p.peer, p.producerId).catch(() => {});
  }

  private async transport(direction: 'send' | 'recv') {
    const params = await this.request('transport', { direction });
    const options = this.web ? { ...params, additionalSettings: { encodedInsertableStreams: true } } : params;
    const t = direction === 'send' ? this.device.createSendTransport(options) : this.device.createRecvTransport(options);
    t.on('connect', ({ dtlsParameters }: any, done: () => void, fail: (e: Error) => void) => { this.request('connect', { transportId: t.id, dtlsParameters }).then(done, fail); });
    if (direction === 'send') t.on('produce', ({ kind, rtpParameters, appData }: any, done: (v: { id: string }) => void, fail: (e: Error) => void) => {
      this.request('produce', { transportId: t.id, kind, rtpParameters, source: appData.source }).then(r => done({ id: r.producerId }), fail);
    });
    return t;
  }

  /** Share: one upload to the server, sealed with `rawKey` (key index 0..15 lets viewers pick the right key). */
  async publish(video: MediaStreamTrack, audio: MediaStreamTrack | null, rawKey: Uint8Array, keyIndex: number, maxBitrate: number) {
    if (!this.sendTransport) this.sendTransport = await this.transport('send');
    const one = async (kind: 'audio' | 'video', track: MediaStreamTrack, options: Record<string, unknown>) => {
      // Chromium holds frames until the transform is attached (encodedInsertableStreams). The native
      // cryptor is attached only after produce(), so the track stays disabled until then: nothing but
      // black frames / silence can leave unsealed.
      const enabled = track.enabled;
      if (!this.web) track.enabled = false;
      let producer: any = null;
      try {
        producer = await this.sendTransport.produce({ track, ...options });
        const release = await this.cipher.sealSender(producer.rtpSender, kind, rawKey, keyIndex);
        this.producers.push({ producer, release });
      } catch (error) {
        if (producer) { try { producer.close(); } catch { /* closed */ } void this.request('close', { producerId: producer.id }).catch(() => {}); }
        throw error;
      } finally { if (!this.web) track.enabled = enabled; }
    };
    await one('video', video, { encodings: [{ maxBitrate, maxFramerate: 60 }], codecOptions: { videoGoogleStartBitrate: 2000 }, appData: { source: 'screen' } });
    if (audio) await one('audio', audio, { codecOptions: { opusStereo: true, opusDtx: false, opusMaxAverageBitrate: 128_000 }, appData: { source: 'screenAudio' } });
  }

  async unpublish() {
    const list = this.producers; this.producers = [];
    for (const { producer, release } of list) { release(); try { producer.close(); } catch { /* closed */ } void this.request('close', { producerId: producer.id }).catch(() => {}); }
  }

  /** Key a person sent us over their own verified peer-to-peer channel. */
  async setPeerKey(peer: string, keyId: number, raw: Uint8Array) { await this.cipher.setPeerKey(peer, keyId, raw); }

  private async consume(peer: string, producerId: string) {
    if (this.closed || !this.recv) return;
    const r = await this.request('consume', { transportId: this.recv.id, producerId, rtpCapabilities: this.device.rtpCapabilities });
    const consumer = await this.recv.consume({ id: r.consumerId, producerId: r.producerId, kind: r.kind, rtpParameters: r.rtpParameters });
    let release: () => void;
    try { release = await this.cipher.openReceiver(peer, consumer.rtpReceiver, r.kind); }
    catch (error) { try { consumer.close(); } catch { /* closed */ } throw error; } // never show frames we cannot open
    this.consumers.set(consumer.id, { peer, consumer, release });
    const stream = this.streams.get(peer) || new (this.web ? MediaStream : this.rtc.MediaStream)();
    stream.addTrack(consumer.track); this.streams.set(peer, stream);
    await this.request('resume', { consumerId: consumer.id });
    if (r.kind === 'video') this.onRemote(peer, stream);
  }

  private dropConsumer(consumerId: string) {
    const item = this.consumers.get(consumerId); if (!item) return;
    this.consumers.delete(consumerId);
    item.release();
    try { item.consumer.close(); } catch { /* closed */ }
    const stream = this.streams.get(item.peer); stream?.removeTrack(item.consumer.track);
    if (stream && !stream.getVideoTracks().length) { this.streams.delete(item.peer); this.onRemote(item.peer, null); }
  }

  /** Someone left: forget their keys and picture. */
  forget(peer: string) {
    this.cipher.forget(peer);
    for (const [id, item] of this.consumers) if (item.peer === peer) this.dropConsumer(id);
  }

  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
    this.pending.clear();
    for (const item of this.consumers.values()) item.release();
    for (const item of this.producers) item.release();
    try { this.sendTransport?.close(); this.recv?.close(); } catch { /* closed */ }
    this.cipher.close();
    this.streams.clear(); this.consumers.clear(); this.producers = [];
  }
}
