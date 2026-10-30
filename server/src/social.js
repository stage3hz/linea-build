// Friends (contacts) and per-user chat settings (pin, archive, mute).
import { fail, objectBody } from './security.js';
import { chatSettings, publicChat, userForViewer } from './database.js';
export { chatSettings };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONTACTS = 2000;
const MAX_PINNED = 5;


export function installSocialRoutes({ app, db, authOptions, publicUser, timestamp, serializationOptions, emitUser }) {
  const userId = value => { if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'Некорректный пользователь.'); return value; };

  app.get('/users/:id', authOptions, async request => {
    const id = userId(request.params.id), viewer = request.auth.user_id;
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!row) fail(404, 'Пользователь не найден.');
    const chat = db.prepare('SELECT a.chat_id FROM chat_members a JOIN chat_members b ON a.chat_id=b.chat_id WHERE a.user_id=? AND b.user_id=?').get(viewer, id);
    const contact = !!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(viewer, id);
    return { user: userForViewer(db, publicUser(row), viewer), isContact: contact, chatId: chat?.chat_id ?? null };
  });

  app.get('/contacts', authOptions, async request => {
    const rows = db.prepare('SELECT u.* FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.owner_id=? ORDER BY u.display_name COLLATE NOCASE').all(request.auth.user_id);
    return { users: rows.map(row => userForViewer(db, publicUser(row), request.auth.user_id)) };
  });

  app.put('/contacts/:id', authOptions, async request => {
    const id = userId(request.params.id), viewer = request.auth.user_id;
    if (id === viewer) fail(400, 'Нельзя добавить себя.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, 'Пользователь не найден.');
    if (db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE owner_id=?').get(viewer).n >= MAX_CONTACTS) fail(400, 'Слишком много друзей в списке.');
    db.prepare('INSERT OR IGNORE INTO contacts(owner_id,contact_id,created_at) VALUES(?,?,?)').run(viewer, id, timestamp());
    return { ok: true };
  });

  app.delete('/contacts/:id', authOptions, async request => {
    db.prepare('DELETE FROM contacts WHERE owner_id=? AND contact_id=?').run(request.auth.user_id, userId(request.params.id));
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
