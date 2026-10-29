import { randomBytes, randomUUID } from 'node:crypto';

// Deliberately synthetic public keys, signatures and envelope bodies. These
// fixtures test relay contracts/ACL/storage, never Signal encryption or decryptability.
const key33 = () => Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString('base64');

export function syntheticPublicBundle() {
  return {
    deviceId: randomUUID(), deviceName: 'Synthetic integration device', registrationId: 1234,
    identityKey: key33(),
    signedPreKey: { id: 100, publicKey: key33(), signature: randomBytes(64).toString('base64') },
    kyberPreKey: { id: 200, publicKey: randomBytes(1569).toString('base64'), signature: randomBytes(64).toString('base64') },
    preKeys: [1, 2].map(id => ({ id, publicKey: key33() })),
  };
}

export function syntheticEnvelope(sender, targets, attachmentIds = []) {
  return {
    scheme: 'signal-v1', senderDeviceId: sender.id,
    envelopes: targets.map(target => ({ userId: target.userId, deviceId: target.id, type: 3, body: randomBytes(96).toString('base64') })),
    attachmentIds,
  };
}

export const syntheticFileBytes = (length = 96) => randomBytes(length);
