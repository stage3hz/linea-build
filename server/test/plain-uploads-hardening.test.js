// Hardening of the chunked uploads (plaintext and encrypted) after review: banner size, account deletion, keep-alive
// after an over-long chunk, disk reserve with outstanding uploads, one request per session, declared video, purposes,
// quotas of one-request uploads, startup sweep.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
/** Three transport-stream packets of `size` bytes with the sync byte at `sync`. */
const ts = (size, sync) => { const b = Buffer.alloc(sync + size * 3); for (let k = 0; k < 3; k++) b[sync + k * size] = 0x47; return b; };
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { CHUNK_PLAIN, diskOutstanding } from '../src/bigfiles.js';
import { videoContainer } from '../src/plainuploads.js';

const MiB = 1024 * 1024;
const PASSWORD = 'Synthetic!Orchid.87.Wind';
const LIMITS = { free: { file: 10 * MiB, video: 16 * MiB, total: 60 * MiB }, platina: { file: 14 * MiB, video: 16 * MiB, total: 60 * MiB } };

async function fixture(t, options = {}) {
  const dataDir = options.dataDir || await mkdtemp(join(tmpdir(), 'linea-harden-test-'));
  let disk = 1000 * 1024 * MiB;
  const build = () => buildApp({ dataDir, authRateLimit: false, diskReserveBytes: 50 * MiB, freeDisk: async () => disk, fileLimits: LIMITS, ...options });
  const f = { dataDir, app: await build(), setDisk: bytes => { disk = bytes; } };
  f.restart = async () => { await f.app.close(); f.app = await build(); };
  t.after(async () => { await f.app.close(); await rm(dataDir, { recursive: true, force: true }); });
  f.sql = op => { const db = new DatabaseSync(join(dataDir, 'linea.sqlite')); try { return op(db); } finally { db.close(); } };
  return f;
}
const call = (app, method, url, account, payload, headers = {}) => app.inject({ method, url, headers: { authorization: `Bearer ${account.token}`, ...headers }, ...(payload === undefined ? {} : { payload }) });
async function register(app, username) {
  const result = await app.inject({ method: 'POST', url: '/auth/register', payload: { username, displayName: username, password: PASSWORD, confirmationWord: 'корабль', recoveryWord: 'астра' } });
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}
const grant = (sql, userId) => sql(db => db.prepare("INSERT INTO platina_entitlements(user_id,grant_id,source,granted_at,expires_at,revoked_at) VALUES(?,?,'admin',?,NULL,NULL)").run(userId, randomUUID(), Date.now()));
const put = (app, account, id, offset, bytes, base = '/uploads/sessions') => call(app, 'PUT', `${base}/${id}?offset=${offset}`, account, bytes, { 'content-type': 'application/octet-stream' });
const start = (app, account, fields) => call(app, 'POST', '/uploads/sessions', account, fields);
function mp4(size) { const b = randomBytes(size); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.writeUInt32BE(512, 12); b.write('isomMSNV', 16, 'latin1'); return b; }
function jpeg(size) { const b = randomBytes(size); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; }
async function chunked(app, account, fields, data) {
  const { id } = (await start(app, account, { size: data.length, ...fields })).json();
  for (let at = 0; at < data.length; at += CHUNK_PLAIN) assert.equal((await put(app, account, id, at, data.subarray(at, at + CHUNK_PLAIN))).statusCode, 200);
  const done = await call(app, 'POST', `/uploads/sessions/${id}/complete`, account);
  assert.equal(done.statusCode, 201, done.body);
  return id;
}
function multipart(bytes, name, mimeType) {
  const boundary = `----t${Date.now()}`;
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

test('B1: a big post photo cannot become the (public) banner; a small one still can', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'harden_banner');
  grant(f.sql, alice.user.id);
  const big = await chunked(f.app, alice, { purpose: 'post', name: 'b.jpg' }, jpeg(9 * MiB));
  const refused = await call(f.app, 'PATCH', '/me', alice, { bannerId: big });
  assert.equal(refused.statusCode, 400); assert.match(refused.json().error, /4 МиБ/);
  const small = await chunked(f.app, alice, { purpose: 'post', name: 's.jpg' }, jpeg(1 * MiB));
  assert.equal((await call(f.app, 'PATCH', '/me', alice, { bannerId: small })).statusCode, 200);
});

