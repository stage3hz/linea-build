PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  login_name TEXT NOT NULL UNIQUE,
  username_change_used INTEGER NOT NULL DEFAULT 0 CHECK(username_change_used IN (0,1)),
  status_emoji TEXT,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  confirmation_hash TEXT,
  recovery_hash TEXT,
  credential_version INTEGER NOT NULL DEFAULT 0,
  bio TEXT NOT NULL DEFAULT '',
  avatar_color TEXT NOT NULL DEFAULT '#6C5CE7',
  avatar_id TEXT,
  created_at TEXT NOT NULL
);

-- Only a trusted server administrator can write grants in this version.
-- There is no client-facing purchase, grant or entitlement-update endpoint.
CREATE TABLE IF NOT EXISTS platina_entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source = 'admin'),
  granted_at INTEGER NOT NULL,
  -- NULL is an explicit permanent administrator grant, not an absent grant.
  expires_at INTEGER CHECK((expires_at IS NULL AND source = 'admin') OR expires_at > granted_at),
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS platina_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
  expires_at INTEGER,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS platina_audit_user ON platina_audit(user_id,created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  id TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT 'Неизвестное устройство',
  last_active_at TEXT NOT NULL DEFAULT '',
  -- F6 «Активные сеансы»: what the app reported at sign-in (model, OS, app build, platform) and
  -- the address the request came from (text only, never geolocated).
  platform TEXT,
  device_model TEXT,
  os_version TEXT,
  app_version TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS recovery_attempts (
  name_key TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL CHECK(attempts >= 0 AND attempts <= 3),
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  epoch TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recovery_attempts_cleanup ON recovery_attempts(updated_at);
CREATE TABLE IF NOT EXISTS recovery_grants (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT 'Неизвестное устройство'
);
CREATE INDEX IF NOT EXISTS recovery_grants_expiry ON recovery_grants(expires_at);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user ON chat_members(user_id, chat_id);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  is_image INTEGER NOT NULL DEFAULT 0,
  is_encrypted INTEGER NOT NULL DEFAULT 0,
  attached_message_id INTEGER UNIQUE REFERENCES messages(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  attachment_id TEXT UNIQUE REFERENCES uploads(id),
  encrypted_json TEXT,
  silent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS messages_chat_id ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS e2ee_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  device_name TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  registration_id INTEGER NOT NULL,
  signed_prekey_id INTEGER NOT NULL,
  signed_prekey_public TEXT NOT NULL,
  signed_prekey_signature TEXT NOT NULL,
  kyber_prekey_id INTEGER NOT NULL,
  kyber_prekey_public TEXT NOT NULL,
  kyber_prekey_signature TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS e2ee_devices_user ON e2ee_devices(user_id,active);
CREATE INDEX IF NOT EXISTS e2ee_devices_session ON e2ee_devices(session_id);

CREATE TABLE IF NOT EXISTS e2ee_prekeys (
  device_id TEXT NOT NULL REFERENCES e2ee_devices(id) ON DELETE CASCADE,
  prekey_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (device_id,prekey_id)
);
CREATE INDEX IF NOT EXISTS e2ee_prekeys_available ON e2ee_prekeys(device_id,consumed_at,prekey_id);

CREATE TABLE IF NOT EXISTS e2ee_message_attachments (
  upload_id TEXT PRIMARY KEY REFERENCES uploads(id),
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS e2ee_attachments_message ON e2ee_message_attachments(message_id);

-- F4 «Отправить позже»: the same end-to-end encrypted envelopes a message is sent with, kept until
-- deliver_at (ms since the epoch) and then moved into `messages` unchanged. The server never sees
-- the text. push: 'message' or 'silent' (no sound on the peer's phone). status 'failed' (+ failure
-- code, e.g. E2EE_DEVICES_CHANGED) when the peer's devices changed meanwhile: the sender's app
-- re-encrypts and sends when it is online.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  encrypted_json TEXT NOT NULL,
  push TEXT NOT NULL DEFAULT 'message' CHECK(push IN ('message','silent')),
  deliver_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','failed')),
  failure TEXT,
  created_at TEXT NOT NULL,
  -- ms when the row became «не удалось»: failed rows are purged 30 days after it (and capped per owner).
  failed_at INTEGER,
  UNIQUE(owner_id, client_id)
);
CREATE INDEX IF NOT EXISTS scheduled_messages_due ON scheduled_messages(status, deliver_at);
CREATE INDEX IF NOT EXISTS scheduled_messages_owner ON scheduled_messages(owner_id, chat_id);

-- Per-user privacy. Absent row = defaults (everything allowed/visible).
CREATE TABLE IF NOT EXISTS user_privacy (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  allow_new_chats INTEGER NOT NULL DEFAULT 1 CHECK(allow_new_chats IN (0,1)),
  show_avatar INTEGER NOT NULL DEFAULT 1 CHECK(show_avatar IN (0,1)),
  read_receipts INTEGER NOT NULL DEFAULT 1 CHECK(read_receipts IN (0,1)),
  show_last_seen INTEGER NOT NULL DEFAULT 1 CHECK(show_last_seen IN (0,1)),
  updated_at TEXT NOT NULL
);

-- «Время захода» exceptions, as in Telegram: «Всегда показывать» (allow) and «Никогда не показывать»
-- (deny). A person is in one list at most; which list applies depends on the mode (user_privacy.last_seen).
CREATE TABLE IF NOT EXISTS last_seen_rules (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule TEXT NOT NULL CHECK(rule IN ('allow','deny')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, user_id),
  CHECK(owner_id <> user_id)
);

-- Friends list. New friendships are mutual (two rows, made when a request is accepted);
-- older one-way rows stay as they were.
CREATE TABLE IF NOT EXISTS contacts (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, contact_id),
  CHECK(owner_id <> contact_id)
);

-- Friend requests: a friend is added only when the other person accepts (as in Discord).
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(from_id, to_id),
  CHECK(from_id <> to_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests(to_id, created_at);

-- Per-user chat list settings: pinned chats, archive, mute. Never visible to the peer.
-- muted_until (F2, Telegram «Выкл. звук на время»): ms since the epoch; NULL = sound on, 0 = forever,
-- otherwise sound returns by itself once the clock passes it (compared on read, no sweep). The older
-- boolean `muted` is kept in step (1 whenever muted_until is set) for readers that predate it.
CREATE TABLE IF NOT EXISTS chat_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  pinned_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1)),
  muted_until INTEGER,
  PRIMARY KEY(user_id, chat_id)
);

