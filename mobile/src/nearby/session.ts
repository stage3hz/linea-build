// Talking to phones nearby: who has what, and handing packets over (tested in
// test/nearby-mesh.test.mjs with phones linked in memory instead of Bluetooth).
import { MeshStore, MESH_LIMITS, type MeshPacket } from './mesh';

type Wire = { t: 'inv'; ids: string[] } | { t: 'want'; ids: string[] } | { t: 'pkt'; p: MeshPacket };

export type MeshEvents = {
  /** A packet addressed to us (a message, a delivery or read receipt). */
  deliver(packet: MeshPacket): void;
  /** Another phone took our packet: show «передано в Mesh». */
  handedOver(id: string): void;
};

export class MeshSession {
  readonly store: MeshStore;
  private peers = new Set<string>();

  constructor(myTags: () => readonly string[], private readonly send: (peer: string, text: string) => void, private readonly events: MeshEvents, private readonly now: () => number = Date.now) {
    this.store = new MeshStore(myTags);
  }

  /** Our own packet: keep it and tell everyone nearby that we have something new. */
  publish(packet: MeshPacket) {
    this.store.addOwn(packet, this.now());
    for (const peer of this.peers) this.offer(peer);
  }

  peerJoined(peer: string) { this.peers.add(peer); this.offer(peer); }
  peerLeft(peer: string) { this.peers.delete(peer); }

  receive(peer: string, text: string) {
    if (text.length > 70_000) return;
    let wire: Wire;
    try { wire = JSON.parse(text); } catch { return; }
    if (!wire || typeof wire !== 'object') return;
    const now = this.now();
    if (wire.t === 'inv') {
      const ids = this.store.wanted((wire as { ids: unknown }).ids);
      if (ids.length) this.write(peer, { t: 'want', ids });
    } else if (wire.t === 'want') {
      for (const p of this.store.give((wire as { ids: unknown }).ids, now)) {
        this.write(peer, { t: 'pkt', p });
        this.events.handedOver(p.id);
      }
    } else if (wire.t === 'pkt') {
      const raw = (wire as { p: unknown }).p;
      const { deliver, stored } = this.store.receive(raw, now);
      // A delivery receipt passing through lets every relay drop the message it confirms.
      const ackOf = ackTarget(deliver ?? (stored ? (raw as MeshPacket) : null));
      if (ackOf) this.store.forget(ackOf, now);
      if (deliver) this.events.deliver(deliver);
      if (stored) for (const other of this.peers) if (other !== peer) this.offer(other);
    }
  }

  private offer(peer: string) {
    const ids = this.store.inventory(this.now());
    if (ids.length) this.write(peer, { t: 'inv', ids });
  }
  private write(peer: string, wire: Wire) { this.send(peer, JSON.stringify(wire)); }
}

/** Receipts carry the id of the message they confirm, in the clear (nothing else). */
export function ackBody(messageId: string) { return JSON.stringify({ ack: messageId }); }
function ackTarget(packet: MeshPacket | null): string | null {
  if (!packet || packet.kind !== 'ack') return null;
  try { const id = JSON.parse(packet.body)?.ack; return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? id : null; } catch { return null; }
}

export function newPacketId(random: (n: number) => Uint8Array): string {
  return [...random(16)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function packetFor(kind: MeshPacket['kind'], to: string, body: string, id: string, now: number): MeshPacket {
  return { v: 1, id, kind, to, hops: 0, expiresAt: now + MESH_LIMITS.ttlMs, body };
}
