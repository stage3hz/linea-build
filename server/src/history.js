// Old chats on a new device of the same account (docs/HISTORY-TRANSFER.md).
//
// Nothing here can read a message. Every page is encrypted on a device of the account before it is
// uploaded, and the keys travel only end-to-end between the account's own devices (Signal, the same
// sessions messages use) or stay with the person (the backup key). The server keeps opaque
// ciphertext for a bounded time and enforces who may write it, who may read it, and when.
//
// Variant A «с другого своего устройства» (history_transfers): a new device asks for a copy of the
// history; the account's other devices show «Новый вход» with «Это был не я». Only after
// TRANSFER_WAIT_MS since that sign-in may an older device of the account claim the request and
// upload pages for exactly that target device. Ending the new session («Это был не я», the existing
// compromise flow) deactivates its device; a transfer whose target is no longer an active device is
// dropped with its pages. Pages are deleted when the target acknowledges, at the latest after
// TRANSFER_TTL_MS.
//
// Variant B «резервная копия» (history_backups): an append-only log of encrypted pages per account.
// Its key comes from a random backup secret made on a device (≥128 bits); the server only keeps a
// random salt and a key-check value derived from that secret (useless for guessing: the secret is
// not a password). The secret moves between own devices sealed per device (history_secret_notes),
// never to a device younger than TRANSFER_WAIT_MS. A restore needs a session at least
// TRANSFER_WAIT_MS old and is limited to RESTORE_ATTEMPTS per RESTORE_WINDOW_MS.
import { randomBytes, randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { fail, objectBody } from './security.js';

export const TRANSFER_WAIT_MS = 10 * 60 * 1000;
export const TRANSFER_TTL_MS = 7 * 86_400_000;
/** A claim that made no progress this long may be taken over by another device of the account. */
export const CLAIM_STALE_MS = 15 * 60 * 1000;
/** One page of ciphertext (nonce + AES-256-GCM-SIV output), in bytes. */
export const MAX_PAGE_BYTES = 512 * 1024;
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
export const MAX_TRANSFER_PAGES = 1024;
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_PAGES = 4096;
export const RESTORE_ATTEMPTS = 5;
export const RESTORE_WINDOW_MS = 60 * 60 * 1000;
/** A backup writer silent this long hands the log to another device of the account. */
export const WRITER_IDLE_MS = 3 * 86_400_000;
const MAX_NOTE_BODY = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, `Некорректный идентификатор: ${label}.`);
  return value.toLowerCase();
}
function base64(value, label, minBytes, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !BASE64.test(value)) fail(400, `Некорректный формат: ${label}.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString('base64') !== value) fail(400, `Некорректный размер: ${label}.`);
  return { value, bytes: bytes.length };
}
function index(value, max) {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) fail(400, 'Некорректный номер страницы.');
  const number = Number(value);
  if (number >= max) fail(400, 'Некорректный номер страницы.');
  return number;
}
/** A Signal message sealed for one device: `{senderDeviceId, type, body}`, opaque here. */
function sealedNote(value) {
  const note = objectBody(value, ['senderDeviceId', 'type', 'body']);
  if (note.type !== 2 && note.type !== 3) fail(400, 'Некорректный тип конверта Signal.');
  return { senderDeviceId: uuid(note.senderDeviceId, 'senderDeviceId'), type: note.type, body: base64(note.body, 'note.body', 1, MAX_NOTE_BODY).value };
}
const pageBody = value => base64(value, 'page', 12 + 16, MAX_PAGE_BYTES);

export function installHistoryRoutes({ app, db, now, authOptions, emitUser, limiter }) {
  const iso = ms => new Date(ms).toISOString();
  const throttle = (request, action, count, windowMs = 60_000) => {
    if (!limiter.allow(`history:${action}:${request.auth.user_id}`, count, windowMs)) fail(429, 'Слишком много запросов. Повторите через минуту.');
  };
  /** The live session of the request (a revoked one is refused even if the token row lingers in a socket). */
  const sessionOf = request => {
    const session = db.prepare('SELECT id,user_id,created_at FROM sessions WHERE token_hash=? AND expires_at>?').get(request.auth?.token_hash || '', now());
    if (!session || session.user_id !== request.auth?.user_id) fail(401, 'Войдите в аккаунт заново.');
    return session;
  };
  /** An active encryption device of this account bound to a live session; `own`: bound to the request's session. */
  const liveDevice = (userId, deviceId) => db.prepare(`SELECT d.id,d.user_id,d.device_name,d.identity_key,d.registration_id,d.created_at,d.session_id,s.created_at AS session_created_at
    FROM e2ee_devices d JOIN sessions s ON s.id=d.session_id WHERE d.id=? AND d.user_id=? AND d.active=1 AND s.expires_at>?`).get(deviceId, userId, now());
  const ownDevice = (request, session, deviceId) => {
    const device = liveDevice(session.user_id, uuid(deviceId, 'deviceId'));
    if (!device || device.session_id !== session.id) fail(403, 'Устройство недоступно.');
    return device;
  };
  /** The moment a device counts as signed in: the later of its key registration and its session. */
  const signedInAt = device => Math.max(Date.parse(device.created_at) || 0, Date.parse(device.session_created_at) || 0);
  const readyAt = device => signedInAt(device) + TRANSFER_WAIT_MS;
  const publicTarget = device => ({ id: device.id, deviceName: device.device_name, identityKey: device.identity_key, registrationId: device.registration_id, createdAt: device.created_at });

  // ── housekeeping ────────────────────────────────────────────────────────────────────────────────────────
  // PRAGMA foreign_keys is off: rows of gone accounts, gone or deactivated devices are removed here.
  const sweep = () => transaction(db, () => {
    const time = now();
    const dead = db.prepare(`SELECT t.id FROM history_transfers t WHERE t.expires_at<=? OR NOT EXISTS (
      SELECT 1 FROM e2ee_devices d JOIN sessions s ON s.id=d.session_id WHERE d.id=t.target_device_id AND d.user_id=t.user_id AND d.active=1 AND s.expires_at>?)`).all(time, time);
    for (const row of dead) {
      db.prepare('DELETE FROM history_transfer_pages WHERE transfer_id=?').run(row.id);
      db.prepare('DELETE FROM history_transfers WHERE id=?').run(row.id);
    }
    db.prepare('DELETE FROM history_transfer_pages WHERE transfer_id NOT IN (SELECT id FROM history_transfers)').run();
    db.prepare(`DELETE FROM history_secret_notes WHERE NOT EXISTS (SELECT 1 FROM e2ee_devices d WHERE d.id=history_secret_notes.target_device_id AND d.active=1)
      OR NOT EXISTS (SELECT 1 FROM history_backups b WHERE b.user_id=history_secret_notes.user_id AND b.generation=history_secret_notes.generation AND b.key_check IS NOT NULL)`).run();
    db.prepare('DELETE FROM history_backup_pages WHERE NOT EXISTS (SELECT 1 FROM history_backups b WHERE b.user_id=history_backup_pages.user_id AND b.key_check IS NOT NULL)').run();
    db.prepare('DELETE FROM history_backups WHERE user_id NOT IN (SELECT id FROM users)').run();
    db.prepare('DELETE FROM history_restore_attempts WHERE window_start<=?').run(time - RESTORE_WINDOW_MS);
    return dead.length;
  });

  // ── Variant A: a copy from another own device ───────────────────────────────────────────────────────────
  const transferOf = (userId, id) => db.prepare('SELECT * FROM history_transfers WHERE id=? AND user_id=?').get(uuid(id, 'transferId'), userId);
  const publicTransfer = (row, target) => ({
    id: row.id, state: row.state, targetDeviceId: row.target_device_id, sourceDeviceId: row.source_device_id ?? null,
    notBefore: iso(row.not_before), ready: now() >= row.not_before, pageCount: row.page_count, bytes: row.bytes,
    expiresAt: iso(row.expires_at), ...(target ? { target: publicTarget(target) } : {}),
    ...(row.state === 'ready' && row.note_json ? { note: JSON.parse(row.note_json) } : {}),
  });
  const notifyOthers = (userId, payload, exceptSession) => emitUser(userId, payload, exceptSession);

  /** The new device asks for a copy of the history (idempotent: one open request per device). */
  app.post('/history/transfers', authOptions, async request => {
    throttle(request, 'request', 10);
    const body = objectBody(request.body, ['deviceId']);
    sweep();
    const session = sessionOf(request);
    const result = transaction(db, () => {
      const device = ownDevice(request, session, body.deviceId);
      const existing = db.prepare('SELECT * FROM history_transfers WHERE target_device_id=?').get(device.id);
      if (existing) return { transfer: publicTransfer(existing), created: false };
      const others = db.prepare(`SELECT COUNT(*) AS n FROM e2ee_devices d JOIN sessions s ON s.id=d.session_id
        WHERE d.user_id=? AND d.active=1 AND s.expires_at>? AND d.id<>? AND d.created_at<?`).get(session.user_id, now(), device.id, device.created_at).n;
      if (!others) fail(409, 'Нет другого устройства, с которого можно перенести переписки.', { code: 'HISTORY_NO_SOURCE' });
      const time = now();
      const row = { id: randomUUID(), user_id: session.user_id, target_device_id: device.id, state: 'waiting', not_before: readyAt(device), created_at: time, expires_at: time + TRANSFER_TTL_MS };
      db.prepare('INSERT INTO history_transfers(id,user_id,target_device_id,state,not_before,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(row.id, row.user_id, row.target_device_id, row.state, row.not_before, row.created_at, row.created_at, row.expires_at);
      return { transfer: publicTransfer({ ...row, page_count: 0, bytes: 0 }), created: true };
    });
    if (result.created) notifyOthers(session.user_id, { type: 'history.request', transferId: result.transfer.id, notBefore: result.transfer.notBefore }, session.id);
    return { transfer: result.transfer };
  });

  /** For an existing device: the requests of the account's newer devices it may answer. */
  app.get('/history/transfers/outgoing', authOptions, async request => {
    sweep();
    const session = sessionOf(request);
    const device = ownDevice(request, session, request.query.deviceId);
    const rows = db.prepare(`SELECT t.* FROM history_transfers t WHERE t.user_id=? AND t.target_device_id<>? AND t.state IN ('waiting','sending') ORDER BY t.created_at`).all(session.user_id, device.id);
    const transfers = [];
    for (const row of rows) {
      const target = liveDevice(session.user_id, row.target_device_id);
      if (!target || !(device.created_at < target.created_at)) continue;
      transfers.push(publicTransfer(row, target));
    }
    return { transfers };
  });

  /** For the new device: its own request, with the sealed key once the copy is complete. */
  app.get('/history/transfers/incoming', authOptions, async request => {
    sweep();
    const session = sessionOf(request);
    const device = ownDevice(request, session, request.query.deviceId);
    const row = db.prepare('SELECT * FROM history_transfers WHERE target_device_id=? AND user_id=?').get(device.id, session.user_id);
    return { transfer: row ? publicTransfer(row) : null };
  });

  /** An older device takes the request; only after the wait, one device at a time. */
  app.post('/history/transfers/:id/claim', authOptions, async request => {
    throttle(request, 'claim', 30);
    const body = objectBody(request.body, ['deviceId']);
    sweep();
    const session = sessionOf(request);
    return transaction(db, () => {
      const device = ownDevice(request, session, body.deviceId);
      const row = transferOf(session.user_id, request.params.id);
      if (!row) fail(404, 'Запрос переноса не найден.');
      const target = liveDevice(session.user_id, row.target_device_id);
      if (!target || target.id === device.id || !(device.created_at < target.created_at)) fail(403, 'Это устройство не может передать переписки.');
      if (now() < row.not_before) fail(425, 'Перенос начнётся через 10 минут после входа.', { code: 'HISTORY_TOO_EARLY', notBefore: iso(row.not_before) });
      if (row.state !== 'waiting' && row.state !== 'sending') fail(409, row.state === 'cancelled' ? 'Перенос отменён.' : 'Переписки уже переданы.', { code: 'HISTORY_CLOSED' });
      if (row.state === 'sending' && row.source_device_id !== device.id && now() - row.updated_at < CLAIM_STALE_MS) fail(409, 'Переписки уже передаёт другое устройство.', { code: 'HISTORY_CLAIMED' });
      db.prepare('DELETE FROM history_transfer_pages WHERE transfer_id=?').run(row.id);
      db.prepare("UPDATE history_transfers SET state='sending',source_device_id=?,claimed_at=?,updated_at=?,page_count=0,bytes=0,note_json=NULL WHERE id=?").run(device.id, now(), now(), row.id);
      return { transfer: publicTransfer({ ...row, state: 'sending', source_device_id: device.id, page_count: 0, bytes: 0, note_json: null }, target) };
    });
  });

  const claimed = (request, session, id, deviceId) => {
    const device = ownDevice(request, session, deviceId);
    const row = transferOf(session.user_id, id);
    if (!row || row.state !== 'sending' || row.source_device_id !== device.id) fail(409, 'Перенос не начат с этого устройства.');
    if (!liveDevice(session.user_id, row.target_device_id)) fail(410, 'Устройство, для которого переносились переписки, вышло из аккаунта.');
    return row;
  };

  /** Pages are appended in order; the last one may be sent again (a retry after a lost answer). */
  app.put('/history/transfers/:id/pages/:index', { ...authOptions, bodyLimit: 1024 * 1024 }, async request => {
    throttle(request, 'page', 600);
    const body = objectBody(request.body, ['deviceId', 'body']);
    const session = sessionOf(request);
    const at = index(request.params.index, MAX_TRANSFER_PAGES);
    const page = pageBody(body.body);
    return transaction(db, () => {
      const row = claimed(request, session, request.params.id, body.deviceId);
      const previous = db.prepare('SELECT body FROM history_transfer_pages WHERE transfer_id=? AND idx=?').get(row.id, at);
      if (at !== row.page_count && !(previous && at === row.page_count - 1)) fail(409, 'Страницы передаются по порядку.', { code: 'HISTORY_PAGE_ORDER', next: row.page_count });
      const previousBytes = previous ? Buffer.from(previous.body, 'base64').length : 0;
      const bytes = row.bytes - previousBytes + page.bytes;
      if (bytes > MAX_TRANSFER_BYTES) fail(413, 'Переписки не помещаются в один перенос.', { code: 'HISTORY_TOO_LARGE' });
      db.prepare('INSERT INTO history_transfer_pages(transfer_id,idx,body) VALUES(?,?,?) ON CONFLICT(transfer_id,idx) DO UPDATE SET body=excluded.body').run(row.id, at, page.value);
      const count = previous ? row.page_count : row.page_count + 1;
      db.prepare('UPDATE history_transfers SET page_count=?,bytes=?,updated_at=? WHERE id=?').run(count, bytes, now(), row.id);
      return { pageCount: count, bytes };
    });
  });

  /** The copy is complete: the key, sealed with Signal for the target device, is handed over. */
  app.post('/history/transfers/:id/complete', authOptions, async request => {
    throttle(request, 'complete', 30);
    const body = objectBody(request.body, ['deviceId', 'note', 'pageCount']);
    const session = sessionOf(request);
    const note = sealedNote(body.note);
    const result = transaction(db, () => {
      const row = claimed(request, session, request.params.id, body.deviceId);
      if (note.senderDeviceId !== row.source_device_id) fail(400, 'Ключ переноса запечатан другим устройством.');
      if (body.pageCount !== row.page_count || row.page_count < 1) fail(409, 'Переданы не все страницы.', { code: 'HISTORY_PAGE_ORDER', next: row.page_count });
      db.prepare("UPDATE history_transfers SET state='ready',note_json=?,updated_at=? WHERE id=?").run(JSON.stringify(note), now(), row.id);
      return { ...row, state: 'ready', note_json: JSON.stringify(note) };
    });
    emitUser(session.user_id, { type: 'history.ready', transferId: result.id });
    return { transfer: publicTransfer(result) };
  });

  /** The target reads a page of its own completed copy. */
  app.get('/history/transfers/:id/pages/:index', authOptions, async request => {
    throttle(request, 'read', 1200);
    const session = sessionOf(request);
    const device = ownDevice(request, session, request.query.deviceId);
    const row = transferOf(session.user_id, request.params.id);
    if (!row || row.target_device_id !== device.id || row.state !== 'ready') fail(404, 'Перенос не найден.');
    const page = db.prepare('SELECT body FROM history_transfer_pages WHERE transfer_id=? AND idx=?').get(row.id, index(request.params.index, MAX_TRANSFER_PAGES));
    if (!page) fail(404, 'Страница не найдена.');
    return { body: page.body };
  });

  /** The target imported the copy (or gave up): every page and the request go. */
  app.post('/history/transfers/:id/ack', authOptions, async request => {
    const body = objectBody(request.body, ['deviceId']);
    const session = sessionOf(request);
    transaction(db, () => {
      const device = ownDevice(request, session, body.deviceId);
      const row = transferOf(session.user_id, request.params.id);
      if (!row || row.target_device_id !== device.id) fail(404, 'Перенос не найден.');
      db.prepare('DELETE FROM history_transfer_pages WHERE transfer_id=?').run(row.id);
      // The row stays (without pages) until it expires, so the same device does not ask again.
      db.prepare("UPDATE history_transfers SET state='done',page_count=0,bytes=0,note_json=NULL,updated_at=? WHERE id=?").run(now(), row.id);
    });
    return { ok: true };
  });

  /** Any other own device stops a transfer («Это не я» ends the session too; this only stops the copy). */
  app.post('/history/transfers/:id/cancel', authOptions, async request => {
    const body = objectBody(request.body, ['deviceId']);
    const session = sessionOf(request);
    transaction(db, () => {
      const device = ownDevice(request, session, body.deviceId);
      const row = transferOf(session.user_id, request.params.id);
      if (!row) fail(404, 'Перенос не найден.');
      if (row.target_device_id === device.id) fail(403, 'Отменить перенос можно только с другого устройства.');
      db.prepare('DELETE FROM history_transfer_pages WHERE transfer_id=?').run(row.id);
      db.prepare("UPDATE history_transfers SET state='cancelled',page_count=0,bytes=0,note_json=NULL,updated_at=? WHERE id=?").run(now(), row.id);
    });
    emitUser(session.user_id, { type: 'history.cancelled', transferId: request.params.id });
    return { ok: true };
  });

  // ── Variant B: the encrypted backup ─────────────────────────────────────────────────────────────────────
  const backupRow = userId => db.prepare('SELECT * FROM history_backups WHERE user_id=?').get(userId);
  /** The salt exists before the backup is enabled: the first device needs it to derive the key check. */
  const ensureBackup = userId => {
    let row = backupRow(userId);
    if (!row) {
      db.prepare('INSERT INTO history_backups(user_id,salt,generation,updated_at) VALUES(?,?,0,?)').run(userId, randomBytes(32).toString('base64'), now());
      row = backupRow(userId);
    }
    return row;
  };
  const publicBackup = (row, session, device) => {
    const enabled = row.key_check !== null;
    const note = enabled && device ? db.prepare('SELECT note_json FROM history_secret_notes WHERE target_device_id=? AND user_id=? AND generation=?').get(device.id, row.user_id, row.generation) : null;
    const restoreAt = (Date.parse(session.created_at) || 0) + TRANSFER_WAIT_MS;
    return {
      enabled, salt: row.salt, generation: row.generation, pageCount: enabled ? row.page_count : 0, bytes: enabled ? row.bytes : 0,
      updatedAt: enabled ? iso(row.updated_at) : null, writerDeviceId: enabled ? row.writer_device_id ?? null : null,
      restoreAt: iso(restoreAt), canRestore: enabled && now() >= restoreAt,
      ...(note ? { note: JSON.parse(note.note_json) } : {}),
    };
  };

  /** State of the backup for this device; with `missing`: own devices still without the secret. */
  app.get('/history/backup', authOptions, async request => {
    sweep();
    const session = sessionOf(request);
    const device = ownDevice(request, session, request.query.deviceId);
    const row = transaction(db, () => ensureBackup(session.user_id));
    const result = publicBackup(row, session, device);
    if (row.key_check !== null) {
      const devices = db.prepare(`SELECT d.id,d.device_name,d.identity_key,d.registration_id,d.created_at,s.created_at AS session_created_at FROM e2ee_devices d JOIN sessions s ON s.id=d.session_id
        WHERE d.user_id=? AND d.active=1 AND s.expires_at>? AND d.id<>? AND NOT EXISTS (SELECT 1 FROM history_secret_notes n WHERE n.target_device_id=d.id AND n.generation=?)`).all(session.user_id, now(), device.id, row.generation);
      result.missing = devices.filter(item => now() >= readyAt(item)).map(publicTarget);
    }
    return result;
  });

  /** Turns the backup on (generation 1) or starts a new secret (generation + 1: old pages and notes go). */
  app.put('/history/backup', authOptions, async request => {
    throttle(request, 'backup-key', 10);
    const body = objectBody(request.body, ['deviceId', 'generation', 'keyCheck']);
    const session = sessionOf(request);
    const keyCheck = base64(body.keyCheck, 'keyCheck', 32, 32).value;
    const result = transaction(db, () => {
      const device = ownDevice(request, session, body.deviceId);
      const row = ensureBackup(session.user_id);
      if (body.generation !== row.generation + 1) fail(409, 'Резервную копию уже включили на другом устройстве.', { code: 'BACKUP_GENERATION', generation: row.generation });
      db.prepare('DELETE FROM history_backup_pages WHERE user_id=?').run(session.user_id);
      db.prepare('DELETE FROM history_secret_notes WHERE user_id=?').run(session.user_id);
      db.prepare('UPDATE history_backups SET key_check=?,generation=?,page_count=0,bytes=0,writer_device_id=?,updated_at=? WHERE user_id=?').run(keyCheck, body.generation, device.id, now(), session.user_id);
      return publicBackup(backupRow(session.user_id), session, device);
    });
    emitUser(session.user_id, { type: 'history.backup' }, session.id);
    return result;
  });

  /** Turns the backup off: every page, every sealed copy of the secret and the key check go. */
  app.delete('/history/backup', authOptions, async request => {
    throttle(request, 'backup-key', 10);
    const session = sessionOf(request);
    ownDevice(request, session, request.query.deviceId);
    transaction(db, () => {
      db.prepare('DELETE FROM history_backup_pages WHERE user_id=?').run(session.user_id);
      db.prepare('DELETE FROM history_secret_notes WHERE user_id=?').run(session.user_id);
      db.prepare('UPDATE history_backups SET key_check=NULL,page_count=0,bytes=0,writer_device_id=NULL,salt=?,updated_at=? WHERE user_id=?').run(randomBytes(32).toString('base64'), now(), session.user_id);
    });
    emitUser(session.user_id, { type: 'history.backup' }, session.id);
    return { ok: true };
  });

  /** The backup secret sealed (Signal) for one own device that signed in at least 10 minutes ago. */
  app.post('/history/backup/notes', authOptions, async request => {
    throttle(request, 'backup-note', 30);
    const body = objectBody(request.body, ['deviceId', 'targetDeviceId', 'generation', 'note']);
    const session = sessionOf(request);
    const note = sealedNote(body.note);
    transaction(db, () => {
      const device = ownDevice(request, session, body.deviceId);
      if (note.senderDeviceId !== device.id) fail(400, 'Ключ запечатан другим устройством.');
      const row = backupRow(session.user_id);
      if (!row || row.key_check === null || body.generation !== row.generation) fail(409, 'Ключ резервной копии изменился.', { code: 'BACKUP_GENERATION' });
      const target = liveDevice(session.user_id, uuid(body.targetDeviceId, 'targetDeviceId'));
      if (!target || target.id === device.id) fail(404, 'Устройство не найдено.');
      if (now() < readyAt(target)) fail(425, 'Ключ можно передать через 10 минут после входа.', { code: 'HISTORY_TOO_EARLY', notBefore: iso(readyAt(target)) });
      db.prepare('INSERT INTO history_secret_notes(target_device_id,user_id,source_device_id,generation,note_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(target_device_id) DO UPDATE SET source_device_id=excluded.source_device_id,generation=excluded.generation,note_json=excluded.note_json,created_at=excluded.created_at')
        .run(target.id, session.user_id, device.id, row.generation, JSON.stringify(note), now());
    });
    emitUser(session.user_id, { type: 'history.backup' }, session.id);
    return { ok: true };
  });

  /**
   * Appends a page to the log. One device writes at a time (the writer); another takes over when the writer is
   * gone or silent for WRITER_IDLE_MS. `reset`: the writer starts the log again (it no longer fits).
   */
  app.post('/history/backup/pages', { ...authOptions, bodyLimit: 1024 * 1024 }, async request => {
    throttle(request, 'backup-page', 300);
    const body = objectBody(request.body, ['deviceId', 'generation', 'body', 'reset']);
    const session = sessionOf(request);
    const page = pageBody(body.body);
    return transaction(db, () => {
      const device = ownDevice(request, session, body.deviceId);
      const row = backupRow(session.user_id);
      if (!row || row.key_check === null || body.generation !== row.generation) fail(409, 'Ключ резервной копии изменился.', { code: 'BACKUP_GENERATION' });
      const writer = row.writer_device_id ? liveDevice(session.user_id, row.writer_device_id) : null;
      if (writer && writer.id !== device.id && now() - row.updated_at < WRITER_IDLE_MS) fail(409, 'Резервную копию ведёт другое устройство.', { code: 'BACKUP_WRITER', writerDeviceId: writer.id });
      let { page_count: count, bytes } = row;
      if (body.reset === true) { db.prepare('DELETE FROM history_backup_pages WHERE user_id=?').run(session.user_id); count = 0; bytes = 0; }
      if (count >= MAX_BACKUP_PAGES || bytes + page.bytes > MAX_BACKUP_BYTES) fail(413, 'Резервная копия заполнена.', { code: 'BACKUP_FULL' });
      db.prepare('INSERT INTO history_backup_pages(user_id,idx,body) VALUES(?,?,?)').run(session.user_id, count, page.value);
      db.prepare('UPDATE history_backups SET page_count=?,bytes=?,writer_device_id=?,updated_at=? WHERE user_id=?').run(count + 1, bytes + page.bytes, device.id, now(), session.user_id);
      return { index: count, pageCount: count + 1, bytes: bytes + page.bytes };
    });
  });

  const attempts = userId => db.prepare('SELECT * FROM history_restore_attempts WHERE user_id=?').get(userId);
  /**
   * Starts a restore: counted (RESTORE_ATTEMPTS an hour), only from a session at least 10 minutes old. Gives the
   * salt and the key check; the device checks the typed secret against them itself.
   */
  app.post('/history/backup/restore', authOptions, async request => {
    const body = objectBody(request.body, ['deviceId']);
    const session = sessionOf(request);
    return transaction(db, () => {
      const device = ownDevice(request, session, body.deviceId);
      const row = backupRow(session.user_id);
      if (!row || row.key_check === null) fail(404, 'Резервной копии нет.', { code: 'BACKUP_NONE' });
      const restoreAt = (Date.parse(session.created_at) || 0) + TRANSFER_WAIT_MS;
      if (now() < restoreAt) fail(425, 'Восстановить переписки можно через 10 минут после входа.', { code: 'HISTORY_TOO_EARLY', notBefore: iso(restoreAt) });
      const time = now(), held = attempts(session.user_id);
      const fresh = !held || time - held.window_start >= RESTORE_WINDOW_MS;
      const count = fresh ? 1 : held.attempts + 1;
      if (count > RESTORE_ATTEMPTS) fail(429, 'Слишком много попыток восстановления. Повтори через час.', { code: 'BACKUP_ATTEMPTS', retryAt: iso(held.window_start + RESTORE_WINDOW_MS) });
      db.prepare('INSERT INTO history_restore_attempts(user_id,window_start,attempts,device_id) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts,device_id=excluded.device_id')
        .run(session.user_id, fresh ? time : held.window_start, count, device.id);
      return { salt: row.salt, keyCheck: row.key_check, generation: row.generation, pageCount: row.page_count, bytes: row.bytes, attemptsLeft: RESTORE_ATTEMPTS - count };
    });
  });

  /**
   * A page of the log. The writer and devices holding a sealed copy of the secret may read it any time (to check
   * the log); any other device only within the hour after it started a restore.
   */
  app.get('/history/backup/pages/:index', authOptions, async request => {
    throttle(request, 'backup-read', 2000);
    const session = sessionOf(request);
    const device = ownDevice(request, session, request.query.deviceId);
    const row = backupRow(session.user_id);
    if (!row || row.key_check === null) fail(404, 'Резервной копии нет.', { code: 'BACKUP_NONE' });
    const holder = row.writer_device_id === device.id || db.prepare('SELECT 1 FROM history_secret_notes WHERE target_device_id=? AND generation=?').get(device.id, row.generation);
    const attempt = attempts(session.user_id);
    if (!holder && !(attempt && attempt.device_id === device.id && now() - attempt.window_start < RESTORE_WINDOW_MS)) fail(403, 'Сначала начни восстановление.', { code: 'BACKUP_RESTORE_FIRST' });
    const page = db.prepare('SELECT body FROM history_backup_pages WHERE user_id=? AND idx=?').get(session.user_id, index(request.params.index, MAX_BACKUP_PAGES));
    if (!page) fail(404, 'Страница не найдена.');
    return { body: page.body };
  });

  return { sweep };
}
