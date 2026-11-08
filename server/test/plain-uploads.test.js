// Big plaintext uploads (channels, profile posts and stories) in resumable chunks: never refused for their size
// below the account limits, counted in the same storage as the encrypted big files, served with byte ranges.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { CHUNK_PLAIN } from '../src/bigfiles.js';

const MiB = 1024 * 1024;
const PASSWORD = 'Synthetic!Orchid.87.Wind';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-plain-test-'));
  let disk = 1000 * 1024 * MiB;
  const app = await buildApp({ dataDir, authRateLimit: false, diskReserveBytes: 50 * MiB, freeDisk: async () => disk,
    fileLimits: { free: { file: 10 * MiB, video: 16 * MiB, total: 30 * MiB }, platina: { file: 14 * MiB, video: 16 * MiB, total: 40 * MiB } }, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const sql = op => { const db = new DatabaseSync(join(dataDir, 'linea.sqlite')); try { return op(db); } finally { db.close(); } };
  return { app, dataDir, sql, setDisk: bytes => { disk = bytes; } };
}
const call = (app, method, url, account, payload, headers = {}) => app.inject({ method, url, headers: { authorization: `Bearer ${account.token}`, ...headers }, ...(payload === undefined ? {} : { payload }) });
async function register(app, username) {
  const result = await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: username, password: PASSWORD, confirmationWord: 'корабль', recoveryWord: 'астра' } });
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}
const grant = (sql, userId) => sql(db => db.prepare("INSERT INTO platina_entitlements(user_id,grant_id,source,granted_at,expires_at,revoked_at) VALUES(?,?,'admin',?,NULL,NULL)").run(userId, randomUUID(), Date.now()));
const put = (app, account, id, offset, bytes) => call(app, 'PUT', `/uploads/sessions/${id}?offset=${offset}`, account, bytes, { 'content-type': 'application/octet-stream' });
const start = (app, account, fields) => call(app, 'POST', '/uploads/sessions', account, fields);
/** An MP4 header (ftyp isom) followed by random bytes: recognised as video/mp4 by the server. */
function mp4(size) { const b = randomBytes(size); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.writeUInt32BE(512, 12); b.write('isomMSNV', 16, 'latin1'); return b; }
async function sendAll(app, account, id, data) {
  for (let at = 0; at < data.length; at += CHUNK_PLAIN) {
    const r = await put(app, account, id, at, data.subarray(at, at + CHUNK_PLAIN));
    assert.equal(r.statusCode, 200, r.body);
  }
  return call(app, 'POST', `/uploads/sessions/${id}/complete`, account);
}
function multipart(bytes, name, mimeType) {
  const boundary = `----t${Date.now()}`;
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

test('channel: a 9 MiB video goes in 4 MiB chunks, resumes after a lost chunk, posts to the channel and is served with ranges', async t => {
  const f = await fixture(t);
  const owner = await register(f.app, 'plain_owner'), member = await register(f.app, 'plain_member'), stranger = await register(f.app, 'plain_stranger');
  const server = (await call(f.app, 'POST', '/communities', owner, { kind: 'server', name: 'Клан' })).json().community;
  const code = (await call(f.app, 'POST', `/communities/${server.id}/invites`, owner, {})).json().invite.code;
  assert.equal((await call(f.app, 'POST', `/invites/${code}/accept`, member)).statusCode, 200);
  const general = server.channels.find(c => c.kind === 'text');

  const limits = (await call(f.app, 'GET', '/uploads/limits', owner)).json();
  assert.equal(limits.chunkBytes, CHUNK_PLAIN); assert.equal(limits.maxVideoBytes, 16 * MiB); assert.equal(limits.maxFileBytes, 10 * MiB);
  const data = mp4(9 * MiB);
  const started = await start(f.app, owner, { purpose: 'channel', size: data.length, kind: 'video', name: '../../VID 0001.mp4', mimeType: 'video/mp4' });
  assert.equal(started.statusCode, 201, started.body);
  const { id } = started.json();
  assert.equal((await call(f.app, 'GET', '/uploads/limits', owner)).json().usedBytes, data.length, 'the upload reserves its size');
  assert.equal((await put(f.app, owner, id, 0, data.subarray(0, CHUNK_PLAIN))).json().received, CHUNK_PLAIN);
  // A lost reply: the client retries the same chunk and learns where to continue.
  const again = await put(f.app, owner, id, 0, data.subarray(0, CHUNK_PLAIN));
  assert.equal(again.statusCode, 409); assert.equal(again.json().received, CHUNK_PLAIN);
  // A chunk cut off mid-way is not counted; the session still says where to resume.
  assert.equal((await put(f.app, owner, id, CHUNK_PLAIN, data.subarray(CHUNK_PLAIN, CHUNK_PLAIN + 1000))).statusCode, 400);
  assert.equal((await call(f.app, 'GET', `/uploads/sessions/${id}`, owner)).json().received, CHUNK_PLAIN);
  assert.equal((await put(f.app, owner, id, 0, data.subarray(0, CHUNK_PLAIN + 10))).statusCode, 409, 'a stale offset is refused');
  assert.equal((await call(f.app, 'POST', `/uploads/sessions/${id}/complete`, owner)).statusCode, 409, 'not finished yet');
  assert.equal((await call(f.app, 'GET', `/uploads/sessions/${id}`, member)).statusCode, 404, 'another account cannot see the session');
  assert.equal((await put(f.app, member, id, CHUNK_PLAIN, data.subarray(CHUNK_PLAIN, 2 * CHUNK_PLAIN))).statusCode, 404);
  assert.equal((await put(f.app, owner, id, CHUNK_PLAIN, data.subarray(CHUNK_PLAIN, 2 * CHUNK_PLAIN))).statusCode, 200);
  assert.equal((await put(f.app, owner, id, 2 * CHUNK_PLAIN, data.subarray(2 * CHUNK_PLAIN))).json().received, data.length);
  const done = await call(f.app, 'POST', `/uploads/sessions/${id}/complete`, owner);
  assert.equal(done.statusCode, 201, done.body);
  assert.deepEqual(done.json().attachment, { id, name: 'VID 0001.mp4', mimeType: 'video/mp4', size: data.length });
  assert.deepEqual(await readFile(join(f.dataDir, 'uploads', id)), data);
  assert.equal((await readdir(join(f.dataDir, 'uploads'))).some(name => name.endsWith('.part')), false);
  assert.deepEqual({ ...f.sql(db => db.prepare('SELECT purpose,is_video,is_image,is_encrypted FROM uploads WHERE id=?').get(id)) }, { purpose: 'channel', is_video: 1, is_image: 0, is_encrypted: 0 });
  assert.equal((await call(f.app, 'GET', '/uploads/limits', owner)).json().usedBytes, data.length);

  const sent = await call(f.app, 'POST', `/communities/${server.id}/channels/${general.id}/messages`, owner, { attachmentId: id });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().message.attachment.size, data.length);
  const whole = await call(f.app, 'GET', `/files/${id}`, member);
  assert.equal(whole.statusCode, 200); assert.equal(whole.headers['content-type'], 'video/mp4'); assert.equal(whole.rawPayload.length, data.length);
  const start2 = 5 * MiB, end = 6 * MiB - 1;
  const part = await call(f.app, 'GET', `/files/${id}`, member, undefined, { range: `bytes=${start2}-${end}` });
  assert.equal(part.statusCode, 206); assert.equal(part.headers['content-range'], `bytes ${start2}-${end}/${data.length}`);
  assert.deepEqual(part.rawPayload, data.subarray(start2, end + 1));
  assert.equal((await call(f.app, 'GET', `/files/${id}`, member, undefined, { range: `bytes=${data.length}-` })).statusCode, 416);
  assert.equal((await call(f.app, 'GET', `/files/${id}`, stranger, undefined, { range: 'bytes=0-9' })).statusCode, 404, 'ranges keep the access check');
});

