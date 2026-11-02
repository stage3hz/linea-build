// Online backup helpers, run inside the api container by deploy/autobackup.sh.
//   node src/backup.js snapshot <out.sqlite>   consistent copy of the live database (VACUUM INTO,
//                                               no downtime), prints its manifest as JSON
//   node src/backup.js verify <copy.sqlite> [manifest.json]
//                                               integrity check of a restored copy; with a manifest,
//                                               also checks that the row counts match the snapshot
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COUNTED = ['users', 'sessions', 'chats', 'messages', 'contacts', 'communities', 'community_messages', 'uploads', 'platina_entitlements'];

export function counts(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  return Object.fromEntries(COUNTED.filter(name => tables.has(name)).map(name => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
}

export function snapshot(dataDir, out) {
  const target = resolve(out);
  if (existsSync(target)) throw new Error('Snapshot target already exists');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    // VACUUM INTO writes a transactionally consistent copy while the server keeps running.
    db.prepare('VACUUM INTO ?').run(target);
  } finally { db.close(); }
  // A standalone file (no WAL), so it can be checked on a read-only mount and restored as is.
  const standalone = new DatabaseSync(target);
  try { standalone.exec('PRAGMA journal_mode = DELETE'); } finally { standalone.close(); }
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    return { format: 1, createdAt: new Date().toISOString(), bytes: statSync(target).size, counts: counts(copy) };
  } finally { copy.close(); }
}

export function verify(file, manifest) {
  const db = new DatabaseSync(resolve(file), { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]);
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`integrity_check: ${integrity.slice(0, 3).join('; ')}`);
    const foreign = db.prepare('PRAGMA foreign_key_check').all();
    if (foreign.length) throw new Error(`foreign_key_check: ${foreign.length} broken references`);
    const found = counts(db);
    if (manifest) for (const [name, expected] of Object.entries(manifest.counts || {})) {
      if (found[name] !== expected) throw new Error(`row count ${name}: ${found[name]} in the copy, ${expected} at snapshot`);
    }
    return { ok: true, counts: found };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, file, manifestFile] = process.argv.slice(2);
  try {
    if (command === 'snapshot' && file) process.stdout.write(JSON.stringify(snapshot(process.env.DATA_DIR || '/data', file)) + '\n');
    else if (command === 'verify' && file) process.stdout.write(JSON.stringify(verify(file, manifestFile ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null)) + '\n');
    else { process.stderr.write('Usage: node src/backup.js snapshot <out> | verify <file> [manifest]\n'); process.exitCode = 2; }
  } catch (error) { process.stderr.write(`Backup check failed: ${error.message}\n`); process.exitCode = 1; }
}
