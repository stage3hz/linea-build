import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { purgeExpiredStories, canSeePosts, STORY_OWNERS_SQL, RECENT_POST_OWNERS_SQL } from '../src/posts.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
function multipart(bytes) {
  const boundary = 'linea-posts-boundary';
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

test('posts and stories: friends see them and their files, strangers do not; stories end after 24 h; delete frees the file', async t => {
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-posts-')), app = await buildApp({ dataDir, authRateLimit: false, now: () => clock });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async username => (await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: username, password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } })).json();
  const owner = await register('post_owner'), friend = await register('post_friend'), stranger = await register('post_stranger');
  const as = u => ({ authorization: `Bearer ${u.token}` });
  const upload = async u => { const form = multipart(PNG); const r = await app.inject({ method: 'POST', url: '/uploads', payload: form.payload, headers: { ...form.headers, ...as(u) } }); assert.equal(r.statusCode, 201, r.body); return r.json().attachment.id; };
  const publish = (u, payload) => app.inject({ method: 'POST', url: '/me/posts', headers: as(u), payload });
  const list = (viewer, id = owner.user.id) => app.inject({ method: 'GET', url: `/users/${id}/posts`, headers: as(viewer) }).then(r => r.json());
  const file = (viewer, id) => app.inject({ method: 'GET', url: `/files/${id}`, headers: as(viewer) }).then(r => r.statusCode);

  const photo = await upload(owner), storyFile = await upload(owner);
  const post = await publish(owner, { uploadId: photo, kind: 'post', caption: ' море ' });
  assert.equal(post.statusCode, 201, post.body); assert.equal(post.json().post.caption, 'море');
  assert.equal((await publish(owner, { uploadId: photo, kind: 'post' })).statusCode, 409);
  assert.equal((await publish(owner, { uploadId: storyFile, kind: 'reel' })).statusCode, 400);
  assert.equal((await publish(owner, { uploadId: storyFile, kind: 'story' })).statusCode, 201);
  // Another person's file cannot be published.
  assert.equal((await publish(stranger, { uploadId: await upload(owner), kind: 'post' })).statusCode, 404);

  const own = await list(owner);
  assert.equal(own.visible, true); assert.equal(own.posts.length, 1); assert.equal(own.stories.length, 1);
  assert.deepEqual(await list(stranger), { visible: false, posts: [], stories: [] });
  assert.equal(await file(stranger, photo), 404);

  await app.inject({ method: 'PUT', url: `/contacts/${friend.user.id}`, headers: as(owner) });
  await app.inject({ method: 'PUT', url: `/contacts/${owner.user.id}`, headers: as(friend) });
  const seen = await list(friend);
  assert.equal(seen.posts.length, 1); assert.equal(seen.stories.length, 1);
  assert.equal(await file(friend, photo), 200); assert.equal(await file(friend, storyFile), 200);

  clock += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await list(friend)).stories.length, 0);
  assert.equal(await file(friend, storyFile), 404);
  assert.equal((await list(friend)).posts.length, 1);

  const postId = seen.posts[0].id;
  assert.equal((await app.inject({ method: 'DELETE', url: `/me/posts/${postId}`, headers: as(friend) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/me/posts/${postId}`, headers: as(owner) })).statusCode, 200);
  assert.equal((await list(owner)).posts.length, 0);
  assert.equal(await file(owner, photo), 404);
});

test('B30: expired stories are removed with their files and give the storage quota back', async t => {
  let clock = Date.parse('2026-11-07T10:00:00Z');
  // The quota fits one small picture: a second upload is refused until the first one is gone.
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-stories-')), app = await buildApp({ dataDir, authRateLimit: false, now: () => clock, maxStoredBytesPerUser: PNG.length });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = (await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'story_owner', displayName: 'o', password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } })).json();
  const as = { authorization: `Bearer ${owner.token}` };
  const upload = async () => { const form = multipart(PNG); return app.inject({ method: 'POST', url: '/uploads', payload: form.payload, headers: { ...form.headers, ...as } }); };
  const exists = id => access(join(dataDir, 'uploads', id)).then(() => true, () => false);
  const first = await upload(); assert.equal(first.statusCode, 201, first.body);
  const storyFile = first.json().attachment.id;
  assert.equal((await app.inject({ method: 'POST', url: '/me/posts', headers: as, payload: { uploadId: storyFile, kind: 'story' } })).statusCode, 201);
  assert.equal((await upload()).statusCode, 413, 'quota is full while the story lives');
  assert.equal(await exists(storyFile), true);

  clock += 24 * 60 * 60 * 1000 + 1;
  const mine = (await app.inject({ method: 'GET', url: `/users/${owner.user.id}/posts`, headers: as })).json();
  assert.equal(mine.stories.length, 0);
  assert.equal(await exists(storyFile), false, 'the file is gone from the disk');
  assert.equal((await app.inject({ method: 'GET', url: `/files/${storyFile}`, headers: as })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/me/posts/${mine.stories[0]?.id ?? storyFile}`, headers: as })).statusCode, 404, 'nothing is left to delete');
  const again = await upload(); assert.equal(again.statusCode, 201, 'the quota is free again');
  // The timer path: the sweep runs with nobody reading the profile (here called directly, on its own connection).
  assert.equal((await app.inject({ method: 'POST', url: '/me/posts', headers: as, payload: { uploadId: again.json().attachment.id, kind: 'story' } })).statusCode, 201);
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await upload()).statusCode, 413, 'nothing has swept yet');
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite'));
  t.after(() => db.close());
  assert.equal(await purgeExpiredStories(db, { uploadDir: join(dataDir, 'uploads'), now: () => clock }), 1);
  assert.equal(await purgeExpiredStories(db, { uploadDir: join(dataDir, 'uploads'), now: () => clock }), 0);
  assert.equal(await exists(again.json().attachment.id), false);
  assert.equal((await upload()).statusCode, 201);
});

