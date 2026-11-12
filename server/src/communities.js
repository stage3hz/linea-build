// Communities: game servers (Discord-like: text + voice channels, roles) and blog channels
// (Telegram-like: owners post, subscribers read). By the owner's decision these are NOT
// end-to-end encrypted: the server stores channel text. TLS and authentication still apply,
// and private conversations keep their E2EE. Access is enforced here for every route.
import { randomBytes, randomUUID } from 'node:crypto';
import { boundedText, fail, objectBody, publicName } from './security.js';
import { createRepeatGuard } from './repeatguard.js';

export const PERM = Object.freeze({
  ADMIN: 1, MANAGE_COMMUNITY: 2, MANAGE_CHANNELS: 4, MANAGE_ROLES: 8, INVITE: 16,
  SEND: 32, VOICE: 64, POST: 128, KICK: 256, MANAGE_MESSAGES: 512,
  // Discord-like moderation: ban (keeps the person out), and in voice: server mute / server deafen.
  BAN: 1024, MUTE_MEMBERS: 2048, DEAFEN_MEMBERS: 4096,
});
const ALL = Object.values(PERM).reduce((sum, bit) => sum | bit, 0);
const DEFAULT_EVERYONE = { server: PERM.INVITE | PERM.SEND | PERM.VOICE, blog: PERM.INVITE };
export const VOICE_LIMIT = 12;
/** What a standard channel is about (chosen at creation, editable). */
export const CHANNEL_CATEGORIES = Object.freeze(['blog', 'news', 'music', 'tech', 'humor', 'education', 'sport', 'games', 'art', 'other']);
const MAX_MEMBERS = 50_000, MAX_CHANNELS = 60, MAX_ROLES = 30, MAX_OWNED = 20;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export const COMMUNITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('server','blog')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar_id TEXT,
  category TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_roles (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8A9BB8',
  position INTEGER NOT NULL DEFAULT 0,
  perms INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1))
);
CREATE INDEX IF NOT EXISTS community_roles_community ON community_roles(community_id);
CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1)),
  PRIMARY KEY(community_id, user_id)
);
CREATE INDEX IF NOT EXISTS community_members_user ON community_members(user_id);
CREATE TABLE IF NOT EXISTS community_member_roles (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES community_roles(id) ON DELETE CASCADE,
  PRIMARY KEY(community_id, user_id, role_id)
);
CREATE TABLE IF NOT EXISTS community_channels (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS community_channels_community ON community_channels(community_id);
-- Roles allowed to see a channel. No rows = everyone in the community.
CREATE TABLE IF NOT EXISTS community_channel_roles (
  channel_id TEXT NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES community_roles(id) ON DELETE CASCADE,
  PRIMARY KEY(channel_id, role_id)
);
CREATE TABLE IF NOT EXISTS community_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL DEFAULT '',
  attachment_id TEXT,
  reply_to INTEGER,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  -- Idempotency key chosen by the sending device: the same (sender, key) again returns this row.
  client_key TEXT
);
CREATE INDEX IF NOT EXISTS community_messages_channel ON community_messages(channel_id, id);
CREATE TABLE IF NOT EXISTS community_bans (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(community_id, user_id)
);
-- Server mute / deafen live on the member, not on the voice session (as in Discord): they stay
-- after leaving and rejoining voice until a moderator lifts them.
CREATE TABLE IF NOT EXISTS community_voice_moderation (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,
  deafened INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(community_id, user_id)
);
CREATE TABLE IF NOT EXISTS community_reactions (
  message_id INTEGER NOT NULL REFERENCES community_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
-- What each person has read, per text channel (no row: the older per-community mark).
CREATE TABLE IF NOT EXISTS community_channel_reads (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, channel_id)
);
-- @mentions and replies: one row per person a message points at (for the «@» counter).
CREATE TABLE IF NOT EXISTS community_mentions (
  message_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id)
);
CREATE INDEX IF NOT EXISTS community_mentions_user ON community_mentions(user_id, channel_id, message_id);
CREATE TABLE IF NOT EXISTS community_invites (
  code TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS community_invites_community ON community_invites(community_id);
`;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function inviteCode() { return Array.from(randomBytes(10), byte => ALPHABET[byte % ALPHABET.length]).join(''); }
export const isInviteCode = value => typeof value === 'string' && /^[A-Za-z0-9]{6,16}$/.test(value);

/** Idempotency key of a channel send (mobile outbox): what the device may choose. */
const CLIENT_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

export function installCommunityRoutes({ app, db, authOptions, publicUser, timestamp, now, emitUser, limiter, voice, isOnline = () => true }) {
  const repeats = createRepeatGuard(now);
  // Idempotent migration (databases made before client keys existed): the column, then the uniqueness
  // per (sender, key). Rows without a key stay out of the index.
  if (!db.prepare('PRAGMA table_info(community_messages)').all().some(column => column.name === 'client_key')) db.exec('ALTER TABLE community_messages ADD COLUMN client_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS community_messages_client_key ON community_messages(sender_id, client_key) WHERE client_key IS NOT NULL');
  const community = id => {
    if (typeof id !== 'string' || !uuid.test(id)) fail(404, 'Сообщество не найдено.');
    const row = db.prepare('SELECT * FROM communities WHERE id=?').get(id);
    if (!row) fail(404, 'Сообщество не найдено.');
    return row;
  };
  const member = (communityId, userId) => db.prepare('SELECT * FROM community_members WHERE community_id=? AND user_id=?').get(communityId, userId);
  const requireMember = (communityId, userId) => { const row = member(communityId, userId); if (!row) fail(404, 'Сообщество не найдено.'); return row; };
  const roleIds = (communityId, userId) => db.prepare('SELECT role_id FROM community_member_roles WHERE community_id=? AND user_id=?').all(communityId, userId).map(row => row.role_id);
  const defaultRole = communityId => db.prepare('SELECT * FROM community_roles WHERE community_id=? AND is_default=1').get(communityId);
  const perms = (row, userId) => {
    if (row.owner_id === userId) return ALL;
    if (!member(row.id, userId)) return 0;
    let value = defaultRole(row.id)?.perms || 0;
    for (const role of db.prepare('SELECT r.perms FROM community_member_roles m JOIN community_roles r ON r.id=m.role_id WHERE m.community_id=? AND m.user_id=?').all(row.id, userId)) value |= role.perms;
    if (value & PERM.ADMIN) return ALL;
    // A closed community keeps its promise «only a link from the owner lets people in»: the
    // invite right belongs to the owner and those who manage the community (as the setting says),
    // whatever the roles say — managers get it, everyone else loses it.
    if (row.closed === 1) value = value & PERM.MANAGE_COMMUNITY ? value | PERM.INVITE : value & ~PERM.INVITE;
    return value;
  };
  const need = (row, userId, bit, message = 'Недостаточно прав.') => { requireMember(row.id, userId); if (!(perms(row, userId) & bit)) fail(403, message, { code: 'FORBIDDEN' }); };
  // One viewer's channel visibility: their rights and roles are looked up once, then asked per channel.
  const visibilityOf = (row, userId) => {
    const value = perms(row, userId);
    if (!member(row.id, userId) && row.owner_id !== userId) return () => false;
    if (value & PERM.ADMIN || value & PERM.MANAGE_CHANNELS) return () => true;
    let mine = null;
    return channel => {
      const allowed = db.prepare('SELECT role_id FROM community_channel_roles WHERE channel_id=?').all(channel.id).map(item => item.role_id);
      if (!allowed.length) return true;
      mine ??= new Set(roleIds(row.id, userId));
      return allowed.some(id => mine.has(id));
    };
  };
  const canSee = (row, channel, userId) => visibilityOf(row, userId)(channel);
  const channel = (row, id) => {
    if (typeof id !== 'string' || !uuid.test(id)) fail(404, 'Канал не найден.');
    const item = db.prepare('SELECT * FROM community_channels WHERE id=? AND community_id=?').get(id, row.id);
    if (!item) fail(404, 'Канал не найден.');
    return item;
  };
  const memberCount = id => db.prepare('SELECT COUNT(*) AS n FROM community_members WHERE community_id=?').get(id).n;
  const publicRole = role => ({ id: role.id, name: role.name, color: role.color, position: role.position, perms: role.perms, isDefault: role.is_default === 1 });
  // Unread and @mention counters (own messages never count). Capped so a huge backlog stays cheap.
  const COUNT_CAP = 9999;
  const lastRead = (channelId, communityId, userId) => {
    const own = db.prepare('SELECT last_read_id FROM community_channel_reads WHERE user_id=? AND channel_id=?').get(userId, channelId);
    if (own) return own.last_read_id;
    return db.prepare('SELECT last_read_id FROM community_members WHERE community_id=? AND user_id=?').get(communityId, userId)?.last_read_id || 0;
  };
  const counters = (item, userId) => {
    if (item.kind !== 'text') return { unread: 0, mentions: 0 };
    const after = lastRead(item.id, item.community_id, userId);
    return {
      unread: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM community_messages WHERE channel_id=? AND id>? AND sender_id<>? LIMIT ${COUNT_CAP})`).get(item.id, after, userId).n,
      mentions: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM community_mentions WHERE user_id=? AND channel_id=? AND message_id>? LIMIT ${COUNT_CAP})`).get(userId, item.id, after).n,
    };
  };
  const totals = (row, userId, sees = visibilityOf(row, userId)) => {
    let unread = 0, mentions = 0;
    for (const item of db.prepare("SELECT * FROM community_channels WHERE community_id=? AND kind='text'").all(row.id)) {
      if (!sees(item)) continue;
      const c = counters(item, userId); unread += c.unread; mentions += c.mentions;
    }
    return { unreadCount: Math.min(unread, COUNT_CAP), mentionCount: Math.min(mentions, COUNT_CAP) };
  };
  /** People a message points at: @username of members who can see the channel, and the author of the message it answers. */
  const MENTION = /(^|[^a-z0-9_@])@([a-z0-9_]{3,24})(?![a-z0-9_])/gi;
  const mentionTargets = (row, item, senderId, text, replyTo) => {
    const ids = new Set();
    const names = new Set(); for (const m of String(text).matchAll(MENTION)) { names.add(m[2].toLowerCase()); if (names.size >= 20) break; }
    for (const name of names) { const user = db.prepare('SELECT id FROM users WHERE username=?').get(name); if (user) ids.add(user.id); }
    if (replyTo) { const parent = db.prepare('SELECT sender_id FROM community_messages WHERE id=?').get(replyTo); if (parent) ids.add(parent.sender_id); }
    ids.delete(senderId);
    return [...ids].filter(id => member(row.id, id) && canSee(row, item, id) && !db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(id, senderId));
  };
  const saveMentions = (messageId, item, ids) => {
    db.prepare('DELETE FROM community_mentions WHERE message_id=?').run(messageId);
    for (const id of ids) db.prepare('INSERT OR IGNORE INTO community_mentions(message_id,channel_id,user_id) VALUES(?,?,?)').run(messageId, item.id, id);
  };
  const publicChannel = (item, viewer) => ({
    id: item.id, kind: item.kind, name: item.name, topic: item.topic, category: item.category, position: item.position,
    roleIds: db.prepare('SELECT role_id FROM community_channel_roles WHERE channel_id=?').all(item.id).map(row => row.role_id),
    ...(item.kind === 'voice' ? { voice: voice.members(item.id) } : {}),
    lastMessageId: db.prepare('SELECT MAX(id) AS id FROM community_messages WHERE channel_id=?').get(item.id).id || 0,
    ...(viewer ? counters(item, viewer) : {}),
  });
  // The newest message of every channel, newest first. The «last message» of a community is the
  // first of these in a channel the viewer may see: a role-restricted channel's text never reaches
  // members outside those roles, in the list, in the detail or in the pushed «community» event.
  const latestPerChannel = communityId => db.prepare('SELECT m.* FROM community_messages m WHERE m.id IN (SELECT MAX(id) FROM community_messages WHERE channel_id IN (SELECT id FROM community_channels WHERE community_id=?) GROUP BY channel_id) ORDER BY m.id DESC').all(communityId);
  const lastVisible = (sees, latest, cache) => {
    const last = latest.find(message => sees({ id: message.channel_id }));
    if (!last) return null;
    if (!cache) return publicMessage(last);
    if (!cache.has(last.id)) cache.set(last.id, publicMessage(last));
    return cache.get(last.id);
  };
  // `shared`: the parts that are the same for every member (count, newest message per channel), computed once by refresh().
  const summary = (row, viewer, shared = null) => {
    const mine = member(row.id, viewer);
    const sees = visibilityOf(row, viewer);
    return {
      id: row.id, kind: row.kind, name: row.name, description: row.description, avatarId: row.avatar_id, ownerId: row.owner_id, category: row.category || null, closed: row.closed === 1,
      createdAt: row.created_at, memberCount: shared ? shared.count : memberCount(row.id), isMember: !!mine, perms: perms(row, viewer),
      lastMessage: mine || row.owner_id === viewer ? lastVisible(sees, shared ? shared.latest : latestPerChannel(row.id), shared?.public) : null, muted: mine?.muted === 1,
      ...(mine ? totals(row, viewer, sees) : { unreadCount: 0, mentionCount: 0 }),
    };
  };
  const detail = (row, viewer) => ({
    ...summary(row, viewer),
    roles: db.prepare('SELECT * FROM community_roles WHERE community_id=? ORDER BY position DESC, name').all(row.id).map(publicRole),
    myRoleIds: roleIds(row.id, viewer),
    channels: db.prepare('SELECT * FROM community_channels WHERE community_id=? ORDER BY kind DESC, position, created_at').all(row.id).filter(item => canSee(row, item, viewer)).map(item => publicChannel(item, viewer)),
  });
  const publicMessage = message => ({
    id: message.id, channelId: message.channel_id, senderId: message.sender_id, text: message.text,
    attachment: message.attachment_id ? (row => row ? { id: row.id, name: row.name, mimeType: row.mime_type, size: row.size } : null)(db.prepare('SELECT * FROM uploads WHERE id=?').get(message.attachment_id)) : null,
    replyTo: message.reply_to, createdAt: message.created_at, editedAt: message.edited_at,
    reactions: reactionsOf(message.id),
  });
  // Discord-style reactions: each emoji with its count and up to 20 user ids (to mark «mine»).
  const reactionsOf = messageId => {
    const groups = new Map();
    for (const r of db.prepare('SELECT emoji, user_id FROM community_reactions WHERE message_id=? ORDER BY created_at').all(messageId)) {
      const g = groups.get(r.emoji) || { emoji: r.emoji, count: 0, userIds: [] };
      g.count++; if (g.userIds.length < 20) g.userIds.push(r.user_id); groups.set(r.emoji, g);
    }
    return [...groups.values()];
  };
  const authorsOf = messages => {
    const ids = [...new Set(messages.map(item => item.senderId))];
    return ids.map(id => db.prepare('SELECT * FROM users WHERE id=?').get(id)).filter(Boolean).map(publicUser);
  };
  /** Pushes an event to every member who can see the channel (or the whole community). */
  const emitCommunity = (row, payload, channelItem = null) => {
    for (const { user_id } of db.prepare('SELECT user_id FROM community_members WHERE community_id=?').all(row.id)) {
      // Offline members get nothing pushed: skip the visibility check for them (it ran ~5 queries each).
      if (!isOnline(user_id)) continue;
      if (channelItem && !canSee(row, channelItem, user_id)) continue;
      emitUser(user_id, payload);
    }
  };
  // Every member who is online gets their fresh summary. It used to be built for every member, each
  // with its own COUNT(*): joining a 20 000-member community froze the server for 21 s (load test F2).
  // Offline members read it when they open the app; the shared parts are computed once.
  const refresh = row => {
    const online = db.prepare('SELECT user_id FROM community_members WHERE community_id=?').all(row.id).map(item => item.user_id).filter(id => isOnline(id));
    if (!online.length) return;
    const shared = { count: memberCount(row.id), latest: latestPerChannel(row.id), public: new Map() };
    for (const userId of online) emitUser(userId, { type: 'community', community: summary(row, userId, shared) });
  };
  const join = (row, userId) => {
    if (member(row.id, userId)) return false;
    if (db.prepare('SELECT 1 FROM community_bans WHERE community_id=? AND user_id=?').get(row.id, userId)) fail(403, 'Тебя заблокировали в этом сообществе.', { code: 'BANNED' });
    if (memberCount(row.id) >= MAX_MEMBERS) fail(403, 'В сообществе максимум участников.');
    // A newcomer starts with everything read: the history is there, but not as a pile of «unread».
    const latest = db.prepare('SELECT MAX(m.id) AS id FROM community_messages m JOIN community_channels c ON c.id=m.channel_id WHERE c.community_id=?').get(row.id).id || 0;
    db.prepare('INSERT INTO community_members(community_id,user_id,joined_at,last_read_id) VALUES(?,?,?,?)').run(row.id, userId, timestamp(), latest);
    db.prepare('DELETE FROM community_channel_reads WHERE user_id=? AND channel_id IN (SELECT id FROM community_channels WHERE community_id=?)').run(userId, row.id);
    return true;
  };
  const text = (value, label, min, max) => boundedText(value, label, min, max);
  const uploadOwned = (id, userId, imageOnly) => {
    if (id === null) return null;
    if (typeof id !== 'string') fail(400, 'Некорректный файл.');
    const upload = db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=? AND is_encrypted=0').get(id, userId);
    if (!upload) fail(404, 'Файл не найден.');
    if (imageOnly && !upload.is_image) fail(400, 'Нужна картинка.');
    return upload.id;
  };

  app.get('/communities', authOptions, async request => {
    const viewer = request.auth.user_id;
    const rows = db.prepare('SELECT c.* FROM communities c JOIN community_members m ON m.community_id=c.id WHERE m.user_id=? ORDER BY m.joined_at DESC').all(viewer);
    return { communities: rows.map(row => summary(row, viewer)) };
  });

  app.post('/communities', authOptions, async request => {
    const viewer = request.auth.user_id;
    const body = objectBody(request.body, ['kind', 'name', 'description', 'avatarId', 'category']);
    if (body.kind !== 'server' && body.kind !== 'blog') fail(400, 'Выбери тип: игровой или стандартный.');
    const category = body.kind === 'blog' ? (body.category === undefined ? 'blog' : body.category) : null;
    if (category !== null && !CHANNEL_CATEGORIES.includes(category)) fail(400, 'Неизвестное содержание канала.');
    if (!limiter.allow(`community-create:${viewer}`, 5, 60 * 60_000)) fail(429, 'Слишком много новых сообществ. Попробуй позже.');
    if (db.prepare('SELECT COUNT(*) AS n FROM communities WHERE owner_id=?').get(viewer).n >= MAX_OWNED) fail(403, 'Можно создать не больше 20 сообществ.');
    const name = publicName(body.name, 'Название', 1, 60);
    const description = body.description === undefined ? '' : text(body.description, 'Описание', 0, 500);
    const avatarId = body.avatarId === undefined ? null : uploadOwned(body.avatarId, viewer, true);
    const id = randomUUID(), time = timestamp();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO communities(id,kind,name,description,avatar_id,category,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, body.kind, name, description, avatarId, category, viewer, time);
      db.prepare('INSERT INTO community_roles(id,community_id,name,color,position,perms,is_default) VALUES(?,?,?,?,?,?,1)').run(randomUUID(), id, body.kind === 'blog' ? 'Подписчики' : 'Участники', '#8A9BB8', 0, DEFAULT_EVERYONE[body.kind]);
      db.prepare('INSERT INTO community_members(community_id,user_id,joined_at) VALUES(?,?,?)').run(id, viewer, time);
      const add = (kind, name, category, position) => db.prepare('INSERT INTO community_channels(id,community_id,kind,name,category,position,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, kind, name, category, position, time);
      if (body.kind === 'server') {
        db.prepare('INSERT INTO community_roles(id,community_id,name,color,position,perms,is_default) VALUES(?,?,?,?,?,?,0)').run(randomUUID(), id, 'Модератор', '#3FA9F5', 10, PERM.MANAGE_MESSAGES | PERM.KICK | PERM.BAN | PERM.MUTE_MEMBERS | PERM.DEAFEN_MEMBERS | PERM.INVITE | PERM.SEND | PERM.VOICE);
        add('text', 'общий', 'Текстовые каналы', 0); add('text', 'новости', 'Текстовые каналы', 1);
        add('voice', 'Общий', 'Голосовые каналы', 0); add('voice', 'Игра', 'Голосовые каналы', 1);
      } else add('text', 'Публикации', '', 0);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { community: detail(community(id), viewer) };
  });

  app.get('/communities/:id', authOptions, async request => {
    const row = community(request.params.id); requireMember(row.id, request.auth.user_id);
    return { community: detail(row, request.auth.user_id) };
  });

  app.patch('/communities/:id', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_COMMUNITY);
    const body = objectBody(request.body, ['name', 'description', 'avatarId', 'muted', 'category', 'closed']);
    if (body.closed !== undefined && typeof body.closed !== 'boolean') fail(400, 'Некорректная настройка доступа.');
    if (body.category !== undefined && (row.kind !== 'blog' || !CHANNEL_CATEGORIES.includes(body.category))) fail(400, 'Неизвестное содержание канала.');
    if (body.muted !== undefined) {
      if (typeof body.muted !== 'boolean') fail(400, 'Некорректная настройка звука.');
    }
    const name = body.name === undefined ? row.name : publicName(body.name, 'Название', 1, 60);
    const description = body.description === undefined ? row.description : text(body.description, 'Описание', 0, 500);
    const avatarId = body.avatarId === undefined ? row.avatar_id : uploadOwned(body.avatarId, viewer, true);
    db.prepare('UPDATE communities SET name=?,description=?,avatar_id=?,category=?,closed=? WHERE id=?').run(name, description, avatarId, body.category === undefined ? row.category : body.category, body.closed === undefined ? (row.closed ? 1 : 0) : (body.closed ? 1 : 0), row.id);
    const next = community(row.id); refresh(next);
    return { community: detail(next, viewer) };
  });

  // Per-member notification setting: any member may mute a community for themselves.
  app.patch('/communities/:id/me', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id); requireMember(row.id, viewer);
    const body = objectBody(request.body, ['muted', 'lastReadId']);
    if (body.muted !== undefined) { if (typeof body.muted !== 'boolean') fail(400, 'Некорректная настройка звука.'); db.prepare('UPDATE community_members SET muted=? WHERE community_id=? AND user_id=?').run(body.muted ? 1 : 0, row.id, viewer); }
    if (body.lastReadId !== undefined) { if (!Number.isSafeInteger(body.lastReadId) || body.lastReadId < 0) fail(400, 'Некорректное сообщение.'); db.prepare('UPDATE community_members SET last_read_id=MAX(last_read_id,?) WHERE community_id=? AND user_id=?').run(body.lastReadId, row.id, viewer); }
    return { community: summary(row, viewer) };
  });

  app.delete('/communities/:id', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    if (row.owner_id !== viewer) fail(403, 'Удалить сообщество может только владелец.');
    const members = db.prepare('SELECT user_id FROM community_members WHERE community_id=?').all(row.id).map(item => item.user_id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM community_reactions WHERE message_id IN (SELECT m.id FROM community_messages m JOIN community_channels c ON c.id=m.channel_id WHERE c.community_id=?)').run(row.id);
      db.prepare('DELETE FROM community_messages WHERE channel_id IN (SELECT id FROM community_channels WHERE community_id=?)').run(row.id);
      db.prepare('DELETE FROM community_mentions WHERE channel_id IN (SELECT id FROM community_channels WHERE community_id=?)').run(row.id);
      db.prepare('DELETE FROM community_channel_reads WHERE channel_id IN (SELECT id FROM community_channels WHERE community_id=?)').run(row.id);
      db.prepare('DELETE FROM communities WHERE id=?').run(row.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    for (const userId of members) emitUser(userId, { type: 'community.removed', communityId: row.id });
    return { ok: true };
  });

  app.post('/communities/:id/leave', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id); requireMember(row.id, viewer);
    if (row.owner_id === viewer) fail(400, 'Владелец не может выйти — передай права или удали сообщество.');
    db.prepare('DELETE FROM community_member_roles WHERE community_id=? AND user_id=?').run(row.id, viewer);
    db.prepare('DELETE FROM community_members WHERE community_id=? AND user_id=?').run(row.id, viewer);
    voice.kick(viewer, row.id);
    emitUser(viewer, { type: 'community.removed', communityId: row.id }); refresh(row);
    return { ok: true };
  });

  // Members with their roles (paged by display name).
  app.get('/communities/:id/members', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id); requireMember(row.id, viewer);
    const rows = db.prepare('SELECT u.*, m.joined_at FROM community_members m JOIN users u ON u.id=m.user_id WHERE m.community_id=? ORDER BY u.display_name COLLATE NOCASE LIMIT 500').all(row.id);
    return { members: rows.map(user => ({ user: publicUser(user), roleIds: roleIds(row.id, user.id), owner: user.id === row.owner_id, joinedAt: user.joined_at })) };
  });

  // Role hierarchy as in Discord: only the owner, or someone whose highest role is above the
  // target's highest role, can kick or ban them.
  const topPosition = (row, userId) => userId === row.owner_id ? Infinity : (db.prepare('SELECT MAX(r.position) AS p FROM community_member_roles mr JOIN community_roles r ON r.id=mr.role_id WHERE mr.community_id=? AND mr.user_id=?').get(row.id, userId)?.p ?? 0);
  const outranks = (row, viewer, target) => viewer === row.owner_id || topPosition(row, viewer) > topPosition(row, target);
  // The same hierarchy for roles themselves: whoever is not the owner hands out, edits and deletes
  // only roles that sit below their own highest role.
  const manageable = (row, viewer, role) => viewer === row.owner_id || role.position < topPosition(row, viewer);
  const removeMember = (row, target) => {
    db.prepare('DELETE FROM community_member_roles WHERE community_id=? AND user_id=?').run(row.id, target);
    db.prepare('DELETE FROM community_members WHERE community_id=? AND user_id=?').run(row.id, target);
    voice.kick(target, row.id);
    emitUser(target, { type: 'community.removed', communityId: row.id }); refresh(row);
  };
  app.delete('/communities/:id/members/:userId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.KICK);
    const target = request.params.userId;
    if (target === row.owner_id || target === viewer) fail(400, 'Этого участника нельзя исключить.');
    if (!member(row.id, target)) fail(404, 'Участник не найден.');
    if (!outranks(row, viewer, target)) fail(403, 'Нельзя исключить участника с такой же или более высокой ролью.');
    removeMember(row, target);
    return { ok: true };
  });

  app.get('/communities/:id/bans', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.BAN);
    const rows = db.prepare('SELECT u.*, b.reason, b.created_at AS banned_at FROM community_bans b JOIN users u ON u.id=b.user_id WHERE b.community_id=? ORDER BY b.created_at DESC LIMIT 500').all(row.id);
    return { bans: rows.map(user => ({ user: publicUser(user), reason: user.reason, createdAt: user.banned_at })) };
  });
  app.put('/communities/:id/bans/:userId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.BAN);
    const target = request.params.userId;
    if (target === row.owner_id || target === viewer) fail(400, 'Этого участника нельзя заблокировать.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(target)) fail(404, 'Пользователь не найден.');
    if (member(row.id, target) && !outranks(row, viewer, target)) fail(403, 'Нельзя заблокировать участника с такой же или более высокой ролью.');
    const body = objectBody(request.body ?? {}, ['reason']);
    const reason = body.reason === undefined ? '' : text(body.reason, 'Причина', 0, 200);
    db.prepare('INSERT INTO community_bans(community_id,user_id,banned_by,reason,created_at) VALUES(?,?,?,?,?) ON CONFLICT(community_id,user_id) DO UPDATE SET reason=excluded.reason').run(row.id, target, viewer, reason, timestamp());
    if (member(row.id, target)) removeMember(row, target);
    return { ok: true };
  });
  app.delete('/communities/:id/bans/:userId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.BAN);
    db.prepare('DELETE FROM community_bans WHERE community_id=? AND user_id=?').run(row.id, request.params.userId);
    return { ok: true };
  });

  // Server mute / server deafen (Discord): the moderated person cannot unmute themselves, and other
  // clients also stop playing their audio, so a modified app cannot get around it.
  const serverVoice = (communityId, userId) => {
    const r = communityId ? db.prepare('SELECT muted, deafened FROM community_voice_moderation WHERE community_id=? AND user_id=?').get(communityId, userId) : null;
    return { serverMuted: r?.muted === 1 || r?.deafened === 1, serverDeafened: r?.deafened === 1 };
  };
  app.put('/communities/:id/members/:userId/voice', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    // Membership and rights come first: an outsider learns nothing (404 for the community itself),
    // and an empty body is a bad request, never a free «who is in here and are they muted» probe.
    requireMember(row.id, viewer);
    const target = request.params.userId;
    const body = objectBody(request.body, ['muted', 'deafened']);
    if (body.muted === undefined && body.deafened === undefined) fail(400, 'Укажи muted или deafened.');
    if (body.muted !== undefined && typeof body.muted !== 'boolean') fail(400, 'muted: да или нет.');
    if (body.deafened !== undefined && typeof body.deafened !== 'boolean') fail(400, 'deafened: да или нет.');
    if (body.muted !== undefined) need(row, viewer, PERM.MUTE_MEMBERS);
    if (body.deafened !== undefined) need(row, viewer, PERM.DEAFEN_MEMBERS);
    if (!member(row.id, target) && target !== row.owner_id) fail(404, 'Участник не найден.');
    if (target === row.owner_id && viewer !== row.owner_id) fail(403, 'Владельца нельзя заглушить.');
    const current = serverVoice(row.id, target);
    const muted = body.muted ?? (current.serverMuted && !current.serverDeafened), deafened = body.deafened ?? current.serverDeafened;
    db.prepare('INSERT INTO community_voice_moderation(community_id,user_id,muted,deafened) VALUES(?,?,?,?) ON CONFLICT(community_id,user_id) DO UPDATE SET muted=excluded.muted,deafened=excluded.deafened').run(row.id, target, muted ? 1 : 0, deafened ? 1 : 0);
    voice.moderated(target, row.id);
    return { ok: true, ...serverVoice(row.id, target) };
  });

  app.put('/communities/:id/members/:userId/roles', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_ROLES);
    const target = request.params.userId;
    if (!member(row.id, target)) fail(404, 'Участник не найден.');
    const body = objectBody(request.body, ['roleIds']);
    if (!Array.isArray(body.roleIds) || body.roleIds.length > MAX_ROLES) fail(400, 'Некорректный список ролей.');
    const roles = new Map(db.prepare('SELECT * FROM community_roles WHERE community_id=? AND is_default=0').all(row.id).map(item => [item.id, item]));
    if (!body.roleIds.every(id => roles.has(id))) fail(400, 'Неизвестная роль.');
    // Nobody but the owner escapes the hierarchy: no changing one's own roles, no touching someone
    // ranked the same or higher, only roles below one's own, and the administrator role never.
    const before = new Set(roleIds(row.id, target)), after = new Set(body.roleIds);
    const changed = [...new Set([...before, ...after])].filter(id => before.has(id) !== after.has(id));
    if (row.owner_id !== viewer && changed.length) {
      if (target === viewer) fail(403, 'Свои роли меняет только владелец.');
      if (!outranks(row, viewer, target)) fail(403, 'Нельзя менять роли участника с такой же или более высокой ролью.');
      if (changed.some(id => roles.get(id).perms & PERM.ADMIN)) fail(403, 'Роль администратора выдаёт только владелец.');
      if (changed.some(id => !manageable(row, viewer, roles.get(id)))) fail(403, 'Выдавать и снимать можно только роли ниже своей.');
    }
    db.prepare('DELETE FROM community_member_roles WHERE community_id=? AND user_id=?').run(row.id, target);
    for (const id of new Set(body.roleIds)) db.prepare('INSERT INTO community_member_roles(community_id,user_id,role_id) VALUES(?,?,?)').run(row.id, target, id);
    emitUser(target, { type: 'community', community: summary(row, target) });
    return { roleIds: roleIds(row.id, target) };
  });

  app.post('/communities/:id/roles', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_ROLES);
    const body = objectBody(request.body, ['name', 'color', 'perms']);
    if (db.prepare('SELECT COUNT(*) AS n FROM community_roles WHERE community_id=?').get(row.id).n >= MAX_ROLES) fail(400, 'Слишком много ролей.');
    const owner = row.owner_id === viewer, top = topPosition(row, viewer);
    if (!owner && top <= 0) fail(403, 'Создавать роли может только участник, у которого есть своя роль.');
    const role = roleFields(body, { name: 'Новая роль', color: '#3FA9F5', perms: PERM.SEND | PERM.VOICE }, { owner, allowed: perms(row, viewer), base: 0 });
    const id = randomUUID();
    // The owner's new role goes on top; anyone else's takes the highest free position under their
    // own highest role, so it stays theirs to manage and never shares a position with another role
    // (nor with the base role at 0, which would put it out of everyone's reach).
    const position = owner ? (db.prepare('SELECT MAX(position) AS p FROM community_roles WHERE community_id=?').get(row.id).p || 0) + 1 : freePositionBelow(row, top);
    db.prepare('INSERT INTO community_roles(id,community_id,name,color,position,perms,is_default) VALUES(?,?,?,?,?,?,0)').run(id, row.id, role.name, role.color, position, role.perms);
    return { role: publicRole(db.prepare('SELECT * FROM community_roles WHERE id=?').get(id)) };
  });

  app.patch('/communities/:id/roles/:roleId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_ROLES);
    const current = db.prepare('SELECT * FROM community_roles WHERE id=? AND community_id=?').get(request.params.roleId, row.id);
    if (!current) fail(404, 'Роль не найдена.');
    if (current.perms & PERM.ADMIN && row.owner_id !== viewer) fail(403, 'Роль администратора меняет только владелец.');
    if (!manageable(row, viewer, current)) fail(403, 'Менять можно только роли ниже своей.');
    const role = roleFields(objectBody(request.body, ['name', 'color', 'perms']), { name: current.name, color: current.color, perms: current.perms }, { owner: row.owner_id === viewer, allowed: perms(row, viewer), base: current.perms });
    db.prepare('UPDATE community_roles SET name=?,color=?,perms=? WHERE id=?').run(role.name, role.color, role.perms, current.id);
    refresh(row);
    return { role: publicRole(db.prepare('SELECT * FROM community_roles WHERE id=?').get(current.id)) };
  });

  app.delete('/communities/:id/roles/:roleId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_ROLES);
    const current = db.prepare('SELECT * FROM community_roles WHERE id=? AND community_id=?').get(request.params.roleId, row.id);
    if (!current) fail(404, 'Роль не найдена.');
    if (current.is_default) fail(400, 'Базовую роль удалить нельзя.');
    if (current.perms & PERM.ADMIN && row.owner_id !== viewer) fail(403, 'Роль администратора удаляет только владелец.');
    if (!manageable(row, viewer, current)) fail(403, 'Удалять можно только роли ниже своей.');
    // Deleting the only role that gates a channel opens that channel to everyone: whoever cannot
    // see the channel themselves may not open it this way.
    if (row.owner_id !== viewer) {
      const gated = db.prepare('SELECT c.* FROM community_channels c JOIN community_channel_roles cr ON cr.channel_id=c.id WHERE c.community_id=? GROUP BY c.id HAVING COUNT(*)=1 AND MAX(cr.role_id)=?').all(row.id, current.id);
      if (gated.some(item => !canSee(row, item, viewer))) fail(403, 'Эта роль закрывает канал, который вам не виден.');
    }
    db.prepare('DELETE FROM community_roles WHERE id=?').run(current.id);
    refresh(row);
    return { ok: true };
  });

  /** The highest position in (0, top) no role of this community holds yet. */
  function freePositionBelow(row, top) {
    const taken = new Set(db.prepare('SELECT position FROM community_roles WHERE community_id=?').all(row.id).map(item => item.position));
    for (let position = top - 1; position > 0; position--) if (!taken.has(position)) return position;
    fail(400, 'Под вашей ролью не осталось свободных позиций.');
  }

  // Rights only travel downhill: whoever is not the owner can grant, or take away, just the rights
  // they hold themselves (`allowed`); `base` is what the role had before, so an edit is judged by what changes.
  function roleFields(body, fallback, { owner, allowed, base }) {
    const name = body.name === undefined ? fallback.name : text(body.name, 'Название роли', 1, 32);
    const color = body.color === undefined ? fallback.color : body.color;
    if (typeof color !== 'string' || !COLOR.test(color)) fail(400, 'Цвет роли — в формате #RRGGBB.');
    const value = body.perms === undefined ? fallback.perms : body.perms;
    if (!Number.isSafeInteger(value) || value < 0 || (value & ~ALL)) fail(400, 'Некорректные права роли.');
    if (value & PERM.ADMIN && !owner) fail(403, 'Права администратора выдаёт только владелец.');
    if (!owner && ((value ^ base) & ~allowed)) fail(403, 'Нельзя выдать права, которых нет у тебя самого.');
    return { name, color: color.toUpperCase(), perms: value };
  }

  app.post('/communities/:id/channels', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_CHANNELS);
    if (row.kind !== 'server') fail(400, 'В блоге один канал публикаций.');
    const body = objectBody(request.body, ['kind', 'name', 'topic', 'category', 'roleIds']);
    if (body.kind !== 'text' && body.kind !== 'voice') fail(400, 'Тип канала: текстовый или голосовой.');
    if (db.prepare('SELECT COUNT(*) AS n FROM community_channels WHERE community_id=?').get(row.id).n >= MAX_CHANNELS) fail(400, 'Слишком много каналов.');
    const id = randomUUID();
    const position = (db.prepare('SELECT MAX(position) AS p FROM community_channels WHERE community_id=? AND kind=?').get(row.id, body.kind).p ?? -1) + 1;
    db.prepare('INSERT INTO community_channels(id,community_id,kind,name,topic,category,position,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, row.id, body.kind, text(body.name, 'Название канала', 1, 40), body.topic === undefined ? '' : text(body.topic, 'Тема', 0, 200), body.category === undefined ? (body.kind === 'voice' ? 'Голосовые каналы' : 'Текстовые каналы') : text(body.category, 'Категория', 0, 40), position, timestamp());
    setChannelRoles(row, id, body.roleIds);
    const item = channel(row, id);
    emitCommunity(row, { type: 'community.channels', communityId: row.id }, item);
    return { channel: publicChannel(item, viewer) };
  });

  function setChannelRoles(row, channelId, value) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > MAX_ROLES) fail(400, 'Некорректный список ролей.');
    const valid = new Set(db.prepare('SELECT id FROM community_roles WHERE community_id=?').all(row.id).map(item => item.id));
    if (!value.every(id => valid.has(id))) fail(400, 'Неизвестная роль.');
    db.prepare('DELETE FROM community_channel_roles WHERE channel_id=?').run(channelId);
    for (const id of new Set(value)) db.prepare('INSERT INTO community_channel_roles(channel_id,role_id) VALUES(?,?)').run(channelId, id);
  }

  app.patch('/communities/:id/channels/:channelId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_CHANNELS);
    const item = channel(row, request.params.channelId);
    const body = objectBody(request.body, ['name', 'topic', 'category', 'roleIds']);
    db.prepare('UPDATE community_channels SET name=?,topic=?,category=? WHERE id=?').run(
      body.name === undefined ? item.name : text(body.name, 'Название канала', 1, 40),
      body.topic === undefined ? item.topic : text(body.topic, 'Тема', 0, 200),
      body.category === undefined ? item.category : text(body.category, 'Категория', 0, 40), item.id);
    setChannelRoles(row, item.id, body.roleIds);
    emitCommunity(row, { type: 'community.channels', communityId: row.id });
    return { channel: publicChannel(channel(row, item.id), viewer) };
  });

  app.delete('/communities/:id/channels/:channelId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_CHANNELS);
    const item = channel(row, request.params.channelId);
    if (db.prepare('SELECT COUNT(*) AS n FROM community_channels WHERE community_id=? AND kind=?').get(row.id, 'text').n <= 1 && item.kind === 'text') fail(400, 'Нужен хотя бы один текстовый канал.');
    voice.close(item.id);
    db.prepare('DELETE FROM community_reactions WHERE message_id IN (SELECT id FROM community_messages WHERE channel_id=?)').run(item.id);
    db.prepare('DELETE FROM community_messages WHERE channel_id=?').run(item.id);
    db.prepare('DELETE FROM community_mentions WHERE channel_id=?').run(item.id);
    db.prepare('DELETE FROM community_channel_reads WHERE channel_id=?').run(item.id);
    db.prepare('DELETE FROM community_channels WHERE id=?').run(item.id);
    emitCommunity(row, { type: 'community.channels', communityId: row.id });
    return { ok: true };
  });

  const visibleChannel = (request, { write = false } = {}) => {
    const viewer = request.auth.user_id, row = community(request.params.id); requireMember(row.id, viewer);
    const item = channel(row, request.params.channelId);
    if (!canSee(row, item, viewer)) fail(404, 'Канал не найден.');
    if (write) {
      if (item.kind !== 'text') fail(400, 'Это голосовой канал.');
      need(row, viewer, row.kind === 'blog' ? PERM.POST : PERM.SEND, row.kind === 'blog' ? 'Публиковать могут только авторы канала.' : 'В этом канале нельзя писать.');
    }
    return { row, item, viewer };
  };

  app.get('/communities/:id/channels/:channelId/messages', authOptions, async request => {
    const { item } = visibleChannel(request);
    const before = request.query.before === undefined ? null : Number(request.query.before);
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) fail(400, 'Некорректная страница.');
    const rows = (before ? db.prepare('SELECT * FROM community_messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT 50').all(item.id, before) : db.prepare('SELECT * FROM community_messages WHERE channel_id=? ORDER BY id DESC LIMIT 50').all(item.id)).reverse();
    const messages = rows.map(publicMessage);
    return { messages, users: authorsOf(messages), hasMore: rows.length === 50 };
  });

  // Marks a channel read up to lastReadId; the person's other devices get the new counters.
  app.post('/communities/:id/channels/:channelId/read', authOptions, async request => {
    const { row, item, viewer } = visibleChannel(request);
    const body = objectBody(request.body, ['lastReadId']);
    if (!Number.isSafeInteger(body.lastReadId) || body.lastReadId < 0) fail(400, 'Некорректное сообщение.');
    const latest = db.prepare('SELECT MAX(id) AS id FROM community_messages WHERE channel_id=?').get(item.id).id || 0;
    const mark = Math.min(body.lastReadId, latest);
    const before = lastRead(item.id, row.id, viewer);
    if (mark > before || !db.prepare('SELECT 1 FROM community_channel_reads WHERE user_id=? AND channel_id=?').get(viewer, item.id)) {
      db.prepare('INSERT INTO community_channel_reads(user_id,channel_id,last_read_id) VALUES(?,?,?) ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_id=MAX(last_read_id,excluded.last_read_id)').run(viewer, item.id, Math.max(mark, before));
    }
    const counts = counters(item, viewer), community = summary(row, viewer);
    if (mark > before) emitUser(viewer, { type: 'community.read', communityId: row.id, channelId: item.id, ...counts, community });
    return { ...counts, community };
  });

  app.post('/communities/:id/channels/:channelId/messages', authOptions, async request => {
    const { row, item, viewer } = visibleChannel(request, { write: true });
    const body = objectBody(request.body, ['text', 'attachmentId', 'replyTo', 'clientKey']);
    // Idempotency: a retry of a send whose answer was lost (timeout, reconnect) returns the stored
    // message instead of a second one. Checked before the limiter and the attachment check: the retry
    // is the very same request, and its attachment is already attached to the first row.
    let clientKey = null;
    if (body.clientKey !== undefined && body.clientKey !== null) {
      if (typeof body.clientKey !== 'string' || !CLIENT_KEY.test(body.clientKey)) fail(400, 'Некорректный ключ сообщения.');
      clientKey = body.clientKey;
      const existing = db.prepare('SELECT * FROM community_messages WHERE sender_id=? AND client_key=?').get(viewer, clientKey);
      if (existing) {
        if (existing.channel_id !== item.id) fail(409, 'Этот ключ уже использован для другого сообщения.');
        return { message: publicMessage(existing) };
      }
    }
    if (!limiter.allow(`community-send:${viewer}`, 30, 10_000)) fail(429, 'Слишком часто. Подожди немного.');
    const value = body.text === undefined ? '' : boundedText(body.text, 'Сообщение', 0, 4000, { trim: false });
    // The same text over and over: five in a row, then 10 s, 15 s, 20 s… between copies (repeatguard.js).
    const hold = repeats.wait(viewer, item.id, value);
    if (hold) { const seconds = Math.ceil(hold / 1000); fail(429, `Одинаковое сообщение. Подождите ${seconds} с.`, { code: 'repeat', retryAfterSeconds: seconds }); }
    let attachmentId = null;
    if (body.attachmentId !== undefined && body.attachmentId !== null) {
      if (typeof body.attachmentId !== 'string') fail(400, 'Некорректный файл.');
      // Only a channel upload (one request or chunked): a profile post or an avatar is not posted to a channel.
      const upload = db.prepare("SELECT * FROM uploads WHERE id=? AND owner_id=? AND is_encrypted=0 AND attached_message_id IS NULL AND purpose='channel'").get(body.attachmentId, viewer);
      if (!upload || db.prepare('SELECT 1 FROM community_messages WHERE attachment_id=?').get(upload.id)) fail(404, 'Файл не найден.');
      attachmentId = upload.id;
    }
    if (!value.trim() && !attachmentId) fail(400, 'Пустое сообщение.');
    let replyTo = null;
    if (body.replyTo !== undefined && body.replyTo !== null) {
      if (!Number.isSafeInteger(body.replyTo) || !db.prepare('SELECT 1 FROM community_messages WHERE id=? AND channel_id=?').get(body.replyTo, item.id)) fail(400, 'Сообщение для ответа не найдено.');
      replyTo = body.replyTo;
    }
    let result;
    try { result = db.prepare('INSERT INTO community_messages(channel_id,sender_id,text,attachment_id,reply_to,created_at,client_key) VALUES(?,?,?,?,?,?,?)').run(item.id, viewer, value, attachmentId, replyTo, timestamp(), clientKey); }
    catch (error) {
      // Two retries raced: the first one won, this one answers with its row.
      const raced = clientKey ? db.prepare('SELECT * FROM community_messages WHERE sender_id=? AND client_key=?').get(viewer, clientKey) : null;
      if (!raced) throw error;
      if (raced.channel_id !== item.id) fail(409, 'Этот ключ уже использован для другого сообщения.');
      return { message: publicMessage(raced) };
    }
    const messageId = Number(result.lastInsertRowid);
    const mentions = mentionTargets(row, item, viewer, value, replyTo); saveMentions(messageId, item, mentions);
    // The sender has read everything up to their own message.
    db.prepare('INSERT INTO community_channel_reads(user_id,channel_id,last_read_id) VALUES(?,?,?) ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_id=MAX(last_read_id,excluded.last_read_id)').run(viewer, item.id, messageId);
    const message = publicMessage(db.prepare('SELECT * FROM community_messages WHERE id=?').get(messageId));
    emitCommunity(row, { type: 'community.message', communityId: row.id, message, mentions, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(viewer)) }, item);
    return { message };
  });

  app.patch('/communities/:id/channels/:channelId/messages/:messageId', authOptions, async request => {
    const { row, item, viewer } = visibleChannel(request);
    const message = db.prepare('SELECT * FROM community_messages WHERE id=? AND channel_id=?').get(Number(request.params.messageId), item.id);
    if (!message) fail(404, 'Сообщение не найдено.');
    if (message.sender_id !== viewer) fail(403, 'Изменить можно только своё сообщение.');
    const body = objectBody(request.body, ['text']);
    const value = boundedText(body.text, 'Сообщение', message.attachment_id ? 0 : 1, 4000, { trim: false });
    db.prepare('UPDATE community_messages SET text=?,edited_at=? WHERE id=?').run(value, timestamp(), message.id);
    saveMentions(message.id, item, mentionTargets(row, item, viewer, value, message.reply_to));
    const next = publicMessage(db.prepare('SELECT * FROM community_messages WHERE id=?').get(message.id));
    emitCommunity(row, { type: 'community.message', communityId: row.id, message: next, edited: true }, item);
    return { message: next };
  });

  // Toggle my reaction (max 20 different emoji per message, 1–16 characters each).
  app.post('/communities/:id/channels/:channelId/messages/:messageId/reactions', authOptions, async request => {
    const { row, item, viewer } = visibleChannel(request);
    const message = db.prepare('SELECT * FROM community_messages WHERE id=? AND channel_id=?').get(Number(request.params.messageId), item.id);
    if (!message) fail(404, 'Сообщение не найдено.');
    const body = objectBody(request.body, ['emoji']);
    const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
    if (!emoji || emoji.length > 16 || /[\s<>]/.test(emoji)) fail(400, 'Неверная реакция.');
    const mine = db.prepare('SELECT 1 FROM community_reactions WHERE message_id=? AND user_id=? AND emoji=?').get(message.id, viewer, emoji);
    if (mine) db.prepare('DELETE FROM community_reactions WHERE message_id=? AND user_id=? AND emoji=?').run(message.id, viewer, emoji);
    else {
      const kinds = db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM community_reactions WHERE message_id=?').get(message.id).n;
      const known = db.prepare('SELECT 1 FROM community_reactions WHERE message_id=? AND emoji=?').get(message.id, emoji);
      if (!known && kinds >= 20) fail(400, 'На сообщении уже 20 разных реакций.');
      db.prepare('INSERT INTO community_reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)').run(message.id, viewer, emoji, timestamp());
    }
    const next = publicMessage(db.prepare('SELECT * FROM community_messages WHERE id=?').get(message.id));
    emitCommunity(row, { type: 'community.message', communityId: row.id, message: next, edited: true }, item);
    return { message: next };
  });

  app.delete('/communities/:id/channels/:channelId/messages/:messageId', authOptions, async request => {
    const { row, item, viewer } = visibleChannel(request);
    const message = db.prepare('SELECT * FROM community_messages WHERE id=? AND channel_id=?').get(Number(request.params.messageId), item.id);
    if (!message) fail(404, 'Сообщение не найдено.');
    if (message.sender_id !== viewer && !(perms(row, viewer) & PERM.MANAGE_MESSAGES)) fail(403, 'Удалить можно только своё сообщение.');
    db.prepare('DELETE FROM community_reactions WHERE message_id=?').run(message.id);
    db.prepare('DELETE FROM community_messages WHERE id=?').run(message.id);
    db.prepare('DELETE FROM community_mentions WHERE message_id=?').run(message.id);
    emitCommunity(row, { type: 'community.message.deleted', communityId: row.id, channelId: item.id, messageId: message.id }, item);
    return { ok: true };
  });

  // Invites: a short code that works as an in-app link and as a web link outside the app.
  app.post('/communities/:id/invites', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.INVITE);
    const body = objectBody(request.body || {}, ['expiresInHours', 'maxUses']);
    const hours = body.expiresInHours ?? null, uses = body.maxUses ?? null;
    if (hours !== null && (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 365)) fail(400, 'Срок ссылки — от часа до года.');
    if (uses !== null && (!Number.isSafeInteger(uses) || uses < 1 || uses > 100_000)) fail(400, 'Некорректный лимит.');
    if (!limiter.allow(`invite-create:${viewer}`, 30, 60 * 60_000)) fail(429, 'Слишком много ссылок. Попробуй позже.');
    // Reuse a permanent unlimited link: one stable link per community and creator.
    if (hours === null && uses === null) {
      const existing = db.prepare('SELECT code FROM community_invites WHERE community_id=? AND creator_id=? AND expires_at IS NULL AND max_uses IS NULL').get(row.id, viewer);
      if (existing) return { invite: { code: existing.code } };
    }
    let code; do code = inviteCode(); while (db.prepare('SELECT 1 FROM community_invites WHERE code=?').get(code));
    db.prepare('INSERT INTO community_invites(code,community_id,creator_id,created_at,expires_at,max_uses) VALUES(?,?,?,?,?,?)').run(code, row.id, viewer, timestamp(), hours === null ? null : now() + hours * 3_600_000, uses);
    return { invite: { code } };
  });

  const liveInvite = code => {
    if (!isInviteCode(code)) return null;
    const invite = db.prepare('SELECT * FROM community_invites WHERE code=?').get(code);
    if (!invite) return null;
    if (invite.expires_at !== null && invite.expires_at <= now()) return null;
    if (invite.max_uses !== null && invite.uses >= invite.max_uses) return null;
    // A closed community: only links from people who may invite right now (the owner, those who
    // manage the community) let anyone in. A link made before it was closed, or by someone who
    // has left or lost that right, is as dead as an expired one.
    const row = db.prepare('SELECT * FROM communities WHERE id=?').get(invite.community_id);
    if (!row) return null;
    if (row.closed === 1 && !(perms(row, invite.creator_id) & PERM.INVITE)) return null;
    return invite;
  };
  const invitePreview = invite => {
    const row = db.prepare('SELECT * FROM communities WHERE id=?').get(invite.community_id);
    return { code: invite.code, community: { id: row.id, kind: row.kind, category: row.category || null, closed: row.closed === 1, name: row.name, description: row.description, avatarId: row.avatar_id, memberCount: memberCount(row.id) } };
  };
  app.get('/invites/:code', authOptions, async request => {
    if (!limiter.allow(`invite-view:${request.auth.user_id}`, 120, 60_000)) fail(429, 'Слишком много запросов.');
    const invite = liveInvite(request.params.code);
    if (!invite) fail(404, 'Приглашение недействительно или истекло.', { code: 'INVITE_INVALID' });
    const preview = invitePreview(invite);
    return { ...preview, isMember: !!member(invite.community_id, request.auth.user_id) };
  });
  app.post('/invites/:code/accept', authOptions, async request => {
    const viewer = request.auth.user_id;
    if (!limiter.allow(`invite-accept:${viewer}`, 30, 60_000)) fail(429, 'Слишком много запросов.');
    const invite = liveInvite(request.params.code);
    if (!invite) fail(404, 'Приглашение недействительно или истекло.', { code: 'INVITE_INVALID' });
    const row = community(invite.community_id);
    if (join(row, viewer)) { db.prepare('UPDATE community_invites SET uses=uses+1 WHERE code=?').run(invite.code); refresh(row); }
    return { community: detail(row, viewer) };
  });

  // Public landing page for links opened outside the app: name only, then the app link.
  app.get('/i/:code', async (request, reply) => {
    if (!limiter.allow(`invite-page:${request.clientIp || request.ip}`, 60, 60_000)) fail(429, 'Слишком много запросов.');
    const invite = liveInvite(request.params.code);
    const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const preview = invite ? invitePreview(invite) : null;
    const deepLink = invite ? `linea://invite/${invite.code}` : '';
    const title = preview ? escape(preview.community.name) : 'Приглашение недействительно';
    const kind = preview ? (preview.community.kind === 'blog' ? 'Канал' : 'Игровой сервер') : '';
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Инвиз</title><meta name="robots" content="noindex">
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0A1529;color:#EAF2FF;font:16px/1.45 -apple-system,system-ui,sans-serif}main{width:min(360px,calc(100% - 32px));padding:28px 24px;border-radius:24px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);text-align:center}h1{font-size:24px;margin:6px 0}p{color:#9FB2D0;margin:0 0 20px}a{display:block;padding:14px;border-radius:14px;background:#3B7BFF;color:#fff;font-weight:600;text-decoration:none}small{display:block;margin-top:14px;color:#6F84A6}</style></head>
<body><main>${preview ? `<p>${kind} · ${preview.community.memberCount} участн.</p><h1>${title}</h1>${preview.community.description ? `<p>${escape(preview.community.description)}</p>` : '<p>Тебя пригласили в Инвиз.</p>'}<a href="${deepLink}">Открыть в Инвиз</a><small>Если приложение не открылось, установи Инвиз и открой ссылку ещё раз.</small>` : `<h1>${title}</h1><p>Попроси новую ссылку у того, кто тебя пригласил.</p>`}</main></body></html>`;
  });

  /** For the app icon badge: unread of every community (a muted one adds only its @mentions). */
  const badge = userId => {
    let n = 0;
    for (const row of db.prepare('SELECT c.*, m.muted AS my_muted FROM communities c JOIN community_members m ON m.community_id=c.id WHERE m.user_id=?').all(userId)) {
      const t = totals(row, userId); n += row.my_muted === 1 ? t.mentionCount : t.unreadCount;
    }
    return n;
  };
  return { badge, community, member, canSee, perms, channel, serverVoice, voiceAllowed: (communityId, channelId, userId) => {
    const row = db.prepare('SELECT * FROM communities WHERE id=?').get(communityId);
    if (!row || !member(row.id, userId)) return null;
    const item = db.prepare('SELECT * FROM community_channels WHERE id=? AND community_id=? AND kind=?').get(channelId, row.id, 'voice');
    if (!item || !canSee(row, item, userId) || !(perms(row, userId) & PERM.VOICE)) return null;
    return { row, item };
  }, emitCommunity };
}
