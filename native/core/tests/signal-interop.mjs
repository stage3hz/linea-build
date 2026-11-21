// Test-only driver for tests/signal_interop.rs: the desktop app's Signal bridge (desktop/signal.mjs, the official
// @signalapp/libsignal-client) answering one JSON line per request, the way the Kotlin test driver
// (mobile/modules/linea-signal/android/src/test/.../SignalInterop.kt) does.
//
// The desktop bridge keeps the same library records in a JSON of its own shape (`invizent-desktop-signal-v1`),
// not the phones' shape. `toPhone` / `toDesktop` move a state from one shape to the other without touching a
// single record: tables are renamed, the address key changes its separator, the identity pair is re-wrapped by
// the library itself. So a record the Node library wrote is read by the Rust library and the other way round.
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const desktop = new URL('../../../desktop/', import.meta.url);
const { desktopSignalBridge: bridge } = await import(new URL('signal.mjs', desktop).href);
const require = createRequire(new URL('package.json', desktop));
const signal = await import(pathToFileURL(require.resolve('@signalapp/libsignal-client')).href);
const sdkVersion = require('@signalapp/libsignal-client/package.json').version;

const encode = value => Buffer.from(value).toString('base64');
const decode = value => Buffer.from(value, 'base64');
const rekey = (table, from, to) => Object.fromEntries(Object.entries(table).map(([key, value]) => {
  const at = key.lastIndexOf(from);
  return [`${key.slice(0, at)}${to}${key.slice(at + 1)}`, value];
}));

function toPhone(text) {
  const state = JSON.parse(text);
  if (state.format !== 'invizent-desktop-signal-v1') throw new Error('not a desktop state');
  const pair = new signal.IdentityKeyPair(signal.PublicKey.deserialize(decode(state.identityKey)), signal.PrivateKey.deserialize(decode(state.identityPrivate)));
  return JSON.stringify({
    version: 1, libsignalVersion: sdkVersion, localAddressName: state.localAddressName, localDeviceId: state.localDeviceId,
    identityKeyPair: encode(pair.serialize()), registrationId: state.registrationId, nextPreKeyId: state.nextPreKeyId, signedPreKeyId: 1, kyberPreKeyId: 1,
    preKeys: state.preKeys, signedPreKeys: state.signedPreKeys, kyberPreKeys: state.kyberPreKeys,
    sessions: rekey(state.sessions, ':', '#'), trustedIdentities: rekey(state.trusted, ':', '#'),
    kyberUsed: Object.fromEntries(state.kyberUses.map(use => [`${use.id}:${use.signedPreKeyId}:${use.baseKey}`, true])), senderKeys: {},
  });
}

function toDesktop(text) {
  const state = JSON.parse(text);
  if (state.version !== 1 || state.libsignalVersion !== sdkVersion) throw new Error('not a phone state of this library');
  if (state.signedPreKeyId !== 1 || state.kyberPreKeyId !== 1) throw new Error('the desktop bridge only knows signed and Kyber prekey 1');
  const pair = signal.IdentityKeyPair.deserialize(decode(state.identityKeyPair));
  return JSON.stringify({
    format: 'invizent-desktop-signal-v1', localAddressName: state.localAddressName, localDeviceId: state.localDeviceId,
    registrationId: state.registrationId, identityPrivate: encode(pair.privateKey.serialize()), identityKey: encode(pair.publicKey.serialize()),
    signedPreKeys: state.signedPreKeys, kyberPreKeys: state.kyberPreKeys, preKeys: state.preKeys, nextPreKeyId: state.nextPreKeyId,
    sessions: rekey(state.sessions, '#', ':'), trusted: rekey(state.trustedIdentities, '#', ':'),
    kyberUses: Object.keys(state.kyberUsed).map(tuple => { const [id, signedPreKeyId, baseKey] = tuple.split(':'); return { id: Number(id), signedPreKeyId: Number(signedPreKeyId), baseKey }; }),
  });
}

const methods = { ...bridge, toPhone: async text => toPhone(text), toDesktop: async text => toDesktop(text), version: async () => sdkVersion };

for await (const line of createInterface({ input: process.stdin })) {
  let answer;
  try {
    const { method, args } = JSON.parse(line);
    if (!Object.hasOwn(methods, method)) throw new Error(`unknown method ${method}`);
    answer = { ok: true, value: await methods[method](...args) };
  } catch (error) {
    answer = { ok: false, error: { name: String(error?.name ?? ''), code: error?.code ?? null, message: String(error?.message ?? error) } };
  }
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}
