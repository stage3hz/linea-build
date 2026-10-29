import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';

// Deliberately synthetic credentials, used only in disposable databases below.
const PASSWORD = 'Synthetic!Harbor.42.Maple';
const NEW_PASSWORD = 'Synthetic!Orchid.87.Wind';
const CONFIRMATION_WORD = 'AmberGardenPrism';
const NEW_CONFIRMATION_WORD = 'JasperMeadowAtlas';
const WORD = 'SilverHarborLantern';
const NEW_WORD = 'WillowOrchardCompass';
const WRONG_WORD = 'DifferentMountainCloud';
const DAY = 24 * 60 * 60 * 1000;
const RECOVERY_DELAY = 10 * 60 * 1000;
const RESET_WINDOW = 20 * 60 * 1000;
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, options = {}, seed) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-auth-test-'));
  let time = Date.now();
  if (seed) await seed(path.join(dataDir, 'linea.sqlite'));
  const instances = [];
  const open = async overrides => {
    const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000, now: () => time, ...options, ...overrides });
    await app.ready();
    instances.push(app);
    return app;
  };
  t.after(async () => {
    for (const instance of instances.reverse()) await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app: await open(), open, dataDir, advanceTo: iso => { time = Date.parse(iso); } };
}

function readDatabase(dataDir, read) {
  const database = new DatabaseSync(path.join(dataDir, 'linea.sqlite'), { readOnly: true });
  try { return read(database); } finally { database.close(); }
}

