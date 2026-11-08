import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platinaState, visibleStatus } from './entitlements.js';
import { visibleCosmetics } from './cosmetics.js';

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
    // WAL: readers (cluster.js position checks, platina-admin, backup snapshots) no longer wait on
    // the writer, and a commit is one sequential append instead of a journal rewrite. It is also the
    // mode Litestream (Dockerfile, deploy/cluster.md) replicates from; the delete-mode default made
    // it fall back to converting the file itself. synchronous=NORMAL in WAL is durable against the
    // process crashing (the WAL is fsynced at checkpoint); only a power loss can lose the very last
    // commits, which Litestream's second-by-second copy already bounds. busy_timeout: a concurrent
    // reader (backup, admin tools) gets a wait instead of SQLITE_BUSY.
    db.exec('PRAGMA busy_timeout = 10000');
    if (db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') throw new Error('SQLite could not switch the database to WAL mode');
    db.exec('PRAGMA synchronous = NORMAL');
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
      // Birthday, as in Telegram: «MM-DD» (day and month) or «YYYY-MM-DD» (full date).
      if (!userColumns.has('birthday')) db.exec('ALTER TABLE users ADD COLUMN birthday TEXT');
      // Optional, shown only as the colour of birthday greetings: «male» (blue) or «female» (pink).
      if (!userColumns.has('gender')) db.exec('ALTER TABLE users ADD COLUMN gender TEXT');
      // Telegram-style background pattern of the profile header: one emoji from PROFILE_PATTERNS (cosmetics.js).
      if (!userColumns.has('profile_pattern')) db.exec('ALTER TABLE users ADD COLUMN profile_pattern TEXT');
      for (const column of ['avatar_video_id', 'avatar_frame', 'banner_id', 'banner_kind', 'banner_preset']) {
        if (!userColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
      }
      const privacyColumns = new Set(db.prepare('PRAGMA table_info(user_privacy)').all().map(column => column.name));
      if (!privacyColumns.has('show_last_seen')) db.exec('ALTER TABLE user_privacy ADD COLUMN show_last_seen INTEGER NOT NULL DEFAULT 1 CHECK(show_last_seen IN (0,1))');
      db.exec('UPDATE users SET login_name=username WHERE login_name IS NULL');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_login_name ON users(login_name);
        DROP TRIGGER IF EXISTS users_login_immutable;
        CREATE TRIGGER IF NOT EXISTS users_login_update BEFORE UPDATE OF login_name ON users
        WHEN NEW.login_name IS NULL OR length(NEW.login_name) NOT BETWEEN 3 AND 24 OR NEW.login_name GLOB '*[^a-z0-9_]*'
          OR EXISTS(SELECT 1 FROM users WHERE id<>NEW.id AND (username=NEW.login_name OR login_name=NEW.login_name))
        BEGIN SELECT RAISE(ABORT,'Account login is invalid or reserved'); END;
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
      // silent=1: a reaction, an edit, a vote (push:'none') — changes another message, never unread (Telegram).
      if (!messageColumns.has('silent')) db.exec('ALTER TABLE messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0');
      const uploadColumns = new Set(db.prepare('PRAGMA table_info(uploads)').all().map(column => column.name));
      if (!uploadColumns.has('is_encrypted')) db.exec('ALTER TABLE uploads ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0');
      if (!uploadColumns.has('is_video')) db.exec('ALTER TABLE uploads ADD COLUMN is_video INTEGER NOT NULL DEFAULT 0');
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

/** `own`: the account itself (birthday and gender included; others get them only as friends, see userForViewer). */
export function publicUser(row, { db, now = Date.now, own = false } = {}) {
  const platina = db ? platinaState(db, row.id, now()) : { active: false, expiresAt: null };
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    ...(own ? personal(row) : {}),
    avatarColor: row.avatar_color,
    avatarId: row.avatar_id,
    profilePattern: row.profile_pattern ?? null,
    createdAt: row.created_at,
    ...visibleStatus(row, platina),
    ...visibleCosmetics(row, platina),
  };
}

const PRIVACY_DEFAULTS = { allowNewChats: true, showAvatar: true, readReceipts: true, showLastSeen: true, calls: 'everyone' };
export function privacyOf(db, userId) {
  const row = db.prepare('SELECT * FROM user_privacy WHERE user_id=?').get(userId);
  return row ? { allowNewChats: row.allow_new_chats === 1, showAvatar: row.show_avatar === 1, readReceipts: row.read_receipts === 1, showLastSeen: row.show_last_seen !== 0, calls: row.calls || 'everyone' } : { ...PRIVACY_DEFAULTS };
}

/** A serialized user as another account may see it. The owner always sees everything. */
const personal = row => ({ birthday: row.birthday ?? null, gender: row.gender === 'male' || row.gender === 'female' ? row.gender : null });

/** True when either side blocked the other (table from moderation.js, created at start-up). */
export function blockedEitherWay(db, a, b) {
  if (!a || !b || a === b) return false;
  return !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a);
}
const blockedBy = (db, blockerId, blockedId) => !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(blockerId, blockedId);

export function userForViewer(db, user, viewerId) {
  if (!user || user.id === viewerId) return user;
  const { birthday: _birthday, gender: _gender, ...rest } = user;
  // Someone this account blocked sees no avatar or banner either (like an avatar hidden by privacy).
  const hideMedia = !privacyOf(db, user.id).showAvatar || (viewerId && blockedBy(db, user.id, viewerId));
  const visible = hideMedia ? { ...rest, avatarId: null, avatarVideoId: null, bannerId: null, bannerKind: null } : rest;
  // Birthday and gender (birthday reminders, the festive ring) are shown to friends only.
  const friend = viewerId && db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(user.id, viewerId);
  return friend ? { ...visible, ...personal(db.prepare('SELECT birthday, gender FROM users WHERE id=?').get(user.id) || {}) } : visible;
}

/** Settings that only Platina may switch off; without an active Platina they count as on. */
export const PLATINA_PRIVACY = Object.freeze(['showLastSeen', 'readReceipts']);
export function effectivePrivacy(db, userId, time = Date.now()) {
  const stored = privacyOf(db, userId);
  if (platinaState(db, userId, time).active) return stored;
  const effective = { ...stored };
  for (const key of PLATINA_PRIVACY) effective[key] = true;
  return effective;
}

/** "Online / last seen" is mutual: whoever hides it (Platina) does not see it either; a block hides it both ways. */
export function presenceVisible(db, a, b, time = Date.now()) {
  if (blockedEitherWay(db, a, b)) return false;
  return effectivePrivacy(db, a, time).showLastSeen && effectivePrivacy(db, b, time).showLastSeen;
}

/** Read receipts are mutual: hidden if either side (with Platina) turned them off or blocked the other. */
export function receiptsVisible(db, a, b, time = Date.now()) {
  if (blockedEitherWay(db, a, b)) return false;
  return effectivePrivacy(db, a, time).readReceipts && effectivePrivacy(db, b, time).readReceipts;
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
  // Capped at 9 999 (the badge shows «9999+» anyway): a full count made every message slower as the
  // receiver's unread pile grew (load test F5: 110 ms at 100 000 unread). Silent rows (reactions,
  // edits, votes — the sender asked for no push) change another message and are not unread.
  const unread = db.prepare('SELECT COUNT(*) AS count FROM (SELECT 1 FROM messages WHERE chat_id=? AND sender_id != ? AND id>? AND silent=0 LIMIT 9999)').get(chatId, userId, self.last_read_message_id);
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
