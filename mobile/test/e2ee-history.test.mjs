import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { harness } from './support/crypto-harness.mjs';
import { nodeSignalBridge } from './support/signal-node.mjs';
import { loadTs } from './support/load-ts.mjs';

// Old chats on a new device (docs/HISTORY-TRANSFER.md), with the real Signal library and AES-256-GCM-SIV:
// the new device of the same account reads what was sent before it existed; the "server" here only keeps
// what the real one keeps (ciphertext pages and sealed notes) and is checked never to see a message.
const history = loadTs(new URL('../src/e2ee/history.ts', import.meta.url));
const sync = loadTs(new URL('../src/e2ee/historySync.ts', import.meta.url));
const random = count => new Uint8Array(randomBytes(count));

/** What the server keeps for history.js, in memory; every value that passes is recorded in `seen`. */
function fakeServer(userId) {
  const seen = [];
  const transfers = new Map(), backup = { enabled: false, salt: randomBytes(32).toString('base64'), generation: 0, keyCheck: null, pages: [], notes: new Map(), writer: null };
  const keep = value => { seen.push(JSON.stringify(value)); return value; };
  const api = {
    requestHistory: async deviceId => { const id = randomUUID(); const transfer = { id, state: 'waiting', targetDeviceId: deviceId, sourceDeviceId: null, notBefore: new Date().toISOString(), ready: true, pageCount: 0, bytes: 0, expiresAt: '', pages: [] }; transfers.set(id, transfer); return { transfer }; },
    outgoingHistory: async deviceId => ({ transfers: [...transfers.values()].filter(t => t.targetDeviceId !== deviceId && (t.state === 'waiting' || t.state === 'sending')) }),
    incomingHistory: async deviceId => ({ transfer: [...transfers.values()].find(t => t.targetDeviceId === deviceId) ?? null }),
    claimHistory: async (id, deviceId) => { const t = transfers.get(id); t.state = 'sending'; t.sourceDeviceId = deviceId; t.pages = []; return { transfer: t }; },
    putHistoryPage: async (id, index, deviceId, body) => { const t = transfers.get(id); assert.equal(index, t.pages.length); t.pages.push(keep(body)); t.pageCount = t.pages.length; return { pageCount: t.pageCount }; },
    completeHistory: async (id, deviceId, note, pageCount) => { const t = transfers.get(id); assert.equal(pageCount, t.pages.length); t.state = 'ready'; t.note = keep(note); return { transfer: t }; },
    historyPage: async (id, index) => ({ body: transfers.get(id).pages[index] }),
    ackHistory: async id => { const t = transfers.get(id); t.state = 'done'; t.pages = []; delete t.note; return { ok: true }; },
    cancelHistory: async id => { transfers.get(id).state = 'cancelled'; return { ok: true }; },
    backupState: async deviceId => ({ enabled: backup.enabled, salt: backup.salt, generation: backup.generation, pageCount: backup.pages.length, bytes: 0, updatedAt: null, writerDeviceId: backup.writer, restoreAt: '', canRestore: true,
      ...(backup.notes.has(deviceId) ? { note: backup.notes.get(deviceId) } : {}), missing: backup.enabled ? api.devices.filter(id => id !== deviceId && !backup.notes.has(id)).map(id => ({ id, deviceName: 'x' })) : [] }),
    enableBackup: async (deviceId, generation, keyCheck) => { assert.equal(generation, backup.generation + 1); Object.assign(backup, { enabled: true, generation, keyCheck: keep(keyCheck), pages: [], writer: deviceId }); backup.notes.clear(); return api.backupState(deviceId); },
    disableBackup: async () => { Object.assign(backup, { enabled: false, keyCheck: null, pages: [], writer: null }); backup.notes.clear(); return { ok: true }; },
    putBackupNote: async (deviceId, target, generation, note) => { assert.equal(generation, backup.generation); backup.notes.set(target, keep(note)); return { ok: true }; },
    appendBackupPage: async (deviceId, generation, body, reset) => {
      if (backup.writer && backup.writer !== deviceId) throw Object.assign(new Error('busy'), { code: 'BACKUP_WRITER', status: 409 });
      if (reset) backup.pages = [];
      backup.pages.push(keep(body)); backup.writer = deviceId; return { index: backup.pages.length - 1, pageCount: backup.pages.length };
    },
    startRestore: async () => { backup.attempts = (backup.attempts ?? 0) + 1; return { salt: backup.salt, keyCheck: backup.keyCheck, generation: backup.generation, pageCount: backup.pages.length, attemptsLeft: 5 - backup.attempts }; },
    backupPage: async index => ({ body: backup.pages[index] }),
    devices: [],
  };
  return { api, seen, transfers, backup, userId };
}

