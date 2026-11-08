import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, stat, statfs, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, fail } from './security.js';

/**
 * Large end-to-end encrypted files (Telegram-like): the client encrypts the file in chunks and
 * uploads them one by one, so a 10 GB video never has to fit in memory and an interrupted
 * upload continues from the last stored byte. The server only ever sees ciphertext.
 *
 * Limits (Telegram-like: 2 GB per file, 4 GB with Premium): a video up to 10 GB for everyone;
 * other files up to 2 GB, 4 GB with Platina. Storage per account: 20 GB, 40 GB with Platina
 * (Telegram has no such quota, but this server is one machine). The server cannot see that a file is a video (it is
 * encrypted): the app declares `kind: 'video'` for files whose content it recognised as video and
 * cleaned of metadata. A dishonest client gains nothing beyond its own quota. An upload is also refused while the disk would drop under a reserve, so
 * one big file cannot fill the server.
 */
const MiB = 1024 * 1024, GiB = 1024 * MiB;
export const DEFAULT_FILE_LIMITS = Object.freeze({
  free: Object.freeze({ file: 2 * GiB, video: 10 * GiB, total: 20 * GiB }),
  platina: Object.freeze({ file: 4 * GiB, video: 10 * GiB, total: 40 * GiB }),
});
/** Plain bytes per encrypted chunk; each chunk adds a 16-byte authentication tag. */
export const CHUNK_PLAIN = 4 * MiB;
export const CHUNK_TAG = 16;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const SWEEP_EVERY = 60 * 60 * 1000;

/**
 * Per-session request lock where the newest request wins. A request half-sent and then silent (the phone switched
 * networks) would otherwise hold the session until the connection timeout: the newcomer destroys its connection,
 * which fails its pipeline at once, waits until it has fully finished, then runs alone.
 */
export function sessionLocks() {
  const inflight = new Map(); // id -> { request, released }
  // `upload`: the request streams a chunk; only such a request is cut off by a newcomer (complete and cancel are awaited).
  return async (id, request, work, { upload = false } = {}) => {
    for (let current = inflight.get(id); current; current = inflight.get(id)) {
      if (current.upload) current.request.raw.destroy();
      await current.released;
    }
    let release;
    const entry = { request, upload, released: new Promise(resolve => { release = resolve; }) };
    inflight.set(id, entry);
    try { return await work(); }
    finally { if (inflight.get(id) === entry) inflight.delete(id); release(); }
  };
}

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
/**
 * Bytes every unfinished chunked upload (encrypted and plaintext) may still write. The disk reserve is checked
 * against free space minus this, so parallel big uploads cannot together fill the disk (SQLite would then fail).
 */
export function diskOutstanding(db) {
  let bytes = 0;
  for (const table of ['e2ee_upload_sessions', 'plain_upload_sessions']) {
    if (hasTable(db, table)) bytes += db.prepare(`SELECT COALESCE(SUM(total_size-received),0) AS bytes FROM ${table}`).get().bytes;
  }
  return bytes;
}

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

