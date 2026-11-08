import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { sessionLabel } from '../src/auth.js';

// F6 «Активные сеансы»: each session stores what the app reported about itself (platform, model,
// OS, app build) and the address the sign-in came from (text only); the current session is listed
// first; a new sign-in is announced to the account's other devices, which may end it.

const PASSWORD = 'correct-horse-42';
const RECOVERY_WORD = 'SilverHarborLantern';
const CONFIRMATION_WORD = 'AmberGardenPrism';
const PHONE = { deviceName: 'iPhone', platform: 'ios', deviceModel: 'iPhone 15 Pro', osVersion: 'iOS 18.1', appVersion: '0.14.13' };
const LAPTOP = { deviceName: 'Windows', platform: 'windows', deviceModel: 'Windows PC', osVersion: 'Windows 11', appVersion: '0.14.12' };

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-f6-test-'));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, ...options });
  await app.ready();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, dataDir };
}

function readDatabase(dataDir, read) {
  const database = new DatabaseSync(path.join(dataDir, 'linea.sqlite'));
  try { return read(database); } finally { database.close(); }
}

const request = (app, method, url, account, payload, headers = {}) =>
  app.inject({ method, url, headers: { ...(account ? { authorization: `Bearer ${account.token}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });

async function register(app, username, device = PHONE, headers) {
  const response = await request(app, 'POST', '/auth/register', null, { username, displayName: username, password: PASSWORD, recoveryWord: RECOVERY_WORD, confirmationWord: CONFIRMATION_WORD, ...device }, headers);
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
async function login(app, username, device = LAPTOP, headers) {
  const response = await request(app, 'POST', '/auth/login', null, { username, password: PASSWORD, confirmationWord: CONFIRMATION_WORD, ...device }, headers);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function socketFor(t, app, account) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const packets = [];
  const listeners = new Set();
  socket.on('message', raw => { const packet = JSON.parse(raw.toString()); packets.push(packet); for (const listener of [...listeners]) listener(packet); });
  socket.on('error', () => {});
  t.after(() => { socket.terminate(); });
  const next = (predicate, { timeout = 3000 } = {}) => {
    const existing = packets.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Timed out waiting for packet; received ${JSON.stringify(packets)}`)); }, timeout);
      const listener = packet => { if (!predicate(packet)) return; clearTimeout(timer); listeners.delete(listener); resolve(packet); };
      listeners.add(listener);
    });
  };
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: account.token }));
  assert.equal((await next(packet => packet.type === 'ready')).userId, account.user.id);
  return { socket, packets, next };
}

test('F6: register and login store the device details and the request address with the session', async t => {
  const { app, dataDir } = await fixture(t);
  const phone = await register(app, 'f6_store', PHONE);
  const laptop = await login(app, 'f6_store', LAPTOP);
  const rows = readDatabase(dataDir, database => database.prepare('SELECT device_name,platform,device_model,os_version,app_version,ip FROM sessions ORDER BY created_at').all().map(row => ({ ...row })));
  assert.deepEqual(rows, [
    { device_name: 'iPhone', platform: 'ios', device_model: 'iPhone 15 Pro', os_version: 'iOS 18.1', app_version: '0.14.13', ip: '127.0.0.1' },
    { device_name: 'Windows', platform: 'windows', device_model: 'Windows PC', os_version: 'Windows 11', app_version: '0.14.12', ip: '127.0.0.1' },
  ]);
  // Old apps send only deviceName: the new columns stay empty instead of failing the sign-in.
  const legacy = await login(app, 'f6_store', { deviceName: 'Браузер' });
  const legacyRow = readDatabase(dataDir, database => ({ ...database.prepare('SELECT platform,device_model,os_version,app_version,ip FROM sessions ORDER BY created_at DESC LIMIT 1').get() }));
  assert.deepEqual(legacyRow, { platform: null, device_model: null, os_version: null, app_version: null, ip: '127.0.0.1' });
  assert.equal((await request(app, 'GET', '/me', legacy)).statusCode, 200);
  assert.ok(phone.token !== laptop.token);
});

