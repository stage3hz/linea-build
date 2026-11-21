// Produces tests/vectors/chunked.json: what the reference makes of a BIG file attached to an encrypted message
// (the chunked scheme) and of a voice message's waveform.
// The reference itself is run — mobile/src/e2ee/attachments.ts (`encryptAndUploadLarge`, `uploadChunks`,
// `downloadChunked`, `chunkNonce`, `chunkAd`, `chunkedCipherSize`) and mobile/src/voice/voice.ts — through the
// loader the mobile tests use; AES-256-GCM-SIV is the desktop app's official @signalapp/libsignal-client.
// Only the device is stood in for: the file system, the random source (a fixed generator) and the server (the
// resumable upload is collected, the ranged download is handed back).
//   nonces, ads, sizes   the small functions of the scheme
//   files                files sealed by the reference: the attachment and the SHA-256 of what the server holds
//                        (the plaintext is a pattern both sides can make: see `pattern`)
//   refused              what the reference says about a download that was tampered with
//   waveforms, bars, times, names, kinds   voice messages and round videos
// Run from the repository root:  node native/core/tests/generate-chunked-vectors.mjs
// The other half of the interoperability test (tests/e2ee_files.rs), one JSON line in, one out:
//   --open  {"attachment":…,"path":"<file with the server's bytes>"} → {"sha256","size"} of what the reference's
//           download gives, or {"error"}
//   --seal  {"seed","size","path"} → the reference uploads the pattern file; the server's bytes are written to
//           `path`; answers {"attachment"}
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { loadTs } from '../../../mobile/test/support/load-ts.mjs';

const { desktopSignalBridge: bridge } = await import(new URL('../../../desktop/signal.mjs', import.meta.url).href);

const MiB = 1024 * 1024, FULL = 4 * MiB + 16;
let seed = 0x0c4a11ed;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const below = n => Math.floor(random() * n);
const randomBytes = n => Buffer.from(Array.from({ length: n }, () => below(256)));
const randomUUID = () => { const b = randomBytes(16); b[6] = b[6] & 0x0f | 0x40; b[8] = b[8] & 0x3f | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const b64 = bytes => Buffer.from(bytes).toString('base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** The plaintext of a test file: byte i is (i·31 + (i >> 8)·17 + seed) mod 256. */
const pattern = (size, start) => { const out = Buffer.alloc(size); for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >>> 8) * 17 + start) & 0xff; return out; };

