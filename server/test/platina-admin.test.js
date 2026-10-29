import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDatabase, publicUser } from '../src/database.js';
import { platinaState } from '../src/entitlements.js';
import * as admin from '../src/platina-admin.js';

const NOW = Date.UTC(2026, 9, 28);
const PERMANENT = { active: true, expiresAt: null, permanent: true };
const run = promisify(execFile);
const script = new URL('../src/platina-admin.js', import.meta.url).pathname;

async function directory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-permanent-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function addUser(db, username = 'alice') {
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,username,login_name,display_name,password_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, username, username, username, 'synthetic-hash', new Date(NOW).toISOString());
  return id;
}

async function fixture(t) {
  const dataDir = await directory(t);
  const db = openDatabase(dataDir);
  t.after(() => db.close());
  return { dataDir, db, userId: addUser(db) };
}

const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

test('real SQLite v4 migration preserves finite grants, revocations, audit and account/session data before allowing null expiry', async t => {
  const dataDir = await directory(t);
  const legacy = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  // Frozen v4 table definitions: the expiry really is NOT NULL, rather than
  // merely relabelling the latest schema with an older user_version.
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,login_name TEXT NOT NULL UNIQUE,
      username_change_used INTEGER NOT NULL DEFAULT 0 CHECK(username_change_used IN (0,1)),status_emoji TEXT,
      display_name TEXT NOT NULL,password_hash TEXT NOT NULL,confirmation_hash TEXT,recovery_hash TEXT,
      credential_version INTEGER NOT NULL DEFAULT 0,bio TEXT NOT NULL DEFAULT '',avatar_color TEXT NOT NULL DEFAULT '#6C5CE7',
      avatar_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE platina_entitlements(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL UNIQUE,source TEXT NOT NULL CHECK(source='admin'),granted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > granted_at),revoked_at INTEGER);
    CREATE TABLE platina_audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grant_id TEXT,action TEXT NOT NULL CHECK(action IN ('grant','revoke')),expires_at INTEGER,
      reason TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,id TEXT UNIQUE,user_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,device_name TEXT NOT NULL,last_active_at TEXT NOT NULL);
    CREATE TABLE recovery_grants(token_hash TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      credential_version INTEGER NOT NULL,ready_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,device_name TEXT NOT NULL);
    PRAGMA user_version=4;
  `);
  const alice = addUser(legacy), bob = addUser(legacy, 'bob');
  const expiry = NOW + 3_600_000;
  for (const [id, revoked] of [[alice, null], [bob, NOW + 1]]) {
    const grantId = randomUUID();
    legacy.prepare("INSERT INTO platina_entitlements VALUES(?,?,'admin',?,?,?)").run(id, grantId, NOW, expiry, revoked);
    legacy.prepare("INSERT INTO platina_audit VALUES(?,?,?,'grant',?,?,?)").run(randomUUID(), id, grantId, expiry, 'Existing finite grant', NOW);
    if (revoked !== null) legacy.prepare("INSERT INTO platina_audit VALUES(?,?,?,'revoke',?,?,?)")
      .run(randomUUID(), id, grantId, expiry, 'Existing revocation', revoked);
  }
  legacy.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run('synthetic-session-hash', randomUUID(), alice, expiry, '2026-10-28T00:00:00.000Z', 'Synthetic device', '2026-10-28T00:00:00.000Z');
  legacy.prepare('INSERT INTO recovery_grants VALUES(?,?,?,?,?,?,?,?)').run('synthetic-recovery-hash', randomUUID(), alice, 0, NOW + 600_000, expiry, '2026-10-28T00:00:00.000Z', 'Synthetic recovery');
  const snapshot = Object.fromEntries(['users', 'sessions', 'recovery_grants', 'platina_entitlements', 'platina_audit'].map(name => [name, rows(legacy, name)]));
  assert.equal(legacy.prepare('PRAGMA table_info(platina_entitlements)').all().find(column => column.name === 'expires_at').notnull, 1);
  assert.throws(() => legacy.prepare('UPDATE platina_entitlements SET expires_at=NULL WHERE user_id=?').run(alice), /NOT NULL/);
  legacy.close();
  const found = JSON.parse((await run(process.execPath, [script, 'lookup', '--data-dir', dataDir, '--username', 'alice'], { timeout: 5000 })).stdout);
  assert.equal(found.accountId, alice);
  const unchanged = new DatabaseSync(join(dataDir, 'linea.sqlite'), { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 4, 'Lookup must not migrate the database');
    assert.equal(unchanged.prepare('PRAGMA table_info(platina_entitlements)').all().find(column => column.name === 'expires_at').notnull, 1);
    for (const [table, expected] of Object.entries(snapshot)) assert.deepEqual(rows(unchanged, table), expected, table);
  } finally { unchanged.close(); }
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openDatabase(dataDir);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
      assert.equal(db.prepare('PRAGMA table_info(platina_entitlements)').all().find(column => column.name === 'expires_at').notnull, 0);
      for (const [table, expected] of Object.entries(snapshot)) assert.deepEqual(rows(db, table), expected, table);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(platinaState(db, alice, NOW), { active: true, expiresAt: new Date(expiry).toISOString() });
      assert.deepEqual(platinaState(db, bob, NOW + 1), { active: false, expiresAt: new Date(expiry).toISOString() });
      assert.throws(() => db.prepare("UPDATE platina_entitlements SET source='client',expires_at=NULL WHERE user_id=?").run(alice), /CHECK/);
      assert.throws(() => db.prepare('UPDATE platina_entitlements SET expires_at=granted_at WHERE user_id=?').run(alice), /CHECK/);
    } finally { db.close(); }
  }
  const db = openDatabase(dataDir);
  try {
    assert.deepEqual(admin.grantPermanentPlatina(db, { userId: alice, reason: 'Synthetic upgrade after migration' }, NOW + 2).platina, PERMANENT);
    assert.equal(db.prepare('SELECT expires_at FROM platina_entitlements WHERE user_id=?').get(alice).expires_at, null);
    assert.equal(rows(db, 'platina_audit').length, snapshot.platina_audit.length + 1);
  } finally { db.close(); }
});

test('permanent grants validate stable accounts and time, replace finite grants, persist on reopen and revoke only once', async t => {
  const { dataDir, db, userId } = await fixture(t);
  const input = { userId, reason: 'Synthetic local permanent grant' };
  for (const change of [{ userId: 'alice' }, { userId: randomUUID() }, { reason: '' }, { reason: 'bad\nreason' }, { reason: 'x'.repeat(501) }]) {
    assert.throws(() => admin.grantPermanentPlatina(db, { ...input, ...change }, NOW));
  }
  for (const invalid of [-1, 1.5, Infinity, 8_640_000_000_000_001]) {
    assert.throws(() => admin.grantPermanentPlatina(db, input, invalid));
  }
  assert.equal(rows(db, 'platina_audit').length, 0);
  assert.equal(rows(db, 'platina_entitlements').length, 0);
  const finiteExpiry = NOW + 60_000;
  admin.grantPlatina(db, { ...input, expiresAt: finiteExpiry }, NOW);
  assert.deepEqual(admin.grantPermanentPlatina(db, input, NOW + 1).platina, PERMANENT);
  const stored = rows(db, 'platina_entitlements')[0];
  assert.equal(stored.source, 'admin');
  assert.equal(stored.expires_at, null);
  db.prepare("UPDATE users SET status_emoji='🎧' WHERE id=?").run(userId);
  const reopened = openDatabase(dataDir);
  try {
    assert.deepEqual(rows(reopened, 'platina_entitlements')[0], stored);
    assert.deepEqual(platinaState(reopened, userId, Date.UTC(9999, 11, 31)), PERMANENT);
    assert.equal(publicUser(reopened.prepare('SELECT * FROM users WHERE id=?').get(userId), { db: reopened, now: () => NOW + 1 }).statusEmojiPermanent, true);
    const revoked = { ...PERMANENT, active: false };
    assert.deepEqual(admin.revokePlatina(reopened, input, NOW + 2).platina, revoked);
    assert.deepEqual(admin.revokePlatina(reopened, input, NOW + 3).platina, revoked);
    assert.deepEqual(rows(reopened, 'platina_audit').map(row => [row.action, row.expires_at]), [
      ['grant', finiteExpiry], ['grant', null], ['revoke', null],
    ]);
    admin.grantPermanentPlatina(reopened, input, NOW + 4);
    assert.deepEqual(admin.grantPlatina(reopened, { ...input, expiresAt: finiteExpiry }, NOW + 5).platina, {
      active: true, expiresAt: new Date(finiteExpiry).toISOString(),
    });
    const finiteUser = publicUser(reopened.prepare('SELECT * FROM users WHERE id=?').get(userId), { db: reopened, now: () => NOW + 5 });
    assert.equal('statusEmojiPermanent' in finiteUser, false);
    assert.equal(finiteUser.statusEmojiExpiresAt, new Date(finiteExpiry).toISOString());
  } finally { reopened.close(); }
});

test('CLI lookup uses the current public username and grant-permanent accepts only the resolved stable UUID', async t => {
  const { dataDir, db, userId } = await fixture(t);
  const base = ['--data-dir', dataDir];
  const cli = (...args) => run(process.execPath, [script, ...args], { timeout: 5000 });
  db.prepare("UPDATE users SET username='current_alice' WHERE id=?").run(userId);
  const lookup = await cli('lookup', ...base, '--username', ' CURRENT_ALICE ');
  assert.deepEqual(JSON.parse(lookup.stdout), {
    accountId: userId, username: 'current_alice', platina: { active: false, expiresAt: null },
  });
  assert.equal(rows(db, 'platina_audit').length, 0);
  await assert.rejects(cli('lookup', ...base, '--username', 'alice'), /Account does not exist/);
  await assert.rejects(cli('grant-permanent', ...base, '--username', 'current_alice', '--reason', 'Synthetic invalid grant'));
  await assert.rejects(cli('grant-permanent', ...base, '--user-id', 'current_alice', '--reason', 'Synthetic invalid grant'));
  // A later public rename does not change the account selected by the UUID.
  db.prepare("UPDATE users SET username='renamed_again' WHERE id=?").run(userId);
  const granted = await cli('grant-permanent', ...base, '--user-id', userId, '--reason', 'Synthetic permanent CLI grant');
  assert.deepEqual(JSON.parse(granted.stdout), { accountId: userId, platina: PERMANENT });
  assert.deepEqual(JSON.parse((await cli('lookup', ...base, '--username', 'renamed_again')).stdout), {
    accountId: userId, username: 'renamed_again', platina: PERMANENT,
  });
  assert.equal(rows(db, 'platina_entitlements')[0].expires_at, null);
  assert.equal(rows(db, 'platina_audit')[0].user_id, userId);
  assert.equal(rows(db, 'platina_audit')[0].expires_at, null);
  await assert.rejects(cli('lookup', ...base, '--username', 'current_alice'), /Account does not exist/);
  const revoked = await cli('revoke', ...base, '--user-id', userId, '--reason', 'Synthetic CLI revocation');
  assert.deepEqual(JSON.parse(revoked.stdout).platina, { ...PERMANENT, active: false });
});

test('invalid or conflicting administrator options cannot grant permanently or create a missing database', async t => {
  const { dataDir, db, userId } = await fixture(t);
  const base = ['--data-dir', dataDir, '--user-id', userId, '--reason', 'Synthetic rejected request'];
  const cli = (...args) => run(process.execPath, [script, ...args], { timeout: 5000 });
  for (const args of [
    ['grant-permanent', ...base, '--expires-at', '2099-01-01T00:00:00Z'],
    ['grant-permanent', ...base, '--permanent', 'true'],
    ['grant-permanent', ...base, '--user-id', userId],
    ['grant-permanent', '--data-dir', dataDir, '--user-id', userId],
    ['grant', ...base],
    ['grant', ...base, '--expires-at', 'null'],
    ['lookup', ...base, '--username', 'alice'],
    ['revoke', ...base, '--expires-at', '2099-01-01T00:00:00Z'],
  ]) await assert.rejects(cli(...args));
  assert.equal(rows(db, 'platina_entitlements').length, 0);
  assert.equal(rows(db, 'platina_audit').length, 0);
  const empty = await directory(t);
  await assert.rejects(cli('lookup', '--data-dir', empty, '--username', 'alice'));
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(empty, 'linea.sqlite')), false);
});
