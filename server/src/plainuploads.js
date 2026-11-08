import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rename, stat, statfs, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publicAttachment } from './database.js';
import { videoMime } from './cosmetics.js';
import { HttpError, fail, imageMime, safeFilename, safeMime } from './security.js';
import { CHUNK_PLAIN, diskOutstanding, sessionLocks } from './bigfiles.js';

/**
 * Big plaintext uploads (channels, profile posts and stories) in resumable chunks — the same design as the
 * end-to-end encrypted big files (bigfiles.js), but the result is an ordinary upload: a channel file or a
 * profile post, stored as is, served by GET /files/:id with byte ranges. The app has already cleaned the
 * file of metadata (streamed cleaner, the same one the encrypted uploads use); the server never sees the
 * original. Media are never refused for their size below the account limits: a video up to 10 GB for
 * everyone, other files up to 2 GB (4 GB with Platina), all counted in the same per-account storage.
 *
 * Chunks are CHUNK_PLAIN (4 MiB) plain bytes each, the last one shorter; a wrong offset answers with what the
 * server has, so the client resumes from there after a lost connection.
 */
const MiB = 1024 * 1024, GiB = 1024 * MiB;
const SESSION_TTL = 24 * 60 * 60 * 1000;
/** Where a chunked plaintext upload may end up. A story is a profile post with a 24 h life (posts.js). */
const PURPOSES = Object.freeze({ channel: 'channel', post: 'post', story: 'post' });
const SWEEP_EVERY = 60 * 60 * 1000;
const ISO_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'junk', 'JUNK', 'pnot', 'PICT']);
/**
 * The start of a video container the app's streamed cleaner produces (MP4/MOV, also without ftyp or after free
 * boxes; Matroska/WebM, AVI, MPEG-PS/ES, FLV, ASF, MPEG-TS/M2TS). Only MP4/MOV is shown as playable media; the
 * rest is a file. A plaintext upload declared as `kind: 'video'` (the 10 GB limit) must start like one.
 */