async function request(app, method, url, account, payload, remoteAddress) {
  return app.inject({
    method, url,
    headers: account ? { authorization: `Bearer ${account.token}` } : {},
    ...(payload === undefined ? {} : { payload }),
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

async function register(app, username = 'alice', overrides = {}) {
  const response = await request(app, 'POST', '/auth/register', null, {
    username, displayName: username, password: PASSWORD, confirmationWord: CONFIRMATION_WORD, recoveryWord: WORD, ...overrides,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

async function login(app, username = 'alice', password = PASSWORD, confirmationWord = CONFIRMATION_WORD) {
  return request(app, 'POST', '/auth/login', null, { username, password, confirmationWord });
}

async function verifyWord(app, username = 'alice', recoveryWord = WORD, remoteAddress) {
  return request(app, 'POST', '/auth/recovery/verify', null, { username, recoveryWord }, remoteAddress);
}

async function grant(app, username = 'alice', recoveryWord = WORD) {
  const response = await verifyWord(app, username, recoveryWord);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(typeof result.resetToken, 'string');
  assert.ok(result.resetToken.length >= 32);
  assert.equal(typeof result.requestId, 'string');
  assert.ok(Number.isFinite(Date.parse(result.readyAt)));
  assert.ok(Number.isFinite(Date.parse(result.expiresAt)));
  assert.ok(Number.isFinite(Date.parse(result.serverTime)));
  return result;
}

async function reset(app, resetToken, overrides = {}) {
  return request(app, 'POST', '/auth/recovery/reset', null, {
    resetToken, newPassword: NEW_PASSWORD, ...overrides,
  });
}

function budget(dataDir, username = 'alice') {
  return readDatabase(dataDir, database => database.prepare('SELECT * FROM recovery_attempts WHERE name_key=?').get(sha256(username)));
}

async function within(promise, label, timeoutMs = 4000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function socketFor(t, app, account) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const packets = [];
  const listeners = new Set();
  const ready = deferred();
  socket.on('error', () => {});
  socket.on('message', raw => {
    const packet = JSON.parse(raw.toString());
    packets.push(packet);
    for (const listener of [...listeners]) listener(packet);
    if (packet.type === 'ready') ready.resolve(packet);
  });
  t.after(() => socket.terminate());
  await within(once(socket, 'open'), 'WebSocket did not open');
  socket.send(JSON.stringify({ type: 'auth', token: account.token }));
  assert.equal((await within(ready.promise, 'WebSocket did not authenticate')).userId, account.user.id);
  const next = (predicate, from = 0) => {
    const existing = packets.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return within(new Promise(resolve => {
      const listener = packet => {
        if (!predicate(packet)) return;
        listeners.delete(listener);
        resolve(packet);
      };
      listeners.add(listener);
    }), 'Expected WebSocket packet did not arrive');
  };
  return { socket, packets, next };
}

test('contact-free registration validates independent secrets and exposes only public account data', async t => {
  const { app, dataDir } = await fixture(t);
  const alice = await register(app);
  const bob = await register(app, 'bob');
  assert.equal((await request(app, 'GET', '/auth/security')).statusCode, 401);
  assert.deepEqual((await request(app, 'GET', '/auth/security', alice)).json(), { recoveryConfigured: true, confirmationConfigured: true });
  const rows = readDatabase(dataDir, database => database.prepare('SELECT * FROM users ORDER BY username').all());
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.password_hash, /^scrypt-v2\$/);
    assert.match(row.recovery_hash, /^scrypt-v2\$/);
    assert.match(row.confirmation_hash, /^scrypt-v2\$/);
    assert.equal(JSON.stringify(row).includes(PASSWORD), false);
    assert.equal(JSON.stringify(row).toLowerCase().includes(WORD.toLowerCase()), false);
    assert.equal(JSON.stringify(row).toLowerCase().includes(CONFIRMATION_WORD.toLowerCase()), false);
    for (const value of [alice, bob, (await request(app, 'GET', '/me', alice)).json()]) {
      const text = JSON.stringify(value);
      assert.equal(text.includes(row.password_hash), false);
      assert.equal(text.includes(row.recovery_hash), false);
      assert.equal(text.includes(row.confirmation_hash), false);
    }
  }
  assert.notEqual(rows[0].password_hash, rows[1].password_hash, 'equal passwords use independent salts');
  assert.notEqual(rows[0].recovery_hash, rows[1].recovery_hash, 'equal recovery words use independent salts');
  assert.notEqual(rows[0].confirmation_hash, rows[1].confirmation_hash, 'equal login words use independent salts');
  const sessionRows = readDatabase(dataDir, database => database.prepare('SELECT token_hash FROM sessions').all());
  assert.equal(sessionRows.some(row => row.token_hash === alice.token), false);
  assert.equal(sessionRows.some(row => row.token_hash === sha256(alice.token)), true);
  for (const credentials of [
    { password: 'short' },
    { recoveryWord: 'abc' },
    { confirmationWord: 'abc' },
    { recoveryWord: 'not-a-single-word-here' },
    { recoveryWord: 'A'.repeat(65) },
    { confirmationWord: WORD.toUpperCase() },
    { password: 'SilverHarborLantern', recoveryWord: 'silverharborlantern' },
    { email: 'synthetic@example.invalid' },
    { phone: '+00000000000' },
  ]) {
    const response = await request(app, 'POST', '/auth/register', null, {
      username: 'invalid_account', displayName: 'Test', password: PASSWORD, confirmationWord: CONFIRMATION_WORD, recoveryWord: WORD, ...credentials,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  for (const word of [{ confirmationWord: CONFIRMATION_WORD }, { recoveryWord: WORD }]) {
    const missingWord = await request(app, 'POST', '/auth/register', null, { username: 'no_word', displayName: 'Test', password: PASSWORD, ...word });
    assert.equal(missingWord.statusCode, 400);
  }
});

test('new password policy counts Unicode code points and preserves intentional spaces', async t => {
  const { app } = await fixture(t);
  const unicodePassword = '🦉🌲🌙🦊🍁🌊🐚🪁🧭🌻🦋🍀🍂🦜🪷';
  assert.equal(Array.from(unicodePassword).length, 15);
  for (const password of [Array.from(unicodePassword).slice(0, 14).join(''), 'x'.repeat(129), ' '.repeat(15)]) {
    const response = await request(app, 'POST', '/auth/register', null, { username: 'unicode', displayName: 'Unicode', password, recoveryWord: WORD, confirmationWord: CONFIRMATION_WORD });
    assert.equal(response.statusCode, 400, response.body);
  }
  await register(app, 'unicode', { password: unicodePassword });
  assert.equal((await login(app, 'unicode', unicodePassword)).statusCode, 200);
  const spaced = '  Synthetic harbor phrase 42  ';
  await register(app, 'spaces', { password: spaced });
  assert.equal((await login(app, 'spaces', spaced)).statusCode, 200);
  assert.equal((await login(app, 'spaces', spaced.trim())).statusCode, 401);
});

test('Russian and English recovery words use consistent NFC, case folding and outer-space normalization', async t => {
  const { app } = await fixture(t);
  await register(app, 'english');
  await grant(app, 'english', `  ${WORD.toUpperCase()}  `);
  const russianWord = 'СеверныйБархатныйМаяк';
  await register(app, 'russian', { recoveryWord: russianWord });
  const entered = `  ${russianWord.toUpperCase().normalize('NFD')}  `;
  await grant(app, 'RUSSIAN', entered);
  assert.equal((await login(app, 'russian', PASSWORD)).statusCode, 200, 'recovery verification does not silently log out normal sessions');
});

test('new accounts require their separate login word and support short Russian recovery words', async t => {
  const { app } = await fixture(t);
  await register(app, 'short_words', { confirmationWord: 'корабль', recoveryWord: 'астра' });
  const good = await login(app, 'short_words', PASSWORD, '  КОРАБЛЬ  ');
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().securitySetupRequired, false);
  for (const word of ['', 'астра', 'чужой', CONFIRMATION_WORD]) {
    const wrong = await login(app, 'short_words', PASSWORD, word);
    assert.equal(wrong.statusCode, 401, wrong.body);
  }
  const missing = await request(app, 'POST', '/auth/login', null, { username: 'short_words', password: PASSWORD });
  assert.equal(missing.statusCode, 401, missing.body);
  const unknown = await login(app, 'missing_person', PASSWORD, 'чужой');
  const wrong = await login(app, 'short_words', PASSWORD, 'чужой');
  assert.deepEqual(wrong.json(), unknown.json(), 'public failure does not disclose which credential or account was wrong');
  await grant(app, 'short_words', '  АСТРА  ');
  await register(app, 'four_letters', { confirmationWord: 'маяк', recoveryWord: 'dawn' });
  assert.equal((await login(app, 'four_letters', PASSWORD, 'МАЯК')).statusCode, 200);
});

test('exactly three failed recovery attempts survive restart and IP changes for a full 24 hours', async t => {
  let time = Date.now();
  const { app, open, dataDir } = await fixture(t, { now: () => time });
  const alice = await register(app);
  for (const [index, address] of ['198.51.100.10', '198.51.100.11'].entries()) {
    const response = await verifyWord(app, 'alice', WRONG_WORD, address);
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.json().code, 'RECOVERY_INVALID');
    assert.equal(response.json().attemptsRemaining, 2 - index);
  }
  assert.equal(budget(dataDir).attempts, 2);
  await app.close();
  const restarted = await open();
  const third = await verifyWord(restarted, 'alice', WRONG_WORD, '198.51.100.12');
  assert.equal(third.statusCode, 429, third.body);
  assert.equal(third.json().code, 'RECOVERY_LOCKED');
  assert.equal(third.json().attemptsRemaining, 0);
  assert.equal(third.json().retryAfterSeconds, DAY / 1000);
  assert.equal(budget(dataDir).attempts, 3);
  assert.equal(budget(dataDir).locked_until, time + DAY);
  assert.equal((await request(restarted, 'GET', '/me', alice)).statusCode, 200);
  assert.equal((await login(restarted)).statusCode, 200, 'ordinary password login remains available');
  const blockedCorrect = await verifyWord(restarted);
  assert.equal(blockedCorrect.statusCode, 429, blockedCorrect.body);
  assert.equal(blockedCorrect.json().attemptsRemaining, 0, 'password login did not reset the recovery budget');
  time += DAY - 1;
  const boundary = await verifyWord(restarted);
  assert.equal(boundary.statusCode, 429);
  assert.equal(boundary.json().retryAfterSeconds, 1);
  time += 1;
  await grant(restarted);
});

test('a correct third recovery word succeeds and resets the failed-attempt budget', async t => {
  const { app, dataDir } = await fixture(t);
  await register(app);
  assert.equal((await verifyWord(app, 'alice', WRONG_WORD)).json().attemptsRemaining, 2);
  assert.equal((await verifyWord(app, 'alice', WRONG_WORD)).json().attemptsRemaining, 1);
  await grant(app);
  assert.equal(budget(dataDir)?.attempts || 0, 0);
  const nextFailure = await verifyWord(app, 'alice', WRONG_WORD);
  assert.equal(nextFailure.statusCode, 401);
  assert.equal(nextFailure.json().attemptsRemaining, 2);
});

test('four parallel wrong words cannot reserve more than three per-account attempts', async t => {
  const { app, dataDir } = await fixture(t);
  await register(app);
  const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => verifyWord(app, 'alice', WRONG_WORD, `198.51.100.${20 + index}`)));
  assert.equal(responses.some(response => response.statusCode === 200), false);
  assert.ok(responses.every(response => [401, 429].includes(response.statusCode)), responses.map(response => response.body).join('\n'));
  assert.ok(responses.some(response => response.statusCode === 429));
  assert.equal(budget(dataDir).attempts, 3);
  assert.ok(budget(dataDir).locked_until > Date.now());
  const correct = await verifyWord(app);
  assert.equal(correct.statusCode, 429, correct.body);
  assert.equal(correct.json().attemptsRemaining, 0);
});

test('unknown accounts have the same public failure and lock budget as existing accounts', async t => {
  let time = Date.now();
  const { app, open, dataDir } = await fixture(t, { now: () => time });
  await register(app);
  await register(app, 'partial_known');
  for (const name of ['partial_known', 'partial_missing']) {
    assert.equal((await verifyWord(app, name, WRONG_WORD)).json().attemptsRemaining, 2);
  }
  for (let index = 0; index < 3; index++) {
    const known = await verifyWord(app, 'alice', WRONG_WORD);
    const unknown = await verifyWord(app, 'missing_person', WRONG_WORD);
    assert.equal(known.statusCode, unknown.statusCode);
    assert.deepEqual(known.json(), unknown.json());
  }
  assert.equal(budget(dataDir, 'missing_person').attempts, 3);
  await app.close();
  const restarted = await open();
  const stillBlocked = await verifyWord(restarted, 'missing_person', WRONG_WORD);
  assert.equal(stillBlocked.statusCode, 429);
  assert.equal(stillBlocked.json().attemptsRemaining, 0);
  time += DAY;
  const freshFailure = await verifyWord(restarted, 'missing_person', WRONG_WORD);
  assert.equal(freshFailure.statusCode, 401);
  assert.equal(freshFailure.json().attemptsRemaining, 2);
  const knownFresh = await verifyWord(restarted, 'alice', WRONG_WORD);
  assert.deepEqual(knownFresh.json(), freshFailure.json());
  for (const name of ['partial_known', 'partial_missing']) {
    const expiredPartial = await verifyWord(restarted, name, WRONG_WORD);
    assert.equal(expiredPartial.statusCode, 401, expiredPartial.body);
    assert.equal(expiredPartial.json().attemptsRemaining, 2, 'a partial budget expires after the same 24 hours of inactivity for known and unknown names');
  }
});

test('recovery grant is hashed, waits ten minutes on the server, expires after the reset window and grants no normal API access', async t => {
  let time = Date.now();
  const { app, open, dataDir } = await fixture(t, { now: () => time, authRateLimit: 20 });
  await register(app);
  const issued = await grant(app);
  assert.equal(Date.parse(issued.readyAt), time + RECOVERY_DELAY);
  assert.equal(Date.parse(issued.expiresAt), time + RECOVERY_DELAY + RESET_WINDOW);
  assert.equal(Date.parse(issued.serverTime), time);
  assert.equal((await request(app, 'GET', '/me', { token: issued.resetToken })).statusCode, 401);
  assert.equal((await request(app, 'GET', '/auth/sessions', { token: issued.resetToken })).statusCode, 401);
  const stored = readDatabase(dataDir, database => database.prepare('SELECT * FROM recovery_grants').all());
  assert.equal(stored.length, 1);
  assert.equal(stored[0].token_hash, sha256(issued.resetToken));
  assert.equal(JSON.stringify(stored).includes(issued.resetToken), false);
  const early = await reset(app, issued.resetToken);
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().code, 'RECOVERY_WAIT');
  const before = await request(app, 'POST', '/auth/recovery/status', null, { resetToken: issued.resetToken });
  assert.equal(before.json().status, 'waiting');
  for (let index = 0; index < 25; index++) {
    const polled = await request(app, 'POST', '/auth/recovery/status', null, { resetToken: issued.resetToken });
    assert.equal(polled.statusCode, 200, 'status polling has a separate budget from the default 20-attempt authentication limit');
  }
  await app.close();
  const restarted = await open();
  time += RECOVERY_DELAY - 1;
  const almost = await request(restarted, 'POST', '/auth/recovery/status', null, { resetToken: issued.resetToken });
  assert.equal(almost.statusCode, 200, almost.body);
  assert.equal(almost.json().status, 'waiting');
  assert.equal((await reset(restarted, issued.resetToken)).statusCode, 409, 'restart or polling does not skip the server delay');
  time += 1;
  const ready = await request(restarted, 'POST', '/auth/recovery/status', null, { resetToken: issued.resetToken });
  assert.equal(ready.json().status, 'ready');
  assert.equal(ready.json().readyAt, issued.readyAt);
  assert.equal(Date.parse(ready.json().serverTime), time);
  time += RESET_WINDOW;
  assert.equal((await reset(restarted, issued.resetToken)).statusCode, 410);
  assert.equal((await request(restarted, 'POST', '/auth/recovery/status', null, { resetToken: issued.resetToken })).statusCode, 410);
  assert.equal((await login(restarted)).statusCode, 200, 'expired grant never changed the password');
});

test('pending recovery is visible only to its owner, notifies own sessions without secrets and can be cancelled', async t => {
  const { app, advanceTo } = await fixture(t);
  const alice = await register(app);
  const aliceOther = (await login(app)).json();
  const bob = await register(app, 'bob');
  const ownSocket = await socketFor(t, app, aliceOther);
  const foreignSocket = await socketFor(t, app, bob);
  assert.equal((await request(app, 'GET', '/auth/recovery/requests')).statusCode, 401);
  const issued = await grant(app);
  const notification = await ownSocket.next(packet => packet.type === 'recovery.requested');
  const serialized = JSON.stringify(notification);
  for (const secret of [issued.resetToken, PASSWORD, WORD, CONFIRMATION_WORD]) {
    assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, 'recovery notice must not disclose a credential');
  }
  assert.equal(foreignSocket.packets.some(packet => packet.type.startsWith('recovery.')), false);
  const listed = await request(app, 'GET', '/auth/recovery/requests', alice);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().requests.length, 1);
  const visible = listed.json().requests[0];
  assert.equal(visible.id, issued.requestId);
  assert.equal(visible.readyAt, issued.readyAt);
  assert.equal(visible.expiresAt, issued.expiresAt);
  assert.equal(typeof visible.deviceName, 'string');
  assert.ok(Number.isFinite(Date.parse(visible.createdAt)));
  assert.equal(JSON.stringify(visible).includes(issued.resetToken), false);
  assert.deepEqual((await request(app, 'GET', '/auth/recovery/requests', bob)).json(), { requests: [] });
  const foreignCancel = await request(app, 'POST', '/auth/recovery/cancel', bob, { requestId: issued.requestId });
  assert.ok([403, 404].includes(foreignCancel.statusCode), foreignCancel.body);
  assert.equal((await request(app, 'POST', '/auth/recovery/status', null, { resetToken: issued.resetToken })).json().status, 'waiting');
  const eventIndex = ownSocket.packets.length;
  const cancelled = await request(app, 'POST', '/auth/recovery/cancel', alice, { requestId: issued.requestId });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.deepEqual(cancelled.json(), { ok: true });
  await ownSocket.next(packet => packet.type === 'recovery.updated', eventIndex);
  assert.equal((await request(app, 'POST', '/auth/recovery/status', null, { resetToken: issued.resetToken })).statusCode, 410);
  advanceTo(issued.readyAt);
  assert.equal((await reset(app, issued.resetToken)).statusCode, 410, 'waiting until ready does not revive a cancelled request');
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 200, 'cancellation does not revoke the legitimate session');
  assert.deepEqual((await request(app, 'GET', '/auth/recovery/requests', alice)).json(), { requests: [] });
});

