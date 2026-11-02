import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { snapshot, verify } from '../src/backup.js';

test('online snapshot of a running server is consistent and verifies; tampering is caught', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-backup-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000 }); await app.ready();
  t.after(() => app.close());
  for (const name of ['alice', 'bobby']) {
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: name, displayName: name, password: 'correct horse battery', recoveryWord: 'гранитный', confirmationWord: 'ласточкин' } });
    assert.equal(r.statusCode, 201, r.body);
  }
  const out = path.join(dataDir, 'snap.sqlite');
  const manifest = snapshot(dataDir, out);            // while the app keeps the database open
  assert.equal(manifest.counts.users, 2);
  assert.deepEqual(verify(out, manifest).counts.users, 2);
  assert.throws(() => snapshot(dataDir, out), /already exists/);
  // A copy that lost rows does not pass as this snapshot.
  const db = new DatabaseSync(out); db.exec('PRAGMA foreign_keys=OFF; DELETE FROM sessions;'); db.close();
  assert.throws(() => verify(out, manifest), /row count sessions/);
  // A damaged file is rejected.
  const bytes = await readFile(out); bytes.fill(0x41, 4096, 8192); await writeFile(out, bytes);
  assert.throws(() => verify(out, manifest));
});
