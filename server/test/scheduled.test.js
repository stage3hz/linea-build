import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { createPush } from '../src/push.js';
import { parseDeliverAt } from '../src/e2ee.js';
import { syntheticEnvelope, syntheticPublicBundle } from './support/relay-fixtures.js';

// F4 «Отправить без звука» / «Отправить позже». Synthetic envelopes only: this is a relay test, the
// server stores and releases opaque ciphertext and never decrypts anything.
const IOS_TOKEN = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
const MINUTE = 60_000;

async function request(app, method, url, account, payload) {
  return app.inject({ method, url, headers: account ? { authorization: `Bearer ${account.token}` } : {}, ...(payload === undefined ? {} : { payload }) });
}
async function register(app, username) {
  const response = await request(app, 'POST', '/auth/register', null, { username, displayName: username, password: 'correct-horse-42', recoveryWord: 'SilverHarborLantern', confirmationWord: 'AmberGardenPrism' });
  assert.equal(response.statusCode, 201, response.body);
  const account = response.json();
  const registered = await request(app, 'POST', '/e2ee/devices', account, syntheticPublicBundle());
  assert.equal(registered.statusCode, 200, registered.body);
  account.device = registered.json().device;
  return account;
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-scheduled-'));
  let time = Date.parse('2026-11-08T10:00:00.000Z');
  const clock = { now: () => time, advance: ms => { time += ms; } };
  const instances = [];
  const open = async overrides => { const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, now: clock.now, ...options, ...overrides }); instances.push(app); return app; };
  const app = await open();
  t.after(async () => { for (const instance of instances.reverse()) await instance.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
  const alice = await register(app, 'alice_f4'), bob = await register(app, 'bob_f4');
  const chat = (await request(app, 'POST', '/chats', alice, { userId: bob.user.id })).json().chat;
  const send = (from, to, clientId, extra = {}) => request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, from, { clientId, encrypted: syntheticEnvelope(from.device, [to.device]), ...extra });
  const unread = async who => (await request(app, 'GET', '/chats', who)).json().chats[0].unreadCount;
  const page = async who => (await request(app, 'GET', `/chats/${chat.id}/messages?lean=1`, who)).json().messages;
  const list = async (who, query = '') => { const r = await request(app, 'GET', `/scheduled${query}`, who); assert.equal(r.statusCode, 200, r.body); return r.json().items; };
  const iso = ms => new Date(ms).toISOString();
  return { app, open, instances, dataDir, clock, alice, bob, chat, send, unread, page, list, iso };
}
const sql = (dataDir, work) => { const db = new DatabaseSync(join(dataDir, 'linea.sqlite')); try { return work(db); } finally { db.close(); } };

test('F4: parseDeliverAt accepts only a zoned ISO time ahead of now, at most a year', () => {
  const now = Date.parse('2026-11-08T10:00:00Z');
  assert.equal(parseDeliverAt('2026-11-08T12:00:00.000Z', now), Date.parse('2026-11-08T12:00:00Z'));
  assert.equal(parseDeliverAt('2026-11-08T15:00+03:00', now), Date.parse('2026-11-08T12:00:00Z'));
  assert.throws(() => parseDeliverAt('2026-11-08T09:00:00Z', now), /уже прошло/);
  assert.throws(() => parseDeliverAt(now + 60_000, now), /Некорректное время/, 'a number is not a time');
  assert.throws(() => parseDeliverAt('2026-11-08 12:00', now), /Некорректное время/, 'no zone');
  assert.throws(() => parseDeliverAt('2028-01-01T00:00:00Z', now), /не больше чем на год/);
});