test('cancellation and reset cannot both commit when they race after the waiting period', async t => {
  const { app, advanceTo } = await fixture(t);
  const alice = await register(app);
  const issued = await grant(app);
  advanceTo(issued.readyAt);
  const [resetResult, cancelResult] = await Promise.all([
    reset(app, issued.resetToken),
    request(app, 'POST', '/auth/recovery/cancel', alice, { requestId: issued.requestId }),
  ]);
  if (cancelResult.statusCode === 200) {
    assert.equal(resetResult.statusCode, 410, resetResult.body);
    assert.equal((await login(app)).statusCode, 200);
    assert.equal((await login(app, 'alice', NEW_PASSWORD)).statusCode, 401);
  } else {
    assert.equal(resetResult.statusCode, 200, resetResult.body);
    assert.ok([401, 404, 410].includes(cancelResult.statusCode), cancelResult.body);
    assert.equal((await login(app)).statusCode, 401);
    assert.equal((await login(app, 'alice', NEW_PASSWORD)).statusCode, 200);
  }
  assert.equal((await request(app, 'POST', '/auth/recovery/status', null, { resetToken: issued.resetToken })).statusCode, 410);
});

test('new verification invalidates the previous grant; validation errors do not consume the current grant', async t => {
  const { app, advanceTo } = await fixture(t);
  await register(app);
  const first = await grant(app);
  const second = await grant(app);
  assert.notEqual(first.resetToken, second.resetToken);
  assert.equal((await reset(app, first.resetToken)).statusCode, 410);
  advanceTo(second.readyAt);
  assert.equal((await reset(app, second.resetToken, { newPassword: 'short' })).statusCode, 400);
  assert.equal((await reset(app, second.resetToken, { newRecoveryWord: NEW_WORD })).statusCode, 400, 'password recovery only accepts the password change');
  const success = await reset(app, second.resetToken);
  assert.equal(success.statusCode, 200, success.body);
  assert.deepEqual(success.json(), { ok: true });
  assert.equal((await reset(app, second.resetToken)).statusCode, 410, 'grant is one-use');
});

