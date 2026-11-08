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

/** `blocksChanged(a, b)`: app.js pushes the new presence and chat state to both accounts at once. */
export function installModerationRoutes({ app, db, authOptions, publicUser, timestamp, limiter, blocksChanged = () => {} }) {
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
    // As in Discord: blocking ends the friendship and any request between the two.
    db.prepare('DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(me, target, target, me);
    db.prepare('DELETE FROM contacts WHERE (owner_id=? AND contact_id=?) OR (owner_id=? AND contact_id=?)').run(me, target, target, me);
    blocksChanged(me, target);
    return { ok: true, blocked: true };
  });
  app.delete('/blocks/:id', authOptions, async request => {
    const target = id(request.params.id), me = request.auth.user_id;
    const removed = db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(me, target).changes;
    if (removed) blocksChanged(me, target);
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
/** F4: scheduled messages of a chat or an account go with it (PRAGMA foreign_keys is off); returns their attachment uploads to remove. */
function dropScheduled(db, column, value) {
  const ids = [];
  for (const row of db.prepare(`SELECT encrypted_json FROM scheduled_messages WHERE ${column}=?`).all(value)) {
    try { const list = JSON.parse(row.encrypted_json).attachmentIds; if (Array.isArray(list)) ids.push(...list.filter(id => typeof id === 'string')); } catch { /* opaque ciphertext without attachments */ }
  }
  db.prepare(`DELETE FROM scheduled_messages WHERE ${column}=?`).run(value);
  return ids;
}
/** Removes one private chat with all its messages and attached files, for both participants. */
export async function deleteChatForEveryone(db, uploadDir, chatId) {
  const files = [];
  const members = transaction(db, () => {
    const ids = db.prepare('SELECT user_id FROM chat_members WHERE chat_id=?').all(chatId).map(row => row.user_id);
    for (const row of db.prepare('SELECT a.upload_id FROM e2ee_message_attachments a JOIN messages m ON m.id=a.message_id WHERE m.chat_id=?').all(chatId)) files.push(row.upload_id);
    for (const row of db.prepare('SELECT u.id FROM uploads u JOIN messages m ON m.id=u.attached_message_id WHERE m.chat_id=?').all(chatId)) files.push(row.id);
    for (const row of db.prepare('SELECT attachment_id FROM messages WHERE chat_id=? AND attachment_id IS NOT NULL').all(chatId)) files.push(row.attachment_id);
    files.push(...dropScheduled(db, 'chat_id', chatId));
    const unique = [...new Set(files)];
    db.prepare('DELETE FROM e2ee_message_attachments WHERE message_id IN (SELECT id FROM messages WHERE chat_id=?)').run(chatId);
    db.prepare('UPDATE uploads SET attached_message_id=NULL WHERE attached_message_id IN (SELECT id FROM messages WHERE chat_id=?)').run(chatId);
    db.prepare('DELETE FROM messages WHERE chat_id=?').run(chatId);
    db.prepare('DELETE FROM chats WHERE id=?').run(chatId);
    for (const uploadId of unique) {
      db.prepare('UPDATE messages SET attachment_id=NULL WHERE attachment_id=?').run(uploadId);
      db.prepare('DELETE FROM e2ee_message_attachments WHERE upload_id=?').run(uploadId);
      db.prepare('DELETE FROM uploads WHERE id=?').run(uploadId);
    }
    files.length = 0; files.push(...unique);
    return ids;
  });
  for (const uploadId of files) await unlink(join(uploadDir, uploadId)).catch(() => {});
  return members;
}

export async function deleteAccount(db, uploadDir, userId) {
  const files = [], parts = [];
  const removed = transaction(db, () => {
    const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(userId).map(row => row.chat_id);
    const peers = [];
    for (const chatId of chats) {
      for (const row of db.prepare('SELECT user_id FROM chat_members WHERE chat_id=? AND user_id<>?').all(chatId, userId)) peers.push({ chatId, userId: row.user_id });
      // The peer's scheduled messages in this chat go too (their files are the peer's uploads).
      files.push(...dropScheduled(db, 'chat_id', chatId));
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
    db.prepare('DELETE FROM community_reactions WHERE user_id=? OR message_id IN (SELECT id FROM community_messages WHERE sender_id=?)').run(userId, userId);
    db.prepare('DELETE FROM communities WHERE owner_id=?').run(userId);
    db.prepare('DELETE FROM community_messages WHERE sender_id=?').run(userId);
    db.prepare('DELETE FROM community_invites WHERE creator_id=?').run(userId);
    db.prepare('DELETE FROM profile_posts WHERE owner_id=?').run(userId);
    files.push(...dropScheduled(db, 'owner_id', userId));
    for (const row of db.prepare('SELECT id FROM uploads WHERE owner_id=?').all(userId)) files.push(row.id);
    const unique = [...new Set(files)];
    for (const uploadId of unique) {
      db.prepare('UPDATE messages SET attachment_id=NULL WHERE attachment_id=?').run(uploadId);
      db.prepare('DELETE FROM e2ee_message_attachments WHERE upload_id=?').run(uploadId);
      db.prepare('DELETE FROM uploads WHERE id=?').run(uploadId);
    }
    files.length = 0; files.push(...unique);
    // Unfinished chunked uploads (plaintext and encrypted): their rows go now, their `<id>.part` files below.
    for (const table of ['plain_upload_sessions', 'e2ee_upload_sessions']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const row of db.prepare(`SELECT id FROM ${table} WHERE owner_id=?`).all(userId)) parts.push(row.id);
      db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(userId);
    }
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    return peers;
  });
  for (const uploadId of files) await unlink(join(uploadDir, uploadId)).catch(() => {});
  for (const id of parts) await unlink(join(uploadDir, `${id}.part`)).catch(() => {});
  return removed;
}