test('a non-media channel file keeps the sanitised declared type; the last chunk may be short, never longer', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'plain_doc');
  const data = randomBytes(CHUNK_PLAIN + 123);
  const { id } = (await start(f.app, alice, { purpose: 'channel', size: data.length, name: 'отчёт.pdf', mimeType: 'application/pdf' })).json();
  assert.equal((await put(f.app, alice, id, 0, data.subarray(0, CHUNK_PLAIN))).statusCode, 200);
  assert.equal((await put(f.app, alice, id, CHUNK_PLAIN, Buffer.concat([data.subarray(CHUNK_PLAIN), Buffer.alloc(5)]))).statusCode, 413);
  assert.equal((await put(f.app, alice, id, CHUNK_PLAIN, data.subarray(CHUNK_PLAIN))).statusCode, 200);
  const done = (await call(f.app, 'POST', `/uploads/sessions/${id}/complete`, alice)).json().attachment;
  assert.deepEqual(done, { id, name: 'отчёт.pdf', mimeType: 'application/pdf', size: data.length });
  const html = (await start(f.app, alice, { purpose: 'channel', size: 10, name: 'x.html', mimeType: 'text/html' })).json();
  const finished = await sendAll(f.app, alice, html.id, Buffer.from('<html>hi!!'));
  assert.equal(finished.json().attachment.mimeType, 'application/octet-stream', 'active content is never served with its own type');
});