test('B2: deleting the account removes unfinished plaintext and encrypted uploads with their .part files', async t => {
  const f = await fixture(t);
  const carol = await register(f.app, 'harden_delete');
  const plain = (await start(f.app, carol, { purpose: 'channel', size: 8 * MiB })).json();
  assert.equal((await put(f.app, carol, plain.id, 0, randomBytes(CHUNK_PLAIN))).statusCode, 200);
  const enc = (await call(f.app, 'POST', '/e2ee/uploads', carol, { size: 6 * MiB })).json();
  assert.equal((await put(f.app, carol, enc.id, 0, randomBytes(CHUNK_PLAIN + 16), '/e2ee/uploads')).statusCode, 200);
  const files = async () => readdir(join(f.dataDir, 'uploads'));
  assert.ok((await files()).includes(`${plain.id}.part`) && (await files()).includes(`${enc.id}.part`));
  const removed = await call(f.app, 'POST', '/auth/delete-account', carol, { currentPassword: PASSWORD, currentConfirmationWord: 'корабль' });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual((await files()).filter(name => name.endsWith('.part')), []);
  assert.equal(f.sql(db => db.prepare('SELECT COUNT(*) AS n FROM plain_upload_sessions').get().n), 0);
  assert.equal(f.sql(db => db.prepare('SELECT COUNT(*) AS n FROM e2ee_upload_sessions').get().n), 0);
});

test('B3: after an over-long chunk the keep-alive connection is closed, so the next request is answered', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'harden_keepalive');
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const port = f.app.server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const send = (method, path, body) => new Promise(resolve => {
    const request = http.request({ agent, host: '127.0.0.1', port, method, path, headers: { authorization: `Bearer ${alice.token}`, ...(body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {}) } }, response => {
      const parts = []; response.on('data', part => parts.push(part)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts).toString() }));
    });
    request.setTimeout(5000, () => { resolve({ status: 'NO RESPONSE' }); request.destroy(); });
    request.on('error', error => resolve({ status: `ERROR ${error.code}` }));
    request.end(body);
  });
  const enc = (await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 100 })).json();
  for (const extra of [200 * 1024, 3 * MiB]) {
    assert.equal((await send('PUT', `/e2ee/uploads/${enc.id}?offset=0`, randomBytes(116 + extra))).status, 413);
    assert.equal((await send('GET', `/e2ee/uploads/${enc.id}`)).status, 200, `encrypted, +${extra} bytes: the next request is answered`);
  }
  const plain = (await start(f.app, alice, { purpose: 'channel', size: 100 })).json();
  for (const extra of [500 * 1024, 2 * MiB, CHUNK_PLAIN]) {
    assert.equal((await send('PUT', `/uploads/sessions/${plain.id}?offset=0`, randomBytes(100 + extra))).status, 413);
    assert.equal((await send('GET', `/uploads/sessions/${plain.id}`)).status, 200, `plaintext, +${extra} bytes: the next request is answered`);
  }
  const ok = await send('PUT', `/uploads/sessions/${plain.id}?offset=0`, randomBytes(100));
  assert.equal(ok.status, 200, ok.body); assert.equal(JSON.parse(ok.body).received, 100);
});

