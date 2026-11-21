// Produces tests/vectors/files.json: what the reference makes of a file attached to an encrypted message.
// The reference itself is run — mobile/src/e2ee/attachments.ts (`encryptAndUpload`, `decryptAttachment`) with its
// real api.ts (`multipartFile`), png.ts, previewModel.ts and base64-js — through the loader the mobile tests use,
// and AES-256-GCM-SIV is the desktop app's official @signalapp/libsignal-client (desktop/signal.mjs). Only the
// device is stood in for: the file system, the picker's result, the random source (a fixed generator, so the
// vectors are the same on every run) and the network (the upload is recorded, the download is handed back).
//   sealed     a file as it leaves the phone: the multipart body of POST /e2ee/files and the attachment object
//   opened     a downloaded file and the attachment of the message: the plaintext, or the refusal's words
//   names, sizes, kinds, multipart   the small pure functions around them
// Run from the repository root:  node native/core/tests/generate-file-vectors.mjs
// With `--open` it is the other half of the interoperability test (tests/e2ee_files.rs): it reads one line
// `{"attachment":…,"cipher":base64}` and answers what the reference's `decryptAttachment` gives for it.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadTs } from '../../../mobile/test/support/load-ts.mjs';
import { pngChunk, pngFixture } from '../../../mobile/test/support/png-fixture.mjs';
import { jpegFixture } from '../../../mobile/test/support/jpeg-fixture.mjs';

const { desktopSignalBridge: bridge } = await import(new URL('../../../desktop/signal.mjs', import.meta.url).href);

// A fixed generator: the same cases on every run.
let seed = 0x0f11e5ed;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const below = n => Math.floor(random() * n);
const randomBytes = n => Buffer.from(Array.from({ length: n }, () => below(256)));
const randomUUID = () => { const b = randomBytes(16); b[6] = b[6] & 0x0f | 0x40; b[8] = b[8] & 0x3f | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const b64 = bytes => Buffer.from(bytes).toString('base64');

const files = new Map();
const fs = {
  cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' },
  async getInfoAsync(uri) { return { exists: files.has(uri), isDirectory: false, size: files.get(uri)?.length || 0 }; },
  async readAsStringAsync(uri) { return files.get(uri).toString('base64'); },
  async writeAsStringAsync(uri, value) { files.set(uri, Buffer.from(value, 'base64')); },
  async makeDirectoryAsync() {},
  async deleteAsync(uri) { for (const key of [...files.keys()]) if (key.startsWith(uri)) files.delete(key); },
};
let prepared = null, preview;
const cache = new Map();
const mocks = {
  'react-native': { Platform: { OS: 'ios' } }, 'expo-file-system': { File: class { constructor(uri) { this.uri = uri; } get size() { return 0; } } }, 'expo-file-system/legacy': fs, 'expo-sharing': {},
  'expo-crypto': { randomUUID, getRandomBytesAsync: async count => new Uint8Array(randomBytes(count)) },
  './signal': { getSignalBridge: () => bridge },
  '../media/pipeline': { prepareMediaForUpload: async () => prepared },
  '../media/thumbnail': { makeThumbnail: async () => preview },
};
const { encryptAndUpload, decryptAttachment, attachmentFileName } = loadTs(new URL('../../../mobile/src/e2ee/attachments.ts', import.meta.url), mocks, cache);
const { multipartFile } = loadTs(new URL('../../../mobile/src/api.ts', import.meta.url), mocks, cache);
const { createPreview } = loadTs(new URL('../../../mobile/src/media/previewModel.ts', import.meta.url), mocks, cache);
const { mediaPreviewKind } = loadTs(new URL('../../../mobile/src/media/formats.ts', import.meta.url), mocks, cache);
const { formatSize } = loadTs(new URL('../../../mobile/src/theme.tsx', import.meta.url), { ...mocks, './i18n': { getLanguage: () => 'ru' } }, new Map());

/** What the reference gives for a downloaded file: the plaintext, or the words of its refusal. */
async function open(attachment, { status = 200, claimed, cipher }) {
  const held = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: status >= 200 && status < 300, status, headers: { get: name => name.toLowerCase() === 'content-length' ? (claimed === undefined ? null : String(claimed)) : null }, arrayBuffer: async () => new Uint8Array(cipher).buffer });
  const api = { token: 't', authHeaders: {}, fileUrl: id => `https://server.example/files/${id}` };
  try {
    const made = await decryptAttachment(api, attachment);
    const plain = files.get(made.uri);
    await made.dispose();
    return { plain: b64(plain) };
  } catch (error) { return { error: String(error?.message ?? error) }; }
  finally { globalThis.fetch = held; }
}

