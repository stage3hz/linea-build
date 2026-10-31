import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { openDatabase, publicUser } from '../src/database.js';

const PASSWORD = 'Synthetic!Harbor.42.Maple';
const NEXT_PASSWORD = 'Synthetic!Orchid.87.Wind';
const CONFIRMATION = 'AmberGardenPrism';
const RECOVERY = 'SilverHarborLantern';
const CHOICES = ['✨', '⭐', '🌙', '☀️', '🌊', '🌿', '🔥', '💎', '🪐', '🎧', '🎮', '🦋', '🌛', '🌞', '🎶', '👾', '⚡', '❄️', '🌈', '👑'];
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-username-test-'));
  let time = Date.now();
  const instances = [];
  const open = async () => {
    const app = await buildApp({ dataDir, now: () => time, authRateLimit: 1000, logger: false });
    instances.push(app);
    return app;
  };
  t.after(async () => {
    for (const app of instances.reverse()) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const sql = work => {
    const db = new DatabaseSync(join(dataDir, 'linea.sqlite'));
    try { db.exec('PRAGMA foreign_keys=ON'); return work(db); } finally { db.close(); }
  };
  return { app: await open(), open, dataDir, sql, now: () => time, advance: milliseconds => { time += milliseconds; } };
}

const request = (app, method, url, account, payload) => app.inject({
  method, url, headers: account ? { authorization: `Bearer ${account.token}` } : {},
  ...(payload === undefined ? {} : { payload }),
});
const status = (app, account) => request(app, 'GET', '/me/username', account);
const rename = (app, account, username) => request(app, 'PATCH', '/me/username', account, { username });
const emoji = (app, account, statusEmoji) => request(app, 'PATCH', '/me/status-emoji', account, { statusEmoji });

async function register(app, username = 'alice') {
  const result = await request(app, 'POST', '/auth/register', null, {
    username, displayName: username, password: PASSWORD, confirmationWord: CONFIRMATION, recoveryWord: RECOVERY,
  });
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}

async function login(app, username, password = PASSWORD) {
  return request(app, 'POST', '/auth/login', null, { username, password, confirmationWord: CONFIRMATION });
}

async function grant(f, account, duration = 60_000) {
  const { grantPlatina } = await import('../src/platina-admin.js');
  return f.sql(db => grantPlatina(db, { userId: account.user.id, expiresAt: f.now() + duration, reason: 'Synthetic local administrator test grant' }, f.now()));
}

test('account status separates immutable private login, unique public username and stable account ID', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  assert.equal((await status(f.app)).statusCode, 401);
  const result = await status(f.app, alice);
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), {
    accountId: alice.user.id, loginName: 'alice', username: 'alice', freeChangeAvailable: true,
    canChangeUsername: true, platina: { active: false, expiresAt: null }, canSetStatusEmoji: false,
    statusEmoji: null, statusEmojiChoices: CHOICES,
  });
  assert.equal(alice.user.statusEmoji, null);
  assert.equal('loginName' in alice.user, false);
  assert.equal('login_name' in alice.user, false);
  assert.equal('platina' in alice.user, false);
});

test('one actual free rename is atomic and repeated same-name requests do not spend it twice', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  const before = f.sql(db => db.prepare('SELECT token_hash,id,user_id FROM sessions WHERE user_id=?').all(alice.user.id));
  const same = await rename(f.app, alice, ' ALICE ');
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json().status.freeChangeAvailable, true);
  const renamed = await rename(f.app, alice, ' Alice_New ');
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().user.id, alice.user.id);
  assert.equal(renamed.json().user.username, 'alice_new');
  assert.equal(renamed.json().status.loginName, 'alice');
  assert.equal(renamed.json().status.freeChangeAvailable, false);
  assert.equal(renamed.json().status.canChangeUsername, false);
  for (const response of await Promise.all([rename(f.app, alice, 'alice_new'), rename(f.app, alice, 'ALICE_NEW')])) {
    assert.equal(response.statusCode, 200, response.body);
  }
  const denied = await rename(f.app, alice, 'another_name');
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().code, 'PLATINA_REQUIRED');
  assert.deepEqual(f.sql(db => db.prepare('SELECT token_hash,id,user_id FROM sessions WHERE user_id=?').all(alice.user.id)), before);
  assert.equal(f.sql(db => db.prepare('SELECT username_change_used FROM users WHERE id=?').get(alice.user.id).username_change_used), 1);
});

