import Fastify, { LogController } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { mkdir, chmod, unlink, access } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openDatabase, transaction, publicUser as serializePublicUser, publicChat, publicMessage, publicAttachment, privacyOf, userForViewer, receiptsVisible } from './database.js';
import { installAuthRoutes, RECOVERY_LOCK_MS } from './auth.js';
import { installE2eeRoutes, parseEncryptedMessage } from './e2ee.js';
import { registerAiRoutes, aiProvider } from './ai.js';
import { installUsernameRoutes } from './username.js';
import { installSocialRoutes } from './social.js';
import {
  HttpError, fail, passwordHash, tokenHash, newToken, validToken,
  objectBody, boundedText, positiveInteger, imageMime, safeFilename, createLimiter,
} from './security.js';

const MiB = 1024 * 1024;
const MAX_AVATAR_BYTES = 4 * MiB;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

// React Native Android sends an endpoint Origin even for a native WebSocket.
// This exception is scoped to the upgrade route, uses the raw Host (never
// X-Forwarded-Host), and does not grant HTTP CORS access. Both http(s) schemes
// are accepted because a TLS-terminating proxy may connect to us over HTTP.
function isEndpointWebSocketOrigin(request, origin) {
  if (request.method !== 'GET' || request.routeOptions.url !== '/ws' ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin &&
      parsed.host === request.raw.headers.host;
  } catch { return false; }
}

