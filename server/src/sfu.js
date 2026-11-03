// Screen sharing for many viewers (SFU, mediasoup): the person sharing sends ONE copy to the
// server, the server forwards it to every viewer in the voice channel. The media stays end-to-end
// encrypted: each video/audio frame is sealed on the sharer's device with a key that travels only
// inside the members' own peer-to-peer channels — the server forwards frames it cannot open.
//
// Off unless SFU_PUBLIC_IP is set. One UDP+TCP port (SFU_PORT, default 40000) must be open.
// Signalling: WebSocket messages { type: 'sfu', id, op, ... } → { type: 'sfu.reply', id, ok, data | error }.

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 2000 } },
];
const MAX_PRODUCERS_PER_PEER = 2; // screen video + PC sound
const SOURCES = new Set(['screen', 'screenAudio']);

export function sfuConfig(env = process.env) {
  const ip = env.SFU_PUBLIC_IP || '';
  if (!ip) return null;
  const port = Number(env.SFU_PORT || 40000);
  if (!/^[0-9a-fA-F.:]{3,45}$/.test(ip) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SFU_PUBLIC_IP / SFU_PORT: invalid');
  return { ip, port, listenIp: env.SFU_LISTEN_IP || '0.0.0.0' };
}

/** Pure check of a client message (tested). Returns the clean message or throws. */
export function parseSfuMessage(data) {
  const ops = ['caps', 'transport', 'connect', 'produce', 'consume', 'resume', 'close', 'producers'];
  if (!data || typeof data !== 'object' || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || !ops.includes(data.op)) throw new Error('bad sfu message');
  const str = (v, max = 64) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : (() => { throw new Error('bad field'); })());
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : (() => { throw new Error('bad field'); })());
  switch (data.op) {
    case 'transport': if (data.direction !== 'send' && data.direction !== 'recv') throw new Error('bad direction'); return { id: data.id, op: data.op, direction: data.direction };
    case 'connect': return { id: data.id, op: data.op, transportId: str(data.transportId), dtlsParameters: obj(data.dtlsParameters) };
    case 'produce':
      if (data.kind !== 'audio' && data.kind !== 'video') throw new Error('bad kind');
      if (!SOURCES.has(data.source)) throw new Error('bad source');
      return { id: data.id, op: data.op, transportId: str(data.transportId), kind: data.kind, rtpParameters: obj(data.rtpParameters), source: data.source };
    case 'consume': return { id: data.id, op: data.op, transportId: str(data.transportId), producerId: str(data.producerId), rtpCapabilities: obj(data.rtpCapabilities) };
    case 'resume': return { id: data.id, op: data.op, consumerId: str(data.consumerId) };
    case 'close': return { id: data.id, op: data.op, producerId: str(data.producerId) };
    default: return { id: data.id, op: data.op };
  }
}

