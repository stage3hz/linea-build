import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { TRANSFER_WAIT_MS, TRANSFER_TTL_MS, RESTORE_ATTEMPTS, MAX_PAGE_BYTES } from '../src/history.js';

// Old chats on a new device (history.js). The server only relays ciphertext between the account's own
// devices: the bytes here are synthetic; what is checked is who may write, read, when, and how long.
const PASSWORD = 'Synthetic!Orchid.87.Wind';
const CONFIRMATION = 'корабль';
const RECOVERY = 'астра';
const key33 = () => Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString('base64');
const bundle = () => ({
  deviceId: randomUUID(), deviceName: 'Synthetic test device', registrationId: 1234, identityKey: key33(),
  signedPreKey: { id: 100, publicKey: key33(), signature: randomBytes(64).toString('base64') },
  kyberPreKey: { id: 200, publicKey: randomBytes(1569).toString('base64'), signature: randomBytes(64).toString('base64') },
  preKeys: [{ id: 1, publicKey: key33() }],
});
const page = (bytes = 200) => randomBytes(bytes).toString('base64');
const note = deviceId => ({ senderDeviceId: deviceId, type: 2, body: randomBytes(120).toString('base64') });

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-history-test-'));
  let time = Date.parse('2026-11-22T10:00:00.000Z');
  const app = await buildApp({ dataDir, now: () => time, authRateLimit: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, dataDir, advance: ms => { time += ms; } };
}
const call = (app, method, url, account, payload) => app.inject({ method, url, ...(account ? { headers: { authorization: `Bearer ${account.token}` } } : {}), ...(payload === undefined ? {} : { payload }) });
async function register(app, username) {
  const result = await call(app, 'POST', '/auth/register', null, { username, displayName: username, password: PASSWORD, confirmationWord: CONFIRMATION, recoveryWord: RECOVERY });
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}
async function login(app, username) {
  const result = await call(app, 'POST', '/auth/login', null, { username, password: PASSWORD, confirmationWord: CONFIRMATION });
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}
async function device(app, account) {
  const response = await call(app, 'POST', '/e2ee/devices', account, bundle());
  assert.equal(response.statusCode, 200, response.body);
  return response.json().device;
}
async function twoDevices(t) {
  const world = await fixture(t);
  const old = await register(world.app, 'alice_history');
  const oldDevice = await device(world.app, old);
  world.advance(60_000);
  const fresh = await login(world.app, 'alice_history');
  const freshDevice = await device(world.app, fresh);
  return { ...world, old, oldDevice, fresh, freshDevice };
}

