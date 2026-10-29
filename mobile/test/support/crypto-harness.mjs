import { createHash, randomUUID } from 'node:crypto';
import { loadTs } from './load-ts.mjs';
import { nodeSignalBridge } from './signal-node.mjs';

export const { CryptoService, UntrustedDeviceError, canonicalEncrypted } = loadTs(new URL('../../src/e2ee/core.ts', import.meta.url));
export const sha256 = async value => createHash('sha256').update(value).digest('hex');

export class MemoryVault {
  constructor(data = new Map()) { this.data = data; this.failNext = false; this.closed = false; this.commits = []; }
  async get(key) { if (this.closed) throw new Error('Vault closed'); return this.data.get(key) ?? null; }
  async commit(values) {
    if (this.closed) throw new Error('Vault closed');
    if (this.failNext) { this.failNext = false; throw new Error('Synthetic atomic commit failure'); }
    const next = new Map(this.data);
    for (const [key, value] of Object.entries(values)) { if (value === null) next.delete(key); else next.set(key, value); }
    this.data.clear();
    for (const [key, value] of next) this.data.set(key, value);
    this.commits.push(structuredClone(values));
  }
  async close() { this.closed = true; }
}

export class PublicRelay {
  devices = new Map(); messages = []; claims = []; registrations = []; pageSize = 2; swapClaim = null; inboxTransform = null;
  transport(userId, vault) {
    return {
      registerCryptoDevice: async (id, bundle) => {
        if (!await vault.get('protocol') || JSON.parse(await vault.get('device')).id !== id) throw new Error('Published before durable local identity');
        this.registrations.push({ userId, id });
        const key = `${userId}:${id}`;
        let record = this.devices.get(key);
        if (!record) {
          record = { device: { id, userId, deviceName: 'Synthetic device', identityKey: bundle.identityKey, registrationId: bundle.registrationId, createdAt: new Date().toISOString(), active: true }, bundle: structuredClone(bundle), keys: new Map(), knownIds: new Set() };
          this.devices.set(key, record);
        }
        if (record.device.identityKey !== bundle.identityKey) throw new Error('Identity mutation rejected');
        for (const preKey of bundle.preKeys) if (!record.knownIds.has(preKey.id)) { record.keys.set(preKey.id, structuredClone(preKey)); record.knownIds.add(preKey.id); }
        return { device: structuredClone(record.device), preKeyCount: record.keys.size };
      },
      cryptoDevices: async requestedId => ({ devices: [...this.devices.values()].filter(record => record.device.userId === requestedId && record.device.active).map(record => ({ ...structuredClone(record.device), preKeyCount: record.keys.size })) }),
      claimPreKey: async (requestedId, id) => {
        const record = this.devices.get(`${requestedId}:${id}`);
        if (!record) throw new Error('Unknown test device');
        const preKey = record.keys.values().next().value;
        if (preKey) record.keys.delete(preKey.id);
        this.claims.push({ userId: requestedId, id, preKeyId: preKey?.id });
        const { preKeys, ...base } = record.bundle;
        const result = { device: structuredClone(record.device), bundle: { ...structuredClone(base), ...(preKey ? { preKey } : {}) } };
        return this.swapClaim ? this.swapClaim(result) : result;
      },
      cryptoInbox: async (deviceId, chatId, after) => {
        const all = this.messages.filter(message => message.chatId === chatId && message.id > after);
        const page = all.slice(0, this.pageSize).map(message => structuredClone(message));
        const result = { messages: page, nextCursor: page.at(-1)?.id ?? after, hasMore: all.length > page.length };
        return this.inboxTransform ? this.inboxTransform(result) : result;
      },
    };
  }
  deliver(senderId, chatId, clientId, encrypted) {
    const message = { id: this.messages.length + 1, chatId, clientId, senderId, text: '', attachment: null, createdAt: new Date().toISOString(), encrypted: structuredClone(encrypted) };
    this.messages.push(message);
    return message;
  }
}

export async function harness(t, { initialize = true } = {}) {
  const relay = new PublicRelay(), chatId = randomUUID(), services = [];
  const make = async (userId = randomUUID(), data) => {
    const vault = new MemoryVault(data);
    const service = new CryptoService(userId, relay.transport(userId, vault), nodeSignalBridge, vault, randomUUID, sha256);
    const client = { userId, vault, service };
    services.push(client);
    if (initialize) await service.initialize();
    return client;
  };
  t.after(async () => { for (const client of services) await client.service.close(); });
  const alice = await make(), bob = await make();
  const approve = async (from, to) => from.service.approveDevices(await from.service.trustSnapshot(to.userId));
  return { relay, chatId, alice, bob, make, approve };
}