test('limits: video up to the video limit for everyone, other files up to the file limit, Platina raises files only', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'plain_limits');
  assert.equal((await start(f.app, alice, { purpose: 'channel', size: 15 * MiB, kind: 'video' })).statusCode, 201, 'a video needs no Platina');
  const tooBig = await start(f.app, alice, { purpose: 'channel', size: 17 * MiB, kind: 'video' });
  assert.equal(tooBig.statusCode, 413); assert.equal(tooBig.json().code, 'FILE_TOO_LARGE');
  const file = await start(f.app, alice, { purpose: 'channel', size: 12 * MiB, kind: 'file' });
  assert.equal(file.statusCode, 413); assert.equal(file.json().code, 'PLATINA_REQUIRED'); assert.match(file.json().error, /Platina/);
  assert.equal((await start(f.app, alice, { purpose: 'channel', size: 12 * MiB })).json().code, 'PLATINA_REQUIRED', 'no kind = file');
  grant(f.sql, alice.user.id);
  const limits = (await call(f.app, 'GET', '/uploads/limits', alice)).json();
  assert.equal(limits.platina, true); assert.equal(limits.maxFileBytes, 14 * MiB); assert.equal(limits.maxVideoBytes, 16 * MiB);
  assert.equal((await start(f.app, alice, { purpose: 'channel', size: 12 * MiB, kind: 'file' })).statusCode, 201);
  const still = await start(f.app, alice, { purpose: 'channel', size: 17 * MiB, kind: 'video' });
  assert.equal(still.statusCode, 413); assert.equal(still.json().code, 'FILE_TOO_LARGE');
  for (const size of [0, -1, 1.5, '5']) assert.equal((await start(f.app, alice, { purpose: 'channel', size })).statusCode, 400);
  assert.equal((await start(f.app, alice, { purpose: 'channel', size: 10, kind: 'photo' })).statusCode, 400);
});

test('quota: chunked plaintext and encrypted uploads share the account storage; disk reserve; cancel frees it', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'plain_quota');
  const first = (await start(f.app, alice, { purpose: 'channel', size: 9 * MiB })).json();
  const enc = await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 9 * MiB });
  assert.equal(enc.statusCode, 201);
  assert.equal((await call(f.app, 'GET', '/e2ee/limits', alice)).json().usedBytes, (await call(f.app, 'GET', '/uploads/limits', alice)).json().usedBytes);
  // 9 + ~9 reserved of 30: another 9 MiB plaintext still fits, then neither kind does.
  const second = await start(f.app, alice, { purpose: 'channel', size: 9 * MiB });
  assert.equal(second.statusCode, 201);
  const full = await start(f.app, alice, { purpose: 'channel', size: 5 * MiB });
  assert.equal(full.statusCode, 413); assert.equal(full.json().code, 'STORAGE_FULL');
  assert.equal((await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 5 * MiB })).json().code, 'STORAGE_FULL', 'the encrypted side sees the plaintext reservation');
  const small = multipart(Buffer.from('hello'), 'a.txt', 'text/plain');
  assert.equal((await call(f.app, 'POST', '/uploads?purpose=channel', alice, small.payload, small.headers)).statusCode, 201, 'small files still fit');
  assert.equal((await call(f.app, 'DELETE', `/uploads/sessions/${first.id}`, alice)).statusCode, 200);
  assert.equal((await call(f.app, 'GET', `/uploads/sessions/${first.id}`, alice)).statusCode, 404);
  assert.equal((await start(f.app, alice, { purpose: 'channel', size: 5 * MiB })).statusCode, 201, 'cancel frees the reservation');
  f.setDisk(52 * MiB); // 50 MiB must stay free
  const disk = await start(f.app, alice, { purpose: 'channel', size: 3 * MiB });
  assert.equal(disk.statusCode, 507); assert.equal(disk.json().code, 'SERVER_FULL');
});