test('variant A: a copy waits 10 minutes, goes to exactly the new device, and is deleted after the acknowledgement', async t => {
  const { app, dataDir, advance, old, oldDevice, fresh, freshDevice } = await twoDevices(t);
  // The old device has nobody older to ask.
  assert.equal((await call(app, 'POST', '/history/transfers', old, { deviceId: oldDevice.id })).statusCode, 409);
  // A device id of another session is refused.
  assert.equal((await call(app, 'POST', '/history/transfers', fresh, { deviceId: oldDevice.id })).statusCode, 403);
  const asked = await call(app, 'POST', '/history/transfers', fresh, { deviceId: freshDevice.id });
  assert.equal(asked.statusCode, 200, asked.body);
  const transfer = asked.json().transfer;
  assert.equal(transfer.state, 'waiting');
  assert.equal(transfer.ready, false);
  // Asking again gives the same request.
  assert.equal((await call(app, 'POST', '/history/transfers', fresh, { deviceId: freshDevice.id })).json().transfer.id, transfer.id);

  const outgoing = (await call(app, 'GET', `/history/transfers/outgoing?deviceId=${oldDevice.id}`, old)).json().transfers;
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].target.identityKey, freshDevice.identityKey);
  // The new device cannot answer its own request, nor see it as outgoing.
  assert.equal((await call(app, 'GET', `/history/transfers/outgoing?deviceId=${freshDevice.id}`, fresh)).json().transfers.length, 0);
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/claim`, fresh, { deviceId: freshDevice.id })).statusCode, 403);

  // Before the wait: refused by the server, whatever the client thinks.
  const early = await call(app, 'POST', `/history/transfers/${transfer.id}/claim`, old, { deviceId: oldDevice.id });
  assert.equal(early.statusCode, 425);
  assert.equal(early.json().code, 'HISTORY_TOO_EARLY');
  advance(TRANSFER_WAIT_MS - 1);
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/claim`, old, { deviceId: oldDevice.id })).statusCode, 425);
  advance(1);
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/claim`, old, { deviceId: oldDevice.id })).statusCode, 200);

  // Pages in order, within limits.
  const put = (index, body, account = old, deviceId = oldDevice.id) => call(app, 'PUT', `/history/transfers/${transfer.id}/pages/${index}`, account, { deviceId, body });
  assert.equal((await put(1, page())).statusCode, 409);
  assert.equal((await put(0, page())).statusCode, 200);
  assert.equal((await put(0, page())).statusCode, 200, 'the last page may be sent again');
  assert.equal((await put(1, page())).statusCode, 200);
  assert.equal((await put(2, 'not base64!')).statusCode, 400);
  assert.equal((await put(2, randomBytes(MAX_PAGE_BYTES + 1).toString('base64'))).statusCode, 400);
  assert.equal((await put(2, page(), fresh, freshDevice.id)).statusCode, 409, 'only the claiming device writes');
  // The target sees nothing before completion.
  assert.equal((await call(app, 'GET', `/history/transfers/${transfer.id}/pages/0?deviceId=${freshDevice.id}`, fresh)).statusCode, 404);
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/complete`, old, { deviceId: oldDevice.id, note: note(oldDevice.id), pageCount: 3 })).statusCode, 409);
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/complete`, old, { deviceId: oldDevice.id, note: note(freshDevice.id), pageCount: 2 })).statusCode, 400);
  const sealed = note(oldDevice.id);
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/complete`, old, { deviceId: oldDevice.id, note: sealed, pageCount: 2 })).statusCode, 200);

  const incoming = (await call(app, 'GET', `/history/transfers/incoming?deviceId=${freshDevice.id}`, fresh)).json().transfer;
  assert.equal(incoming.state, 'ready');
  assert.deepEqual(incoming.note, sealed);
  assert.equal(incoming.pageCount, 2);
  // The old device cannot read the pages (they are for the target only).
  assert.equal((await call(app, 'GET', `/history/transfers/${transfer.id}/pages/0?deviceId=${oldDevice.id}`, old)).statusCode, 404);
  assert.equal((await call(app, 'GET', `/history/transfers/${transfer.id}/pages/1?deviceId=${freshDevice.id}`, fresh)).statusCode, 200);

  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/ack`, fresh, { deviceId: freshDevice.id })).statusCode, 200);
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history_transfer_pages').get().n, 0); } finally { db.close(); }
  assert.equal((await call(app, 'GET', `/history/transfers/incoming?deviceId=${freshDevice.id}`, fresh)).json().transfer.state, 'done');
});

test('variant A: «Это был не я» (the session ends) drops the transfer; cancel from another device stops it; expiry', async t => {
  const { app, advance, old, oldDevice, fresh, freshDevice } = await twoDevices(t);
  const transfer = (await call(app, 'POST', '/history/transfers', fresh, { deviceId: freshDevice.id })).json().transfer;
  // The target cannot cancel its own copy; another own device can.
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/cancel`, fresh, { deviceId: freshDevice.id })).statusCode, 403);
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/cancel`, old, { deviceId: oldDevice.id })).statusCode, 200);
  advance(TRANSFER_WAIT_MS);
  assert.equal((await call(app, 'POST', `/history/transfers/${transfer.id}/claim`, old, { deviceId: oldDevice.id })).statusCode, 409);

  // A third sign-in, ended from the old device before the wait is over.
  advance(60_000);
  const third = await login(app, 'alice_history');
  const thirdDevice = await device(app, third);
  const next = (await call(app, 'POST', '/history/transfers', third, { deviceId: thirdDevice.id })).json().transfer;
  const sessions = (await call(app, 'GET', '/auth/sessions', old)).json().sessions;
  const stranger = sessions.find(item => !item.current && item.createdAt === sessions.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).createdAt);
  assert.equal((await call(app, 'POST', '/auth/sessions/revoke', old, { sessionId: stranger.id })).statusCode, 200);
  advance(TRANSFER_WAIT_MS);
  assert.equal((await call(app, 'POST', `/history/transfers/${next.id}/claim`, old, { deviceId: oldDevice.id })).statusCode, 404);

  // A request nobody answers is gone after its lifetime.
  advance(60_000);
  const fourth = await login(app, 'alice_history');
  const fourthDevice = await device(app, fourth);
  const late = (await call(app, 'POST', '/history/transfers', fourth, { deviceId: fourthDevice.id })).json().transfer;
  advance(TRANSFER_TTL_MS + 1);
  assert.equal((await call(app, 'GET', `/history/transfers/incoming?deviceId=${fourthDevice.id}`, fourth)).json().transfer, null);
  assert.equal((await call(app, 'POST', `/history/transfers/${late.id}/claim`, old, { deviceId: oldDevice.id })).statusCode, 404);
});

test('variant B: backup log, sealed secret only for devices past the wait, restore limited and only after 10 minutes', async t => {
  const { app, advance, old, oldDevice, fresh, freshDevice } = await twoDevices(t);
  const state = (await call(app, 'GET', `/history/backup?deviceId=${oldDevice.id}`, old)).json();
  assert.equal(state.enabled, false);
  assert.equal(Buffer.from(state.salt, 'base64').length, 32);
  const keyCheck = randomBytes(32).toString('base64');
  assert.equal((await call(app, 'PUT', '/history/backup', old, { deviceId: oldDevice.id, generation: 2, keyCheck })).statusCode, 409);
  assert.equal((await call(app, 'PUT', '/history/backup', old, { deviceId: oldDevice.id, generation: 1, keyCheck: 'short' })).statusCode, 400);
  assert.equal((await call(app, 'PUT', '/history/backup', old, { deviceId: oldDevice.id, generation: 1, keyCheck })).statusCode, 200);
  // The salt stays the one the key check was derived with.
  assert.equal((await call(app, 'GET', `/history/backup?deviceId=${oldDevice.id}`, old)).json().salt, state.salt);

  const append = (account, deviceId, extra = {}) => call(app, 'POST', '/history/backup/pages', account, { deviceId, generation: 1, body: page(), ...extra });
  assert.equal((await append(old, oldDevice.id)).json().index, 0);
  assert.equal((await append(old, oldDevice.id)).json().index, 1);
  const busy = await append(fresh, freshDevice.id);
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, 'BACKUP_WRITER');

  // The new device is not yet «missing» (younger than 10 minutes) and cannot get the secret.
  assert.equal((await call(app, 'GET', `/history/backup?deviceId=${oldDevice.id}`, old)).json().missing.length, 0);
  assert.equal((await call(app, 'POST', '/history/backup/notes', old, { deviceId: oldDevice.id, targetDeviceId: freshDevice.id, generation: 1, note: note(oldDevice.id) })).statusCode, 425);
  // Restore before the wait: refused; pages without a restore: refused.
  assert.equal((await call(app, 'POST', '/history/backup/restore', fresh, { deviceId: freshDevice.id })).statusCode, 425);
  assert.equal((await call(app, 'GET', `/history/backup/pages/0?deviceId=${freshDevice.id}`, fresh)).statusCode, 403);
  advance(TRANSFER_WAIT_MS);
  const missing = (await call(app, 'GET', `/history/backup?deviceId=${oldDevice.id}`, old)).json().missing;
  assert.deepEqual(missing.map(item => item.id), [freshDevice.id]);

  const restore = await call(app, 'POST', '/history/backup/restore', fresh, { deviceId: freshDevice.id });
  assert.equal(restore.statusCode, 200, restore.body);
  assert.equal(restore.json().keyCheck, keyCheck);
  assert.equal(restore.json().salt, state.salt);
  assert.equal(restore.json().pageCount, 2);
  assert.equal((await call(app, 'GET', `/history/backup/pages/1?deviceId=${freshDevice.id}`, fresh)).statusCode, 200);
  for (let attempt = 2; attempt <= RESTORE_ATTEMPTS; attempt++) assert.equal((await call(app, 'POST', '/history/backup/restore', fresh, { deviceId: freshDevice.id })).statusCode, 200);
  const limited = await call(app, 'POST', '/history/backup/restore', fresh, { deviceId: freshDevice.id });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, 'BACKUP_ATTEMPTS');

  // The sealed secret for the new device, now allowed; it is handed only to that device.
  const sealed = note(oldDevice.id);
  assert.equal((await call(app, 'POST', '/history/backup/notes', old, { deviceId: oldDevice.id, targetDeviceId: freshDevice.id, generation: 1, note: sealed })).statusCode, 200);
  assert.deepEqual((await call(app, 'GET', `/history/backup?deviceId=${freshDevice.id}`, fresh)).json().note, sealed);
  assert.equal((await call(app, 'GET', `/history/backup?deviceId=${oldDevice.id}`, old)).json().note, undefined);

  // Turning it off removes every page and note.
  assert.equal((await call(app, 'DELETE', `/history/backup?deviceId=${oldDevice.id}`, old)).statusCode, 200);
  const off = (await call(app, 'GET', `/history/backup?deviceId=${freshDevice.id}`, fresh)).json();
  assert.equal(off.enabled, false);
  assert.equal(off.note, undefined);
  assert.notEqual(off.salt, state.salt);
});