test('gifts: only friends send and see them, unknown gifts and self-gifts are refused, the recipient can remove one; the profile pattern is a known emoji', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-gifts-')), app = await buildApp({ dataDir, authRateLimit: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async username => (await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: username, password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } })).json();
  const a = await register('gift_a'), b = await register('gift_b'), c = await register('gift_c');
  const as = u => ({ authorization: `Bearer ${u.token}` });
  const send = (from, to, payload) => app.inject({ method: 'POST', url: `/users/${to.user.id}/gifts`, headers: as(from), payload });
  const gifts = (viewer, of) => app.inject({ method: 'GET', url: `/users/${of.user.id}/gifts`, headers: as(viewer) }).then(r => r.json());
  assert.equal((await send(a, b, { gift: 'bear' })).statusCode, 403);
  await app.inject({ method: 'PUT', url: `/contacts/${b.user.id}`, headers: as(a) });
  await app.inject({ method: 'PUT', url: `/contacts/${a.user.id}`, headers: as(b) });
  const sent = await send(a, b, { gift: 'bear', message: ' с днём! ' });
  assert.equal(sent.statusCode, 201, sent.body); assert.equal(sent.json().gift.message, 'с днём!'); assert.equal(sent.json().gift.sender.id, a.user.id);
  assert.equal((await send(a, b, { gift: 'yacht' })).statusCode, 400);
  assert.equal((await send(a, a, { gift: 'bear' })).statusCode, 400);
  assert.equal((await gifts(a, b)).gifts.length, 1);
  assert.equal((await gifts(b, b)).gifts.length, 1);
  assert.deepEqual(await gifts(c, b), { visible: false, gifts: [] });
  const id = (await gifts(b, b)).gifts[0].id;
  assert.equal((await app.inject({ method: 'DELETE', url: `/me/gifts/${id}`, headers: as(a) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/me/gifts/${id}`, headers: as(b) })).statusCode, 200);
  assert.equal((await gifts(b, b)).gifts.length, 0);

  const pattern = value => app.inject({ method: 'PATCH', url: '/me', headers: as(a), payload: { profilePattern: value } });
  assert.equal((await pattern('🌸')).json().user.profilePattern, '🌸');
  assert.equal((await pattern('<script>')).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/users/${a.user.id}`, headers: as(c) })).json().user.profilePattern, '🌸');
  assert.equal((await pattern(null)).json().user.profilePattern, null);
});

test('rate limiter: a full table drops its oldest windows instead of refusing every new key', async () => {
  const { createLimiter } = await import('../src/security.js');
  let clock = 0; const limiter = createLimiter(() => clock, 100);
  for (let i = 0; i < 100; i++) assert.equal(limiter.allow(`flood:${i}`, 1, 60_000), true);
  // Table full of live windows: a real user still gets through.
  assert.equal(limiter.allow('user:real', 5, 60_000), true);
  // The user's own limit still works.
  for (let i = 0; i < 4; i++) limiter.allow('user:real', 5, 60_000);
  assert.equal(limiter.allow('user:real', 5, 60_000), false);
});

