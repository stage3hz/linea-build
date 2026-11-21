// The reference's own CryptoService (mobile/src/e2ee/core.ts), loaded from its source text and run with
// recording stand-ins for everything outside it: the Signal library, the server, the clock, the id generator.
// The recordings are the vectors: the Rust core must make the same calls with the same arguments in the same
// order and leave the same records in the vault.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../../../mobile/src/e2ee/core.ts', import.meta.url), 'utf8');
const previewSource = readFileSync(new URL('../../../mobile/src/media/previewModel.ts', import.meta.url), 'utf8');
const base64js = createRequire(new URL('../../../mobile/package.json', import.meta.url))('base64-js');
const { validMeta } = await import('../../../mobile/src/messageMeta.ts');

const cut = (text, from, to) => { const start = text.indexOf(from); const end = to ? text.indexOf(to, start) : text.length; if (start < 0 || end < 0) throw new Error('reference changed: ' + from); return text.slice(start, end); };
const mediaCode = stripTypeScriptTypes(['const record=', 'const dimension=', 'const only='].map(name => cut(previewSource, name, '\n')).join('\n') + '\n' + cut(previewSource, 'export function validMedia', '\n/**').replace('export function', 'function'), { mode: 'transform' });
const validMedia = new Function(`${mediaCode}; return validMedia;`)();
/** The stand-in for the preview picture's own check (ported separately): no preview, or the word OK. */
export const validPreview = value => value === undefined || value === 'OK';