// The device: files in memory, and a server that keeps what is uploaded.
const files = new Map();
const server = { file: Buffer.alloc(0), total: 0 };
class FileHandle { constructor(uri) { this.uri = uri; this.offset = 0; } readBytes(n) { const b = files.get(this.uri).subarray(this.offset, this.offset + n); this.offset += b.length; return new Uint8Array(b); } writeBytes(bytes) { files.set(this.uri, Buffer.concat([files.get(this.uri), Buffer.from(bytes)])); } close() {} }
class File { constructor(uri) { this.uri = uri; } get size() { return files.get(this.uri)?.length ?? 0; } get exists() { return files.has(this.uri); } delete() { files.delete(this.uri); } create() { files.set(this.uri, Buffer.alloc(0)); } open() { return new FileHandle(this.uri); } }
const legacy = { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, FileSystemUploadType: { BINARY_CONTENT: 0 },
  async writeAsStringAsync(uri, value) { files.set(uri, Buffer.from(value, 'base64')); },
  async readAsStringAsync(uri) { return files.get(uri).toString('base64'); },
  async deleteAsync(uri) { files.delete(uri); },
  async getInfoAsync(uri) { return { exists: files.has(uri), isDirectory: false, size: files.get(uri)?.length ?? 0 }; },
  async makeDirectoryAsync() {},
  async uploadAsync(url, from, options) {
    if (options.httpMethod !== 'PUT' || options.headers['Content-Type'] !== 'application/octet-stream') throw new Error('the reference changed its upload');
    const offset = Number(new URL(url).searchParams.get('offset'));
    if (offset !== server.file.length) return { status: 409, body: JSON.stringify({ received: server.file.length }) };
    server.file = Buffer.concat([server.file, files.get(from)]);
    return { status: 200, body: JSON.stringify({ received: server.file.length }) };
  },
  async downloadAsync(url, to, options) {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    files.set(to, server.file.subarray(Number(a), Number(b) + 1)); return { status: 206 };
  },
};
const mocks = {
  'react-native': { Platform: { OS: 'ios' } }, 'expo-file-system': { File }, 'expo-file-system/legacy': legacy, 'expo-sharing': {},
  'expo-crypto': { randomUUID, getRandomBytesAsync: async n => new Uint8Array(randomBytes(n)) },
  './signal': { getSignalBridge: () => bridge },
  '../attest/index': { attestHeaders: () => ({}) },
  '../media/pipeline': { prepareMediaForUpload: async () => { throw new Error('big files skip media processing'); } },
  '../media/thumbnail': { makeThumbnail: async () => undefined },
};
const cache = new Map();
const mod = loadTs(new URL('../../../mobile/src/e2ee/attachments.ts', import.meta.url), mocks, cache);
const voice = loadTs(new URL('../../../mobile/src/voice/voice.ts', import.meta.url), mocks, cache);
const api = { endpoint: 'https://server.example', token: 't', authHeaders: {}, ensureProof: async () => {}, fileUrl: id => `https://server.example/files/${id}`,
  async request(path, options = {}) {
    if (path === '/e2ee/limits') return { platina: true, maxFileBytes: 4096 * MiB, maxVideoBytes: 10240 * MiB, storageBytes: 0, usedBytes: 0, chunkBytes: 4 * MiB };
    if (path === '/e2ee/uploads' && options.method === 'POST') { server.file = Buffer.alloc(0); server.total = mod.chunkedCipherSize(JSON.parse(options.body).size); return { id: 'session-1' }; }
    if (path === '/e2ee/uploads/session-1/complete') { if (server.file.length !== server.total) throw new Error('the reference completed an unfinished upload'); return { id: api.nextId, size: server.file.length }; }
    throw new Error(`the reference changed: ${path}`);
  } };

/** The reference uploads a pattern file; gives its attachment and what the server holds. */
async function seal(size, start) {
  files.clear();
  files.set('file:///user/data.bin', pattern(size, start));
  api.nextId = randomUUID();
  const attachment = await mod.encryptAndUploadLarge(api, { uri: 'file:///user/data.bin', name: 'data.bin', mimeType: 'application/octet-stream' });
  return { attachment, cipher: server.file };
}
/** What the reference's download gives for these server bytes. */
async function open(attachment, cipher) {
  files.clear(); server.file = cipher;
  try {
    await mod.decryptAttachmentWithProgress(api, attachment, () => {}, 'file:///cache/out.bin');
    const plain = files.get('file:///cache/out.bin');
    return { sha256: sha256(plain), size: plain.length };
  } catch (error) { return { error: String(error?.message ?? error) }; }
}

if (process.argv.includes('--open') || process.argv.includes('--seal')) {
  for await (const line of createInterface({ input: process.stdin })) {
    const ask = JSON.parse(line);
    if (process.argv.includes('--open')) process.stdout.write(`${JSON.stringify(await open(ask.attachment, readFileSync(ask.path)))}\n`);
    else { seed = (0x5ea1 ^ ask.seed ^ Date.now()) | 0; const made = await seal(ask.size, ask.seed); writeFileSync(ask.path, made.cipher); process.stdout.write(`${JSON.stringify({ attachment: made.attachment })}\n`); }
  }
  process.exit(0);
}

