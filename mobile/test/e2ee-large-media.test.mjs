// Big photos/videos are cleaned before the chunked encrypted upload (the >20 MB bypass leaked GPS and device data).
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';
import { nodeSignalBridge as bridge } from './support/signal-node.mjs';
import { bigMp4, GPS } from './support/stream-fixtures.mjs';
import { atom } from './support/mp4-fixture.mjs';

const MiB = 1024 * 1024, GiB = 1024 * MiB;
function harness({ limits = { platina: false, maxFileBytes: 2 * GiB, maxVideoBytes: 10 * GiB }, dropAfter = -1, photo, passthrough = false } = {}) {
  const files = new Map(), server = { file: Buffer.alloc(0), posts: [], completed: false }; let puts = 0;
  class FileHandle { constructor(uri) { this.uri = uri; this.offset = 0; } readBytes(n) { const b = files.get(this.uri).subarray(this.offset, this.offset + n); this.offset += b.length; return new Uint8Array(b); } close() {} }
  class File { constructor(uri) { this.uri = uri; } get size() { return files.get(this.uri)?.length ?? 0; } open() { return new FileHandle(this.uri); } }
  const legacy = { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, FileSystemUploadType: { BINARY_CONTENT: 0 },
    async writeAsStringAsync(uri, value) { files.set(uri, Buffer.from(value, 'base64')); },
    async readAsStringAsync(uri) { return files.get(uri).toString('base64'); },
    async deleteAsync(uri) { files.delete(uri); },
    async getInfoAsync(uri) { return { exists: files.has(uri), isDirectory: false, size: files.get(uri)?.length ?? 0 }; },
    async uploadAsync(url, from) {
      if (puts++ === dropAfter) return null;
      const offset = Number(new URL(url).searchParams.get('offset'));
      if (offset !== server.file.length) return { status: 409, body: JSON.stringify({ received: server.file.length }) };
      server.file = Buffer.concat([server.file, files.get(from)]); return { status: 200, body: '{}' };
    },
  };
  const calls = { prepared: 0, thumbnails: 0 };
  const mod = loadTs(new URL('../src/e2ee/attachments.ts', import.meta.url), {
    'react-native': { Platform: { OS: 'android' } }, 'expo-file-system': { File }, 'expo-file-system/legacy': legacy, 'expo-sharing': {},
    'expo-crypto': { randomUUID, getRandomBytesAsync: async n => new Uint8Array(randomBytes(n)) },
    './signal': { getSignalBridge: () => bridge },
    '../media/pipeline': { prepareMediaForUpload: async file => { calls.prepared++; if (passthrough) return { file, photo: false, video: false, dispose: async () => {} }; if (!photo) throw new Error('unsupported codec'); files.set('file:///cache/clean.jpg', photo); return { file: { uri: 'file:///cache/clean.jpg', name: 'photo.jpg', mimeType: 'image/jpeg', size: photo.length }, photo: true, media: { width: 2, height: 2 }, dispose: async () => {} }; } },
    '../photo/jpeg': { sanitizeJpeg: bytes => ({ bytes }) },
    '../photo/jpegHdr': { sanitizePhotoJpeg: bytes => ({ bytes }) },
    '../media/thumbnail': { makeThumbnail: async () => { calls.thumbnails++; return undefined; } },
    '../api': { CLIENT_HEADER: 'test', multipartFile: bytes => ({ body: bytes, contentType: 'application/octet-stream' }) },
    '../attest/index': { attestHeaders: () => ({}) },
    'base64-js': { fromByteArray: bytes => Buffer.from(bytes).toString('base64'), toByteArray: value => new Uint8Array(Buffer.from(value, 'base64')) },
  });
  const api = { endpoint: 'https://api.test', token: 'token', fileUrl: id => `https://api.test/files/${id}`,
    async request(path, options = {}) {
      if (path === '/e2ee/limits') return { ...limits, storageBytes: 20 * GiB, usedBytes: 0, chunkBytes: 4 * MiB };
      if (path === '/e2ee/uploads' && options.method === 'POST') { server.posts.push(JSON.parse(options.body)); return { id: 'session-1' }; }
      if (path === '/e2ee/uploads/session-1') return { received: server.file.length };
      if (path === '/e2ee/uploads/session-1/complete') { server.completed = true; return { id: '11111111-1111-4111-8111-111111111111', size: server.file.length }; }
      if (path === '/e2ee/files') return { id: '22222222-2222-4222-8222-222222222222', size: 0 };
      throw new Error(`unexpected ${path}`);
    } };
  return { mod, api, files, server, calls };
}
async function decrypt(h, attachment) {
  const chunks = []; const full = 4 * MiB + 16;
  for (let i = 0, n = Math.ceil(attachment.size / (4 * MiB)); i < n; i++) {
    const plain = await bridge.open(h.server.file.subarray(i * full, (i + 1) * full).toString('base64'), attachment.encryption.key, h.mod.chunkNonce(attachment.encryption.nonce, i), h.mod.chunkAd(attachment.encryption.fileKeyId, i, n));
    chunks.push(Buffer.from(plain, 'base64'));
  }
  return Buffer.concat(chunks);
}

