// Test-only adapter. Protocol operations are delegated to the official native
// libsignal SDK, never reimplemented here. This opaque JSON is a disposable
// Node test store, not the encrypted on-device storage used by the application.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const toolsRoot = process.env.LINEA_SIGNAL_TEST_TOOLS || '/tmp/linea-signal-tests';
const require = createRequire(path.join(path.resolve(toolsRoot), 'package.json'));
const sdkEntry = require.resolve('@signalapp/libsignal-client');
const metadata = JSON.parse(readFileSync(path.join(path.dirname(sdkEntry), '..', 'package.json'), 'utf8'));
if (metadata.version !== '0.106.0') throw new Error(`Tests require official libsignal 0.106.0, found ${metadata.version}`);
export const signal = await import(pathToFileURL(sdkEntry).href);
export const SIGNAL_VERSION = metadata.version;

const FORMAT = 'linea-signal-node-test-v1';
const MAX_KEYS = 1000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const encode = value => Buffer.from(value).toString('base64');
const addressKey = address => `${address.name()}:${address.deviceId()}`;

function decode(value, { length, max = MAX_FILE_BYTES + 16 } = {}) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4) throw new Error('Invalid base64 length');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > max || (length !== undefined && bytes.length !== length)) throw new Error('Invalid canonical base64');
  return bytes;
}

function unpack(state) {
  const result = JSON.parse(state);
  if (result.format !== FORMAT) throw new Error('Unknown test-store format');
  return result;
}

function localAddress(state) {
  return signal.ProtocolAddress.new(state.localAddressName, state.localDeviceId);
}

function publicBundle(state, preKeys) {
  const signed = signal.SignedPreKeyRecord.deserialize(decode(state.signedPreKeys['1']));
  const kyber = signal.KyberPreKeyRecord.deserialize(decode(state.kyberPreKeys['1']));
  return {
    registrationId: state.registrationId,
    identityKey: state.identityKey,
    signedPreKey: { id: signed.id(), publicKey: encode(signed.publicKey().serialize()), signature: encode(signed.signature()) },
    kyberPreKey: { id: kyber.id(), publicKey: encode(kyber.publicKey().serialize()), signature: encode(kyber.signature()) },
    preKeys,
  };
}

function addPreKeys(state, count) {
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Invalid pre-key batch size');
  if (Object.keys(state.preKeys).length + count > MAX_KEYS) throw new Error('Pre-key retention capacity exceeded');
  const published = [];
  for (let index = 0; index < count; index++) {
    const id = state.nextPreKeyId++;
    if (id > 0x7fffffff) throw new Error('Pre-key id exhausted');
    const key = signal.PrivateKey.generate();
    const record = signal.PreKeyRecord.new(id, key.getPublicKey(), key);
    state.preKeys[id] = encode(record.serialize());
    published.push({ id, publicKey: encode(record.publicKey().serialize()) });
  }
  return published;
}

class Stores extends signal.IdentityKeyStore {
  constructor(state) { super(); this.state = state; }
  async getIdentityKey() { return signal.PrivateKey.deserialize(decode(this.state.identityPrivate)); }
  async getLocalRegistrationId() { return this.state.registrationId; }
  async saveIdentity(address, identity) {
    const key = addressKey(address), serialized = encode(identity.serialize());
    if (this.state.trusted[key] !== serialized) throw new Error('Identity was not explicitly approved');
    return signal.IdentityChange.NewOrUnchanged;
  }
  async isTrustedIdentity(address, identity) {
    return this.state.trusted[addressKey(address)] === encode(identity.serialize());
  }
  async getIdentity(address) {
    const saved = this.state.trusted[addressKey(address)];
    return saved ? signal.PublicKey.deserialize(decode(saved)) : null;
  }
  async saveSession(address, record) { this.state.sessions[addressKey(address)] = encode(record.serialize()); }
  async getSession(address) {
    const saved = this.state.sessions[addressKey(address)];
    return saved ? signal.SessionRecord.deserialize(decode(saved)) : null;
  }
  async getExistingSessions(addresses) {
    return Promise.all(addresses.map(async address => {
      const record = await this.getSession(address);
      if (!record) throw new Error('Missing session');
      return record;
    }));
  }
  async savePreKey(id, record) { this.state.preKeys[id] = encode(record.serialize()); }
  async getPreKey(id) {
    if (!this.state.preKeys[id]) throw new Error('Missing one-time pre-key');
    return signal.PreKeyRecord.deserialize(decode(this.state.preKeys[id]));
  }
  async removePreKey(id) { delete this.state.preKeys[id]; }
  async saveSignedPreKey(id, record) { this.state.signedPreKeys[id] = encode(record.serialize()); }
  async getSignedPreKey(id) {
    if (!this.state.signedPreKeys[id]) throw new Error('Missing signed pre-key');
    return signal.SignedPreKeyRecord.deserialize(decode(this.state.signedPreKeys[id]));
  }
  async saveKyberPreKey(id, record) { this.state.kyberPreKeys[id] = encode(record.serialize()); }
  async getKyberPreKey(id) {
    if (!this.state.kyberPreKeys[id]) throw new Error('Missing Kyber pre-key');
    return signal.KyberPreKeyRecord.deserialize(decode(this.state.kyberPreKeys[id]));
  }
  async markKyberPreKeyUsed(id, signedPreKeyId, baseKey) {
    // This is the declared reusable last-resort Kyber key. Record its use; do
    // not remove it and accidentally make another legitimate device fail.
    this.state.kyberUses.push({ id, signedPreKeyId, baseKey: encode(baseKey.serialize()) });
  }
}