// ── The small functions ──────────────────────────────────────────────────────────────────────────────────────
const nonces = [];
for (const index of [0, 1, 2, 255, 256, 2559, 65535, 65536, 0x7fffffff, 0x80000000, 0xffffffff]) for (let i = 0; i < 4; i++) { const base = b64(i === 0 ? Buffer.alloc(12) : i === 1 ? Buffer.alloc(12, 0xff) : randomBytes(12)); nonces.push({ base, index, nonce: mod.chunkNonce(base, index) }); }
const ads = [];
for (const [index, count] of [[0, 1], [0, 2], [1, 2], [2559, 2560], [7, 9]]) { const fileKeyId = randomUUID(); ads.push({ fileKeyId, index, count, ad: mod.chunkAd(fileKeyId, index, count) }); }
const sizes = [1, 2, 4 * MiB - 1, 4 * MiB, 4 * MiB + 1, 8 * MiB, 8 * MiB + 1, 20 * MiB + 1, 1024 * MiB, 10240 * MiB, 10240 * MiB - 1].map(size => ({ size, cipherSize: mod.chunkedCipherSize(size) }));
for (let i = 0; i < 60; i++) { const size = 1 + below(2 ** (1 + below(34))); sizes.push({ size, cipherSize: mod.chunkedCipherSize(size) }); }

// ── Files sealed by the reference ────────────────────────────────────────────────────────────────────────────
const sealedFiles = [], refused = [];
let big = null;
for (const [size, start] of [[1, 3], [5, 250], [4 * MiB - 1, 9], [4 * MiB, 77], [4 * MiB + 1, 130], [8 * MiB + 5, 201]]) {
  const { attachment, cipher } = await seal(size, start);
  if (attachment.encryption.scheme !== 'aes-256-gcm-siv-chunked' || cipher.length !== mod.chunkedCipherSize(size)) throw new Error('the reference did not chunk: ' + size);
  const back = await open(attachment, cipher);
  if (back.sha256 !== sha256(pattern(size, start)) || back.size !== size) throw new Error('the reference does not open its own file: ' + size);
  const tags = []; for (let at = 0; at < cipher.length; at += FULL) tags.push(cipher.subarray(Math.min(cipher.length, at + FULL) - 16, Math.min(cipher.length, at + FULL)).toString('hex'));
  sealedFiles.push({ size, start, attachment: JSON.stringify(attachment), cipherSha256: sha256(cipher), tags });
  if (size === 8 * MiB + 5) big = { attachment, cipher, size, start };
}
// The same file, tampered with on the server or in the message.
const refuse = async (name, attachment, cipher) => { const result = await open(attachment, cipher); if (!result.error) throw new Error('the reference opened: ' + name); refused.push({ name, error: result.error }); };
await refuse('the first two chunks swapped', big.attachment, Buffer.concat([big.cipher.subarray(FULL, 2 * FULL), big.cipher.subarray(0, FULL), big.cipher.subarray(2 * FULL)]));
await refuse('a byte of the second chunk changed', big.attachment, (() => { const out = Buffer.from(big.cipher); out[FULL + 100] ^= 1; return out; })());
await refuse('the message names one chunk only', { ...big.attachment, size: 4 * MiB }, big.cipher);
await refuse('the message names two chunks only', { ...big.attachment, size: 8 * MiB }, big.cipher);
await refuse('another file key id', { ...big.attachment, encryption: { ...big.attachment.encryption, fileKeyId: randomUUID() } }, big.cipher);
await refuse('another chunk size', { ...big.attachment, encryption: { ...big.attachment.encryption, chunkSize: 1024 * 1024 } }, big.cipher);
await refuse('no chunk size', { ...big.attachment, encryption: (({ chunkSize, ...rest }) => rest)(big.attachment.encryption) }, big.cipher);

