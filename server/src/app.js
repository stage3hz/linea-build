import { createSfu, sfuConfig } from './sfu.js';
import { installCallRoutes } from './calls.js';
import { parseClientInfo, clientGateDecision } from './clientgate.js';
import { verifyAttest, attestMode } from './attest.js';
import { createRelease } from './release.js';
import { PUSH_SCHEMA, PUSH_KINDS, chatNotification, migratePushTokens } from './push.js';
import { MODERATION_SCHEMA, installModerationRoutes, blockedBetween, deleteAccount, deleteChatForEveryone } from './moderation.js';
import { installSoundCloudRoutes } from './soundcloud.js';
import { COMMUNITY_SCHEMA, installCommunityRoutes, VOICE_LIMIT } from './communities.js';
import Fastify, { LogController } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdir, chmod, unlink, access } from 'node:fs/promises';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CALL_MODES, canCall, installCallPrivacyRoutes, migrateCallPrivacy } from './callprivacy.js';
import { openDatabase, transaction, publicUser as serializePublicUser, publicChat, publicMessage, publicAttachment, privacyOf, effectivePrivacy, PLATINA_PRIVACY, LAST_SEEN_MODES, userForViewer, receiptsVisible, readTimeVisible, presenceView, chatSettings } from './database.js';
import { installLastSeenRoutes } from './lastseen.js';
import { isAvatarFrame, isBannerPreset, isProfileEffect, isNameplate, isProfilePattern, MAX_PROFILE_VIDEO_BYTES, videoMime } from './cosmetics.js';
import { platinaState } from './entitlements.js';
import { DEFAULT_FILE_LIMITS, installBigFileRoutes } from './bigfiles.js';
import { installPlainUploadRoutes } from './plainuploads.js';
import { installAuthRoutes, RECOVERY_LOCK_MS, rateLimitIp } from './auth.js';
import { installDeviceBinding, PROOF_HEADER, PROOF_REQUIRED, proofAccepted } from './devicebind.js';
import { installE2eeRoutes, installScheduledRoutes, parseEncryptedMessage } from './e2ee.js';
import { registerAiRoutes, aiProvider } from './ai.js';
import { installUsernameRoutes } from './username.js';
import { installSocialRoutes } from './social.js';
import { installPostRoutes, canSeePosts, postOwnerOfUpload } from './posts.js';
import { privacyHtml, supportHtml } from './legal.js';
import {
  HttpError, fail, passwordHash, tokenHash, newToken, validToken,
  objectBody, boundedText, positiveInteger, imageMime, safeFilename, safeMime, createLimiter,
  publicName,
} from './security.js';
const READ_DATE_WINDOW_MS = 7 * 24 * 3600 * 1000;

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

/** «MM-DD» or «YYYY-MM-DD» (1900…this year), a real calendar day; null clears it. */
export function birthdayValue(value, thisYear) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') fail(400, 'Некорректный день рождения.');
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(value);
  if (!m) fail(400, 'День рождения: ММ-ДД или ГГГГ-ММ-ДД.');
  const year = m[1] ? Number(m[1]) : 2000, month = Number(m[2]), day = Number(m[3]);
  if (m[1] && (year < 1900 || year > thisYear)) fail(400, 'Год рождения указан неверно.');
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail(400, 'Такого дня нет в календаре.');
  return value;
}