test('F6: the response lists the current session first with model, OS, app version, address, first login and last activity', async t => {
  let clock = Date.parse('2026-11-08T10:00:00.000Z');
  const { app } = await fixture(t, { now: () => clock });
  const phone = await register(app, 'f6_shape', PHONE);
  clock += 5 * 60_000;
  const laptop = await login(app, 'f6_shape', LAPTOP);
  clock += 2 * 60_000;
  assert.equal((await request(app, 'GET', '/me', phone)).statusCode, 200, 'activity on the phone slides its last_active_at');

  const fromLaptop = (await request(app, 'GET', '/auth/sessions', laptop)).json().sessions;
  assert.equal(fromLaptop.length, 2);
  assert.equal(fromLaptop[0].isCurrent, true, 'the asking device comes first even though it signed in later');
  assert.deepEqual(Object.keys(fromLaptop[0]).sort(), ['appVersion', 'createdAt', 'deviceModel', 'deviceName', 'expiresAt', 'id', 'ip', 'isCurrent', 'lastActiveAt', 'osVersion', 'platform']);
  assert.deepEqual({ ...fromLaptop[0], id: undefined, expiresAt: undefined }, {
    id: undefined, expiresAt: undefined, deviceName: 'Windows', platform: 'windows', deviceModel: 'Windows PC', osVersion: 'Windows 11', appVersion: '0.14.12',
    ip: '127.0.0.1', isCurrent: true, createdAt: '2026-11-08T10:05:00.000Z', lastActiveAt: '2026-11-08T10:07:00.000Z' /* this very request is activity */,
  });
  const phoneRow = fromLaptop[1];
  assert.equal(phoneRow.isCurrent, false);
  assert.equal(phoneRow.deviceModel, 'iPhone 15 Pro');
  assert.equal(phoneRow.createdAt, '2026-11-08T10:00:00.000Z', 'first login');
  assert.equal(phoneRow.lastActiveAt, '2026-11-08T10:07:00.000Z', 'last activity moved with the request (touchSessions)');
  assert.equal(typeof phoneRow.ip, 'string');
  assert.ok(!('token' in phoneRow) && !('tokenHash' in phoneRow), 'never the secret');

  const fromPhone = (await request(app, 'GET', '/auth/sessions', phone)).json().sessions;
  assert.equal(fromPhone[0].isCurrent, true);
  assert.equal(fromPhone[0].deviceModel, 'iPhone 15 Pro');
  assert.equal(fromPhone[1].id, fromLaptop[0].id);
});

