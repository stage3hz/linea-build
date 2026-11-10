// «Время захода» exceptions, as in Telegram: «Всегда показывать» (allow) and «Никогда не показывать»
// (deny). The visibility rules themselves live in database.js (sharesLastSeen / presenceVisible).
// Only the owner ever reads these lists; the people in them are not told.
import { fail, objectBody } from './security.js';
import { userForViewer } from './database.js';

export const MAX_LAST_SEEN_RULES = 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `changed(ownerId, userId)`: app.js re-sends both sides' presence when they share a chat. */
export function installLastSeenRoutes({ app, db, authOptions, publicUser, timestamp, changed }) {
  const userId = value => { if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'Некорректный пользователь.'); return value; };
  const rules = owner => {
    const rows = db.prepare('SELECT r.rule, u.* FROM last_seen_rules r JOIN users u ON u.id=r.user_id WHERE r.owner_id=? ORDER BY r.created_at DESC, u.display_name COLLATE NOCASE').all(owner);
    const pack = rule => rows.filter(row => row.rule === rule).map(row => userForViewer(db, publicUser(row), owner));
    return { allow: pack('allow'), deny: pack('deny') };
  };
  app.get('/me/last-seen-rules', authOptions, async request => rules(request.auth.user_id));
  // Adding someone to one list takes him out of the other (Telegram does the same).
  app.put('/me/last-seen-rules/:id', authOptions, async request => {
    const owner = request.auth.user_id, id = userId(request.params.id);
    const body = objectBody(request.body, ['rule']);
    if (body.rule !== 'allow' && body.rule !== 'deny') fail(400, 'Правило должно быть «всегда» или «никогда».');
    if (id === owner) fail(400, 'Нельзя добавить себя.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, 'Пользователь не найден.');
    const exists = db.prepare('SELECT 1 FROM last_seen_rules WHERE owner_id=? AND user_id=?').get(owner, id);
    if (!exists && db.prepare('SELECT COUNT(*) AS n FROM last_seen_rules WHERE owner_id=?').get(owner).n >= MAX_LAST_SEEN_RULES) fail(400, 'Список слишком большой.');
    db.prepare('INSERT INTO last_seen_rules(owner_id,user_id,rule,created_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,user_id) DO UPDATE SET rule=excluded.rule,created_at=excluded.created_at').run(owner, id, body.rule, timestamp());
    changed?.(owner, id);
    return rules(owner);
  });
  app.delete('/me/last-seen-rules/:id', authOptions, async request => {
    const owner = request.auth.user_id, id = userId(request.params.id);
    if (db.prepare('DELETE FROM last_seen_rules WHERE owner_id=? AND user_id=?').run(owner, id).changes) changed?.(owner, id);
    return rules(owner);
  });
}
