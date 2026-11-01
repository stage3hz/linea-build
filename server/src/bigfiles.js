import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, stat, statfs, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, fail } from './security.js';

/**
 * Large end-to-end encrypted files (Telegram-like): the client encrypts the file in chunks and
 * uploads them one by one, so a 5 GB video never has to fit in memory and an interrupted
 * upload continues from the last stored byte. The server only ever sees ciphertext.
 *
 * Limits: without Platina 100 MB per file and 2 GB in total; with Platina 5 GB per file and
 * 15 GB in total. An upload is also refused while the disk would drop under a reserve, so
 * one big file cannot fill the server.
 */
const MiB = 1024 * 1024, GiB = 1024 * MiB;
export const DEFAULT_FILE_LIMITS = Object.freeze({
  free: Object.freeze({ file: 100 * MiB, total: 2 * GiB }),
  platina: Object.freeze({ file: 5 * GiB, total: 15 * GiB }),
});
/** Plain bytes per encrypted chunk; each chunk adds a 16-byte authentication tag. */
export const CHUNK_PLAIN = 4 * MiB;
export const CHUNK_TAG = 16;
const SESSION_TTL = 24 * 60 * 60 * 1000;

export const BIG_UPLOAD_SCHEMA = `
CREATE TABLE IF NOT EXISTS e2ee_upload_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS e2ee_upload_sessions_owner ON e2ee_upload_sessions(owner_id);
`;

/** Ciphertext size of a file of `plain` bytes cut into CHUNK_PLAIN chunks. */
export const cipherSize = plain => plain + Math.max(1, Math.ceil(plain / CHUNK_PLAIN)) * CHUNK_TAG;