test('F8 stories: the feed is friends-only and unseen-first, a view is idempotent and not counted for the owner, viewers are the owner\'s alone', async t => {
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-feed-')), app = await buildApp({ dataDir, authRateLimit: false, now: () => clock });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async username => (await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: username, password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } })).json();
  const owner = await register('feed_owner'), friend = await register('feed_friend'), other = await register('feed_other'), stranger = await register('feed_stranger');
  const as = u => ({ authorization: `Bearer ${u.token}` });
  const befriend = async (a, b) => { await app.inject({ method: 'PUT', url: `/contacts/${b.user.id}`, headers: as(a) }); await app.inject({ method: 'PUT', url: `/contacts/${a.user.id}`, headers: as(b) }); };
  const story = async u => { const form = multipart(PNG); const up = await app.inject({ method: 'POST', url: '/uploads', payload: form.payload, headers: { ...form.headers, ...as(u) } }); const r = await app.inject({ method: 'POST', url: '/me/posts', headers: as(u), payload: { uploadId: up.json().attachment.id, kind: 'story' } }); assert.equal(r.statusCode, 201, r.body); return r.json().post.id; };
  const feed = u => app.inject({ method: 'GET', url: '/stories/feed', headers: as(u) }).then(r => r.json());
  const view = (u, id) => app.inject({ method: 'POST', url: `/stories/${id}/view`, headers: as(u) });
  const viewers = (u, id) => app.inject({ method: 'GET', url: `/stories/${id}/viewers`, headers: as(u) });

  await befriend(owner, friend); await befriend(other, friend);
  const first = await story(owner); clock += 1000; const second = await story(owner); clock += 1000; const others = await story(other);
  // Friends only: the stranger sees nobody; the friend sees both people, nothing seen yet, the newest story first.
  assert.deepEqual((await feed(stranger)).items, []);
  assert.deepEqual((await feed(owner)).mine.map(s => s.id), [first, second]);
  let seen = await feed(friend);
  assert.deepEqual(seen.items.map(i => [i.user.id, i.unseen]), [[other.user.id, 1], [owner.user.id, 2]]);
  assert.deepEqual(seen.items[1].stories.map(s => [s.id, s.seen]), [[first, false], [second, false]]);
  assert.equal(seen.items[1].stories[0].views, undefined, 'view counts are not shown to friends');

  // A view is idempotent; the stranger cannot view; the owner's own view is not counted.
  assert.equal((await view(friend, first)).statusCode, 200);
  assert.equal((await view(friend, first)).statusCode, 200);
  assert.equal((await view(stranger, first)).statusCode, 404);
  assert.equal((await view(owner, first)).statusCode, 200);
  assert.equal((await view(friend, '00000000-0000-4000-8000-000000000000')).statusCode, 404);
  seen = await feed(friend);
  assert.deepEqual(seen.items.map(i => [i.user.id, i.unseen]), [[other.user.id, 1], [owner.user.id, 1]]);
  assert.deepEqual(seen.items[1].stories.map(s => s.seen), [true, false]);
  // Everything of the owner seen: «other» (still unseen) stays first even though the owner's story is newer.
  await view(friend, second);
  seen = await feed(friend);
  assert.deepEqual(seen.items.map(i => [i.user.id, i.unseen]), [[other.user.id, 1], [owner.user.id, 0]]);
  await view(friend, others);
  // Nothing unseen anywhere: the newest story goes first.
  assert.deepEqual((await feed(friend)).items.map(i => i.user.id), [other.user.id, owner.user.id]);

  // Viewers: the owner alone; the count is one person however many times they looked.
  const who = await viewers(owner, first);
  assert.equal(who.statusCode, 200); assert.equal(who.json().count, 1); assert.equal(who.json().viewers[0].user.id, friend.user.id); assert.ok(who.json().viewers[0].viewedAt);
  assert.equal((await viewers(friend, first)).statusCode, 404);
  assert.equal((await viewers(stranger, first)).statusCode, 404);
  const mine = (await app.inject({ method: 'GET', url: `/users/${owner.user.id}/posts`, headers: as(owner) })).json();
  assert.deepEqual(mine.stories.map(s => [s.id, s.views]), [[second, 1], [first, 1]]);
  // A blocked friend drops out of the feed and may not view.
  await app.inject({ method: 'PUT', url: `/blocks/${friend.user.id}`, headers: as(owner) });
  assert.deepEqual((await feed(friend)).items.map(i => i.user.id), [other.user.id]);
  assert.equal((await view(friend, second)).statusCode, 404);
  // Expired stories leave the feed.
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.deepEqual((await feed(friend)).items, []);
  assert.equal((await viewers(owner, first)).statusCode, 404);
});

