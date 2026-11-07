// Profile posts and stories (Telegram «Публикации» / «Истории»): photos and videos a person pins to
// their profile. Like the birthday, they are seen by friends only (and by the owner). A story lives 24 h.
// Files are the ordinary profile uploads (POST /uploads); messages stay end-to-end encrypted — these are
// profile media, published on purpose, exactly like the avatar and the banner.
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, objectBody } from './security.js';
import { blockedByMe } from './moderation.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STORY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_POSTS = 300;
export const MAX_ACTIVE_STORIES = 50;
const MAX_CAPTION = 300;

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

const publicPost = row => ({
  id: row.id, kind: row.kind, caption: row.caption || '', createdAt: row.created_at, expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
  media: { id: row.upload_id, mimeType: row.mime_type, isImage: Boolean(row.is_image), isVideo: Boolean(row.is_video), size: row.size },
});

export function installPostRoutes({ app, db, authOptions, now, timestamp, limiter, uploadDir }) {
  const list = (ownerId, kind) => db.prepare(`SELECT p.*, u.mime_type, u.is_image, u.is_video, u.size FROM profile_posts p JOIN uploads u ON u.id=p.upload_id
    WHERE p.owner_id=? AND p.kind=? AND (p.expires_at IS NULL OR p.expires_at > ?) ORDER BY p.created_at DESC, p.id DESC`).all(ownerId, kind, now()).map(publicPost);

  app.get('/users/:id/posts', authOptions, async request => {
    const id = request.params.id; if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректный пользователь.');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, 'Пользователь не найден.');
    if (!canSeePosts(db, id, request.auth.user_id)) return { visible: false, posts: [], stories: [] };
    return { visible: true, posts: list(id, 'post'), stories: list(id, 'story') };
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
    const time = now();
    if (kind === 'post' && db.prepare("SELECT COUNT(*) AS n FROM profile_posts WHERE owner_id=? AND kind='post'").get(me).n >= MAX_POSTS) fail(409, `Не больше ${MAX_POSTS} публикаций.`);
    if (kind === 'story' && db.prepare("SELECT COUNT(*) AS n FROM profile_posts WHERE owner_id=? AND kind='story' AND expires_at > ?").get(me, time).n >= MAX_ACTIVE_STORIES) fail(409, `Не больше ${MAX_ACTIVE_STORIES} историй за сутки.`);
    const id = randomUUID();
    db.prepare('INSERT INTO profile_posts(id,owner_id,upload_id,kind,caption,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, me, upload.id, kind, caption.trim(), timestamp(), kind === 'story' ? time + STORY_TTL_MS : null);
    const row = db.prepare('SELECT p.*, u.mime_type, u.is_image, u.is_video, u.size FROM profile_posts p JOIN uploads u ON u.id=p.upload_id WHERE p.id=?').get(id);
    return reply.code(201).send({ post: publicPost(row) });
  });

  app.delete('/me/posts/:id', authOptions, async request => {
    const id = request.params.id; if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'Некорректная публикация.');
    const me = request.auth.user_id;
    const post = db.prepare('SELECT upload_id FROM profile_posts WHERE id=? AND owner_id=?').get(id, me);
    if (!post) fail(404, 'Публикация не найдена.');
    db.prepare('DELETE FROM profile_posts WHERE id=?').run(id);
    // The file goes too (frees the storage quota) unless it is also the avatar or the banner.
    const inUse = db.prepare('SELECT 1 FROM users WHERE avatar_id=? OR avatar_video_id=? OR banner_id=?').get(post.upload_id, post.upload_id, post.upload_id);
    if (!inUse && uploadDir) { db.prepare('DELETE FROM uploads WHERE id=? AND owner_id=?').run(post.upload_id, me); await unlink(join(uploadDir, post.upload_id)).catch(() => {}); }
    return { ok: true };
  });
}
