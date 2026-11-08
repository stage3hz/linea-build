import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { CHUNK_PLAIN, CHUNK_TAG, cipherSize } from '../src/bigfiles.js';

const MiB = 1024 * 1024;
const PASSWORD = 'Synthetic!Orchid.87.Wind';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-big-test-'));
  let disk = 1000 * 1024 * MiB;
  const app = await buildApp({ dataDir, authRateLimit: false, diskReserveBytes: 50 * MiB, freeDisk: async () => disk,
    fileLimits: { free: { file: 5 * MiB, total: 20 * MiB }, platina: { file: 12 * MiB, total: 30 * MiB } }, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const sql = op => { const db = new DatabaseSync(join(dataDir, 'linea.sqlite')); try { return op(db); } finally { db.close(); } };
  return { app, dataDir, sql, setDisk: bytes => { disk = bytes; } };
}
const call = (app, method, url, account, payload, headers = {}) => app.inject({ method, url, headers: { authorization: `Bearer ${account.token}`, ...headers }, ...(payload === undefined ? {} : { payload }) });
async function register(app, username) {
  const result = await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: username, password: PASSWORD, confirmationWord: 'корабль', recoveryWord: 'астра' } });
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}
const grant = (sql, userId) => sql(db => db.prepare("INSERT INTO platina_entitlements(user_id,grant_id,source,granted_at,expires_at,revoked_at) VALUES(?,?,'admin',?,NULL,NULL)").run(userId, randomUUID(), Date.now()));
const put = (app, account, id, offset, bytes) => call(app, 'PUT', `/e2ee/uploads/${id}?offset=${offset}`, account, bytes, { 'content-type': 'application/octet-stream' });

test('big files: tier limits, chunked resumable upload, ranges', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'alice_big');
  let limits = (await call(f.app, 'GET', '/e2ee/limits', alice)).json();
  assert.equal(limits.platina, false); assert.equal(limits.maxFileBytes, 5 * MiB); assert.equal(limits.chunkBytes, CHUNK_PLAIN);
  const tooBig = await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 6 * MiB });
  assert.equal(tooBig.statusCode, 413); assert.equal(tooBig.json().code, 'PLATINA_REQUIRED');

  grant(f.sql, alice.user.id);
  limits = (await call(f.app, 'GET', '/e2ee/limits', alice)).json();
  assert.equal(limits.platina, true); assert.equal(limits.maxFileBytes, 12 * MiB);

  const plain = 9 * MiB, total = cipherSize(plain);
  assert.equal(total, plain + 3 * CHUNK_TAG);
  const started = await call(f.app, 'POST', '/e2ee/uploads', alice, { size: plain });
  assert.equal(started.statusCode, 201, started.body);
  const { id } = started.json();
  assert.equal((await call(f.app, 'GET', '/e2ee/limits', alice)).json().usedBytes, total, 'the upload reserves its size');
  const data = randomBytes(total);
  const full = CHUNK_PLAIN + CHUNK_TAG;
  assert.equal((await put(f.app, alice, id, 0, data.subarray(0, full))).json().received, full);
  // A lost reply: the client retries the same chunk and learns where to continue.
  const again = await put(f.app, alice, id, 0, data.subarray(0, full));
  assert.equal(again.statusCode, 409); assert.equal(again.json().received, full);
  const short = await put(f.app, alice, id, full, data.subarray(full, full + 100));
  assert.equal(short.statusCode, 400, 'a cut chunk is not counted');
  assert.equal((await call(f.app, 'GET', `/e2ee/uploads/${id}`, alice)).json().received, full);
  assert.equal((await put(f.app, alice, id, full, data.subarray(full, 2 * full))).statusCode, 200);
  assert.equal((await call(f.app, 'POST', `/e2ee/uploads/${id}/complete`, alice)).statusCode, 409, 'not finished yet');
  assert.equal((await put(f.app, alice, id, 2 * full, data.subarray(2 * full))).json().received, total);
  const done = await call(f.app, 'POST', `/e2ee/uploads/${id}/complete`, alice);
  assert.equal(done.statusCode, 201, done.body);
  assert.deepEqual(done.json(), { id, size: total });
  assert.deepEqual(await readFile(join(f.dataDir, 'uploads', id)), data);
  assert.equal((await call(f.app, 'GET', '/e2ee/limits', alice)).json().usedBytes, total);

  const whole = await call(f.app, 'GET', `/files/${id}`, alice);
  assert.equal(whole.statusCode, 200); assert.equal(whole.rawPayload.length, total);
  const part = await call(f.app, 'GET', `/files/${id}`, alice, undefined, { range: `bytes=${full}-${2 * full - 1}` });
  assert.equal(part.statusCode, 206); assert.equal(part.headers['content-range'], `bytes ${full}-${2 * full - 1}/${total}`);
  assert.deepEqual(part.rawPayload, data.subarray(full, 2 * full));
  assert.equal((await call(f.app, 'GET', `/files/${id}`, alice, undefined, { range: `bytes=${total}-` })).statusCode, 416);
  const bob = await register(f.app, 'bob_big');
  assert.equal((await call(f.app, 'GET', `/files/${id}`, bob, undefined, { range: 'bytes=0-9' })).statusCode, 404, 'ranges keep the access check');
});