test('concurrent distinct renames on two server connections consume exactly one free change', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  const second = await f.open();
  const responses = await Promise.all([rename(f.app, alice, 'first_name'), rename(second, alice, 'second_name')]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 403]);
  const current = (await status(f.app, alice)).json();
  assert.ok(['first_name', 'second_name'].includes(current.username));
  assert.equal(current.freeChangeAvailable, false);
  assert.equal((await rename(second, alice, current.username)).statusCode, 200);
});

test('public and immutable-login namespaces remain reserved and conflicts do not consume a free change', async t => {
  const f = await fixture(t);
  const alice = await register(f.app), bob = await register(f.app, 'bob');
  assert.equal((await rename(f.app, alice, 'renamed_alice')).statusCode, 200);
  for (const name of ['ALICE', 'renamed_alice']) {
    const collision = await rename(f.app, bob, name);
    assert.equal(collision.statusCode, 409, collision.body);
    assert.equal(collision.json().code, 'USERNAME_TAKEN');
    const registration = await request(f.app, 'POST', '/auth/register', null, {
      username: name, displayName: 'Collision', password: PASSWORD, confirmationWord: CONFIRMATION, recoveryWord: RECOVERY,
    });
    assert.equal(registration.statusCode, 409, registration.body);
  }
  assert.equal((await status(f.app, bob)).json().freeChangeAvailable, true);
  assert.equal((await rename(f.app, bob, 'renamed_bob')).statusCode, 200);
  assert.equal((await login(f.app, 'alice')).statusCode, 200);
  assert.equal((await login(f.app, 'renamed_alice')).statusCode, 401, 'a public name cannot become an alternate login');
});

test('recovery pending before rename keeps the immutable login budget and remains cancellable and usable', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  const verify = word => request(f.app, 'POST', '/auth/recovery/verify', null, { username: 'alice', recoveryWord: word });
  const first = await verify(RECOVERY);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((await rename(f.app, alice, 'new_public')).statusCode, 200);
  const waiting = await request(f.app, 'POST', '/auth/recovery/status', null, { resetToken: first.json().resetToken });
  assert.equal(waiting.statusCode, 200);
  assert.equal(waiting.json().status, 'waiting');
  assert.equal((await verify('DifferentMountainCloud')).statusCode, 401);
  assert.ok(f.sql(db => db.prepare('SELECT 1 FROM recovery_attempts WHERE name_key=?').get(hash('alice'))));
  const canceled = await request(f.app, 'POST', '/auth/recovery/cancel', alice, { requestId: first.json().requestId });
  assert.equal(canceled.statusCode, 200, canceled.body);
  assert.equal(f.sql(db => db.prepare('SELECT 1 FROM recovery_attempts WHERE name_key=?').get(hash('alice'))), undefined);
  const second = await verify(RECOVERY);
  assert.equal(second.statusCode, 200, second.body);
  f.advance(10 * 60_000);
  const reset = await request(f.app, 'POST', '/auth/recovery/reset', null, { resetToken: second.json().resetToken, newPassword: NEXT_PASSWORD });
  assert.equal(reset.statusCode, 200, reset.body);
  const next = await login(f.app, 'alice', NEXT_PASSWORD);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().user.id, alice.user.id);
  assert.equal(next.json().user.username, 'new_public');
  assert.equal((await login(f.app, 'new_public', NEXT_PASSWORD)).statusCode, 401);
});

