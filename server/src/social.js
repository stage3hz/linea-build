// Friends (contacts) and per-user chat settings (pin, archive, mute).
import { fail, objectBody } from './security.js';
import { chatSettings, publicChat, userForViewer } from './database.js';
import { blockedByMe } from './moderation.js';
export { chatSettings };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONTACTS = 2000;
const MAX_PINNED = 5;
const MAX_OUTGOING = 100;  // unanswered requests one person may have sent
const MAX_INCOMING = 500;  // waiting requests one person may receive


export function installSocialRoutes({ app, db, authOptions, publicUser, timestamp, serializationOptions, emitUser }) {
  const userId = value => { if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'Некорректный пользователь.'); return value; };

  app.get('/users/:id', authOptions, async request => {
    const id = userId(request.params.id), viewer = request.auth.user_id;
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!row) fail(404, 'Пользователь не найден.');
    const chat = db.prepare('SELECT a.chat_id FROM chat_members a JOIN chat_members b ON a.chat_id=b.chat_id WHERE a.user_id=? AND b.user_id=?').get(viewer, id);
    const contact = !!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(viewer, id);
    return { user: userForViewer(db, publicUser(row), viewer), isContact: contact, friendRequest: contact ? null : requestState(viewer, id), chatId: chat?.chat_id ?? null, blocked: blockedByMe(db, viewer, id) };
  });

  app.get('/contacts', authOptions, async request => {
    const rows = db.prepare('SELECT u.* FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.owner_id=? ORDER BY u.display_name COLLATE NOCASE').all(request.auth.user_id);
    return { users: rows.map(row => userForViewer(db, publicUser(row), request.auth.user_id)) };
  });

  const isContact = (a, b) => !!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(a, b);
  const requested = (from, to) => !!db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?').get(from, to);
  const blockedEither = (a, b) => !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a);
  const contactCount = id => db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE owner_id=?').get(id).n;
  const notify = (...ids) => { for (const id of ids) emitUser?.(id, { type: 'friends' }); };
  /** Both people become friends (two rows); any request between them is gone. */
  const befriend = (a, b) => {
    if (contactCount(a) >= MAX_CONTACTS || contactCount(b) >= MAX_CONTACTS) fail(400, 'Слишком много друзей в списке.');
    const now = timestamp();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO contacts(owner_id,contact_id,created_at) VALUES(?,?,?)').run(a, b, now);
      db.prepare('INSERT OR IGNORE INTO contacts(owner_id,contact_id,created_at) VALUES(?,?,?)').run(b, a, now);
      db.prepare('DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(a, b, b, a);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    notify(a, b);
  };
  const requestState = (viewer, other) => requested(viewer, other) ? 'outgoing' : requested(other, viewer) ? 'incoming' : null;

  // "В друзья": sends a request, or accepts the one the other person already sent.
  app.put('/contacts/:id', authOptions, async request => {
    const id = userId(request.params.id), viewer = request.auth.user_id;
    if (id === viewer) fail(400, 'Нельзя добавить себя.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, 'Пользователь не найден.');
    if (blockedByMe(db, viewer, id)) fail(400, 'Сначала разблокируй пользователя.');
    if (isContact(viewer, id) && isContact(id, viewer)) return { ok: true, status: 'friends' };
    // They already asked (or added us earlier, before requests existed): we become friends now.
    if (requested(id, viewer) || isContact(id, viewer)) { befriend(viewer, id); return { ok: true, status: 'friends' }; }
    if (contactCount(viewer) >= MAX_CONTACTS) fail(400, 'Слишком много друзей в списке.');
    if (requested(viewer, id)) return { ok: true, status: 'requested' };
    if (db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id=?').get(viewer).n >= MAX_OUTGOING) fail(429, 'Слишком много неотвеченных заявок. Отмени часть из них.');
    // Someone who blocked us never learns about the request; for us it looks sent.
    if (blockedEither(viewer, id)) return { ok: true, status: 'requested' };
    if (db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE to_id=?').get(id).n >= MAX_INCOMING) return { ok: true, status: 'requested' };
    db.prepare('INSERT OR IGNORE INTO friend_requests(from_id,to_id,created_at) VALUES(?,?,?)').run(viewer, id, timestamp());
    notify(viewer, id);
    return { ok: true, status: 'requested' };
  });

  // Remove a friend: the friendship ends for both.
  app.delete('/contacts/:id', authOptions, async request => {
    const id = userId(request.params.id), viewer = request.auth.user_id;
    const gone = db.prepare('DELETE FROM contacts WHERE (owner_id=? AND contact_id=?) OR (owner_id=? AND contact_id=?)').run(viewer, id, id, viewer).changes;
    if (gone) notify(viewer, id);
    return { ok: true };
  });

  app.get('/friends/requests', authOptions, async request => {
    const viewer = request.auth.user_id;
    const list = sql => db.prepare(sql).all(viewer).map(row => ({ user: userForViewer(db, publicUser(row), viewer), createdAt: row.request_at }));
    return {
      incoming: list(`SELECT u.*, r.created_at AS request_at FROM friend_requests r JOIN users u ON u.id=r.from_id
        WHERE r.to_id=? AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=r.to_id AND b.blocked_id=r.from_id) ORDER BY r.created_at DESC LIMIT ${MAX_INCOMING}`),
      outgoing: list(`SELECT u.*, r.created_at AS request_at FROM friend_requests r JOIN users u ON u.id=r.to_id WHERE r.from_id=? ORDER BY r.created_at DESC LIMIT ${MAX_OUTGOING}`),
    };
  });

  app.post('/friends/requests/:id/accept', authOptions, async request => {
    const id = userId(request.params.id), viewer = request.auth.user_id;
    if (!requested(id, viewer) || blockedEither(viewer, id)) fail(404, 'Заявка не найдена.');
    befriend(viewer, id);
    return { ok: true, status: 'friends' };
  });

  // Decline an incoming request or cancel our own.
  app.delete('/friends/requests/:id', authOptions, async request => {
    const id = userId(request.params.id), viewer = request.auth.user_id;
    const gone = db.prepare('DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(viewer, id, id, viewer).changes;
    if (gone) notify(viewer, id);
    return { ok: true };
  });

  app.patch('/chats/:chatId/settings', authOptions, async request => {
    const chatId = request.params.chatId, viewer = request.auth.user_id;
    if (typeof chatId !== 'string' || !uuid.test(chatId) || !db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?').get(chatId, viewer)) fail(404, 'Чат не найден.');
    const body = objectBody(request.body, ['pinned', 'archived', 'muted']);
    for (const key of ['pinned', 'archived', 'muted']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'Некорректная настройка чата.');
    const current = chatSettings(db, viewer, chatId);
    let pinnedAt = current.pinnedAt;
    if (body.pinned === true && !pinnedAt) {
      const count = db.prepare('SELECT COUNT(*) AS n FROM chat_settings WHERE user_id=? AND pinned_at IS NOT NULL').get(viewer).n;
      if (count >= MAX_PINNED) fail(400, `Можно закрепить не больше ${MAX_PINNED} чатов.`);
      pinnedAt = timestamp();
    }
    if (body.pinned === false) pinnedAt = null;
    const archived = body.archived ?? current.archived, muted = body.muted ?? current.muted;
    // An archived chat is not pinned in the main list (as in Telegram).
    if (body.archived === true) pinnedAt = null;
    db.prepare(`INSERT INTO chat_settings(user_id,chat_id,pinned_at,archived,muted) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,chat_id) DO UPDATE SET pinned_at=excluded.pinned_at,archived=excluded.archived,muted=excluded.muted`)
      .run(viewer, chatId, pinnedAt, archived ? 1 : 0, muted ? 1 : 0);
    const chat = publicChat(db, chatId, viewer, serializationOptions);
    emitUser(viewer, { type: 'chat', chat });
    return { chat };
  });
}
