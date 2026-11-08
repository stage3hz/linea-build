import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { createPush } from '../src/push.js';
import { syntheticEnvelope, syntheticPublicBundle } from './support/relay-fixtures.js';

const IOS_TOKEN = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);

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
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-silent-'));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const alice = await register(app, 'alice_s'), bob = await register(app, 'bob_s');
  const chat = (await request(app, 'POST', '/chats', alice, { userId: bob.user.id })).json().chat;
  const send = async (from, to, clientId, push) => {
    const response = await request(app, 'POST', `/chats/${chat.id}/messages?lean=1`, from, { clientId, encrypted: syntheticEnvelope(from.device, [to.device]), ...(push ? { push } : {}) });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().message;
  };
  const unread = async who => (await request(app, 'GET', '/chats', who)).json().chats[0].unreadCount;
  return { app, dataDir, alice, bob, chat, send, unread };
}

test('B43: a message sent with push:none (a reaction, an edit, a vote) is not unread for the peer', async t => {
  const { app, alice, bob, chat, send, unread } = await fixture(t);
  const first = await send(alice, bob, 'client-message-0001');
  assert.equal(await unread(bob), 1);
  await request(app, 'POST', `/chats/${chat.id}/read`, bob, { messageId: first.id });
  assert.equal(await unread(bob), 0);
  // Alice reacts: the row is there (the peer's app needs it) but the chat does not light up.
  const reaction = await send(alice, bob, 'client-react-00001', 'none');
  assert.equal(await unread(bob), 0, 'a reaction alone');
  assert.equal(reaction.silent, undefined, 'the flag is not exposed in the message');
  const page = (await request(app, 'GET', `/chats/${chat.id}/messages?lean=1`, bob)).json();
  assert.deepEqual(page.messages.map(m => m.id), [first.id, reaction.id], 'the reaction travels like any message');
  // «Reaction + new message»: the count is 1, not 2 — the same as the client's own count.
  await send(alice, bob, 'client-message-0002');
  assert.equal(await unread(bob), 1, 'reaction + message');
  await send(alice, bob, 'client-react-00002', 'none');
  assert.equal(await unread(bob), 1, 'reaction + message + reaction');
  const chats = (await request(app, 'GET', '/chats', alice)).json().chats;
  assert.equal(chats[0].unreadCount, 0, 'the sender has nothing unread');
});

test('B43: pushes and the icon badge skip silent rows too', async t => {
  const sent = [];
  const push = createPush({ ios: async (token, message) => { sent.push(message); return 'ok'; } });
  const { app, alice, bob, send } = await fixture(t, { push });
  assert.equal((await request(app, 'PUT', '/me/push', bob, { token: IOS_TOKEN, platform: 'ios' })).statusCode, 200);
  await send(alice, bob, 'client-message-0001');
  await send(alice, bob, 'client-react-00001', 'none');
  await send(alice, bob, 'client-message-0002');
  await new Promise(resolve => setTimeout(resolve, 20));
  const bodies = sent.map(message => message.apns.payload.aps.alert.body);
  assert.deepEqual(bodies, ['Новое сообщение', '2 новых сообщения'], 'push:none sends nothing; the message after the reaction says 2, not 3');
  assert.deepEqual(sent.map(message => message.apns.payload.aps.badge), [1, 2], 'the icon badge agrees');
});

test('B43: an existing database gets the silent column; old rows count as before', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-silent-migrate-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  // A messages table from before the column, as an older server left it.
  const old = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, client_id TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '', attachment_id TEXT UNIQUE, encrypted_json TEXT, created_at TEXT NOT NULL, UNIQUE(sender_id, client_id))`);
  old.exec('PRAGMA user_version=5');
  old.close();
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000 });
  t.after(async () => { await app.close(); });
  const alice = await register(app, 'alice_m'), bob = await register(app, 'bob_m');
  const chat = (await request(app, 'POST', '/chats', alice, { userId: bob.user.id })).json().chat;
  const response = await request(app, 'POST', `/chats/${chat.id}/messages`, alice, { clientId: 'client-message-0001', encrypted: syntheticEnvelope(alice.device, [bob.device]) });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal((await request(app, 'GET', '/chats', bob)).json().chats[0].unreadCount, 1);
  const silent = await request(app, 'POST', `/chats/${chat.id}/messages`, alice, { clientId: 'client-react-00001', encrypted: syntheticEnvelope(alice.device, [bob.device]), push: 'none' });
  assert.equal(silent.statusCode, 201, silent.body);
  assert.equal((await request(app, 'GET', '/chats', bob)).json().chats[0].unreadCount, 1);
  // The migration is idempotent: a second open changes nothing.
  await app.close();
  const again = await buildApp({ dataDir, logger: false, authRateLimit: 1000 });
  t.after(async () => { await again.close(); });
  assert.equal((await request(again, 'GET', '/chats', bob)).json().chats[0].unreadCount, 1);
});