test('F4: «Отправить без звука» is a normal unread message; only its push is quiet', async t => {
  const sent = [];
  const push = createPush({ ios: async (token, message) => { sent.push(message); return 'ok'; } });
  const { app, alice, bob, send, unread } = await fixture(t, { push });
  assert.equal((await request(app, 'PUT', '/me/push', bob, { token: IOS_TOKEN, platform: 'ios' })).statusCode, 200);
  const quiet = await send(alice, bob, 'client-silent-00001', { push: 'silent' });
  assert.equal(quiet.statusCode, 201, quiet.body);
  assert.equal(quiet.json().message.silent, undefined, 'nothing about the push leaks into the message');
  assert.equal(await unread(bob), 1, 'a silent message is still news for the peer (unlike push:none)');
  const loud = await send(alice, bob, 'client-loud-000001');
  assert.equal(loud.statusCode, 201, loud.body);
  assert.equal(await unread(bob), 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 2, 'both pushes went out');
  assert.equal(sent[0].apns.payload.aps.sound, undefined, 'the silent push has no sound');
  assert.equal(sent[0].apns.payload.aps['interruption-level'], 'passive');
  assert.equal(sent[0].apns.payload.aps.alert.body, 'Новое сообщение', 'but it is a visible notification');
  assert.equal(sent[0].apns.payload.kind, 'silent');
  assert.equal(sent[0].android.notification.channel_id, 'silent');
  assert.equal(sent[0].android.notification.sound, undefined);
  assert.equal(sent[1].apns.payload.aps.sound, 'default', 'the ordinary push rings');
  assert.equal(sent[1].apns.payload.aps.badge, 2, 'the badge counts the silent message too');
});

test('F4: a scheduled message waits in its own table and reaches the chat only when its time comes', async t => {
  const sent = [];
  const push = createPush({ ios: async (token, message) => { sent.push(message); return 'ok'; } });
  const { app, dataDir, clock, alice, bob, chat, send, unread, page, list, iso } = await fixture(t, { push });
  assert.equal((await request(app, 'PUT', '/me/push', bob, { token: IOS_TOKEN, platform: 'ios' })).statusCode, 200);
  const deliverAt = iso(clock.now() + 30 * MINUTE);
  const response = await send(alice, bob, 'client-later-000001', { deliverAt, push: 'silent' });
  assert.equal(response.statusCode, 202, response.body);
  const item = response.json().scheduled;
  assert.equal(item.status, 'scheduled'); assert.equal(item.deliverAt, deliverAt); assert.equal(item.push, 'silent'); assert.equal(item.chatId, chat.id);
  assert.equal(item.clientId, 'client-later-000001');
  assert.ok(item.encrypted?.envelopes?.length, 'the sender gets its envelopes back (to recognise the item in its vault)');
  // Nothing happened in the chat yet: no message, no unread, no push, no bump of the chat.
  assert.deepEqual(await page(bob), []);
  assert.equal(await unread(bob), 0);
  assert.equal(sent.length, 0);
  assert.equal(sql(dataDir, db => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n), 0, 'the envelopes are not in messages');
  assert.equal(sql(dataDir, db => db.prepare('SELECT encrypted_json FROM scheduled_messages').get().encrypted_json.includes('"body"')), true, 'stored as the same ciphertext envelopes');
  // Idempotent: the same clientId with the same envelopes answers the same item; different content is refused.
  const again = await request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, alice, { clientId: 'client-later-000001', encrypted: item.encrypted, deliverAt });
  assert.equal(again.statusCode, 202, again.body); assert.equal(again.json().scheduled.id, item.id);
  const other = await send(alice, bob, 'client-later-000001', { deliverAt });
  assert.equal(other.statusCode, 409, other.body);
  // The list is the owner's only; Bob sees nothing about it.
  assert.deepEqual((await list(alice)).map(x => x.id), [item.id]);
  assert.deepEqual((await list(alice, `?chatId=${chat.id}`)).map(x => x.id), [item.id]);
  assert.deepEqual(await list(bob), []);
  assert.equal((await request(app, 'DELETE', `/scheduled/${item.id}`, bob)).statusCode, 404, 'not Bob\'s to delete');
  assert.equal((await request(app, 'POST', `/scheduled/${item.id}/send`, bob)).statusCode, 404);
  // Not yet due: still nothing after an on-demand check.
  clock.advance(29 * MINUTE);
  assert.equal((await list(alice)).length, 1);
  assert.deepEqual(await page(bob), []);
  // Due: the on-demand check on the list request releases it into the chat as a normal message.
  clock.advance(2 * MINUTE);
  assert.deepEqual(await list(alice), [], 'released items leave the list');
  const messages = await page(bob);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].clientId, 'client-later-000001');
  assert.equal(messages[0].senderId, alice.user.id);
  assert.equal(messages[0].createdAt, iso(clock.now()), 'the row is dated at release time (the server clock)');
  assert.equal(await unread(bob), 1, 'now it is unread');
  assert.equal(sql(dataDir, db => db.prepare('SELECT silent FROM messages').get().silent), 0, 'a silent-push message is not a silent action');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1, 'the push went out at release');
  assert.equal(sent[0].apns.payload.aps.sound, undefined, 'and it kept the «без звука» choice');
  assert.equal(sent[0].apns.payload.aps.badge, 1);
  const chats = (await request(app, 'GET', '/chats', alice)).json().chats;
  assert.equal(chats[0].lastMessage.clientId, 'client-later-000001');
  assert.equal(chats[0].updatedAt, iso(clock.now()), 'the chat moved to the top at release');
});