/** An independent, ready Fastify instance; tests may inject requests without binding a port. */
export async function buildApp({
  turn = null,
  push = null,
  soundcloud = null,
  dataDir = resolve('data'),
  logger = false,
  allowedOrigins = [],
  trustProxy = false,
  edgeSecret = '',
  sessionTtlMs = SESSION_TTL,
  authRateLimit = 20,
  maxUploadBytes = 20 * MiB,
  // Extra cap on top of the per-tier storage (tests, small servers); null = tier limits only.
  maxStoredBytesPerUser = null,
  fileLimits = DEFAULT_FILE_LIMITS,
  diskReserveBytes = 5 * 1024 * MiB,
  freeDisk,
  maxConcurrentPasswordJobs = 4,
  /** How long a voice-room member survives its socket closing before the room is told it left. */
  voiceGraceMs = 25_000,
  /** Period of the housekeeping tick (socket pings, expired rows, last seen, session touch). */
  maintenanceIntervalMs = 30_000,
  /** Cluster (src/cluster.js): false while this process is not the primary with a live lease — timed work that writes (scheduled messages) waits. */
  writable = () => true,
  /** SFU for screen sharing (src/sfu.js); undefined = from the environment, null = off. */
  sfu: sfuOption,
  authTestHooks,
  aiApiKey = '',
  aiProviderConfig = {},
  aiFetch = globalThis.fetch,
  // Client version gate (clientgate.js). null = allow every client, including header-less.
  minClientVersion = null,
  requireClientHeader = false,
  // Request signing (attest.js): key + 'off' | 'warn' | 'enforce'. No key = off.
  attestKey = '',
  attestModeSetting = 'off',
  // Path to the release manifest written by deploy/release.sh (release.js). null = no updates.
  releaseManifest = null,
  serverList = null,
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
  const attestState = attestMode(attestModeSetting, attestKey);
  // Update offer + grace period; also feeds the version gate (deadline passed = minimum).
  const release = createRelease({ manifestPath: releaseManifest, minClientVersion, now, log: error => app.log.warn({ err: error }, 'release manifest is invalid') });
  const limiter = createLimiter(now);
  const sockets = new Set();
  const PUBLIC_PATHS = new Set(['/health', '/app/update', '/servers', '/privacy', '/support']);
  const publicPath = url => { const path = url.split('?')[0]; return PUBLIC_PATHS.has(path) || path.startsWith('/i/'); };
  // Signed-in sockets by user: emitting to one user no longer walks every open socket (load test F3).
  const socketsByUser = new Map();
  const indexSocket = state => { const set = socketsByUser.get(state.auth.user_id) || new Set(); set.add(state); socketsByUser.set(state.auth.user_id, set); };
  const unindexSocket = state => { const userId = state.auth?.user_id; const set = userId && socketsByUser.get(userId); if (!set) return; set.delete(state); if (!set.size) socketsByUser.delete(userId); };
  let passwordJobs = 0;
  let databaseClosed = false;
  let expireEncryptionDevices = () => {};
  // A missing account follows the same scrypt path as a known account.
  const dummyPasswordHash = await passwordHash(randomUUID());
  const sfu = sfuOption !== undefined ? sfuOption : await createSfu({ config: sfuConfig(), log: (...a) => console.warn('[sfu]', ...a) });
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
  const publicUser = (row, extra = {}) => serializePublicUser(row,{db,now,...extra});
  const sessionForToken = token => {
    if (!validToken(token)) return null;
    return db.prepare('SELECT token_hash,id,user_id,expires_at,last_active_at,bind_key,proof_hash,proof_expires_at,proof_prev_hash,proof_prev_expires_at FROM sessions WHERE token_hash=? AND expires_at>?')
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
  // Lean clients (?lean=1, or lean in the socket auth frame) read their own Signal envelope from
  // /e2ee/inbox and show text from their local cache; lists and events then leave the full
  // ciphertext (all devices, 20 KB+ per message) out. Older clients get it as before.
  const leanMessage = message => (message && message.encrypted ? { ...message, encrypted: undefined, lean: true } : message);
  const leanPayload = payload => payload.type === 'message' ? { ...payload, message: leanMessage(payload.message) }
    : payload.type === 'chat' && payload.chat?.lastMessage ? { ...payload, chat: { ...payload.chat, lastMessage: leanMessage(payload.chat.lastMessage) } } : payload;
  // `exceptSession`: the device that made the change already has the result from its HTTP answer.
  const emitUser = (userId, payload, exceptSession = null) => {
    const own = socketsByUser.get(userId);
    if (!own) return;
    for (const state of [...own]) {
      if (exceptSession && state.auth.id === exceptSession) continue;
      if (!sessionStillValid(state)) {
        state.socket.close(4401, 'Session expired');
        continue;
      }
      sendSocket(state, state.lean ? leanPayload(payload) : payload);
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
  // Presence ("в сети" / "был(а) …"): online while any authenticated socket is open.
  const isOnline = userId => { const own = socketsByUser.get(userId); if (!own) return false; for (const state of own) if (state.socket.readyState === 1) return true; return false; };
  const peersOf = userId => db.prepare('SELECT DISTINCT b.user_id FROM chat_members a JOIN chat_members b ON a.chat_id=b.chat_id WHERE a.user_id=? AND b.user_id<>?').all(userId, userId).map(row => row.user_id);
  // «был(а) …» is written when the last socket closes, but also at sign-in, every maintenance
  // tick and at shutdown: after a crash or restart the close handlers never run, and the time
  // would otherwise be hours stale.
  // One statement for all of them: a row per online user every tick as separate autocommits took
  // seconds at a thousand users (each commit is an fsync), one write takes milliseconds.
  const recordSeen = userIds => {
    const ids = [...new Set(userIds)];
    if (ids.length) db.prepare('UPDATE users SET last_seen_at=? WHERE id IN (SELECT value FROM json_each(?))').run(timestamp(), JSON.stringify(ids));
  };
  // Exact («в сети», «был(а) в 18:36») or, when «Время захода» hides it, only Telegram's approximate
  // `approx` bucket («недавно», «на этой неделе», …) — never the time itself (database.js presenceView).
  const presenceFor = (userId, viewerId) => presenceView(db, userId, viewerId, { online: isOnline(userId), time: now() });
  // Only peers who are online get pushes; offline ones read the state when they connect (load test F4).
  // A peer for whom the presence is hidden (a block, hidden «last seen») gets nothing at all: even a
  // {hidden:true} packet at socket open and close would tell them when the person comes and goes.
  // `includeHidden` is for the moment the visibility itself changes, so the peer's cached state is replaced.
  const broadcastPresence = (userId, { includeHidden = false } = {}) => {
    for (const peerId of peersOf(userId)) {
      if (!isOnline(peerId)) continue;
      const presence = presenceFor(userId, peerId);
      if (presence.hidden && !includeHidden) continue;
      emitUser(peerId, { type: 'presence', presence });
    }
  };
  // Blocking or unblocking: both sides see the other's presence change at once ({hidden:true} in a
  // block) and their shared chats are re-sent, so a cached «в сети» or avatar does not linger.
  const blocksChanged = (a, b) => {
    if (isOnline(a)) emitUser(a, { type: 'presence', presence: presenceFor(b, a) });
    if (isOnline(b)) emitUser(b, { type: 'presence', presence: presenceFor(a, b) });
    for (const { chat_id } of db.prepare('SELECT a.chat_id FROM chat_members a JOIN chat_members b ON a.chat_id=b.chat_id WHERE a.user_id=? AND b.user_id=?').all(a, b)) emitChat(chat_id);
  };
  // A «Время захода» exception or a friendship changed between two people: if they share a chat, both
  // get the other's presence as it now looks (strangers never get presence at all).
  const presencePairChanged = (a, b) => {
    if (a === b || !db.prepare('SELECT 1 FROM chat_members x JOIN chat_members y ON x.chat_id=y.chat_id WHERE x.user_id=? AND y.user_id=? LIMIT 1').get(a, b)) return;
    if (isOnline(a)) emitUser(a, { type: 'presence', presence: presenceFor(b, a) });
    if (isOnline(b)) emitUser(b, { type: 'presence', presence: presenceFor(a, b) });
  };
  const emitChat = chatId => {
    for (const userId of memberIds(chatId)) if (isOnline(userId)) emitUser(userId, { type: 'chat', chat: publicChat(db, chatId, userId, serializationOptions) });
  };
  const requireMembership = (chatId, userId) => {
    const member = db.prepare('SELECT * FROM chat_members WHERE chat_id=? AND user_id=?').get(chatId, userId);
    if (!member) fail(404, 'Чат не найден.');
    return member;
  };
  /** The largest request body read from a caller that has not shown a valid session (sign-in, registration and
   *  recovery are far smaller). */
  const ANONYMOUS_BODY = 64 * 1024;
  const requireAuth = async request => {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header) ? header.slice(7) : null;
    const session = sessionForToken(token);
    if (!session) fail(401, 'Войдите в аккаунт заново.');
    // A session bound to a device key (devicebind.js): the token alone is not enough, the request also carries the
    // short-lived proof only that device can obtain. The routes that issue the proof are the exception.
    if (session.bind_key && !request.routeOptions?.url?.startsWith('/auth/device/') && !proofAccepted(session, request.headers[PROOF_HEADER], now())) fail(401, 'Подтвердите устройство.', PROOF_REQUIRED);
    request.auth = session;
    if (!limiter.allow(`api:${session.user_id}`, 600, 60_000)) fail(429, 'Слишком много запросов. Попробуйте через минуту.');
    touchSession(session);
  };
  // Sliding expiry: a device in use stays signed in; one idle for sessionTtlMs (SESSION_TTL_DAYS) is signed out.
  // Written at most once a minute per session (every request would otherwise be a write).
  const touchSession = session => touchSessions([session]);
  const touchSessions = sessions => {
    const due = sessions.filter(session => now() - Date.parse(session.last_active_at) >= 60_000);
    if (!due.length) return;
    const touched = timestamp(), expiry = now() + sessionTtlMs;
    const update = db.prepare('UPDATE sessions SET last_active_at=?, expires_at=? WHERE token_hash=? AND expires_at>?');
    const run = () => { for (const session of due) { update.run(touched, expiry, session.token_hash, now()); session.last_active_at = touched; } };
    if (due.length === 1) run(); else transaction(db, run);
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
    // IPv6 is counted per /64 (one subscriber's prefix), or a single host would hold 2^64 fresh keys.
    if (!limiter.allow(`auth:${rateLimitIp(request.clientIp)}`, authRateLimit, 15 * 60_000)) fail(429, 'Слишком много попыток входа. Повторите через 15 минут.');
  };
  const recoveryStatusThrottle = request => {
    if (!limiter.allow(`recovery-status:${request.clientIp}`, 120, 60_000)) fail(429, 'Слишком много запросов статуса. Повторите через минуту.');
  };
  const allowAccountLogin = username => limiter.allow(`account:${username}`, authRateLimit === false ? false : authRateLimit * 2, 15 * 60_000);
  const withPasswordJob = async work => {
    if (passwordJobs >= maxConcurrentPasswordJobs) fail(503, 'Сервер занят. Попробуйте через несколько секунд.');
    passwordJobs++;
    try { return await work(); } finally { passwordJobs--; }
  };

  // Reserve entrance through Cloudflare (deploy/edge.sh): only a request carrying the shared
  // secret may name the real client IP; anything else keeps the address the proxy saw.
  const edgeKey = typeof edgeSecret === 'string' && edgeSecret.length >= 32 ? Buffer.from(edgeSecret) : null;
  const fromEdge = request => {
    const given = request.headers['x-invizent-edge-key'];
    if (!edgeKey || typeof given !== 'string') return null;
    const bytes = Buffer.from(given);
    if (bytes.length !== edgeKey.length || !timingSafeEqual(bytes, edgeKey)) return null;
    const ip = request.headers['x-invizent-edge-ip'];
    return typeof ip === 'string' && isIP(ip) ? ip : null;
  };
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (request, reply) => {
    request.clientIp = fromEdge(request) || request.ip;
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
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        // The app announces its version and signs writes (clientgate.js, attest.js).
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Linea-Client, X-Linea-Attest, X-Linea-Proof, Range');
      }
    }
    // A large body is read only from a signed-in caller. Fastify parses JSON before any preHandler, so without this
    // an anonymous client could make the server parse 17 MB bodies (≈1 s of blocked event loop and ≈240 MB of heap
    // each) on the routes with a raised bodyLimit, never reaching the per-user limiter. Other servers of the cluster
    // sign their own way (/cluster/*).
    const declared = Number(request.headers['content-length']);
    const large = Number.isFinite(declared) ? declared > ANONYMOUS_BODY : request.headers['transfer-encoding'] !== undefined;
    if (large && !request.url.startsWith('/cluster/')) {
      const header = request.headers.authorization;
      const token = typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header) ? header.slice(7) : null;
      if (!sessionForToken(token)) { reply.header('Connection', 'close'); fail(401, 'Войдите в аккаунт заново.'); }
    }
    if (request.query && ('token' in request.query || 'access_token' in request.query)) {
      fail(400, 'Передавайте токен только в заголовке Authorization или первом сообщении WebSocket.');
    }
    // Version gate: health check, CORS preflight and pages opened in a browser (which never sends
    // X-Linea-Client: invite landing, privacy policy, support) always pass.
    if (request.method !== 'OPTIONS' && !publicPath(request.url)) {
      request.clientInfo = parseClientInfo(request.headers['x-linea-client']);
      const refusal = clientGateDecision(request.clientInfo, { minVersion: release.currentMinimum(), requireHeader: requireClientHeader });
      if (refusal) fail(426, refusal.message, { code: refusal.code });
      // Only state-changing requests are signed: logins, sends, uploads, settings. Downloads
      // (GET) and the WebSocket upgrade still require a session, which only a signed login gives.
      if (attestState !== 'off' && !['GET', 'HEAD'].includes(request.method) && !request.url.startsWith('/ws')) {
        const problem = verifyAttest(request.headers['x-linea-attest'], { key: attestKey, method: request.method, url: request.url, nowSeconds: Math.floor(now() / 1000) });
        if (problem) {
          request.log.warn({ attest: problem, client: request.clientInfo?.raw ?? null, url: request.url.split('?')[0] }, 'request signature check failed');
          if (attestState === 'enforce') fail(403, 'Запрос не от официального приложения INVIZENT. Установите приложение заново.', { code: 'ATTEST_FAILED' });
        }
      }
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
  // 128 KB: voice SDP (with ICE candidates) and SFU parameters do not fit into 4 KB.
  await app.register(websocket, { options: { maxPayload: 128 * 1024, perMessageDeflate: false } });
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fieldNameSize: 100, fileSize: maxUploadBytes, headerPairs: 100 },
  });

  app.get('/health', async () => ({ status: 'ok' }));
  // Pages the App Store links to (privacy policy, support).
  const html = (reply, body) => reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'public, max-age=600').send(body);
  app.get('/privacy', async (_request, reply) => html(reply, privacyHtml(process.env.SUPPORT_EMAIL || '', '4 ноября 2026')));
  app.get('/support', async (_request, reply) => html(reply, supportHtml(process.env.SUPPORT_EMAIL || '')));
  // The server list signed by the owner (deploy/servers.mjs). Served as is: the app checks the
  // signature itself, so a server can pass the list on but never change it.
  app.get('/servers', async (request, reply) => {
    if (!serverList) return reply.code(404).send({ error: 'Список серверов не настроен.' });
    try {
      const signed = JSON.parse(readFileSync(serverList, 'utf8'));
      if (typeof signed?.payload !== 'string' || typeof signed?.sig !== 'string') throw new Error('bad list');
      reply.header('Cache-Control', 'public, max-age=300');
      return { payload: signed.payload, sig: signed.sig };
    } catch { return reply.code(404).send({ error: 'Список серверов не настроен.' }); }
  });
  release.install(app);

  installDeviceBinding({ app, db, now, authOptions, limiter });
  installAuthRoutes({
    app, db, now, timestamp, authOptions, authThrottle, recoveryStatusThrottle,
    allowAccountLogin, withPasswordJob, newSession, dummyPasswordHash,
    closeRevokedSockets, emitUser, authTestHooks,
    deleteAccount: async userId => {
      const peers = await deleteAccount(db, uploadDir, userId);
      closeRevokedSockets();
      for (const { chatId, userId: peer } of peers) emitUser(peer, { type: 'chat.deleted', chatId });
    },
  });
  registerAiRoutes(app,{authenticate:requireAuth,apiKey:aiApiKey,provider:aiProvider(aiProviderConfig),fetchImpl:aiFetch,allowedOrigins,now,isPlatina:userId=>platinaState(db,userId,now()).active});
  installUsernameRoutes({app,db,now,authOptions,emitUser,emitChat});
  installCallRoutes({app,authOptions,now,turn});
  installSocialRoutes({app,db,authOptions,publicUser,timestamp,serializationOptions,emitUser,friendsChanged:presencePairChanged});
  installPostRoutes({ app, db, authOptions, now, timestamp, limiter, uploadDir, emitUser });
  migratePushTokens(db);
  db.exec(PUSH_SCHEMA);
  { const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name)); for (const column of ['profile_effect', 'nameplate']) if (!columns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`); }
  db.exec(MODERATION_SCHEMA);
  migrateCallPrivacy(db);
  installCallPrivacyRoutes({ app, db, authOptions, publicUser, timestamp });
  installLastSeenRoutes({ app, db, authOptions, publicUser, timestamp, changed: presencePairChanged });
  installModerationRoutes({ app, db, authOptions, publicUser, timestamp, limiter, blocksChanged });
  installSoundCloudRoutes({ app, authOptions, soundcloud, limiter });
  // Push token of this signed-in device. It lives as long as the session: a revoked or
  // expired session stops receiving pushes.
  app.put('/me/push', authOptions, async request => {
    const body = objectBody(request.body, ['token', 'platform']);
    if (typeof body.token !== 'string' || !/^[A-Za-z0-9_:\-]{20,4096}$/.test(body.token)) fail(400, 'Некорректный токен уведомлений.');
    if (body.platform !== 'android' && body.platform !== 'ios') fail(400, 'Неизвестная платформа уведомлений.');
    if (body.platform === 'ios' && !/^[0-9a-f]{64,200}$/i.test(body.token)) fail(400, 'Некорректный токен уведомлений.');
    db.prepare('INSERT INTO push_tokens(token,user_id,session_hash,platform,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,session_hash=excluded.session_hash,updated_at=excluded.updated_at')
      .run(body.token, request.auth.user_id, request.auth.token_hash, body.platform, now());
    return { ok: true, enabled: !!push && (push.platforms ? !!push.platforms[body.platform] : body.platform === 'android') };
  });
  app.delete('/me/push', authOptions, async request => {
    db.prepare('DELETE FROM push_tokens WHERE session_hash=?').run(request.auth.token_hash);
    return { ok: true };
  });
  // The number on the app icon: unread chats (not muted or archived), community counters and
  // waiting friend requests — the same total the app shows once it is open.
  const badgeTotal = userId => {
    // Each chat is capped at 9 999 like publicChat (the badge shows «9999+» anyway): a full count per
    // push grew with the receiver's unread pile in every chat.
    const chats = db.prepare(`SELECT COALESCE(SUM((SELECT COUNT(*) FROM (SELECT 1 FROM messages m WHERE m.chat_id=cm.chat_id AND m.sender_id<>cm.user_id AND m.id>cm.last_read_message_id AND m.silent=0 LIMIT 9999))),0) AS n
      FROM chat_members cm LEFT JOIN chat_settings s ON s.user_id=cm.user_id AND s.chat_id=cm.chat_id
      WHERE cm.user_id=? AND (s.muted_until IS NULL OR (s.muted_until<>0 AND s.muted_until<=?)) AND COALESCE(s.archived,0)=0`).get(userId, now()).n;
    const friends = db.prepare('SELECT COUNT(*) AS n FROM friend_requests r WHERE r.to_id=? AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=r.to_id AND b.blocked_id=r.from_id)').get(userId).n;
    let communities = 0; try { communities = communityApi.badge(userId); } catch { /* counters are best effort */ }
    return Math.min(chats + friends + communities, 99999);
  };
  const notify = (chatId, senderId, kind) => {
    if (!push || kind === 'none') return;
    const sender = db.prepare('SELECT display_name FROM users WHERE id=?').get(senderId);
    for (const userId of memberIds(chatId)) {
      if (userId === senderId) continue;
      // A timed mute (F2) ends by comparison with the clock: no sweep, the next message simply rings again.
      if (kind !== 'call' && chatSettings(db, userId, chatId, now()).muted) continue;
      const tokens = db.prepare('SELECT p.token, p.platform FROM push_tokens p JOIN sessions s ON s.token_hash=p.session_hash WHERE p.user_id=? AND s.expires_at>?').all(userId, now());
      if (!tokens.length) continue;
      const member = db.prepare('SELECT last_read_message_id FROM chat_members WHERE chat_id=? AND user_id=?').get(chatId, userId);
      const unread = db.prepare('SELECT COUNT(*) AS count FROM (SELECT 1 FROM messages WHERE chat_id=? AND sender_id<>? AND id>? AND silent=0 LIMIT 9999)').get(chatId, userId, member?.last_read_message_id ?? 0).count;
      const message = chatNotification({ chatId, senderName: sender?.display_name || 'Инвиз', kind, unread, badge: kind === 'call' ? undefined : badgeTotal(userId) });
      for (const { token, platform } of tokens) {
        push(token, message, platform).then(result => { if (result === 'gone' && !databaseClosed) db.prepare('DELETE FROM push_tokens WHERE token=?').run(token); })
          .catch(error => app.log.warn({ err: error.message }, 'push failed'));
      }
    }
  };
  db.exec(COMMUNITY_SCHEMA);
  if (!db.prepare('PRAGMA table_info(communities)').all().some(column => column.name === 'category')) db.exec('ALTER TABLE communities ADD COLUMN category TEXT');
  if (!db.prepare('PRAGMA table_info(communities)').all().some(column => column.name === 'closed')) db.exec('ALTER TABLE communities ADD COLUMN closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1))');
  if (!db.prepare('PRAGMA table_info(uploads)').all().some(column => column.name === 'purpose')) db.exec("ALTER TABLE uploads ADD COLUMN purpose TEXT NOT NULL DEFAULT 'profile'");
  // Voice channels: who is connected where (in memory). Audio flows peer to peer (WebRTC,
  // DTLS-SRTP, through TURN when needed); the server only relays signalling between members.
  const voiceRooms = new Map(); // channelId -> Map(socketId -> { state, userId, muted })
  const voiceMembers = channelId => [...(voiceRooms.get(channelId)?.values() || [])].map(item => ({ userId: item.userId, muted: item.muted, ...(communityApi?.serverVoice(item.state.voice?.communityId, item.userId) || {}) }));
  // Who is in a voice channel goes only to members who can see that channel (a role-gated room is
  // not listed to the rest). A community or channel that is already gone has nobody left to tell.
  const emitVoiceState = (communityId, channelId) => {
    const row = db.prepare('SELECT * FROM communities WHERE id=?').get(communityId);
    const item = row && db.prepare('SELECT * FROM community_channels WHERE id=? AND community_id=?').get(channelId, row.id);
    if (!item) return;
    communityApi?.emitCommunity(row, { type: 'voice.state', communityId, channelId, members: voiceMembers(channelId) }, item);
  };
  const leaveVoice = state => {
    clearTimeout(state.voiceGrace); state.voiceGrace = undefined;
    const channelId = state.voice?.channelId; if (!channelId) return;
    const room = voiceRooms.get(channelId); const communityId = state.voice.communityId; state.voice = null;
    sfu?.leave(channelId, state.id);
    if (room) { room.delete(state.id); if (!room.size) voiceRooms.delete(channelId); }
    for (const item of room?.values() || []) sendSocket(item.state, { type: 'voice.left', channelId, peer: state.id });
    emitVoiceState(communityId, channelId);
  };
  // The socket dropped (a tunnel, a network change, the app sent to the background for a moment):
  // the member stays in the room for a grace period instead of leaving at once, so the peers keep
  // their RTC connection to it. A `voice.join` by the same user within the period takes the place
  // of the ghost; otherwise it leaves when the period ends.
  const graceVoice = state => {
    if (!state.voice || state.voiceGrace) return;
    // An exception here would be uncaught (a timer has no request to answer) and would take the process down.
    state.voiceGrace = setTimeout(() => {
      state.voiceGrace = undefined;
      if (databaseClosed) return;
      try { leaveVoice(state); } catch (error) { app.log.error({ err: error }, 'voice grace: leave failed'); }
    }, voiceGraceMs);
    state.voiceGrace.unref?.();
  };
  // Every seat this user holds in the community's voice rooms, sockets in their grace period included
  // (those are no longer in `sockets`, yet still listed to everyone until the period ends).
  const seatsOf = (userId, communityId) => {
    const seats = [];
    for (const room of voiceRooms.values()) for (const item of room.values()) if (item.userId === userId && (communityId === undefined || item.state.voice?.communityId === communityId)) seats.push(item.state);
    return seats;
  };
  const dropGhosts = userId => { for (const ghost of seatsOf(userId)) if (ghost.voiceGrace) leaveVoice(ghost); };
  const voice = {
    members: voiceMembers,
    kick: (userId, communityId) => { for (const state of seatsOf(userId, communityId)) { sendSocket(state, { type: 'voice.kicked', channelId: state.voice.channelId }); leaveVoice(state); } },
    // A moderator changed someone's server mute/deafen: everyone in that person's voice room gets the new state.
    moderated: (userId, communityId) => { for (const channelId of new Set(seatsOf(userId, communityId).map(state => state.voice.channelId))) emitVoiceState(communityId, channelId); },
    close: channelId => { for (const item of [...(voiceRooms.get(channelId)?.values() || [])]) { sendSocket(item.state, { type: 'voice.kicked', channelId }); leaveVoice(item.state); } },
  };
  const communityApi = installCommunityRoutes({ app, db, authOptions, publicUser, timestamp, now, emitUser, limiter, voice, isOnline: userId => isOnline(userId) });
  // Storage per account depends on Platina (20 GB without, 40 GB with); big files reserve their size while uploading.
  const isPlatinaActive = userId => platinaState(db, userId, now()).active;
  const tierTotal = userId => (isPlatinaActive(userId) ? fileLimits.platina.total : fileLimits.free.total);
  const storageLimit = userId => Math.min(tierTotal(userId), maxStoredBytesPerUser ?? Infinity);
  const e2ee = installE2eeRoutes({
    app, db, now, timestamp, authOptions, emitUser, limiter, uploadDir,
    maxUploadBytes, storageLimit, closeRevokedSockets, usage: userId => bigFiles.usage(userId),
  });
  let plainUploads = null;
  const bigFiles = installBigFileRoutes({ app, db, uploadDir, authOptions, limiter, isPlatina: isPlatinaActive, now, timestamp, assertSession: e2ee.assertSession, writable,
    limits: { free: { ...fileLimits.free, total: Math.min(fileLimits.free.total, maxStoredBytesPerUser ?? Infinity) }, platina: { ...fileLimits.platina, total: Math.min(fileLimits.platina.total, maxStoredBytesPerUser ?? Infinity) } },
    extraReserved: userId => plainUploads?.reserved(userId) ?? 0,
    diskReserveBytes, ...(freeDisk ? { freeDisk } : {}) });
  // Big channel files, posts and stories: chunked and resumable, counted in the same storage (plainuploads.js).
  plainUploads = installPlainUploadRoutes({ app, db, uploadDir, authOptions, limiter, bigFiles, now, timestamp, sessionStillValid, writable,
    diskReserveBytes, ...(freeDisk ? { freeDisk } : {}) });
  expireEncryptionDevices = e2ee.expireDevices;
  expireEncryptionDevices();

  app.get('/me', authOptions, async request => {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(request.auth.user_id);
    return { user: publicUser(user, { own: true }), securitySetupRequired: !user.confirmation_hash || !user.recovery_hash };
  });

  app.patch('/me', authOptions, async request => {
    const body = objectBody(request.body, ['displayName', 'bio', 'birthday', 'gender', 'avatarColor', 'avatarId', 'avatarVideoId', 'avatarFrame', 'bannerId', 'bannerPreset', 'profileEffect', 'nameplate', 'profilePattern']);
    const current = db.prepare('SELECT * FROM users WHERE id=?').get(request.auth.user_id);
    const displayName = body.displayName === undefined ? current.display_name : publicName(body.displayName, 'Имя', 1, 50);
    const bio = body.bio === undefined ? current.bio : boundedText(body.bio, 'О себе', 0, 160);
    const birthday = body.birthday === undefined ? current.birthday ?? null : birthdayValue(body.birthday, new Date(now()).getUTCFullYear());
    const gender = body.gender === undefined ? current.gender ?? null : body.gender;
    if (gender !== null && gender !== 'male' && gender !== 'female') fail(400, 'Пол: male, female или не указан.');
    const avatarColor = body.avatarColor === undefined ? current.avatar_color : body.avatarColor;
    if (typeof avatarColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(avatarColor)) fail(400, 'Цвет должен быть в формате #RRGGBB.');
    const avatarId = body.avatarId === undefined ? current.avatar_id : body.avatarId;
    if (avatarId !== null) {
      if (typeof avatarId !== 'string') fail(400, 'Некорректное фото профиля.');
      const upload = db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=?').get(avatarId, current.id);
      if (!upload) fail(404, 'Фото профиля не найдено.');
      if (!upload.is_image || upload.size > MAX_AVATAR_BYTES) fail(400, 'Фото профиля должно быть изображением PNG, JPEG, GIF или WebP до 4 МиБ.');
    }
    // Platina decoration. Clearing (null) is always allowed; setting needs an active Platina.
    const platinaActive = platinaState(db, current.id, now()).active;
    const needPlatina = key => { if (body[key] !== undefined && body[key] !== null && !platinaActive) fail(403, 'Это оформление доступно с Platina.', { code: 'PLATINA_REQUIRED' }); };
    for (const key of ['avatarVideoId', 'avatarFrame', 'bannerId', 'bannerPreset', 'profileEffect', 'nameplate']) needPlatina(key);
    const ownUpload = (id, label) => {
      if (typeof id !== 'string') fail(400, `Некорректное ${label}.`);
      const upload = db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=? AND is_encrypted=0 AND attached_message_id IS NULL').get(id, current.id);
      if (!upload) fail(404, `${label[0].toUpperCase()}${label.slice(1)} не найдено.`);
      return upload;
    };
    let avatarVideoId = current.avatar_video_id;
    if (body.avatarVideoId !== undefined) {
      avatarVideoId = body.avatarVideoId;
      // The animated avatar stays a short video up to 8 MiB, even when the file was a bigger post.
      if (avatarVideoId !== null && (u => !u.is_video || u.size > MAX_PROFILE_VIDEO_BYTES)(ownUpload(avatarVideoId, 'видео профиля'))) fail(400, 'Анимированный аватар должен быть видео MP4 или MOV до 8 МиБ.');
    }
    const avatarFrame = body.avatarFrame === undefined ? current.avatar_frame : body.avatarFrame;
    if (avatarFrame !== null && avatarFrame !== undefined && !isAvatarFrame(avatarFrame)) fail(400, 'Неизвестная рамка.');
    const bannerPreset = body.bannerPreset === undefined ? current.banner_preset : body.bannerPreset;
    if (bannerPreset !== null && bannerPreset !== undefined && !isBannerPreset(bannerPreset)) fail(400, 'Неизвестный баннер.');
    const profileEffect = body.profileEffect === undefined ? current.profile_effect : body.profileEffect;
    if (profileEffect !== null && profileEffect !== undefined && !isProfileEffect(profileEffect)) fail(400, 'Неизвестный эффект профиля.');
    const nameplate = body.nameplate === undefined ? current.nameplate : body.nameplate;
    if (nameplate !== null && nameplate !== undefined && !isNameplate(nameplate)) fail(400, 'Неизвестная табличка.');
    let bannerId = current.banner_id; let bannerKind = current.banner_kind;
    if (body.bannerId !== undefined) {
      bannerId = body.bannerId; bannerKind = null;
      if (bannerId !== null) {
        const upload = ownUpload(bannerId, 'изображение баннера');
        if (upload.is_video) { if (upload.size > MAX_PROFILE_VIDEO_BYTES) fail(400, 'Видео для баннера — до 8 МиБ.'); bannerKind = 'video'; }
        else if (upload.is_image) { if (upload.size > MAX_AVATAR_BYTES) fail(400, 'Фото для баннера — до 4 МиБ.'); bannerKind = 'image'; }
        else fail(400, 'Баннер должен быть фото или видео.');
      }
    }
    const profilePattern = body.profilePattern === undefined ? current.profile_pattern ?? null : body.profilePattern;
    if (profilePattern !== null && !isProfilePattern(profilePattern)) fail(400, 'Неизвестный узор.');
    db.prepare('UPDATE users SET display_name=?,bio=?,birthday=?,gender=?,avatar_color=?,avatar_id=?,avatar_video_id=?,avatar_frame=?,banner_id=?,banner_kind=?,banner_preset=?,profile_effect=?,nameplate=?,profile_pattern=? WHERE id=?')
      .run(displayName, bio, birthday, gender, avatarColor.toUpperCase(), avatarId, avatarVideoId ?? null, avatarFrame ?? null, bannerId ?? null, bannerKind ?? null, bannerPreset ?? null, profileEffect ?? null, nameplate ?? null, profilePattern, current.id);
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(current.id), { own: true });
    emitUser(current.id, { type: 'profile', user });
    const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(current.id);
    // Peers see the new profile; the editor's own chat cards do not change (they show the peer), so they
    // are not rebuilt — that cost ~1 s for an account with 2 000 chats (load test F4).
    for (const { chat_id } of chats) {
      for (const peerId of memberIds(chat_id)) {
        if (peerId === current.id || !isOnline(peerId)) continue;
        emitUser(peerId, { type: 'profile', user: userForViewer(db, user, peerId) });
        emitUser(peerId, { type: 'chat', chat: publicChat(db, chat_id, peerId, serializationOptions) });
      }
    }
    return { user };
  });

  const privacyResponse = userId => ({ privacy: effectivePrivacy(db, userId, now()), platinaOnly: PLATINA_PRIVACY, platina: platinaState(db, userId, now()).active });
  app.get('/me/privacy', authOptions, async request => privacyResponse(request.auth.user_id));

  app.patch('/me/privacy', authOptions, async request => {
    const body = objectBody(request.body, ['allowNewChats', 'showAvatar', 'readReceipts', 'showLastSeen', 'lastSeen', 'hideReadTime', 'calls']);
    const userId = request.auth.user_id;
    const next = { ...privacyOf(db, userId) };
    const platinaActive = platinaState(db, userId, now()).active;
    for (const key of ['allowNewChats', 'showAvatar', 'readReceipts', 'showLastSeen', 'hideReadTime']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') fail(400, 'Настройка конфиденциальности должна быть включена или выключена.');
      if (body[key] === false && PLATINA_PRIVACY.includes(key) && !platinaActive) fail(403, 'Скрывать это можно с Platina.', { code: 'PLATINA_REQUIRED' });
      next[key] = body[key];
    }
    // «Время захода» is free, as in Telegram. Older apps send the on/off switch: off is «Никто», on
    // turns «Никто» back into «Все» and leaves «Мои контакты» as it is.
    if (body.lastSeen !== undefined) { if (!LAST_SEEN_MODES.includes(body.lastSeen)) fail(400, 'Неизвестная настройка времени захода.'); next.lastSeen = body.lastSeen; }
    else if (body.showLastSeen !== undefined) next.lastSeen = body.showLastSeen ? (next.lastSeen === 'nobody' ? 'everyone' : next.lastSeen) : 'nobody';
    if (body.calls !== undefined) { if (!CALL_MODES.includes(body.calls)) fail(400, 'Неизвестная настройка звонков.'); next.calls = body.calls; }
    db.prepare(`INSERT INTO user_privacy(user_id,allow_new_chats,show_avatar,read_receipts,show_last_seen,last_seen,hide_read_time,calls,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET allow_new_chats=excluded.allow_new_chats,show_avatar=excluded.show_avatar,read_receipts=excluded.read_receipts,show_last_seen=excluded.show_last_seen,last_seen=excluded.last_seen,hide_read_time=excluded.hide_read_time,calls=excluded.calls,updated_at=excluded.updated_at`)
      .run(userId, next.allowNewChats ? 1 : 0, next.showAvatar ? 1 : 0, next.readReceipts ? 1 : 0, next.lastSeen === 'nobody' ? 0 : 1, next.lastSeen, next.hideReadTime ? 1 : 0, next.calls, timestamp());
    // Peers learn the new visibility even when it is now hidden; «last seen» is reciprocal, so this
    // account's own view of its peers changes too.
    broadcastPresence(userId, { includeHidden: true });
    if (isOnline(userId)) emitUser(userId, { type: 'presence.snapshot', items: peersOf(userId).map(peerId => presenceFor(peerId, userId)) });
    // Peers get a fresh view of the avatar and of read receipts.
    for (const { chat_id } of db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(userId)) emitChat(chat_id);
    return privacyResponse(userId);
  });

  // Global search works like Telegram's: other users are not listed from one or two letters. A login
  // matches exactly; its beginning only from SEARCH_PREFIX_MIN characters; a display name only in full.
  // (People you already chat with are filtered on the device.)
  const SEARCH_PREFIX_MIN = 4;
  app.get('/users', authOptions, async request => {
    const query = boundedText(request.query.q, 'Поиск', 2, 100);
    const usernameOnly=query.startsWith('@');
    const needle=(usernameOnly?query.slice(1):query).toLowerCase();
    // SQLite's built-in LOWER is ASCII-only; the registered function also handles Cyrillic names.
    const prefix = needle.length >= SEARCH_PREFIX_MIN ? `${needle.replace(/[\\%_]/g, '\\$&')}%` : null;
    const users = db.prepare("SELECT * FROM users WHERE id != ? AND (username = ? OR (? IS NOT NULL AND username LIKE ? ESCAPE '\\') OR (?=0 AND unicode_lower(display_name) = ?)) ORDER BY (username = ?) DESC, length(username), username LIMIT 20")
      .all(request.auth.user_id, needle, prefix, prefix, usernameOnly?1:0, needle, needle).map(row => userForViewer(db, publicUser(row), request.auth.user_id));
    return { users };
  });

  app.get('/chats', authOptions, async request => {
    const rows = db.prepare('SELECT c.id FROM chats c JOIN chat_members m ON c.id=m.chat_id WHERE m.user_id=? ORDER BY c.updated_at DESC,c.id DESC').all(request.auth.user_id);
    const chats = rows.map(row => publicChat(db, row.id, request.auth.user_id, serializationOptions));
    return { chats: request.query?.lean === '1' ? chats.map(chat => ({ ...chat, lastMessage: leanMessage(chat.lastMessage) })) : chats };
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
    if (blockedBetween(db, selfId, peerId)) fail(403, 'Переписка с этим пользователем недоступна.', { code: 'BLOCKED' });
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
    const messages = rows.slice(0, limit).reverse().map(row => publicMessage(db, row, serializationOptions));
    return { messages: request.query.lean === '1' ? messages.map(leanMessage) : messages, hasMore: rows.length > limit };
  });

  // ?lean=1: the sender already has its ciphertext (often 20 KB+ with several devices), so the
  // answer leaves it out — on EDGE that is seconds saved per message.
  const lean = (request, message) => (request.query?.lean === '1' ? { ...message, encrypted: undefined } : message);
  app.post('/chats/:chatId/messages', { ...authOptions, bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const chatId = request.params.chatId;
    const senderId = request.auth.user_id;
    requireMembership(chatId, senderId);
    const peerMember = db.prepare('SELECT user_id FROM chat_members WHERE chat_id=? AND user_id<>?').get(chatId, senderId);
    if (peerMember && blockedBetween(db, senderId, peerMember.user_id)) fail(403, 'Переписка с этим пользователем недоступна.', { code: 'BLOCKED' });
    const body = objectBody(request.body, ['text', 'attachmentId', 'clientId', 'encrypted', 'push', 'deliverAt']);
    if (body.push !== undefined && !PUSH_KINDS.has(body.push)) fail(400, 'Некорректный вид уведомления.');
    if (body.push === 'call' && peerMember && !canCall(db, senderId, peerMember.user_id)) fail(403, 'Этот человек ограничил, кто может ему звонить.', { code: 'CALLS_RESTRICTED' });
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
      return reply.code(200).send({ message: lean(request, publicMessage(db, previous, serializationOptions)) });
    }
    if (!limiter.allow(`send:${senderId}`, 120, 60_000)) fail(429, 'Слишком много сообщений. Подождите минуту.');
    // F4 «Отправить позже»: the same envelopes, kept by the server until deliverAt (e2ee.js, scheduled_messages).
    // push:'silent' (F4 «Отправить без звука») is an ordinary message for the unread counts — silent=0 below —
    // only its push arrives without sound; silent=1 stays for reactions and edits (push:'none').
    if (body.deliverAt !== undefined) {
      return reply.code(202).send({ scheduled: scheduled.create(request, chatId, { clientId, encrypted, encryptedJson, push: body.push || 'message', deliverAt: body.deliverAt }) });
    }
    const date = timestamp();
    const id = transaction(db, () => {
      e2ee.validateMessage(request, chatId, encrypted);
      // push:'none' — a reaction, an edit, a vote: the server cannot see inside, but the sender says it is
      // not news, so the row stays out of the unread counts (publicChat, pushes, the icon badge).
      const result = db.prepare('INSERT INTO messages(chat_id,sender_id,client_id,text,attachment_id,encrypted_json,silent,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(chatId, senderId, clientId, '', null, encryptedJson, body.push === 'none' ? 1 : 0, date);
      const messageId = Number(result.lastInsertRowid);
      e2ee.linkAttachments(messageId, encrypted.attachmentIds);
      db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(date, chatId);
      return messageId;
    });
    const message = publicMessage(db, db.prepare('SELECT * FROM messages WHERE id=?').get(id), serializationOptions);
    // The sending device gets its message from the HTTP answer; echoing 20 KB+ of its own
    // ciphertext over the socket would double the traffic on EDGE (lean clients only).
    for (const userId of memberIds(chatId)) emitUser(userId, { type: 'message', chatId, message }, request.query?.lean === '1' ? request.auth.id : null);
    emitChat(chatId);
    notify(chatId, senderId, body.push || 'message');
    return reply.code(201).send({ message: lean(request, message) });
  });
  // F4: scheduled envelopes are released by a timer for the next due item, by the housekeeping tick and
  // on demand (startup, GET /scheduled); the release goes through the same emit/notify path as a send.
  const scheduled = installScheduledRoutes({ app, db, now, timestamp, authOptions, emitUser, emitChat, memberIds, blockedBetween, e2ee, serializationOptions, uploadDir, writable,
    notify: (chatId, senderId, kind) => notify(chatId, senderId, kind), log: (error, note) => app.log.warn({ err: error?.message }, note) });

  // «Прочитано сегодня в 18:36» for the sender's own message, like Telegram: only within 7 days,
  // and only when both sides share read receipts and «Скрывать время прочтения» allows it (otherwise
  // `hidden`, the time is not revealed).
  // «Удалить у меня и у собеседника»: the whole private chat, its messages and files, for both.
  app.delete('/chats/:chatId', authOptions, async request => {
    const chatId = request.params.chatId;
    requireMembership(chatId, request.auth.user_id);
    const members = await deleteChatForEveryone(db, uploadDir, chatId);
    for (const userId of members) emitUser(userId, { type: 'chat.deleted', chatId });
    return { ok: true };
  });

  app.get('/chats/:chatId/messages/:messageId/read-date', authOptions, async request => {
    const chatId = request.params.chatId;
    const userId = request.auth.user_id;
    requireMembership(chatId, userId);
    const messageId = positiveInteger(Number(request.params.messageId), 'Номер сообщения');
    const message = db.prepare('SELECT sender_id, created_at FROM messages WHERE id=? AND chat_id=?').get(messageId, chatId);
    if (!message) fail(404, 'Сообщение не найдено в этом чате.');
    if (message.sender_id !== userId) fail(403, 'Время прочтения есть только у своих сообщений.');
    if (now() - Date.parse(message.created_at) > READ_DATE_WINDOW_MS) return { readAt: null, reason: 'old' };
    const peer = db.prepare('SELECT user_id, last_read_message_id FROM chat_members WHERE chat_id=? AND user_id<>?').get(chatId, userId);
    if (!peer || peer.last_read_message_id < messageId) return { readAt: null, reason: 'unread' };
    if (!readTimeVisible(db, peer.user_id, userId, now())) return { readAt: null, reason: 'hidden' };
    const mark = db.prepare('SELECT MIN(read_at) AS at FROM read_marks WHERE chat_id=? AND user_id=? AND message_id>=?').get(chatId, peer.user_id, messageId);
    return mark?.at ? { readAt: new Date(mark.at).toISOString() } : { readAt: null, reason: 'unknown' };
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
      db.prepare('INSERT OR IGNORE INTO read_marks(chat_id,user_id,message_id,read_at) VALUES(?,?,?,?)').run(chatId, userId, lastReadMessageId, now());
      db.prepare('DELETE FROM read_marks WHERE read_at<?').run(now() - READ_DATE_WINDOW_MS);
      for (const targetId of memberIds(chatId)) {
        if (targetId !== userId && !receiptsVisible(db, userId, targetId, now())) continue;
        emitUser(targetId, { type: 'read', chatId, userId, messageId: lastReadMessageId });
      }
      emitChat(chatId);
    }
    return { ok: true, lastReadMessageId };
  });

  app.post('/uploads', authOptions, async (request, reply) => {
    const ownerId = request.auth.user_id;
    const channelUpload = request.query?.purpose === 'channel';
    // A profile post or story (posts.js): a photo or an MP4/MOV up to the upload limit. Bigger ones go in chunks
    // (POST /uploads/sessions); the avatar and the banner keep their own small limits.
    const postUpload = request.query?.purpose === 'post' || request.query?.purpose === 'story';
    if (!request.isMultipart()) fail(400, 'Отправьте файл как multipart/form-data.');
    if (!limiter.allow(`upload:${ownerId}`, 20, 60_000)) fail(429, 'Слишком много загрузок. Попробуйте через минуту.');
    // Stored files plus the unfinished chunked uploads that already reserved their size.
    const used = bigFiles.usage(ownerId);
    if (used >= storageLimit(ownerId)) fail(413, 'Достигнут лимит хранения файлов для аккаунта.');
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
            if (size > maxUploadBytes || used + size > storageLimit(ownerId)) {
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
        const video = mime ? null : videoMime(header);
        if (channelUpload) {
          // Channel files are not end-to-end encrypted (owner decision); any type up to the upload limit.
          attachment = { id, name: safeFilename(part.filename), mime_type: mime || video || safeMime(part.mimetype), size, is_image: mime ? 1 : 0, is_video: video ? 1 : 0 };
          continue;
        }
        if (postUpload) {
          if (!mime && !video) fail(400, 'Публикация — фото или видео MP4/MOV.');
          attachment = { id, name: safeFilename(part.filename), mime_type: mime || video, size, is_image: mime ? 1 : 0, is_video: video ? 1 : 0 };
          continue;
        }
        if (video) {
          if (size > MAX_PROFILE_VIDEO_BYTES) fail(400, 'Видео для профиля — до 8 МиБ.');
        } else if (!mime || size > MAX_AVATAR_BYTES) fail(400, 'Для профиля допустимо изображение PNG, JPEG, GIF или WebP до 4 МиБ или видео MP4/MOV до 8 МиБ. Отправка файлов в чат требует шифрования.');
        attachment = { id, name: safeFilename(part.filename), mime_type: mime || video, size, is_image: mime ? 1 : 0, is_video: video ? 1 : 0 };
      }
      if (!attachment) fail(400, 'Выберите файл для загрузки.');
      if (!sessionStillValid({ auth: request.auth })) fail(401, 'Войдите в аккаунт заново.');
      // Recheck after async streaming: parallel uploads must not bypass the account quota.
      const finalUsed = bigFiles.usage(ownerId);
      if (finalUsed + attachment.size > storageLimit(ownerId)) fail(413, 'Достигнут лимит хранения файлов для аккаунта.');
      db.prepare('INSERT INTO uploads(id,owner_id,name,mime_type,size,is_image,is_video,purpose,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(attachment.id, ownerId, attachment.name, attachment.mime_type, attachment.size, attachment.is_image, attachment.is_video, channelUpload ? 'channel' : postUpload ? 'post' : 'profile', timestamp());
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
    // Published profile media: the photo, and — while Platina is active — the animated avatar and banner.
    const profileMediaOwner = () => {
      if (upload.is_encrypted) return null;
      if (upload.purpose === 'channel') {
        // A channel file: visible to members who can see the channel it was posted in.
        const posted = db.prepare('SELECT c.*, m.channel_id FROM community_messages m JOIN community_channels ch ON ch.id=m.channel_id JOIN communities c ON c.id=ch.community_id WHERE m.attachment_id=?').get(upload.id);
        if (!posted) return null;
        const item = db.prepare('SELECT * FROM community_channels WHERE id=?').get(posted.channel_id);
        return communityApi.canSee(posted, item, userId) ? { id: userId } : null;
      }
      if (upload.is_image && db.prepare('SELECT 1 FROM communities WHERE avatar_id=?').get(upload.id)) return { id: userId };
      const photo = upload.is_image ? db.prepare('SELECT id FROM users WHERE avatar_id=?').get(upload.id) : null;
      if (photo) return photo;
      if (!upload.is_image && !upload.is_video) return null;
      const decorated = db.prepare('SELECT id FROM users WHERE avatar_video_id=? OR banner_id=?').get(upload.id, upload.id);
      return decorated && platinaState(db, decorated.id, now()).active ? decorated : null;
    };
    const avatarOwner = profileMediaOwner();
    const publicAvatar = Boolean(avatarOwner) && (avatarOwner.id === userId || privacyOf(db, avatarOwner.id).showAvatar);
    if (!upload.is_encrypted && upload.attached_message_id && !publicAvatar) fail(404, 'Файл не найден.');
    let permitted = upload.owner_id === userId || publicAvatar;
    // A profile post or a live story: its owner's friends may open it.
    if (!permitted && !upload.is_encrypted && !upload.attached_message_id) { const owner = postOwnerOfUpload(db, upload.id, now()); permitted = Boolean(owner) && canSeePosts(db, owner, userId); }
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
    reply.header('Content-Disposition', `${!upload.is_encrypted && (upload.is_image || upload.is_video) ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
    reply.type(upload.is_encrypted ? 'application/octet-stream' : upload.mime_type);
    reply.header('Accept-Ranges', 'bytes');
    // Byte ranges: big encrypted files are downloaded chunk by chunk and resumed after a drop.
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range || ''));
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), upload.size - 1) : upload.size - 1;
      if (!Number.isSafeInteger(start) || start > end || start >= upload.size) { reply.header('Content-Range', `bytes */${upload.size}`); return reply.code(416).type('application/json; charset=utf-8').send({ error: 'Неверный диапазон.' }); }
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${upload.size}`).header('Content-Length', end - start + 1);
      return reply.send(createReadStream(filePath, { start, end }));
    }
    reply.header('Content-Length', upload.size);
    return reply.send(createReadStream(filePath));
  });

  app.get('/ws', {
    websocket: true,
    preValidation: async request => {
      if (!limiter.allow(`ws-connect:${request.clientIp}`, 60, 60_000)) fail(429, 'Слишком много подключений.');
      let sameIp = 0, pending = 0;
      for (const state of sockets) { if (state.ip === request.clientIp) sameIp++; if (!state.auth) pending++; }
      // Sockets that have not signed in yet have their own small budget, so unauthenticated
      // connections cannot fill the whole table and lock real users out (load test F8).
      if (sameIp >= 100 || pending >= 200 || sockets.size >= 3000) fail(503, 'Достигнут лимит подключений.');
    },
  }, (socket, request) => {
    const state = { socket, ip: request.clientIp, auth: null, id: randomUUID(), alive: true };
    sockets.add(state);
    // 20 s: on EDGE (≈0.5 s round trips behind queued traffic) the auth frame can take a while.
    // 4408 = «too slow», not «signed out» (4401), so the app just reconnects.
    const authDeadline = setTimeout(() => {
      if (!state.auth) socket.close(4408, 'Authentication timeout');
    }, 20000);
    authDeadline.unref();
    socket.on('error', () => {});
    socket.on('pong', () => { state.alive = true; });
    socket.on('close', () => {
      clearTimeout(authDeadline);
      if (state.voice && !databaseClosed) graceVoice(state);
      sockets.delete(state);
      unindexSocket(state);
      const userId = state.auth?.user_id;
      if (userId && !databaseClosed && !isOnline(userId)) {
        recordSeen([userId]);
        broadcastPresence(userId);
      }
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
          // Bound to a device key: the frame carries the proof as well (4402: fetch a new proof and reconnect).
          if (session.bind_key && !proofAccepted(session, data.proof, now())) { socket.close(4402, 'Device proof required'); return; }
          const sameUser = socketsByUser.get(session.user_id)?.size || 0;
          if (sameUser >= 10) { socket.close(4429, 'Connection limit'); return; }
          const wasOnline = isOnline(session.user_id);
          state.auth = session;
          touchSession(session);
          indexSocket(state);
          recordSeen([session.user_id]);
          state.lean = data.lean === true;
          clearTimeout(authDeadline);
          sendSocket(state, { type: 'ready', userId: session.user_id });
          sendSocket(state, { type: 'presence.snapshot', items: peersOf(session.user_id).map(peerId => presenceFor(peerId, session.user_id)) });
          if (!wasOnline) broadcastPresence(session.user_id);
          return;
        }
        if (!sessionStillValid(state)) { socket.close(4401, 'Session expired'); return; }
        if (data.type === 'ping') { sendSocket(state, { type: 'pong' }); return; }
        if (data.type === 'typing') {
          if (typeof data.chatId !== 'string' || typeof data.isTyping !== 'boolean') fail(400, 'Некорректное событие набора текста.');
          requireMembership(data.chatId, state.auth.user_id);
          if (!limiter.allow(`typing:${state.auth.user_id}`, 30, 10_000)) fail(429, 'Слишком много событий набора текста.');
          // Blocked either way: no activity leaks in either direction (messages are refused too).
          for (const userId of memberIds(data.chatId)) if (userId !== state.auth.user_id && !blockedBetween(db, state.auth.user_id, userId)) {
            emitUser(userId, { type: 'typing', chatId: data.chatId, userId: state.auth.user_id, isTyping: data.isTyping });
          }
          return;
        }
        if (data.type === 'voice.join') {
          const allowed = typeof data.communityId === 'string' && typeof data.channelId === 'string' ? communityApi.voiceAllowed(data.communityId, data.channelId, state.auth.user_id) : null;
          if (!allowed) fail(403, 'Нет доступа к голосовому каналу.');
          if (state.voice) leaveVoice(state);
          const room = voiceRooms.get(data.channelId) || new Map();
          // This user's own dropped sockets still in their grace period are not peers and take no seat; they leave once the new socket is seated, so the member list never loses the person.
          const ghost = item => item.userId === state.auth.user_id && item.state.voiceGrace;
          const live = [...room.values()].filter(item => !ghost(item));
          if (live.length >= VOICE_LIMIT) fail(403, `В голосовом канале максимум ${VOICE_LIMIT} человек.`);
          // `device`: the member's encryption device. The others seal their connection checks for it
          // (Signal, end to end) — a wrong value here only makes the check fail, it cannot fake it.
          const device = typeof data.device === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.device) ? data.device : null;
          const peers = live.map(item => ({ peer: item.state.id, userId: item.userId, muted: item.muted, device: item.device }));
          room.set(state.id, { state, userId: state.auth.user_id, muted: data.muted === true, device }); voiceRooms.set(data.channelId, room);
          state.voice = { channelId: data.channelId, communityId: data.communityId };
          dropGhosts(state.auth.user_id);
          sendSocket(state, { type: 'voice.joined', channelId: data.channelId, self: state.id, peers, sfu: !!sfu });
          communityApi.emitCommunity(allowed.row, { type: 'voice.state', communityId: data.communityId, channelId: data.channelId, members: voiceMembers(data.channelId) }, allowed.item);
          return;
        }
        if (data.type === 'voice.leave') { leaveVoice(state); return; }
        if (data.type === 'sfu') {
          // Screen sharing through the SFU: only members of the voice channel, with a rate limit.
          if (!sfu || !state.voice) fail(403, 'Демонстрация через сервер недоступна.');
          if (!limiter.allow(`sfu:${state.auth.user_id}`, 120, 10_000)) fail(429, 'Слишком много запросов.');
          const channelId = state.voice.channelId, id = data.id;
          const notify = (socketId, payload) => { const target = voiceRooms.get(channelId)?.get(socketId); if (target) sendSocket(target.state, payload); };
          void sfu.handle({ channelId, socketId: state.id, data, notify })
            .then(result => sendSocket(state, { type: 'sfu.reply', id, ok: true, data: result }))
            .catch(error => sendSocket(state, { type: 'sfu.reply', id, ok: false, error: String(error?.message || error).slice(0, 200) }));
          return;
        }
        if (data.type === 'voice.mute') {
          const item = state.voice && voiceRooms.get(state.voice.channelId)?.get(state.id);
          if (!item || typeof data.muted !== 'boolean') return;
          item.muted = data.muted;
          emitVoiceState(state.voice.communityId, state.voice.channelId);
          return;
        }
        if (data.type === 'voice.signal') {
          // Relays an SDP offer/answer only between two sockets in the same voice room.
          const room = state.voice && voiceRooms.get(state.voice.channelId);
          const target = room && typeof data.to === 'string' ? room.get(data.to) : null;
          if (!target || target.state === state) fail(404, 'Участник вышел из канала.');
          const payload = data.data;
          if (!payload || typeof payload !== 'object' || !['offer', 'answer'].includes(payload.kind) || typeof payload.sdp !== 'string' || payload.sdp.length > 60_000 || !payload.sdp.startsWith('v=0')) fail(400, 'Некорректный сигнал.');
          sendSocket(target.state, { type: 'voice.signal', channelId: state.voice.channelId, from: state.id, userId: state.auth.user_id, device: room.get(state.id)?.device ?? null, data: { kind: payload.kind, sdp: payload.sdp } });
          return;
        }
        if (data.type === 'voice.auth') {
          // A Signal-encrypted note that proves the DTLS fingerprints of a voice connection end to end.
          // The server cannot read or forge it; it only passes it on inside the same voice room.
          const room = state.voice && voiceRooms.get(state.voice.channelId);
          const target = room && typeof data.to === 'string' ? room.get(data.to) : null;
          if (!target || target.state === state) fail(404, 'Участник вышел из канала.');
          const note = data.note;
          if (!note || typeof note !== 'object' || typeof note.senderDeviceId !== 'string' || note.senderDeviceId.length > 64 || (note.type !== 2 && note.type !== 3) || typeof note.body !== 'string' || note.body.length > 16_000) fail(400, 'Некорректная проверка соединения.');
          sendSocket(target.state, { type: 'voice.auth', channelId: state.voice.channelId, from: state.id, userId: state.auth.user_id, note: { senderDeviceId: note.senderDeviceId, type: note.type, body: note.body } });
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
    scheduled.releaseDue();
    limiter.sweep();
    recordSeen([...socketsByUser.keys()].filter(isOnline));
    // A client that only keeps its socket open (no HTTP requests for days) is in use too: its
    // session slides like one that makes requests.
    touchSessions([...sockets].filter(state => state.auth && state.socket.readyState === 1).map(state => state.auth));
    for (const state of sockets) {
      if (state.auth && !sessionStillValid(state)) { state.socket.close(4401, 'Session expired'); continue; }
      if (!state.alive) { state.socket.terminate(); continue; }
      state.alive = false;
      if (state.socket.readyState === 1) state.socket.ping();
    }
  }, maintenanceIntervalMs);
  maintenance.unref();
  app.addHook('onClose', async () => {
    sfu?.close();
    clearInterval(maintenance);
    scheduled.close();
    for (const room of voiceRooms.values()) for (const item of room.values()) clearTimeout(item.state.voiceGrace);
    if (!databaseClosed) { recordSeen(socketsByUser.keys()); databaseClosed = true; db.close(); }
  });
  try { await app.ready(); } catch (error) { await app.close(); throw error; }
  return app;
}
