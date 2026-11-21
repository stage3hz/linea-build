// Scenarios of the encryption service, recorded from the reference itself (see reference-crypto.mjs).
// Run from the repository root:  node native/core/tests/generate-crypto-scenarios.mjs
import { writeFileSync } from 'node:fs';
import { world, step } from './reference-crypto.mjs';

const ME = '0f8fad5b-d9cb-469f-a165-70867728950e', PEER = '7c9e6679-7425-40de-944b-e07fc1f90ae7', OTHER = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const CHAT = 'c0000000-0000-4000-8000-000000000001';
const D = n => `d000000${n}-0000-4000-8000-00000000000${n}`;
const M = n => `e000000${n}-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const KEY = 'A'.repeat(43) + '=', NONCE = 'b'.repeat(16);
const FILE = { id: 'f0000000-0000-4000-8000-000000000001', name: 'voice.m4a', mimeType: 'audio/mp4', size: 4096, encryption: { scheme: 'aes-256-gcm-siv', key: KEY, nonce: NONCE, fileKeyId: 'f0000000-0000-4000-8000-000000000002' }, media: { durationMs: 3000, waveform: 'ABCDEFGHabcdef' } };
const scenarios = [];

/** A scenario: its steps are recorded; `run` gets helpers that record each call of the service. */
async function scenario(name, options, run) {
  const w = world({ userId: ME }); const steps = []; let service = w.service(options);
  const api = {
    w,
    restart: (next = options) => { service = w.service(next); steps.push({ op: 'new', args: JSON.stringify([next]), ok: null, error: null, io: [], set: {}, removed: [] }); },
    initialize: () => step(w, steps, 'initialize', '[]', () => service.initialize()),
    encrypt: (clientId, text, { peer = PEER, chat = CHAT, attachment = null, meta, deliverAt } = {}) => step(w, steps, 'encrypt', JSON.stringify([chat, peer, clientId, text, attachment, meta ?? null, deliverAt ?? null]), () => service.encrypt(chat, peer, clientId, text, attachment, meta, deliverAt)),
    snapshot: (peer = PEER) => step(w, steps, 'snapshot', JSON.stringify([peer]), () => service.trustSnapshot(peer)),
    approve: snapshot => step(w, steps, 'approve', JSON.stringify([snapshot]), () => service.approveDevices(snapshot)),
    pending: () => step(w, steps, 'pendingOutbox', '[]', () => service.pendingOutbox()),
  };
  steps.push({ op: 'new', args: JSON.stringify([options]), ok: null, error: null, io: [], set: {}, removed: [] });
  await run(api);
  scenarios.push({ name, userId: ME, steps });
}

await scenario('first start: keys are made, kept, then published', { autoTrust: true }, async s => { await s.initialize(); await s.initialize(); });
await scenario('first start with few prekeys left on the server: more are made and published', { autoTrust: true }, async s => { s.w.server.preKeyCount = 7; await s.initialize(); });
await scenario('a second start finds the keys and only publishes them', { autoTrust: true }, async s => { await s.initialize(); s.restart(); s.w.server.preKeyCount = 8; await s.initialize(); });
await scenario('the server answers with other keys: stopped', { autoTrust: true }, async s => {
  await s.initialize(); s.restart();
  s.w.server.registerOverride = row => ({ ...row, identityKey: 'Z'.repeat(44) });
  await s.initialize();
  s.w.server.registerOverride = row => ({ ...row, id: D(9) });
  await s.initialize();
  s.w.server.registerOverride = null; s.w.addDevice(PEER, D(1));
  await s.encrypt(M(1), 'привет');
});
await scenario('no internet at the start: nothing is published, the next try works', { autoTrust: true }, async s => { s.w.server.offline = true; await s.initialize(); s.w.server.offline = false; await s.initialize(); });
await scenario('a message to a peer with two devices and to one own other device', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1)); s.w.addDevice(PEER, D(2)); s.w.addDevice(ME, D(3));
  await s.encrypt(M(1), 'привет');
  await s.encrypt(M(1), 'привет'); // a retry: the same ciphertext, no calls out
  await s.encrypt(M(1), 'другой текст'); // the id is taken
  await s.encrypt(M(2), 'второе', { meta: { silent: true } });
  await s.encrypt(M(2), 'второе'); // same id, other meta
  await s.encrypt(M(3), '', { attachment: FILE, meta: { reply: { clientId: M(1), senderId: ME, preview: 'привет' } } });
  await s.encrypt(M(3), '', { attachment: FILE, meta: { reply: { clientId: M(1), senderId: ME, preview: 'привет' } } });
  await s.pending();
});
await scenario('content that is not a message is refused before anything else', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  await s.encrypt(M(1), '');
  await s.encrypt(M(1), '   \n ');
  await s.encrypt(M(1), 'x'.repeat(8001));
  await s.encrypt(M(1), 'x'.repeat(8000));
  await s.encrypt('not-an-id', 'x');
  await s.encrypt(M(2), 'x', { chat: 'nope' });
  await s.encrypt(M(2), 'x', { attachment: { ...FILE, size: -1 } });
  await s.encrypt(M(2), 'x', { meta: { unknown: 1 } });
  await s.encrypt(M(2), 'x', { deliverAt: 'не дата' });
  await s.encrypt(M(2), 'x', { peer: ME });
  await s.encrypt(M(2), 'x', { peer: 'nobody' });
});
await scenario('without automatic trust a new device stops the message; approving the codes lets it through', {}, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1)); s.w.addDevice(PEER, D(2));
  await s.encrypt(M(1), 'привет');
  const seen = await s.snapshot();
  await s.approve(seen.ok);
  await s.encrypt(M(1), 'привет');
  await s.snapshot();
  // A third device appears between looking and approving.
  const before = await s.snapshot(); s.w.addDevice(PEER, D(4));
  await s.approve(before.ok);
  await s.encrypt(M(2), 'ещё');
});
await scenario('the peer re-installed: with automatic trust the new key gets a fresh session', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  await s.encrypt(M(1), 'раз');
  await s.encrypt(M(2), 'два'); // the session exists: no bundle is claimed
  s.w.addDevice(PEER, D(1), { address: `${PEER}.${D(1)}.reinstalled` });
  await s.encrypt(M(3), 'три');
  await s.snapshot();
});
await scenario('the peer re-installed: without automatic trust the changed key is refused, also on approval', {}, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const first = await s.snapshot(); await s.approve(first.ok);
  await s.encrypt(M(1), 'раз');
  s.w.addDevice(PEER, D(1), { address: `${PEER}.${D(1)}.reinstalled` });
  await s.encrypt(M(2), 'два');
  const changed = await s.snapshot();
  await s.approve(changed.ok);
});
await scenario('without internet: only to devices already written to; a stranger cannot be written to', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1)); s.w.addDevice(ME, D(3));
  await s.encrypt(M(1), 'в сети');
  s.w.addDevice(PEER, D(2)); // appears while we are offline: unknown here
  s.w.server.offline = true;
  await s.encrypt(M(2), 'без сети');
  await s.encrypt(M(3), 'другому', { peer: OTHER });
  await s.encrypt(M(4), 'позже', { deliverAt: '2026-12-01T10:00:00.000Z' }); // scheduling needs the server
  await s.pending();
});
await scenario('a scheduled message travels in its own session, renewed after twenty days', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  await s.encrypt(M(1), 'обычное');
  await s.encrypt(M(2), 'позже', { deliverAt: '2026-12-01T10:00:00.000Z' });
  await s.encrypt(M(3), 'ещё позже', { deliverAt: '2026-12-02T10:00:00+03:00' });
  await s.encrypt(M(2), 'позже'); // the same id without the time: not the same message
  s.w.advance(21 * 86_400_000);
  await s.encrypt(M(4), 'через три недели', { deliverAt: '2027-01-01T00:00:00Z' });
  s.w.failures.push({ method: 'encrypt', message: 'SessionNotFound: no session', name: 'Error' });
  await s.encrypt(M(5), 'сессия пропала', { deliverAt: '2027-01-02T00:00:00.000Z' });
  s.w.failures.push({ method: 'encrypt', message: 'untrusted identity for session', name: 'Error' });
  await s.encrypt(M(6), 'ключ не тот', { deliverAt: '2027-01-03T00:00:00.000Z' });
  s.w.failures.push({ method: 'encrypt', message: 'SessionNotFound', name: 'Error' });
  await s.encrypt(M(7), 'обычная сессия не чинится так'); // not a lane: the error goes up
  await s.pending();
});
await scenario('lists the server may not send', { autoTrust: true }, async s => {
  await s.initialize();
  await s.encrypt(M(1), 'никого'); // the peer has no devices
  s.w.addDevice(PEER, D(1), { active: false });
  await s.encrypt(M(1), 'выключено');
  s.w.addDevice(PEER, D(1));
  for (let n = 1; n <= 9; n++) s.w.addDevice(PEER, `d00000${String(n).padStart(2, '0')}-0000-4000-8000-000000000099`);
  await s.encrypt(M(1), 'слишком много');
  s.w.server.devices.set(PEER, [{ ...s.w.server.devices.get(PEER)[0], registrationId: 16384 }]);
  await s.encrypt(M(1), 'не тот номер');
  s.w.server.devices.set(PEER, [{ ...s.w.server.devices.get(PEER)[0], registrationId: 5, identityKey: 'short' }]);
  await s.encrypt(M(1), 'не тот ключ');
  s.w.server.devices.set(PEER, [{ ...s.w.server.devices.get(PEER)[0], identityKey: 'K'.repeat(44), userId: OTHER }]);
  await s.encrypt(M(1), 'чужое устройство');
  // This device is no longer in the account's list.
  s.w.server.devices.set(PEER, []); s.w.addDevice(PEER, D(1)); s.w.server.devices.set(ME, []);
  await s.encrypt(M(1), 'меня убрали');
});
await scenario('the server hands out a bundle for another key: refused', { autoTrust: true }, async s => {
  await s.initialize(); const row = s.w.addDevice(PEER, D(1));
  s.w.server.claimOverride = device => ({ device: structuredClone(device), bundle: { registrationId: device.registrationId, identityKey: 'X'.repeat(44), signedPreKey: { id: 1, publicKey: 'spk', signature: 'sig' }, kyberPreKey: { id: 1, publicKey: 'kpk', signature: 'ksig' } } });
  await s.encrypt(M(1), 'привет');
  s.w.server.claimOverride = device => ({ device: { ...structuredClone(device), id: D(2) }, bundle: { registrationId: device.registrationId, identityKey: device.identityKey, signedPreKey: { id: 1, publicKey: 'spk', signature: 'sig' }, kyberPreKey: { id: 1, publicKey: 'kpk', signature: 'ksig' } } });
  await s.encrypt(M(1), 'привет');
  s.w.server.claimOverride = null;
  await s.encrypt(M(1), 'привет');
});
await scenario('sixty messages: the history turns a page, the list of unsent ones grows', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  for (let n = 1; n <= 60; n++) await s.encrypt(`e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, `сообщение ${n}`);
  await s.pending();
});

const out = new URL('./vectors/crypto-scenarios.json', import.meta.url);
writeFileSync(out, '[\n' + scenarios.map(item => JSON.stringify(item)).join(',\n') + '\n]\n');
console.log('scenarios', scenarios.length, 'steps', scenarios.reduce((sum, item) => sum + item.steps.length, 0), 'errors', scenarios.reduce((sum, item) => sum + item.steps.filter(step => step.error).length, 0));
for (const item of scenarios) console.log(' ', item.steps.filter(step => step.error).length, 'of', item.steps.length, 'refused —', item.name, '|', [...new Set(item.steps.filter(step => step.error).map(step => step.error.message.slice(0, 40)))].join(' ; '));