async function world(t) {
  const h = await harness(t, { autoTrust: true });
  const { alice, bob, relay, chatId, make } = h;
  // Two messages each way before the new device exists, one with an attachment key inside.
  const attachment = { id: randomUUID(), name: 'отчёт.pdf', mimeType: 'application/pdf', size: 1234, encryption: { scheme: 'aes-256-gcm-siv', key: Buffer.alloc(32, 7).toString('base64'), nonce: Buffer.alloc(12, 9).toString('base64'), fileKeyId: randomUUID() } };
  const sent = [];
  for (const [from, to, text, file] of [[alice, bob, 'Привет, это до нового телефона', null], [bob, alice, 'Секретный ответ', attachment], [alice, bob, 'И ещё одно', null]]) {
    const id = randomUUID();
    const encrypted = await from.service.encrypt(chatId, to.userId, id, text, file);
    sent.push({ message: relay.deliver(from.userId, chatId, id, encrypted), text, file });
    await to.service.syncChat(chatId);
  }
  const phone = await make(alice.userId);
  return { ...h, alice, bob, phone, sent, attachment };
}

test('variant A: the new device of the account reads the old chats sent by another own device; the server sees only ciphertext', async t => {
  const { alice, phone, sent, chatId } = await world(t);
  // Before: the new device has no envelope for the old messages.
  for (const { message } of sent) assert.equal((await phone.service.preview(structuredClone(message))).cryptoState, 'no-key');
  const server = fakeServer(alice.userId);
  const deps = client => ({ userId: alice.userId, api: server.api, crypto: client.service, cipher: nodeSignalBridge, random });
  const asked = await sync.askForHistory(deps(phone));
  assert.ok(asked);
  assert.equal(await sync.askForHistory(deps(phone)), null, 'asked only once');
  assert.equal(await sync.receiveHistory(deps(phone)), null, 'nothing before the old device answers');

  assert.equal(await sync.serveHistory(deps(alice)), null);
  const imported = await sync.receiveHistory(deps(phone));
  assert.equal(imported, 3);
  for (const { message, text, file } of sent) {
    const shown = await phone.service.preview(structuredClone(message));
    assert.equal(shown.cryptoState, 'decrypted');
    assert.equal(shown.text, text);
    assert.deepEqual(shown.attachment, file);
  }
  assert.deepEqual((await phone.service.history(chatId)).map(item => item.text), ['И ещё одно', 'Секретный ответ', 'Привет, это до нового телефона']);
  // A changed server copy is not shown with the imported text.
  const forged = structuredClone(sent[1].message); forged.encrypted.envelopes[0].body = Buffer.from('changed').toString('base64');
  assert.equal((await phone.service.preview(forged)).cryptoState, 'invalid');
  for (const value of server.seen) for (const { text } of sent) assert.equal(value.includes(text), false, 'the server never sees a message');
  assert.equal(server.seen.some(value => value.includes(Buffer.alloc(32, 7).toString('base64'))), false, 'nor an attachment key');
  assert.equal([...server.transfers.values()][0].state, 'done');
});

test('variant A: pages are bound to their transfer, place and key; a copy is imported once', async t => {
  const { alice, phone } = await world(t);
  const server = fakeServer(alice.userId);
  const deps = client => ({ userId: alice.userId, api: server.api, crypto: client.service, cipher: nodeSignalBridge, random });
  await sync.askForHistory(deps(phone));
  await sync.serveHistory(deps(alice));
  const transfer = [...server.transfers.values()][0];
  const key = history.newPageKey(random);
  const page = await history.sealPage(nodeSignalBridge, key, history.transferAd(transfer.id, 0), [], true, random);
  await assert.rejects(history.openPage(nodeSignalBridge, key, history.transferAd(transfer.id, 1), page), /расшифровать/);
  await assert.rejects(history.openPage(nodeSignalBridge, history.newPageKey(random), history.transferAd(transfer.id, 0), page), /расшифровать/);
  const swapped = transfer.pages[0];
  transfer.pages[0] = page; // a page made under another key
  await assert.rejects(sync.receiveHistory(deps(phone)), /расшифровать/);
  transfer.pages[0] = swapped;
  assert.equal(await sync.receiveHistory(deps(phone)), 3);
  // Importing the same entries again changes nothing.
  const batch = await alice.service.historyExport(null, null);
  assert.equal((await phone.service.historyImport(batch.items)).imported, 0);
  // Malformed entries refuse the whole batch.
  await assert.rejects(phone.service.historyImport([{ ...batch.items[0], fingerprint: 'x' }]), /Некорректная копия/);
  await assert.rejects(phone.service.historyImport([{ ...batch.items[0], extra: 1 }]), /Некорректная копия/);
  // A key note for another device / not from an own device is refused.
  await assert.rejects(phone.service.openNote(randomUUID(), transfer.note ?? { senderDeviceId: randomUUID(), type: 2, body: 'AA==' }, 'history'), /Некорректная заметка/);
});