test('an expired story whose file is also the avatar keeps the file and the upload row', async t => {
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-avatar-story-')), app = await buildApp({ dataDir, authRateLimit: false, now: () => clock });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = (await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'avatar_story', displayName: 'a', password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } })).json();
  const as = { authorization: `Bearer ${owner.token}` };
  const form = multipart(PNG); const up = await app.inject({ method: 'POST', url: '/uploads', payload: form.payload, headers: { ...form.headers, ...as } });
  const fileId = up.json().attachment.id;
  assert.equal((await app.inject({ method: 'PATCH', url: '/me', headers: as, payload: { avatarId: fileId } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/me/posts', headers: as, payload: { uploadId: fileId, kind: 'story' } })).statusCode, 201);
  clock += 24 * 60 * 60 * 1000 + 1;
  const mine = (await app.inject({ method: 'GET', url: `/users/${owner.user.id}/posts`, headers: as })).json();
  assert.equal(mine.stories.length, 0, 'the story is gone');
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite')); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM profile_posts WHERE upload_id=?').get(fileId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE id=?').get(fileId).n, 1, 'the upload row stays: it is the avatar');
  await access(join(dataDir, 'uploads', fileId));
  assert.equal((await app.inject({ method: 'GET', url: `/files/${fileId}`, headers: as })).statusCode, 200, 'the avatar still opens');
  assert.equal((await app.inject({ method: 'GET', url: `/users/${owner.user.id}`, headers: as })).json().user.avatarId, fileId);
});

// A WebSocket signed in as `account` (the harness of blocks-sessions-presence.test.js): `next` waits for a
// packet, `settle` is a ping/pong barrier — anything emitted before it has arrived by the time it resolves.
async function socketFor(t, app, account) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const packets = [], listeners = new Set();
  socket.on('message', raw => { const packet = JSON.parse(raw.toString()); packets.push(packet); for (const listener of [...listeners]) listener(packet); });
  socket.on('error', () => {});
  t.after(() => { socket.terminate(); });
  const next = (predicate, { from = 0, timeout = 3000 } = {}) => {
    const existing = packets.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Timed out waiting for WebSocket packet; received ${JSON.stringify(packets)}`)); }, timeout);
      const listener = packet => { if (!predicate(packet)) return; clearTimeout(timer); listeners.delete(listener); resolve(packet); };
      listeners.add(listener);
    });
  };
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: account.token }));
  assert.equal((await next(packet => packet.type === 'ready')).userId, account.user.id);
  const settle = async () => { const marker = packets.length; socket.send(JSON.stringify({ type: 'ping' })); await next(packet => packet.type === 'pong', { from: marker }); };
  return { socket, packets, next, settle, of: type => packets.filter(packet => packet.type === type) };
}

test('F8 stories over the socket: `story` on publish and on delete reaches friends and not strangers, `story.view` reaches the owner; a friend\'s list carries `seen`', async t => {
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-story-socket-')), app = await buildApp({ dataDir, authRateLimit: false, now: () => clock });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async username => (await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: username, password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } })).json();
  const owner = await register('sock_owner'), friend = await register('sock_friend'), stranger = await register('sock_stranger');
  const as = u => ({ authorization: `Bearer ${u.token}` });
  await app.inject({ method: 'PUT', url: `/contacts/${friend.user.id}`, headers: as(owner) });
  await app.inject({ method: 'PUT', url: `/contacts/${owner.user.id}`, headers: as(friend) });
  const ownerSocket = await socketFor(t, app, owner), friendSocket = await socketFor(t, app, friend), strangerSocket = await socketFor(t, app, stranger);

  const form = multipart(PNG); const up = await app.inject({ method: 'POST', url: '/uploads', payload: form.payload, headers: { ...form.headers, ...as(owner) } });
  const published = await app.inject({ method: 'POST', url: '/me/posts', headers: as(owner), payload: { uploadId: up.json().attachment.id, kind: 'story' } });
  assert.equal(published.statusCode, 201, published.body);
  const storyId = published.json().post.id;
  assert.deepEqual(await friendSocket.next(packet => packet.type === 'story'), { type: 'story', ownerId: owner.user.id });
  await strangerSocket.settle(); await ownerSocket.settle();
  assert.deepEqual(strangerSocket.of('story'), [], 'a stranger learns nothing');
  assert.deepEqual(ownerSocket.of('story'), [], 'the owner is not told about their own story');

  // The friend's list says the story is unseen, the owner's carries the count instead of `seen`.
  const list = viewer => app.inject({ method: 'GET', url: `/users/${owner.user.id}/posts`, headers: as(viewer) }).then(r => r.json());
  assert.deepEqual((await list(friend)).stories.map(s => [s.id, s.seen, s.views]), [[storyId, false, undefined]]);
  assert.deepEqual((await list(owner)).stories.map(s => [s.id, s.seen, s.views]), [[storyId, undefined, 0]]);
  assert.equal((await app.inject({ method: 'POST', url: `/stories/${storyId}/view`, headers: as(friend) })).statusCode, 200);
  assert.deepEqual(await ownerSocket.next(packet => packet.type === 'story.view'), { type: 'story.view', storyId, views: 1 });
  assert.deepEqual((await list(friend)).stories.map(s => s.seen), [true]);
  assert.deepEqual((await list(owner)).stories.map(s => s.views), [1]);
  // A second look is not a second view and sends nothing.
  assert.equal((await app.inject({ method: 'POST', url: `/stories/${storyId}/view`, headers: as(friend) })).statusCode, 200);
  await ownerSocket.settle();
  assert.equal(ownerSocket.of('story.view').length, 1);

  // Taking the story down tells the friends again (the strip drops it), the stranger still hears nothing.
  const before = friendSocket.packets.length;
  assert.equal((await app.inject({ method: 'DELETE', url: `/me/posts/${storyId}`, headers: as(owner) })).statusCode, 200);
  assert.deepEqual(await friendSocket.next(packet => packet.type === 'story', { from: before }), { type: 'story', ownerId: owner.user.id });
  await strangerSocket.settle();
  assert.deepEqual(strangerSocket.of('story'), []);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/stories/feed', headers: as(friend) })).json().items, []);
});

test('F8 stories feed: the owners query reads the partial index profile_posts_expires instead of scanning the posts', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-story-plan-')), app = await buildApp({ dataDir, authRateLimit: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite')); t.after(() => db.close());
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${STORY_OWNERS_SQL}`).all(Date.now(), 'me', 'me').map(row => row.detail);
  assert.ok(plan.some(step => /SEARCH p USING INDEX profile_posts_expires \(expires_at>\?\)/.test(step)), plan.join('\n'));
  assert.ok(!plan.some(step => /^SCAN p\b/.test(step)), plan.join('\n'));
  // The contacts check is a lookup in the contacts primary key, one per live story.
  assert.ok(plan.some(step => /SEARCH c .*contacts.*owner_id=\? AND contact_id=\?/.test(step)), plan.join('\n'));
});

// Shared by the «Кто видит мои истории и записи» tests below: an app on a movable clock and the usual helpers.
async function audienceFixture(t, prefix) {
  const state = { clock: Date.parse('2026-11-07T10:00:00Z') };
  const dataDir = await mkdtemp(join(tmpdir(), `linea-${prefix}-`)), app = await buildApp({ dataDir, authRateLimit: false, now: () => state.clock });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = async name => (await app.inject({ method: 'POST', url: '/auth/register', payload: { username: `${prefix}_${name}`, displayName: name, password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } })).json();
  const as = u => ({ authorization: `Bearer ${u.token}` });
  const call = (method, url, u, payload) => app.inject({ method, url, headers: as(u), ...(payload ? { payload } : {}) });
  const ask = (from, to) => call('PUT', `/contacts/${to.user.id}`, from); // a friend request (or accepting theirs)
  const befriend = async (a, b) => { await ask(a, b); await ask(b, a); };
  const audience = async (u, posts) => { const r = await call('PATCH', '/me/privacy', u, { posts }); assert.equal(r.statusCode, 200, r.body); };
  const publish = async (u, kind) => {
    const form = multipart(PNG); const up = await app.inject({ method: 'POST', url: '/uploads', payload: form.payload, headers: { ...form.headers, ...as(u) } });
    const r = await call('POST', '/me/posts', u, { uploadId: up.json().attachment.id, kind }); assert.equal(r.statusCode, 201, r.body);
    return { id: r.json().post.id, file: up.json().attachment.id };
  };
  const feed = (u, query = '?posts=1') => call('GET', `/stories/feed${query}`, u).then(r => r.json());
  return { state, app, dataDir, register, as, call, ask, befriend, audience, publish, feed };
}

test('privacy «Кто видит мои истории и записи»: friends by default, only the two known values are stored, other settings stay', async t => {
  const { register, call } = await audienceFixture(t, 'aud');
  const user = await register('user');
  assert.equal((await call('GET', '/me/privacy', user)).json().privacy.posts, 'friends');
  for (const bad of ['nobody', 'contacts', true, 1, null, '']) assert.equal((await call('PATCH', '/me/privacy', user, { posts: bad })).statusCode, 400, JSON.stringify(bad));
  assert.equal((await call('GET', '/me/privacy', user)).json().privacy.posts, 'friends', 'a refused value changes nothing');
  assert.equal((await call('PATCH', '/me/privacy', user, { posts: 'everyone' })).json().privacy.posts, 'everyone');
  // Another setting saved later keeps it, and it does not disturb the others.
  const after = (await call('PATCH', '/me/privacy', user, { allowNewChats: false })).json().privacy;
  assert.equal(after.posts, 'everyone'); assert.equal(after.allowNewChats, false); assert.equal(after.calls, 'everyone'); assert.equal(after.lastSeen, 'everyone');
  assert.equal((await call('PATCH', '/me/privacy', user, { posts: 'friends' })).json().privacy.posts, 'friends');
});

test('canSeePosts: a friend always; a stranger only with «Все»; a block either way hides everything; gifts stay friends-only', async t => {
  const { dataDir, register, call, befriend, audience, publish } = await audienceFixture(t, 'see');
  const owner = await register('owner'), friend = await register('friend'), stranger = await register('stranger'), blocked = await register('blocked'), blocker = await register('blocker');
  await befriend(owner, friend);
  const post = await publish(owner, 'post'), story = await publish(owner, 'story');
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite')); t.after(() => db.close());
  const sees = viewer => canSeePosts(db, owner.user.id, viewer.user.id);
  // What a viewer gets over HTTP: the profile lists, both files, marking the story watched.
  const reach = async viewer => {
    const lists = (await call('GET', `/users/${owner.user.id}/posts`, viewer)).json();
    return { visible: lists.visible, posts: lists.posts.length, stories: lists.stories.length, postFile: (await call('GET', `/files/${post.file}`, viewer)).statusCode,
      storyFile: (await call('GET', `/files/${story.file}`, viewer)).statusCode, view: (await call('POST', `/stories/${story.id}/view`, viewer)).statusCode };
  };
  const open = { visible: true, posts: 1, stories: 1, postFile: 200, storyFile: 200, view: 200 }, closed = { visible: false, posts: 0, stories: 0, postFile: 404, storyFile: 404, view: 404 };

  // Friends-only (the default): the friend and the owner, nobody else.
  assert.equal(sees(owner), true); assert.equal(sees(friend), true); assert.equal(sees(stranger), false);
  assert.deepEqual(await reach(friend), open); assert.deepEqual(await reach(stranger), closed);

  // «Все»: the stranger too — but not someone the owner blocked, nor someone who blocked the owner.
  await audience(owner, 'everyone');
  await call('PUT', `/blocks/${blocked.user.id}`, owner); await call('PUT', `/blocks/${owner.user.id}`, blocker);
  assert.equal(sees(friend), true); assert.equal(sees(stranger), true); assert.equal(sees(blocked), false); assert.equal(sees(blocker), false);
  assert.deepEqual(await reach(friend), open); assert.deepEqual(await reach(stranger), open);
  assert.deepEqual(await reach(blocked), closed); assert.deepEqual(await reach(blocker), closed);
  assert.equal(canSeePosts(db, owner.user.id, undefined), false, 'no viewer, no access');
  // Another person's «Все» opens nothing of the owner's, and the setting is per owner.
  assert.equal(canSeePosts(db, stranger.user.id, owner.user.id), false);

  // Gifts are not posts: a stranger neither sees nor sends them even with «Все».
  assert.deepEqual((await call('GET', `/users/${owner.user.id}/gifts`, stranger)).json(), { visible: false, gifts: [] });
  const gift = await call('POST', `/users/${owner.user.id}/gifts`, stranger, { gift: 'bear' });
  assert.equal(gift.statusCode, 403); assert.equal(gift.json().message ?? gift.json().error, 'Подарки можно дарить только друзьям.');
  assert.equal((await call('POST', `/users/${owner.user.id}/gifts`, friend, { gift: 'bear' })).statusCode, 201);

  // A blocked friend loses access whatever the setting; back to friends-only the stranger does too.
  await call('PUT', `/blocks/${friend.user.id}`, owner);
  assert.equal(sees(friend), false); assert.deepEqual(await reach(friend), closed);
  await audience(owner, 'friends');
  assert.equal(sees(stranger), false); assert.deepEqual(await reach(stranger), closed);
});

test('stories feed: friends, plus people I sent a still-waiting request to when they show to everyone (`pending`); an incoming request is not enough', async t => {
  const { register, call, ask, befriend, audience, publish, feed } = await audienceFixture(t, 'pend');
  const me = await register('me'), friend = await register('friend'), open = await register('open'), shut = await register('shut'), asker = await register('asker'), nobody = await register('nobody');
  await befriend(me, friend);
  await ask(me, open); await ask(me, shut); await ask(asker, me);
  await audience(open, 'everyone'); await audience(asker, 'everyone'); await audience(nobody, 'everyone');
  const stories = {};
  for (const [name, user] of Object.entries({ friend, open, shut, asker, nobody })) { stories[name] = (await publish(user, 'story')).id; }
  const shape = result => result.items.map(item => [item.user.id, item.pending === true, item.stories.map(s => s.id)]).sort((a, b) => a[0].localeCompare(b[0]));
  const expected = [[friend.user.id, false, [stories.friend]], [open.user.id, true, [stories.open]]].sort((a, b) => a[0].localeCompare(b[0]));
  // `shut` keeps friends-only; `asker` only asked me; `nobody` has «Все» but no request from me.
  assert.deepEqual(shape(await feed(me)), expected);
  assert.deepEqual(shape(await feed(me, '')), expected, 'an older app (no ?posts=1) gets the same story items');
  assert.equal('pending' in (await feed(me)).items.find(item => item.user.id === friend.user.id), false, 'a friend carries no `pending`');
  // The pending person's story can be watched and counts as seen afterwards.
  assert.equal((await call('POST', `/stories/${stories.open}/view`, me)).statusCode, 200);
  assert.equal((await feed(me)).items.find(item => item.user.id === open.user.id).unseen, 0);
  assert.equal((await call('POST', `/stories/${stories.shut}/view`, me)).statusCode, 404);
  // The other side sees nothing of mine through my own request: I am friends-only.
  await publish(me, 'story');
  assert.deepEqual((await feed(open)).items, []);
  assert.deepEqual((await feed(asker)).items, [], 'sending a request does not open a friends-only person');

  // `shut` switches to «Все»: now in the strip, marked pending. Cancelling the request removes them again.
  await audience(shut, 'everyone');
  assert.deepEqual((await feed(me)).items.filter(item => item.pending).map(item => item.user.id).sort(), [open.user.id, shut.user.id].sort());
  assert.equal((await call('DELETE', `/friends/requests/${shut.user.id}`, me)).statusCode, 200);
  assert.deepEqual((await feed(me)).items.map(item => item.user.id).sort(), [friend.user.id, open.user.id].sort());
  // Accepted: an ordinary friend, no longer pending.
  await ask(open, me);
  assert.equal((await feed(me)).items.find(item => item.user.id === open.user.id).pending, undefined);
  // A block removes a pending person (the block also drops the request).
  await ask(me, nobody);
  assert.equal((await feed(me)).items.find(item => item.user.id === nobody.user.id).pending, true);
  await call('PUT', `/blocks/${me.user.id}`, nobody);
  assert.equal((await feed(me)).items.some(item => item.user.id === nobody.user.id), false);
});

test('stories feed with ?posts=1: a person without a live story but with a post in the last 48 h is listed with `posts`', async t => {
  const { state, register, ask, befriend, audience, publish, feed, call } = await audienceFixture(t, 'recent');
  const me = await register('me'), friend = await register('friend'), open = await register('open'), shut = await register('shut'), stranger = await register('stranger'), teller = await register('teller');
  await befriend(me, friend); await befriend(me, teller);
  await ask(me, open); await ask(me, shut);
  await audience(open, 'everyone'); await audience(stranger, 'everyone');
  const first = await publish(friend, 'post'); state.clock += 60_000;
  const second = await publish(friend, 'post'); state.clock += 60_000;
  const openPost = await publish(open, 'post'); state.clock += 60_000;
  await publish(shut, 'post'); await publish(stranger, 'post'); state.clock += 60_000;
  const tale = await publish(teller, 'story'); await publish(teller, 'post');

  // Unseen stories first; then the newest post. Posts come newest first; a person with a live story has no `posts`.
  let items = (await feed(me)).items;
  assert.deepEqual(items.map(item => item.user.id), [teller.user.id, open.user.id, friend.user.id]);
  assert.deepEqual(items.map(item => [item.stories.map(s => s.id), (item.posts || []).map(p => p.id), item.unseen, item.pending === true]),
    [[[tale.id], [], 1, false], [[], [openPost.id], 0, true], [[], [second.id, first.id], 0, false]]);
  assert.equal(items[2].posts[0].kind, 'post'); assert.equal(items[2].posts[0].seen, undefined); assert.equal(items[2].posts[0].media.id, second.file);
  assert.equal((await call('GET', `/files/${openPost.file}`, me)).statusCode, 200, 'the listed post can be opened');
  // An app that did not ask for posts gets story items only (it could not open the others).
  assert.deepEqual((await feed(me, '')).items.map(item => item.user.id), [teller.user.id]);
  assert.deepEqual((await feed(me, '?posts=yes')).items.map(item => item.user.id), [teller.user.id]);

  // A post taken down leaves the strip; the older one is still inside 48 h.
  assert.equal((await call('DELETE', `/me/posts/${second.id}`, friend)).statusCode, 200);
  assert.deepEqual((await feed(me)).items.find(item => item.user.id === friend.user.id).posts.map(p => p.id), [first.id]);
  // 48 h after the friend's first post it is no longer news; the younger posts still are — the storyteller's
  // too, now that the story has expired (newest first).
  state.clock = Date.parse('2026-11-07T10:00:00Z') + 48 * 60 * 60 * 1000 + 90_000;
  items = (await feed(me)).items;
  assert.deepEqual(items.map(item => [item.user.id, item.stories.length, item.posts.length]), [[teller.user.id, 0, 1], [open.user.id, 0, 1]]);
  state.clock += 60 * 60 * 1000;
  assert.deepEqual((await feed(me)).items, []);
  // The post itself stays on the profile: only the strip forgets it.
  assert.equal((await call('GET', `/users/${friend.user.id}/posts`, me)).json().posts.length, 1);
});

test('stories feed: the recent posts query reads the partial index profile_posts_recent instead of scanning the posts', async t => {
  const { dataDir } = await audienceFixture(t, 'plan');
  const db = new DatabaseSync(join(dataDir, 'linea.sqlite')); t.after(() => db.close());
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${RECENT_POST_OWNERS_SQL}`).all(new Date().toISOString(), 'me', 'me').map(row => row.detail);
  assert.ok(plan.some(step => /SEARCH p USING INDEX profile_posts_recent \(created_at>\?\)/.test(step)), plan.join('\n'));
  assert.ok(!plan.some(step => /^SCAN p\b/.test(step)), plan.join('\n'));
});

test('stories over the socket: a new story or post reaches friends and, with «Все», people whose request is waiting; never a stranger', async t => {
  const { app, register, ask, befriend, audience, publish } = await audienceFixture(t, 'tell');
  const owner = await register('owner'), friend = await register('friend'), asker = await register('asker'), stranger = await register('stranger');
  await befriend(owner, friend); await ask(asker, owner);
  const friendSocket = await socketFor(t, app, friend), askerSocket = await socketFor(t, app, asker), strangerSocket = await socketFor(t, app, stranger);
  const told = { type: 'story', ownerId: owner.user.id };
  // Friends-only: the person who asked hears nothing; a post is announced like a story (it shows in the strip).
  await publish(owner, 'post');
  assert.deepEqual(await friendSocket.next(packet => packet.type === 'story'), told);
  await askerSocket.settle();
  assert.deepEqual(askerSocket.of('story'), []);
  await audience(owner, 'everyone');
  await publish(owner, 'story');
  assert.deepEqual(await askerSocket.next(packet => packet.type === 'story'), told);
  await strangerSocket.settle();
  assert.deepEqual(strangerSocket.of('story'), [], 'a stranger learns nothing even with «Все»');
});