test('purpose: channel, post and story only; a post is a photo or MP4/MOV, checked on its first chunk', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'plain_post');
  for (const purpose of [undefined, 'profile', 'avatar', 'toString', 42]) assert.equal((await start(f.app, alice, { purpose, size: 10 })).statusCode, 400, String(purpose));

  const doc = (await start(f.app, alice, { purpose: 'post', size: CHUNK_PLAIN + 10 })).json();
  const refused = await put(f.app, alice, doc.id, 0, randomBytes(CHUNK_PLAIN));
  assert.equal(refused.statusCode, 415); assert.equal(refused.json().code, 'UNSUPPORTED_MEDIA');
  assert.equal((await call(f.app, 'GET', `/uploads/sessions/${doc.id}`, alice)).statusCode, 404, 'the refused upload is gone with its reservation');
  assert.equal((await readdir(join(f.dataDir, 'uploads'))).length, 0);

  const video = mp4(9 * MiB);
  const story = (await start(f.app, alice, { purpose: 'story', size: video.length, kind: 'video', name: 'post.mp4', mimeType: 'video/mp4' })).json();
  const done = await sendAll(f.app, alice, story.id, video);
  assert.equal(done.statusCode, 201, done.body);
  assert.equal(f.sql(db => db.prepare('SELECT purpose FROM uploads WHERE id=?').get(story.id)).purpose, 'post');
  const published = await call(f.app, 'POST', '/me/posts', alice, { uploadId: story.id, kind: 'story' });
  assert.equal(published.statusCode, 201, published.body);
  assert.equal(published.json().post.media.isVideo, true); assert.equal(published.json().post.media.size, video.length);
  const range = await call(f.app, 'GET', `/files/${story.id}`, alice, undefined, { range: 'bytes=0-15' });
  assert.equal(range.statusCode, 206); assert.deepEqual(range.rawPayload, video.subarray(0, 16));

  // The animated avatar and the banner keep their 8 MiB rule, even for a bigger post video.
  grant(f.sql, alice.user.id);
  assert.equal((await call(f.app, 'PATCH', '/me', alice, { avatarVideoId: story.id })).statusCode, 400);
  assert.equal((await call(f.app, 'PATCH', '/me', alice, { bannerId: story.id })).statusCode, 400);

  // A channel upload cannot be published as a post (posts.js), a post upload is not a channel file to others.
  const channel = (await start(f.app, alice, { purpose: 'channel', size: 32, name: 'c.mp4' })).json();
  await sendAll(f.app, alice, channel.id, mp4(32));
  assert.equal((await call(f.app, 'POST', '/me/posts', alice, { uploadId: channel.id })).statusCode, 404);
});

test('POST /uploads?purpose=post takes a post video above the 8 MiB profile limit; the plain profile upload keeps it', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'plain_single');
  const video = mp4(10 * MiB);
  const asPost = multipart(video, 'post.mp4', 'video/mp4');
  const posted = await call(f.app, 'POST', '/uploads?purpose=post', alice, asPost.payload, asPost.headers);
  assert.equal(posted.statusCode, 201, posted.body);
  assert.equal(f.sql(db => db.prepare('SELECT purpose,is_video FROM uploads WHERE id=?').get(posted.json().attachment.id)).purpose, 'post');
  assert.equal((await call(f.app, 'POST', '/me/posts', alice, { uploadId: posted.json().attachment.id })).statusCode, 201);
  const profile = multipart(video, 'profile.mp4', 'video/mp4');
  assert.equal((await call(f.app, 'POST', '/uploads', alice, profile.payload, profile.headers)).statusCode, 400, 'the animated avatar stays up to 8 MiB');
  const text = multipart(Buffer.from('not media'), 'a.txt', 'text/plain');
  assert.equal((await call(f.app, 'POST', '/uploads?purpose=post', alice, text.payload, text.headers)).statusCode, 400);
});