test('recovery changes the password, preserves both words, revokes all HTTP and WS sessions, and affects only its bound account', async t => {
  const { app, advanceTo } = await fixture(t);
  const alice = await register(app);
  const aliceOther = (await login(app)).json();
  const bob = await register(app, 'bob');
  const aliceSocket = await socketFor(t, app, alice);
  const otherSocket = await socketFor(t, app, aliceOther);
  const closed = once(aliceSocket.socket, 'close');
  const otherClosed = once(otherSocket.socket, 'close');
  const issued = await grant(app);
  const injectedUser = await reset(app, issued.resetToken, { username: 'bob' });
  assert.equal(injectedUser.statusCode, 400, 'a grant cannot be directed at a caller-supplied account');
  advanceTo(issued.readyAt);
  const result = await reset(app, issued.resetToken);
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { ok: true }, 'recovery does not automatically establish a new session');
  await within(Promise.all([closed, otherClosed]), 'A revoked WebSocket remained connected after recovery');
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 401);
  assert.equal((await request(app, 'GET', '/me', aliceOther)).statusCode, 401);
  assert.equal((await request(app, 'GET', '/me', bob)).statusCode, 200);
  assert.equal((await login(app, 'bob')).statusCode, 200);
  assert.equal((await login(app)).statusCode, 401, 'old password no longer authenticates');
  assert.equal((await login(app, 'alice', NEW_PASSWORD, NEW_CONFIRMATION_WORD)).statusCode, 401, 'the login word is still required after a password reset');
  assert.equal((await login(app, 'alice', NEW_PASSWORD)).statusCode, 200, 'the remembered login word is preserved');
  await grant(app, 'alice', WORD);
});

