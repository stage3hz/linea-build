// Who may call me: everyone / only friends (my contacts) / only people I allowed,
// plus a personal "never" list (by @login). The deny list always wins; the allow
// list also works as exceptions in «friends» mode.
import { fail, objectBody } from './security.js';
import { userForViewer } from './database.js';

export const CALL_MODES = Object.freeze(['everyone', 'contacts', 'allowed']);
export const MAX_CALL_RULES = 500;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CALL_PRIVACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS call_rules (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule TEXT NOT NULL CHECK(rule IN ('allow','deny')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, user_id)
);`;

export function migrateCallPrivacy(db) {
  db.exec(CALL_PRIVACY_SCHEMA);
  const columns = new Set(db.prepare('PRAGMA table_info(user_privacy)').all().map(column => column.name));
  if (!columns.has('calls')) db.exec("ALTER TABLE user_privacy ADD COLUMN calls TEXT NOT NULL DEFAULT 'everyone' CHECK(calls IN ('everyone','contacts','allowed'))");
}

/** May `callerId` ring `calleeId`? */
export function canCall(db, callerId, calleeId) {
  if (callerId === calleeId) return false;
  const rule = db.prepare('SELECT rule FROM call_rules WHERE owner_id=? AND user_id=?').get(calleeId, callerId)?.rule;
  if (rule === 'deny') return false;
  const mode = db.prepare('SELECT calls FROM user_privacy WHERE user_id=?').get(calleeId)?.calls || 'everyone';
  if (mode === 'everyone' || rule === 'allow') return true;
  if (mode === 'contacts') return !!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(calleeId, callerId);
  return false;
}

export function installCallPrivacyRoutes({ app, db, authOptions, publicUser, timestamp }) {
  const userId = value => { if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'Некорректный пользователь.'); return value; };
  const rules = owner => {
    const rows = db.prepare('SELECT r.rule, u.* FROM call_rules r JOIN users u ON u.id=r.user_id WHERE r.owner_id=? ORDER BY r.created_at DESC').all(owner);
    const pack = rule => rows.filter(row => row.rule === rule).map(row => userForViewer(db, publicUser(row), owner));
    return { allow: pack('allow'), deny: pack('deny') };
  };
  app.get('/me/call-rules', authOptions, async request => rules(request.auth.user_id));
  app.put('/me/call-rules/:id', authOptions, async request => {
    const owner = request.auth.user_id, id = userId(request.params.id);
    const body = objectBody(request.body, ['rule']);
    if (body.rule !== 'allow' && body.rule !== 'deny') fail(400, 'Правило должно быть «разрешить» или «запретить».');
    if (id === owner) fail(400, 'Нельзя добавить себя.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, 'Пользователь не найден.');
    const exists = db.prepare('SELECT 1 FROM call_rules WHERE owner_id=? AND user_id=?').get(owner, id);
    if (!exists && db.prepare('SELECT COUNT(*) AS n FROM call_rules WHERE owner_id=?').get(owner).n >= MAX_CALL_RULES) fail(400, 'Список слишком большой.');
    db.prepare('INSERT INTO call_rules(owner_id,user_id,rule,created_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,user_id) DO UPDATE SET rule=excluded.rule,created_at=excluded.created_at').run(owner, id, body.rule, timestamp());
    return rules(owner);
  });
  app.delete('/me/call-rules/:id', authOptions, async request => {
    db.prepare('DELETE FROM call_rules WHERE owner_id=? AND user_id=?').run(request.auth.user_id, userId(request.params.id));
    return rules(request.auth.user_id);
  });
  // Caller side: may I ring this person? Callee side: may this person ring me?
  app.get('/calls/permission/:id', authOptions, async request => {
    const me = request.auth.user_id, other = userId(request.params.id);
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(other)) fail(404, 'Пользователь не найден.');
    return request.query.direction === 'incoming' ? { allowed: canCall(db, other, me) } : { allowed: canCall(db, me, other) };
  });
}