test('only trusted active Platina permits further name changes and exact expiry revokes the right', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  assert.equal((await rename(f.app, alice, 'first_public')).statusCode, 200);
  await grant(f, alice);
  const active = (await status(f.app, alice)).json();
  assert.equal(active.platina.active, true);
  assert.equal(active.platina.expiresAt, new Date(f.now() + 60_000).toISOString());
  assert.equal(active.canChangeUsername, true);
  for (const name of ['second_public', 'third_public']) assert.equal((await rename(f.app, alice, name)).statusCode, 200);
  f.advance(60_000);
  assert.equal((await status(f.app, alice)).json().platina.active, false);
  assert.equal((await rename(f.app, alice, 'expired_public')).statusCode, 403);
  assert.equal((await rename(f.app, alice, 'third_public')).statusCode, 200, 'an idempotent retry is not a paid change');
  await grant(f, alice);
  const { revokePlatina } = await import('../src/platina-admin.js');
  f.sql(db => revokePlatina(db, { userId: alice.user.id, reason: 'Synthetic revocation' }, f.now()));
  assert.equal((await status(f.app, alice)).json().platina.active, false);
  assert.equal((await rename(f.app, alice, 'revoked_public')).statusCode, 403);
});

test('static status emoji requires active Platina and is hidden for peers immediately at expiry', async t => {
  const f = await fixture(t);
  const alice = await register(f.app), bob = await register(f.app, 'bob');
  assert.equal((await emoji(f.app, alice, '✨')).statusCode, 403);
  assert.equal((await emoji(f.app, alice, null)).statusCode, 200);
  await grant(f, alice);
  const set = await emoji(f.app, alice, '🎧');
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().user.statusEmoji, '🎧');
  assert.equal(set.json().status.canSetStatusEmoji, true);
  const chat = await request(f.app, 'POST', '/chats', bob, { userId: alice.user.id });
  assert.equal(chat.statusCode, 201, chat.body);
  assert.equal(chat.json().chat.peer.statusEmoji, '🎧');
  const publicSearch = await request(f.app, 'GET', '/users?q=alice', bob);
  assert.equal(publicSearch.json().users[0].statusEmoji, '🎧');
  assert.equal('loginName' in publicSearch.json().users[0], false);
  assert.equal('platina' in publicSearch.json().users[0], false);
  f.advance(60_000);
  const after = await request(f.app, 'GET', '/chats', bob);
  assert.equal(after.json().chats[0].peer.statusEmoji, null);
  assert.equal((await request(f.app, 'GET', '/users?q=alice', bob)).json().users[0].statusEmoji, null);
  assert.equal((await emoji(f.app, alice, '💎')).statusCode, 403);
  assert.equal((await emoji(f.app, alice, null)).statusCode, 200, 'clearing is allowed after expiry');
  await grant(f, alice);
  assert.equal((await status(f.app, alice)).json().statusEmoji, null);
});

test('clients cannot grant Platina, alter login/ID or submit arbitrary emoji assets', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  for (const payload of [
    { username: 'allowed', platina: true }, { username: 'allowed', paid: true },
    { username: 'allowed', permanent: true }, { username: 'allowed', expiresAt: null },
    { username: 'allowed', platina: { active: true, permanent: true, expiresAt: null } },
    { username: 'allowed', loginName: 'changed_login' }, { username: 'allowed', id: randomUUID() },
    { username: '@alice' }, { username: 'ab' }, { username: 'Яндекс' }, { username: 'a'.repeat(25) },
  ]) assert.equal((await request(f.app, 'PATCH', '/me/username', alice, payload)).statusCode, 400);
  assert.equal((await request(f.app, 'PATCH', '/me/username', null, { username: 'intruder' })).statusCode, 401);
  assert.equal((await request(f.app, 'POST', '/me/platina', alice, { active: true, expiresAt: '2099-01-01T00:00:00Z' })).statusCode, 404);
  assert.equal((await request(f.app, 'PATCH', '/me', alice, { statusEmoji: '✨', platina: true })).statusCode, 400);
  assert.equal((await request(f.app, 'PATCH', '/me', alice, { statusEmojiPermanent: true })).statusCode, 400);
  assert.equal((await request(f.app, 'PATCH', '/me/status-emoji', alice, { statusEmoji: '✨', permanent: true })).statusCode, 400);
  for (const url of ['/me/platina', '/me/platina/grant-permanent', '/admin/platina/grant-permanent']) {
    assert.equal((await request(f.app, 'POST', url, alice, { userId: alice.user.id, permanent: true, expiresAt: null })).statusCode, 404);
  }
  assert.deepEqual((await status(f.app, alice)).json().platina, { active: false, expiresAt: null });
  await grant(f, alice);
  for (const value of ['', '⭐️', '✨✨', 'not-an-emoji', 'https://example.invalid/custom.gif', '<svg/>', 42, {}, ['✨']]) {
    assert.equal((await emoji(f.app, alice, value)).statusCode, 400);
  }
  assert.equal((await request(f.app, 'PATCH', '/me/status-emoji', alice, { statusEmoji: '✨', animated: true })).statusCode, 400);
  assert.equal((await status(f.app, alice)).json().freeChangeAvailable, true);
});

