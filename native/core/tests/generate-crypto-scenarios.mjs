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
    sync: (chat = CHAT, maxPages) => step(w, steps, 'sync', JSON.stringify([chat, maxPages ?? null]), () => service.syncChat(chat, maxPages)),
    preview: message => step(w, steps, 'preview', JSON.stringify([message]), () => service.preview(structuredClone(message))),
    mesh: input => step(w, steps, 'mesh', JSON.stringify([input]), () => service.receiveMesh(structuredClone(input))),
    delivered: (clientId, chat = CHAT) => step(w, steps, 'delivered', JSON.stringify([chat, clientId]), () => service.delivered(chat, clientId)),
    forget: (clientId, chat = CHAT) => step(w, steps, 'forget', JSON.stringify([chat, clientId]), () => service.forget(chat, clientId)),
    forgetChat: (chat = CHAT) => step(w, steps, 'forgetChat', JSON.stringify([chat]), () => service.forgetChat(chat)),
    historyPage: (chat = CHAT, page) => step(w, steps, 'historyPage', JSON.stringify([chat, page ?? null]), () => service.historyPage(chat, page)),
    history: (chat = CHAT, limit, fromPage) => step(w, steps, 'history', JSON.stringify([chat, limit ?? null, fromPage ?? null]), () => service.history(chat, limit, fromPage)),
    storeCache: (name, value) => step(w, steps, 'storeCache', JSON.stringify([name, value]), () => service.storeCache(name, value)),
    loadCache: name => step(w, steps, 'loadCache', JSON.stringify([name]), () => service.loadCache(name)),
    sealNote: (peer, device, text) => step(w, steps, 'sealNote', JSON.stringify([peer, device, text]), () => service.sealNote(peer, device, text)),
    openNote: (sender, note) => step(w, steps, 'openNote', JSON.stringify([sender, note]), () => service.openNote(sender, note)),
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

// ── Receiving ──
const MYDEV = '00000000-0000-4000-8000-000000000001'; // the first id a world hands out: this device's
const CHAT2 = 'c0000000-0000-4000-8000-000000000002';
const b64 = text => Buffer.from(text, 'utf8').toString('base64');
/** A message as the server hands it out, «encrypted» the way the stand-in library does. `tweak` spoils it. */
function incoming(id, clientId, text, { sender = PEER, device = D(1), chat = CHAT, lane, attachment = null, meta, waveform, type = 3, tweak, raw } = {}) {
  const payload = { version: 1, chatId: chat, clientId, senderId: sender, senderDeviceId: device, recipientId: ME, recipientDeviceId: MYDEV, ...(lane ? { lane } : {}), text, attachment, sentAt: '2026-11-20T12:00:00.000Z', ...(meta ? { meta } : {}), ...(waveform ? { voiceWaveform: waveform } : {}) };
  const message = { id, chatId: chat, clientId, senderId: sender, text: '', attachment: null, createdAt: '2026-11-20T12:00:01.000Z', encrypted: { scheme: 'signal-v1', senderDeviceId: device, envelopes: [], attachmentIds: attachment ? [attachment.id] : [], ...(lane ? { lane } : {}) } };
  tweak?.(payload, message);
  message.encrypted.envelopes = [{ userId: ME, deviceId: D(3), type: 2, body: b64('other\nx') }, { userId: ME, deviceId: MYDEV, type, body: b64('me\n' + (raw ?? JSON.stringify(payload))) }, ...(message.encrypted.envelopes || [])];
  return message;
}
/** The server's inbox: `list` in pages of `size`. */
const serve = (s, list, size = 100) => { s.w.server.inbox = (device, chat, after) => { const rest = list.filter(m => m.id > after), page = rest.slice(0, size); return structuredClone({ messages: page, nextCursor: page.length ? page[page.length - 1].id : after, hasMore: rest.length > page.length }); }; };
const PHOTO = { id: 'f0000000-0000-4000-8000-000000000003', name: 'a.jpg', mimeType: 'image/jpeg', size: 1000, encryption: { scheme: 'aes-256-gcm-siv', key: KEY, nonce: NONCE, fileKeyId: 'f0000000-0000-4000-8000-000000000004' } };
const VOICE = { id: FILE.id, name: FILE.name, mimeType: FILE.mimeType, size: FILE.size, encryption: FILE.encryption, media: { durationMs: 3000 } };