test('a 21 MiB camera MP4 is cleaned before the chunked upload, sent as kind=video with size and duration', async () => {
  const h = harness(), { bytes } = bigMp4();
  h.files.set('file:///user/VID_0001.mp4', bytes);
  const attachment = await h.mod.encryptAndUpload(h.api, { uri: 'file:///user/VID_0001.mp4', name: 'VID_0001.mp4', mimeType: 'video/mp4', size: bytes.length });
  assert.equal(h.calls.prepared, 0, 'big files never go through the 20 MB pipeline');
  assert.deepEqual(h.server.posts, [{ size: bytes.length, kind: 'video' }]);
  assert.equal(attachment.encryption.scheme, 'aes-256-gcm-siv-chunked');
  assert.equal(attachment.mimeType, 'video/mp4');
  assert.deepEqual(attachment.media, { width: 1920, height: 1080, durationMs: 2000 });
  const plain = await decrypt(h, attachment);
  assert.equal(plain.length, bytes.length);
  assert.equal(plain.includes(Buffer.from('GPS-SECRET')), false);
  assert.ok(bytes.includes(Buffer.from('GPS-SECRET')));
});

test('a resumed upload continues with exactly the same cleaned bytes', async () => {
  const h = harness({ dropAfter: 2 }), { bytes } = bigMp4(); // one lost chunk reply, then an interruption
  h.files.set('file:///user/v.mov', bytes);
  let state; const file = { uri: 'file:///user/v.mov', name: 'v.mov', mimeType: 'video/quicktime' };
  // uploadAsync returning null six times would take minutes with the back-off: simulate one lost chunk by aborting instead.
  const abort = new AbortController(); let n = 0;
  await assert.rejects(h.mod.encryptAndUploadLarge(h.api, file, { onState: s => state = s, signal: abort.signal, onProgress: () => { if (++n === 3) abort.abort(); } }), /отменена/);
  const before = h.server.file.length; assert.ok(before > 0 && !h.server.completed);
  const attachment = await h.mod.encryptAndUploadLarge(h.api, file, { state });
  assert.equal(h.server.posts.length, 1, 'same server session');
  const plain = await decrypt(h, attachment);
  const fresh = harness(); fresh.files.set('file:///user/v.mov', bytes);
  const reference = await decrypt(fresh, await fresh.mod.encryptAndUploadLarge(fresh.api, file));
  assert.deepEqual(plain, reference, 'resume reproduced the cleaned stream byte for byte');
});

