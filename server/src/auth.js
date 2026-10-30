import { randomUUID } from 'node:crypto';
import { transaction, publicUser } from './database.js';
import {
  fail, objectBody, boundedText, usernameValue, passwordValue, passwordHash,
  passwordMatches, recoveryWordValue, normalizeRecoveryWord, deviceNameValue,
  tokenHash, newToken, validToken,
} from './security.js';

export const RECOVERY_LOCK_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_WAIT_MS = 10 * 60 * 1000;
export const RECOVERY_GRANT_MS = 20 * 60 * 1000;
const MAX_UNKNOWN_RECOVERY_NAMES = 10000;
const COLORS = ['#6C5CE7', '#2E8B83', '#BA6A43', '#566BC2', '#A44A7C', '#3C859F'];
const iso = time => new Date(time).toISOString();

export function installAuthRoutes({
  app, db, now, timestamp, authOptions, authThrottle, recoveryStatusThrottle,
  allowAccountLogin, withPasswordJob, newSession, dummyPasswordHash,
  closeRevokedSockets, emitUser, authTestHooks, deleteAccount,
}) {
  const activeUser = request => {
    const session = db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?')
      .get(request.auth?.token_hash || '', now());
    if (!session || session.user_id !== request.auth?.user_id) fail(401, 'Войдите в аккаунт заново.');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id);
    if (!user) fail(401, 'Войдите в аккаунт заново.');
    return user;
  };
  const sameCredentials = (current, snapshot) => Boolean(current &&
    current.credential_version === snapshot.credential_version &&
    current.password_hash === snapshot.password_hash &&
    current.confirmation_hash === snapshot.confirmation_hash &&
    current.recovery_hash === snapshot.recovery_hash);
  const unchangedUser = (request, snapshot) => {
    const current = activeUser(request);
    if (!sameCredentials(current, snapshot)) fail(401, 'Учётные данные изменились. Войдите снова.');
    return current;
  };
  const checkCredentials = async (user, password, confirmationWord) => {
    // Always perform both KDFs, including for unknown and legacy accounts. The
    // HTTP result does not identify which of the two entered secrets was wrong.
    const passwordCorrect = await passwordMatches(password, user?.password_hash || dummyPasswordHash);
    const confirmationCorrect = await passwordMatches(confirmationWord, user?.confirmation_hash || dummyPasswordHash);
    return Boolean(user && passwordCorrect && (!user.confirmation_hash || confirmationCorrect));
  };
  const reauthenticate = async (snapshot, password, confirmationWord) => {
    if (!await checkCredentials(snapshot, password, confirmationWord)) {
      fail(401, 'Неверный текущий пароль или подтверждающее слово.');
    }
  };
  const sessionResponse = (user, deviceName) => ({
    token: newSession(user.id, deviceName), user: publicUser(user, { db, now }),
    securitySetupRequired: !user.confirmation_hash || !user.recovery_hash,
  });
  const invalidateCredentials = (user, { password = user.password_hash, confirmation = user.confirmation_hash, recovery = user.recovery_hash }) => {
    const updated = db.prepare('UPDATE users SET password_hash=?,confirmation_hash=?,recovery_hash=?,credential_version=credential_version+1 WHERE id=? AND credential_version=? AND password_hash=?')
      .run(password, confirmation, recovery, user.id, user.credential_version, user.password_hash);
    if (updated.changes !== 1) fail(401, 'Учётные данные изменились. Войдите снова.');
    db.prepare('DELETE FROM recovery_grants WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM recovery_attempts WHERE name_key=?').run(tokenHash(user.login_name));
  };
  const ensurePasswordDiffersFromWords = async (password, user) => {
    const normalized = normalizeRecoveryWord(password);
    const matchesConfirmation = await passwordMatches(normalized, user.confirmation_hash || dummyPasswordHash);
    const matchesRecovery = await passwordMatches(normalized, user.recovery_hash || dummyPasswordHash);
    if ((user.confirmation_hash && matchesConfirmation) || (user.recovery_hash && matchesRecovery)) {
      fail(400, 'Основной пароль должен отличаться от обоих секретных слов.');
    }
  };
  const recoveryFailure = nameKey => {
    const budget = db.prepare('SELECT attempts,locked_until FROM recovery_attempts WHERE name_key=?').get(nameKey);
    if (budget && budget.locked_until > now()) {
      fail(429, 'Попытки восстановления закончились. Повторите через 24 часа после блокировки. Вход по паролю остаётся доступен.', {
        code: 'RECOVERY_LOCKED', attemptsRemaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((budget.locked_until - now()) / 1000)),
      });
    }
    fail(401, 'Неверный логин или слово для восстановления.', {
      code: 'RECOVERY_INVALID', attemptsRemaining: Math.max(0, 3 - (budget?.attempts || 0)),
    });
  };
  const reserveRecoveryAttempt = (username, userId) => transaction(db, () => {
    const time = now(), nameKey = tokenHash(username);
    let budget = db.prepare('SELECT * FROM recovery_attempts WHERE name_key=?').get(nameKey);
    if (budget && ((budget.locked_until && budget.locked_until <= time) ||
      (!budget.locked_until && budget.updated_at <= time - RECOVERY_LOCK_MS))) {
      db.prepare('DELETE FROM recovery_attempts WHERE name_key=?').run(nameKey);
      budget = undefined;
    }
    if (budget?.locked_until > time) recoveryFailure(nameKey);
    if (!budget) {
      // Known and unknown names have the same idle TTL. Otherwise, cleanup
      // could reveal account existence by returning different remaining tries.
      db.prepare('DELETE FROM recovery_attempts WHERE updated_at<=? AND locked_until<=?')
        .run(time - RECOVERY_LOCK_MS, time);
      if (db.prepare('SELECT COUNT(*) AS count FROM recovery_attempts WHERE user_id IS NULL').get().count >= MAX_UNKNOWN_RECOVERY_NAMES) {
        // Apply backpressure to every new budget, not just unknown accounts.
        fail(503, 'Восстановление временно занято. Попробуйте позже.');
      }
      budget = { attempts: 0, epoch: randomUUID() };
      db.prepare('INSERT INTO recovery_attempts(name_key,user_id,attempts,locked_until,updated_at,epoch) VALUES(?,?,0,0,?,?)')
        .run(nameKey, userId || null, time, budget.epoch);
    }
    const attempts = budget.attempts + 1;
    if (attempts > 3) recoveryFailure(nameKey);
    // Reserve before asynchronous work: the fourth concurrent request cannot
    // enter validation, but a correct third reserved request may still succeed.
    db.prepare('UPDATE recovery_attempts SET attempts=?,locked_until=?,updated_at=?,user_id=COALESCE(user_id,?) WHERE name_key=?')
      .run(attempts, attempts === 3 ? time + RECOVERY_LOCK_MS : 0, time, userId || null, nameKey);
    return { nameKey, epoch: budget.epoch };
  });
  const invalidGrant = () => fail(410, 'Запрос восстановления недействителен, отменён или истёк. Начните восстановление заново.');
  const readGrant = token => {
    if (!validToken(token)) invalidGrant();
    const grant = db.prepare('SELECT * FROM recovery_grants WHERE token_hash=? AND expires_at>?').get(tokenHash(token), now());
    const user = grant && db.prepare('SELECT * FROM users WHERE id=?').get(grant.user_id);
    if (!grant || !user || grant.credential_version !== user.credential_version) invalidGrant();
    return { grant, user };
  };
  const grantMetadata = grant => ({
    requestId: grant.id, readyAt: iso(grant.ready_at), expiresAt: iso(grant.expires_at), serverTime: timestamp(),
  });
  const ensureGrantReady = grant => {
    if (now() < grant.ready_at) fail(409, 'Защитное ожидание ещё не завершилось.', {
      code: 'RECOVERY_WAIT', readyAt: iso(grant.ready_at), serverTime: timestamp(),
      retryAfterSeconds: Math.max(1, Math.ceil((grant.ready_at - now()) / 1000)),
    });
  };

  app.post('/auth/register', async (request, reply) => {
    authThrottle(request);
    const body = objectBody(request.body, ['username', 'password', 'displayName', 'confirmationWord', 'recoveryWord', 'deviceName']);
    const username = usernameValue(body.username);
    const password = passwordValue(body.password, { username });
    const confirmationWord = recoveryWordValue(body.confirmationWord, { password, username });
    const recoveryWord = recoveryWordValue(body.recoveryWord, { password, username });
    if (confirmationWord === recoveryWord) fail(400, 'Подтверждающее слово и слово для восстановления должны отличаться.');
    const displayName = boundedText(body.displayName, 'Имя', 1, 50);
    const deviceName = deviceNameValue(body.deviceName);
    if (db.prepare('SELECT 1 FROM users WHERE username=? OR login_name=?').get(username, username)) fail(409, 'Это имя пользователя уже занято.', { code: 'USERNAME_TAKEN' });
    const hashes = await withPasswordJob(async () => ({
      password: await passwordHash(password), confirmation: await passwordHash(confirmationWord), recovery: await passwordHash(recoveryWord),
    }));
    const result = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE username=? OR login_name=?').get(username, username)) fail(409, 'Это имя пользователя уже занято.', { code: 'USERNAME_TAKEN' });
      const id = randomUUID();
      const color = COLORS[Number.parseInt(id.slice(0, 2), 16) % COLORS.length];
      db.prepare('INSERT INTO users(id,username,login_name,display_name,password_hash,confirmation_hash,recovery_hash,avatar_color,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, username, username, displayName, hashes.password, hashes.confirmation, hashes.recovery, color, timestamp());
      db.prepare('DELETE FROM recovery_attempts WHERE name_key=?').run(tokenHash(username));
      return sessionResponse(db.prepare('SELECT * FROM users WHERE id=?').get(id), deviceName);
    });
    return reply.code(201).send(result);
  });

  app.post('/auth/login', async request => {
    authThrottle(request);
    const body = objectBody(request.body, ['username', 'password', 'confirmationWord', 'deviceName']);
    const username = usernameValue(body.username);
    const password = passwordValue(body.password, { existing: true });
    const confirmationWord = normalizeRecoveryWord(body.confirmationWord ?? '');
    const deviceName = deviceNameValue(body.deviceName);
    // This limiter is independent of the recovery attempt budget.
    if (!allowAccountLogin(username)) fail(429, 'Слишком много попыток входа в этот аккаунт. Повторите позже.');
    const snapshot = db.prepare('SELECT * FROM users WHERE login_name=?').get(username);
    const matches = await withPasswordJob(() => checkCredentials(snapshot, password, confirmationWord));
    if (!matches) fail(401, 'Неверный логин, пароль или подтверждающее слово.');
    // Internal scheduling hook for deterministic race regression tests; not
    // exposed through HTTP, environment variables, or a production endpoint.
    if (authTestHooks?.beforeSessionCreate) await authTestHooks.beforeSessionCreate({ userId: snapshot.id });
    return transaction(db, () => {
      const current = db.prepare('SELECT * FROM users WHERE id=?').get(snapshot.id);
      if (!sameCredentials(current, snapshot)) fail(401, 'Учётные данные изменились. Войдите снова.');
      return sessionResponse(current, deviceName);
    });
  });

  app.post('/auth/logout', authOptions, async request => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(request.auth.token_hash);
    closeRevokedSockets();
    return { ok: true };
  });

  app.post('/auth/recovery/verify', async request => {
    authThrottle(request);
    const body = objectBody(request.body, ['username', 'recoveryWord', 'deviceName']);
    const username = usernameValue(body.username);
    const word = normalizeRecoveryWord(body.recoveryWord);
    const deviceName = deviceNameValue(body.deviceName);
    const result = await withPasswordJob(async () => {
      const snapshot = db.prepare('SELECT * FROM users WHERE login_name=?').get(username);
      // Acquire the global KDF slot first; overload rejections do not spend a try.
      const reservation = reserveRecoveryAttempt(username, snapshot?.id);
      const matches = await passwordMatches(word, snapshot?.recovery_hash || dummyPasswordHash);
      if (!snapshot?.recovery_hash || !matches) recoveryFailure(reservation.nameKey);
      return transaction(db, () => {
        const current = db.prepare('SELECT * FROM users WHERE id=?').get(snapshot.id);
        const budget = db.prepare('SELECT epoch FROM recovery_attempts WHERE name_key=?').get(reservation.nameKey);
        if (!sameCredentials(current, snapshot) || budget?.epoch !== reservation.epoch) recoveryFailure(reservation.nameKey);
        const resetToken = newToken(), id = randomUUID();
        const time = now(), readyAt = time + RECOVERY_WAIT_MS, expiresAt = readyAt + RECOVERY_GRANT_MS;
        db.prepare('DELETE FROM recovery_grants WHERE user_id=?').run(current.id);
        db.prepare('INSERT INTO recovery_grants(token_hash,id,user_id,credential_version,ready_at,expires_at,created_at,device_name) VALUES(?,?,?,?,?,?,?,?)')
          .run(tokenHash(resetToken), id, current.id, current.credential_version, readyAt, expiresAt, iso(time), deviceName);
        db.prepare('DELETE FROM recovery_attempts WHERE name_key=?').run(reservation.nameKey);
        return { userId: current.id, response: { resetToken, requestId: id, readyAt: iso(readyAt), expiresAt: iso(expiresAt), serverTime: iso(time) } };
      });
    });
    emitUser(result.userId, { type: 'recovery.requested' });
    return result.response;
  });

  app.post('/auth/recovery/status', async request => {
    // Polling for ten minutes must not exhaust the login/verification IP limit.
    recoveryStatusThrottle(request);
    const body = objectBody(request.body, ['resetToken']);
    const { grant } = readGrant(body.resetToken);
    return { ...grantMetadata(grant), status: now() < grant.ready_at ? 'waiting' : 'ready' };
  });

  app.post('/auth/recovery/reset', async request => {
    authThrottle(request);
    const body = objectBody(request.body, ['resetToken', 'newPassword']);
    const snapshot = readGrant(body.resetToken);
    const password = passwordValue(body.newPassword, { username: snapshot.user.login_name });
    ensureGrantReady(snapshot.grant);
    const encoded = await withPasswordJob(async () => {
      await ensurePasswordDiffersFromWords(password, snapshot.user);
      return passwordHash(password);
    });
    transaction(db, () => {
      // Cancellation, another reset, expiry, or a protected credential change
      // may have happened while scrypt ran. All checks and writes are atomic.
      const current = readGrant(body.resetToken);
      ensureGrantReady(current.grant);
      if (!sameCredentials(current.user, snapshot.user)) invalidGrant();
      invalidateCredentials(current.user, { password: encoded });
    });
    closeRevokedSockets(snapshot.user.id);
    return { ok: true };
  });

  app.get('/auth/recovery/requests', authOptions, async request => {
    const user = activeUser(request);
    const requests = db.prepare('SELECT id,created_at,ready_at,expires_at,device_name FROM recovery_grants WHERE user_id=? AND credential_version=? AND expires_at>? ORDER BY created_at DESC')
      .all(user.id, user.credential_version, now()).map(grant => ({
        id: grant.id, createdAt: grant.created_at, readyAt: iso(grant.ready_at), expiresAt: iso(grant.expires_at), deviceName: grant.device_name,
      }));
    return { requests };
  });

  app.post('/auth/recovery/cancel', authOptions, async request => {
    const body = objectBody(request.body, ['requestId']);
    const id = boundedText(body.requestId, 'Запрос восстановления', 1, 100);
    transaction(db, () => {
      const user = activeUser(request);
      const removed = db.prepare('DELETE FROM recovery_grants WHERE id=? AND user_id=? AND credential_version=? AND expires_at>?')
        .run(id, user.id, user.credential_version, now());
      if (removed.changes !== 1) fail(404, 'Запрос восстановления не найден.');
      // Also invalidate a verification already in flight when the owner cancels.
      db.prepare('DELETE FROM recovery_attempts WHERE name_key=?').run(tokenHash(user.login_name));
    });
    emitUser(request.auth.user_id, { type: 'recovery.updated' });
    return { ok: true };
  });

  app.get('/auth/security', authOptions, async request => {
    const user = activeUser(request);
    return { confirmationConfigured: Boolean(user.confirmation_hash), recoveryConfigured: Boolean(user.recovery_hash) };
  });

  app.post('/auth/password', authOptions, async request => {
    authThrottle(request);
    const body = objectBody(request.body, ['currentPassword', 'currentConfirmationWord', 'newPassword']);
    const snapshot = activeUser(request);
    const currentPassword = passwordValue(body.currentPassword, { existing: true });
    const currentConfirmationWord = normalizeRecoveryWord(body.currentConfirmationWord ?? '');
    const password = passwordValue(body.newPassword, { username: snapshot.login_name });
    const encoded = await withPasswordJob(async () => {
      await reauthenticate(snapshot, currentPassword, currentConfirmationWord);
      await ensurePasswordDiffersFromWords(password, snapshot);
      return passwordHash(password);
    });
    transaction(db, () => invalidateCredentials(unchangedUser(request, snapshot), { password: encoded }));
    closeRevokedSockets(snapshot.id);
    return { ok: true };
  });

  // Change the private sign-in login. Requires the current password and confirmation word;
  // the current session stays, every other session is signed out.
  app.post('/auth/login-name', authOptions, async request => {
    authThrottle(request);
    const body = objectBody(request.body, ['currentPassword', 'currentConfirmationWord', 'newLogin']);
    const snapshot = activeUser(request);
    const currentPassword = passwordValue(body.currentPassword, { existing: true });
    const currentConfirmationWord = normalizeRecoveryWord(body.currentConfirmationWord ?? '');
    const login = usernameValue(body.newLogin);
    if (login === snapshot.login_name) fail(400, 'Это и так твой логин.');
    if (normalizeRecoveryWord(currentPassword) === login) fail(400, 'Пароль совпадает с новым логином. Сначала смени пароль.');
    await withPasswordJob(() => reauthenticate(snapshot, currentPassword, currentConfirmationWord));
    const user = transaction(db, () => {
      const current = unchangedUser(request, snapshot);
      if (db.prepare('SELECT 1 FROM users WHERE id<>? AND (username=? OR login_name=?)').get(current.id, login, login)) {
        fail(409, 'Этот логин уже занят.', { code: 'LOGIN_TAKEN' });
      }
      db.prepare('UPDATE users SET login_name=? WHERE id=?').run(login, current.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(current.id, request.auth.token_hash);
      return db.prepare('SELECT * FROM users WHERE id=?').get(current.id);
    });
    closeRevokedSockets(snapshot.id);
    return { ok: true, loginName: user.login_name };
  });

  const changeWord = (path, field, column, otherColumn) => app.post(path, authOptions, async request => {
    authThrottle(request);
    const body = objectBody(request.body, ['currentPassword', 'currentConfirmationWord', field]);
    const snapshot = activeUser(request);
    const currentPassword = passwordValue(body.currentPassword, { existing: true });
    const currentConfirmationWord = normalizeRecoveryWord(body.currentConfirmationWord ?? '');
    const word = recoveryWordValue(body[field], { password: currentPassword, username: snapshot.login_name });
    const encoded = await withPasswordJob(async () => {
      await reauthenticate(snapshot, currentPassword, currentConfirmationWord);
      const sameWord = await passwordMatches(word, snapshot[column] || dummyPasswordHash);
      const sameOtherWord = await passwordMatches(word, snapshot[otherColumn] || dummyPasswordHash);
      if ((snapshot[column] && sameWord) || (snapshot[otherColumn] && sameOtherWord)) {
        fail(400, 'Выберите новое слово, отличающееся от обоих текущих слов.');
      }
      return passwordHash(word);
    });
    transaction(db, () => {
      const current = unchangedUser(request, snapshot);
      invalidateCredentials(current, column === 'confirmation_hash' ? { confirmation: encoded } : { recovery: encoded });
    });
    closeRevokedSockets(snapshot.id);
    return { ok: true };
  });
  // App Store 5.1.1(v): the account can be deleted from the app. Needs the password (and the
  // confirmation word when one is set), then removes the account with everything it owns.
  app.post('/auth/delete-account', authOptions, async request => {
    authThrottle(request);
    const body = objectBody(request.body, ['currentPassword', 'currentConfirmationWord']);
    const snapshot = activeUser(request);
    const currentPassword = passwordValue(body.currentPassword, { existing: true });
    const currentConfirmationWord = normalizeRecoveryWord(body.currentConfirmationWord ?? '');
    await withPasswordJob(() => reauthenticate(snapshot, currentPassword, currentConfirmationWord));
    unchangedUser(request, snapshot);
    await deleteAccount(snapshot.id);
    return { ok: true };
  });

  changeWord('/auth/confirmation-word', 'confirmationWord', 'confirmation_hash', 'recovery_hash');
  changeWord('/auth/recovery-word', 'recoveryWord', 'recovery_hash', 'confirmation_hash');

  app.get('/auth/sessions', authOptions, async request => {
    activeUser(request);
    const sessions = db.prepare('SELECT id,token_hash,device_name,created_at,last_active_at,expires_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC,id DESC')
      .all(request.auth.user_id, now()).map(session => ({
        id: session.id, deviceName: session.device_name, createdAt: session.created_at,
        lastActiveAt: session.last_active_at, expiresAt: iso(session.expires_at),
        isCurrent: session.token_hash === request.auth.token_hash,
      }));
    return { sessions };
  });

  app.post('/auth/sessions/revoke', authOptions, async request => {
    const body = objectBody(request.body, ['sessionId']);
    const id = boundedText(body.sessionId, 'Сессия', 1, 100);
    transaction(db, () => {
      activeUser(request);
      const session = db.prepare('SELECT token_hash FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(id, request.auth.user_id, now());
      if (!session) fail(404, 'Сессия не найдена.');
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
    });
    closeRevokedSockets();
    return { ok: true };
  });

  app.post('/auth/sessions/revoke-others', authOptions, async request => {
    objectBody(request.body || {}, []);
    transaction(db, () => {
      activeUser(request);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(request.auth.user_id, request.auth.token_hash);
    });
    closeRevokedSockets();
    return { ok: true };
  });
}
