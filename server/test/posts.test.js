import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { purgeExpiredStories, STORY_OWNERS_SQL } from '../src/posts.js';

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