await scenario('messages come: each is opened once, kept, and shown from the kept copy', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const list = [incoming(1, M(1), 'привет'), incoming(2, M(2), 'тихо', { meta: { silent: true }, type: 2 }), incoming(3, M(3), '', { attachment: VOICE, waveform: 'ABCDEFGHabcdef', type: 2 }), incoming(4, M(4), 'фото', { attachment: PHOTO, type: 2 })];
  serve(s, list);
  await s.sync(); await s.sync();
  for (const message of list) await s.preview(message);
  await s.preview({ ...list[0], encrypted: { ...list[0].encrypted, attachmentIds: [PHOTO.id] } }); // the list shows another packet under the same id
  await s.preview(incoming(9, M(9), 'ещё не открыто'));
  await s.preview(incoming(9, M(9), 'от незнакомого устройства', { device: D(2) }));
  await s.preview({ id: 9, chatId: CHAT, clientId: M(9), senderId: PEER, text: 'старое', attachment: null, createdAt: 'x' });
  await s.preview({ id: 9, chatId: CHAT, clientId: M(9), senderId: PEER, text: '', encrypted: { scheme: 'other' } });
  await s.preview({ id: 9, chatId: CHAT, clientId: M(9), senderId: PEER, text: '', encrypted: { scheme: 'signal-v1', senderDeviceId: D(1), envelopes: [{ userId: PEER, deviceId: D(1), type: 2, body: b64('x') }], attachmentIds: [] } });
  await s.preview({ id: 1, chatId: CHAT, clientId: M(1), senderId: PEER, lean: true, text: '' });
  await s.preview({ id: 2, chatId: CHAT, clientId: M(2), senderId: PEER, lean: true, text: '', meta: { pinned: true } });
  await s.preview({ id: 9, chatId: CHAT, clientId: M(9), senderId: PEER, lean: true, text: '' });
  await s.historyPage(); await s.historyPage(CHAT, 0); await s.historyPage(CHAT, 5); await s.historyPage(CHAT2);
  await s.history(); await s.history(CHAT, 2);
  await s.encrypt(M(5), 'ответ'); // there is a session now: answered without asking for a bundle
});
await scenario('without automatic trust nothing from an unchecked device is opened', {}, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const list = [incoming(1, M(1), 'привет')]; serve(s, list);
  await s.sync(); await s.preview(list[0]);
  const seen = await s.snapshot(); await s.approve(seen.ok);
  await s.preview(list[0]); await s.sync(); await s.preview(list[0]);
});
await scenario('a message that never opens is tried three times, then skipped; the next message to its sender starts a fresh session', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const list = [incoming(1, M(1), 'до'), incoming(2, M(2), 'битое', { type: 2 }), incoming(3, M(3), 'после', { type: 2 })]; serve(s, list);
  for (let n = 0; n < 3; n++) { s.w.failures.push({ method: 'decrypt', message: 'InvalidMessage: bad MAC', name: 'Error' }); await s.sync(); }
  await s.sync();
  await s.preview(list[1]); await s.preview({ id: 2, chatId: CHAT, clientId: M(2), senderId: PEER, lean: true }); await s.preview(list[2]);
  await s.historyPage();
  await s.encrypt(M(5), 'ты тут?'); await s.encrypt(M(6), 'ещё');
  // A broken scheduled message says nothing about the ordinary session.
  list.push(incoming(4, M(4), 'отложенное битое', { lane: 'scheduled' }));
  for (let n = 0; n < 3; n++) { s.w.failures.push({ method: 'decrypt', message: 'bad', name: 'Error' }); await s.sync(); }
  await s.encrypt(M(7), 'без новой сессии');
  // The network going away in the middle is not an attempt.
  list.push(incoming(5, M(8), 'от нового устройства', { device: D(2) })); s.w.addDevice(PEER, D(2)); s.w.server.offline = true;
  await s.sync(); s.w.server.offline = false; await s.sync();
});
await scenario('what is inside must say the same as what is outside', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const bad = [
    p => { p.recipientDeviceId = D(3); }, p => { p.chatId = CHAT2; }, p => { p.clientId = M(9); }, p => { p.senderId = OTHER; }, p => { p.senderDeviceId = D(2); }, p => { p.recipientId = PEER; },
    p => { p.version = 2; }, p => { p.text = 5; }, p => { p.text = 'x'.repeat(8001); }, p => { delete p.attachment; }, p => { p.attachment = { id: 'x' }; }, p => { p.sentAt = 'вчера'; }, p => { delete p.sentAt; },
    p => { p.meta = { unknown: true }; }, p => { p.lane = 'scheduled'; }, (p, m) => { m.encrypted.lane = 'scheduled'; }, (p, m) => { m.encrypted.attachmentIds = [PHOTO.id]; }, p => { p.attachment = PHOTO; },
  ];
  const list = bad.map((tweak, n) => incoming(n + 1, M(1), 'x', { tweak })).map((m, n) => ({ ...m, clientId: `e00000${String(n + 10)}-0000-4000-8000-000000000001` }));
  // (the ids differ outside; inside they are fixed up to match unless the tweak is about them)
  const fixed = bad.map((tweak, n) => { const clientId = `e00000${String(n + 10)}-0000-4000-8000-000000000001`; return incoming(n + 1, clientId, 'x', { tweak: (p, m) => { tweak(p, m); } }); });
  fixed.push(incoming(40, M(2), 'x', { raw: 'не JSON' }), incoming(41, M(3), 'x', { raw: 'null' }), incoming(42, M(4), 'x', { raw: '"текст"' }), incoming(43, M(5), 'хорошее', { lane: 'scheduled' }), incoming(44, M(6), 'с пустой отметкой', { tweak: p => { p.lane = null; p.meta = null; } }));
  serve(s, fixed);
  for (let n = 0; n < fixed.length * 3 + 2; n++) { const result = await s.sync(); if (!result.error) break; }
  await s.sync();
  for (const message of [fixed[0], fixed[18], fixed[21], fixed[22]]) await s.preview(message);
  await s.historyPage();
});
await scenario('a server that hands out the wrong things', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1)); s.w.addDevice(ME, D(3));
  const a = incoming(5, M(1), 'первое'), b = incoming(6, M(2), 'второе', { type: 2 });
  serve(s, [a, b]); await s.sync();
  serve(s, [{ ...a, id: 7 }]); await s.sync(); // the same message again under a new number: nothing is opened twice
  serve(s, [{ ...incoming(8, M(1), 'подменённое'), }]); await s.sync(); // another packet under a kept id
  s.w.server.inbox = () => ({ messages: [incoming(3, M(3), 'из прошлого')], nextCursor: 3, hasMore: false }); await s.sync();
  s.w.server.inbox = () => ({ messages: [incoming(9, M(3), 'из другого чата', { chat: CHAT2 })], nextCursor: 9, hasMore: false }); await s.sync();
  s.w.server.inbox = () => ({ messages: [{ ...incoming(9, M(3), 'x'), id: 9.5 }], nextCursor: 9, hasMore: false }); await s.sync();
  s.w.server.inbox = () => ({ messages: [{ ...incoming(9, M(3), 'x'), id: '9' }], nextCursor: 9, hasMore: false }); await s.sync();
  s.w.server.inbox = () => ({ messages: [{ ...incoming(9, M(3), 'x'), encrypted: { scheme: 'signal-v1' } }], nextCursor: 9, hasMore: false }); await s.sync();
  s.w.server.inbox = () => ({ messages: [{ id: 9, chatId: CHAT, clientId: M(3), senderId: PEER, text: 'открытым текстом' }], nextCursor: 9, hasMore: false }); await s.sync();
  s.w.server.inbox = () => ({ messages: [], nextCursor: 7, hasMore: true }); await s.sync();
  s.w.server.inbox = (d, c, after) => ({ messages: after < 9 ? [incoming(9, M(3), 'третье', { type: 2 })] : [], nextCursor: 8, hasMore: true }); await s.sync();
  // Not for this device; our own from another device (lean: no packet at all); our own with a packet.
  const elsewhere = incoming(10, M(4), 'x'); elsewhere.encrypted.envelopes = elsewhere.encrypted.envelopes.filter(e => e.deviceId !== MYDEV);
  serve(s, [elsewhere, { id: 11, chatId: CHAT, clientId: M(5), senderId: ME, lean: true }, incoming(12, M(6), 'с моего другого устройства', { sender: ME, device: D(3) }), { id: 13, chatId: CHAT, clientId: M(7), senderId: PEER, lean: true }]);
  await s.sync(); await s.preview(elsewhere);
  s.w.server.refuse = { method: 'cryptoInbox', message: 'Слишком много запросов.' }; await s.sync();
});
await scenario('a long history comes in pages; a background catch-up stops at its limit and goes on later', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const list = Array.from({ length: 7 }, (_, n) => incoming(n + 1, `e0000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`, `сообщение ${n + 1}`, { type: n ? 2 : 3 }));
  serve(s, list, 2);
  await s.sync(CHAT, 1); await s.sync(CHAT, 2); await s.sync(); await s.sync(CHAT, 1);
  await s.history(CHAT, 3); await s.sync(CHAT2);
});
await scenario('a scheduled message is opened at its own address and leaves the ordinary session alone', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const list = [incoming(1, M(1), 'отложенное', { lane: 'scheduled' })]; serve(s, list);
  await s.sync(); await s.preview(list[0]);
  await s.encrypt(M(2), 'ответ'); // no ordinary session yet: a bundle is asked for
});
await scenario('Mesh: a message that came without the server, and the server copy after it', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const strip = m => ({ chatId: m.chatId, clientId: m.clientId, senderId: m.senderId, encrypted: m.encrypted });
  const a = incoming(1, M(1), 'по блютузу'), b = incoming(2, M(2), 'второе', { type: 2, meta: { silent: true } }), c = incoming(3, M(3), 'третье', { type: 2 });
  await s.mesh(strip(a)); await s.mesh(strip(a));
  await s.mesh(strip(b)); await s.mesh(strip(c));
  await s.historyPage();
  // The server copies: the very same packet; a re-encryption of the same content; other content under the same id.
  const again = incoming(2, M(2), 'второе', { type: 2, meta: { silent: true } }); again.encrypted.envelopes.push({ userId: PEER, deviceId: D(2), type: 3, body: b64('x') });
  const other = incoming(3, M(3), 'не то', { type: 2 }); other.encrypted.envelopes.push({ userId: PEER, deviceId: D(2), type: 3, body: b64('x') });
  serve(s, [a, again, other]);
  await s.sync(); await s.sync();
  await s.preview(a); await s.preview(again); await s.historyPage();
  await s.mesh(null); await s.mesh({ ...strip(a), clientId: 'x' }); await s.mesh({ ...strip(a), clientId: M(4), encrypted: { scheme: 'signal-v1' } });
  await s.mesh(strip(incoming(0, M(4), 'от себя', { sender: ME, device: D(3) })));
  const elsewhere = incoming(0, M(4), 'x'); elsewhere.encrypted.envelopes = elsewhere.encrypted.envelopes.filter(e => e.deviceId !== MYDEV); await s.mesh(strip(elsewhere));
  await s.mesh(strip(incoming(0, M(4), 'не туда', { tweak: p => { p.chatId = CHAT2; } })));
  // A device never seen, with no internet to ask about it: not received (it may come again).
  s.w.addDevice(PEER, D(2)); s.w.server.offline = true;
  const fresh = strip(incoming(0, M(5), 'с нового устройства', { device: D(2) }));
  await s.mesh(fresh); s.w.server.offline = false; await s.mesh(fresh);
  await s.mesh(strip(incoming(0, M(6), 'с устройства, которого нет в списке', { device: D(4) })));
  await s.mesh(strip(incoming(0, M(7), 'отложенное', { lane: 'scheduled' })));
});
await scenario('Mesh without automatic trust: an unchecked device is refused', {}, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const m = incoming(0, M(1), 'x'); await s.mesh({ chatId: m.chatId, clientId: m.clientId, senderId: m.senderId, encrypted: m.encrypted });
});
await scenario('sent, refused for good, chat deleted: what leaves the vault', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1)); s.w.addDevice(OTHER, D(2));
  for (const n of [1, 2, 3]) await s.encrypt(M(n), `сообщение ${n}`);
  await s.encrypt(M(4), 'в другой чат', { chat: CHAT2, peer: OTHER });
  serve(s, [incoming(1, M(5), 'входящее')]); await s.sync();
  await s.storeCache(`page:v1:${CHAT}`, '{"messages":[]}'); await s.storeCache('chats:v1', '[]'); await s.storeCache('other', 'x'); await s.storeCache('page:v1:', 'x'); await s.storeCache(`page:v1:${'a'.repeat(81)}`, 'x');
  await s.loadCache('chats:v1'); await s.loadCache(`page:v1:${CHAT2}`); await s.loadCache('device');
  await s.delivered(M(1)); await s.delivered(M(1)); await s.pending(); await s.historyPage();
  await s.forget(M(2)); await s.forget(M(9)); await s.pending(); await s.historyPage();
  await s.encrypt(M(2), 'заново, другим текстом'); // the id is free again
  await s.forgetChat('not-a-chat'); await s.forgetChat(); await s.forgetChat();
  await s.pending(); await s.historyPage(); await s.historyPage(CHAT2); await s.loadCache(`page:v1:${CHAT}`);
  await s.storeCache('chats:v1', null);
  await s.forgetChat(CHAT2); await s.pending();
});
await scenario('notes for one device (voice rooms)', { autoTrust: true }, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1)); s.w.addDevice(PEER, D(2));
  const note = (text, { device = D(1), type = 3, tweak, raw } = {}) => { const p = { version: 1, note: 'voice', senderId: PEER, senderDeviceId: device, recipientId: ME, recipientDeviceId: MYDEV, text }; tweak?.(p); return { senderDeviceId: device, type, body: b64('n\n' + (raw ?? JSON.stringify(p))) }; };
  await s.sealNote(PEER, D(1), 'я здесь'); await s.sealNote(PEER, D(1), 'ещё раз');
  await s.sealNote(PEER, D(4), 'нет такого'); await s.sealNote(PEER, 'x', 'x'); await s.sealNote(PEER, D(1), ''); await s.sealNote(PEER, D(1), 'x'.repeat(4001)); await s.sealNote(ME, D(1), 'себе');
  await s.openNote(PEER, note('и я здесь', { device: D(2) })); await s.openNote(PEER, note('второе', { type: 2 }));
  await s.openNote(PEER, note('не мне', { tweak: p => { p.recipientDeviceId = D(3); } })); await s.openNote(PEER, note('не заметка', { tweak: p => { delete p.note; } })); await s.openNote(PEER, note('x'.repeat(4001)));
  await s.openNote(PEER, note('x', { raw: '{' })); await s.openNote(PEER, { ...note('x'), type: 1 }); await s.openNote(PEER, { ...note('x'), body: 'не base64' }); await s.openNote(ME, note('x')); await s.openNote('x', note('x'));
  await s.openNote(PEER, note('с неизвестного', { device: D(4) })); await s.openNote(OTHER, note('x'));
  s.w.failures.push({ method: 'decrypt', message: 'bad MAC', name: 'Error' }); await s.openNote(PEER, note('x'));
  s.w.advance(21 * 86_400_000); await s.sealNote(PEER, D(1), 'через три недели');
  s.w.failures.push({ method: 'encrypt', message: 'SessionNotFound', name: 'Error' }); await s.sealNote(PEER, D(1), 'сессия пропала');
  s.w.failures.push({ method: 'encrypt', message: 'untrusted identity', name: 'Error' }); await s.sealNote(PEER, D(1), 'ключ не тот');
  s.w.addDevice(PEER, D(1), { address: `${PEER}.${D(1)}.reinstalled` }); await s.sealNote(PEER, D(1), 'после переустановки');
  await s.encrypt(M(1), 'обычное сообщение идёт своей сессией');
});
await scenario('notes without automatic trust', {}, async s => {
  await s.initialize(); s.w.addDevice(PEER, D(1));
  const body = b64('n\n' + JSON.stringify({ version: 1, note: 'voice', senderId: PEER, senderDeviceId: D(1), recipientId: ME, recipientDeviceId: MYDEV, text: 'привет' }));
  await s.sealNote(PEER, D(1), 'x'); await s.openNote(PEER, { senderDeviceId: D(1), type: 3, body });
  const seen = await s.snapshot(); await s.approve(seen.ok);
  await s.sealNote(PEER, D(1), 'x'); await s.openNote(PEER, { senderDeviceId: D(1), type: 3, body });
});

const out = new URL('./vectors/crypto-scenarios.json', import.meta.url);
writeFileSync(out, '[\n' + scenarios.map(item => JSON.stringify(item)).join(',\n') + '\n]\n');
console.log('scenarios', scenarios.length, 'steps', scenarios.reduce((sum, item) => sum + item.steps.length, 0), 'errors', scenarios.reduce((sum, item) => sum + item.steps.filter(step => step.error).length, 0));
for (const item of scenarios) console.log(' ', item.steps.filter(step => step.error).length, 'of', item.steps.length, 'refused —', item.name, '|', [...new Set(item.steps.filter(step => step.error).map(step => step.error.message.slice(0, 40)))].join(' ; '));
