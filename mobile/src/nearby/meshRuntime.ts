// Runs Mesh while there is no internet: the Bluetooth link (native) + the store-and-forward
// session (JS). The messenger publishes packets here and listens for deliveries.
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as Crypto from 'expo-crypto';
import type { LineaNearbyBridge } from '../../modules/linea-nearby';
import { MeshSession, ackBody, packetFor } from './session';
import type { MeshPacket } from './mesh';
import { recipientTag } from './tag';

const native = requireOptionalNativeModule<LineaNearbyBridge>('LineaNearby');

type Listener = { deliver(packet: MeshPacket): void; handedOver(id: string): void };
let session: MeshSession | null = null;
let myTag = '';
let subs: { remove(): void }[] = [];
const listeners = new Set<Listener>();

export function onMesh(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export async function startMesh(userId: string): Promise<boolean> {
  if (!native) return false;
  myTag = recipientTag(userId);
  if (!session) {
    session = new MeshSession(() => [myTag], (peer, text) => { void native.sendMesh(peer, text).catch(() => {}); }, {
      deliver: packet => { for (const l of listeners) l.deliver(packet); },
      handedOver: id => { for (const l of listeners) l.handedOver(id); },
    });
    subs = [
      native.addListener('meshPeer', e => session?.peerJoined(e.peer)),
      native.addListener('meshLost', e => session?.peerLeft(e.peer)),
      native.addListener('meshData', e => session?.receive(e.peer, e.text)),
    ];
  }
  return native.startMesh().catch(() => false);
}

export async function stopMesh() {
  // The session (with packets for others) is kept in memory until the app closes, so a phone
  // that walks into range again can still pass them on; the radio itself is switched off.
  await native?.stopMesh().catch(() => {});
}

/** Packet id from the message clientId (a UUID): the same message has the same id everywhere. */
export const packetIdOf = (clientId: string) => clientId.replace(/-/g, '').toLowerCase();

export function publishMessage(peerId: string, body: string, clientId: string) {
  session?.publish(packetFor('msg', recipientTag(peerId), body, packetIdOf(clientId), Date.now()));
}
export function publishReceipt(kind: 'ack' | 'read', peerId: string, messageId: string) {
  const id = [...Crypto.getRandomBytes(16)].map(b => b.toString(16).padStart(2, '0')).join('');
  session?.publish(packetFor(kind, recipientTag(peerId), kind === 'ack' ? ackBody(messageId) : JSON.stringify({ read: messageId }), id, Date.now()));
}
export const meshRunning = () => !!session;