test('documents, voice notes and video-like files without a cleaner keep their bytes and use the file limit', async () => {
  const h = harness();
  const doc = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(21 * MiB)]);
  h.files.set('file:///user/a.pdf', doc);
  const a = await h.mod.encryptAndUploadLarge(h.api, { uri: 'file:///user/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' });
  assert.deepEqual(h.server.posts.at(-1), { size: doc.length, kind: 'file' });
  assert.deepEqual(await decrypt(h, a), doc);
  // A real voice take: ftyp, the AAC data, then the index with one sound track (as the recorder writes it).
  const sound = atom('trak', atom('tkhd', Buffer.alloc(84)), atom('mdia', atom('mdhd', Buffer.alloc(24)), atom('hdlr', Buffer.from('\0\0\0\0\0\0\0\0soun\0\0\0\0\0\0\0\0\0\0\0\0\0')), atom('minf', atom('smhd', Buffer.alloc(8)))));
  const mvhdBox = atom('mvhd', Buffer.alloc(100));
  const voice = Buffer.concat([atom('ftyp', Buffer.from('M4A \0\0\0\0M4A isom')), atom('mdat', randomBytes(21 * MiB)), atom('moov', mvhdBox, sound)]);
  const hv = harness(); hv.files.set('file:///cache/voice-1.m4a', voice);
  const v = await hv.mod.encryptAndUploadLarge(hv.api, { uri: 'file:///cache/voice-1.m4a', name: 'voice-1730000000000.m4a', mimeType: 'audio/mp4' });
  assert.equal(v.name, 'voice-1730000000000.m4a'); assert.equal(v.mimeType, 'audio/mp4');
  assert.deepEqual(await decrypt(hv, v), voice, 'a long voice message goes chunked and unchanged');
  const h2 = harness(), odd = randomBytes(21 * MiB);
  h2.files.set('file:///user/clip.rm', odd);
  const clip = { uri: 'file:///user/clip.rm', name: 'clip.rm', mimeType: 'video/vnd.rn-realvideo' };
  await assert.rejects(h2.mod.encryptAndUploadLarge(h2.api, clip), /нельзя очистить от метаданных/, 'never sent silently');
  assert.equal(h2.server.posts.length, 0);
  assert.equal(await h2.mod.needsUncleanedConsent(clip), true);
  const b = await h2.mod.encryptAndUploadLarge(h2.api, { ...clip, sendUncleaned: true });
  assert.equal(b.mimeType, 'application/octet-stream', 'confirmed: only as a plain file, never as playable media');
  assert.equal(h2.server.posts.at(-1).kind, 'file');
  assert.equal(b.media, undefined);
});

test('size limits: video up to 10 GB for everyone, files 2 GB (4 GB with Platina), texts from the limits', () => {
  const { mod } = harness();
  const free = { platina: false, maxFileBytes: 2 * GiB, maxVideoBytes: 10 * GiB }, platina = { platina: true, maxFileBytes: 4 * GiB, maxVideoBytes: 10 * GiB };
  assert.equal(mod.limitError(free, 'video', 9 * GiB), null);
  assert.equal(mod.limitError(free, 'video', 11 * GiB), 'Видео больше 10 ГБ.');
  assert.equal(mod.limitError(free, 'file', 3 * GiB), 'Файл больше 2 ГБ. С Platina можно отправлять файлы до 4 ГБ.');
  assert.equal(mod.limitError(platina, 'file', 3 * GiB), null);
  assert.equal(mod.limitError(platina, 'file', 5 * GiB), 'Файл больше 4 ГБ.');
  assert.equal(mod.limitError({ platina: false, maxFileBytes: 100 * MiB }, 'video', 200 * MiB), 'Видео больше 100 МБ.', 'old server without maxVideoBytes');
});

test('a big photo is re-encoded (never sent raw) and goes as a normal photo', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]);
  const h = harness({ photo: jpeg }), raw = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('Exif GPS ' + GPS), Buffer.alloc(21 * MiB)]);
  h.files.set('file:///user/IMG.jpg', raw);
  const attachment = await h.mod.encryptAndUploadLarge(h.api, { uri: 'file:///user/IMG.jpg', name: 'IMG.jpg', mimeType: 'image/jpeg' });
  assert.equal(h.calls.prepared, 1);
  assert.equal(attachment.encryption.scheme, 'aes-256-gcm-siv');
  assert.equal(attachment.size, jpeg.length);
  assert.equal(h.server.posts.length, 0);
});

