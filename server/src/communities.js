// Communities: game servers (Discord-like: text + voice channels, roles) and blog channels
// (Telegram-like: owners post, subscribers read). By the owner's decision these are NOT
// end-to-end encrypted: the server stores channel text. TLS and authentication still apply,
// and private conversations keep their E2EE. Access is enforced here for every route.
import { randomBytes, randomUUID } from 'node:crypto';
import { boundedText, fail, objectBody } from './security.js';

export const PERM = Object.freeze({
  ADMIN: 1, MANAGE_COMMUNITY: 2, MANAGE_CHANNELS: 4, MANAGE_ROLES: 8, INVITE: 16,
  SEND: 32, VOICE: 64, POST: 128, KICK: 256, MANAGE_MESSAGES: 512,
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
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS community_messages_channel ON community_messages(channel_id, id);
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

export function installCommunityRoutes({ app, db, authOptions, publicUser, timestamp, now, emitUser, limiter, voice }) {
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
    return value & PERM.ADMIN ? ALL : value;
  };
  const need = (row, userId, bit, message = 'Недостаточно прав.') => { requireMember(row.id, userId); if (!(perms(row, userId) & bit)) fail(403, message, { code: 'FORBIDDEN' }); };
  const canSee = (row, channel, userId) => {
    const value = perms(row, userId);
    if (!member(row.id, userId) && row.owner_id !== userId) return false;
    if (value & PERM.ADMIN || value & PERM.MANAGE_CHANNELS) return true;
    const allowed = db.prepare('SELECT role_id FROM community_channel_roles WHERE channel_id=?').all(channel.id).map(item => item.role_id);
    if (!allowed.length) return true;
    const mine = new Set(roleIds(row.id, userId));
    return allowed.some(id => mine.has(id));
  };
  const channel = (row, id) => {
    if (typeof id !== 'string' || !uuid.test(id)) fail(404, 'Канал не найден.');
    const item = db.prepare('SELECT * FROM community_channels WHERE id=? AND community_id=?').get(id, row.id);
    if (!item) fail(404, 'Канал не найден.');
    return item;
  };
  const memberCount = id => db.prepare('SELECT COUNT(*) AS n FROM community_members WHERE community_id=?').get(id).n;
  const publicRole = role => ({ id: role.id, name: role.name, color: role.color, position: role.position, perms: role.perms, isDefault: role.is_default === 1 });
  const publicChannel = (item, viewer) => ({
    id: item.id, kind: item.kind, name: item.name, topic: item.topic, category: item.category, position: item.position,
    roleIds: db.prepare('SELECT role_id FROM community_channel_roles WHERE channel_id=?').all(item.id).map(row => row.role_id),
    ...(item.kind === 'voice' ? { voice: voice.members(item.id) } : {}),
    lastMessageId: db.prepare('SELECT MAX(id) AS id FROM community_messages WHERE channel_id=?').get(item.id).id || 0,
    ...(viewer ? {} : {}),
  });
  const summary = (row, viewer) => {
    const mine = member(row.id, viewer);
    const last = db.prepare('SELECT m.* FROM community_messages m JOIN community_channels c ON c.id=m.channel_id WHERE c.community_id=? ORDER BY m.id DESC LIMIT 1').get(row.id);
    return {
      id: row.id, kind: row.kind, name: row.name, description: row.description, avatarId: row.avatar_id, ownerId: row.owner_id, category: row.category || null,
      createdAt: row.created_at, memberCount: memberCount(row.id), isMember: !!mine, perms: perms(row, viewer),
      lastMessage: last ? publicMessage(last) : null, muted: mine?.muted === 1,
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
  });
  const authorsOf = messages => {
    const ids = [...new Set(messages.map(item => item.senderId))];
    return ids.map(id => db.prepare('SELECT * FROM users WHERE id=?').get(id)).filter(Boolean).map(publicUser);
  };
  /** Pushes an event to every member who can see the channel (or the whole community). */
  const emitCommunity = (row, payload, channelItem = null) => {
    for (const { user_id } of db.prepare('SELECT user_id FROM community_members WHERE community_id=?').all(row.id)) {
      if (channelItem && !canSee(row, channelItem, user_id)) continue;
      emitUser(user_id, payload);
    }
  };
  const refresh = row => { for (const { user_id } of db.prepare('SELECT user_id FROM community_members WHERE community_id=?').all(row.id)) emitUser(user_id, { type: 'community', community: summary(row, user_id) }); };
  const join = (row, userId) => {
    if (member(row.id, userId)) return false;
    if (memberCount(row.id) >= MAX_MEMBERS) fail(403, 'В сообществе максимум участников.');
    db.prepare('INSERT INTO community_members(community_id,user_id,joined_at) VALUES(?,?,?)').run(row.id, userId, timestamp());
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
    const name = text(body.name, 'Название', 1, 60);
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
        db.prepare('INSERT INTO community_roles(id,community_id,name,color,position,perms,is_default) VALUES(?,?,?,?,?,?,0)').run(randomUUID(), id, 'Модератор', '#3FA9F5', 10, PERM.MANAGE_MESSAGES | PERM.KICK | PERM.INVITE | PERM.SEND | PERM.VOICE);
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
    const body = objectBody(request.body, ['name', 'description', 'avatarId', 'muted', 'category']);
    if (body.category !== undefined && (row.kind !== 'blog' || !CHANNEL_CATEGORIES.includes(body.category))) fail(400, 'Неизвестное содержание канала.');
    if (body.muted !== undefined) {
      if (typeof body.muted !== 'boolean') fail(400, 'Некорректная настройка звука.');
    }
    const name = body.name === undefined ? row.name : text(body.name, 'Название', 1, 60);
    const description = body.description === undefined ? row.description : text(body.description, 'Описание', 0, 500);
    const avatarId = body.avatarId === undefined ? row.avatar_id : uploadOwned(body.avatarId, viewer, true);
    db.prepare('UPDATE communities SET name=?,description=?,avatar_id=?,category=? WHERE id=?').run(name, description, avatarId, body.category === undefined ? row.category : body.category, row.id);
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
      db.prepare('DELETE FROM community_messages WHERE channel_id IN (SELECT id FROM community_channels WHERE community_id=?)').run(row.id);
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

  app.delete('/communities/:id/members/:userId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.KICK);
    const target = request.params.userId;
    if (target === row.owner_id || target === viewer) fail(400, 'Этого участника нельзя исключить.');
    if (!member(row.id, target)) fail(404, 'Участник не найден.');
    db.prepare('DELETE FROM community_member_roles WHERE community_id=? AND user_id=?').run(row.id, target);
    db.prepare('DELETE FROM community_members WHERE community_id=? AND user_id=?').run(row.id, target);
    voice.kick(target, row.id);
    emitUser(target, { type: 'community.removed', communityId: row.id }); refresh(row);
    return { ok: true };
  });

  app.put('/communities/:id/members/:userId/roles', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_ROLES);
    const target = request.params.userId;
    if (!member(row.id, target)) fail(404, 'Участник не найден.');
    const body = objectBody(request.body, ['roleIds']);
    if (!Array.isArray(body.roleIds) || body.roleIds.length > MAX_ROLES) fail(400, 'Некорректный список ролей.');
    const valid = new Set(db.prepare('SELECT id FROM community_roles WHERE community_id=? AND is_default=0').all(row.id).map(item => item.id));
    if (!body.roleIds.every(id => valid.has(id))) fail(400, 'Неизвестная роль.');
    // Only the owner hands out the administrator role.
    const adminRoles = new Set(db.prepare('SELECT id FROM community_roles WHERE community_id=? AND (perms & ?)<>0').all(row.id, PERM.ADMIN).map(item => item.id));
    if (row.owner_id !== viewer && [...new Set([...roleIds(row.id, target), ...body.roleIds])].some(id => adminRoles.has(id) && (body.roleIds.includes(id) !== roleIds(row.id, target).includes(id)))) fail(403, 'Роль администратора выдаёт только владелец.');
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
    const role = roleFields(body, { name: 'Новая роль', color: '#3FA9F5', perms: PERM.SEND | PERM.VOICE }, row.owner_id === viewer);
    const id = randomUUID();
    const position = (db.prepare('SELECT MAX(position) AS p FROM community_roles WHERE community_id=?').get(row.id).p || 0) + 1;
    db.prepare('INSERT INTO community_roles(id,community_id,name,color,position,perms,is_default) VALUES(?,?,?,?,?,?,0)').run(id, row.id, role.name, role.color, position, role.perms);
    return { role: publicRole(db.prepare('SELECT * FROM community_roles WHERE id=?').get(id)) };
  });

  app.patch('/communities/:id/roles/:roleId', authOptions, async request => {
    const viewer = request.auth.user_id, row = community(request.params.id);
    need(row, viewer, PERM.MANAGE_ROLES);
    const current = db.prepare('SELECT * FROM community_roles WHERE id=? AND community_id=?').get(request.params.roleId, row.id);
    if (!current) fail(404, 'Роль не найдена.');
    if (current.perms & PERM.ADMIN && row.owner_id !== viewer) fail(403, 'Роль администратора меняет только владелец.');
    const role = roleFields(objectBody(request.body, ['name', 'color', 'perms']), { name: current.name, color: current.color, perms: current.perms }, row.owner_id === viewer);
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
    db.prepare('DELETE FROM community_roles WHERE id=?').run(current.id);
    refresh(row);
    return { ok: true };
  });

  function roleFields(body, fallback, owner) {
    const name = body.name === undefined ? fallback.name : text(body.name, 'Название роли', 1, 32);
    const color = body.color === undefined ? fallback.color : body.color;
    if (typeof color !== 'string' || !COLOR.test(color)) fail(400, 'Цвет роли — в формате #RRGGBB.');
    const value = body.perms === undefined ? fallback.perms : body.perms;
    if (!Number.isSafeInteger(value) || value < 0 || (value & ~ALL)) fail(400, 'Некорректные права роли.');
    if (value & PERM.ADMIN && !owner) fail(403, 'Права администратора выдаёт только владелец.');
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
    db.prepare('DELETE FROM community_messages WHERE channel_id=?').run(item.id);
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

  app.post('/communities/:id/channels/:channelId/messages', authOptions, async request => {
    const { row, item, viewer } = visibleChannel(request, { write: true });
    if (!limiter.allow(`community-send:${viewer}`, 30, 10_000)) fail(429, 'Слишком часто. Подожди немного.');
    const body = objectBody(request.body, ['text', 'attachmentId', 'replyTo']);
    const value = body.text === undefined ? '' : boundedText(body.text, 'Сообщение', 0, 4000, { trim: false });
    let attachmentId = null;
    if (body.attachmentId !== undefined && body.attachmentId !== null) {
      if (typeof body.attachmentId !== 'string') fail(400, 'Некорректный файл.');
      const upload = db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=? AND is_encrypted=0 AND attached_message_id IS NULL').get(body.attachmentId, viewer);
      if (!upload || db.prepare('SELECT 1 FROM community_messages WHERE attachment_id=?').get(upload.id)) fail(404, 'Файл не найден.');
      attachmentId = upload.id;
    }
    if (!value.trim() && !attachmentId) fail(400, 'Пустое сообщение.');
    let replyTo = null;
    if (body.replyTo !== undefined && body.replyTo !== null) {
      if (!Number.isSafeInteger(body.replyTo) || !db.prepare('SELECT 1 FROM community_messages WHERE id=? AND channel_id=?').get(body.replyTo, item.id)) fail(400, 'Сообщение для ответа не найдено.');
      replyTo = body.replyTo;
    }
    const result = db.prepare('INSERT INTO community_messages(channel_id,sender_id,text,attachment_id,reply_to,created_at) VALUES(?,?,?,?,?,?)').run(item.id, viewer, value, attachmentId, replyTo, timestamp());
    const message = publicMessage(db.prepare('SELECT * FROM community_messages WHERE id=?').get(Number(result.lastInsertRowid)));
    emitCommunity(row, { type: 'community.message', communityId: row.id, message, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(viewer)) }, item);
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
    const next = publicMessage(db.prepare('SELECT * FROM community_messages WHERE id=?').get(message.id));
    emitCommunity(row, { type: 'community.message', communityId: row.id, message: next, edited: true }, item);
    return { message: next };
  });

  app.delete('/communities/:id/channels/:channelId/messages/:messageId', authOptions, async request => {
    const { row, item, viewer } = visibleChannel(request);
    const message = db.prepare('SELECT * FROM community_messages WHERE id=? AND channel_id=?').get(Number(request.params.messageId), item.id);
    if (!message) fail(404, 'Сообщение не найдено.');
    if (message.sender_id !== viewer && !(perms(row, viewer) & PERM.MANAGE_MESSAGES)) fail(403, 'Удалить можно только своё сообщение.');
    db.prepare('DELETE FROM community_messages WHERE id=?').run(message.id);
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
    return invite;
  };
  const invitePreview = invite => {
    const row = db.prepare('SELECT * FROM communities WHERE id=?').get(invite.community_id);
    return { code: invite.code, community: { id: row.id, kind: row.kind, category: row.category || null, name: row.name, description: row.description, avatarId: row.avatar_id, memberCount: memberCount(row.id) } };
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
    if (!limiter.allow(`invite-page:${request.ip}`, 60, 60_000)) fail(429, 'Слишком много запросов.');
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

  return { community, member, canSee, perms, channel, voiceAllowed: (communityId, channelId, userId) => {
    const row = db.prepare('SELECT * FROM communities WHERE id=?').get(communityId);
    if (!row || !member(row.id, userId)) return null;
    const item = db.prepare('SELECT * FROM community_channels WHERE id=? AND community_id=? AND kind=?').get(channelId, row.id, 'voice');
    if (!item || !canSee(row, item, userId) || !(perms(row, userId) & PERM.VOICE)) return null;
    return { row, item };
  }, emitCommunity };
}
