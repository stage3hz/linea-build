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
  /** Ids of the messages this phone wrote itself: the only ones a receipt may refer to here. */
  private ownMessages = new Set<string>();

  constructor(myTags: () => readonly string[], private readonly send: (peer: string, text: string) => void, private readonly events: MeshEvents, private readonly now: () => number = Date.now) {
    this.store = new MeshStore(myTags);
  }

  /** Our own packet: keep it and tell everyone nearby that we have something new. */
  publish(packet: MeshPacket) {
    if (packet.kind === 'msg') {
      this.ownMessages.add(packet.id);
      while (this.ownMessages.size > MESH_LIMITS.maxSeen) this.ownMessages.delete(this.ownMessages.keys().next().value as string);
    }
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
      // Receipts are not authenticated on the radio: any phone nearby can write «ack <id>» for an id
      // it heard in an inventory. So a receipt never changes what is kept or counted as seen — not
      // here, not on relays (a forged ack used to make every relay drop the message and the
      // recipient skip the real one later). A message leaves the store only by its own expiry.
      // A receipt is shown only to the sender, and only for a message this very phone wrote; the
      // tick it produces is informational (Signal already authenticates the message itself).
      if (deliver) {
        const receiptOf = receiptTarget(deliver);
        if (deliver.kind === 'msg' || (receiptOf !== null && this.ownMessages.has(receiptOf))) this.events.deliver(deliver);
      }
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
/** The message id a receipt («ack» or «read») refers to, or null for anything malformed. */
export function receiptTarget(packet: MeshPacket | null): string | null {
  if (!packet || (packet.kind !== 'ack' && packet.kind !== 'read')) return null;
  try { const id = JSON.parse(packet.body)?.[packet.kind]; return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? id : null; } catch { return null; }
}

export function newPacketId(random: (n: number) => Uint8Array): string {
  return [...random(16)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function packetFor(kind: MeshPacket['kind'], to: string, body: string, id: string, now: number): MeshPacket {
  return { v: 1, id, kind, to, hops: 0, expiresAt: now + MESH_LIMITS.ttlMs, body };
}