test('two concurrent reset submissions consume their grant exactly once', async t => {
  const { app, advanceTo } = await fixture(t);
  await register(app);
  const issued = await grant(app);
  advanceTo(issued.readyAt);
  const responses = await Promise.all([
    reset(app, issued.resetToken),
    reset(app, issued.resetToken, { newPassword: 'Synthetic!Second.92.Password' }),
  ]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 410]);
  const firstWon = responses[0].statusCode === 200;
  assert.equal((await login(app, 'alice', firstWon ? NEW_PASSWORD : 'Synthetic!Second.92.Password')).statusCode, 200);
  assert.equal((await login(app, 'alice', firstWon ? 'Synthetic!Second.92.Password' : NEW_PASSWORD)).statusCode, 401);
});

test('password and recovery-word changes require current password plus login word and revoke every previous session', async t => {
  const { app } = await fixture(t);
  const alice = await register(app);
  const other = (await login(app)).json();
  for (const [url, body] of [
    ['/auth/password', { currentPassword: 'wrong', currentConfirmationWord: CONFIRMATION_WORD, newPassword: NEW_PASSWORD }],
    ['/auth/recovery-word', { currentPassword: 'wrong', currentConfirmationWord: CONFIRMATION_WORD, recoveryWord: NEW_WORD }],
    ['/auth/confirmation-word', { currentPassword: 'wrong', currentConfirmationWord: CONFIRMATION_WORD, confirmationWord: NEW_CONFIRMATION_WORD }],
    ['/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }],
    ['/auth/password', { currentPassword: PASSWORD, currentConfirmationWord: 'WrongCopperBridge', newPassword: NEW_PASSWORD }],
  ]) {
    assert.equal((await request(app, 'POST', url, alice, body)).statusCode, 401);
    assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 200);
  }
  assert.equal((await request(app, 'POST', '/auth/password', alice, { currentPassword: PASSWORD, currentConfirmationWord: CONFIRMATION_WORD, newPassword: WORD })).statusCode, 400, 'password must not duplicate the recovery word');
  const changed = await request(app, 'POST', '/auth/password', alice, { currentPassword: PASSWORD, currentConfirmationWord: CONFIRMATION_WORD, newPassword: NEW_PASSWORD });
  assert.equal(changed.statusCode, 200, changed.body);
  for (const account of [alice, other]) assert.equal((await request(app, 'GET', '/me', account)).statusCode, 401);
  assert.equal((await login(app)).statusCode, 401);
  const next = (await login(app, 'alice', NEW_PASSWORD)).json();
  const nextOther = (await login(app, 'alice', NEW_PASSWORD)).json();
  const oldGrant = await grant(app);
  const rotated = await request(app, 'POST', '/auth/recovery-word', next, { currentPassword: NEW_PASSWORD, currentConfirmationWord: CONFIRMATION_WORD, recoveryWord: NEW_WORD });
  assert.equal(rotated.statusCode, 200, rotated.body);
  for (const account of [next, nextOther]) assert.equal((await request(app, 'GET', '/me', account)).statusCode, 401);
  assert.equal((await reset(app, oldGrant.resetToken)).statusCode, 410);
  assert.equal((await verifyWord(app)).statusCode, 401);
  await grant(app, 'alice', NEW_WORD);
  assert.equal((await login(app, 'alice', NEW_PASSWORD)).statusCode, 200);
});

