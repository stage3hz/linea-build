// Channel files, posts and stories above 20 MB: never refused for their size, cleaned by the streamed cleaner
// (the same one as the encrypted big files) and uploaded as plaintext in resumable 4 MiB chunks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';
import { nodeSignalBridge as bridge } from './support/signal-node.mjs';
import { bigMp4, GPS } from './support/stream-fixtures.mjs';

const MiB = 1024 * 1024, GiB = 1024 * MiB, CHUNK = 4 * MiB;
function harness({ limits = { platina: false, maxFileBytes: 2 * GiB, maxVideoBytes: 10 * GiB }, dropReplyAt = -1, prepared } = {}) {
  const files = new Map(), server = { file: Buffer.alloc(0), sessions: [], completed: 0, deleted: [], multipart: [], puts: [], cancels: 0 };
  const calls = { prepared: 0, disposed: 0 };
  let putCount = 0;
  class FileHandle { constructor(uri) { this.uri = uri; this.offset = 0; } readBytes(n) { const b = files.get(this.uri).subarray(this.offset, this.offset + n); this.offset += b.length; return new Uint8Array(b); } close() {} }
  class File { constructor(uri) { this.uri = uri; } get size() { return files.get(this.uri)?.length ?? 0; } open() { return new FileHandle(this.uri); } }
  const legacy = { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, FileSystemUploadType: { BINARY_CONTENT: 0 },
    async writeAsStringAsync(uri, value) { files.set(uri, Buffer.from(value, 'base64')); },
    async readAsStringAsync(uri) { return files.get(uri).toString('base64'); },
    async deleteAsync(uri) { files.delete(uri); },
    async getInfoAsync(uri) { return { exists: files.has(uri), isDirectory: false, size: files.get(uri)?.length ?? 0 }; },
    createUploadTask(url, from, options) {
      const task = { cancelled: false, uploadAsync: () => (server.hold ? server.hold(task) : Promise.resolve()).then(() => task.cancelled ? null : legacy.put(url, from, options)), cancelAsync: async () => { task.cancelled = true; server.cancels++; task.release?.(); } };
      return task;
    },
    async put(url, from, options) {
      assert.equal(options.httpMethod, 'PUT'); assert.equal(options.headers.Authorization, 'Bearer token');
      const offset = Number(new URL(url).searchParams.get('offset')), chunk = files.get(from);
      server.puts.push({ offset, length: chunk.length });
      if (server.lost) { server.lost = false; server.file = Buffer.alloc(0); return { status: 409, body: JSON.stringify({ code: 'UPLOAD_LOST' }) }; }
      if (offset !== server.file.length) return { status: 409, body: JSON.stringify({ code: 'OFFSET_MISMATCH', received: server.file.length }) };
      server.file = Buffer.concat([server.file, chunk]);
      // The chunk got through but the reply was lost on the way back.
      if (putCount++ === dropReplyAt) return null;
      return { status: 200, body: JSON.stringify({ received: server.file.length }) };
    },
  };
  const pipeline = { prepareMediaForUpload: async file => {
    calls.prepared++;
    if (!prepared) throw new Error('unsupported codec');
    const out = prepared(file); files.set(out.file.uri, out.bytes);
    return { ...out, dispose: async () => { calls.disposed++; } };
  } };
  const mocks = {
    'react-native': { Platform: { OS: 'android' } }, 'expo-file-system': { File }, 'expo-file-system/legacy': legacy, 'expo-sharing': {},
    'expo-crypto': { randomUUID, getRandomBytesAsync: async n => new Uint8Array(randomBytes(n)) },
    './signal': { getSignalBridge: () => bridge },
    './media/pipeline': pipeline, './pipeline': pipeline, '../media/pipeline': pipeline,
    '../media/thumbnail': { makeThumbnail: async () => undefined },
    'base64-js': { fromByteArray: bytes => Buffer.from(bytes).toString('base64'), toByteArray: value => new Uint8Array(Buffer.from(value, 'base64')) },
  };
  const { Api } = loadTs(new URL('../src/api.ts', import.meta.url), mocks);
  const api = new Api('https://api.test', 'token');
  api.request = async (path, options = {}) => {
    const method = options.method || 'GET';
    if (path === '/uploads/limits') return { ...limits, storageBytes: 20 * GiB, usedBytes: 0, chunkBytes: CHUNK };
    if (path === '/uploads/sessions' && method === 'POST') { server.sessions.push(JSON.parse(options.body)); return { id: `s${server.sessions.length}` }; }
    const m = /^\/uploads\/sessions\/(s\d+)(\/complete)?$/.exec(path);
    if (m && method === 'GET') return { received: server.file.length };
    if (m && method === 'DELETE') { server.deleted.push(m[1]); return { ok: true }; }
    if (m && m[2]) { server.completed++; const s = server.sessions.at(-1); return { attachment: { id: '11111111-1111-4111-8111-111111111111', name: s.name, mimeType: s.mimeType, size: server.file.length } }; }
    if (path.startsWith('/uploads?purpose=') && method === 'POST') { server.multipart.push({ path, body: Buffer.from(options.body) }); return { attachment: { id: 'small', name: 'x', mimeType: 'video/mp4', size: 1 } }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, files, server, calls };
}

test('a 21 MiB channel video skips the 20 MB pipeline and goes through the streamed cleaner: no GPS leaves the device', async () => {
  const h = harness(), { bytes } = bigMp4();
  h.files.set('file:///user/VID_0001.mp4', bytes);
  assert.ok(bytes.includes(Buffer.from('GPS-SECRET')), 'the fixture carries a location');
  const progress = [];
  const attachment = await h.api.uploadChannelFile({ uri: 'file:///user/VID_0001.mp4', name: 'VID_0001.mp4', mimeType: 'video/mp4', size: bytes.length }, { onProgress: (sent, total) => progress.push([sent, total]) });
  assert.equal(h.calls.prepared, 0, 'never read whole into memory by the 20 MB pipeline');
  assert.deepEqual(h.server.sessions, [{ purpose: 'channel', size: bytes.length, kind: 'video', name: 'VID_0001.mp4', mimeType: 'video/mp4' }]);
  assert.equal(h.server.completed, 1);
  assert.equal(h.server.file.length, bytes.length);
  assert.equal(h.server.file.includes(Buffer.from('GPS-SECRET')), false, 'the uploaded bytes are the cleaned stream');
  assert.equal(h.server.file.includes(Buffer.from('iPhone 15 Pro')), false);
  assert.ok(h.server.puts.every((p, i, all) => p.offset === i * CHUNK && (p.length === CHUNK || i === all.length - 1)), '4 MiB chunks in order');
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
  assert.deepEqual(attachment.media, { width: 1920, height: 1080, durationMs: 2000 });
  assert.equal(h.server.multipart.length, 0);
  assert.equal([...h.files.keys()].some(uri => uri.includes('linea-plain-up-')), false, 'temporary chunk files are removed');
});

test('a resumed upload continues the same session with exactly the same cleaned bytes', async () => {
  const h = harness(), { bytes } = bigMp4();
  h.files.set('file:///user/v.mov', bytes);
  const file = { uri: 'file:///user/v.mov', name: 'v.mov', mimeType: 'video/quicktime', size: bytes.length };
  let state; const abort = new AbortController(); let n = 0;
  await assert.rejects(h.api.uploadChannelFile(file, { onState: s => { state = s; }, signal: abort.signal, onProgress: () => { if (++n === 3) abort.abort(); } }), /отменена/);
  const before = h.server.file.length;
  assert.ok(before > 0 && before < bytes.length && h.server.completed === 0);
  assert.deepEqual(h.server.deleted, [], 'a caller that keeps the state keeps the server session');
  await h.api.uploadChannelFile(file, { state });
  assert.equal(h.server.sessions.length, 1, 'same server session');
  assert.equal(h.server.puts[h.server.puts.length - Math.ceil((bytes.length - before) / CHUNK)].offset, before, 'continued from the confirmed offset');
  const fresh = harness(); fresh.files.set('file:///user/v.mov', bytes);
  await fresh.api.uploadChannelFile(file);
  assert.deepEqual(h.server.file, fresh.server.file, 'resume reproduced the cleaned stream byte for byte');
  assert.equal(h.server.file.includes(Buffer.from('GPS-SECRET')), false);
});

test('a lost chunk reply: the chunk is not sent twice, the upload goes on from what the server has', async () => {
  const h = harness({ dropReplyAt: 1 }), { bytes } = bigMp4();
  h.files.set('file:///user/a.mp4', bytes);
  await h.api.uploadChannelFile({ uri: 'file:///user/a.mp4', name: 'a.mp4', mimeType: 'video/mp4', size: bytes.length });
  assert.equal(h.server.file.length, bytes.length);
  assert.deepEqual(h.server.puts.slice(1, 3).map(p => p.offset), [CHUNK, CHUNK], 'one retry of the lost chunk, answered 409 with the new offset');
  assert.equal(h.server.puts[3].offset, 2 * CHUNK);
});

test('a failed upload without resume state frees the server reservation', async () => {
  const h = harness(), { bytes } = bigMp4();
  h.files.set('file:///user/a.mp4', bytes);
  const abort = new AbortController(); let n = 0;
  await assert.rejects(h.api.uploadChannelFile({ uri: 'file:///user/a.mp4', name: 'a.mp4', mimeType: 'video/mp4', size: bytes.length }, { signal: abort.signal, onProgress: () => { if (++n === 2) abort.abort(); } }), /отменена/);
  assert.deepEqual(h.server.deleted, ['s1']);
});

test('small files keep the one-request path; a video whose cleaned copy is above 20 MB is streamed from the original', async () => {
  const small = harness({ prepared: () => ({ file: { uri: 'file:///cache/clean.mp4', name: 'v.mp4', mimeType: 'video/mp4', size: 4 }, bytes: Buffer.from('mp4!'), video: true, photo: false }) });
  small.files.set('file:///user/v.mp4', Buffer.from('original'));
  await small.api.uploadChannelFile({ uri: 'file:///user/v.mp4', name: 'v.mp4', mimeType: 'video/mp4', size: 8 });
  assert.equal(small.server.multipart.length, 1); assert.equal(small.server.multipart[0].path, '/uploads?purpose=channel');
  assert.ok(small.server.multipart[0].body.includes(Buffer.from('mp4!')), 'the cleaned copy is what is sent');
  assert.equal(small.server.sessions.length, 0); assert.equal(small.calls.disposed, 1);

  const { bytes } = bigMp4();
  const grown = harness({ prepared: () => ({ file: { uri: 'file:///cache/clean.mp4', name: 'v.mp4', mimeType: 'video/mp4', size: 25 * MiB }, bytes: Buffer.alloc(8), video: true, photo: false }) });
  grown.files.set('file:///user/v.mp4', bytes);
  // The picker said 19 MB; after the remux the clean copy is over the one-request limit.
  await grown.api.uploadChannelFile({ uri: 'file:///user/v.mp4', name: 'v.mp4', mimeType: 'video/mp4', size: 19 * MiB });
  assert.equal(grown.calls.prepared, 1); assert.equal(grown.calls.disposed, 1);
  assert.equal(grown.server.multipart.length, 0); assert.equal(grown.server.sessions[0].kind, 'video');
  assert.equal(grown.server.file.includes(Buffer.from('GPS-SECRET')), false);

  // The native remux failed (unusual codec): the streamed cleaner takes it instead of an error.
  const fallback = harness();
  fallback.files.set('file:///user/x.mp4', bytes);
  await fallback.api.uploadChannelFile({ uri: 'file:///user/x.mp4', name: 'x.mp4', mimeType: 'video/mp4', size: 1000 });
  assert.equal(fallback.calls.prepared, 1); assert.equal(fallback.server.sessions.length, 1);
  assert.equal(fallback.server.file.includes(Buffer.from('GPS-SECRET')), false);
});

test('posts and stories: big videos go in chunks as purpose=post; content a post cannot show is refused before any upload', async () => {
  const h = harness(), { bytes } = bigMp4();
  h.files.set('file:///user/post.mp4', bytes);
  await h.api.upload({ uri: 'file:///user/post.mp4', name: 'post.mp4', mimeType: 'video/mp4', size: bytes.length }, { purpose: 'post' });
  assert.equal(h.server.sessions[0].purpose, 'post'); assert.equal(h.server.sessions[0].kind, 'video');
  assert.equal(h.server.file.includes(Buffer.from('GPS-SECRET')), false);
  const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(21 * MiB)]);
  const other = harness(); other.files.set('file:///user/clip.mkv', mkv);
  await assert.rejects(other.api.upload({ uri: 'file:///user/clip.mkv', name: 'clip.mkv', mimeType: 'video/x-matroska', size: mkv.length }, { purpose: 'post' }), /Публикация — фото или видео MP4\/MOV/);
  assert.equal(other.server.sessions.length, 0);
  // Without purpose (avatar, banner) the profile keeps its small limit.
  await assert.rejects(other.api.upload({ uri: 'file:///user/post.mp4', name: 'post.mp4', mimeType: 'video/mp4', size: 21 * MiB }), /до 20 МБ/);
});