if (process.argv.includes('--open')) {
  for await (const line of createInterface({ input: process.stdin })) {
    const { attachment, cipher } = JSON.parse(line);
    process.stdout.write(`${JSON.stringify(await open(attachment, { cipher: Buffer.from(cipher, 'base64') }))}\n`);
  }
  process.exit(0);
}

// ── A file as it leaves the phone ────────────────────────────────────────────────────────────────────────────
const sealed = [];
const privateData = Buffer.from('GPS:51.0,0.1; camera serial SECRET');
async function seal(name, file, bytes, { photo = false, media, withPreview = false } = {}) {
  files.clear();
  files.set(file.uri, Buffer.from(bytes));
  prepared = { file, photo, video: false, ...(media ? { media } : {}), dispose: async () => {} };
  preview = withPreview ? createPreview(jpegFixture()) : undefined;
  // The order the reference asks the random source in: the file's id, its key, its nonce.
  const id = randomUUID(), at = seed;
  const fileKeyId = randomUUID(), key = b64(randomBytes(32)), nonce = b64(randomBytes(12));
  seed = at;
  let upload = null;
  const api = { async request(path, options) {
    if (path !== '/e2ee/files' || options.method !== 'POST') throw new Error('the reference changed: ' + path);
    upload = { body: b64(options.body), contentType: options.headers['Content-Type'] };
    return { id, size: options.body.length };
  } };
  // The boundary of the multipart body is the only other thing taken from the device: the clock and Math.random.
  const held = [Math.random, Date.now];
  Math.random = () => 0.6180339887; Date.now = () => 1795244400000;
  let attachment;
  try { attachment = await encryptAndUpload(api, file); } finally { [Math.random, Date.now] = held; }
  if (attachment.encryption.fileKeyId !== fileKeyId || attachment.encryption.key !== key || attachment.encryption.nonce !== nonce) throw new Error('the reference asks the random source in another order: ' + name);
  const boundary = /boundary=(.+)$/.exec(upload.contentType)[1];
  // What was sealed: the picked file itself, or — for a photo — what the reference's gate left of it.
  const cipher = bodyCipher(Buffer.from(upload.body, 'base64'), boundary);
  const plain = Buffer.from(await bridge.open(b64(cipher), key, nonce, b64(`linea-attachment-v1:${fileKeyId}`)), 'base64');
  if (photo ? plain.includes(privateData) || plain.length >= bytes.length && withPreview : !plain.equals(Buffer.from(bytes))) throw new Error('the reference sealed something else: ' + name);
  if (attachment.size !== plain.length || attachment.id !== id) throw new Error('the reference describes another file: ' + name);
  sealed.push({ name, fileName: file.name, mimeType: file.mimeType, plain: b64(plain), id, key, nonce, fileKeyId, ...(media ? { media: JSON.stringify(media) } : {}), ...(preview ? { preview: JSON.stringify(preview) } : {}), boundary, contentType: upload.contentType, body: upload.body, attachment: JSON.stringify(attachment) });
  return { attachment, cipher };
}
const bodyCipher = (body, boundary) => body.subarray(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`)));
const doc = (name, mimeType) => ({ uri: 'file:///picked/source.bin', name, mimeType });

const first = await seal('a small document', doc('Договор № 7 (черновик).pdf', 'application/pdf'), randomBytes(4096));
await seal('one byte', doc('a', 'text/plain'), Buffer.from([0x41]));
await seal('fifteen bytes', doc('notes.txt', 'text/plain'), randomBytes(15));
await seal('a bigger archive', doc('архив.zip', 'application/zip'), randomBytes(20001));
await seal('no name', doc('', 'application/octet-stream'), randomBytes(33));
await seal('no kind', doc('data.bin', ''), randomBytes(34));
await seal('a name of 240 units is kept', doc('я'.repeat(236) + '.txt', 'text/plain'), randomBytes(40));
await seal('a long name is cut at 240 units', doc('n'.repeat(300) + '.txt', 'text/plain'), randomBytes(41));
await seal('a long name is cut inside a pair', doc('a'.repeat(239) + '😀.txt', 'text/plain'), randomBytes(42));
await seal('a long kind is cut at 150', doc('x.dat', 'application/' + 'x'.repeat(200)), randomBytes(43));
await seal('quotes and line breaks in the name', doc('a"b\\c\r\nd.txt', 'text/plain'), randomBytes(44));
// A photo: the picture the phone prepared (its private chunks are dropped by the reference's own gate).
const photoFile = { uri: 'file:///cache/linea-photo-export.png', name: 'photo.png', mimeType: 'image/png' };
const photo = await seal('a photo with its preview', photoFile, pngFixture({ before: [pngChunk('eXIf', privateData), pngChunk('iTXt', privateData)] }), { photo: true, media: { width: 1, height: 1, hdr: 'sdr' }, withPreview: true });
await seal('a photo without a preview', photoFile, pngFixture(), { photo: true, media: { width: 1, height: 1, hdr: 'sdr' } });

// ── A downloaded file ────────────────────────────────────────────────────────────────────────────────────────
const opened = [];
async function download(name, attachment, given) {
  const result = await open(attachment, given);
  opened.push({ name, attachment: JSON.stringify(attachment), status: given.status ?? 200, ...(given.claimed === undefined ? {} : { claimed: given.claimed }), cipher: b64(given.cipher), ...result });
  return result;
}
const flipped = (bytes, at) => { const out = Buffer.from(bytes); out[at < 0 ? out.length + at : at] ^= 1; return out; };
for (const [label, { attachment, cipher }] of [['document', first], ['photo', photo]]) {
  const e = attachment.encryption;
  if (!(await download(`${label}: as uploaded`, attachment, { cipher })).plain) throw new Error('the reference does not open its own file');
  await download(`${label}: the size is told`, attachment, { cipher, claimed: cipher.length });
  await download(`${label}: first byte changed`, attachment, { cipher: flipped(cipher, 0) });
  await download(`${label}: a middle byte changed`, attachment, { cipher: flipped(cipher, cipher.length >> 1) });
  await download(`${label}: the tag changed`, attachment, { cipher: flipped(cipher, -1) });
  await download(`${label}: cut short`, attachment, { cipher: cipher.subarray(0, cipher.length - 1) });
  await download(`${label}: only a tag`, attachment, { cipher: cipher.subarray(0, 16) });
  await download(`${label}: nothing`, attachment, { cipher: Buffer.alloc(0) });
  await download(`${label}: a byte added`, attachment, { cipher: Buffer.concat([cipher, Buffer.from([0])]) });
  await download(`${label}: the message names a smaller size`, { ...attachment, size: attachment.size - 1 }, { cipher });
  await download(`${label}: the message names a bigger size`, { ...attachment, size: attachment.size + 1 }, { cipher });
  await download(`${label}: the message names more than 20 MiB`, { ...attachment, size: 20 * 1024 * 1024 + 1 }, { cipher });
  await download(`${label}: exactly 20 MiB is named`, { ...attachment, size: 20 * 1024 * 1024 }, { cipher });
  await download(`${label}: another key`, { ...attachment, encryption: { ...e, key: b64(randomBytes(32)) } }, { cipher });
  await download(`${label}: another nonce`, { ...attachment, encryption: { ...e, nonce: b64(randomBytes(12)) } }, { cipher });
  await download(`${label}: another file key id`, { ...attachment, encryption: { ...e, fileKeyId: randomUUID() } }, { cipher });
  await download(`${label}: no encryption`, (({ encryption, ...rest }) => rest)(attachment), { cipher });
  await download(`${label}: another scheme`, { ...attachment, encryption: { ...e, scheme: 'aes-256-gcm' } }, { cipher });
  await download(`${label}: the server says no`, attachment, { cipher, status: 404 });
  await download(`${label}: the server fails`, attachment, { cipher, status: 500 });
  await download(`${label}: too much is announced`, attachment, { cipher, claimed: 20 * 1024 * 1024 + 17 });
  await download(`${label}: the limit is announced`, attachment, { cipher, claimed: 20 * 1024 * 1024 + 16 });
  await download(`${label}: a wrong size is announced`, attachment, { cipher, claimed: 5 });
}
// Every sealed file opens as the reference's own plaintext.
for (const item of sealed) {
  const attachment = JSON.parse(item.attachment), cipher = bodyCipher(Buffer.from(item.body, 'base64'), item.boundary);
  const result = await download(`sealed: ${item.name}`, attachment, { cipher });
  if (result.plain === undefined || Buffer.from(result.plain, 'base64').length !== attachment.size) throw new Error('the reference does not open: ' + item.name);
}

// ── The small functions ──────────────────────────────────────────────────────────────────────────────────────
const NAMES = ['', 'file', 'photo.png', 'Договор № 7 (черновик).pdf', 'ёЁ-яА_.txt', 'a b\tc\nd', '../../etc/passwd', 'C:\\Users\\x\\y.doc', '😀.png', 'a'.repeat(99), 'a'.repeat(100), 'a'.repeat(101), 'x'.repeat(150) + '.tar.gz', 'і ї є ґ.txt', 'ｆｕｌｌ.txt', 'a\u0000b', '日本語.txt', '.hidden', '..', '-', 'é.txt', 'Ａ', 'ѐ.txt', 'ʼ.txt'];
for (let i = 0; i < 60; i++) NAMES.push(Array.from({ length: 1 + below(130) }, () => String.fromCharCode([0x20 + below(95), 0x400 + below(0x60), below(0x3000), 0xd800 + below(0x800)][below(4)])).join(''));
// As UTF-16 code units: a name may hold half of a pair, which JSON text cannot carry everywhere.
const names = NAMES.map(name => ({ units: Array.from({ length: name.length }, (_, index) => name.charCodeAt(index)), safe: attachmentFileName({ name }) }));

const SIZES = [0, 1, 2, 511, 512, 513, 1023, 1024, 1025, 1535, 1536, 1537, 2047, 2048, 10240, 524287, 524288, 1048063, 1048064, 1048575, 1048576, 1048577, 1100000, 1101004, 1101005, 1153433, 1153434, 1572864, 5 * 1024 * 1024, 20 * 1024 * 1024, 20 * 1024 * 1024 + 16, 1023 * 1024 * 1024, 1073741823, 1073741824, 1127428915, 1127428916, 3 * 1024 ** 3, 10 * 1024 ** 3];
for (let i = 0; i < 300; i++) SIZES.push(below(2 ** (1 + below(34))));
for (let i = 0; i < 120; i++) { const tenth = 1 + below(200); SIZES.push(Math.round(tenth * 104857.6 + 52428.8) + below(3) - 1); SIZES.push((1 + below(1023)) * 1024 + 511 + below(3)); }
const sizes = [...new Set(SIZES)].map(bytes => ({ bytes, text: formatSize(bytes) }));

const KIND_NAMES = ['', 'file', 'photo.png', 'PHOTO.JPG', 'a.jpeg', 'a.heic', 'a.heif', 'a.hif', 'a.gif', 'a.webp', 'a.dng', 'a.svg', 'a.psd', 'a.ico', 'a.png.txt', 'apng', 'a.mp4', 'A.MOV', 'a.mkv', 'a.ts', 'a.webm', 'a.3gp', 'a.mp3', 'a.m4a', 'a.ogg', 'a.aif', 'a.aiff', 'a.opus', 'a.wma', 'a.pdf', 'a.zip', 'a.docx', 'a.txt', 'a.tga', 'a.qoi', 'a.jp2', 'a.tif', 'a.tiff', 'a.raw', 'a.mpeg', 'a.caf', 'voice.m4a', 'a.jpg ', 'a.jpgx', 'jpg', '.jpg'];
const KIND_TYPES = ['', 'application/octet-stream', 'image/png', 'IMAGE/JPEG', 'image/', 'image', 'ximage/png', 'video/mp4', 'Video/quicktime', 'audio/mpeg', 'AUDIO/ogg', 'application/pdf', 'text/plain', 'image/gif', 'application/image/png'];
const kinds = [];
for (const name of KIND_NAMES) for (const mimeType of KIND_TYPES) kinds.push({ name, mimeType, kind: mediaPreviewKind({ name, mimeType }) });

const multipart = [];
for (const [filename, mimeType] of [['encrypted.bin', 'application/octet-stream'], ['a"b\\c\r\nd.txt', 'text/plain'], ['', ''], ['x'.repeat(250), 'not a type'], ['файл.pdf', 'application/vnd.api+json'], ['a.b', 'a/b/c'], ['q', 'text/plain; charset=utf-8'], ['я'.repeat(201), 'image/svg+xml']]) {
  const bytes = randomBytes(below(40));
  const held = [Math.random, Date.now];
  Math.random = () => 0.3141592653; Date.now = () => 1795244400123;
  let part;
  try { part = multipartFile(new Uint8Array(bytes), filename, mimeType); } finally { [Math.random, Date.now] = held; }
  multipart.push({ filename, mimeType, bytes: b64(bytes), boundary: /boundary=(.+)$/.exec(part.contentType)[1], contentType: part.contentType, body: b64(part.body) });
}

const out = new URL('vectors/files.json', import.meta.url);
writeFileSync(out, JSON.stringify({ sealed, opened, names, sizes, kinds, multipart }) + '\n');
const refused = opened.filter(item => item.error !== undefined);
console.log(`${sealed.length} sealed, ${opened.length} opened (${refused.length} refused: ${[...new Set(refused.map(item => item.error))].length} different words), ${names.length} names, ${sizes.length} sizes, ${kinds.length} kinds, ${multipart.length} multipart`);