test('B4: the disk reserve counts what unfinished uploads may still write; chunks stop when the disk is nearly full', async t => {
  const f = await fixture(t, { fileLimits: { free: { file: 100 * MiB, video: 100 * MiB, total: 1000 * MiB }, platina: { file: 100 * MiB, video: 100 * MiB, total: 1000 * MiB } } });
  const alice = await register(f.app, 'harden_disk'), bob = await register(f.app, 'harden_disk2');
  f.setDisk(200 * MiB); // 50 MiB must stay free: 150 MiB for all unfinished uploads together
  assert.equal((await start(f.app, alice, { purpose: 'channel', size: 80 * MiB })).statusCode, 201);
  const second = await start(f.app, bob, { purpose: 'channel', size: 80 * MiB });
  assert.equal(second.statusCode, 507, 'the first upload already holds 80 MiB of the disk'); assert.equal(second.json().code, 'SERVER_FULL');
  const enc = await call(f.app, 'POST', '/e2ee/uploads', bob, { size: 80 * MiB });
  assert.equal(enc.statusCode, 507, 'the encrypted side sees the plaintext reservation too');
  assert.equal((await start(f.app, bob, { purpose: 'channel', size: 60 * MiB })).statusCode, 201);
  assert.equal(f.sql(db => diskOutstanding(db)), 140 * MiB);
  const third = await start(f.app, bob, { purpose: 'channel', size: 15 * MiB }); // 200 - 140 - 15 < 50
  assert.equal(third.statusCode, 507);
  // A chunk on a nearly full disk (less than half the reserve free) is refused before anything is written.
  const sessions = f.sql(db => db.prepare('SELECT id FROM plain_upload_sessions WHERE owner_id=?').all(alice.user.id));
  f.setDisk(20 * MiB);
  const chunk = await put(f.app, alice, sessions[0].id, 0, randomBytes(CHUNK_PLAIN));
  assert.equal(chunk.statusCode, 507); assert.equal(chunk.json().code, 'SERVER_FULL');
  f.setDisk(200 * MiB);
  assert.equal((await put(f.app, alice, sessions[0].id, 0, randomBytes(CHUNK_PLAIN))).statusCode, 200);
});

/** A PUT over a raw socket that sends part of its body and then goes silent (no FIN), like a phone switching networks. */
function halfPut(port, account, path, length, sent) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  socket.write(`PUT ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${account.token}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\n\r\n`);
  socket.write(sent);
  return socket;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('last request wins: a silent half-sent chunk never blocks the retry, complete, or the cancel', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'harden_race'), bob = await register(f.app, 'harden_race_b');
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const port = f.app.server.address().port;
  const sockets = []; t.after(() => sockets.forEach(socket => socket.destroy()));
  const video = mp4(CHUNK_PLAIN + 10);
  const { id } = (await start(f.app, alice, { purpose: 'post', size: video.length, kind: 'video' })).json();
  // Garbage half-sent at offset 0, then silence: the retry at the same offset goes through at once.
  sockets.push(halfPut(port, alice, `/uploads/sessions/${id}?offset=0`, CHUNK_PLAIN, Buffer.alloc(MiB, 0x41)));
  await sleep(200);
  assert.equal((await put(f.app, bob, id, 0, video.subarray(0, CHUNK_PLAIN))).statusCode, 404, 'another account cannot take the session over');
  const retry = await put(f.app, alice, id, 0, video.subarray(0, CHUNK_PLAIN));
  assert.equal(retry.statusCode, 200, retry.body);
  sockets.push(halfPut(port, alice, `/uploads/sessions/${id}?offset=${CHUNK_PLAIN}`, 10, Buffer.alloc(3, 0x42)));
  await sleep(200);
  assert.equal((await put(f.app, alice, id, CHUNK_PLAIN, video.subarray(CHUNK_PLAIN))).statusCode, 200);
  // Two completes at once: one wins, the other gets a clean 404/409, never 500.
  const codes = (await Promise.all([call(f.app, 'POST', `/uploads/sessions/${id}/complete`, alice), call(f.app, 'POST', `/uploads/sessions/${id}/complete`, alice)])).map(r => r.statusCode);
  assert.equal(codes.filter(code => code === 201).length, 1, String(codes));
  assert.ok([404, 409].includes(codes.find(code => code !== 201)), String(codes));
  assert.deepEqual(await readFile(join(f.dataDir, 'uploads', id)), video, 'the served file is exactly the uploaded one');

  // Cancel while a chunk hangs: the reservation is freed at once.
  const usedBefore = (await call(f.app, 'GET', '/uploads/limits', alice)).json().usedBytes;
  const big = (await start(f.app, alice, { purpose: 'channel', size: 9 * MiB })).json();
  assert.equal((await call(f.app, 'GET', '/uploads/limits', alice)).json().usedBytes, usedBefore + 9 * MiB);
  sockets.push(halfPut(port, alice, `/uploads/sessions/${big.id}?offset=0`, CHUNK_PLAIN, Buffer.alloc(MiB)));
  await sleep(200);
  assert.equal((await call(f.app, 'DELETE', `/uploads/sessions/${big.id}`, alice)).statusCode, 200);
  assert.equal((await call(f.app, 'GET', `/uploads/sessions/${big.id}`, alice)).statusCode, 404);
  assert.equal((await call(f.app, 'GET', '/uploads/limits', alice)).json().usedBytes, usedBefore, 'the reservation is freed at once');
  await sleep(100);
  assert.equal((await readdir(join(f.dataDir, 'uploads'))).includes(`${big.id}.part`), false);

  // The encrypted big files behave the same.
  const enc = (await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 100 })).json();
  sockets.push(halfPut(port, alice, `/e2ee/uploads/${enc.id}?offset=0`, 116, Buffer.alloc(50)));
  await sleep(200);
  assert.equal((await put(f.app, alice, enc.id, 0, randomBytes(116), '/e2ee/uploads')).statusCode, 200);
  const enc2 = (await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 100 })).json();
  sockets.push(halfPut(port, alice, `/e2ee/uploads/${enc2.id}?offset=0`, 116, Buffer.alloc(50)));
  await sleep(200);
  assert.equal((await call(f.app, 'DELETE', `/e2ee/uploads/${enc2.id}`, alice)).statusCode, 200);
});