test('F4: validation — the past, a year ahead, a reaction, an unknown chat, the limit', async t => {
  const { app, clock, alice, bob, chat, send, iso } = await fixture(t);
  const past = await send(alice, bob, 'client-past-0000001', { deliverAt: iso(clock.now() - MINUTE) });
  assert.equal(past.statusCode, 400); assert.equal(past.json().code, 'SCHEDULE_IN_PAST');
  assert.equal((await send(alice, bob, 'client-far-00000001', { deliverAt: iso(clock.now() + 400 * 86_400_000) })).statusCode, 400);
  assert.equal((await send(alice, bob, 'client-bad-00000001', { deliverAt: 'tomorrow' })).statusCode, 400);
  assert.equal((await send(alice, bob, 'client-none-0000001', { deliverAt: iso(clock.now() + MINUTE), push: 'none' })).statusCode, 400, 'reactions and edits are not scheduled');
  // The envelopes are checked against today's device set at scheduling time, like a normal send.
  const wrong = await request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, alice, { clientId: 'client-wrong-000001', encrypted: syntheticEnvelope(alice.device, [alice.device]), deliverAt: iso(clock.now() + MINUTE) });
  assert.equal(wrong.statusCode, 409); assert.equal(wrong.json().code, 'E2EE_DEVICES_CHANGED');
  assert.equal((await request(app, 'POST', '/chats/00000000-0000-4000-8000-000000000000/messages', alice, { clientId: 'client-nochat-00001', encrypted: syntheticEnvelope(alice.device, [bob.device]), deliverAt: iso(clock.now() + MINUTE) })).statusCode, 404);
  for (let index = 0; index < 100; index++) assert.equal((await send(alice, bob, `client-many-${String(index).padStart(6, '0')}`, { deliverAt: iso(clock.now() + 2 * MINUTE) })).statusCode, 202);
  const over = await send(alice, bob, 'client-many-overflow', { deliverAt: iso(clock.now() + 2 * MINUTE) });
  assert.equal(over.statusCode, 409); assert.equal(over.json().code, 'SCHEDULE_LIMIT');
});

test('F4: «Отправить сейчас» releases at once; «Удалить» drops it for good', async t => {
  const { app, alice, bob, clock, send, unread, page, list, iso } = await fixture(t);
  const first = (await send(alice, bob, 'client-now-00000001', { deliverAt: iso(clock.now() + 60 * MINUTE) })).json().scheduled;
  const second = (await send(alice, bob, 'client-drop-0000001', { deliverAt: iso(clock.now() + 60 * MINUTE) })).json().scheduled;
  const now = await request(app, 'POST', `/scheduled/${first.id}/send?lean=1`, alice);
  assert.equal(now.statusCode, 201, now.body);
  assert.equal(now.json().message.clientId, 'client-now-00000001');
  assert.equal(now.json().message.encrypted, undefined, 'lean: the sender has its ciphertext');
  assert.deepEqual((await page(bob)).map(m => m.clientId), ['client-now-00000001']);
  assert.equal(await unread(bob), 1);
  assert.equal((await request(app, 'POST', `/scheduled/${first.id}/send`, alice)).statusCode, 404, 'gone once sent');
  assert.equal((await request(app, 'DELETE', `/scheduled/${second.id}`, alice)).statusCode, 200);
  assert.deepEqual(await list(alice), []);
  clock.advance(120 * MINUTE);
  assert.deepEqual((await page(bob)).map(m => m.clientId), ['client-now-00000001'], 'the deleted one never arrives');
});