test('channel: a video the app cannot clean needs consent; a document goes unchanged; limits come from the server', async () => {
  const h = harness(), odd = randomBytes(21 * MiB);
  h.files.set('file:///user/clip.rm', odd);
  const clip = { uri: 'file:///user/clip.rm', name: 'clip.rm', mimeType: 'video/vnd.rn-realvideo', size: odd.length };
  await assert.rejects(h.api.uploadChannelFile(clip), /нельзя очистить от метаданных/, 'never sent silently');
  assert.equal(h.server.sessions.length, 0);
  const sent = await h.api.uploadChannelFile({ ...clip, sendUncleaned: true });
  assert.equal(h.server.sessions[0].kind, 'file'); assert.equal(h.server.sessions[0].mimeType, 'application/octet-stream');
  assert.equal(sent.media, undefined);

  const doc = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(21 * MiB)]);
  const d = harness(); d.files.set('file:///user/a.pdf', doc);
  await d.api.uploadChannelFile({ uri: 'file:///user/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: doc.length });
  assert.deepEqual(d.server.file, doc); assert.equal(d.server.sessions[0].kind, 'file');

  const limited = harness({ limits: { platina: false, maxFileBytes: 10 * MiB, maxVideoBytes: 10 * MiB } });
  limited.files.set('file:///user/a.pdf', doc);
  await assert.rejects(limited.api.uploadChannelFile({ uri: 'file:///user/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: doc.length }), /Файл больше 10 МБ. С Platina/);
  assert.equal(limited.server.sessions.length, 0);
});

test('the server lost the part file (409 UPLOAD_LOST): the old session is dropped and a new one starts once', async () => {
  const h = harness(), { bytes } = bigMp4();
  h.files.set('file:///user/a.mp4', bytes);
  let n = 0;
  await h.api.uploadChannelFile({ uri: 'file:///user/a.mp4', name: 'a.mp4', mimeType: 'video/mp4', size: bytes.length }, { onProgress: () => { if (++n === 3) h.server.lost = true; } });
  assert.deepEqual(h.server.deleted, ['s1']);
  assert.equal(h.server.sessions.length, 2);
  assert.equal(h.server.file.length, bytes.length);
  assert.equal(h.server.file.includes(Buffer.from('GPS-SECRET')), false);
});

test('«Отмена» cancels the chunk in flight (upload task), not only between chunks', async () => {
  const h = harness(), { bytes } = bigMp4();
  h.files.set('file:///user/a.mp4', bytes);
  const abort = new AbortController();
  h.server.hold = task => new Promise(resolve => { task.release = resolve; setTimeout(() => abort.abort(), 10); });
  await assert.rejects(h.api.uploadChannelFile({ uri: 'file:///user/a.mp4', name: 'a.mp4', mimeType: 'video/mp4', size: bytes.length }, { signal: abort.signal }), /отменена/);
  assert.equal(h.server.cancels, 1);
  assert.equal(h.server.file.length, 0);
});

test('after five failed retries the text depends on whether the caller can resume', async () => {
  const core = loadTs(new URL('../src/media/plainUploadCore.ts', import.meta.url), {
    'react-native': { Platform: { OS: 'android' } }, 'expo-file-system': { File: class {} }, 'expo-file-system/legacy': {}, 'expo-sharing': {},
    'expo-crypto': { randomUUID, getRandomBytesAsync: async n => new Uint8Array(randomBytes(n)) }, './signal': { getSignalBridge: () => bridge },
    '../media/pipeline': {}, '../media/thumbnail': {}, '../api': { CLIENT_HEADER: 'test', multipartFile: () => ({}) },
  });
  const data = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(100)]);
  const io = { open: async () => ({ size: data.length, read: async (o, l) => new Uint8Array(data.subarray(o, o + l)), close: () => {} }), put: async () => null, bigPhoto: async () => { throw new Error('no'); }, wait: async () => {} };
  const api = { token: 't', authHeaders: { Authorization: 'Bearer t' }, ensureProof: async () => {}, request: async (path, options = {}) => path === '/uploads/sessions' ? { id: 's1' } : path === '/uploads/limits' ? { platina: false, maxFileBytes: GiB, maxVideoBytes: GiB } : { ok: true } };
  const file = { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf' };
  await assert.rejects(core.uploadPlainChunked(api, file, io, { purpose: 'channel' }), /Отправь файл ещё раз/);
  await assert.rejects(core.uploadPlainChunked(api, file, io, { purpose: 'channel', onState: () => {} }), /продолжится с того же места/);
});

test('409 UPLOAD_BUSY (an earlier request still on the server) is waited out without spending the five retries', async () => {
  const core = loadTs(new URL('../src/media/plainUploadCore.ts', import.meta.url), {
    'react-native': { Platform: { OS: 'android' } }, 'expo-file-system': { File: class {} }, 'expo-file-system/legacy': {}, 'expo-sharing': {},
    'expo-crypto': { randomUUID, getRandomBytesAsync: async n => new Uint8Array(randomBytes(n)) }, './signal': { getSignalBridge: () => bridge },
    '../media/pipeline': {}, '../media/thumbnail': {}, '../api': { CLIENT_HEADER: 'test', multipartFile: () => ({}) },
  });
  const data = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(100)]);
  let busy = 8, pauses = 0;
  const io = { open: async () => ({ size: data.length, read: async (o, l) => new Uint8Array(data.subarray(o, o + l)), close: () => {} }),
    put: async () => busy-- > 0 ? { status: 409, body: { code: 'UPLOAD_BUSY' } } : { status: 200, body: { received: data.length } },
    bigPhoto: async () => { throw new Error('no'); }, wait: async () => {}, busyWait: async () => { pauses++; } };
  const api = { token: 't', authHeaders: { Authorization: 'Bearer t' }, ensureProof: async () => {}, request: async path => path === '/uploads/sessions' ? { id: 's1' } : path === '/uploads/limits' ? { platina: false, maxFileBytes: GiB, maxVideoBytes: GiB } : path.endsWith('/complete') ? { attachment: { id: 'x', size: data.length } } : { ok: true } };
  const attachment = await core.uploadPlainChunked(api, { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }, io, { purpose: 'channel' });
  assert.equal(attachment.size, data.length); assert.equal(pauses, 8);
});