test('changing a login word invalidates old sessions and pending recovery while preserving the password and recovery word', async t => {
  const { app } = await fixture(t);
  const alice = await register(app);
  const other = (await login(app)).json();
  const pending = await grant(app);
  const sameAsRecovery = await request(app, 'POST', '/auth/confirmation-word', alice, { currentPassword: PASSWORD, currentConfirmationWord: CONFIRMATION_WORD, confirmationWord: WORD.toUpperCase() });
  assert.equal(sameAsRecovery.statusCode, 400, sameAsRecovery.body);
  const changed = await request(app, 'POST', '/auth/confirmation-word', alice, { currentPassword: PASSWORD, currentConfirmationWord: CONFIRMATION_WORD, confirmationWord: NEW_CONFIRMATION_WORD });
  assert.equal(changed.statusCode, 200, changed.body);
  for (const account of [alice, other]) assert.equal((await request(app, 'GET', '/me', account)).statusCode, 401);
  assert.equal((await login(app)).statusCode, 401);
  assert.equal((await login(app, 'alice', PASSWORD, NEW_CONFIRMATION_WORD)).statusCode, 200);
  assert.equal((await request(app, 'POST', '/auth/recovery/status', null, { resetToken: pending.resetToken })).statusCode, 410);
  await grant(app);
});