test('F4: the peer added a device meanwhile → «не удалось», nothing is delivered, the sender re-encrypts', async t => {
  const { app, alice, bob, clock, send, page, list, iso } = await fixture(t);
  const item = (await send(alice, bob, 'client-stale-000001', { deliverAt: iso(clock.now() + 10 * MINUTE) })).json().scheduled;
  // Bob signs in on a second phone (a fresh session with its own encryption device).
  const login = await request(app, 'POST', '/auth/login', null, { username: 'bob_f4', password: 'correct-horse-42', confirmationWord: 'AmberGardenPrism' });
  assert.equal(login.statusCode, 200, login.body);
  const bobPhone2 = login.json();
  assert.equal((await request(app, 'POST', '/e2ee/devices', bobPhone2, syntheticPublicBundle())).statusCode, 200);
  clock.advance(11 * MINUTE);
  const items = await list(alice);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'failed'); assert.equal(items[0].failure, 'E2EE_DEVICES_CHANGED');
  assert.deepEqual(await page(bob), [], 'stale envelopes are never delivered');
  // «Отправить сейчас» on a failed item: the server cannot help (only the sender's device can encrypt).
  const retry = await request(app, 'POST', `/scheduled/${item.id}/send`, alice);
  assert.equal(retry.statusCode, 409); assert.equal(retry.json().code, 'E2EE_DEVICES_CHANGED');
  // The app re-encrypts for the three devices and sends through the normal route, then drops the failed row.
  const devices = (await request(app, 'GET', `/e2ee/devices?userId=${bob.user.id}`, alice)).json().devices;
  assert.equal(devices.length, 2);
  const resent = await request(app, 'POST', `/chats/${items[0].chatId}/messages?lean=1`, alice, { clientId: 'client-stale-000001', encrypted: syntheticEnvelope(alice.device, devices) });
  assert.equal(resent.statusCode, 201, resent.body);
  assert.equal((await request(app, 'DELETE', `/scheduled/${item.id}`, alice)).statusCode, 200);
  assert.deepEqual((await page(bob)).map(m => m.clientId), ['client-stale-000001']);
  assert.deepEqual(await list(alice), []);
});