test('credential changes still reject an immutable login reused as a secret after a public rename', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'oldimmutablelogin');
  assert.equal((await rename(f.app, alice, 'shortpublic')).statusCode, 200);
  const password = await request(f.app, 'POST', '/auth/password', alice, {
    currentPassword: PASSWORD, currentConfirmationWord: CONFIRMATION, newPassword: 'oldimmutablelogin',
  });
  assert.equal(password.statusCode, 400, password.body);
  const word = await request(f.app, 'POST', '/auth/recovery-word', alice, {
    currentPassword: PASSWORD, currentConfirmationWord: CONFIRMATION, recoveryWord: 'oldimmutablelogin',
  });
  assert.equal(word.statusCode, 400, word.body);
  assert.equal((await login(f.app, 'oldimmutablelogin')).statusCode, 200);
});

test('v3 migration preserves identity, sessions and pending recovery, and prevents login and ID mutation', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-v3-username-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const accountId = randomUUID(), sessionId = randomUUID(), recoveryId = randomUUID();
  const date = new Date().toISOString();
  const legacy = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  legacy.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,confirmation_hash TEXT,recovery_hash TEXT,credential_version INTEGER NOT NULL DEFAULT 0,bio TEXT NOT NULL DEFAULT '',avatar_color TEXT NOT NULL DEFAULT '#6C5CE7',avatar_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,id TEXT UNIQUE,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,device_name TEXT NOT NULL,last_active_at TEXT NOT NULL);
    CREATE TABLE recovery_grants(token_hash TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),credential_version INTEGER NOT NULL,ready_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,device_name TEXT NOT NULL);
    PRAGMA user_version=3;
  `);
  legacy.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').run(accountId, 'legacy', 'Legacy', 'synthetic-hash', date);
  legacy.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run('synthetic-token-hash', sessionId, accountId, Date.now() + 3600_000, date, 'Existing device', date);
  legacy.prepare('INSERT INTO recovery_grants VALUES(?,?,?,?,?,?,?,?)').run('synthetic-grant-hash', recoveryId, accountId, 0, Date.now() + 600_000, Date.now() + 1800_000, date, 'Recovery device');
  legacy.close();
  const verify = db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    const user = db.prepare('SELECT * FROM users').get();
    assert.equal(user.id, accountId);
    assert.equal(user.login_name, 'legacy');
    assert.equal(user.username, 'legacy');
    assert.equal(user.username_change_used, 0);
    assert.equal(user.status_emoji, null);
    assert.equal(db.prepare('SELECT id FROM sessions').get().id, sessionId);
    assert.equal(db.prepare('SELECT id FROM recovery_grants').get().id, recoveryId);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM platina_entitlements').get().count, 0);
    // The login may change only through /auth/login-name; the database still rejects malformed logins.
    assert.throws(() => db.prepare('UPDATE users SET login_name=? WHERE id=?').run('Bad Login!', accountId), /invalid or reserved/i);
    assert.throws(() => db.prepare('UPDATE users SET id=? WHERE id=?').run(randomUUID(), accountId), /immutable/i);
    assert.equal(publicUser(user, { db }).statusEmoji, null);
  };
  let db = openDatabase(dataDir);
  try { verify(db); } finally { db.close(); }
  db = openDatabase(dataDir);
  try { verify(db); } finally { db.close(); }
});

test('renaming leaves persisted encryption device identity and account foreign keys unchanged', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  const deviceId = randomUUID();
  f.sql(db => {
    const session = db.prepare('SELECT id FROM sessions WHERE user_id=?').get(alice.user.id);
    db.prepare(`INSERT INTO e2ee_devices(id,user_id,session_id,device_name,identity_key,registration_id,signed_prekey_id,signed_prekey_public,signed_prekey_signature,kyber_prekey_id,kyber_prekey_public,kyber_prekey_signature,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(deviceId, alice.user.id, session.id, 'Synthetic identity fixture', 'synthetic-public-identity', 1, 2, 'synthetic-prekey', 'synthetic-signature', 3, 'synthetic-kyber', 'synthetic-signature', new Date(f.now()).toISOString(), new Date(f.now()).toISOString());
  });
  const before = f.sql(db => db.prepare('SELECT * FROM e2ee_devices WHERE id=?').get(deviceId));
  const result = await rename(f.app, alice, 'renamed_device_owner');
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM e2ee_devices WHERE id=?').get(deviceId)), before);
});