test('export goes in batches by size and continues where it stopped; marks give only newer messages', async t => {
  const { alice, bob, relay, chatId } = await world(t);
  const all = await alice.service.historyExport(null, null);
  assert.equal(all.items.length, 3);
  assert.equal(all.next, null);
  const first = await alice.service.historyExport(null, null, 10);
  assert.equal(first.items.length, 1);
  assert.ok(first.next);
  const second = await alice.service.historyExport(null, first.next, 10);
  assert.equal(second.items[0].clientId, all.items[1].clientId);
  const after = await alice.service.historyExport(all.marks, null);
  assert.equal(after.items.length, 0);
  const id = randomUUID();
  relay.deliver(bob.userId, chatId, id, await bob.service.encrypt(chatId, alice.userId, id, 'новое', null));
  await alice.service.syncChat(chatId);
  const fresh = await alice.service.historyExport(all.marks, null);
  assert.deepEqual(fresh.items.map(item => item.text), ['новое']);
});

test('variant B: backup secret made on a device, shared sealed with own devices, restored on a new device by the typed secret', async t => {
  const { alice, phone, sent } = await world(t);
  const server = fakeServer(alice.userId);
  server.api.devices = [];
  const deps = client => ({ userId: alice.userId, api: server.api, crypto: client.service, cipher: nodeSignalBridge, random });
  const secret = await sync.enableBackup(deps(alice));
  assert.equal(history.parseSecret(history.formatSecret(secret).toLowerCase()), secret);
  assert.ok(await sync.runBackup(deps(alice)) >= 1);
  assert.equal(await sync.runBackup(deps(alice)), 0, 'nothing new: nothing written');
  for (const value of server.seen) {
    for (const { text } of sent) assert.equal(value.includes(text), false);
    assert.equal(value.includes(secret), false, 'the secret never goes to the server');
  }
  // Wrong secret: caught on the device (typo), or by the key check (another valid secret).
  await assert.rejects(sync.restoreBackup(deps(phone), secret.slice(0, 35) + (secret[35] === 'A' ? 'B' : 'A')), /с ошибкой/);
  const other = history.newBackupSecret(random);
  await assert.rejects(sync.restoreBackup(deps(phone), other), /не подходит/);
  assert.equal(await sync.restoreBackup(deps(phone), history.formatSecret(secret)), 3);
  for (const { message, text } of sent) assert.equal((await phone.service.preview(structuredClone(message))).text, text);
  // Secret shared with another own device through a sealed note.
  server.api.devices = [alice.service.deviceId, phone.service.deviceId];
  await sync.runBackup(deps(alice));
  await phone.service.storeLocal('history:v1', '{}');
  assert.equal(await sync.currentSecret(deps(phone)), secret);
});

test('backup secret: format, check characters, confusable letters, key derivation bound to the account', () => {
  const secret = history.newBackupSecret(random);
  assert.match(secret, /^[0-9A-HJKMNP-TV-Z]{36}$/);
  assert.equal(history.formatSecret(secret).split(' ').length, 9);
  assert.equal(history.parseSecret(history.secretQr(secret)), secret);
  assert.equal(history.parseSecret(secret.replace(/0/g, 'o').replace(/1/g, 'l')), secret);
  assert.equal(history.parseSecret(secret.slice(1)), null);
  const salt = randomBytes(32).toString('base64'), user = randomUUID();
  const a = history.backupKeys(secret, salt, user), b = history.backupKeys(secret, salt, randomUUID()), c = history.backupKeys(secret, randomBytes(32).toString('base64'), user);
  assert.notEqual(a.key, a.keyCheck);
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.key, c.key);
  assert.equal(Buffer.from(a.key, 'base64').length, 32);
});