test('F4: the housekeeping tick and a server restart release what is due', async t => {
  const { app, open, instances, alice, bob, clock, send, page, iso } = await fixture(t, { maintenanceIntervalMs: 15 });
  assert.equal((await send(alice, bob, 'client-tick-0000001', { deliverAt: iso(clock.now() + 5 * MINUTE) })).statusCode, 202);
  assert.equal((await send(alice, bob, 'client-boot-0000001', { deliverAt: iso(clock.now() + 60 * MINUTE) })).statusCode, 202);
  clock.advance(6 * MINUTE);
  for (let waited = 0; waited < 50 && (await page(bob)).length === 0; waited++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual((await page(bob)).map(m => m.clientId), ['client-tick-0000001'], 'the tick released the first one');
  // The server is down while the second one comes due: it goes out at startup.
  await app.close(); instances.pop();
  clock.advance(60 * MINUTE);
  const restarted = await open();
  const messages = (await request(restarted, 'GET', `/chats/${(await request(restarted, 'GET', '/chats', bob)).json().chats[0].id}/messages?lean=1`, bob)).json().messages;
  assert.deepEqual(messages.map(m => m.clientId), ['client-tick-0000001', 'client-boot-0000001']);
  assert.deepEqual((await request(restarted, 'GET', '/scheduled', alice)).json().items, []);
});

test('F4: an existing database gets the scheduled table; the migration is idempotent', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-scheduled-migrate-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const old = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, client_id TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '', attachment_id TEXT UNIQUE, encrypted_json TEXT, created_at TEXT NOT NULL, UNIQUE(sender_id, client_id))`);
  old.exec('PRAGMA user_version=5');
  old.close();
  let time = Date.now();
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, now: () => time });
  t.after(async () => { await app.close().catch(() => {}); });
  assert.equal(sql(dataDir, db => db.prepare('PRAGMA user_version').get().user_version), 5, 'user_version is never changed');
  assert.deepEqual(sql(dataDir, db => db.prepare('PRAGMA table_info(scheduled_messages)').all().map(c => c.name)), ['id', 'owner_id', 'chat_id', 'client_id', 'encrypted_json', 'push', 'deliver_at', 'status', 'failure', 'created_at', 'failed_at']);
  const alice = await register(app, 'alice_m4'), bob = await register(app, 'bob_m4');
  const chat = (await request(app, 'POST', '/chats', alice, { userId: bob.user.id })).json().chat;
  const response = await request(app, 'POST', `/chats/${chat.id}/messages`, alice, { clientId: 'client-later-000001', encrypted: syntheticEnvelope(alice.device, [bob.device]), deliverAt: new Date(time + MINUTE).toISOString() });
  assert.equal(response.statusCode, 202, response.body);
  await app.close();
  time += 2 * MINUTE;
  const again = await buildApp({ dataDir, logger: false, authRateLimit: 1000, now: () => time });
  t.after(async () => { await again.close().catch(() => {}); });
  assert.equal((await request(again, 'GET', '/chats', bob)).json().chats[0].unreadCount, 1, 'released at the second start');
});

// ---- after the review: the lane flag, attachments, limits, cluster, failures ----
async function uploadEncrypted(app, account, content = randomBytes(64)) {
  const boundary = `synthetic-${randomUUID()}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const response = await app.inject({ method: 'POST', url: '/e2ee/files', headers: { authorization: `Bearer ${account.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}
const uploadRow = (dataDir, id) => sql(dataDir, db => db.prepare('SELECT id FROM uploads WHERE id=?').get(id));
const fileExists = (dataDir, id) => access(join(dataDir, 'uploads', id)).then(() => true, () => false);

test('F4: the lane flag of a scheduled envelope passes through untouched; ?lean=1 leaves the ciphertext out', async t => {
  const { app, alice, bob, chat, clock, list, iso } = await fixture(t);
  const laned = { ...syntheticEnvelope(alice.device, [bob.device]), lane: 'scheduled' };
  const response = await request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, alice, { clientId: 'client-lane-0000001', encrypted: laned, deliverAt: iso(clock.now() + 5 * MINUTE) });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().scheduled.encrypted.lane, 'scheduled');
  const bad = await request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, alice, { clientId: 'client-lane-0000002', encrypted: { ...laned, lane: 'other' }, deliverAt: iso(clock.now() + 5 * MINUTE) });
  assert.equal(bad.statusCode, 400);
  const full = await list(alice); assert.equal(full[0].encrypted.lane, 'scheduled');
  const lean = await list(alice, '?lean=1'); assert.equal('encrypted' in lean[0], false, 'lean: ids, times and states only'); assert.equal(lean[0].status, 'scheduled');
  clock.advance(6 * MINUTE);
  assert.deepEqual(await list(alice, '?lean=1'), []);
  const inbox = (await request(app, 'GET', `/e2ee/inbox?deviceId=${bob.device.id}&chatId=${chat.id}&after=0&limit=10`, bob)).json().messages;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].encrypted.lane, 'scheduled', 'the recipient learns which session opens it');
  // An ordinary message may carry the lane too (e.g. «Отправить сейчас» re-sent envelopes): it is just passed through.
  const now = await request(app, 'POST', `/chats/${chat.id}/messages`, alice, { clientId: 'client-lane-0000003', encrypted: { ...syntheticEnvelope(alice.device, [bob.device]), lane: 'scheduled' } });
  assert.equal(now.statusCode, 201, now.body); assert.equal(now.json().message.encrypted.lane, 'scheduled');
});

test('F4: attachments leave with a deleted or failed item, stay for a device-set retry, go with the chat', async t => {
  const { app, dataDir, alice, bob, chat, clock, list, iso } = await fixture(t);
  const schedule = async (clientId, uploadId, minutes = 60, targets = [bob.device]) => {
    const response = await request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, alice, { clientId, encrypted: syntheticEnvelope(alice.device, targets, [uploadId]), deliverAt: iso(clock.now() + minutes * MINUTE) });
    assert.equal(response.statusCode, 202, response.body); return response.json().scheduled;
  };
  // «Удалить»: the file is going nowhere any more.
  const dropped = await uploadEncrypted(app, alice);
  const item = await schedule('client-att-drop-001', dropped);
  assert.equal((await request(app, 'DELETE', `/scheduled/${item.id}`, alice)).statusCode, 200);
  assert.equal(uploadRow(dataDir, dropped), undefined); assert.equal(await fileExists(dataDir, dropped), false);
  // «не удалось» for good (blocked): the file goes too.
  const blocked = await uploadEncrypted(app, alice);
  await schedule('client-att-block-01', blocked, 5);
  assert.equal((await request(app, 'PUT', `/blocks/${alice.user.id}`, bob)).statusCode, 200);
  clock.advance(6 * MINUTE);
  const failed = await list(alice); assert.equal(failed[0].failure, 'BLOCKED');
  assert.equal(uploadRow(dataDir, blocked), undefined); assert.equal(await fileExists(dataDir, blocked), false);
  assert.equal((await request(app, 'DELETE', `/blocks/${alice.user.id}`, bob)).statusCode, 200);
  assert.equal((await request(app, 'DELETE', `/scheduled/${failed[0].id}`, alice)).statusCode, 200);
  // The peer's devices changed: the app re-encrypts the same text with the same attachment, so it stays.
  const kept = await uploadEncrypted(app, alice);
  const stale = await schedule('client-att-keep-001', kept, 5);
  const login = await request(app, 'POST', '/auth/login', null, { username: 'bob_f4', password: 'correct-horse-42', confirmationWord: 'AmberGardenPrism' });
  assert.equal((await request(app, 'POST', '/e2ee/devices', login.json(), syntheticPublicBundle())).statusCode, 200);
  clock.advance(6 * MINUTE);
  assert.equal((await list(alice))[0].failure, 'E2EE_DEVICES_CHANGED');
  assert.ok(uploadRow(dataDir, kept)); assert.equal(await fileExists(dataDir, kept), true);
  assert.equal((await request(app, 'DELETE', `/scheduled/${stale.id}`, alice)).statusCode, 200, 'the app drops the stale row before re-sending');
  assert.ok(uploadRow(dataDir, kept), 'and the attachment is still there for the re-sent message');
  const devices = (await request(app, 'GET', `/e2ee/devices?userId=${bob.user.id}`, alice)).json().devices;
  assert.equal((await request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, alice, { clientId: 'client-att-keep-001', encrypted: syntheticEnvelope(alice.device, devices, [kept]) })).statusCode, 201);
  // «Удалить у меня и у собеседника»: the chat's scheduled messages and their files disappear with it.
  const withChat = await uploadEncrypted(app, alice);
  await schedule('client-att-chat-001', withChat, 60, devices);
  assert.equal((await request(app, 'DELETE', `/chats/${chat.id}`, alice)).statusCode, 200);
  assert.equal(sql(dataDir, db => db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').get().n), 0);
  assert.equal(uploadRow(dataDir, withChat), undefined); assert.equal(await fileExists(dataDir, withChat), false);
});

test('F4: the limit counts only waiting items; old failed rows are purged; own devices may be a subset', async t => {
  const { app, dataDir, alice, bob, clock, send, list, iso } = await fixture(t);
  for (let index = 0; index < 100; index++) assert.equal((await send(alice, bob, `client-cnt-${String(index).padStart(7, '0')}`, { deliverAt: iso(clock.now() + 60 * MINUTE) })).statusCode, 202);
  assert.equal((await send(alice, bob, 'client-cnt-overflow', { deliverAt: iso(clock.now() + 60 * MINUTE) })).json().code, 'SCHEDULE_LIMIT');
  sql(dataDir, db => db.prepare("UPDATE scheduled_messages SET status='failed',failure='BLOCKED' WHERE client_id<'client-cnt-0000050'").run());
  assert.equal((await send(alice, bob, 'client-cnt-after-fail', { deliverAt: iso(clock.now() + 60 * MINUTE) })).statusCode, 202, '«не удалось» rows do not count');
  assert.equal((await list(alice, '?lean=1')).length, 101);
  // Failed rows are purged a month after they failed (failed_at), not after their delivery time.
  sql(dataDir, db => db.prepare("UPDATE scheduled_messages SET failed_at=? WHERE status='failed'").run(clock.now() - 29 * 86_400_000));
  assert.equal((await list(alice, '?lean=1')).length, 101, 'failed 29 days ago: still listed');
  sql(dataDir, db => db.prepare("UPDATE scheduled_messages SET failed_at=? WHERE status='failed'").run(clock.now() - 31 * 86_400_000));
  assert.equal((await list(alice, '?lean=1')).length, 51);
  // The sender signs in on another phone after scheduling: the envelopes (without that phone) are still delivered.
  const login = await request(app, 'POST', '/auth/login', null, { username: 'alice_f4', password: 'correct-horse-42', confirmationWord: 'AmberGardenPrism' });
  assert.equal((await request(app, 'POST', '/e2ee/devices', login.json(), syntheticPublicBundle())).statusCode, 200);
  clock.advance(61 * MINUTE);
  assert.deepEqual(await list(alice), []);
  assert.equal(sql(dataDir, db => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n), 51);
});

test('F4: a replica never releases (writable hook); a row that cannot be released is marked failed, not retried in a loop', async t => {
  let leader = false;
  const { app, dataDir, alice, bob, clock, send, page, list, iso } = await fixture(t, { writable: () => leader });
  assert.equal((await send(alice, bob, 'client-repl-000001', { deliverAt: iso(clock.now() + 5 * MINUTE) })).statusCode, 202);
  assert.equal((await send(alice, bob, 'client-broken-00001', { deliverAt: iso(clock.now() + 5 * MINUTE) })).statusCode, 202);
  clock.advance(6 * MINUTE);
  assert.equal((await list(alice, '?lean=1')).filter(item => item.status === 'scheduled').length, 2, 'not the primary: nothing moves');
  assert.deepEqual(await page(bob), []);
  sql(dataDir, db => db.prepare("UPDATE scheduled_messages SET encrypted_json='not json' WHERE client_id='client-broken-00001'").run());
  leader = true;
  const items = await list(alice, '?lean=1');
  assert.deepEqual(items.map(item => [item.clientId, item.status, item.failure]), [['client-broken-00001', 'failed', 'RELEASE_ERROR']]);
  assert.deepEqual((await page(bob)).map(m => m.clientId), ['client-repl-000001']);
});

test('F4: deleting an account takes the scheduled rows of its chats with it — the peer\'s too — and their files', async t => {
  const { app, dataDir, alice, bob, chat, clock, iso } = await fixture(t);
  const own = await uploadEncrypted(app, alice), peers = await uploadEncrypted(app, bob);
  const at = iso(clock.now() + 60 * MINUTE);
  assert.equal((await request(app, 'POST', `/chats/${chat.id}/messages`, alice, { clientId: 'client-acct-alice01', encrypted: syntheticEnvelope(alice.device, [bob.device], [own]), deliverAt: at })).statusCode, 202);
  assert.equal((await request(app, 'POST', `/chats/${chat.id}/messages`, bob, { clientId: 'client-acct-bob0001', encrypted: syntheticEnvelope(bob.device, [alice.device], [peers]), deliverAt: at })).statusCode, 202);
  const removed = await request(app, 'POST', '/auth/delete-account', alice, { currentPassword: 'correct-horse-42', currentConfirmationWord: 'AmberGardenPrism' });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(sql(dataDir, db => db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').get().n), 0, 'Bob\'s message to a deleted account is gone too');
  for (const id of [own, peers]) { assert.equal(uploadRow(dataDir, id), undefined); assert.equal(await fileExists(dataDir, id), false); }
  assert.deepEqual((await request(app, 'GET', '/scheduled', bob)).json().items, []);
});

test('F4: «не удалось» rows are capped per owner; the oldest failed go first with their files', async t => {
  const { app, dataDir, alice, bob, chat, clock, send, list, iso } = await fixture(t);
  for (let index = 0; index < 100; index++) assert.equal((await send(alice, bob, `client-cap-${String(index).padStart(7, '0')}`, { deliverAt: iso(clock.now() + 60 * MINUTE) })).statusCode, 202);
  sql(dataDir, db => db.prepare("UPDATE scheduled_messages SET status='failed',failure='BLOCKED',failed_at=?").run(clock.now() - 86_400_000));
  const file = await uploadEncrypted(app, alice);
  sql(dataDir, db => db.prepare("UPDATE scheduled_messages SET encrypted_json=json_set(encrypted_json,'$.attachmentIds',json_array(?)),failed_at=? WHERE client_id='client-cap-0000000'").run(file, clock.now() - 2 * 86_400_000));
  // One more fails now (the peer blocks): 101 failed → the oldest one (with its file) is dropped.
  assert.equal((await request(app, 'POST', `/chats/${chat.id}/messages`, alice, { clientId: 'client-cap-newest01', encrypted: syntheticEnvelope(alice.device, [bob.device]), deliverAt: iso(clock.now() + 5 * MINUTE) })).statusCode, 202);
  assert.equal((await request(app, 'PUT', `/blocks/${alice.user.id}`, bob)).statusCode, 200);
  clock.advance(6 * MINUTE);
  const items = await list(alice, '?lean=1');
  assert.equal(items.length, 100);
  assert.equal(items.some(item => item.clientId === 'client-cap-0000000'), false, 'the oldest failed row was purged');
  assert.equal(items.some(item => item.clientId === 'client-cap-newest01'), true);
  assert.equal(uploadRow(dataDir, file), undefined); assert.equal(await fileExists(dataDir, file), false);
});

test('F4: a scheduled table from the first build gets failed_at; already failed rows start their 30 days now', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-scheduled-failedat-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const first = await buildApp({ dataDir, logger: false, authRateLimit: 1000 });
  await first.close();
  sql(dataDir, db => { db.exec('DROP TABLE scheduled_messages'); db.exec(`CREATE TABLE scheduled_messages (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL, client_id TEXT NOT NULL,
    encrypted_json TEXT NOT NULL, push TEXT NOT NULL DEFAULT 'message', deliver_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', failure TEXT, created_at TEXT NOT NULL, UNIQUE(owner_id, client_id))`);
    db.prepare("INSERT INTO scheduled_messages VALUES('x','u','c','client-old-failed1','{}','message',1,'failed','BLOCKED','2026-01-01')").run(); });
  const before = Date.now();
  const again = await buildApp({ dataDir, logger: false, authRateLimit: 1000 });
  t.after(async () => { await again.close().catch(() => {}); });
  const row = sql(dataDir, db => db.prepare('SELECT failed_at FROM scheduled_messages WHERE id=?').get('x'));
  assert.ok(row.failed_at >= before, 'not purged at once for its old deliver_at');
  assert.equal(sql(dataDir, db => db.prepare('PRAGMA user_version').get().user_version), 5);
});