test('encrypted big file: 409 UPLOAD_LOST (part file gone after a failover) restarts the upload once in a new session', async () => {
  const files = new Map(), server = { file: Buffer.alloc(0), posts: 0, deleted: [], lostOnce: true };
  class FileHandle { constructor(uri) { this.uri = uri; this.offset = 0; } readBytes(n) { const b = files.get(this.uri).subarray(this.offset, this.offset + n); this.offset += b.length; return new Uint8Array(b); } close() {} }
  class File { constructor(uri) { this.uri = uri; } get size() { return files.get(this.uri)?.length ?? 0; } open() { return new FileHandle(this.uri); } }
  const legacy = { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, FileSystemUploadType: { BINARY_CONTENT: 0 },
    async writeAsStringAsync(uri, value) { files.set(uri, Buffer.from(value, 'base64')); }, async readAsStringAsync(uri) { return files.get(uri).toString('base64'); },
    async deleteAsync(uri) { files.delete(uri); }, async getInfoAsync(uri) { return { exists: files.has(uri), isDirectory: false, size: files.get(uri)?.length ?? 0 }; },
    async uploadAsync(url, from) {
      const offset = Number(new URL(url).searchParams.get('offset'));
      if (offset > 0 && server.lostOnce) { server.lostOnce = false; return { status: 409, body: JSON.stringify({ code: 'UPLOAD_LOST' }) }; }
      if (offset !== server.file.length) return { status: 409, body: JSON.stringify({ received: server.file.length }) };
      server.file = Buffer.concat([server.file, files.get(from)]); return { status: 200, body: '{}' };
    } };
  const mod = loadTs(new URL('../src/e2ee/attachments.ts', import.meta.url), {
    'react-native': { Platform: { OS: 'android' } }, 'expo-file-system': { File }, 'expo-file-system/legacy': legacy, 'expo-sharing': {},
    'expo-crypto': { randomUUID, getRandomBytesAsync: async n => new Uint8Array(randomBytes(n)) }, './signal': { getSignalBridge: () => bridge },
    '../media/pipeline': { prepareMediaForUpload: async () => { throw new Error('unused'); } }, '../media/thumbnail': { makeThumbnail: async () => undefined },
    '../api': { CLIENT_HEADER: 'test', multipartFile: bytes => ({ body: bytes, contentType: 'x' }) }, '../attest/index': { attestHeaders: () => ({}) },
    'base64-js': { fromByteArray: bytes => Buffer.from(bytes).toString('base64'), toByteArray: value => new Uint8Array(Buffer.from(value, 'base64')) },
  });
  const api = { endpoint: 'https://api.test', token: 'token', authHeaders: { Authorization: 'Bearer token' }, ensureProof: async () => {}, async request(path, options = {}) {
    if (path === '/e2ee/limits') return { platina: false, maxFileBytes: 2 * GiB, maxVideoBytes: 10 * GiB, storageBytes: 20 * GiB, usedBytes: 0, chunkBytes: CHUNK };
    if (path === '/e2ee/uploads' && options.method === 'POST') { server.posts++; server.file = Buffer.alloc(0); return { id: `e${server.posts}` }; }
    if (options.method === 'DELETE') { server.deleted.push(path); return { ok: true }; }
    if (path.endsWith('/complete')) return { id: '11111111-1111-4111-8111-111111111111', size: server.file.length };
    throw new Error(`unexpected ${path}`);
  } };
  const doc = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(21 * MiB)]);
  files.set('file:///user/a.pdf', doc);
  const states = [];
  const attachment = await mod.encryptAndUploadLarge(api, { uri: 'file:///user/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }, { onState: state => states.push({ ...state }) });
  const keys = new Set(states.map(state => state.key));
  assert.ok(keys.size >= 2, 'the restart from byte 0 uses new key material');
  assert.equal(attachment.encryption.key, states.at(-1).key, 'the attachment carries the key of the upload that completed');
  assert.notEqual(attachment.encryption.nonce, states[0].nonce);
  assert.equal(server.posts, 2); assert.deepEqual(server.deleted, ['/e2ee/uploads/e1']);
  assert.equal(server.file.length, mod.chunkedCipherSize(doc.length)); assert.equal(attachment.size, doc.length);
});
