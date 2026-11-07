import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

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