test('F6: the stored address follows trustProxy — forwarded headers count only when the proxy is trusted', async t => {
  const plain = await fixture(t);
  await register(plain.app, 'f6_ip_plain', PHONE, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(readDatabase(plain.dataDir, database => database.prepare('SELECT ip FROM sessions').get().ip), '127.0.0.1', 'an untrusted X-Forwarded-For is ignored');

  const proxied = await fixture(t, { trustProxy: true });
  await register(proxied.app, 'f6_ip_proxied', PHONE, { 'x-forwarded-for': '203.0.113.9' });
  const listed = (await login(proxied.app, 'f6_ip_proxied', LAPTOP, { 'x-forwarded-for': '198.51.100.7' }));
  const sessions = (await request(proxied.app, 'GET', '/auth/sessions', listed)).json().sessions;
  assert.equal(sessions.find(session => session.isCurrent).ip, '198.51.100.7');
  assert.equal(sessions.find(session => !session.isCurrent).ip, '203.0.113.9');
});

test('F6: device fields are validated like the device name; unknown fields are refused', async t => {
  const { app } = await fixture(t);
  await register(app, 'f6_valid', PHONE);
  const attempt = extra => request(app, 'POST', '/auth/login', null, { username: 'f6_valid', password: PASSWORD, confirmationWord: CONFIRMATION_WORD, ...extra });
  assert.equal((await attempt({ deviceModel: 'x'.repeat(81) })).statusCode, 400, 'too long');
  assert.equal((await attempt({ osVersion: 'iOS\u0007 18' })).statusCode, 400, 'control characters');
  assert.equal((await attempt({ osVersion: 'iOS\u0085 18' })).statusCode, 400, 'C1 control characters');
  assert.equal((await attempt({ deviceModel: 'Pixel\u200b 8' })).statusCode, 400, 'zero-width characters');
  assert.equal((await attempt({ deviceModel: 'Pixel \u202e8' })).statusCode, 400, 'direction-changing characters');
  assert.equal((await attempt({ appVersion: '0.14\ufeff.13' })).statusCode, 400, 'byte order mark inside the text');
  assert.equal((await attempt({ deviceModel: '\u3164Pixel 8' })).statusCode, 400, 'Hangul filler');
  assert.equal((await attempt({ appVersion: 42 })).statusCode, 400, 'not a string');
  assert.equal((await attempt({ geo: 'Moscow' })).statusCode, 400, 'no geolocation or other unknown fields');
  assert.equal((await attempt({ deviceModel: '  Pixel 8  ' })).statusCode, 200, 'trimmed text is fine');
  assert.equal((await attempt({ osVersion: 'Android\t15' })).statusCode, 400, 'a tab is a control character too');
  const spaced = await attempt({ deviceModel: 'Pixel   8', osVersion: 'Android  15' });
  assert.equal(spaced.statusCode, 200, 'repeated spaces are fine');
  const stored = (await request(app, 'GET', '/auth/sessions', spaced.json())).json().sessions.find(session => session.isCurrent);
  assert.equal(stored.deviceModel, 'Pixel 8', 'whitespace is collapsed');
  assert.equal(stored.osVersion, 'Android 15');
});

test('F6: a new sign-in is announced to the other devices, and «Это был не я» ends exactly that session', async t => {
  const { app } = await fixture(t);
  const phone = await register(app, 'f6_notice', PHONE);
  const phoneSocket = await socketFor(t, app, phone);
  const laptop = await login(app, 'f6_notice', LAPTOP);
  const event = await phoneSocket.next(packet => packet.type === 'session.new');
  assert.equal(event.label, 'Windows PC · Windows 11');
  assert.deepEqual({ ...event.session, id: undefined, createdAt: undefined, lastActiveAt: undefined, expiresAt: undefined }, {
    id: undefined, createdAt: undefined, lastActiveAt: undefined, expiresAt: undefined,
    deviceName: 'Windows', platform: 'windows', deviceModel: 'Windows PC', osVersion: 'Windows 11', appVersion: '0.14.12', ip: '127.0.0.1', isCurrent: false,
  });
  assert.ok(!JSON.stringify(event).includes(laptop.token), 'the event never carries the new token');
  const listed = (await request(app, 'GET', '/auth/sessions', laptop)).json().sessions;
  assert.equal(listed.find(session => session.isCurrent).id, event.session.id, 'the event names the public session id');

  // Registration creates the only session: nothing to announce. A stranger never hears about it.
  const stranger = await register(app, 'f6_stranger', PHONE);
  const strangerSocket = await socketFor(t, app, stranger);
  await login(app, 'f6_notice', { deviceName: 'Браузер' });
  await phoneSocket.next(packet => packet.type === 'session.new' && packet.session.deviceName === 'Браузер');
  assert.equal(strangerSocket.packets.filter(packet => packet.type === 'session.new').length, 0);

  // «Это был не я → Завершить сеанс» from the phone: the laptop is signed out, the phone stays.
  const revoked = await request(app, 'POST', '/auth/sessions/revoke', phone, { sessionId: event.session.id });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await request(app, 'GET', '/me', laptop)).statusCode, 401);
  assert.equal((await request(app, 'GET', '/me', phone)).statusCode, 200);
});

test('F6: the notice label prefers model and OS, then the device name', () => {
  assert.equal(sessionLabel({ device_name: 'Windows', device_model: 'Windows PC', os_version: 'Windows 11' }), 'Windows PC · Windows 11');
  assert.equal(sessionLabel({ device_name: 'Браузер', device_model: null, os_version: null }), 'Браузер');
  assert.equal(sessionLabel({ deviceName: 'Android', deviceModel: 'Pixel 8', osVersion: null }), 'Pixel 8');
  assert.equal(sessionLabel({}), 'Неизвестное устройство');
});

test('F6: a database made before the detail columns migrates and keeps its sessions', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-f6-migrate-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await buildApp({ dataDir, logger: false, authRateLimit: 1000 });
  await first.ready();
  const account = await register(first, 'f6_migrate', PHONE);
  await first.close();
  readDatabase(dataDir, database => {
    for (const column of ['platform', 'device_model', 'os_version', 'app_version', 'ip']) database.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
  });
  const second = await buildApp({ dataDir, logger: false, authRateLimit: 1000 });
  await second.ready();
  t.after(() => second.close());
  const sessions = (await request(second, 'GET', '/auth/sessions', account)).json().sessions;
  assert.equal(sessions.length, 1);
  assert.deepEqual({ platform: sessions[0].platform, deviceModel: sessions[0].deviceModel, ip: sessions[0].ip, isCurrent: sessions[0].isCurrent }, { platform: null, deviceModel: null, ip: null, isCurrent: true });
});