test('administrator grants validate account and expiry, audit changes and revoke idempotently', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  const { grantPlatina, revokePlatina } = await import('../src/platina-admin.js');
  const input = { userId: alice.user.id, expiresAt: f.now() + 60_000, reason: 'Synthetic trusted grant' };
  f.sql(db => {
    for (const change of [
      { userId: randomUUID() }, { userId: 'alice' }, { expiresAt: f.now() },
      { expiresAt: Infinity }, { expiresAt: '2099-01-01' }, { reason: '' }, { reason: 'control\ntext' },
    ]) assert.throws(() => grantPlatina(db, { ...input, ...change }, f.now()));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM platina_entitlements').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM platina_audit').get().count, 0);
    assert.equal(grantPlatina(db, input, f.now()).platina.active, true);
    assert.equal(db.prepare('SELECT source FROM platina_entitlements').get().source, 'admin');
    assert.throws(() => db.prepare("UPDATE platina_entitlements SET source='client'").run());
    assert.equal(revokePlatina(db, input, f.now()).platina.active, false);
    assert.equal(revokePlatina(db, input, f.now()).platina.active, false);
    assert.deepEqual(db.prepare('SELECT action FROM platina_audit ORDER BY rowid').all().map(row => row.action), ['grant', 'revoke']);
  });
});

test('the local administrator CLI operates on an existing database without a network or purchase endpoint', async t => {
  const f = await fixture(t);
  const alice = await register(f.app);
  const run = promisify(execFile);
  const script = new URL('../src/platina-admin.js', import.meta.url).pathname;
  const args = ['--data-dir', f.dataDir, '--user-id', alice.user.id, '--reason', 'Synthetic CLI verification'];
  const expiry = new Date(Date.now() + 3600_000).toISOString();
  const granted = await run(process.execPath, [script, 'grant', ...args, '--expires-at', expiry], { timeout: 5000 });
  assert.ok(granted.stdout.trim(), 'The child process must return the administrator result; a blocked spawn is not a CLI success');
  assert.equal(JSON.parse(granted.stdout).platina.active, true);
  // The CLI uses wall-clock time. Advance the injectable HTTP fixture clock
  // past that grant instead of treating a valid new grant as future-dated.
  f.advance(Date.now() - f.now());
  assert.equal((await status(f.app, alice)).json().platina.active, true);
  const revoked = await run(process.execPath, [script, 'revoke', ...args], { timeout: 5000 });
  assert.equal(JSON.parse(revoked.stdout).platina.active, false);
  assert.equal((await status(f.app, alice)).json().platina.active, false);
  await assert.rejects(run(process.execPath, [script, 'grant', ...args, '--expires-at', 'invalid'], { timeout: 5000 }));
  assert.equal((await status(f.app, alice)).json().platina.active, false);
});