test('big files: storage quota, server disk reserve, cancel frees the reservation', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'alice_quota');
  grant(f.sql, alice.user.id);
  const a = (await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 12 * MiB })).json();
  const b = (await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 12 * MiB })).json();
  const c = await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 12 * MiB });
  assert.equal(c.statusCode, 413); assert.equal(c.json().code, 'STORAGE_FULL');
  assert.equal((await call(f.app, 'DELETE', `/e2ee/uploads/${b.id}`, alice)).statusCode, 200);
  f.setDisk(55 * MiB);
  const d = await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 12 * MiB });
  assert.equal(d.statusCode, 507); assert.equal(d.json().code, 'SERVER_FULL');
  const bob = await register(f.app, 'bob_quota');
  assert.equal((await put(f.app, bob, a.id, 0, randomBytes(10))).statusCode, 404, 'someone else cannot write into an upload');
});

test('big files: a video may be bigger than other files; Platina raises only files', async t => {
  const f = await fixture(t, { fileLimits: { free: { file: 5 * MiB, video: 12 * MiB, total: 40 * MiB }, platina: { file: 8 * MiB, video: 12 * MiB, total: 40 * MiB } } });
  const alice = await register(f.app, 'alice_video');
  let limits = (await call(f.app, 'GET', '/e2ee/limits', alice)).json();
  assert.equal(limits.maxFileBytes, 5 * MiB); assert.equal(limits.maxVideoBytes, 12 * MiB);
  const file = await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 6 * MiB });
  assert.equal(file.statusCode, 413); assert.equal(file.json().code, 'PLATINA_REQUIRED');
  assert.equal((await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 10 * MiB, kind: 'video' })).statusCode, 201, 'a video needs no Platina');
  const huge = await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 13 * MiB, kind: 'video' });
  assert.equal(huge.statusCode, 413); assert.equal(huge.json().code, 'FILE_TOO_LARGE'); assert.match(huge.body, /Видео больше 12 МБ/);
  grant(f.sql, alice.user.id);
  limits = (await call(f.app, 'GET', '/e2ee/limits', alice)).json();
  assert.equal(limits.maxFileBytes, 8 * MiB); assert.equal(limits.maxVideoBytes, 12 * MiB);
  assert.equal((await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 7 * MiB })).statusCode, 201);
  const big = await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 9 * MiB });
  assert.equal(big.json().code, 'FILE_TOO_LARGE'); assert.match(big.body, /Файл больше 8 МБ\./);
  assert.equal((await call(f.app, 'POST', '/e2ee/uploads', alice, { size: MiB, kind: 'audio' })).statusCode, 400);
});

test('big files: default limits — video 10 GB for everyone, files 2 GB (4 GB with Platina)', async () => {
  const { DEFAULT_FILE_LIMITS: L } = await import('../src/bigfiles.js');
  const GiB = 1024 * MiB;
  assert.deepEqual([L.free.file, L.free.video, L.platina.file, L.platina.video], [2 * GiB, 10 * GiB, 4 * GiB, 10 * GiB]);
  for (const tier of [L.free, L.platina]) assert.ok(tier.total >= tier.video, 'one video fits the storage');
});