export async function createSfu({ config, log = () => {} }) {
  if (!config) return null;
  let mediasoup;
  try { mediasoup = await import('mediasoup'); } catch (error) { log('SFU disabled: mediasoup not available', error.message); return null; }
  let worker, webRtcServer;
  const rooms = new Map(); // channelId -> { router, peers: Map(socketId -> peer) }
  const start = async () => {
    worker = await mediasoup.createWorker({ logLevel: 'warn' });
    worker.on('died', () => { log('SFU worker died, restarting'); for (const room of rooms.values()) room.router.close(); rooms.clear(); setTimeout(() => void start().catch(() => {}), 2000); });
    webRtcServer = await worker.createWebRtcServer({ listenInfos: [
      { protocol: 'udp', ip: config.listenIp, announcedAddress: config.ip, port: config.port },
      { protocol: 'tcp', ip: config.listenIp, announcedAddress: config.ip, port: config.port },
    ] });
  };
  await start();

  const room = async channelId => {
    let r = rooms.get(channelId);
    if (!r) { r = { router: await worker.createRouter({ mediaCodecs: MEDIA_CODECS }), peers: new Map() }; rooms.set(channelId, r); }
    return r;
  };
  const peerOf = async (channelId, socketId) => {
    const r = await room(channelId);
    let p = r.peers.get(socketId);
    if (!p) { p = { transports: new Map(), producers: new Map(), consumers: new Map() }; r.peers.set(socketId, p); }
    return { r, p };
  };

  /** Handles one message from a socket that is in voice channel `channelId`. `notify(socketId, payload)` reaches others in the room. */
  async function handle({ channelId, socketId, data, notify }) {
    const m = parseSfuMessage(data);
    const { r, p } = await peerOf(channelId, socketId);
    switch (m.op) {
      case 'caps': return { rtpCapabilities: r.router.rtpCapabilities };
      case 'transport': {
        if (p.transports.size >= 2) throw new Error('too many transports');
        const t = await r.router.createWebRtcTransport({ webRtcServer, enableUdp: true, enableTcp: true, preferUdp: true, initialAvailableOutgoingBitrate: 3_000_000, appData: { direction: m.direction } });
        p.transports.set(t.id, t);
        // Limit each sharer's upload into the SFU (1080p60 + stereo sound with margin).
        if (m.direction === 'send') await t.setMaxIncomingBitrate(12_000_000).catch(() => {});
        return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
      }
      case 'connect': { const t = p.transports.get(m.transportId); if (!t) throw new Error('no transport'); await t.connect({ dtlsParameters: m.dtlsParameters }); return {}; }
      case 'produce': {
        const t = p.transports.get(m.transportId); if (!t || t.appData.direction !== 'send') throw new Error('no send transport');
        if (p.producers.size >= MAX_PRODUCERS_PER_PEER) throw new Error('too many producers');
        const producer = await t.produce({ kind: m.kind, rtpParameters: m.rtpParameters, appData: { source: m.source } });
        p.producers.set(producer.id, producer);
        producer.on('transportclose', () => p.producers.delete(producer.id));
        for (const other of r.peers.keys()) if (other !== socketId) notify(other, { type: 'sfu.producer', channelId, peer: socketId, producerId: producer.id, kind: m.kind, source: m.source });
        return { producerId: producer.id };
      }
      case 'producers': {
        const list = [];
        for (const [other, q] of r.peers) if (other !== socketId) for (const producer of q.producers.values()) list.push({ peer: other, producerId: producer.id, kind: producer.kind, source: producer.appData.source });
        return { producers: list };
      }
      case 'consume': {
        const t = p.transports.get(m.transportId); if (!t || t.appData.direction !== 'recv') throw new Error('no recv transport');
        if (!r.router.canConsume({ producerId: m.producerId, rtpCapabilities: m.rtpCapabilities })) throw new Error('cannot consume');
        const consumer = await t.consume({ producerId: m.producerId, rtpCapabilities: m.rtpCapabilities, paused: true });
        p.consumers.set(consumer.id, consumer);
        consumer.on('producerclose', () => { p.consumers.delete(consumer.id); notify(socketId, { type: 'sfu.closed', channelId, consumerId: consumer.id }); });
        consumer.on('transportclose', () => p.consumers.delete(consumer.id));
        return { consumerId: consumer.id, producerId: m.producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
      }
      case 'resume': { const c = p.consumers.get(m.consumerId); if (!c) throw new Error('no consumer'); await c.resume(); return {}; }
      case 'close': { const producer = p.producers.get(m.producerId); if (producer) { producer.close(); p.producers.delete(m.producerId); } return {}; }
    }
    return {};
  }

  /** Socket left the voice channel or disconnected: close everything it had. */
  function leave(channelId, socketId) {
    const r = rooms.get(channelId); const p = r?.peers.get(socketId);
    if (!p) return;
    for (const t of p.transports.values()) t.close();
    r.peers.delete(socketId);
    if (!r.peers.size) { r.router.close(); rooms.delete(channelId); }
  }

  return { handle, leave, close: () => { worker?.close(); rooms.clear(); }, stats: () => ({ rooms: rooms.size }) };
}