function remoteBundle(value, deviceId) {
  return signal.PreKeyBundle.new(
    value.registrationId, deviceId,
    value.preKey?.id ?? null, value.preKey ? signal.PublicKey.deserialize(decode(value.preKey.publicKey, { length: 33 })) : null,
    value.signedPreKey.id, signal.PublicKey.deserialize(decode(value.signedPreKey.publicKey, { length: 33 })), decode(value.signedPreKey.signature, { length: 64 }),
    signal.PublicKey.deserialize(decode(value.identityKey, { length: 33 })),
    value.kyberPreKey.id, signal.KEMPublicKey.deserialize(decode(value.kyberPreKey.publicKey, { length: 1569 })), decode(value.kyberPreKey.signature, { length: 64 }),
  );
}

export const nodeSignalBridge = {
  async createState(localAddressName, deviceId) {
    signal.ProtocolAddress.new(localAddressName, deviceId);
    const identity = signal.PrivateKey.generate();
    const signedKey = signal.PrivateKey.generate();
    const signed = signal.SignedPreKeyRecord.new(1, Date.now(), signedKey.getPublicKey(), signedKey, identity.sign(signedKey.getPublicKey().serialize()));
    const kyberKey = signal.KEMKeyPair.generate();
    const kyber = signal.KyberPreKeyRecord.new(1, Date.now(), kyberKey, identity.sign(kyberKey.getPublicKey().serialize()));
    const state = {
      format: FORMAT, localAddressName, localDeviceId: deviceId,
      registrationId: randomInt(1, 16384), identityPrivate: encode(identity.serialize()), identityKey: encode(identity.getPublicKey().serialize()),
      signedPreKeys: { 1: encode(signed.serialize()) }, kyberPreKeys: { 1: encode(kyber.serialize()) },
      preKeys: {}, nextPreKeyId: 1, sessions: {}, trusted: {}, kyberUses: [],
    };
    const preKeys = addPreKeys(state, 20);
    return { state: JSON.stringify(state), bundle: publicBundle(state, preKeys) };
  },
  async replenish(serialized, count) {
    const state = unpack(serialized);
    const preKeys = addPreKeys(state, count);
    return { state: JSON.stringify(state), bundle: publicBundle(state, preKeys) };
  },
  async trustIdentity(serialized, addressName, deviceId, identityKey) {
    const state = unpack(serialized);
    const address = signal.ProtocolAddress.new(addressName, deviceId), key = addressKey(address);
    const normalized = encode(signal.PublicKey.deserialize(decode(identityKey, { length: 33 })).serialize());
    if (state.trusted[key] && state.trusted[key] !== normalized) throw new Error('Identity key changed; explicit reset is required');
    state.trusted[key] = normalized;
    return { state: JSON.stringify(state) };
  },
  async encrypt(serialized, addressName, deviceId, plaintext, bundle = null) {
    if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_MESSAGE_BYTES) throw new Error('Invalid plaintext');
    const state = unpack(serialized), stores = new Stores(state);
    const address = signal.ProtocolAddress.new(addressName, deviceId);
    if (bundle) await signal.processPreKeyBundle(remoteBundle(bundle, deviceId), address, localAddress(state), stores, stores);
    const encrypted = await signal.signalEncrypt(Buffer.from(plaintext, 'utf8'), address, localAddress(state), stores, stores);
    const type = encrypted.type();
    if (type !== 2 && type !== 3) throw new Error('Unexpected Signal envelope type');
    return { state: JSON.stringify(state), type, body: encode(encrypted.serialize()) };
  },
  async decrypt(serialized, addressName, deviceId, type, body) {
    const state = unpack(serialized), stores = new Stores(state);
    const address = signal.ProtocolAddress.new(addressName, deviceId), bytes = decode(body, { max: 2 * MAX_MESSAGE_BYTES });
    let plaintext;
    if (type === 3) plaintext = await signal.signalDecryptPreKey(signal.PreKeySignalMessage.deserialize(bytes), address, localAddress(state), stores, stores, stores, stores, stores);
    else if (type === 2) plaintext = await signal.signalDecrypt(signal.SignalMessage.deserialize(bytes), address, localAddress(state), stores, stores);
    else throw new Error('Only Signal types 2 and 3 are supported; plaintext is forbidden');
    return { state: JSON.stringify(state), plaintext: new TextDecoder('utf-8', { fatal: true }).decode(plaintext) };
  },
  async seal(plaintextBase64, keyBase64, nonceBase64, adBase64) {
    const cipher = signal.Aes256GcmSiv.new(decode(keyBase64, { length: 32 }));
    return encode(cipher.encrypt(decode(plaintextBase64, { max: MAX_FILE_BYTES }), decode(nonceBase64, { length: 12 }), decode(adBase64, { max: 64 * 1024 })));
  },
  async open(ciphertextBase64, keyBase64, nonceBase64, adBase64) {
    const cipher = signal.Aes256GcmSiv.new(decode(keyBase64, { length: 32 }));
    return encode(cipher.decrypt(decode(ciphertextBase64, { max: MAX_FILE_BYTES + 16 }), decode(nonceBase64, { length: 12 }), decode(adBase64, { max: 64 * 1024 })));
  },
};

export function claimedBundle(bundle, index = 0) {
  const { preKeys, ...base } = bundle;
  return { ...base, ...(preKeys[index] ? { preKey: preKeys[index] } : {}) };
}
