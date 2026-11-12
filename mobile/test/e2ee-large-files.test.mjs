// Big files: chunked AES-256-GCM-SIV (real Signal AEAD), resumable upload, ranged download.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';
import { nodeSignalBridge as bridge } from './support/signal-node.mjs';

const MiB = 1024 * 1024;
function harness({ loseReplyAt = -1, maxFileBytes = 5 * 1024 * MiB, platina = true } = {}) {
  const files = new Map(); const server = { file: Buffer.alloc(0), total: 0, completed: false, deleted: false };
  class FileHandle { constructor(uri) { this.uri = uri; this.offset = 0; } readBytes(n) { const b = files.get(this.uri).subarray(this.offset, this.offset + n); this.offset += b.length; return new Uint8Array(b); } writeBytes(bytes) { files.set(this.uri, Buffer.concat([files.get(this.uri), Buffer.from(bytes)])); } close() {} }
  class File { constructor(uri) { this.uri = uri; } get size() { return files.get(this.uri)?.length ?? 0; } get exists() { return files.has(this.uri); } delete() { files.delete(this.uri); } create() { files.set(this.uri, Buffer.alloc(0)); } open() { return new FileHandle(this.uri); } }
  let puts = 0;
  const legacy = { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, FileSystemUploadType: { BINARY_CONTENT: 0 },
    async writeAsStringAsync(uri, value) { files.set(uri, Buffer.from(value, 'base64')); },
    async readAsStringAsync(uri) { return files.get(uri).toString('base64'); },
    async deleteAsync(uri) { files.delete(uri); },
    async getInfoAsync(uri) { return { exists: files.has(uri), isDirectory: false, size: files.get(uri)?.length ?? 0 }; },
    async makeDirectoryAsync() {},
    async uploadAsync(url, from, options) {
      assert.equal(options.httpMethod, 'PUT'); assert.equal(options.headers.Authorization, 'Bearer token');
      const offset = Number(new URL(url).searchParams.get('offset')); const body = files.get(from);
      if (offset !== server.file.length) return { status: 409, body: JSON.stringify({ received: server.file.length }) };
      server.file = Buffer.concat([server.file, body]);
      if (puts++ === loseReplyAt) throw new Error('connection reset');
      return { status: 200, body: JSON.stringify({ received: server.file.length }) };
    },
    async downloadAsync(url, to, options) {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
      files.set(to, server.file.subarray(Number(a), Number(b) + 1)); return { status: 206 };
    },
  };
  const mod = loadTs(new URL('../src/e2ee/attachments.ts', import.meta.url), {
    'react-native': { Platform: { OS: 'android' } }, 'expo-file-system': { File }, 'expo-file-system/legacy': legacy, 'expo-sharing': {},
    'expo-crypto': { randomUUID, getRandomBytesAsync: async n => new Uint8Array(randomBytes(n)) },
    './signal': { getSignalBridge: () => bridge },
    '../media/pipeline': { prepareMediaForUpload: async () => { throw new Error('big files skip media processing'); } },
    '../media/thumbnail': { makeThumbnail: async () => undefined },
    'base64-js': { fromByteArray: bytes => Buffer.from(bytes).toString('base64'), toByteArray: value => new Uint8Array(Buffer.from(value, 'base64')) },
  });
  const api = { base: 'https://api.test', endpoint: 'https://api.test', token: 'token', authHeaders: { Authorization: 'Bearer token' }, ensureProof: async () => {}, fileUrl: id => `https://api.test/files/${id}`,
    async request(path, options = {}) {
      if (path === '/e2ee/limits') return { platina, maxFileBytes, storageBytes: 15 * 1024 * MiB, usedBytes: 0, chunkBytes: 4 * MiB };
      if (path === '/e2ee/uploads' && options.method === 'POST') { server.total = mod.chunkedCipherSize(JSON.parse(options.body).size); return { id: 'session-1' }; }
      if (path === '/e2ee/uploads/session-1' && options.method === 'DELETE') { server.deleted = true; return { ok: true }; }
      if (path === '/e2ee/uploads/session-1') return { received: server.file.length };
      if (path === '/e2ee/uploads/session-1/complete') { assert.equal(server.file.length, server.total); server.completed = true; return { id: '11111111-1111-4111-8111-111111111111', size: server.file.length }; }
      throw new Error(`unexpected ${path}`);
    } };
  return { mod, api, files, server };
}