/** An independent, ready Fastify instance; tests may inject requests without binding a port. */
export async function buildApp({
  dataDir = resolve('data'),
  logger = false,
  allowedOrigins = [],
  trustProxy = false,
  sessionTtlMs = SESSION_TTL,
  authRateLimit = 20,
  maxUploadBytes = 20 * MiB,
  maxStoredBytesPerUser = 512 * MiB,
  maxConcurrentPasswordJobs = 4,
  authTestHooks,
  aiApiKey = '',
  aiProviderConfig = {},
  aiFetch = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) throw new Error('sessionTtlMs must be positive');
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) throw new Error('maxUploadBytes must be positive');
  if (!Number.isSafeInteger(maxConcurrentPasswordJobs) || maxConcurrentPasswordJobs <= 0) throw new Error('maxConcurrentPasswordJobs must be positive');
  const storageDir = resolve(dataDir);
  const uploadDir = join(storageDir, 'uploads');
  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(storageDir);
  await chmod(join(storageDir, 'linea.sqlite'), 0o600);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  const origins = new Set(allowedOrigins);
  const limiter = createLimiter(now);
  const sockets = new Set();
  let passwordJobs = 0;
  let databaseClosed = false;
  let expireEncryptionDevices = () => {};
  // A missing account follows the same scrypt path as a known account.
  const dummyPasswordHash = await passwordHash(randomUUID());
  const app = Fastify({
    logger: logger ? {
      ...(typeof logger === 'object' ? logger : {}),
      redact: [
        'req.headers.authorization', 'req.headers.cookie',
        ...['password', 'currentPassword', 'newPassword', 'confirmationWord', 'currentConfirmationWord',
          'recoveryWord', 'newRecoveryWord', 'newConfirmationWord', 'resetToken', 'token']
          .flatMap(field => [`body.${field}`, `req.body.${field}`]),
      ],
    } : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 75_000,
    trustProxy,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
  });
  app.decorateRequest('auth', null);

  const timestamp = () => new Date(now()).toISOString();
  const serializationOptions = { now };
  const publicUser = row => serializePublicUser(row,{db,now});
  const sessionForToken = token => {
    if (!validToken(token)) return null;
    return db.prepare('SELECT token_hash,id,user_id,expires_at,last_active_at FROM sessions WHERE token_hash=? AND expires_at>?')
      .get(tokenHash(token), now()) || null;
  };
  const sessionStillValid = state => state.auth && db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?')
    .get(state.auth.token_hash, now());
  const sendSocket = (state, payload) => {
    if (state.socket.readyState !== 1) return;
    if (state.socket.bufferedAmount > MiB) {
      state.socket.close(1013, 'Slow connection');
      return;
    }
    state.socket.send(JSON.stringify(payload));
  };
  const emitUser = (userId, payload) => {
    for (const state of sockets) {
      if (state.auth?.user_id !== userId) continue;
      if (!sessionStillValid(state)) {
        state.socket.close(4401, 'Session expired');
        continue;
      }
      sendSocket(state, payload);
    }
  };
  const closeRevokedSockets = recoveryUpdatedUserId => {
    for (const state of sockets) {
      if (!state.auth || sessionStillValid(state)) continue;
      // Only non-secret metadata is sent before sign-out. Normal emitUser cannot
      // notify these sockets because their sessions were just revoked atomically.
      if (state.auth.user_id === recoveryUpdatedUserId) sendSocket(state, { type: 'recovery.updated' });
      state.socket.close(4401, 'Session revoked');
    }
    expireEncryptionDevices();
  };
  const memberIds = chatId => db.prepare('SELECT user_id FROM chat_members WHERE chat_id=?').all(chatId).map(row => row.user_id);
  const emitChat = chatId => {
    for (const userId of memberIds(chatId)) emitUser(userId, { type: 'chat', chat: publicChat(db, chatId, userId, serializationOptions) });
  };
  const requireMembership = (chatId, userId) => {
    const member = db.prepare('SELECT * FROM chat_members WHERE chat_id=? AND user_id=?').get(chatId, userId);
    if (!member) fail(404, 'Чат не найден.');
    return member;
  };
  const requireAuth = async request => {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header) ? header.slice(7) : null;
    const session = sessionForToken(token);
    if (!session) fail(401, 'Войдите в аккаунт заново.');
    request.auth = session;
    if (!limiter.allow(`api:${session.user_id}`, 600, 60_000)) fail(429, 'Слишком много запросов. Попробуйте через минуту.');
    if (now() - Date.parse(session.last_active_at) >= 60_000) {
      db.prepare('UPDATE sessions SET last_active_at=? WHERE token_hash=? AND expires_at>?').run(timestamp(), session.token_hash, now());
    }
  };
  const authOptions = { preHandler: requireAuth };
  const newSession = (userId, deviceName) => {
    const token = newToken();
    const date = timestamp();
    db.prepare('INSERT INTO sessions(token_hash,id,user_id,expires_at,created_at,device_name,last_active_at) VALUES(?,?,?,?,?,?,?)')
      .run(tokenHash(token), randomUUID(), userId, now() + sessionTtlMs, date, deviceName, date);
    return token;
  };
  const authThrottle = request => {
    if (!limiter.allow(`auth:${request.ip}`, authRateLimit, 15 * 60_000)) fail(429, 'Слишком много попыток входа. Повторите через 15 минут.');
  };
  const recoveryStatusThrottle = request => {
    if (!limiter.allow(`recovery-status:${request.ip}`, 120, 60_000)) fail(429, 'Слишком много запросов статуса. Повторите через минуту.');
  };
  const allowAccountLogin = username => limiter.allow(`account:${username}`, authRateLimit === false ? false : authRateLimit * 2, 15 * 60_000);
  const withPasswordJob = async work => {
    if (passwordJobs >= maxConcurrentPasswordJobs) fail(503, 'Сервер занят. Попробуйте через несколько секунд.');
    passwordJobs++;
    try { return await work(); } finally { passwordJobs--; }
  };

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    const origin = request.headers.origin;
    if (origin) {
      const allowlisted = origins.has(origin);
      if (!allowlisted && !isEndpointWebSocketOrigin(request, origin)) fail(403, 'Этот источник запросов не разрешён.');
      if (allowlisted) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      }
    }
    if (request.query && ('token' in request.query || 'access_token' in request.query)) {
      fail(400, 'Передавайте токен только в заголовке Authorization или первом сообщении WebSocket.');
    }
  });
  app.options('/*', async (_request, reply) => reply.code(204).send());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      if (error.details?.retryAfterSeconds) reply.header('Retry-After', error.details.retryAfterSeconds);
      return reply.code(error.statusCode).send({ error: error.message, ...error.details });
    }
    if (['FST_REQ_FILE_TOO_LARGE', 'FST_ERR_CTP_BODY_TOO_LARGE'].includes(error.code)) {
      return reply.code(413).send({ error: 'Слишком большой файл или запрос.' });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'Некорректный запрос.' });
    }
    // Do not log request bodies, URLs, passwords, bearer tokens or SQL parameters.
    app.log.error({ code: error.code || 'INTERNAL', name: error.name }, 'Request failed');
    return reply.code(500).send({ error: 'Ошибка сервера. Попробуйте ещё раз.' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Адрес не найден.' }));

  app.addHook('preClose', async () => {
    for (const state of sockets) state.socket.terminate();
  });
  await app.register(websocket, { options: { maxPayload: 4096, perMessageDeflate: false } });
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fieldNameSize: 100, fileSize: maxUploadBytes, headerPairs: 100 },
  });

  app.get('/health', async () => ({ status: 'ok' }));

  installAuthRoutes({
    app, db, now, timestamp, authOptions, authThrottle, recoveryStatusThrottle,
    allowAccountLogin, withPasswordJob, newSession, dummyPasswordHash,
    closeRevokedSockets, emitUser, authTestHooks,
  });
  registerAiRoutes(app,{authenticate:requireAuth,apiKey:aiApiKey,provider:aiProvider(aiProviderConfig),fetchImpl:aiFetch,allowedOrigins,now});
  installUsernameRoutes({app,db,now,authOptions,emitUser,emitChat});
  installSocialRoutes({app,db,authOptions,publicUser,timestamp,serializationOptions,emitUser});
  const e2ee = installE2eeRoutes({
    app, db, now, timestamp, authOptions, emitUser, limiter, uploadDir,
    maxUploadBytes, maxStoredBytesPerUser, closeRevokedSockets,
  });
  expireEncryptionDevices = e2ee.expireDevices;
  expireEncryptionDevices();

  app.get('/me', authOptions, async request => {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(request.auth.user_id);
    return { user: publicUser(user), securitySetupRequired: !user.confirmation_hash || !user.recovery_hash };
  });

  app.patch('/me', authOptions, async request => {
    const body = objectBody(request.body, ['displayName', 'bio', 'avatarColor', 'avatarId']);
    const current = db.prepare('SELECT * FROM users WHERE id=?').get(request.auth.user_id);
    const displayName = body.displayName === undefined ? current.display_name : boundedText(body.displayName, 'Имя', 1, 50);
    const bio = body.bio === undefined ? current.bio : boundedText(body.bio, 'О себе', 0, 160);
    const avatarColor = body.avatarColor === undefined ? current.avatar_color : body.avatarColor;
    if (typeof avatarColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(avatarColor)) fail(400, 'Цвет должен быть в формате #RRGGBB.');
    const avatarId = body.avatarId === undefined ? current.avatar_id : body.avatarId;
    if (avatarId !== null) {
      if (typeof avatarId !== 'string') fail(400, 'Некорректное фото профиля.');
      const upload = db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=?').get(avatarId, current.id);
      if (!upload) fail(404, 'Фото профиля не найдено.');
      if (!upload.is_image || upload.size > MAX_AVATAR_BYTES) fail(400, 'Фото профиля должно быть изображением PNG, JPEG, GIF или WebP до 4 МиБ.');
    }
    db.prepare('UPDATE users SET display_name=?,bio=?,avatar_color=?,avatar_id=? WHERE id=?')
      .run(displayName, bio, avatarColor.toUpperCase(), avatarId, current.id);
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(current.id));
    emitUser(current.id, { type: 'profile', user });
    const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(current.id);
    for (const { chat_id } of chats) {
      for (const peerId of memberIds(chat_id)) if (peerId !== current.id) emitUser(peerId, { type: 'profile', user: userForViewer(db, user, peerId) });
      emitChat(chat_id);
    }
    return { user };
  });

  app.get('/me/privacy', authOptions, async request => ({ privacy: privacyOf(db, request.auth.user_id) }));

  app.patch('/me/privacy', authOptions, async request => {
    const body = objectBody(request.body, ['allowNewChats', 'showAvatar', 'readReceipts']);
    const userId = request.auth.user_id;
    const next = { ...privacyOf(db, userId) };
    for (const key of ['allowNewChats', 'showAvatar', 'readReceipts']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') fail(400, 'Настройка конфиденциальности должна быть включена или выключена.');
      next[key] = body[key];
    }
    db.prepare(`INSERT INTO user_privacy(user_id,allow_new_chats,show_avatar,read_receipts,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET allow_new_chats=excluded.allow_new_chats,show_avatar=excluded.show_avatar,read_receipts=excluded.read_receipts,updated_at=excluded.updated_at`)
      .run(userId, next.allowNewChats ? 1 : 0, next.showAvatar ? 1 : 0, next.readReceipts ? 1 : 0, timestamp());
    // Peers get a fresh view of the avatar and of read receipts.
    for (const { chat_id } of db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(userId)) emitChat(chat_id);
    return { privacy: next };
  });

  app.get('/users', authOptions, async request => {
    const query = boundedText(request.query.q, 'Поиск', 2, 100);
    const usernameOnly=query.startsWith('@');
    // SQLite's built-in LOWER is ASCII-only; the registered function also handles Cyrillic names.
    const escaped = (usernameOnly?query.slice(1):query).toLowerCase().replace(/[\\%_]/g, '\\$&');
    const users = db.prepare("SELECT * FROM users WHERE id != ? AND (username LIKE ? ESCAPE '\\' OR (?=0 AND unicode_lower(display_name) LIKE ? ESCAPE '\\')) ORDER BY username LIMIT 30")
      .all(request.auth.user_id, `%${escaped}%`, usernameOnly?1:0, `%${escaped}%`).map(row => userForViewer(db, publicUser(row), request.auth.user_id));
    return { users };
  });

  app.get('/chats', authOptions, async request => {
    const rows = db.prepare('SELECT c.id FROM chats c JOIN chat_members m ON c.id=m.chat_id WHERE m.user_id=? ORDER BY c.updated_at DESC,c.id DESC').all(request.auth.user_id);
    return { chats: rows.map(row => publicChat(db, row.id, request.auth.user_id, serializationOptions)) };
  });

  app.post('/chats', authOptions, async (request, reply) => {
    const body = objectBody(request.body, ['userId']);
    const peerId = boundedText(body.userId, 'Пользователь', 1, 100);
    const selfId = request.auth.user_id;
    if (peerId === selfId) fail(400, 'Выберите другого пользователя.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(peerId)) fail(404, 'Пользователь не найден.');
    const pairKey = [selfId, peerId].sort().join(':');
    let chat = db.prepare('SELECT * FROM chats WHERE pair_key=?').get(pairKey);
    let created = false;
    if (!chat && !privacyOf(db, peerId).allowNewChats) fail(403, 'Пользователь ограничил новые разговоры.', { code: 'NEW_CHATS_DISABLED' });
    if (!chat) {
      const id = randomUUID();
      const date = timestamp();
      transaction(db, () => {
        db.prepare('INSERT INTO chats(id,pair_key,created_at,updated_at) VALUES(?,?,?,?)').run(id, pairKey, date, date);
        const insertMember = db.prepare('INSERT INTO chat_members(chat_id,user_id) VALUES(?,?)');
        insertMember.run(id, selfId);
        insertMember.run(id, peerId);
      });
      chat = { id };
      created = true;
      emitChat(id);
    }
    return reply.code(created ? 201 : 200).send({ chat: publicChat(db, chat.id, selfId, serializationOptions) });
  });

  app.get('/chats/:chatId/messages', authOptions, async request => {
    requireMembership(request.params.chatId, request.auth.user_id);
    const limitRaw = request.query.limit;
    const beforeRaw = request.query.before;
    if (limitRaw !== undefined && (typeof limitRaw !== 'string' || !/^\d+$/.test(limitRaw))) fail(400, 'Некорректный лимит сообщений.');
    if (beforeRaw !== undefined && (typeof beforeRaw !== 'string' || !/^\d+$/.test(beforeRaw))) fail(400, 'Некорректная граница сообщений.');
    const limit = limitRaw === undefined ? 50 : positiveInteger(Number(limitRaw), 'Лимит');
    if (limit > 100) fail(400, 'Максимум 100 сообщений за запрос.');
    const before = beforeRaw === undefined ? Number.MAX_SAFE_INTEGER : positiveInteger(Number(beforeRaw), 'Граница сообщений');
    const rows = db.prepare('SELECT * FROM messages WHERE chat_id=? AND id<? ORDER BY id DESC LIMIT ?')
      .all(request.params.chatId, before, limit + 1);
    return { messages: rows.slice(0, limit).reverse().map(row => publicMessage(db, row, serializationOptions)), hasMore: rows.length > limit };
  });

  app.post('/chats/:chatId/messages', { ...authOptions, bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const chatId = request.params.chatId;
    const senderId = request.auth.user_id;
    requireMembership(chatId, senderId);
    const body = objectBody(request.body, ['text', 'attachmentId', 'clientId', 'encrypted']);
    if (body.text !== undefined || body.attachmentId !== undefined || !body.encrypted) {
      fail(400, 'Сообщения принимаются только в зашифрованном виде.', { code: 'E2EE_PLAINTEXT_REJECTED' });
    }
    const clientId = boundedText(body.clientId, 'Ключ сообщения', 8, 100);
    const encrypted = parseEncryptedMessage(body.encrypted);
    const encryptedJson = JSON.stringify(encrypted);
    const previous = db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_id=?').get(senderId, clientId);
    if (previous) {
      if (previous.chat_id !== chatId) fail(409, 'Этот ключ сообщения уже используется в другом чате.');
      if ((previous.encrypted_json || null) !== encryptedJson) fail(409, 'Этот ключ сообщения уже использован с другим зашифрованным содержимым.');
      return reply.code(200).send({ message: publicMessage(db, previous, serializationOptions) });
    }
    if (!limiter.allow(`send:${senderId}`, 120, 60_000)) fail(429, 'Слишком много сообщений. Подождите минуту.');
    const date = timestamp();
    const id = transaction(db, () => {
      e2ee.validateMessage(request, chatId, encrypted);
      const result = db.prepare('INSERT INTO messages(chat_id,sender_id,client_id,text,attachment_id,encrypted_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(chatId, senderId, clientId, '', null, encryptedJson, date);
      const messageId = Number(result.lastInsertRowid);
      e2ee.linkAttachments(messageId, encrypted.attachmentIds);
      db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(date, chatId);
      return messageId;
    });
    const message = publicMessage(db, db.prepare('SELECT * FROM messages WHERE id=?').get(id), serializationOptions);
    for (const userId of memberIds(chatId)) emitUser(userId, { type: 'message', chatId, message });
    emitChat(chatId);
    return reply.code(201).send({ message });
  });

  app.post('/chats/:chatId/read', authOptions, async request => {
    const chatId = request.params.chatId;
    const userId = request.auth.user_id;
    const member = requireMembership(chatId, userId);
    const body = objectBody(request.body, ['messageId']);
    const messageId = positiveInteger(body.messageId, 'Номер сообщения');
    if (!db.prepare('SELECT 1 FROM messages WHERE id=? AND chat_id=?').get(messageId, chatId)) fail(404, 'Сообщение не найдено в этом чате.');
    const lastReadMessageId = Math.max(member.last_read_message_id, messageId);
    if (lastReadMessageId > member.last_read_message_id) {
      db.prepare('UPDATE chat_members SET last_read_message_id=? WHERE chat_id=? AND user_id=?').run(lastReadMessageId, chatId, userId);
      for (const targetId of memberIds(chatId)) {
        if (targetId !== userId && !receiptsVisible(db, userId, targetId)) continue;
        emitUser(targetId, { type: 'read', chatId, userId, messageId: lastReadMessageId });
      }
      emitChat(chatId);
    }
    return { ok: true, lastReadMessageId };
  });

  app.post('/uploads', authOptions, async (request, reply) => {
    const ownerId = request.auth.user_id;
    if (!request.isMultipart()) fail(400, 'Отправьте файл как multipart/form-data.');
    if (!limiter.allow(`upload:${ownerId}`, 20, 60_000)) fail(429, 'Слишком много загрузок. Попробуйте через минуту.');
    const used = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner_id=?').get(ownerId).bytes;
    if (used >= maxStoredBytesPerUser) fail(413, 'Достигнут лимит хранения файлов для аккаунта.');
    let attachment = null;
    let filePath = null;
    let persisted = false;
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'file' || attachment) {
          if (part.type === 'file') part.file.resume();
          fail(400, 'Допустим один файл в поле file.');
        }
        const id = randomUUID();
        filePath = join(uploadDir, id);
        let size = 0;
        let header = Buffer.alloc(0);
        const inspect = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > maxUploadBytes || used + size > maxStoredBytesPerUser) {
              callback(new HttpError(413, 'Слишком большой файл или достигнут лимит хранения.'));
              return;
            }
            if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
            callback(null, chunk);
          },
        });
        await pipeline(part.file, inspect, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated) fail(413, 'Файл превышает допустимый размер.');
        const mime = imageMime(header);
        if (!mime || size > MAX_AVATAR_BYTES) fail(400, 'Для фото профиля допустимо изображение PNG, JPEG, GIF или WebP до 4 МиБ. Отправка файлов в чат требует шифрования.');
        attachment = { id, name: safeFilename(part.filename), mime_type: mime || 'application/octet-stream', size, is_image: mime ? 1 : 0 };
      }
      if (!attachment) fail(400, 'Выберите файл для загрузки.');
      if (!sessionStillValid({ auth: request.auth })) fail(401, 'Войдите в аккаунт заново.');
      // Recheck after async streaming: parallel uploads must not bypass the account quota.
      const finalUsed = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner_id=?').get(ownerId).bytes;
      if (finalUsed + attachment.size > maxStoredBytesPerUser) fail(413, 'Достигнут лимит хранения файлов для аккаунта.');
      db.prepare('INSERT INTO uploads(id,owner_id,name,mime_type,size,is_image,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(attachment.id, ownerId, attachment.name, attachment.mime_type, attachment.size, attachment.is_image, timestamp());
      persisted = true;
      return reply.code(201).send({ attachment: publicAttachment(attachment) });
    } finally {
      if (filePath && !persisted) await unlink(filePath).catch(() => {});
    }
  });

  app.get('/files/:id', authOptions, async (request, reply) => {
    const upload = db.prepare('SELECT * FROM uploads WHERE id=?').get(request.params.id);
    if (!upload) fail(404, 'Файл не найден.');
    const userId = request.auth.user_id;
    // The only public media is a deliberately published profile avatar.
    // Historical unencrypted conversation files cannot be downloaded, even by
    // the uploader. Staged avatars remain private until explicitly published.
    const avatarOwner = upload.is_image ? db.prepare('SELECT id FROM users WHERE avatar_id=?').get(upload.id) : null;
    const publicAvatar = Boolean(avatarOwner) && (avatarOwner.id === userId || privacyOf(db, avatarOwner.id).showAvatar);
    if (!upload.is_encrypted && upload.attached_message_id && !publicAvatar) fail(404, 'Файл не найден.');
    let permitted = upload.owner_id === userId || publicAvatar;
    if (!permitted && upload.is_encrypted) {
      permitted = Boolean(db.prepare('SELECT 1 FROM e2ee_message_attachments a JOIN messages m ON m.id=a.message_id JOIN chat_members c ON c.chat_id=m.chat_id WHERE a.upload_id=? AND c.user_id=?')
        .get(upload.id, userId));
    }
    if (!permitted) fail(404, 'Файл не найден.');
    const filePath = join(uploadDir, upload.id);
    try { await access(filePath); } catch { fail(404, 'Файл недоступен.'); }
    if (!sessionStillValid({ auth: request.auth })) fail(401, 'Войдите в аккаунт заново.');
    const fileName = upload.is_encrypted ? 'encrypted.bin' : upload.name;
    const fallbackName = fileName.replace(/[^a-zA-Z0-9._ -]/g, '_').replaceAll('"', '_');
    const encodedName = encodeURIComponent(fileName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    reply.header('Content-Disposition', `${!upload.is_encrypted && upload.is_image ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
    reply.header('Content-Length', upload.size);
    reply.type(upload.is_encrypted ? 'application/octet-stream' : upload.mime_type);
    return reply.send(createReadStream(filePath));
  });

  app.get('/ws', {
    websocket: true,
    preValidation: async request => {
      if (!limiter.allow(`ws-connect:${request.ip}`, 60, 60_000)) fail(429, 'Слишком много подключений.');
      let sameIp = 0;
      for (const state of sockets) if (state.ip === request.ip) sameIp++;
      if (sameIp >= 100 || sockets.size >= 1000) fail(503, 'Достигнут лимит подключений.');
    },
  }, (socket, request) => {
    const state = { socket, ip: request.ip, auth: null, id: randomUUID(), alive: true };
    sockets.add(state);
    const authDeadline = setTimeout(() => {
      if (!state.auth) socket.close(4401, 'Authentication required');
    }, 5000);
    authDeadline.unref();
    socket.on('error', () => {});
    socket.on('pong', () => { state.alive = true; });
    socket.on('close', () => {
      clearTimeout(authDeadline);
      sockets.delete(state);
    });
    socket.on('message', (buffer, isBinary) => {
      try {
        if (isBinary) { socket.close(1003, 'Text JSON required'); return; }
        if (!limiter.allow(`ws-frame:${state.id}`, 90, 60_000)) { socket.close(4429, 'Rate limit'); return; }
        let data;
        try { data = JSON.parse(buffer.toString()); } catch { socket.close(1007, 'Invalid JSON'); return; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) { socket.close(1007, 'Invalid JSON'); return; }
        if (!state.auth) {
          if (data.type !== 'auth') { socket.close(4401, 'Authentication required'); return; }
          const session = sessionForToken(data.token);
          if (!session) { socket.close(4401, 'Invalid session'); return; }
          const sameUser = [...sockets].filter(item => item.auth?.user_id === session.user_id).length;
          if (sameUser >= 10) { socket.close(4429, 'Connection limit'); return; }
          state.auth = session;
          clearTimeout(authDeadline);
          sendSocket(state, { type: 'ready', userId: session.user_id });
          return;
        }
        if (!sessionStillValid(state)) { socket.close(4401, 'Session expired'); return; }
        if (data.type === 'ping') { sendSocket(state, { type: 'pong' }); return; }
        if (data.type === 'typing') {
          if (typeof data.chatId !== 'string' || typeof data.isTyping !== 'boolean') fail(400, 'Некорректное событие набора текста.');
          requireMembership(data.chatId, state.auth.user_id);
          if (!limiter.allow(`typing:${state.auth.user_id}`, 30, 10_000)) fail(429, 'Слишком много событий набора текста.');
          for (const userId of memberIds(data.chatId)) if (userId !== state.auth.user_id) {
            emitUser(userId, { type: 'typing', chatId: data.chatId, userId: state.auth.user_id, isTyping: data.isTyping });
          }
          return;
        }
        sendSocket(state, { type: 'error', error: 'Неизвестный тип события.' });
      } catch (error) {
        sendSocket(state, { type: 'error', error: error instanceof HttpError ? error.message : 'Не удалось обработать событие.' });
      }
    });
  });

  const maintenance = setInterval(() => {
    if (databaseClosed) return;
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    db.prepare('DELETE FROM recovery_grants WHERE expires_at <= ?').run(now());
    db.prepare('DELETE FROM recovery_attempts WHERE updated_at<=? AND locked_until<=?')
      .run(now() - RECOVERY_LOCK_MS, now());
    expireEncryptionDevices();
    limiter.sweep();
    for (const state of sockets) {
      if (state.auth && !sessionStillValid(state)) { state.socket.close(4401, 'Session expired'); continue; }
      if (!state.alive) { state.socket.terminate(); continue; }
      state.alive = false;
      if (state.socket.readyState === 1) state.socket.ping();
    }
  }, 30_000);
  maintenance.unref();
  app.addHook('onClose', async () => {
    clearInterval(maintenance);
    if (!databaseClosed) { databaseClosed = true; db.close(); }
  });
  try { await app.ready(); } catch (error) { await app.close(); throw error; }
  return app;
}
