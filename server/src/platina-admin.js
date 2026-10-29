import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from './database.js';
import { platinaState } from './entitlements.js';
import { usernameValue } from './security.js';

function validated(db, userId, reason, time) {
  if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new Error('A stable account UUID is required');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) throw new Error('A short administrator reason is required');
  if (!Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000) throw new Error('Invalid server time');
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw new Error('Account does not exist');
  return reason.trim();
}

function writeGrant(db, userId, expiresAt, note, time) {
  return transaction(db, () => {
    const grantId = randomUUID();
    db.prepare(`INSERT INTO platina_entitlements(user_id,grant_id,source,granted_at,expires_at,revoked_at) VALUES(?,?,'admin',?,?,NULL)
      ON CONFLICT(user_id) DO UPDATE SET grant_id=excluded.grant_id,source='admin',granted_at=excluded.granted_at,expires_at=excluded.expires_at,revoked_at=NULL`)
      .run(userId, grantId, time, expiresAt);
    db.prepare("INSERT INTO platina_audit(id,user_id,grant_id,action,expires_at,reason,created_at) VALUES(?,?,?,'grant',?,?,?)")
      .run(randomUUID(), userId, grantId, expiresAt, note, time);
    return { accountId: userId, platina: platinaState(db, userId, time) };
  });
}

/** Trusted local operations only. Never install these as public HTTP handlers. */
export function grantPlatina(db, { userId, expiresAt, reason }, time = Date.now()) {
  const note = validated(db, userId, reason, time);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= time || expiresAt > 8_640_000_000_000_000) throw new Error('Expiry must be a future UTC timestamp');
  return writeGrant(db, userId, expiresAt, note, time);
}

export function grantPermanentPlatina(db, { userId, reason }, time = Date.now()) {
  const note = validated(db, userId, reason, time);
  return writeGrant(db, userId, null, note, time);
}

/** Resolve only the current public name; never fall back to the private login. */
export function lookupPlatinaAccount(db, username, time = Date.now()) {
  const user = db.prepare('SELECT id,username FROM users WHERE username=?').get(usernameValue(username));
  if (!user) throw new Error('Account does not exist');
  return { accountId: user.id, username: user.username, platina: platinaState(db, user.id, time) };
}

export function revokePlatina(db, { userId, reason }, time = Date.now()) {
  const note = validated(db, userId, reason, time);
  return transaction(db, () => {
    const grant = db.prepare('SELECT grant_id,expires_at,revoked_at FROM platina_entitlements WHERE user_id=?').get(userId);
    if (grant && grant.revoked_at === null) {
      db.prepare('UPDATE platina_entitlements SET revoked_at=? WHERE user_id=?').run(time, userId);
      db.prepare("INSERT INTO platina_audit(id,user_id,grant_id,action,expires_at,reason,created_at) VALUES(?,?,?,'revoke',?,?,?)")
        .run(randomUUID(), userId, grant.grant_id, grant.expires_at, note, time);
    }
    return { accountId: userId, platina: platinaState(db, userId, time) };
  });
}

const COMMAND_ARGUMENTS = new Map([
  ['lookup', ['--data-dir', '--username']],
  ['grant', ['--data-dir', '--user-id', '--reason', '--expires-at']],
  ['grant-permanent', ['--data-dir', '--user-id', '--reason']],
  ['revoke', ['--data-dir', '--user-id', '--reason']],
]);

function commandOptions(args) {
  const [action, ...rest] = args;
  const allowed = COMMAND_ARGUMENTS.get(action);
  if (!allowed || rest.length % 2) throw new Error('Usage: platina-admin.js lookup --data-dir <existing-dir> --username <current-name> | grant|grant-permanent|revoke --data-dir <existing-dir> --user-id <UUID> --reason <text> [grant only: --expires-at <UTC-ISO>]');
  const options = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.includes(key) || options.has(key) || !value) throw new Error('Invalid administrator arguments');
    options.set(key, value);
  }
  for (const key of allowed) if (!options.has(key)) throw new Error(`Missing ${key}`);
  return { action, options };
}

function readOnlyDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version < 4 || version > 5) throw new Error('Lookup requires an existing Linea schema 4 or 5');
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch (error) { db.close(); throw error; }
}

function main(args) {
  const { action, options } = commandOptions(args);
  const directory = realpathSync(resolve(options.get('--data-dir')));
  const filename = join(directory, 'linea.sqlite');
  if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw new Error('An existing regular Linea database is required');
  const expiry = options.get('--expires-at');
  if (action === 'grant' && (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry))) throw new Error('Grant requires --expires-at in UTC ISO format');
  const db = action === 'lookup' ? readOnlyDatabase(filename) : openDatabase(directory);
  try {
    const input = { userId: options.get('--user-id'), reason: options.get('--reason'), expiresAt: Date.parse(expiry) };
    let result;
    if (action === 'lookup') result = lookupPlatinaAccount(db, options.get('--username'));
    else if (action === 'grant') result = grantPlatina(db, input);
    else if (action === 'grant-permanent') result = grantPermanentPlatina(db, input);
    else result = revokePlatina(db, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`Platina operation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
