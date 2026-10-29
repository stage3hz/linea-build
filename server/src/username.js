import { publicUser, transaction, userForViewer } from './database.js';
import { isStatusEmoji, platinaState, STATUS_EMOJI_CHOICES, visibleStatus } from './entitlements.js';
import { fail, objectBody, usernameValue } from './security.js';

function activeUser(db, now, request) {
  // Auth middleware has already parsed request.auth. Recheck the stored session
  // inside the transaction that grants or spends a right, including revocation.
  const row = db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.id=?')
    .get(request.auth.token_hash, now(), request.auth.user_id);
  if (!row) fail(401, 'Войдите в аккаунт заново.');
  return row;
}

function accountState(db, now, user) {
  const platina = platinaState(db, user.id, now());
  const freeChangeAvailable = user.username_change_used === 0;
  return {
    accountId: user.id, loginName: user.login_name, username: user.username,
    freeChangeAvailable, canChangeUsername: freeChangeAvailable || platina.active,
    platina, canSetStatusEmoji: platina.active,
    statusEmoji: visibleStatus(user, platina).statusEmoji,
    statusEmojiChoices: STATUS_EMOJI_CHOICES,
  };
}

function broadcastProfile({ db, emitUser, emitChat }, user) {
  const recipients = db.prepare(`SELECT DISTINCT cm.user_id FROM chat_members cm JOIN chat_members own ON own.chat_id=cm.chat_id WHERE own.user_id=?`).all(user.id);
  emitUser(user.id, { type: 'profile', user });
  for (const { user_id } of recipients) if (user_id !== user.id) emitUser(user_id, { type: 'profile', user: userForViewer(db, user, user_id) });
  for (const { chat_id } of db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(user.id)) emitChat(chat_id);
}

function mutateProfile(context, request, change) {
  const { db, now } = context;
  const result = transaction(db, () => {
    const current = activeUser(db, now, request);
    const changed = change(current);
    const user = changed ? db.prepare('SELECT * FROM users WHERE id=?').get(current.id) : current;
    return { changed, value: { user: publicUser(user, { db, now }), status: accountState(db, now, user) } };
  });
  if (result.changed) broadcastProfile(context, result.value.user);
  return result.value;
}

export function installUsernameRoutes({ app, db, now, authOptions, emitUser, emitChat }) {
  const context = { db, now, emitUser, emitChat };
  app.get('/me/username', authOptions, async request => accountState(db, now, activeUser(db, now, request)));

  app.patch('/me/username', authOptions, async request => {
    const body = objectBody(request.body, ['username']);
    const username = usernameValue(body.username);
    return mutateProfile(context, request, current => {
      if (username === current.username) return false;
      const occupied = db.prepare('SELECT 1 FROM users WHERE id<>? AND (username=? OR login_name=?)').get(current.id, username, username);
      if (occupied) fail(409, 'Это имя пользователя уже занято.', { code: 'USERNAME_TAKEN' });
      if (current.username_change_used !== 0 && !platinaState(db, current.id, now()).active) {
        fail(403, 'Бесплатная смена уже использована. Для новой смены нужна активная Platina.', { code: 'PLATINA_REQUIRED' });
      }
      db.prepare('UPDATE users SET username=?,username_change_used=1 WHERE id=?').run(username, current.id);
      return true;
    });
  });

  app.patch('/me/status-emoji', authOptions, async request => {
    const body = objectBody(request.body, ['statusEmoji']);
    const selected = body.statusEmoji;
    if (selected !== null && !isStatusEmoji(selected)) fail(400, 'Выберите статичный эмодзи из доступного набора или очистите статус.', { code: 'STATUS_EMOJI_INVALID' });
    return mutateProfile(context, request, current => {
      if (selected !== null && !platinaState(db, current.id, now()).active) {
        fail(403, 'Для статусного эмодзи нужна активная Platina.', { code: 'PLATINA_REQUIRED' });
      }
      if (selected === current.status_emoji) return false;
      db.prepare('UPDATE users SET status_emoji=? WHERE id=?').run(selected, current.id);
      return true;
    });
  });
}
