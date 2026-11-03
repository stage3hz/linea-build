// PC side of screen sharing through the SFU (server/src/sfu.js). The sharer uploads one copy;
// every frame is sealed with the share key before it leaves the PC (frameCrypto.ts), and viewers
// open frames only with keys received over their peer-to-peer channels. Phones keep receiving a
// direct copy (their WebRTC build cannot open sealed frames yet).
import { frameCryptoSupported, importKey, openFrame, sealFrame, transformFrames } from './frameCrypto';

type Send = (message: Record<string, unknown>) => boolean;
type RemoteScreen = (peer: string, stream: MediaStream | null) => void;

export const sfuUsable = () => typeof window !== 'undefined' && frameCryptoSupported();

export class SfuSession {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private device: any = null;
  private recv: any = null;
  private sendTransport: any = null;
  private producers: any[] = [];
  private keys = new Map<string, Map<number, CryptoKey>>(); // peer -> keyId -> key
  private streams = new Map<string, MediaStream>();
  private consumers = new Map<string, { peer: string; consumer: any }>();
  private closed = false;

  constructor(private readonly send: Send, private readonly onRemote: RemoteScreen) {}

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
    this.device = new Device();
    const { rtpCapabilities } = await this.request('caps');
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });
    this.recv = await this.transport('recv');
    const { producers } = await this.request<{ producers: { peer: string; producerId: string }[] }>('producers');
    for (const p of producers) void this.consume(p.peer, p.producerId).catch(() => {});
  }

  private async transport(direction: 'send' | 'recv') {
    const params = await this.request('transport', { direction });
    const options = { ...params, additionalSettings: { encodedInsertableStreams: true } };
    const t = direction === 'send' ? this.device.createSendTransport(options) : this.device.createRecvTransport(options);
    t.on('connect', ({ dtlsParameters }: any, done: () => void, fail: (e: Error) => void) => { this.request('connect', { transportId: t.id, dtlsParameters }).then(done, fail); });
    if (direction === 'send') t.on('produce', ({ kind, rtpParameters, appData }: any, done: (v: { id: string }) => void, fail: (e: Error) => void) => {
      this.request('produce', { transportId: t.id, kind, rtpParameters, source: appData.source }).then(r => done({ id: r.producerId }), fail);
    });
    return t;
  }

  /** Share: one upload to the server, sealed with `key` (keyId lets viewers pick the right key). */
  async publish(video: MediaStreamTrack, audio: MediaStreamTrack | null, rawKey: Uint8Array, keyId: number, maxBitrate: number) {
    const key = await importKey(rawKey);
    if (!this.sendTransport) this.sendTransport = await this.transport('send');
    const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const seal = (kind: 'audio' | 'video', producer: any) => transformFrames(producer.rtpSender, data => sealFrame(key, keyId, kind, data, random));
    const v = await this.sendTransport.produce({ track: video, encodings: [{ maxBitrate, maxFramerate: 60 }], codecOptions: { videoGoogleStartBitrate: 2000 }, appData: { source: 'screen' } });
    seal('video', v); this.producers.push(v);
    if (audio) {
      const a = await this.sendTransport.produce({ track: audio, codecOptions: { opusStereo: true, opusDtx: false, opusMaxAverageBitrate: 128_000 }, appData: { source: 'screenAudio' } });
      seal('audio', a); this.producers.push(a);
    }
  }

  async unpublish() {
    const list = this.producers; this.producers = [];
    for (const p of list) { try { p.close(); } catch { /* closed */ } void this.request('close', { producerId: p.id }).catch(() => {}); }
  }

  /** Key a person sent us over their own peer-to-peer channel. */
  async setPeerKey(peer: string, keyId: number, raw: Uint8Array) {
    const map = this.keys.get(peer) || new Map<number, CryptoKey>();
    map.set(keyId, await importKey(raw)); if (map.size > 4) map.delete(map.keys().next().value as number);
    this.keys.set(peer, map);
  }

  private async consume(peer: string, producerId: string) {
    if (this.closed || !this.recv) return;
    const r = await this.request('consume', { transportId: this.recv.id, producerId, rtpCapabilities: this.device.rtpCapabilities });
    const consumer = await this.recv.consume({ id: r.consumerId, producerId: r.producerId, kind: r.kind, rtpParameters: r.rtpParameters });
    transformFrames(consumer.rtpReceiver, data => openFrame(id => this.keys.get(peer)?.get(id), r.kind, data));
    this.consumers.set(consumer.id, { peer, consumer });
    const stream = this.streams.get(peer) || new MediaStream();
    stream.addTrack(consumer.track); this.streams.set(peer, stream);
    await this.request('resume', { consumerId: consumer.id });
    if (r.kind === 'video') this.onRemote(peer, stream);
  }

  private dropConsumer(consumerId: string) {
    const item = this.consumers.get(consumerId); if (!item) return;
    this.consumers.delete(consumerId);
    try { item.consumer.close(); } catch { /* closed */ }
    const stream = this.streams.get(item.peer); stream?.removeTrack(item.consumer.track);
    if (stream && !stream.getVideoTracks().length) { this.streams.delete(item.peer); this.onRemote(item.peer, null); }
  }

  /** Someone left: forget their keys and picture. */
  forget(peer: string) {
    this.keys.delete(peer);
    for (const [id, item] of this.consumers) if (item.peer === peer) this.dropConsumer(id);
  }

  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
    this.pending.clear();
    try { this.sendTransport?.close(); this.recv?.close(); } catch { /* closed */ }
    this.keys.clear(); this.streams.clear(); this.consumers.clear();
  }
}
