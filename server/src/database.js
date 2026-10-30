import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platinaState, visibleStatus } from './entitlements.js';

function migratePlatinaExpiry(db) {
  const expiry = db.prepare('PRAGMA table_info(platina_entitlements)').all().find(column => column.name === 'expires_at');
  if (expiry?.notnull !== 1) return;
  // SQLite cannot drop NOT NULL in place. Rebuild only this leaf table inside
  // the caller's transaction, preserving all existing grants and their IDs.
  db.exec(`
    CREATE TABLE platina_entitlements_v5 (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL CHECK(source = 'admin'),
      granted_at INTEGER NOT NULL,
      expires_at INTEGER CHECK((expires_at IS NULL AND source = 'admin') OR expires_at > granted_at),
      revoked_at INTEGER
    );
    INSERT INTO platina_entitlements_v5(user_id,grant_id,source,granted_at,expires_at,revoked_at)
      SELECT user_id,grant_id,source,granted_at,expires_at,revoked_at FROM platina_entitlements;
    DROP TABLE platina_entitlements;
    ALTER TABLE platina_entitlements_v5 RENAME TO platina_entitlements;
  `);
}

export function openDatabase(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 5) throw new Error('This database requires a newer Linea server.');
    db.function('unicode_lower', { deterministic: true }, value => typeof value === 'string' ? value.toLowerCase() : value);
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    db.exec(schema);
    transaction(db, () => {
      // Introspection makes the migration safe for both a fresh schema and v1 databases.
      const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
      if (!userColumns.has('confirmation_hash')) db.exec('ALTER TABLE users ADD COLUMN confirmation_hash TEXT');
      if (!userColumns.has('recovery_hash')) db.exec('ALTER TABLE users ADD COLUMN recovery_hash TEXT');
      if (!userColumns.has('credential_version')) db.exec('ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0');
      if (!userColumns.has('login_name')) db.exec('ALTER TABLE users ADD COLUMN login_name TEXT');
      if (!userColumns.has('username_change_used')) db.exec('ALTER TABLE users ADD COLUMN username_change_used INTEGER NOT NULL DEFAULT 0 CHECK(username_change_used IN (0,1))');
      if (!userColumns.has('status_emoji')) db.exec('ALTER TABLE users ADD COLUMN status_emoji TEXT');
      if (!userColumns.has('last_seen_at')) db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT');
      const privacyColumns = new Set(db.prepare('PRAGMA table_info(user_privacy)').all().map(column => column.name));
      if (!privacyColumns.has('show_last_seen')) db.exec('ALTER TABLE user_privacy ADD COLUMN show_last_seen INTEGER NOT NULL DEFAULT 1 CHECK(show_last_seen IN (0,1))');
      db.exec('UPDATE users SET login_name=username WHERE login_name IS NULL');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_login_name ON users(login_name);
        CREATE TRIGGER IF NOT EXISTS users_login_immutable BEFORE UPDATE OF login_name ON users
        WHEN OLD.login_name IS NOT NEW.login_name BEGIN SELECT RAISE(ABORT,'Account login is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS users_id_immutable BEFORE UPDATE OF id ON users
        WHEN OLD.id IS NOT NEW.id BEGIN SELECT RAISE(ABORT,'Account ID is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS users_login_required BEFORE INSERT ON users
        WHEN NEW.login_name IS NULL OR length(NEW.login_name) NOT BETWEEN 3 AND 24 OR NEW.login_name GLOB '*[^a-z0-9_]*'
        BEGIN SELECT RAISE(ABORT,'A canonical login is required'); END;
        CREATE TRIGGER IF NOT EXISTS users_names_insert BEFORE INSERT ON users
        WHEN EXISTS(SELECT 1 FROM users WHERE username=NEW.login_name OR login_name=NEW.username)
        BEGIN SELECT RAISE(ABORT,'Account name is reserved'); END;
        CREATE TRIGGER IF NOT EXISTS users_username_reserved BEFORE UPDATE OF username ON users
        WHEN EXISTS(SELECT 1 FROM users WHERE id<>NEW.id AND login_name=NEW.username)
        BEGIN SELECT RAISE(ABORT,'Account name is reserved'); END;
      `);
      const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name));
      if (!sessionColumns.has('id')) db.exec('ALTER TABLE sessions ADD COLUMN id TEXT');
      if (!sessionColumns.has('device_name')) db.exec("ALTER TABLE sessions ADD COLUMN device_name TEXT NOT NULL DEFAULT 'Неизвестное устройство'");
      if (!sessionColumns.has('last_active_at')) db.exec("ALTER TABLE sessions ADD COLUMN last_active_at TEXT NOT NULL DEFAULT ''");
      // The encryption-device foreign key references this unique public id.
      // Establish the parent key before updating legacy session rows.
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sessions_id ON sessions(id)');
      for (const session of db.prepare('SELECT token_hash FROM sessions WHERE id IS NULL').all()) {
        db.prepare('UPDATE sessions SET id=? WHERE token_hash=?').run(randomUUID(), session.token_hash);
      }
      db.exec("UPDATE sessions SET last_active_at=created_at WHERE last_active_at=''");
      const grantColumns = new Set(db.prepare('PRAGMA table_info(recovery_grants)').all().map(column => column.name));
      if (!grantColumns.has('ready_at') || !grantColumns.has('id')) {
        // Discard only obsolete, temporary grants: old grants have no waiting period.
        db.exec('DELETE FROM recovery_grants');
      }
      if (!grantColumns.has('id')) db.exec('ALTER TABLE recovery_grants ADD COLUMN id TEXT');
      if (!grantColumns.has('ready_at')) db.exec('ALTER TABLE recovery_grants ADD COLUMN ready_at INTEGER NOT NULL DEFAULT 0');
      if (!grantColumns.has('device_name')) db.exec("ALTER TABLE recovery_grants ADD COLUMN device_name TEXT NOT NULL DEFAULT 'Неизвестное устройство'");
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS recovery_grants_id ON recovery_grants(id)');
      const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(column => column.name));
      if (!messageColumns.has('encrypted_json')) db.exec('ALTER TABLE messages ADD COLUMN encrypted_json TEXT');
      const uploadColumns = new Set(db.prepare('PRAGMA table_info(uploads)').all().map(column => column.name));
      if (!uploadColumns.has('is_encrypted')) db.exec('ALTER TABLE uploads ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0');
      if (version < 5) migratePlatinaExpiry(db);
      db.exec('PRAGMA user_version = 5');
    });
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function publicUser(row, { db, now = Date.now } = {}) {
  const platina = db ? platinaState(db, row.id, now()) : { active: false, expiresAt: null };
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarColor: row.avatar_color,
    avatarId: row.avatar_id,
    createdAt: row.created_at,
    ...visibleStatus(row, platina),
  };
}

const PRIVACY_DEFAULTS = { allowNewChats: true, showAvatar: true, readReceipts: true, showLastSeen: true };
export function privacyOf(db, userId) {
  const row = db.prepare('SELECT * FROM user_privacy WHERE user_id=?').get(userId);
  return row ? { allowNewChats: row.allow_new_chats === 1, showAvatar: row.show_avatar === 1, readReceipts: row.read_receipts === 1, showLastSeen: row.show_last_seen !== 0 } : { ...PRIVACY_DEFAULTS };
}

/** A serialized user as another account may see it. The owner always sees everything. */
export function userForViewer(db, user, viewerId) {
  if (!user || user.id === viewerId) return user;
  return privacyOf(db, user.id).showAvatar ? user : { ...user, avatarId: null };
}

/** "Online / last seen" is mutual, as in Telegram: whoever hides it does not see it either. */
export function presenceVisible(db, a, b) {
  return privacyOf(db, a).showLastSeen && privacyOf(db, b).showLastSeen;
}

/** Read receipts are mutual, as in common messengers: hidden if either side turned them off. */
export function receiptsVisible(db, a, b) {
  return privacyOf(db, a).readReceipts && privacyOf(db, b).readReceipts;
}

export function publicAttachment(row) {
  return { id: row.id, name: row.name, mimeType: row.mime_type, size: row.size };
}

export function publicMessage(_db, row) {
  const encrypted = row.encrypted_json ? JSON.parse(row.encrypted_json) : null;
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    clientId: row.client_id,
    text: '',
    attachment: null,
    createdAt: row.created_at,
    ...(encrypted ? { encrypted } : { legacy: true }),
  };
}

export function chatSettings(db, userId, chatId) {
  const row = db.prepare('SELECT pinned_at,archived,muted FROM chat_settings WHERE user_id=? AND chat_id=?').get(userId, chatId);
  return { pinnedAt: row?.pinned_at ?? null, archived: !!row?.archived, muted: !!row?.muted };
}

export function publicChat(db, chatId, userId, options) {
  const chat = db.prepare('SELECT * FROM chats WHERE id=?').get(chatId);
  const self = db.prepare('SELECT * FROM chat_members WHERE chat_id=? AND user_id=?').get(chatId, userId);
  if (!chat || !self) return null;
  const peerMember = db.prepare('SELECT * FROM chat_members WHERE chat_id=? AND user_id != ?').get(chatId, userId);
  const peer = db.prepare('SELECT * FROM users WHERE id=?').get(peerMember.user_id);
  const lastMessage = db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1').get(chatId);
  const unread = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE chat_id=? AND sender_id != ? AND id>?').get(chatId, userId, self.last_read_message_id);
  return {
    id: chat.id,
    peer: userForViewer(db, publicUser(peer, { db, now: options?.now || Date.now }), userId),
    lastMessage: lastMessage ? publicMessage(db, lastMessage, options) : null,
    unreadCount: unread.count,
    lastReadMessageId: self.last_read_message_id,
    peerLastReadMessageId: receiptsVisible(db, userId, peerMember.user_id) ? peerMember.last_read_message_id : 0,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    settings: chatSettings(db, userId, chatId),
  };
}
