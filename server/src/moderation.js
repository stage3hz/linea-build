// Block, report and account deletion (App Store 1.2 and 5.1.1(v)).
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, objectBody } from './security.js';
import { transaction, userForViewer } from './database.js';

export const MODERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  community_id TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('spam','abuse','violence','sexual','illegal','scam','other')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
`;
export const REPORT_REASONS = ['spam', 'abuse', 'violence', 'sexual', 'illegal', 'scam', 'other'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Either side blocked the other: no new messages and no calls between them. */
export const blockedBetween = (db, a, b) => !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a);
export const blockedByMe = (db, me, other) => !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(me, other);

export function installModerationRoutes({ app, db, authOptions, publicUser, timestamp, limiter }) {
  const id = value => { if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'Некорректный пользователь.'); return value; };
  app.get('/blocks', authOptions, async request => {
    const rows = db.prepare('SELECT u.* FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC').all(request.auth.user_id);
    return { users: rows.map(row => userForViewer(db, publicUser(row), request.auth.user_id)) };
  });
  app.put('/blocks/:id', authOptions, async request => {
    const target = id(request.params.id), me = request.auth.user_id;
    if (target === me) fail(400, 'Нельзя заблокировать себя.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(target)) fail(404, 'Пользователь не найден.');
    db.prepare('INSERT OR IGNORE INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(me, target, timestamp());
    return { ok: true, blocked: true };
  });
  app.delete('/blocks/:id', authOptions, async request => {
    db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(request.auth.user_id, id(request.params.id));
    return { ok: true, blocked: false };
  });
  app.post('/reports', authOptions, async (request, reply) => {
    const me = request.auth.user_id;
    if (!limiter.allow(`report:${me}`, 20, 24 * 60 * 60_000)) fail(429, 'Слишком много жалоб за сутки.');
    const body = objectBody(request.body, ['userId', 'communityId', 'reason', 'comment']);
    if (!REPORT_REASONS.includes(body.reason)) fail(400, 'Выбери причину жалобы.');
    const comment = body.comment === undefined ? '' : body.comment;
    if (typeof comment !== 'string' || comment.length > 1000) fail(400, 'Комментарий слишком длинный.');
    const userId = body.userId === undefined ? null : id(body.userId);
    const communityId = body.communityId === undefined ? null : id(body.communityId);
    if (!userId && !communityId) fail(400, 'На кого жалоба?');
    if (userId && !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) fail(404, 'Пользователь не найден.');
    if (communityId && !db.prepare('SELECT 1 FROM communities WHERE id=?').get(communityId)) fail(404, 'Канал не найден.');
    db.prepare('INSERT INTO reports(id,reporter_id,target_user_id,community_id,reason,comment,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), me, userId, communityId, body.reason, comment.trim(), timestamp());
    return reply.code(201).send({ ok: true });
  });
}

/**
 * Deletes the account with everything it owns: private chats (for both sides), channels and
 * servers it owns, its messages in other channels, its files, sessions, devices and settings.
 * Returns the chats that disappeared and their other members, so they can be told.
 */
export async function deleteAccount(db, uploadDir, userId) {
  const files = [];
  const removed = transaction(db, () => {
    const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(userId).map(row => row.chat_id);
    const peers = [];
    for (const chatId of chats) {
      for (const row of db.prepare('SELECT user_id FROM chat_members WHERE chat_id=? AND user_id<>?').all(chatId, userId)) peers.push({ chatId, userId: row.user_id });
      const messageIds = db.prepare('SELECT id FROM messages WHERE chat_id=?').all(chatId).map(row => row.id);
      for (const messageId of messageIds) {
        for (const row of db.prepare('SELECT upload_id FROM e2ee_message_attachments WHERE message_id=?').all(messageId)) files.push(row.upload_id);
        for (const row of db.prepare('SELECT id FROM uploads WHERE attached_message_id=?').all(messageId)) files.push(row.id);
      }
      db.prepare('DELETE FROM e2ee_message_attachments WHERE message_id IN (SELECT id FROM messages WHERE chat_id=?)').run(chatId);
      db.prepare('UPDATE uploads SET attached_message_id=NULL WHERE attached_message_id IN (SELECT id FROM messages WHERE chat_id=?)').run(chatId);
      db.prepare('DELETE FROM messages WHERE chat_id=?').run(chatId);
      db.prepare('DELETE FROM chats WHERE id=?').run(chatId);
    }
    db.prepare('DELETE FROM communities WHERE owner_id=?').run(userId);
    db.prepare('DELETE FROM community_messages WHERE sender_id=?').run(userId);
    db.prepare('DELETE FROM community_invites WHERE creator_id=?').run(userId);
    for (const row of db.prepare('SELECT id FROM uploads WHERE owner_id=?').all(userId)) files.push(row.id);
    const unique = [...new Set(files)];
    for (const uploadId of unique) {
      db.prepare('UPDATE messages SET attachment_id=NULL WHERE attachment_id=?').run(uploadId);
      db.prepare('DELETE FROM e2ee_message_attachments WHERE upload_id=?').run(uploadId);
      db.prepare('DELETE FROM uploads WHERE id=?').run(uploadId);
    }
    files.length = 0; files.push(...unique);
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    return peers;
  });
  for (const uploadId of files) await unlink(join(uploadDir, uploadId)).catch(() => {});
  return removed;
}