const body = source.split('\n').filter(line => !/^import /.test(line)).join('\n').replace(/^export /gm, '');
const code = stripTypeScriptTypes(body, { mode: 'transform' });
/** `Date` as the reference sees it: the clock is the recording's. */
const build = new Function('fromByteArray', 'toByteArray', 'validMedia', 'validPreview', 'validMeta', 'Date', `${code}; return { CryptoService, UntrustedDeviceError, canonicalEncrypted };`);

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/** A world for one scenario: records every call out of the service. */
export function world({ userId, start = Date.parse('2026-11-21T07:00:00.000Z') }) {
  const io = []; let clock = start; let ids = 0;
  const RealDate = Date;
  class FakeDate { toISOString() { const text = new RealDate(clock).toISOString(); clock += 1000; io.push({ kind: 'now', result: text }); return text; } static parse(text) { return RealDate.parse(text); } }
  const { CryptoService, UntrustedDeviceError, canonicalEncrypted } = build(base64js.fromByteArray, base64js.toByteArray, validMedia, validPreview, validMeta, FakeDate);
  const vault = new Map();
  const vaultApi = { get: async key => (vault.has(key) ? vault.get(key) : null), commit: async values => { for (const [key, value] of Object.entries(values)) { if (value === null) vault.delete(key); else vault.set(key, value); } }, close: async () => {} };
  const randomUUID = () => { const id = `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`; io.push({ kind: 'uuid', result: id }); return id; };
  // The Signal library: deterministic, with its whole «state» a growing text.
  // 33 bytes: 44 base64 digits without padding, the shape of a real identity key.
  const key44 = name => Buffer.concat([createHash('sha256').update(name).digest(), Buffer.from([5])]).toString('base64');
  const bundleOf = (address, preKeys) => ({ registrationId: 1 + (createHash('sha256').update(address).digest().readUInt16BE(0) % 16383), identityKey: key44(address), signedPreKey: { id: 1, publicKey: 'spk', signature: 'sig' }, kyberPreKey: { id: 1, publicKey: 'kpk', signature: 'ksig' }, preKeys: Array.from({ length: preKeys }, (_, i) => ({ id: i + 1, publicKey: `pk${i + 1}` })) });
  const failures = [];
  const recorded = (method, args, work) => { const planned = failures.findIndex(f => f.method === method); if (planned >= 0) { const [f] = failures.splice(planned, 1); io.push({ kind: 'bridge', method, args, error: f.message, errorName: f.name || 'Error' }); const error = new Error(f.message); if (f.name) error.name = f.name; throw error; } const result = work(); io.push({ kind: 'bridge', method, args, result }); return result; };
  const bridge = {
    createState: async (address, deviceId) => recorded('createState', [address, deviceId], () => ({ state: `S|create:${address}`, bundle: bundleOf(address, 4) })),
    replenish: async (state, count) => recorded('replenish', [state, count], () => ({ state: `${state}|replenish:${count}`, bundle: bundleOf(state.split('|')[1].slice(7), 4 + count) })),
    trustIdentity: async (state, address, deviceId, identityKey) => recorded('trustIdentity', [state, address, deviceId, identityKey], () => ({ state: `${state}|trust:${address}` })),
    encrypt: async (state, address, deviceId, plaintext, bundle) => recorded('encrypt', [state, address, deviceId, plaintext, bundle], () => ({ state: `${state}|enc:${address}:${bundle ? 3 : 2}`, type: bundle ? 3 : 2, body: Buffer.from(`${address}\n${plaintext}`, 'utf8').toString('base64') })),
    decrypt: async (state, address, deviceId, type, body) => recorded('decrypt', [state, address, deviceId, type, body], () => { const text = Buffer.from(body, 'base64').toString('utf8'); return { state: `${state}|dec:${address}:${type}`, plaintext: text.slice(text.indexOf('\n') + 1) }; }),
  };
  // The server: what it knows about devices, and whether it can be reached.
  const server = { devices: new Map(), preKeyCount: 20, offline: false, refuse: null };
  const call = (method, args, work) => {
    if (server.offline) { io.push({ kind: 'transport', method, args, error: 'network' }); const error = new Error('Нет связи с сервером.'); error.name = 'NetworkError'; throw error; }
    if (server.refuse && server.refuse.method === method) { const { message } = server.refuse; server.refuse = null; io.push({ kind: 'transport', method, args, error: message }); throw new Error(message); }
    const result = work(); io.push({ kind: 'transport', method, args, result: structuredClone(result) }); return result;
  };
  const deviceRow = (owner, id, bundle) => ({ id, userId: owner, deviceName: 'Телефон', identityKey: bundle.identityKey, registrationId: bundle.registrationId, createdAt: '2026-11-01T00:00:00.000Z', active: true });
  const transport = {
    registerCryptoDevice: async (deviceId, bundle) => call('registerCryptoDevice', [deviceId, bundle], () => { const list = server.devices.get(userId) || []; const row = deviceRow(userId, deviceId, bundle); server.devices.set(userId, [...list.filter(d => d.id !== deviceId), row]); return { device: server.registerOverride ? server.registerOverride(row) : row, preKeyCount: server.preKeyCount }; }),
    cryptoDevices: async id => call('cryptoDevices', [id], () => ({ devices: structuredClone(server.devices.get(id) || []) })),
    claimPreKey: async (owner, deviceId) => call('claimPreKey', [owner, deviceId], () => { const row = (server.devices.get(owner) || []).find(d => d.id === deviceId); if (!row) throw new Error('no such device'); const claimed = server.claimOverride?.(row); return claimed ?? { device: structuredClone(row), bundle: { registrationId: row.registrationId, identityKey: row.identityKey, signedPreKey: { id: 1, publicKey: 'spk', signature: 'sig' }, kyberPreKey: { id: 1, publicKey: 'kpk', signature: 'ksig' }, preKey: { id: 7, publicKey: 'pk7' } } }; }),
    cryptoInbox: async (deviceId, chatId, after) => call('cryptoInbox', [deviceId, chatId, after], () => server.inbox?.(deviceId, chatId, after) ?? { messages: [], nextCursor: after, hasMore: false }),
  };
  /** Another person's (or one's own other) device as the server lists it. */
  const addDevice = (owner, id, { active = true, address = `${owner}.${id}` } = {}) => { const row = { ...deviceRow(owner, id, bundleOf(address, 4)), active }; server.devices.set(owner, [...(server.devices.get(owner) || []).filter(d => d.id !== id), row]); return row; };
  const service = options => new CryptoService(userId, transport, bridge, vaultApi, randomUUID, async text => sha256(text), options);
  const snapshot = () => Object.fromEntries([...vault.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { io, vault, server, failures, service, addDevice, snapshot, advance: ms => { clock += ms; }, UntrustedDeviceError, canonicalEncrypted };
}

/** Runs one call and records what happened: the result or the error, every call out, and the vault afterwards. */
export async function step(w, steps, op, args, work) {
  const from = w.io.length;
  let ok = null, error = null;
  try { const value = await work(); ok = value === undefined ? null : value; } catch (e) { error = { name: e.name, message: e.message }; }
  const now = w.snapshot(), before = w.last || {}; w.last = now;
  const set = Object.fromEntries(Object.entries(now).filter(([key, value]) => before[key] !== value)), removed = Object.keys(before).filter(key => !(key in now));
  steps.push({ op, args, ok: ok === null ? null : JSON.stringify(ok), error, io: w.io.slice(from).map(entry => ({ ...entry, args: entry.args === undefined ? undefined : JSON.stringify(entry.args), result: entry.result === undefined ? undefined : (typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result)) })), set, removed });
  return { ok, error };
}