-- When a member's read pointer advanced (for "прочитано сегодня в 18:36" on own messages).
-- Kept for 7 days; only the time, never message content.
CREATE TABLE IF NOT EXISTS read_marks (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id, message_id)
);

-- Profile posts and stories (photos/videos on the profile, seen by friends). A story expires after 24 h.
CREATE TABLE IF NOT EXISTS profile_posts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('post','story')),
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS profile_posts_owner ON profile_posts(owner_id, kind, created_at);
-- Expired stories are swept by expires_at (posts.js purgeExpiredStories); posts (NULL) stay out of the index.
CREATE INDEX IF NOT EXISTS profile_posts_expires ON profile_posts(expires_at) WHERE expires_at IS NOT NULL;

-- Who watched a story and when (Telegram «Просмотры»): one row a viewer, shown to the owner only.
CREATE TABLE IF NOT EXISTS story_views (
  story_id TEXT NOT NULL REFERENCES profile_posts(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY(story_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS story_views_story ON story_views(story_id, viewed_at);

-- Gifts friends send each other, shown on the recipient's profile («Подарки»). The recipient may hide one.
CREATE TABLE IF NOT EXISTS profile_gifts (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS profile_gifts_recipient ON profile_gifts(recipient_id, created_ms);
CREATE INDEX IF NOT EXISTS profile_gifts_sender ON profile_gifts(sender_id, created_ms);