export function installBigFileRoutes({ app, db, uploadDir, authOptions, limiter, isPlatina, now, timestamp, assertSession, writable = () => true,
  limits = DEFAULT_FILE_LIMITS, extraReserved = () => 0, diskReserveBytes = 5 * GiB, freeDisk = async dir => { const s = await statfs(dir); return s.bavail * s.bsize; } }) {
  db.exec(BIG_UPLOAD_SCHEMA);
  const tier = userId => (isPlatina(userId) ? limits.platina : limits.free);
  const videoLimit = t => Math.max(t.file, t.video ?? t.file);
  const sizeLabel = bytes => bytes >= GiB ? `${+(bytes / GiB).toFixed(1)} ГБ` : `${Math.round(bytes / MiB)} МБ`;
  const partPath = id => join(uploadDir, `${id}.part`);
  const stored = userId => db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner_id=?').get(userId).bytes;
  // Unfinished uploads hold their full size so parallel uploads cannot overrun the quota.
  const reserved = (userId, except = '') => db.prepare('SELECT COALESCE(SUM(total_size),0) AS bytes FROM e2ee_upload_sessions WHERE owner_id=? AND id<>?').get(userId, except).bytes;
  // Chunked plaintext uploads (plainuploads.js) reserve from the same storage.
  const usage = userId => stored(userId) + reserved(userId) + extraReserved(userId);

  const sweep = async () => {
    const stale = db.prepare('SELECT id FROM e2ee_upload_sessions WHERE updated_at<?').all(now() - SESSION_TTL);
    for (const { id } of stale) { db.prepare('DELETE FROM e2ee_upload_sessions WHERE id=?').run(id); await unlink(partPath(id)).catch(() => {}); }
  };

  // Startup and hourly: abandoned sessions free their quota and `.part` files even when nobody uploads.
  // A cluster replica (not writable) leaves the rows and files to the primary.
  const sweepIfPrimary = () => { if (writable()) sweep().catch(() => {}); };
  sweepIfPrimary();
  const sweeper = setInterval(sweepIfPrimary, SWEEP_EVERY);
  sweeper.unref?.();
  app.addHook('onClose', async () => clearInterval(sweeper));
  // One request at a time per session, the last one wins (sessionLocks): a slow PUT never writes into a file that
  // /complete already moved, and a PUT that went silent (Wi-Fi ↔ LTE) never blocks the retry or the cancel.
  const exclusive = sessionLocks();

  const limitsFor = userId => { const t = tier(userId); return { platina: isPlatina(userId), maxFileBytes: t.file, maxVideoBytes: videoLimit(t), storageBytes: t.total, usedBytes: usage(userId), chunkBytes: CHUNK_PLAIN }; };
  app.get('/e2ee/limits', authOptions, async request => limitsFor(request.auth.user_id));

  // Raw ciphertext chunks arrive as application/octet-stream and are streamed to disk.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.post('/e2ee/uploads', authOptions, async (request, reply) => {
    const ownerId = request.auth.user_id;
    if (!limiter.allow(`upload:${ownerId}`, 20, 60_000)) fail(429, 'Слишком много загрузок. Повторите через минуту.');
    const plain = request.body?.size;
    if (!Number.isSafeInteger(plain) || plain <= 0) fail(400, 'Укажите размер файла.');
    const kind = request.body?.kind;
    if (kind !== undefined && kind !== 'video' && kind !== 'file') fail(400, 'Неизвестный тип файла.');
    const t = tier(ownerId), video = kind === 'video', max = video ? videoLimit(t) : t.file;
    if (plain > max) {
      // Platina only raises the limit of ordinary files; videos have one limit for everyone.
      const platina = isPlatina(ownerId), upgrade = !video && !platina && limits.platina.file > max;
      fail(413, upgrade
        ? `Файл больше ${sizeLabel(max)}. С Platina можно отправлять файлы до ${sizeLabel(limits.platina.file)}.`
        : `${video ? 'Видео' : 'Файл'} больше ${sizeLabel(max)}.`,
        { code: upgrade ? 'PLATINA_REQUIRED' : 'FILE_TOO_LARGE' });
    }
    await sweep();
    const total = cipherSize(plain);
    if (usage(ownerId) + total > t.total) fail(413, `Достигнут лимит хранения (${Math.round(t.total / GiB)} ГБ). Удали старые файлы из чатов.`, { code: 'STORAGE_FULL' });
    const free = await freeDisk(uploadDir);
    if (free - diskOutstanding(db) - total < diskReserveBytes) fail(507, 'На сервере закончилось место для больших файлов. Попробуй позже.', { code: 'SERVER_FULL' });
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
  // The route bodyLimit does not apply to the raw stream parser: the counting Transform is the real limit.
  app.put('/e2ee/uploads/:id', { ...authOptions, bodyLimit: CHUNK_PLAIN + CHUNK_TAG + 1024 }, async (request, reply) => {
    // Ownership first: only the owner's own request may take over the session.
    session(request);
    try { return await exclusive(request.params.id, request, () => putChunk(request), { upload: true }); }
    catch (error) {
      // An answer before the body was read whole (an over-long chunk): the rest is still on the socket, so it must not be reused.
      if (!request.raw.complete) reply.header('Connection', 'close');
      throw error;
    }
  });
  const putChunk = async request => {
    const row = session(request);
    const offset = Number(request.query?.offset);
    if (!Number.isSafeInteger(offset) || offset !== row.received) fail(409, 'Загрузка продолжится с сохранённого места.', { code: 'OFFSET_MISMATCH', received: row.received });
    if (!request.body || typeof request.body.pipe !== 'function') fail(400, 'Нужен бинарный фрагмент файла.');
    const limit = Math.min(CHUNK_PLAIN + CHUNK_TAG, row.total_size - offset);
    let size = 0;
    const count = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; if (size > limit) { callback(new HttpError(413, 'Фрагмент больше допустимого.')); return; } callback(null, chunk); } });
    if ((await freeDisk(uploadDir)) < diskReserveBytes / 2) fail(507, 'На сервере закончилось место для больших файлов. Попробуй позже.', { code: 'SERVER_FULL' });
    const path = partPath(row.id);
    // Truncate anything a broken earlier attempt left past the confirmed offset.
    const onDisk = await stat(path).then(info => info.size).catch(() => -1);
    if (onDisk !== offset) {
      if (onDisk > offset) await truncate(path, offset); else if (offset > 0) fail(409, 'Загрузка повреждена. Начни отправку заново.', { code: 'UPLOAD_LOST' });
    }
    // The part file is created only for the first chunk and only when missing; later chunks write into it ('r+').
    await pipeline(request.body, count, createWriteStream(path, { flags: onDisk < 0 ? 'wx' : 'r+', start: offset, mode: 0o600 }));
    // The session went away meanwhile (account deleted): the chunk must not leave a `.part` behind.
    if (!db.prepare('SELECT 1 FROM e2ee_upload_sessions WHERE id=?').get(row.id)) { await unlink(path).catch(() => {}); fail(404, 'Загрузка не найдена. Начни отправку заново.'); }
    if (!size) fail(400, 'Пустой фрагмент.');
    if (size !== limit) fail(400, 'Неполный фрагмент. Он будет отправлен заново.', { code: 'OFFSET_MISMATCH', received: offset });
    const received = offset + size;
    db.prepare('UPDATE e2ee_upload_sessions SET received=?, updated_at=? WHERE id=?').run(received, now(), row.id);
    return { received, totalBytes: row.total_size };
  };

  app.post('/e2ee/uploads/:id/complete', authOptions, async (request, reply) => { session(request); return exclusive(request.params.id, request, async () => {
    const row = session(request);
    if (row.received !== row.total_size) fail(409, 'Файл загружен не полностью.', { code: 'OFFSET_MISMATCH', received: row.received });
    const size = await stat(partPath(row.id)).then(info => info.size).catch(() => -1);
    if (size !== row.total_size) fail(409, 'Загрузка повреждена. Начни отправку заново.', { code: 'UPLOAD_LOST' });
    const t = tier(row.owner_id);
    if (stored(row.owner_id) + reserved(row.owner_id, row.id) + extraReserved(row.owner_id) + size > t.total) fail(413, 'Достигнут лимит хранения файлов.', { code: 'STORAGE_FULL' });
    assertSession(request);
    try { await rename(partPath(row.id), join(uploadDir, row.id)); }
    catch { fail(409, 'Загрузка повреждена. Начни отправку заново.', { code: 'UPLOAD_LOST' }); }
    db.prepare('DELETE FROM e2ee_upload_sessions WHERE id=?').run(row.id);
    db.prepare("INSERT INTO uploads(id,owner_id,name,mime_type,size,is_image,is_encrypted,created_at) VALUES(?,?,'encrypted.bin','application/octet-stream',?,0,1,?)").run(row.id, row.owner_id, size, timestamp());
    return reply.code(201).send({ id: row.id, size });
  }); });

  // A cancel takes over a hanging PUT too, so the reservation is freed now, not after 24 h.
  app.delete('/e2ee/uploads/:id', authOptions, async request => { session(request); return exclusive(request.params.id, request, async () => {
    const row = session(request);
    db.prepare('DELETE FROM e2ee_upload_sessions WHERE id=?').run(row.id);
    await unlink(partPath(row.id)).catch(() => {});
    return { ok: true };
  }); });

  return { usage, tier, limitsFor, stored, reservedEncrypted: userId => reserved(userId), isPlatina, limits };
}