test('permanent Platina and its emoji survive public renames, server restart and real account recovery, then revoke', async t => {
  const f = await fixture(t);
  const alice = await register(f.app), bob = await register(f.app, 'bob');
  const { grantPermanentPlatina, revokePlatina } = await import('../src/platina-admin.js');
  const expected = { active: true, expiresAt: null, permanent: true };
  f.sql(db => grantPermanentPlatina(db, { userId: alice.user.id, reason: 'Synthetic permanent entitlement lifecycle' }, f.now()));
  const grantBefore = f.sql(db => db.prepare('SELECT * FROM platina_entitlements WHERE user_id=?').get(alice.user.id));
  const auditBefore = f.sql(db => db.prepare('SELECT * FROM platina_audit WHERE user_id=? ORDER BY rowid').all(alice.user.id));
  for (const name of ['first_public', 'second_public']) {
    const renamed = await rename(f.app, alice, name);
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().user.id, alice.user.id);
    assert.deepEqual(renamed.json().status.platina, expected);
  }
  const selected = await emoji(f.app, alice, '🎧');
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(selected.json().user.statusEmojiPermanent, true);
  assert.equal(selected.json().user.statusEmojiExpiresAt, null);
  const chat = await request(f.app, 'POST', '/chats', bob, { userId: alice.user.id });
  assert.equal(chat.statusCode, 201, chat.body);
  assert.equal(chat.json().chat.peer.statusEmojiPermanent, true);
  await f.app.close();
  const restarted = await f.open();
  assert.deepEqual((await status(restarted, alice)).json().platina, expected);
  const verified = await request(restarted, 'POST', '/auth/recovery/verify', null, { username: 'alice', recoveryWord: RECOVERY });
  assert.equal(verified.statusCode, 200, verified.body);
  f.advance(10 * 60_000);
  const reset = await request(restarted, 'POST', '/auth/recovery/reset', null, { resetToken: verified.json().resetToken, newPassword: NEXT_PASSWORD });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal((await status(restarted, alice)).statusCode, 401);
  const signedIn = await login(restarted, 'alice', NEXT_PASSWORD);
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  const recovered = signedIn.json();
  assert.equal(recovered.user.id, alice.user.id);
  assert.equal(recovered.user.username, 'second_public');
  assert.equal(recovered.user.statusEmojiPermanent, true);
  assert.deepEqual((await status(restarted, recovered)).json().platina, expected);
  assert.equal((await rename(restarted, recovered, 'third_public')).statusCode, 200);
  const reusedName = await rename(restarted, bob, 'second_public');
  assert.equal(reusedName.statusCode, 200, reusedName.body);
  assert.equal(reusedName.json().user.id, bob.user.id);
  assert.deepEqual(reusedName.json().status.platina, { active: false, expiresAt: null });
  assert.equal(reusedName.json().status.canSetStatusEmoji, false);
  assert.equal('statusEmojiPermanent' in reusedName.json().user, false);
  assert.deepEqual((await status(restarted, recovered)).json().platina, expected);
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM platina_entitlements WHERE user_id=?').get(alice.user.id)), grantBefore);
  assert.deepEqual(f.sql(db => db.prepare('SELECT * FROM platina_audit WHERE user_id=? ORDER BY rowid').all(alice.user.id)), auditBefore);
  const searched = await request(restarted, 'GET', '/users?q=third_public', bob);
  assert.equal(searched.json().users[0].statusEmojiPermanent, true);
  f.sql(db => revokePlatina(db, { userId: alice.user.id, reason: 'Synthetic permanent revocation' }, f.now()));
  const revoked = (await status(restarted, recovered)).json();
  assert.deepEqual(revoked.platina, { ...expected, active: false });
  assert.equal(revoked.canChangeUsername, false);
  assert.equal(revoked.canSetStatusEmoji, false);
  assert.equal(revoked.statusEmoji, null);
  assert.equal((await rename(restarted, recovered, 'after_revocation')).statusCode, 403);
  assert.equal((await emoji(restarted, recovered, '💎')).statusCode, 403);
  const peer = (await request(restarted, 'GET', '/chats', bob)).json().chats[0].peer;
  assert.equal(peer.statusEmoji, null);
  assert.equal(peer.statusEmojiExpiresAt, null);
  assert.equal('statusEmojiPermanent' in peer, false);
});

test('the sign-in login cannot be changed (it is private and permanent)', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'samelogin');
  const response = await request(f.app, 'POST', '/auth/login-name', alice, { currentPassword: PASSWORD, currentConfirmationWord: CONFIRMATION, newLogin: 'secretlogin' });
  assert.equal(response.statusCode, 410);
  assert.equal((await login(f.app, 'samelogin')).statusCode, 200);
});
