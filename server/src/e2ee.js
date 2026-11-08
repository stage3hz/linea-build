import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { transaction, publicMessage } from './database.js';
import { HttpError, fail, objectBody, deviceNameValue } from './security.js';

const MAX_ACTIVE_DEVICES = 5;
// An installation unused this long gives its slot to a new one (as WhatsApp unlinks idle devices),
// so reinstalling the app a few times never locks a person out of their own chats.
export const IDLE_DEVICE_DAYS = 14;
const MAX_PREKEYS = 100;
const MAX_PREKEY_UPLOAD = 32;
const MAX_ENVELOPES = 10;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_ATTACHMENTS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, `Некорректный идентификатор: ${label}.`);
  return value.toLowerCase();
}
function integer(value, label, max = 0x7fffffff, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `Некорректное число: ${label}.`);
  return value;
}
function base64(value, label, minBytes, maxBytes = minBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !BASE64.test(value)) {
    fail(400, `Некорректный формат: ${label}.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < minBytes || decoded.length > maxBytes || decoded.toString('base64') !== value) fail(400, `Некорректный размер: ${label}.`);
  return value;
}
function curvePublicKey(value, label) {
  const key = base64(value, label, 33);
  if (Buffer.from(key, 'base64')[0] !== 5) fail(400, `Некорректный тип ключа: ${label}.`);
  return key;
}
function signedPreKey(value, kyber = false) {
  const key = objectBody(value, ['id', 'publicKey', 'signature']);
  return {
    id: integer(key.id, 'preKey.id'),
    publicKey: kyber ? base64(key.publicKey, 'kyberPreKey.publicKey', 1569) : curvePublicKey(key.publicKey, 'signedPreKey.publicKey'),
    signature: base64(key.signature, 'preKey.signature', 64),
  };
}

export function parseEncryptedMessage(value) {
  const encrypted = objectBody(value, ['scheme', 'senderDeviceId', 'envelopes', 'attachmentIds', 'lane']);
  if (encrypted.scheme !== 'signal-v1') fail(400, 'Неподдерживаемая схема шифрования.');
  // F4: `lane:'scheduled'` = encrypted in the sender's separate Signal session for scheduled messages (the
  // app's core.ts Lane); the recipient opens it there. Opaque to the server, passed through unchanged.
  if (encrypted.lane !== undefined && encrypted.lane !== 'scheduled') fail(400, 'Некорректный признак сессии шифрования.');
  const senderDeviceId = uuid(encrypted.senderDeviceId, 'senderDeviceId');
  if (!Array.isArray(encrypted.envelopes) || encrypted.envelopes.length < 1 || encrypted.envelopes.length > MAX_ENVELOPES) {
    fail(400, 'Допустимо от 1 до 10 зашифрованных конвертов.');
  }
  const recipientIds = new Set();
  const envelopes = encrypted.envelopes.map(value => {
    const envelope = objectBody(value, ['userId', 'deviceId', 'type', 'body']);
    const userId = uuid(envelope.userId, 'userId'), deviceId = uuid(envelope.deviceId, 'deviceId');
    if (recipientIds.has(deviceId)) fail(400, 'Устройства получателей не должны повторяться.');
    recipientIds.add(deviceId);
    if (![2, 3].includes(envelope.type)) fail(400, 'Некорректный тип конверта Signal.');
    return { userId, deviceId, type: envelope.type, body: base64(envelope.body, 'envelope.body', 1, MAX_CIPHERTEXT_BYTES) };
  }).sort((a, b) => a.userId.localeCompare(b.userId) || a.deviceId.localeCompare(b.deviceId));
  const ids = encrypted.attachmentIds === undefined ? [] : encrypted.attachmentIds;
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) fail(400, 'Допустимо не более 10 зашифрованных вложений.');
  const attachmentIds = ids.map(id => uuid(id, 'attachmentId')).sort();
  if (new Set(attachmentIds).size !== attachmentIds.length) fail(400, 'Вложения не должны повторяться.');
  return { scheme: 'signal-v1', senderDeviceId, envelopes, attachmentIds, ...(encrypted.lane ? { lane: encrypted.lane } : {}) };
}

/** Public-key and opaque-ciphertext relay only. All Signal operations occur on clients. */
export function installE2eeRoutes({
  app, db, now, timestamp, authOptions, emitUser, limiter, uploadDir,
  maxUploadBytes, storageLimit, closeRevokedSockets,
  // Stored files plus the reservations of unfinished chunked uploads (bigfiles.js, plainuploads.js).
  usage = userId => db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner_id=?').get(userId).bytes,
}) {
  const assertSession = request => {
    const session = db.prepare('SELECT id,user_id FROM sessions WHERE token_hash=? AND expires_at>?')
      .get(request.auth?.token_hash || '', now());
    if (!session || session.user_id !== request.auth?.user_id) fail(401, 'Войдите в аккаунт заново.');
    return session;
  };
  const activeDevices = userId => db.prepare('SELECT d.* FROM e2ee_devices d JOIN sessions s ON s.id=d.session_id WHERE d.user_id=? AND d.active=1 AND s.expires_at>? ORDER BY d.id')
    .all(userId, now());
  const publicDevice = (row, includeCount = false) => ({
    id: row.id, userId: row.user_id, deviceName: row.device_name,
    identityKey: row.identity_key, registrationId: row.registration_id,
    createdAt: row.created_at, active: Boolean(row.effective_active ?? row.active),
    ...(includeCount ? { preKeyCount: db.prepare('SELECT COUNT(*) AS count FROM e2ee_prekeys WHERE device_id=? AND consumed_at IS NULL').get(row.id).count } : {}),
  });
  const notifyDevices = userId => {
    const peers = db.prepare('SELECT DISTINCT peer.user_id FROM chat_members mine JOIN chat_members peer ON peer.chat_id=mine.chat_id WHERE mine.user_id=?')
      .all(userId).map(row => row.user_id);
    for (const targetId of new Set([userId, ...peers])) emitUser(targetId, { type: 'e2ee.devices', userId });
  };
  const expireDevices = () => {
    const owners = transaction(db, () => {
      const rows = db.prepare('SELECT DISTINCT user_id FROM e2ee_devices d WHERE active=1 AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=d.session_id AND s.expires_at>?)').all(now());
      db.prepare('UPDATE e2ee_devices SET active=0,session_id=NULL,updated_at=? WHERE active=1 AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=e2ee_devices.session_id AND s.expires_at>?)')
        .run(timestamp(), now());
      return rows.map(row => row.user_id);
    });
    for (const userId of owners) notifyDevices(userId);
  };
  const mayReadUser = (viewerId, targetId) => {
    if (viewerId === targetId) return;
    const member = db.prepare('SELECT 1 FROM chat_members mine JOIN chat_members peer ON peer.chat_id=mine.chat_id WHERE mine.user_id=? AND peer.user_id=? LIMIT 1')
      .get(viewerId, targetId);
    if (!member) fail(404, 'Устройства пользователя недоступны.');
  };
  const throttle = (request, action, count) => {
    if (!limiter.allow(`e2ee:${action}:${request.auth.user_id}`, count, 60_000)) fail(429, 'Слишком много запросов шифрования. Повторите через минуту.');
  };

  app.post('/e2ee/devices', authOptions, async request => {
    throttle(request, 'keys', 30);
    const body = objectBody(request.body, ['deviceId', 'deviceName', 'registrationId', 'identityKey', 'signedPreKey', 'kyberPreKey', 'preKeys']);
    const deviceId = uuid(body.deviceId, 'deviceId');
    const deviceName = deviceNameValue(body.deviceName);
    const registrationId = integer(body.registrationId, 'registrationId', 16383, 1);
    const identityKey = curvePublicKey(body.identityKey, 'identityKey');
    const signed = signedPreKey(body.signedPreKey), kyber = signedPreKey(body.kyberPreKey, true);
    if (!Array.isArray(body.preKeys) || body.preKeys.length > MAX_PREKEY_UPLOAD) fail(400, 'За один запрос можно передать не более 32 одноразовых ключей.');
    const ids = new Set();
    const preKeys = body.preKeys.map(value => {
      const key = objectBody(value, ['id', 'publicKey']);
      const id = integer(key.id, 'preKey.id');
      if (ids.has(id)) fail(400, 'Идентификаторы одноразовых ключей не должны повторяться.');
      ids.add(id);
      return { id, publicKey: curvePublicKey(key.publicKey, 'preKey.publicKey') };
    });
    expireDevices();
    const result = transaction(db, () => {
      const session = assertSession(request);
      const current = db.prepare('SELECT * FROM e2ee_devices WHERE id=?').get(deviceId);
      if (current && (current.user_id !== session.user_id || current.identity_key !== identityKey || current.registration_id !== registrationId)) {
        fail(409, 'Идентификатор устройства уже связан с другим ключом.');
      }
      if ((!current || !current.active) && activeDevices(session.user_id).length >= MAX_ACTIVE_DEVICES) {
        const idleBefore = new Date(now() - IDLE_DEVICE_DAYS * 86_400_000).toISOString();
        const idle = db.prepare(`SELECT d.id FROM e2ee_devices d JOIN sessions s ON s.id=d.session_id
          WHERE d.user_id=? AND d.active=1 AND s.expires_at>? AND s.id<>? AND s.last_active_at<>'' AND s.last_active_at<?
          ORDER BY s.last_active_at LIMIT 1`).get(session.user_id, now(), session.id, idleBefore);
        if (!idle) fail(409, 'На аккаунте уже пять устройств с шифрованием. Отключи старое в «Безопасность и устройства».', { code: 'E2EE_DEVICE_LIMIT' });
        db.prepare('UPDATE e2ee_devices SET active=0,session_id=NULL,updated_at=? WHERE id=?').run(timestamp(), idle.id);
      }
      let fresh = 0;
      for (const key of preKeys) {
        const previous = db.prepare('SELECT public_key FROM e2ee_prekeys WHERE device_id=? AND prekey_id=?').get(deviceId, key.id);
        if (previous && previous.public_key !== key.publicKey) fail(409, 'Идентификатор одноразового ключа уже использован другим ключом.');
        if (!previous) fresh++;
      }
      const available = db.prepare('SELECT COUNT(*) AS count FROM e2ee_prekeys WHERE device_id=? AND consumed_at IS NULL').get(deviceId).count;
      if (available + fresh > MAX_PREKEYS) fail(409, 'Устройство может хранить не более 100 неиспользованных одноразовых ключей.');
      const date = timestamp();
      if (!current) {
        db.prepare('INSERT INTO e2ee_devices(id,user_id,session_id,device_name,identity_key,registration_id,signed_prekey_id,signed_prekey_public,signed_prekey_signature,kyber_prekey_id,kyber_prekey_public,kyber_prekey_signature,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)')
          .run(deviceId, session.user_id, session.id, deviceName, identityKey, registrationId, signed.id, signed.publicKey, signed.signature, kyber.id, kyber.publicKey, kyber.signature, date, date);
      } else {
        db.prepare('UPDATE e2ee_devices SET session_id=?,device_name=?,signed_prekey_id=?,signed_prekey_public=?,signed_prekey_signature=?,kyber_prekey_id=?,kyber_prekey_public=?,kyber_prekey_signature=?,active=1,updated_at=? WHERE id=?')
          .run(session.id, deviceName, signed.id, signed.publicKey, signed.signature, kyber.id, kyber.publicKey, kyber.signature, date, deviceId);
      }
      for (const key of preKeys) {
        // Consumed rows are immutable tombstones. Retrying registration must
        // never republish an EC prekey that has already been claimed.
        db.prepare('INSERT OR IGNORE INTO e2ee_prekeys(device_id,prekey_id,public_key,created_at) VALUES(?,?,?,?)')
          .run(deviceId, key.id, key.publicKey, date);
      }
      const device = publicDevice(db.prepare('SELECT * FROM e2ee_devices WHERE id=?').get(deviceId));
      return { device, preKeyCount: available + fresh };
    });
    notifyDevices(request.auth.user_id);
    return result;
  });

  app.get('/e2ee/devices/self', authOptions, async request => {
    assertSession(request);
    expireDevices();
    const devices = db.prepare('SELECT d.*,CASE WHEN d.active=1 AND s.expires_at>? THEN 1 ELSE 0 END AS effective_active FROM e2ee_devices d LEFT JOIN sessions s ON s.id=d.session_id WHERE d.user_id=? ORDER BY d.created_at DESC,d.id')
      .all(now(), request.auth.user_id).map(row => publicDevice(row, true));
    return { devices };
  });

  app.get('/e2ee/devices', authOptions, async request => {
    assertSession(request);
    const userId = uuid(request.query.userId ?? request.auth.user_id, 'userId');
    mayReadUser(request.auth.user_id, userId);
    expireDevices();
    return { devices: activeDevices(userId).map(row => publicDevice(row)) };
  });

  app.post('/e2ee/prekeys/claim', authOptions, async request => {
    throttle(request, 'claim', 120);
    const body = objectBody(request.body, ['userId', 'deviceId']);
    const userId = uuid(body.userId, 'userId'), deviceId = uuid(body.deviceId, 'deviceId');
    expireDevices();
    return transaction(db, () => {
      assertSession(request);
      mayReadUser(request.auth.user_id, userId);
      const device = activeDevices(userId).find(item => item.id === deviceId);
      if (!device) fail(404, 'Устройство недоступно.');
      const key = db.prepare('SELECT prekey_id,public_key FROM e2ee_prekeys WHERE device_id=? AND consumed_at IS NULL ORDER BY prekey_id LIMIT 1').get(deviceId);
      if (key) db.prepare('UPDATE e2ee_prekeys SET consumed_at=? WHERE device_id=? AND prekey_id=? AND consumed_at IS NULL').run(timestamp(), deviceId, key.prekey_id);
      return {
        device: publicDevice(device),
        bundle: {
          registrationId: device.registration_id, identityKey: device.identity_key,
          signedPreKey: { id: device.signed_prekey_id, publicKey: device.signed_prekey_public, signature: device.signed_prekey_signature },
          // The client designates this as a last-resort Kyber key. One-time EC
          // prekeys above are consumed atomically, including concurrent claims.
          kyberPreKey: { id: device.kyber_prekey_id, publicKey: device.kyber_prekey_public, signature: device.kyber_prekey_signature },
          ...(key ? { preKey: { id: key.prekey_id, publicKey: key.public_key } } : {}),
        },
      };
    });
  });

  app.post('/e2ee/devices/revoke', authOptions, async request => {
    throttle(request, 'keys', 30);
    const body = objectBody(request.body, ['deviceId']);
    const id = uuid(body.deviceId, 'deviceId');
    transaction(db, () => {
      assertSession(request);
      const device = db.prepare('SELECT id,session_id FROM e2ee_devices WHERE id=? AND user_id=?').get(id, request.auth.user_id);
      if (!device) fail(404, 'Устройство не найдено.');
      if (device.session_id) {
        // An inactive key alone is insufficient: the same bearer token could
        // immediately register it again, or create another device identity.
        db.prepare('UPDATE e2ee_devices SET active=0,session_id=NULL,updated_at=? WHERE session_id=?').run(timestamp(), device.session_id);
        db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(device.session_id, request.auth.user_id);
      }
      db.prepare('UPDATE e2ee_devices SET active=0,session_id=NULL,updated_at=? WHERE id=?').run(timestamp(), id);
    });
    closeRevokedSockets();
    notifyDevices(request.auth.user_id);
    return { ok: true };
  });

  app.get('/e2ee/inbox', authOptions, async request => {
    const session = assertSession(request);
    const deviceId = uuid(request.query.deviceId, 'deviceId');
    const chatId = request.query.chatId === undefined ? null : uuid(request.query.chatId, 'chatId');
    if (chatId && !db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?').get(chatId, session.user_id)) fail(404, 'Чат не найден.');
    const parseCursor = (value, fallback, label, max, min) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(400, `Некорректное число: ${label}.`);
      return integer(Number(value), label, max, min);
    };
    const after = parseCursor(request.query.after, 0, 'after', Number.MAX_SAFE_INTEGER, 0);
    const limit = parseCursor(request.query.limit, 100, 'limit', 100, 1);
    if (!db.prepare('SELECT 1 FROM e2ee_devices WHERE id=? AND user_id=? AND session_id=? AND active=1')
      .get(deviceId, session.user_id, session.id)) fail(403, 'Устройство недоступно.');
    // Drain in global ascending message order. Each client persists its ratchet
    // state, plaintext cache, and cursor together before requesting the next page.
    const rows = db.prepare(`SELECT m.* FROM messages m
      JOIN chat_members member ON member.chat_id=m.chat_id AND member.user_id=?
      WHERE m.id>? AND (? IS NULL OR m.chat_id=?) AND m.encrypted_json IS NOT NULL AND (
        (m.sender_id=? AND json_extract(m.encrypted_json,'$.senderDeviceId')=?) OR
        EXISTS (SELECT 1 FROM json_each(m.encrypted_json,'$.envelopes') envelope
          WHERE json_extract(envelope.value,'$.userId')=? AND json_extract(envelope.value,'$.deviceId')=?)
      ) ORDER BY m.id ASC LIMIT ?`)
      .all(session.user_id, after, chatId, chatId, session.user_id, deviceId, session.user_id, deviceId, limit + 1);
    const page = rows.slice(0, limit);
    // lean=1: messages this very device sent come back without their ciphertext — the device
    // has them already and has no envelope of its own to open (saves 20 KB+ per message on EDGE).
    const lean = request.query.lean === '1';
    const shape = row => { const m = publicMessage(db, row); return lean && row.sender_id === session.user_id && m.encrypted?.senderDeviceId === deviceId ? { ...m, encrypted: undefined, lean: true } : m; };
    return { messages: page.map(shape), nextCursor: page.at(-1)?.id ?? after, hasMore: rows.length > limit };
  });

  app.post('/e2ee/files', authOptions, async (request, reply) => {
    const ownerId = request.auth.user_id;
    if (!request.isMultipart()) fail(400, 'Отправьте зашифрованный файл как multipart/form-data.');
    if (!limiter.allow(`upload:${ownerId}`, 20, 60_000)) fail(429, 'Слишком много загрузок. Повторите через минуту.');
    const maxCipherBytes = maxUploadBytes + 64;
    const used = usage(ownerId);
    if (used >= storageLimit(ownerId)) fail(413, 'Достигнут лимит хранения файлов для аккаунта.');
    let attachment = null, filePath = null, persisted = false;
    try {
      for await (const part of request.parts({ limits: { fileSize: maxCipherBytes, files: 1, fields: 0, parts: 1 } })) {
        if (part.type !== 'file' || part.fieldname !== 'file' || attachment || part.mimetype !== 'application/octet-stream') {
          if (part.type === 'file') part.file.resume();
          fail(400, 'Требуется один бинарный зашифрованный файл в поле file.');
        }
        const id = randomUUID();
        filePath = join(uploadDir, id);
        let size = 0;
        const inspect = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > maxCipherBytes || used + size > storageLimit(ownerId)) {
              callback(new HttpError(413, 'Слишком большой файл или достигнут лимит хранения.'));
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(part.file, inspect, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated) fail(413, 'Зашифрованный файл превышает допустимый размер.');
        if (!size) fail(400, 'Зашифрованный файл не может быть пустым.');
        attachment = { id, size };
      }
      if (!attachment) fail(400, 'Выберите зашифрованный файл.');
      transaction(db, () => {
        assertSession(request);
        const finalUsed = usage(ownerId);
        if (finalUsed + attachment.size > storageLimit(ownerId)) fail(413, 'Достигнут лимит хранения файлов для аккаунта.');
        db.prepare("INSERT INTO uploads(id,owner_id,name,mime_type,size,is_image,is_encrypted,created_at) VALUES(?,?,'encrypted.bin','application/octet-stream',?,0,1,?)")
          .run(attachment.id, ownerId, attachment.size, timestamp());
      });
      persisted = true;
      return reply.code(201).send(attachment);
    } finally {
      if (filePath && !persisted) await unlink(filePath).catch(() => {});
    }
  });

  // These helpers run synchronously inside the message insertion transaction.
  const validateMessage = (request, chatId, encrypted) => {
    const session = assertSession(request);
    const sender = db.prepare('SELECT * FROM e2ee_devices WHERE id=? AND user_id=? AND session_id=? AND active=1')
      .get(encrypted.senderDeviceId, request.auth.user_id, session.id);
    if (!sender) fail(403, 'Устройство отправителя недоступно. Зарегистрируйте его заново.');
    const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id=?').all(chatId).map(row => row.user_id);
    if (members.length !== 2 || !members.includes(request.auth.user_id)) fail(404, 'Чат не найден.');
    const peerId = members.find(id => id !== request.auth.user_id);
    const peerDevices = activeDevices(peerId);
    const targets = [...peerDevices, ...activeDevices(request.auth.user_id).filter(device => device.id !== sender.id)];
    const expected = new Set(targets.map(device => `${device.user_id}:${device.id}`));
    if (!peerDevices.length || expected.size !== encrypted.envelopes.length ||
        encrypted.envelopes.some(envelope => !expected.has(`${envelope.userId}:${envelope.deviceId}`))) {
      fail(409, 'Список устройств изменился. Обновите ключи получателей и зашифруйте сообщение заново.', { code: 'E2EE_DEVICES_CHANGED' });
    }
    for (const id of encrypted.attachmentIds) {
      const file = db.prepare('SELECT id FROM uploads WHERE id=? AND owner_id=? AND is_encrypted=1').get(id, request.auth.user_id);
      if (!file) fail(404, 'Зашифрованное вложение не найдено.');
      if (db.prepare('SELECT 1 FROM e2ee_message_attachments WHERE upload_id=?').get(id)) fail(409, 'Это зашифрованное вложение уже прикреплено к сообщению.');
    }
  };
  const linkAttachments = (messageId, attachmentIds) => {
    for (const id of attachmentIds) db.prepare('INSERT INTO e2ee_message_attachments(upload_id,message_id) VALUES(?,?)').run(id, messageId);
  };
  // F4: a scheduled message is released without its sender's request or session (the device may be
  // offline or signed out by then). The ciphertext was encrypted for the device set of the moment it
  // was scheduled. The peer's devices must still be exactly those (a new phone of the peer would miss
  // the message; a removed one is a session the server knows nothing about). The sender's own other
  // devices are only required to be the sender's: a device added since does not get the copy (it was
  // not there when the text was encrypted), one signed out since is simply never read. Returns null
  // when the envelopes can be delivered as they are, otherwise the reason.
  const releaseCheck = (ownerId, chatId, encrypted, blocked = () => false) => {
    const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id=?').all(chatId).map(row => row.user_id);
    if (members.length !== 2 || !members.includes(ownerId)) return { code: 'CHAT_GONE', message: 'Чат не найден.' };
    const peerId = members.find(id => id !== ownerId);
    if (blocked(ownerId, peerId)) return { code: 'BLOCKED', message: 'Переписка с этим пользователем недоступна.' };
    const peerDevices = activeDevices(peerId);
    const expected = new Set(peerDevices.map(device => `${device.user_id}:${device.id}`));
    const toPeer = encrypted.envelopes.filter(envelope => envelope.userId === peerId);
    if (!peerDevices.length || expected.size !== toPeer.length || toPeer.some(envelope => !expected.has(`${envelope.userId}:${envelope.deviceId}`)) ||
        encrypted.envelopes.some(envelope => envelope.userId !== peerId && (envelope.userId !== ownerId || envelope.deviceId === encrypted.senderDeviceId))) {
      return { code: 'E2EE_DEVICES_CHANGED', message: 'Список устройств изменился. Обновите ключи получателей и зашифруйте сообщение заново.' };
    }
    for (const id of encrypted.attachmentIds) {
      if (!db.prepare('SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND is_encrypted=1').get(id, ownerId)) return { code: 'ATTACHMENT_GONE', message: 'Зашифрованное вложение не найдено.' };
      if (db.prepare('SELECT 1 FROM e2ee_message_attachments WHERE upload_id=?').get(id)) return { code: 'ATTACHMENT_USED', message: 'Это зашифрованное вложение уже прикреплено к сообщению.' };
    }
    return null;
  };
  return { expireDevices, validateMessage, linkAttachments, assertSession, releaseCheck };
}

// ---- F4 «Отправить позже»: encrypted envelopes kept until their time ---------------------------
// The client encrypts the message now, for the devices of now, and uploads the same envelopes it
// would send at once, plus `deliverAt`. The server keeps them as opaque ciphertext in
// scheduled_messages and moves them into `messages` when the clock passes deliverAt (a timer for the
// next due item, the housekeeping tick and an on-demand check at startup and on every list request,
// so a server that slept through the time catches up). Nothing is ever decrypted here.
export const MAX_SCHEDULED_PER_USER = 100;
export const MAX_SCHEDULE_AHEAD_MS = 366 * 86_400_000;
export const MIN_SCHEDULE_AHEAD_MS = 10_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** `deliverAt` (ISO 8601 with a zone) → epoch ms; it must lie ahead of `nowMs`, at most a year. */
export function parseDeliverAt(value, nowMs) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) fail(400, 'Некорректное время отправки.');
  const at = Date.parse(value);
  if (!Number.isFinite(at)) fail(400, 'Некорректное время отправки.');
  if (at < nowMs + MIN_SCHEDULE_AHEAD_MS) fail(400, 'Время отправки уже прошло.', { code: 'SCHEDULE_IN_PAST' });
  if (at > nowMs + MAX_SCHEDULE_AHEAD_MS) fail(400, 'Отложить можно не больше чем на год.');
  return at;
}

/** Failed rows are purged (with their attachments) this long after they failed: the owner has seen «не удалось» by then. */
export const FAILED_SCHEDULED_TTL_MS = 30 * 86_400_000;
/** At most this many «не удалось» rows per owner (a separate limit from the 100 waiting ones); the oldest go first. */
export const MAX_FAILED_SCHEDULED_PER_USER = 100;

export function installScheduledRoutes({ app, db, now, timestamp, authOptions, emitUser, emitChat, notify, memberIds, blockedBetween, e2ee, serializationOptions, uploadDir, writable = () => true, log = () => {} }) {
  const blocked = (a, b) => blockedBetween(db, a, b);
  const publicScheduled = (row, lean = false) => ({
    id: row.id, chatId: row.chat_id, clientId: row.client_id, deliverAt: new Date(row.deliver_at).toISOString(),
    status: row.status, failure: row.failure ?? null, push: row.push, createdAt: row.created_at, ...(lean ? {} : { encrypted: JSON.parse(row.encrypted_json) }),
  });
  const ownRow = (request, id) => {
    const row = db.prepare('SELECT * FROM scheduled_messages WHERE id=? AND owner_id=?').get(uuid(id, 'id'), request.auth.user_id);
    if (!row) fail(404, 'Отложенное сообщение не найдено.');
    return row;
  };
  // The encrypted attachments of a scheduled message are uploads of the owner that no message links yet
  // (PRAGMA foreign_keys is off: nothing cascades). When the message is dropped for good they go too;
  // after E2EE_DEVICES_CHANGED they stay: the app re-encrypts the same text with the same attachment.
  const attachmentIds = row => { try { const ids = JSON.parse(row.encrypted_json).attachmentIds; return Array.isArray(ids) ? ids : []; } catch { return []; } };
  const dropUploads = (row, keepOnDevicesChanged = true) => {
    if (keepOnDevicesChanged && row.status === 'failed' && row.failure === 'E2EE_DEVICES_CHANGED') return;
    for (const id of attachmentIds(row)) {
      const upload = db.prepare('SELECT id FROM uploads WHERE id=? AND owner_id=? AND is_encrypted=1 AND NOT EXISTS (SELECT 1 FROM e2ee_message_attachments a WHERE a.upload_id=uploads.id)').get(id, row.owner_id);
      if (!upload) continue;
      db.prepare('DELETE FROM uploads WHERE id=?').run(id);
      if (uploadDir) unlink(join(uploadDir, id)).catch(() => {});
    }
  };
  const purge = row => transaction(db, () => { dropUploads(row, false); db.prepare('DELETE FROM scheduled_messages WHERE id=?').run(row.id); });
  const markFailed = (row, code) => {
    db.prepare('UPDATE scheduled_messages SET status=?,failure=?,failed_at=? WHERE id=? AND status=?').run('failed', code, now(), row.id, 'scheduled');
    dropUploads({ ...row, status: 'failed', failure: code });
    for (const old of db.prepare('SELECT * FROM scheduled_messages WHERE owner_id=? AND status=? ORDER BY failed_at DESC,id LIMIT -1 OFFSET ?').all(row.owner_id, 'failed', MAX_FAILED_SCHEDULED_PER_USER)) purge(old);
    emitUser(row.owner_id, { type: 'scheduled', chatId: row.chat_id, reason: 'failed', id: row.id });
  };

  /** Moves one scheduled row into the chat (or marks it «не удалось»); returns { message } or { failure, scheduled }. `exceptSession`: the owner's session that asked (it has the HTTP answer). */
  const release = (row, exceptSession = null) => {
    const encrypted = JSON.parse(row.encrypted_json);
    const outcome = transaction(db, () => {
      const current = db.prepare('SELECT 1 FROM scheduled_messages WHERE id=? AND status=?').get(row.id, 'scheduled');
      if (!current) return null; // released or deleted meanwhile
      let problem = e2ee.releaseCheck(row.owner_id, row.chat_id, encrypted, blocked);
      if (!problem && db.prepare('SELECT 1 FROM messages WHERE sender_id=? AND client_id=?').get(row.owner_id, row.client_id)) problem = { code: 'CLIENT_ID_USED', message: 'Этот ключ сообщения уже использован.' };
      if (problem) return { failure: problem };
      const date = timestamp();
      // Never `silent`: a scheduled message is news for the peer (silent=1 marks reactions and edits).
      const result = db.prepare('INSERT INTO messages(chat_id,sender_id,client_id,text,attachment_id,encrypted_json,silent,created_at) VALUES(?,?,?,?,?,?,0,?)')
        .run(row.chat_id, row.owner_id, row.client_id, '', null, row.encrypted_json, date);
      const messageId = Number(result.lastInsertRowid);
      e2ee.linkAttachments(messageId, encrypted.attachmentIds);
      db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(date, row.chat_id);
      db.prepare('DELETE FROM scheduled_messages WHERE id=?').run(row.id);
      return { messageId };
    });
    if (!outcome) return null;
    if (outcome.failure) {
      markFailed(row, outcome.failure.code);
      return { failure: outcome.failure, scheduled: publicScheduled(db.prepare('SELECT * FROM scheduled_messages WHERE id=?').get(row.id)) };
    }
    const message = publicMessage(db, db.prepare('SELECT * FROM messages WHERE id=?').get(outcome.messageId), serializationOptions);
    for (const userId of memberIds(row.chat_id)) emitUser(userId, { type: 'message', chatId: row.chat_id, message }, userId === row.owner_id ? exceptSession : null);
    emitChat(row.chat_id);
    emitUser(row.owner_id, { type: 'scheduled', chatId: row.chat_id, reason: 'sent', id: row.id }, exceptSession);
    notify(row.chat_id, row.owner_id, row.push);
    return { message };
  };

  let timer = null, closed = false;
  // In a cluster only the primary with a live lease writes (cluster.js writable()); a replica leaves
  // the rows alone — the housekeeping tick asks again, and a new primary releases at its start.
  const releaseDue = () => {
    if (closed || !writable()) return 0;
    const due = db.prepare('SELECT * FROM scheduled_messages WHERE status=? AND deliver_at<=? ORDER BY deliver_at,created_at,id').all('scheduled', now());
    let released = 0;
    for (const row of due) {
      try { if (release(row)) released++; }
      catch (error) {
        // A row that cannot be released (a corrupt envelope, a database error) is marked «не удалось»
        // instead of being retried every few milliseconds by the timer below.
        log(error, 'scheduled release failed');
        try { markFailed(row, 'RELEASE_ERROR'); } catch (inner) { log(inner, 'scheduled row could not be marked failed'); }
      }
    }
    try {
      for (const row of db.prepare('SELECT * FROM scheduled_messages WHERE status=? AND COALESCE(failed_at,deliver_at)<=?').all('failed', now() - FAILED_SCHEDULED_TTL_MS)) purge(row);
    } catch (error) { log(error, 'scheduled purge failed'); }
    arm();
    return released;
  };
  // The timer is set from the real clock delta so a message due in two days does not wait for a
  // tick; the housekeeping tick and the list request cover a clock that jumps (tests, suspend).
  const arm = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (closed) return;
    const next = db.prepare('SELECT MIN(deliver_at) AS at FROM scheduled_messages WHERE status=?').get('scheduled').at;
    if (next === null || next === undefined) return;
    timer = setTimeout(() => { timer = null; releaseDue(); }, Math.min(Math.max(next - now(), 0) + 5, 0x7fffffff));
    timer.unref();
  };
  const close = () => { closed = true; if (timer) clearTimeout(timer); timer = null; };

  /** POST /chats/:chatId/messages with deliverAt: runs inside the send route after parsing (session, rate limit done there). */
  const create = (request, chatId, { clientId, encrypted, encryptedJson, push, deliverAt }) => {
    const at = parseDeliverAt(deliverAt, now());
    if (!['message', 'silent'].includes(push)) fail(400, 'Отложить можно только обычное сообщение.');
    const ownerId = request.auth.user_id;
    const row = transaction(db, () => {
      const previous = db.prepare('SELECT * FROM scheduled_messages WHERE owner_id=? AND client_id=?').get(ownerId, clientId);
      if (previous) {
        if (previous.chat_id !== chatId || previous.encrypted_json !== encryptedJson) fail(409, 'Этот ключ сообщения уже использован с другим зашифрованным содержимым.');
        return previous;
      }
      // Only what is still waiting counts: «не удалось» rows wait for the owner (or the purge above), not for the limit.
      if (db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages WHERE owner_id=? AND status=?').get(ownerId, 'scheduled').n >= MAX_SCHEDULED_PER_USER) fail(409, 'Отложить можно не больше 100 сообщений.', { code: 'SCHEDULE_LIMIT' });
      e2ee.validateMessage(request, chatId, encrypted);
      for (const id of encrypted.attachmentIds) {
        if (db.prepare("SELECT 1 FROM scheduled_messages s, json_each(s.encrypted_json,'$.attachmentIds') a WHERE a.value=?").get(id)) fail(409, 'Это зашифрованное вложение уже прикреплено к сообщению.');
      }
      const id = randomUUID(), date = timestamp();
      db.prepare('INSERT INTO scheduled_messages(id,owner_id,chat_id,client_id,encrypted_json,push,deliver_at,status,failure,created_at) VALUES(?,?,?,?,?,?,?,?,NULL,?)')
        .run(id, ownerId, chatId, clientId, encryptedJson, push, at, 'scheduled', date);
      return db.prepare('SELECT * FROM scheduled_messages WHERE id=?').get(id);
    });
    arm();
    emitUser(ownerId, { type: 'scheduled', chatId, reason: 'added', id: row.id }, request.auth.id);
    return publicScheduled(row);
  };

  // ?lean=1: without the ciphertext (the app's periodic refresh only needs ids, times and states; its
  // own copy of the text is in the vault under the clientId).
  app.get('/scheduled', authOptions, async request => {
    e2ee.assertSession(request);
    releaseDue(); // on-demand check: whatever is due goes out before the list is answered
    const chatId = request.query.chatId === undefined ? null : uuid(request.query.chatId, 'chatId');
    const rows = db.prepare('SELECT * FROM scheduled_messages WHERE owner_id=? AND (? IS NULL OR chat_id=?) ORDER BY deliver_at,created_at,id')
      .all(request.auth.user_id, chatId, chatId);
    const lean = request.query.lean === '1';
    return { items: rows.map(row => publicScheduled(row, lean)) };
  });
  app.delete('/scheduled/:id', authOptions, async request => {
    e2ee.assertSession(request);
    const row = ownRow(request, request.params.id);
    transaction(db, () => { dropUploads(row); db.prepare('DELETE FROM scheduled_messages WHERE id=?').run(row.id); });
    arm();
    emitUser(row.owner_id, { type: 'scheduled', chatId: row.chat_id, reason: 'deleted', id: row.id }, request.auth.id);
    return { ok: true };
  });
  // «Отправить сейчас»: the stored envelopes go out at once. A device-set change since scheduling
  // is answered with 409 E2EE_DEVICES_CHANGED (the row is marked «не удалось»): only the sender's
  // device can encrypt afresh, so the app re-encrypts and sends through the normal route.
  app.post('/scheduled/:id/send', authOptions, async (request, reply) => {
    e2ee.assertSession(request);
    const row = ownRow(request, request.params.id);
    if (row.status !== 'scheduled') fail(409, 'Сообщение не удалось отправить: зашифруйте его заново.', { code: row.failure || 'E2EE_DEVICES_CHANGED' });
    // The asking device gets the message from this answer, like a normal send (lean: without its own ciphertext).
    const outcome = release(row, request.query?.lean === '1' ? request.auth.id : null);
    if (!outcome) fail(404, 'Отложенное сообщение не найдено.');
    if (outcome.failure) fail(409, outcome.failure.message, { code: outcome.failure.code });
    return reply.code(201).send({ message: request.query?.lean === '1' ? { ...outcome.message, encrypted: undefined } : outcome.message });
  });

  releaseDue();
  return { releaseDue, create, close };
}
