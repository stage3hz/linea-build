// Profile posts and stories (Telegram «Публикации» / «Истории»): photos and videos a person pins to
// their profile. Like the birthday, they are seen by friends only (and by the owner). A story lives 24 h.
// Files are the ordinary profile uploads (POST /uploads); messages stay end-to-end encrypted — these are
// profile media, published on purpose, exactly like the avatar and the banner.
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, objectBody } from './security.js';
import { transaction, publicUser, userForViewer } from './database.js';
import { blockedByMe } from './moderation.js';
import { isGift } from './cosmetics.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STORY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_POSTS = 300;
export const MAX_ACTIVE_STORIES = 50;
const MAX_CAPTION = 300;
// How often expired stories are swept from the database and the disk (B30).
export const STORY_SWEEP_MS = 60_000;

/** True when `viewerId` may see `ownerId`'s posts and stories: the owner, or a friend who is not blocked. */
export function canSeePosts(db, ownerId, viewerId) {
  if (ownerId === viewerId) return true;
  if (!db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(ownerId, viewerId)) return false;
  return !blockedByMe(db, ownerId, viewerId) && !blockedByMe(db, viewerId, ownerId);
}

/** The owner of a still-visible post or story that uses this upload, or null. */
export function postOwnerOfUpload(db, uploadId, time) {
  const row = db.prepare('SELECT owner_id FROM profile_posts WHERE upload_id=? AND (expires_at IS NULL OR expires_at > ?)').get(uploadId, time);
  return row ? row.owner_id : null;
}

/**
 * Removes a post or story row and its file, unless the file is also the avatar or the banner. The two
 * rows go in one transaction: a crash between them would otherwise leave an upload (and its quota)
 * that nothing references. The disk file is unlinked once the rows are gone.
 */
async function removePost(db, post, uploadDir) {
  const fileFreed = transaction(db, () => {
    db.prepare('DELETE FROM profile_posts WHERE id=?').run(post.id);
    // The file goes too (frees the storage quota) unless it is also the avatar or the banner.
    const inUse = db.prepare('SELECT 1 FROM users WHERE avatar_id=? OR avatar_video_id=? OR banner_id=?').get(post.upload_id, post.upload_id, post.upload_id);
    if (inUse || !uploadDir) return false;
    db.prepare('DELETE FROM uploads WHERE id=? AND owner_id=?').run(post.upload_id, post.owner_id);
    return true;
  });
  if (fileFreed) await unlink(join(uploadDir, post.upload_id)).catch(() => {});
}

/**
 * Deletes stories whose 24 h have passed, together with their files: an expired story is invisible to
 * everyone, its owner included, so nothing but this sweep would ever free the storage quota it takes.
 * With `ownerId` only that person's stories are swept (done when their profile is read or extended).
 */
export async function purgeExpiredStories(db, { uploadDir, now, ownerId, limit = 500 }) {
  const rows = ownerId
    ? db.prepare('SELECT id, owner_id, upload_id FROM profile_posts WHERE owner_id=? AND expires_at IS NOT NULL AND expires_at <= ?').all(ownerId, now())
    : db.prepare('SELECT id, owner_id, upload_id FROM profile_posts WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?').all(now(), limit);
  for (const row of rows) await removePost(db, row, uploadDir);
  return rows.length;
}

const publicPost = row => ({
  id: row.id, kind: row.kind, caption: row.caption || '', createdAt: row.created_at, expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
  media: { id: row.upload_id, mimeType: row.mime_type, isImage: Boolean(row.is_image), isVideo: Boolean(row.is_video), size: row.size },
  // `views`: how many people watched a story — the owner only (undefined for everyone else, and for posts).
  ...(row.views === undefined || row.views === null ? {} : { views: row.views }),
  // `seen`: whether the requesting person has watched this story (the stories feed).
  ...(row.seen === undefined || row.seen === null ? {} : { seen: Boolean(row.seen) }),
});
const POST_COLUMNS = 'p.*, u.mime_type, u.is_image, u.is_video, u.size';

export const MAX_GIFTS_PER_DAY = 20;
const MAX_GIFT_MESSAGE = 120;

