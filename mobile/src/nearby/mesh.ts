// Mesh store-and-forward: what a phone keeps, passes on and delivers. Pure logic, no radio
// (tested in test/nearby-mesh.test.mjs). Packets come from strangers' phones, so every field
// is checked and every list is bounded. The body is the same Signal ciphertext the server
// would get: relays can neither read nor change it (Signal authenticates it).

export type MeshKind = 'msg' | 'ack' | 'read';
export type MeshPacket = {
  v: 1;
  /** Random 128-bit id, hex. The same message keeps the same id on every phone. */
  id: string;
  kind: MeshKind;
  /** Recipient tag (see recipientTag). Lets a phone know a packet is for it without opening it. */
  to: string;
  /** How many phones it has passed through. */
  hops: number;
  /** Unix ms; dropped everywhere after this. */
  expiresAt: number;
  /** Opaque encrypted content (JSON string), never parsed by relays. */
  body: string;
};

export const MESH_LIMITS = {
  maxHops: 8,
  maxPackets: 500,
  maxBytes: 2_000_000,
  maxBody: 16_384,
  ttlMs: 48 * 60 * 60 * 1000,
  maxSeen: 5000,
  maxInventory: 500,
} as const;

const HEX32 = /^[0-9a-f]{32}$/;
const TAG = /^[A-Za-z0-9_-]{16,64}$/;

/** Checks a packet from the radio. Returns a clean copy or null. */
export function parsePacket(value: unknown, now: number): MeshPacket | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (p.v !== 1 || typeof p.id !== 'string' || !HEX32.test(p.id)) return null;
  if (p.kind !== 'msg' && p.kind !== 'ack' && p.kind !== 'read') return null;
  if (typeof p.to !== 'string' || !TAG.test(p.to)) return null;
  if (!Number.isSafeInteger(p.hops) || (p.hops as number) < 0 || (p.hops as number) > MESH_LIMITS.maxHops) return null;
  if (!Number.isSafeInteger(p.expiresAt) || (p.expiresAt as number) <= now || (p.expiresAt as number) > now + MESH_LIMITS.ttlMs + 60_000) return null;
  if (typeof p.body !== 'string' || !p.body.length || p.body.length > MESH_LIMITS.maxBody) return null;
  return { v: 1, id: p.id, kind: p.kind, to: p.to, hops: p.hops as number, expiresAt: p.expiresAt as number, body: p.body };
}

type Entry = { packet: MeshPacket; own: boolean; storedAt: number };

export class MeshStore {
  private entries = new Map<string, Entry>();
  /** Ids already delivered here or seen before: never stored or delivered twice. */
  private seen = new Map<string, number>();
  private bytes = 0;

  constructor(private readonly myTags: () => readonly string[]) {}

  get size() { return this.entries.size; }

  /** Our own outgoing packet (a message we wrote, or our ack/read for someone). */
  addOwn(packet: MeshPacket, now: number) { if (!this.entries.has(packet.id) && !this.seen.has(packet.id)) this.put(packet, true, now); }

  /**
   * A packet that arrived over the radio. If it is for us it is returned for delivery and
   * not passed on; otherwise it is kept to pass on (one hop further).
   */
  receive(raw: unknown, now: number): { deliver: MeshPacket | null; stored: boolean } {
    const packet = parsePacket(raw, now);
    if (!packet || this.seen.has(packet.id) || this.entries.has(packet.id)) return { deliver: null, stored: false };
    if (this.myTags().includes(packet.to)) {
      this.remember(packet.id, now);
      return { deliver: packet, stored: false };
    }
    if (packet.hops + 1 > MESH_LIMITS.maxHops) { this.remember(packet.id, now); return { deliver: null, stored: false }; }
    this.put({ ...packet, hops: packet.hops + 1 }, false, now);
    return { deliver: null, stored: true };
  }

  /** Ids we hold, newest own messages first, to tell a neighbour what we can give. */
  inventory(now: number): string[] {
    this.prune(now);
    return [...this.entries.values()]
      .sort((a, b) => Number(b.own) - Number(a.own) || b.storedAt - a.storedAt)
      .slice(0, MESH_LIMITS.maxInventory)
      .map(e => e.packet.id);
  }

  /** From a neighbour's inventory, the ids we neither hold nor have seen. */
  wanted(theirs: unknown): string[] {
    if (!Array.isArray(theirs)) return [];
    return theirs.slice(0, MESH_LIMITS.maxInventory).filter((id): id is string => typeof id === 'string' && HEX32.test(id) && !this.entries.has(id) && !this.seen.has(id));
  }

  /** The packets a neighbour asked for. */
  give(ids: unknown, now: number): MeshPacket[] {
    if (!Array.isArray(ids)) return [];
    this.prune(now);
    const out: MeshPacket[] = [];
    for (const id of ids.slice(0, MESH_LIMITS.maxInventory)) { const e = typeof id === 'string' ? this.entries.get(id) : undefined; if (e) out.push(e.packet); }
    return out;
  }

  /** The recipient confirmed (ack): every phone that hears it can drop the message. */
  forget(id: string, now: number) {
    const e = this.entries.get(id);
    if (e) { this.entries.delete(id); this.bytes -= e.packet.body.length; }
    this.remember(id, now);
  }

  prune(now: number) {
    for (const [id, e] of this.entries) if (e.packet.expiresAt <= now) { this.entries.delete(id); this.bytes -= e.packet.body.length; }
    for (const [id, until] of this.seen) if (until <= now) this.seen.delete(id);
  }

  private remember(id: string, now: number) {
    this.seen.set(id, now + MESH_LIMITS.ttlMs);
    if (this.seen.size > MESH_LIMITS.maxSeen) this.seen.delete(this.seen.keys().next().value as string);
  }

  private put(packet: MeshPacket, own: boolean, now: number) {
    this.entries.set(packet.id, { packet, own, storedAt: now });
    this.bytes += packet.body.length;
    // Over the limit: strangers' packets go first (oldest first); our own are kept longest.
    while (this.entries.size > MESH_LIMITS.maxPackets || this.bytes > MESH_LIMITS.maxBytes) {
      const victim = [...this.entries.values()].filter(e => e.packet.id !== packet.id).sort((a, b) => Number(a.own) - Number(b.own) || a.storedAt - b.storedAt)[0];
      if (!victim) break;
      this.entries.delete(victim.packet.id); this.bytes -= victim.packet.body.length;
    }
  }
}