test('session list uses opaque public ids, isolates owners and supports targeted/current/all-other revocation', async t => {
  const { app, dataDir } = await fixture(t);
  const alice = await register(app);
  const aliceOther = (await login(app)).json();
  const bob = await register(app, 'bob');
  const list = await request(app, 'GET', '/auth/sessions', alice);
  assert.equal(list.statusCode, 200, list.body);
  const sessions = list.json().sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter(session => session.isCurrent).length, 1);
  const tokenHashes = readDatabase(dataDir, database => database.prepare('SELECT token_hash FROM sessions').all().map(row => row.token_hash));
  for (const session of sessions) {
    assert.equal(typeof session.id, 'string');
    assert.equal(typeof session.deviceName, 'string');
    for (const name of ['createdAt', 'lastActiveAt', 'expiresAt']) assert.ok(Number.isFinite(Date.parse(session[name])), `${name} must be an ISO timestamp`);
    assert.equal(tokenHashes.includes(session.id), false);
    assert.equal(JSON.stringify(session).includes(alice.token), false);
  }
  const current = sessions.find(session => session.isCurrent);
  const remote = sessions.find(session => !session.isCurrent);
  const foreign = await request(app, 'POST', '/auth/sessions/revoke', bob, { sessionId: remote.id });
  assert.ok([403, 404].includes(foreign.statusCode), foreign.body);
  assert.equal((await request(app, 'GET', '/me', aliceOther)).statusCode, 200);
  const otherSocket = await socketFor(t, app, aliceOther);
  const closed = once(otherSocket.socket, 'close');
  assert.equal((await request(app, 'POST', '/auth/sessions/revoke', alice, { sessionId: remote.id })).statusCode, 200);
  await within(closed, 'Targeted revoked session kept its WebSocket');
  assert.equal((await request(app, 'GET', '/me', aliceOther)).statusCode, 401);
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 200);
  const another = (await login(app)).json();
  assert.equal((await request(app, 'POST', '/auth/sessions/revoke-others', alice, {})).statusCode, 200);
  assert.equal((await request(app, 'GET', '/me', another)).statusCode, 401);
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 200);
  assert.equal((await request(app, 'GET', '/me', bob)).statusCode, 200);
  assert.equal((await request(app, 'POST', '/auth/sessions/revoke', alice, { sessionId: current.id })).statusCode, 200);
  assert.equal((await request(app, 'GET', '/me', alice)).statusCode, 401, 'revoking the current session signs it out on the server');
});