export function videoContainer(head) {
  if (head.length >= 8 && ISO_BOXES.has(head.subarray(4, 8).toString('latin1'))) return true;
  const starts = bytes => bytes.every((value, index) => head[index] === value);
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) return true;
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'AVI ') return true;
  if (starts([0, 0, 1, 0xba]) || starts([0, 0, 1, 0xb3])) return true;
  if (head.length >= 4 && head.subarray(0, 3).toString('latin1') === 'FLV' && head[3] === 1) return true;
  if (starts([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return true;
  // MPEG-TS / M2TS: the sync byte of three packets in a row (188, 192 with a 4-byte prefix, 204), as the app checks.
  return [[188, 0], [192, 4], [204, 0]].some(([size, sync]) => head.length >= sync + size * 3 && [0, 1, 2].every(k => head[sync + k * size] === 0x47));
}

export const PLAIN_UPLOAD_SCHEMA = `
CREATE TABLE IF NOT EXISTS plain_upload_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plain_upload_sessions_owner ON plain_upload_sessions(owner_id);
`;

export function installPlainUploadRoutes({ app, db, uploadDir, authOptions, limiter, bigFiles, now, timestamp, sessionStillValid, writable = () => true,
  diskReserveBytes = 5 * GiB, freeDisk = async dir => { const s = await statfs(dir); return s.bavail * s.bsize; } }) {
  db.exec(PLAIN_UPLOAD_SCHEMA);
  const { tier, stored, reservedEncrypted, limitsFor } = bigFiles;
  const videoLimit = t => Math.max(t.file, t.video ?? t.file);
  const sizeLabel = bytes => bytes >= GiB ? `${+(bytes / GiB).toFixed(1)} ГБ` : `${Math.round(bytes / MiB)} МБ`;
  const partPath = id => join(uploadDir, `${id}.part`);
  /** Unfinished plaintext uploads hold their full size, like the encrypted ones. */
  const reserved = (userId, except = '') => db.prepare('SELECT COALESCE(SUM(total_size),0) AS bytes FROM plain_upload_sessions WHERE owner_id=? AND id<>?').get(userId, except).bytes;
  const usage = (userId, except = '') => stored(userId) + reservedEncrypted(userId) + reserved(userId, except);

  const sweep = async () => {
    const stale = db.prepare('SELECT id FROM plain_upload_sessions WHERE updated_at<?').all(now() - SESSION_TTL);
    for (const { id } of stale) { db.prepare('DELETE FROM plain_upload_sessions WHERE id=?').run(id); await unlink(partPath(id)).catch(() => {}); }
  };
  // Startup and hourly: abandoned sessions free their quota and their `.part` files even when nobody uploads.
  // A cluster replica (not writable) leaves the rows and files to the primary.
  const sweepIfPrimary = () => { if (writable()) sweep().catch(() => {}); };
  sweepIfPrimary();
  const sweeper = setInterval(sweepIfPrimary, SWEEP_EVERY);
  sweeper.unref?.();
  app.addHook('onClose', async () => clearInterval(sweeper));
  // One request at a time per session, the last one wins (sessionLocks): a slow PUT never writes into a file that
  // /complete already moved, and a PUT that went silent (Wi-Fi ↔ LTE) never blocks the retry or the cancel.
  const exclusive = sessionLocks();
  /** Space the disk must keep: the reserve plus what every unfinished upload may still write. */
  const diskFull = async extra => (await freeDisk(uploadDir)) - diskOutstanding(db) - extra < diskReserveBytes;
  const drop = async id => { db.prepare('DELETE FROM plain_upload_sessions WHERE id=?').run(id); await unlink(partPath(id)).catch(() => {}); };
  const header = async path => {
    const handle = await open(path, 'r');
    try { const buffer = Buffer.alloc(1024); const { bytesRead } = await handle.read(buffer, 0, 1024, 0); return buffer.subarray(0, bytesRead); }
    finally { await handle.close(); }
  };
  /** A profile post or story is a photo or an MP4/MOV video (what the profile can show); a channel takes any file. */
  const postMedia = head => imageMime(head) || videoMime(head);

  app.get('/uploads/limits', authOptions, async request => limitsFor(request.auth.user_id));

  app.post('/uploads/sessions', authOptions, async (request, reply) => {
    const ownerId = request.auth.user_id;
    if (!limiter.allow(`upload:${ownerId}`, 20, 60_000)) fail(429, 'Слишком много загрузок. Повторите через минуту.');
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const purpose = typeof body.purpose === 'string' && Object.hasOwn(PURPOSES, body.purpose) ? PURPOSES[body.purpose] : null;
    if (!purpose) fail(400, 'Укажите, куда загружается файл.');
    const size = body.size;
    if (!Number.isSafeInteger(size) || size <= 0) fail(400, 'Укажите размер файла.');
    const kind = body.kind === undefined ? 'file' : body.kind;
    if (kind !== 'video' && kind !== 'file') fail(400, 'Неизвестный тип файла.');
    if (body.name !== undefined && typeof body.name !== 'string') fail(400, 'Некорректное имя файла.');
    if (body.mimeType !== undefined && typeof body.mimeType !== 'string') fail(400, 'Некорректный тип файла.');
    const t = tier(ownerId), video = kind === 'video', max = video ? videoLimit(t) : t.file;
    if (size > max) {
      const upgrade = !video && !bigFiles.isPlatina(ownerId) && bigFiles.limits.platina.file > max;
      fail(413, upgrade
        ? `Файл больше ${sizeLabel(max)}. С Platina можно отправлять файлы до ${sizeLabel(bigFiles.limits.platina.file)}.`
        : `${video ? 'Видео' : 'Файл'} больше ${sizeLabel(max)}.`,
        { code: upgrade ? 'PLATINA_REQUIRED' : 'FILE_TOO_LARGE' });
    }
    await sweep();
    if (usage(ownerId) + size > t.total) fail(413, `Достигнут лимит хранения (${Math.round(t.total / GiB)} ГБ). Удали старые файлы из чатов.`, { code: 'STORAGE_FULL' });
    if (await diskFull(size)) fail(507, 'На сервере закончилось место для больших файлов. Попробуй позже.', { code: 'SERVER_FULL' });
    const id = randomUUID(), at = now();
    db.prepare('INSERT INTO plain_upload_sessions(id,owner_id,purpose,kind,name,mime_type,total_size,received,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run(id, ownerId, purpose, kind, safeFilename(body.name), safeMime(body.mimeType), size, at, at);
    return reply.code(201).send({ id, received: 0, totalBytes: size, chunkBytes: CHUNK_PLAIN });
  });

  const session = request => {
    const row = db.prepare('SELECT * FROM plain_upload_sessions WHERE id=? AND owner_id=?').get(request.params.id, request.auth.user_id);
    if (!row) fail(404, 'Загрузка не найдена. Начни отправку заново.');
    return row;
  };

  app.get('/uploads/sessions/:id', authOptions, async request => { const row = session(request); return { id: row.id, received: row.received, totalBytes: row.total_size }; });

  // The route bodyLimit does not apply to the raw stream parser: the counting Transform is the real limit.
  app.put('/uploads/sessions/:id', { ...authOptions, bodyLimit: CHUNK_PLAIN + 1024 }, async (request, reply) => {
    // Ownership first: only the owner's own request may take over the session.
    session(request);
    try { return await exclusive(request.params.id, request, () => putChunk(request, reply), { upload: true }); }
    catch (error) {
      // An answer before the body was read whole: the rest of the body is still on the socket, so it must not be reused.
      if (!request.raw.complete) reply.header('Connection', 'close');
      throw error;
    }
  });
  const putChunk = async (request, reply) => {
    const row = session(request);
    const offset = Number(request.query?.offset);
    if (!Number.isSafeInteger(offset) || offset !== row.received) fail(409, 'Загрузка продолжится с сохранённого места.', { code: 'OFFSET_MISMATCH', received: row.received });
    if (!request.body || typeof request.body.pipe !== 'function') fail(400, 'Нужен бинарный фрагмент файла.');
    const limit = Math.min(CHUNK_PLAIN, row.total_size - offset);
    // An overlong chunk is drained, not written (destroying the request stream would leave the client without an answer).
    // Far past the limit the request is cut off: nobody drains an endless body.
    let size = 0;
    const count = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit + MiB) { callback(new HttpError(413, 'Фрагмент больше допустимого.')); return; }
      callback(null, size > limit ? undefined : chunk);
    } });
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
    if (!db.prepare('SELECT 1 FROM plain_upload_sessions WHERE id=?').get(row.id)) { await unlink(path).catch(() => {}); fail(404, 'Загрузка не найдена. Начни отправку заново.'); }
    if (size > limit) { await truncate(path, offset); fail(413, 'Фрагмент больше допустимого.', { code: 'OFFSET_MISMATCH', received: offset }); }
    if (!size) fail(400, 'Пустой фрагмент.');
    if (size !== limit) fail(400, 'Неполный фрагмент. Он будет отправлен заново.', { code: 'OFFSET_MISMATCH', received: offset });
    // A post or a story is checked on its first chunk, so a wrong file is not uploaded for nothing.
    if (offset === 0) {
      const head = await header(path);
      if (row.purpose === 'post' && !postMedia(head)) { await drop(row.id); fail(415, 'Публикация — фото или видео MP4/MOV.', { code: 'UNSUPPORTED_MEDIA' }); }
      // The video limit (10 GB for everyone) is for videos only: a file declared as video must start like one.
      if (row.kind === 'video' && !videoContainer(head)) { await drop(row.id); fail(415, 'Это не видео. Отправь его как файл.', { code: 'UNSUPPORTED_MEDIA' }); }
    }
    const received = offset + size;
    db.prepare('UPDATE plain_upload_sessions SET received=?, updated_at=? WHERE id=?').run(received, now(), row.id);
    return { received, totalBytes: row.total_size };
  };

  app.post('/uploads/sessions/:id/complete', authOptions, async (request, reply) => { session(request); return exclusive(request.params.id, request, async () => {
    const row = session(request);
    if (row.received !== row.total_size) fail(409, 'Файл загружен не полностью.', { code: 'OFFSET_MISMATCH', received: row.received });
    const size = await stat(partPath(row.id)).then(info => info.size).catch(() => -1);
    if (size !== row.total_size) fail(409, 'Загрузка повреждена. Начни отправку заново.', { code: 'UPLOAD_LOST' });
    const t = tier(row.owner_id);
    if (stored(row.owner_id) + reservedEncrypted(row.owner_id) + reserved(row.owner_id, row.id) + size > t.total) fail(413, 'Достигнут лимит хранения файлов для аккаунта.', { code: 'STORAGE_FULL' });
    if (!sessionStillValid({ auth: request.auth })) fail(401, 'Войдите в аккаунт заново.');
    // The content decides how the file is shown, exactly as for POST /uploads: a recognised image or MP4/MOV
    // is media; anything else in a channel is a file with the (sanitised) type the app declared.
    const head = await header(partPath(row.id));
    const image = imageMime(head), video = image ? null : videoMime(head);
    if (row.purpose === 'post' && !image && !video) { await drop(row.id); fail(415, 'Публикация — фото или видео MP4/MOV.', { code: 'UNSUPPORTED_MEDIA' }); }
    const attachment = { id: row.id, name: row.name, mime_type: image || video || row.mime_type, size, is_image: image ? 1 : 0, is_video: video ? 1 : 0 };
    try { await rename(partPath(row.id), join(uploadDir, row.id)); }
    catch { fail(409, 'Загрузка повреждена. Начни отправку заново.', { code: 'UPLOAD_LOST' }); }
    db.prepare('DELETE FROM plain_upload_sessions WHERE id=?').run(row.id);
    db.prepare('INSERT INTO uploads(id,owner_id,name,mime_type,size,is_image,is_video,purpose,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(attachment.id, row.owner_id, attachment.name, attachment.mime_type, size, attachment.is_image, attachment.is_video, row.purpose, timestamp());
    return reply.code(201).send({ attachment: publicAttachment(attachment) });
  }); });

  // A cancel takes over a hanging PUT too, so the reservation is freed now, not after 24 h.
  app.delete('/uploads/sessions/:id', authOptions, async request => { session(request); return exclusive(request.params.id, request, async () => {
    const row = session(request);
    await drop(row.id);
    return { ok: true };
  }); });

  return { reserved, usage, sweep };
}