test('documents over 20 MB (content is not a photo or video) go in chunks unchanged', async () => {
  const h = harness();
  h.files.set('file:///user/huge.bin', Buffer.alloc(21 * MiB, 7));
  const attachment = await h.mod.encryptAndUpload(h.api, { uri: 'file:///user/huge.bin', name: 'huge.bin', mimeType: 'application/octet-stream' });
  assert.equal(attachment.encryption.scheme, 'aes-256-gcm-siv-chunked');
  assert.equal(attachment.size, 21 * MiB);
});

test('a big file is encrypted in 4 MiB chunks, survives a lost reply and decrypts back byte for byte', async () => {
  const h = harness({ loseReplyAt: 1 });
  const data = randomBytes(9 * MiB + 5); h.files.set('file:///user/movie.mkv', data); // random bytes: needs the explicit «send uncleaned» consent
  const progress = [];
  const attachment = await h.mod.encryptAndUploadLarge(h.api, { uri: 'file:///user/movie.mkv', name: 'movie.mkv', mimeType: 'video/x-matroska', sendUncleaned: true }, { onProgress: (sent, total) => progress.push([sent, total]) });
  assert.equal(attachment.size, data.length);
  assert.equal(attachment.encryption.scheme, 'aes-256-gcm-siv-chunked');
  assert.equal(attachment.encryption.chunkSize, 4 * MiB);
  assert.ok(h.server.completed); assert.equal(h.server.file.length, data.length + 3 * 16);
  assert.ok(!h.server.file.includes(data.subarray(0, 64)), 'only ciphertext reaches the server');
  assert.deepEqual(progress.at(-1), [data.length, data.length]);
  const target = 'file:///cache/out.mkv'; const fractions = [];
  await h.mod.decryptAttachmentWithProgress(h.api, attachment, f => fractions.push(f), target);
  assert.deepEqual(h.files.get(target), data);
  assert.equal(fractions.at(-1), 1);
});

test('swapped or cut chunks fail authentication and leave no plaintext behind', async () => {
  const h = harness();
  const data = randomBytes(8 * MiB + 1); h.files.set('file:///user/a.bin', data);
  const attachment = await h.mod.encryptAndUploadLarge(h.api, { uri: 'file:///user/a.bin', name: 'a.bin', mimeType: 'application/octet-stream' });
  const full = 4 * MiB + 16, original = h.server.file;
  h.server.file = Buffer.concat([original.subarray(full, 2 * full), original.subarray(0, full), original.subarray(2 * full)]);
  await assert.rejects(h.mod.decryptAttachmentWithProgress(h.api, attachment, () => {}, 'file:///cache/x.bin'), /Проверка вложения не пройдена/);
  assert.equal(h.files.has('file:///cache/x.bin'), false);
  h.server.file = original;
  await assert.rejects(h.mod.decryptAttachmentWithProgress(h.api, { ...attachment, size: 4 * MiB }, () => {}, 'file:///cache/y.bin'), /Проверка вложения не пройдена/, 'a shorter claimed size changes the chunk count in the associated data');
});

test('without Platina a file over 100 MB is refused before anything is uploaded', async () => {
  const h = harness({ platina: false, maxFileBytes: 1024 });
  h.files.set('file:///user/big.bin', Buffer.alloc(2048));
  await assert.rejects(h.mod.encryptAndUploadLarge(h.api, { uri: 'file:///user/big.bin', name: 'big.bin', mimeType: 'application/octet-stream' }), /Platina/);
  assert.equal(h.server.file.length, 0);
  assert.equal(h.mod.chunkNonce('AAAAAAAAAAAAAAAA', 1), 'AAAAAAAAAAAAAAAB');
});
