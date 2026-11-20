// Rooms («комнаты»): a persistent voice room for a fixed set of people, outside communities. A room is
// only a list of members and a name; the voice itself is the same engine the community voice channels
// use (app.js: `voice.join` with `roomId`), so audio is peer to peer and the server relays signalling.
// Who is inside is kept in memory by that engine; here live the membership, the name, the «awake»
// period after the last person left and the ring («позвать в комнату»).
import { randomUUID } from 'node:crypto';
import { fail, objectBody, publicName } from './security.js';
import { transaction, privacyOf } from './database.js';
import { blockedBetween, blockedByMe } from './moderation.js';
import { roomNotification } from './push.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Members of a room, the creator included (the same number a voice channel holds). */
export const ROOM_LIMIT = 12;
export const MAX_ROOM_NAME = 48;
/** Rooms one person may be in when creating another. */
export const MAX_ROOMS = 100;
/** One ring per person per room in this period. */
export const ROOM_RING_MS = 30_000;

// `name` NULL: the automatic name (the other members' names, made for each viewer).
// `last_active_at`: when someone last entered or left (ms), NULL for a room nobody has been in.
// PRAGMA foreign_keys is off, so nothing cascades: the rows are removed by hand (removeMember, forget).
export const ROOM_SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at INTEGER
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_members_user ON room_members(user_id);
`;

/** «Лариса», «Лариса, Тимур», «Лариса, Тимур, Анна», «Лариса, Тимур и ещё 2». */
export function autoRoomName(names) {
  if (!names.length) return 'Комната';
  return names.length > 3 ? `${names.slice(0, 2).join(', ')} и ещё ${names.length - 2}` : names.join(', ');
}

/**
 * `voice`: the voice engine of app.js — `members(roomId)` (who is inside, the shape `voice.state` uses),
 * `close(roomId)` (everyone out) and `evict(userId, roomId)` (one person out).
 * `closed()`: true once the database is closed (a timer must not touch it then).
 * Returns what the engine needs back: `voiceAllowed`, `voiceChanged`, and `forget` for a deleted account.
 */
export function installRoomRoutes({ app, db, authOptions, now, timestamp, limiter, emitUser, voice, push = null, roomSleepMs = 300_000, closed = () => false }) {
  db.exec(ROOM_SCHEMA);
  // Rooms that are awake: roomId -> the timer that puts the room to sleep, or null while someone is
  // inside. A room that is not here is asleep and holds nothing in memory.
  const awake = new Map();
  const isAwake = roomId => awake.has(roomId);

  const roomRow = id => (typeof id === 'string' && uuid.test(id) ? db.prepare('SELECT * FROM rooms WHERE id=?').get(id) : undefined);
  const isMember = (roomId, userId) => !!db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(roomId, userId);
  const memberIds = roomId => db.prepare('SELECT user_id FROM room_members WHERE room_id=? ORDER BY joined_at, user_id').all(roomId).map(row => row.user_id);
  const memberRows = roomId => db.prepare('SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_id FROM room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.joined_at, u.id').all(roomId);
  // The avatar follows the same rules as everywhere else: hidden by the member's privacy setting and from someone they blocked.
  const publicMember = (row, viewerId) => ({
    id: row.id, username: row.username, displayName: row.display_name, avatarColor: row.avatar_color,
    avatarId: row.id === viewerId || (privacyOf(db, row.id).showAvatar && !blockedByMe(db, row.id, viewerId)) ? row.avatar_id : null,
  });
  const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
  // What a room's voice looks like right now; the same three fields go out as `room.state`.
  const liveState = row => ({ inside: voice.members(row.id), awake: isAwake(row.id), lastActiveAt: iso(row.last_active_at) });
  // The room as `viewerId` sees it: the automatic name leaves the viewer's own name out.
  const publicRoom = (row, viewerId) => {
    const rows = memberRows(row.id);
    return {
      id: row.id,
      name: row.name || autoRoomName(rows.filter(item => item.id !== viewerId).map(item => item.display_name)),
      auto: !row.name,
      members: rows.map(item => publicMember(item, viewerId)),
      ...liveState(row),
      createdAt: row.created_at,
    };
  };
  const emitRoom = (row, type, userIds = memberIds(row.id)) => { for (const userId of userIds) emitUser(userId, { type, room: publicRoom(row, userId) }); };
  const emitState = row => {
    const state = liveState(row);
    for (const userId of memberIds(row.id)) emitUser(userId, { type: 'room.state', roomId: row.id, ...state });
  };
  const sleepNow = roomId => { clearTimeout(awake.get(roomId)); awake.delete(roomId); };
  const memberRoom = (id, userId) => {
    const row = roomRow(id);
    // Not a member reads the same as no such room: a room's existence is nobody else's business.
    if (!row || !isMember(row.id, userId)) fail(404, 'Комната не найдена.');
    return row;
  };
  const friends = (a, b) => !!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(a, b) && !!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(b, a);
  const roomName = value => (typeof value === 'string' && !value.trim() ? null : publicName(value, 'Название комнаты', 1, MAX_ROOM_NAME));

  // The voice engine reports that someone entered or left `roomId` (or changed their microphone).
  // Members get `room.state` (the list of rooms) and `voice.state` (the open voice screen, exactly as
  // for a community channel). When the last person leaves the room stays awake for `roomSleepMs`.
  const voiceChanged = roomId => {
    let row = roomRow(roomId);
    if (!row) { sleepNow(roomId); return; }
    const inside = voice.members(roomId);
    if (inside.length) { clearTimeout(awake.get(roomId)); awake.set(roomId, null); }
    else if (awake.get(roomId) === null) {
      // An exception in a timer would be uncaught (there is no request to answer) and would take the process down.
      const timer = setTimeout(() => {
        if (awake.get(roomId) !== timer) return;
        awake.delete(roomId);
        if (closed()) return;
        try { const asleep = roomRow(roomId); if (asleep) emitState(asleep); } catch (error) { app.log.error({ err: error }, 'room sleep: notify failed'); }
      }, roomSleepMs);
      timer.unref?.();
      awake.set(roomId, timer);
    }
    db.prepare('UPDATE rooms SET last_active_at=? WHERE id=?').run(now(), roomId);
    row = roomRow(roomId);
    emitState(row);
    for (const userId of memberIds(roomId)) emitUser(userId, { type: 'voice.state', channelId: roomId, roomId, members: inside });
  };

  // Takes one person out of a room: out of its voice first, then out of the list. A room is for at
  // least two, so the last one left alone loses it as well. Returns nothing; everyone affected is told.
  const removeMember = (row, userId) => {
    const before = memberIds(row.id);
    const deleted = transaction(db, () => {
      db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(row.id, userId);
      if (db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id=?').get(row.id).n >= 2) return false;
      db.prepare('DELETE FROM room_members WHERE room_id=?').run(row.id);
      db.prepare('DELETE FROM rooms WHERE id=?').run(row.id);
      return true;
    });
    if (deleted) {
      voice.close(row.id);
      sleepNow(row.id);
      for (const id of before) emitUser(id, { type: 'room.removed', roomId: row.id });
      return;
    }
    voice.evict(userId, row.id);
    emitUser(userId, { type: 'room.removed', roomId: row.id });
    emitRoom(roomRow(row.id), 'room.updated');
  };

  app.get('/rooms', authOptions, async request => {
    const me = request.auth.user_id;
    const rows = db.prepare('SELECT r.* FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=? ORDER BY COALESCE(r.last_active_at, 0) DESC, r.created_at DESC, r.id').all(me);
    return { rooms: rows.map(row => publicRoom(row, me)) };
  });

  app.post('/rooms', authOptions, async (request, reply) => {
    const me = request.auth.user_id;
    const body = objectBody(request.body, ['memberIds', 'name']);
    if (!Array.isArray(body.memberIds) || body.memberIds.length > 100 || body.memberIds.some(id => typeof id !== 'string' || !uuid.test(id))) fail(400, 'Некорректный список участников.');
    const others = [...new Set(body.memberIds.map(id => id.toLowerCase()))].filter(id => id !== me);
    if (!others.length) fail(400, 'Выбери, кого позвать в комнату.');
    if (others.length > ROOM_LIMIT - 1) fail(400, `В комнате максимум ${ROOM_LIMIT} человек.`);
    const name = body.name === undefined || body.name === null ? null : roomName(body.name);
    // Friends only, and nobody who blocked the creator or was blocked by them. One answer for all
    // three cases (a stranger, a block, no such account), so it tells nothing about who blocked whom.
    for (const id of others) if (!friends(me, id) || blockedBetween(db, me, id)) fail(403, 'В комнату можно позвать только друзей.');
    // The same people already have a room: it is returned instead of a second one.
    const ids = [me, ...others];
    const marks = ids.map(() => '?').join(',');
    const same = db.prepare(`SELECT room_id FROM room_members WHERE room_id IN (SELECT room_id FROM room_members WHERE user_id=?)
      GROUP BY room_id HAVING COUNT(*)=? AND SUM(user_id IN (${marks}))=? LIMIT 1`).get(me, ids.length, ...ids, ids.length);
    if (same) return { room: publicRoom(roomRow(same.room_id), me), created: false };
    if (!limiter.allow(`room-create:${me}`, 20, 60 * 60_000)) fail(429, 'Слишком много новых комнат. Попробуй позже.');
    if (db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE user_id=?').get(me).n >= MAX_ROOMS) fail(409, `Не больше ${MAX_ROOMS} комнат.`);
    const id = randomUUID(); const time = now();
    transaction(db, () => {
      db.prepare('INSERT INTO rooms(id,name,created_by,created_at,last_active_at) VALUES(?,?,?,?,NULL)').run(id, name, me, timestamp());
      // The creator first, then the others in the order they were named.
      ids.forEach((userId, index) => db.prepare('INSERT INTO room_members(room_id,user_id,joined_at) VALUES(?,?,?)').run(id, userId, time + index));
    });
    const row = roomRow(id);
    emitRoom(row, 'room.created');
    return reply.code(201).send({ room: publicRoom(row, me), created: true });
  });

  // Any member may rename the room; an empty name brings the automatic one back.
  app.patch('/rooms/:id', authOptions, async request => {
    const me = request.auth.user_id;
    const row = memberRoom(request.params.id, me);
    const body = objectBody(request.body, ['name']);
    if (typeof body.name !== 'string') fail(400, 'Название комнаты: требуется строка.');
    if (!limiter.allow(`room-rename:${me}`, 30, 60_000)) fail(429, 'Слишком часто. Подожди немного.');
    db.prepare('UPDATE rooms SET name=? WHERE id=?').run(roomName(body.name), row.id);
    const updated = roomRow(row.id);
    emitRoom(updated, 'room.updated');
    return { room: publicRoom(updated, me) };
  });

  app.post('/rooms/:id/leave', authOptions, async request => {
    const me = request.auth.user_id;
    removeMember(memberRoom(request.params.id, me), me);
    return { ok: true };
  });

  // «Позвать в комнату»: everyone who is not inside right now gets a socket event and an ordinary
  // notification (not a call: nothing rings for a minute). Someone who blocked the caller, or whom the
  // caller blocked, is not called.
  app.post('/rooms/:id/ring', authOptions, async request => {
    const me = request.auth.user_id;
    const row = memberRoom(request.params.id, me);
    if (!limiter.allow(`room-ring:${row.id}:${me}`, 1, ROOM_RING_MS)) fail(429, 'Ты уже звал в эту комнату. Подожди немного.', { retryAfterSeconds: Math.ceil(ROOM_RING_MS / 1000) });
    const inside = new Set(voice.members(row.id).map(item => item.userId));
    const caller = db.prepare('SELECT display_name FROM users WHERE id=?').get(me);
    const callerName = caller?.display_name || 'Инвиз';
    let rang = 0;
    for (const userId of memberIds(row.id)) {
      if (userId === me || inside.has(userId) || blockedBetween(db, me, userId)) continue;
      rang++;
      const name = publicRoom(row, userId).name;
      emitUser(userId, { type: 'room.ring', roomId: row.id, name, fromId: me, fromName: callerName });
      if (!push) continue;
      const message = roomNotification({ roomId: row.id, roomName: name, callerName });
      for (const { token, platform } of db.prepare('SELECT p.token, p.platform FROM push_tokens p JOIN sessions s ON s.token_hash=p.session_hash WHERE p.user_id=? AND s.expires_at>?').all(userId, now())) {
        push(token, message, platform)
          .then(result => { if (result === 'gone' && !closed()) db.prepare('DELETE FROM push_tokens WHERE token=?').run(token); })
          .catch(error => { app.log.warn({ err: error.message }, 'room push failed'); });
      }
    }
    return { ok: true, rang };
  });

  app.addHook('onClose', async () => { for (const timer of awake.values()) clearTimeout(timer); awake.clear(); });

  return {
    /** May this person enter the room's voice? */
    voiceAllowed: (roomId, userId) => { const row = roomRow(roomId); return !!row && isMember(row.id, userId); },
    voiceChanged,
    /** The account is being deleted: it leaves every room (called before its rows go). */
    forget: userId => { for (const row of db.prepare('SELECT r.* FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=?').all(userId)) removeMember(row, userId); },
  };
}