test('a small video the native remux cannot take falls back to container cleaning instead of failing', async () => {
  const h = harness(), { bytes } = bigMp4({ gap: 1024 });
  h.files.set('file:///user/prores.mov', bytes);
  const attachment = await h.mod.encryptAndUpload(h.api, { uri: 'file:///user/prores.mov', name: 'prores.mov', mimeType: 'video/quicktime', size: bytes.length });
  assert.equal(h.calls.prepared, 1);
  assert.equal(h.server.posts[0].kind, 'video');
  assert.equal((await decrypt(h, attachment)).includes(Buffer.from('GPS-SECRET')), false);
});

// Reviewer's bypass probes: content that the old byte sniffing did not recognise went out unchanged.
for (const [label, make, name, mime] of [
  ['MOV with a leading free box', () => bigMp4({ prefix: atom('free', Buffer.alloc(8)) }).bytes, 'IMG_0001.MOV', 'video/quicktime'],
  ['reviewer probe: free box prepended without fixing the offsets (damaged samples are blanked)', () => Buffer.concat([atom('free', Buffer.alloc(8)), bigMp4().bytes]), 'IMG_0002.MOV', 'video/quicktime'],
  ['MOV with a leading free box under a neutral name', () => bigMp4({ prefix: atom('free', Buffer.alloc(8)) }).bytes, 'export.bin', 'application/octet-stream'],
]) test('no bypass (large path): ' + label, async () => {
  const h = harness(), bytes = make();
  h.files.set('file:///user/' + name, bytes);
  const att = await h.mod.encryptAndUploadLarge(h.api, { uri: 'file:///user/' + name, name, mimeType: mime, size: bytes.length });
  const plain = await decrypt(h, att);
  assert.equal(plain.includes(Buffer.from(GPS)), false);
  assert.equal(h.server.posts[0].kind, 'video');
});

test('no bypass: a 25 MiB Fuji RAF is a photo (re-encoded or refused, never sent raw)', async () => {
  const raf = Buffer.alloc(25 * MiB); raf.write('FUJIFILMCCD-RAW 0201FF383501'); raf.write('GPS ' + GPS, 4096);
  const refused = harness(); refused.files.set('file:///user/DSCF0001.RAF', raf);
  await assert.rejects(refused.mod.encryptAndUploadLarge(refused.api, { uri: 'file:///user/DSCF0001.RAF', name: 'DSCF0001.RAF', mimeType: 'image/x-fuji-raf' }));
  assert.equal(refused.server.posts.length, 0);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]), ok = harness({ photo: jpeg }); ok.files.set('file:///user/x.raf', raf);
  const att = await ok.mod.encryptAndUploadLarge(ok.api, { uri: 'file:///user/x.raf', name: 'x.raf', mimeType: 'application/octet-stream' });
  assert.equal(att.size, jpeg.length);
});

test('no bypass (small path): a MOV the 20 MB pipeline passes through as a plain file is still cleaned', async () => {
  const h = harness({ passthrough: true }), bytes = bigMp4({ gap: 2048, prefix: atom('free', Buffer.alloc(8)) }).bytes;
  h.files.set('file:///user/clip.bin', bytes);
  const att = await h.mod.encryptAndUpload(h.api, { uri: 'file:///user/clip.bin', name: 'clip.bin', mimeType: 'application/octet-stream', size: bytes.length });
  assert.equal((await decrypt(h, att)).includes(Buffer.from(GPS)), false);
  assert.equal(h.server.posts[0].kind, 'video');
});

test('AI documents: photos and videos are not sent to the model as documents', () => {
  const attach = loadTs(new URL('../src/ai/attach.ts', import.meta.url), { 'expo-file-system/legacy': {}, 'expo-image-manipulator': {}, 'expo-image-picker': {}, 'expo-video-thumbnails': {}, 'expo-document-picker': {}, 'base64-js': {} });
  assert.throws(() => attach.refuseMediaDocument(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0]), 'scan.pdf', 'application/pdf'), /без метаданных/);
  assert.throws(() => attach.refuseMediaDocument(new Uint8Array(bigMp4({ gap: 64 }).bytes.subarray(0, 64)), 'a.bin', ''), /без метаданных/);
  attach.refuseMediaDocument(new Uint8Array(Buffer.from('%PDF-1.7\n')), 'a.pdf', 'application/pdf');
});