test('a chunk that finishes after the account was deleted leaves no .part behind', async t => {
  const f = await fixture(t);
  const carol = await register(f.app, 'harden_late');
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const port = f.app.server.address().port;
  const { id } = (await start(f.app, carol, { purpose: 'channel', size: CHUNK_PLAIN + 10 })).json();
  const socket = halfPut(port, carol, `/uploads/sessions/${id}?offset=0`, CHUNK_PLAIN, Buffer.alloc(MiB));
  t.after(() => socket.destroy());
  const answer = new Promise(resolve => { let text = ''; socket.on('data', part => { text += part; }); socket.on('close', () => resolve(text)); socket.on('end', () => resolve(text)); });
  await sleep(200);
  assert.equal((await call(f.app, 'POST', '/auth/delete-account', carol, { currentPassword: PASSWORD, currentConfirmationWord: 'корабль' })).statusCode, 200);
  socket.write(Buffer.alloc(CHUNK_PLAIN - MiB)); // no FIN: a half-closed socket would be dropped before the answer
  assert.match(await answer, /^HTTP\/1\.1 (404|401)/);
  assert.deepEqual((await readdir(join(f.dataDir, 'uploads'))).filter(name => name.endsWith('.part')), []);
});

test('a plaintext upload declared as video must start like a video container; Matroska passes, a document does not', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'harden_kind');
  const doc = (await start(f.app, alice, { purpose: 'channel', size: CHUNK_PLAIN + 1, kind: 'video' })).json();
  const refused = await put(f.app, alice, doc.id, 0, Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(CHUNK_PLAIN - 9)]));
  assert.equal(refused.statusCode, 415); assert.equal(refused.json().code, 'UNSUPPORTED_MEDIA');
  assert.equal((await call(f.app, 'GET', `/uploads/sessions/${doc.id}`, alice)).statusCode, 404);
  const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(100)]);
  const id = await chunked(f.app, alice, { purpose: 'channel', kind: 'video', name: 'a.mkv', mimeType: 'video/x-matroska' }, mkv);
  assert.equal(f.sql(db => db.prepare('SELECT is_video, mime_type FROM uploads WHERE id=?').get(id)).mime_type, 'video/x-matroska');
  for (const head of [Buffer.from('\0\0\0\x08freeXXXX'), Buffer.from('\0\0\0\x08mdat'), Buffer.from('RIFF\0\0\0\0AVI LIST'), Buffer.from([0, 0, 1, 0xba, 0]), Buffer.from('FLV\x01\x05'), ts(188, 0), ts(192, 4), ts(204, 0)]) assert.equal(videoContainer(head), true, head.toString('latin1'));
  assert.equal(videoContainer(Buffer.from('%PDF-1.7')), false);
  assert.equal(videoContainer(Buffer.from('Gibberish! starting with G')), false, 'one G is not a transport stream');
  assert.equal(videoContainer(Buffer.concat([Buffer.from([0x47]), Buffer.alloc(700)])), false);
});