/**
 * People with a live story who have `me` among their contacts (parameters: now, me, me). `expires_at IS
 * NOT NULL` is redundant with `> ?` but lets SQLite use the partial index profile_posts_expires (a partial
 * index is usable only when its WHERE clause appears in the query): the live stories are a handful of rows
 * in a table of posts that never expire. The contacts check is an EXISTS rather than a JOIN so the planner
 * starts from that index even without ANALYZE statistics (a JOIN made it scan the table by owner_id).
 * Exported for the EXPLAIN QUERY PLAN check in the tests.
 */
export const STORY_OWNERS_SQL = `SELECT DISTINCT p.owner_id FROM profile_posts p
      WHERE p.expires_at IS NOT NULL AND p.expires_at > ? AND p.kind='story' AND p.owner_id<>?
      AND EXISTS(SELECT 1 FROM contacts c WHERE c.owner_id=p.owner_id AND c.contact_id=?)`;

export function installPostRoutes({ app, db, authOptions, now, timestamp, limiter, uploadDir, emitUser }) {
  // Gifts (Telegram «Подарки»): a friend sends one of GIFTS with a short note; the profile shows them to
  // the owner and friends, like posts. Free, up to MAX_GIFTS_PER_DAY a day from one person.
  const giftRows = id => db.prepare('SELECT g.*, u.id AS s_id FROM profile_gifts g JOIN users u ON u.id=g.sender_id WHERE g.recipient_id=? ORDER BY g.created_ms DESC LIMIT 500').all(id);
  const publicGift = row => {
    const sender = db.prepare('SELECT * FROM users WHERE id=?').get(row.sender_id);
    return { id: row.id, gift: row.gift, message: row.message || '', createdAt: row.created_at, sender: sender ? { id: sender.id, username: sender.username, displayName: sender.display_name, avatarColor: sender.avatar_color } : null };
  };
  app.get('/users/:id/gifts', authOptions, async request => {
    const id = request.params.id; if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректный пользователь.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, 'Пользователь не найден.');
    if (!canSeePosts(db, id, request.auth.user_id)) return { visible: false, gifts: [] };
    return { visible: true, gifts: giftRows(id).map(publicGift) };
  });
  app.post('/users/:id/gifts', authOptions, async (request, reply) => {
    const me = request.auth.user_id; const id = request.params.id;
    if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректный пользователь.');
    if (id === me) fail(400, 'Себе подарок не отправить.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, 'Пользователь не найден.');
    if (!canSeePosts(db, id, me) || !db.prepare('SELECT 1 FROM contacts WHERE owner_id=? AND contact_id=?').get(me, id)) fail(403, 'Подарки можно дарить только друзьям.');
    const body = objectBody(request.body, ['gift', 'message']);
    if (!isGift(body.gift)) fail(400, 'Неизвестный подарок.');
    const note = body.message === undefined || body.message === null ? '' : body.message;
    if (typeof note !== 'string' || note.length > MAX_GIFT_MESSAGE) fail(400, `Подпись — до ${MAX_GIFT_MESSAGE} символов.`);
    const time = now();
    if (db.prepare('SELECT COUNT(*) AS n FROM profile_gifts WHERE sender_id=? AND created_ms > ?').get(me, time - 24 * 60 * 60 * 1000).n >= MAX_GIFTS_PER_DAY) fail(429, `Не больше ${MAX_GIFTS_PER_DAY} подарков в сутки.`);
    const giftId = randomUUID();
    db.prepare('INSERT INTO profile_gifts(id,sender_id,recipient_id,gift,message,created_at,created_ms) VALUES(?,?,?,?,?,?,?)').run(giftId, me, id, body.gift, note.trim(), timestamp(), time);
    const gift = publicGift(db.prepare('SELECT * FROM profile_gifts WHERE id=?').get(giftId));
    emitUser?.(id, { type: 'gift', gift });
    return reply.code(201).send({ gift });
  });
  app.delete('/me/gifts/:id', authOptions, async request => {
    const id = request.params.id; if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректный подарок.');
    const removed = db.prepare('DELETE FROM profile_gifts WHERE id=? AND recipient_id=?').run(id, request.auth.user_id);
    if (!removed.changes) fail(404, 'Подарок не найден.');
    return { ok: true };
  });

  // Expired stories are removed on a timer (one run at a time), and right away for the profile being read or extended.
  let sweeping = null;
  const sweep = ownerId => {
    if (ownerId) return purgeExpiredStories(db, { uploadDir, now, ownerId }).catch(() => 0);
    if (!sweeping) sweeping = purgeExpiredStories(db, { uploadDir, now }).catch(() => 0).finally(() => { sweeping = null; });
    return sweeping;
  };
  const timer = setInterval(() => { sweep(); }, STORY_SWEEP_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  // The owner's own stories carry the view count; a friend's carry whether that friend has seen them.
  const list = (ownerId, kind, viewerId) => db.prepare(`SELECT ${POST_COLUMNS},
      CASE WHEN p.kind='story' AND p.owner_id=? THEN (SELECT COUNT(*) FROM story_views v WHERE v.story_id=p.id) END AS views,
      CASE WHEN p.kind='story' AND p.owner_id<>? THEN EXISTS(SELECT 1 FROM story_views v WHERE v.story_id=p.id AND v.viewer_id=?) END AS seen
    FROM profile_posts p JOIN uploads u ON u.id=p.upload_id
    WHERE p.owner_id=? AND p.kind=? AND (p.expires_at IS NULL OR p.expires_at > ?) ORDER BY p.created_at DESC, p.id DESC`).all(viewerId, viewerId, viewerId, ownerId, kind, now()).map(publicPost);

  app.get('/users/:id/posts', authOptions, async request => {
    const id = request.params.id; if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректный пользователь.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, 'Пользователь не найден.');
    if (!canSeePosts(db, id, request.auth.user_id)) return { visible: false, posts: [], stories: [] };
    await sweep(id);
    return { visible: true, posts: list(id, 'post', request.auth.user_id), stories: list(id, 'story', request.auth.user_id) };
  });

  // The strip above the chat list (Telegram): friends with a live story, those with something unseen first,
  // then by the newest story. Only people whose posts this account may see (canSeePosts: friends, no block).
  // Own stories come as `mine` so the strip's «Моя история» needs no second request.
  app.get('/stories/feed', authOptions, async request => {
    const me = request.auth.user_id; const time = now();
    const owners = db.prepare(STORY_OWNERS_SQL).all(time, me, me).map(row => row.owner_id).filter(ownerId => canSeePosts(db, ownerId, me));
    const items = owners.map(ownerId => {
      const row = db.prepare('SELECT * FROM users WHERE id=?').get(ownerId); if (!row) return null;
      const stories = list(ownerId, 'story', me).reverse(); // oldest first: they play in order
      // A story may expire between the two queries (or be swept): nothing to show for this person.
      if (!stories.length) return null;
      return { user: userForViewer(db, publicUser(row, { db, now }), me), stories, unseen: stories.filter(story => !story.seen).length, latest: stories[stories.length - 1].createdAt };
    }).filter(Boolean).sort((a, b) => (b.unseen > 0) - (a.unseen > 0) || b.latest.localeCompare(a.latest)).map(({ latest: _latest, ...item }) => item);
    return { items, mine: list(me, 'story', me).reverse() };
  });

  // Marks a story watched. Idempotent: the first view is kept, later calls change nothing. The owner's
  // own view is not counted (Telegram does not show you to yourself).
  app.post('/stories/:id/view', authOptions, async request => {
    const id = request.params.id; if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректная история.');
    const me = request.auth.user_id; const time = now();
    const story = db.prepare("SELECT id, owner_id FROM profile_posts WHERE id=? AND kind='story' AND expires_at > ?").get(id, time);
    if (!story || !canSeePosts(db, story.owner_id, me)) fail(404, 'История не найдена.');
    if (story.owner_id === me) return { ok: true, seen: true };
    const added = db.prepare('INSERT OR IGNORE INTO story_views(story_id,viewer_id,viewed_at) VALUES(?,?,?)').run(id, me, time);
    if (added.changes) emitUser?.(story.owner_id, { type: 'story.view', storyId: id, views: db.prepare('SELECT COUNT(*) AS n FROM story_views WHERE story_id=?').get(id).n });
    return { ok: true, seen: true };
  });

  // Who watched my story, newest first — the owner only (a friend gets 404, like a story that is not theirs).
  app.get('/stories/:id/viewers', authOptions, async request => {
    const id = request.params.id; if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректная история.');
    const me = request.auth.user_id;
    const story = db.prepare("SELECT id FROM profile_posts WHERE id=? AND owner_id=? AND kind='story' AND expires_at > ?").get(id, me, now());
    if (!story) fail(404, 'История не найдена.');
    const rows = db.prepare('SELECT u.*, v.viewed_at FROM story_views v JOIN users u ON u.id=v.viewer_id WHERE v.story_id=? ORDER BY v.viewed_at DESC, u.id LIMIT 1000').all(id);
    return { count: db.prepare('SELECT COUNT(*) AS n FROM story_views WHERE story_id=?').get(id).n, viewers: rows.map(row => ({ user: userForViewer(db, publicUser(row, { db, now }), me), viewedAt: new Date(row.viewed_at).toISOString() })) };
  });

  app.post('/me/posts', authOptions, async (request, reply) => {
    const me = request.auth.user_id;
    if (limiter && !limiter.allow(`posts:${me}`, 30, 60_000)) fail(429, 'Слишком часто. Попробуй через минуту.');
    const body = objectBody(request.body, ['uploadId', 'kind', 'caption']);
    const kind = body.kind === undefined ? 'post' : body.kind;
    if (kind !== 'post' && kind !== 'story') fail(400, 'Вид: post или story.');
    const caption = body.caption === undefined || body.caption === null ? '' : body.caption;
    if (typeof caption !== 'string' || caption.length > MAX_CAPTION) fail(400, `Подпись — до ${MAX_CAPTION} символов.`);
    if (typeof body.uploadId !== 'string' || !uuid.test(body.uploadId)) fail(400, 'Некорректный файл.');
    const upload = db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=? AND is_encrypted=0 AND attached_message_id IS NULL').get(body.uploadId, me);
    if (!upload || upload.purpose === 'channel') fail(404, 'Файл не найден.');
    if (!upload.is_image && !upload.is_video) fail(400, 'Публикация — фото или видео.');
    if (db.prepare('SELECT 1 FROM profile_posts WHERE upload_id=?').get(upload.id)) fail(409, 'Этот файл уже опубликован.');
    await sweep(me);
    const time = now();
    if (kind === 'post' && db.prepare("SELECT COUNT(*) AS n FROM profile_posts WHERE owner_id=? AND kind='post'").get(me).n >= MAX_POSTS) fail(409, `Не больше ${MAX_POSTS} публикаций.`);
    if (kind === 'story' && db.prepare("SELECT COUNT(*) AS n FROM profile_posts WHERE owner_id=? AND kind='story' AND expires_at > ?").get(me, time).n >= MAX_ACTIVE_STORIES) fail(409, `Не больше ${MAX_ACTIVE_STORIES} историй за сутки.`);
    const id = randomUUID();
    db.prepare('INSERT INTO profile_posts(id,owner_id,upload_id,kind,caption,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, me, upload.id, kind, caption.trim(), timestamp(), kind === 'story' ? time + STORY_TTL_MS : null);
    const row = db.prepare(`SELECT ${POST_COLUMNS} FROM profile_posts p JOIN uploads u ON u.id=p.upload_id WHERE p.id=?`).get(id);
    if (kind === 'story') notifyFriends(me);
    return reply.code(201).send({ post: publicPost(row) });
  });

  app.delete('/me/posts/:id', authOptions, async request => {
    const id = request.params.id; if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректная публикация.');
    const me = request.auth.user_id;
    const post = db.prepare('SELECT id, owner_id, upload_id, kind, expires_at FROM profile_posts WHERE id=? AND owner_id=?').get(id, me);
    if (!post) fail(404, 'Публикация не найдена.');
    await removePost(db, post, uploadDir);
    // A live story taken down leaves the friends' strip at once (an expired one was never there).
    if (post.kind === 'story' && post.expires_at > now()) notifyFriends(me);
    return { ok: true };
  });

  // Friends learn of a new or removed story at once, so the strip above their chat list updates
  // (blocked people get nothing). The payload says only whose stories changed: the strip re-reads the feed.
  function notifyFriends(ownerId) {
    if (!emitUser) return;
    for (const { contact_id } of db.prepare('SELECT contact_id FROM contacts WHERE owner_id=?').all(ownerId)) if (canSeePosts(db, ownerId, contact_id)) emitUser(contact_id, { type: 'story', ownerId });
  }
}