test('v1 database and short legacy password migrate without losing accounts or sessions', async t => {
  const oldPassword = 'legacy-42!';
  const unicodeOldPassword = 'legacy\npass-e\u0301';
  const oldUserId = randomUUID();
  const oldToken = randomBytes(32).toString('base64url');
  const salt = 'ab'.repeat(16);
  const derived = await promisify(scrypt)(oldPassword, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const oldHash = `scrypt-v1$${salt}$${derived.toString('hex')}`;
  const unicodeSalt = 'cd'.repeat(16);
  const unicodeDerived = await promisify(scrypt)(unicodeOldPassword, unicodeSalt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const unicodeOldHash = `scrypt-v1$${unicodeSalt}$${unicodeDerived.toString('hex')}`;
  const { app, open, dataDir } = await fixture(t, {}, filename => {
    const database = new DatabaseSync(filename);
    database.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,bio TEXT NOT NULL DEFAULT '',avatar_color TEXT NOT NULL DEFAULT '#6C5CE7',avatar_id TEXT,created_at TEXT NOT NULL);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    const createdAt = new Date().toISOString();
    database.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').run(oldUserId, 'legacy', 'Legacy user', oldHash, createdAt);
    database.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), 'legacy_unicode', 'Legacy Unicode', unicodeOldHash, createdAt);
    database.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sha256(oldToken), oldUserId, Date.now() + DAY, createdAt);
    database.close();
  });
  const oldSession = { token: oldToken };
  assert.equal((await login(app, 'legacy_unicode', unicodeOldPassword, '')).statusCode, 200, 'legacy controls and decomposed Unicode retain their original semantics');
  assert.equal((await login(app, 'legacy_unicode', unicodeOldPassword.normalize('NFC'), '')).statusCode, 401, 'v1 hashes must not silently change to NFC password comparison');
  assert.equal((await request(app, 'GET', '/me', oldSession)).statusCode, 200);
  assert.deepEqual((await request(app, 'GET', '/auth/security', oldSession)).json(), { recoveryConfigured: false, confirmationConfigured: false });
  const before = (await request(app, 'GET', '/auth/sessions', oldSession)).json().sessions;
  assert.equal(before.length, 1);
  assert.equal(before[0].isCurrent, true);
  assert.notEqual(before[0].id, sha256(oldToken));
  const loggedIn = await login(app, 'legacy', oldPassword, '');
  assert.equal(loggedIn.statusCode, 200, loggedIn.body);
  assert.equal(loggedIn.json().user.id, oldUserId);
  assert.equal(loggedIn.json().securitySetupRequired, true);
  assert.equal(readDatabase(dataDir, database => database.prepare('PRAGMA user_version').get().user_version), 5);
  await app.close();
  const restarted = await open();
  const after = (await request(restarted, 'GET', '/auth/sessions', oldSession)).json().sessions;
  assert.equal(after.find(session => session.isCurrent).id, before[0].id);
  assert.equal((await login(restarted, 'legacy', oldPassword, '')).statusCode, 200);
  const added = await request(restarted, 'POST', '/auth/recovery-word', loggedIn.json(), { currentPassword: oldPassword, recoveryWord: WORD });
  assert.equal(added.statusCode, 200, added.body);
  assert.equal((await request(restarted, 'GET', '/me', oldSession)).statusCode, 401);
  const current = (await login(restarted, 'legacy', oldPassword, '')).json();
  assert.equal(current.securitySetupRequired, true);
  assert.deepEqual((await request(restarted, 'GET', '/auth/security', current)).json(), { recoveryConfigured: true, confirmationConfigured: false });
  const confirmed = await request(restarted, 'POST', '/auth/confirmation-word', current, { currentPassword: oldPassword, confirmationWord: CONFIRMATION_WORD });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal((await request(restarted, 'GET', '/me', current)).statusCode, 401);
  assert.equal((await login(restarted, 'legacy', oldPassword, '')).statusCode, 401);
  const complete = (await login(restarted, 'legacy', oldPassword)).json();
  assert.equal(complete.securitySetupRequired, false);
  assert.deepEqual((await request(restarted, 'GET', '/auth/security', complete)).json(), { recoveryConfigured: true, confirmationConfigured: true });
  await grant(restarted, 'legacy');
});

test('a password login already verified before recovery cannot create a fresh session after recovery commits', async t => {
  const verified = deferred();
  const release = deferred();
  let holdLogin = false;
  const { app, dataDir, advanceTo } = await fixture(t, {
    authTestHooks: { beforeSessionCreate: async () => {
      if (!holdLogin) return;
      verified.resolve();
      await release.promise;
    } },
  });
  t.after(() => release.resolve());
  await register(app);
  const issued = await grant(app);
  advanceTo(issued.readyAt);
  holdLogin = true;
  const delayedLogin = login(app);
  await within(verified.promise, 'Login never reached the post-verification barrier');
  try {
    const recovered = await reset(app, issued.resetToken);
    assert.equal(recovered.statusCode, 200, recovered.body);
  } finally {
    holdLogin = false;
    release.resolve();
  }
  const stale = await delayedLogin;
  assert.equal(stale.statusCode, 401, stale.body);
  assert.equal(readDatabase(dataDir, database => database.prepare('SELECT count(*) AS count FROM sessions').get().count), 0);
  assert.equal((await login(app, 'alice', NEW_PASSWORD)).statusCode, 200);
});