export function installBigFileRoutes({ app, db, uploadDir, authOptions, limiter, isPlatina, now, timestamp, assertSession,
  limits = DEFAULT_FILE_LIMITS, diskReserveBytes = 5 * GiB, freeDisk = async dir => { const s = await statfs(dir); return s.bavail * s.bsize; } }) {
  db.exec(BIG_UPLOAD_SCHEMA);
  const tier = userId => (isPlatina(userId) ? limits.platina : limits.free);
  const partPath = id => join(uploadDir, `${id}.part`);
  const stored = userId => db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner_id=?').get(userId).bytes;
  // Unfinished uploads hold their full size so parallel uploads cannot overrun the quota.
  const reserved = (userId, except = '') => db.prepare('SELECT COALESCE(SUM(total_size),0) AS bytes FROM e2ee_upload_sessions WHERE owner_id=? AND id<>?').get(userId, except).bytes;
  const usage = userId => stored(userId) + reserved(userId);

  const sweep = async () => {
    const stale = db.prepare('SELECT id FROM e2ee_upload_sessions WHERE updated_at<?').all(now() - SESSION_TTL);
    for (const { id } of stale) { db.prepare('DELETE FROM e2ee_upload_sessions WHERE id=?').run(id); await unlink(partPath(id)).catch(() => {}); }
  };

  const limitsFor = userId => { const t = tier(userId); return { platina: isPlatina(userId), maxFileBytes: t.file, storageBytes: t.total, usedBytes: usage(userId), chunkBytes: CHUNK_PLAIN }; };
  app.get('/e2ee/limits', authOptions, async request => limitsFor(request.auth.user_id));

  // Raw ciphertext chunks arrive as application/octet-stream and are streamed to disk.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.post('/e2ee/uploads', authOptions, async (request, reply) => {
    const ownerId = request.auth.user_id;
    if (!limiter.allow(`upload:${ownerId}`, 20, 60_000)) fail(429, 'Слишком много загрузок. Повторите через минуту.');
    const plain = request.body?.size;
    if (!Number.isSafeInteger(plain) || plain <= 0) fail(400, 'Укажите размер файла.');
    const t = tier(ownerId);
    if (plain > t.file) fail(413, isPlatina(ownerId) ? 'Файл больше 5 ГБ.' : 'Файл больше 100 МБ. С Platina можно отправлять файлы до 5 ГБ.', { code: isPlatina(ownerId) ? 'FILE_TOO_LARGE' : 'PLATINA_REQUIRED' });
    await sweep();
    const total = cipherSize(plain);
    if (usage(ownerId) + total > t.total) fail(413, `Достигнут лимит хранения (${Math.round(t.total / GiB)} ГБ). Удали старые файлы из чатов.`, { code: 'STORAGE_FULL' });
    const free = await freeDisk(uploadDir);
    if (free - total < diskReserveBytes) fail(507, 'На сервере закончилось место для больших файлов. Попробуй позже.', { code: 'SERVER_FULL' });
    const id = randomUUID(), at = now();
    db.prepare('INSERT INTO e2ee_upload_sessions(id,owner_id,total_size,received,created_at,updated_at) VALUES(?,?,?,0,?,?)').run(id, ownerId, total, at, at);
    return reply.code(201).send({ id, received: 0, totalBytes: total, chunkBytes: CHUNK_PLAIN });
  });

  const session = (request) => {
    const row = db.prepare('SELECT * FROM e2ee_upload_sessions WHERE id=? AND owner_id=?').get(request.params.id, request.auth.user_id);
    if (!row) fail(404, 'Загрузка не найдена. Начни отправку заново.');
    return row;
  };

  app.get('/e2ee/uploads/:id', authOptions, async request => { const row = session(request); return { id: row.id, received: row.received, totalBytes: row.total_size }; });

  // One encrypted chunk, appended at `offset`. A wrong offset answers with what the server has,
  // so the client can resume from there after a lost connection.
  app.put('/e2ee/uploads/:id', { ...authOptions, bodyLimit: CHUNK_PLAIN + CHUNK_TAG + 1024 }, async request => {
    const row = session(request);
    const offset = Number(request.query?.offset);
    if (!Number.isSafeInteger(offset) || offset !== row.received) fail(409, 'Загрузка продолжится с сохранённого места.', { code: 'OFFSET_MISMATCH', received: row.received });
    if (!request.body || typeof request.body.pipe !== 'function') fail(400, 'Нужен бинарный фрагмент файла.');
    const limit = Math.min(CHUNK_PLAIN + CHUNK_TAG, row.total_size - offset);
    let size = 0;
    const count = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; if (size > limit) { callback(new HttpError(413, 'Фрагмент больше допустимого.')); return; } callback(null, chunk); } });
    const path = partPath(row.id);
    // Truncate anything a broken earlier attempt left past the confirmed offset.
    const onDisk = await stat(path).then(info => info.size).catch(() => 0);
    if (onDisk !== offset) {
      if (onDisk > offset) await truncate(path, offset); else if (offset > 0) fail(409, 'Загрузка повреждена. Начни отправку заново.', { code: 'UPLOAD_LOST' });
    }
    await pipeline(request.body, count, createWriteStream(path, { flags: offset ? 'r+' : 'w', start: offset, mode: 0o600 }));
    if (!size) fail(400, 'Пустой фрагмент.');
    if (size !== limit) fail(400, 'Неполный фрагмент. Он будет отправлен заново.', { code: 'OFFSET_MISMATCH', received: offset });
    const received = offset + size;
    db.prepare('UPDATE e2ee_upload_sessions SET received=?, updated_at=? WHERE id=?').run(received, now(), row.id);
    return { received, totalBytes: row.total_size };
  });

  app.post('/e2ee/uploads/:id/complete', authOptions, async (request, reply) => {
    const row = session(request);
    if (row.received !== row.total_size) fail(409, 'Файл загружен не полностью.', { code: 'OFFSET_MISMATCH', received: row.received });
    const size = await stat(partPath(row.id)).then(info => info.size).catch(() => -1);
    if (size !== row.total_size) fail(409, 'Загрузка повреждена. Начни отправку заново.', { code: 'UPLOAD_LOST' });
    const t = tier(row.owner_id);
    if (stored(row.owner_id) + reserved(row.owner_id, row.id) + size > t.total) fail(413, 'Достигнут лимит хранения файлов.', { code: 'STORAGE_FULL' });
    assertSession(request);
    await rename(partPath(row.id), join(uploadDir, row.id));
    db.prepare('DELETE FROM e2ee_upload_sessions WHERE id=?').run(row.id);
    db.prepare("INSERT INTO uploads(id,owner_id,name,mime_type,size,is_image,is_encrypted,created_at) VALUES(?,?,'encrypted.bin','application/octet-stream',?,0,1,?)").run(row.id, row.owner_id, size, timestamp());
    return reply.code(201).send({ id: row.id, size });
  });

  app.delete('/e2ee/uploads/:id', authOptions, async request => {
    const row = session(request);
    db.prepare('DELETE FROM e2ee_upload_sessions WHERE id=?').run(row.id);
    await unlink(partPath(row.id)).catch(() => {});
    return { ok: true };
  });

  return { usage, tier, limitsFor };
}