test('channels attach only channel uploads; the one-request encrypted upload counts chunked reservations', async t => {
  const f = await fixture(t);
  const owner = await register(f.app, 'harden_channel');
  const server = (await call(f.app, 'POST', '/communities', owner, { kind: 'server', name: 'Клан' })).json().community;
  const general = server.channels.find(c => c.kind === 'text');
  const post = await chunked(f.app, owner, { purpose: 'post', name: 'p.jpg' }, jpeg(100));
  assert.equal((await call(f.app, 'POST', `/communities/${server.id}/channels/${general.id}/messages`, owner, { attachmentId: post })).statusCode, 404);
  const channel = await chunked(f.app, owner, { purpose: 'channel', name: 'c.jpg' }, jpeg(100));
  assert.equal((await call(f.app, 'POST', `/communities/${server.id}/channels/${general.id}/messages`, owner, { attachmentId: channel })).statusCode, 200);

  // 60 MiB storage: a 59.99 MiB reservation leaves no room for a one-request encrypted file.
  const holder = await register(f.app, 'harden_quota');
  assert.equal((await start(f.app, holder, { purpose: 'channel', size: 60 * MiB - 1000, kind: 'video' })).statusCode, 413, 'over the 16 MiB video limit');
  for (let i = 0; i < 4; i++) assert.equal((await start(f.app, holder, { purpose: 'channel', size: 15 * MiB - 250, kind: 'video' })).statusCode, 201);
  const enc = multipart(randomBytes(4096), 'encrypted.bin', 'application/octet-stream');
  assert.equal((await call(f.app, 'POST', '/e2ee/files', holder, enc.payload, enc.headers)).statusCode, 413);
});

test('abandoned sessions are swept at startup with their .part files', async t => {
  const f = await fixture(t);
  const alice = await register(f.app, 'harden_sweep');
  const plain = (await start(f.app, alice, { purpose: 'channel', size: 8 * MiB })).json();
  await put(f.app, alice, plain.id, 0, randomBytes(CHUNK_PLAIN));
  const enc = (await call(f.app, 'POST', '/e2ee/uploads', alice, { size: 6 * MiB })).json();
  await put(f.app, alice, enc.id, 0, randomBytes(CHUNK_PLAIN + 16), '/e2ee/uploads');
  f.sql(db => { db.prepare('UPDATE plain_upload_sessions SET updated_at=0').run(); db.prepare('UPDATE e2ee_upload_sessions SET updated_at=0').run(); });
  await f.restart();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.sql(db => db.prepare('SELECT COUNT(*) AS n FROM plain_upload_sessions').get().n), 0);
  assert.equal(f.sql(db => db.prepare('SELECT COUNT(*) AS n FROM e2ee_upload_sessions').get().n), 0);
  assert.deepEqual((await readdir(join(f.dataDir, 'uploads'))).filter(name => name.endsWith('.part')), []);
});