// ── Voice messages and round videos ──────────────────────────────────────────────────────────────────────────
const waveforms = [];
const levelSets = [[], [0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0, 0, 0], [0.02, 0.02, 0.02, 0.02], [0.021, 0, 0, 0], [1, 1, 1, 1, 1, 1], [0, 1, 0, 1, 0, 1, 0], [2, -1, 0.5, 3, 0.25], Array.from({ length: 100 }, (_, i) => i / 99), Array.from({ length: 101 }, (_, i) => 1 - i / 100), Array.from({ length: 99 }, (_, i) => (i % 10) / 10)];
for (const length of [4, 5, 7, 13, 50, 99, 100, 101, 150, 199, 200, 201, 250, 777, 3000]) for (let i = 0; i < 6; i++) levelSets.push(Array.from({ length }, () => [random(), random() ** 3, 0.4 + random() * 0.6, random() < 0.2 ? random() : 0][i % 4]));
for (let i = 0; i < 40; i++) levelSets.push(Array.from({ length: 4 + below(600) }, () => Math.round(random() * 1000) / 1000));
for (const levels of levelSets) waveforms.push({ levels: JSON.stringify(levels), waveform: voice.encodeWaveform(levels) ?? null });
const bars = [];
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const texts = [null, '', 'AAAAAAA', 'AAAAAAAA', 'f'.repeat(100), 'f'.repeat(101), 'ABCDEFGg', 'ABCDEFG1', letters, letters + letters + letters, ...waveforms.map(item => item.waveform).filter(Boolean).slice(0, 12)];
for (let i = 0; i < 20; i++) texts.push(Array.from({ length: 8 + below(93) }, () => letters[below(32)]).join(''));
for (const text of texts) for (const count of [0, 1, 11, 12, 13, 37, 48, 49, 58, 99, 100, 101, 400]) {
  // As the reference's bubble does it (voice/VoiceMessage.tsx, `VoiceBubbleView`).
  bars.push({ waveform: text, count, bars: voice.fitWaveform(voice.decodeWaveform(text ?? undefined) || Array.from({ length: 48 }, () => .12), Math.max(12, count)) });
}
const times = [0, 1, 499, 999, 1000, 1001, 4630, 9999, 59999, 60000, 61000, 599000, 3599999, 3600000, 64800000, -5, 0.5, 1234.5678].map(ms => ({ ms, time: voice.formatVoiceTime(ms), fine: voice.formatVoiceTimeFine(ms) }));
const names = [0, 1, 1795244400000, 1795244400000.75, -3, 9999999999999999].map(now => ({ now, voice: voice.voiceFileName(now), note: voice.videoNoteFileName(now) }));
const kinds = [];
for (const name of ['voice-1.m4a', 'voice-1795244400000.m4a', 'voice-.m4a', 'voice-12345678901234567.m4a', 'voice-1234567890123456.m4a', 'voice-1a.m4a', 'Voice-1.m4a', 'voice-1.m4a ', 'xvoice-1.m4a', 'voice-1.mp4', 'circle-1.mp4', 'circle-1795244400000.mp4', 'circle-.mp4', 'circle-1.m4a', 'circle-12345678901234567.mp4', 'circle-١.mp4', 'video.mp4', ''])
  for (const mimeType of ['audio/mp4', 'video/mp4', 'audio/m4a', 'AUDIO/MP4', '']) kinds.push({ name, mimeType, voice: voice.isVoice({ name, mimeType }), note: voice.isVideoNote({ name, mimeType }) });
const rules = { voiceMime: voice.VOICE_MIME, voiceMinMs: voice.VOICE_MIN_MS, voiceMaxMs: voice.VOICE_MAX_MS, noteMaxMs: voice.VIDEO_NOTE_MAX_MS, bars: voice.WAVEFORM_BARS, chunk: mod.CHUNK_PLAIN, large: mod.LARGE_FILE };

writeFileSync(new URL('vectors/chunked.json', import.meta.url), JSON.stringify({ nonces, ads, sizes, files: sealedFiles, refused, waveforms, bars, times, names, kinds, rules }) + '\n');
console.log(`${nonces.length} nonces, ${ads.length} ads, ${sizes.length} sizes, ${sealedFiles.length} files, ${refused.length} refused (${[...new Set(refused.map(item => item.error))].length} different words), ${waveforms.length} waveforms (${waveforms.filter(item => item.waveform).length} with bars), ${bars.length} bars, ${times.length} times, ${kinds.length} kinds`);
