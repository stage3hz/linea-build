// End-to-end encryption of media frames sent through the SFU. The server forwards frames it
// cannot read. AES-GCM per frame with a fresh 96-bit IV; the first bytes of a VP8 frame stay
// readable (10 for a key frame, 3 otherwise) because the codec needs them to detect key frames,
// and 1 byte of an Opus frame (its TOC). The readable head is authenticated (AES-GCM AAD).
//
// Two layouts:
//  • «lk» (current, what PCs send): the frame format of the WebRTC FrameCryptor used by
//    @livekit/react-native-webrtc (webrtc-sdk api/crypto/frame_crypto_transformer.cc), so phones can
//    open SFU frames natively: [clear head][ciphertext+tag][IV 12][IV length = 12][key index 0..15].
//    The AES-128 key is HKDF-SHA256(raw key, salt LK_SALT, info = 128 zero bytes) — the FrameCryptor's
//    key provider with keyDerivationAlgorithm HKDF and the same ratchet salt derives exactly this.
//  • legacy (apps up to 0.14.13, still opened): [clear head][ciphertext+tag][IV 12][keyId 1], raw key.
// Pure byte logic is tested in test/sfu-frame-crypto.test.mjs with WebCrypto in Node.

export const IV_BYTES = 12;
export function clearBytes(kind: 'audio' | 'video', data: Uint8Array): number {
  if (kind === 'audio') return Math.min(1, data.length);
  if (!data.length) return 0;
  const keyFrame = (data[0] & 0x01) === 0; // VP8 payload header: P bit 0 = key frame
  return Math.min(keyFrame ? 10 : 3, data.length);
}

export async function sealFrame(key: CryptoKey, keyId: number, kind: 'audio' | 'video', data: Uint8Array, random: (n: number) => Uint8Array): Promise<Uint8Array> {
  const head = clearBytes(kind, data);
  const iv = random(IV_BYTES);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: data.subarray(0, head) as BufferSource }, key, data.subarray(head) as BufferSource));
  const out = new Uint8Array(head + sealed.length + IV_BYTES + 1);
  out.set(data.subarray(0, head), 0); out.set(sealed, head); out.set(iv, head + sealed.length); out[out.length - 1] = keyId & 0xff;
  return out;
}

/** Returns the original frame, or null if it was not sealed with a key we have (dropped, never shown). */
export async function openFrame(keys: (id: number) => CryptoKey | undefined, kind: 'audio' | 'video', data: Uint8Array): Promise<Uint8Array | null> {
  if (data.length < IV_BYTES + 1 + 16) return null;
  const key = keys(data[data.length - 1]); if (!key) return null;
  const head = clearBytes(kind, data);
  const iv = data.subarray(data.length - 1 - IV_BYTES, data.length - 1);
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: data.subarray(0, head) as BufferSource }, key, data.subarray(head, data.length - 1 - IV_BYTES) as BufferSource));
    const out = new Uint8Array(head + plain.length); out.set(data.subarray(0, head), 0); out.set(plain, head);
    return out;
  } catch { return null; }
}

/** Frame format «lk» (see the top of this file). */
export const LK_SALT = 'INVIZENT screen frames v1';
export const LK_KEY_RING = 16;
const utf8 = (text: string) => new TextEncoder().encode(text);
export async function deriveLkKey(raw: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8(LK_SALT) as BufferSource, info: new Uint8Array(128) as BufferSource }, base, { name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
}
export async function sealFrameLk(key: CryptoKey, keyIndex: number, kind: 'audio' | 'video', data: Uint8Array, random: (n: number) => Uint8Array): Promise<Uint8Array> {
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex >= LK_KEY_RING) throw new Error('key index');
  const head = clearBytes(kind, data);
  const iv = random(IV_BYTES);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: data.subarray(0, head) as BufferSource }, key, data.subarray(head) as BufferSource));
  const out = new Uint8Array(head + sealed.length + IV_BYTES + 2);
  out.set(data.subarray(0, head), 0); out.set(sealed, head); out.set(iv, head + sealed.length);
  out[out.length - 2] = IV_BYTES; out[out.length - 1] = keyIndex;
  return out;
}
export const looksLk = (data: Uint8Array) => data.length >= IV_BYTES + 2 + 16 && data[data.length - 2] === IV_BYTES && data[data.length - 1] < LK_KEY_RING;
export async function openFrameLk(keys: (index: number) => CryptoKey | undefined, kind: 'audio' | 'video', data: Uint8Array): Promise<Uint8Array | null> {
  if (!looksLk(data)) return null;
  const key = keys(data[data.length - 1]); if (!key) return null;
  const head = clearBytes(kind, data);
  const end = data.length - 2;
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(end - IV_BYTES, end) as BufferSource, additionalData: data.subarray(0, head) as BufferSource }, key, data.subarray(head, end - IV_BYTES) as BufferSource));
    const out = new Uint8Array(head + plain.length); out.set(data.subarray(0, head), 0); out.set(plain, head);
    return out;
  } catch { return null; }
}
export type PeerFrameKeys = { lk: Map<number, CryptoKey>; legacy: Map<number, CryptoKey> };
/** Opens a frame in either layout with the keys one person sent us. */
export async function openAnyFrame(keys: PeerFrameKeys | undefined, kind: 'audio' | 'video', data: Uint8Array): Promise<Uint8Array | null> {
  if (!keys) return null;
  if (looksLk(data)) { const out = await openFrameLk(i => keys.lk.get(i), kind, data); if (out) return out; }
  return openFrame(id => keys.legacy.get(id), kind, data);
}

export const importKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);

/** Chromium «insertable streams»: run every frame of a sender/receiver through `fn`. */
export function transformFrames(endpoint: any, fn: (data: Uint8Array) => Promise<Uint8Array | null>) {
  const { readable, writable } = endpoint.createEncodedStreams();
  void readable.pipeThrough(new TransformStream({
    async transform(frame: any, controller: any) {
      const out = await fn(new Uint8Array(frame.data));
      if (!out) return; // undecryptable: drop instead of showing garbage
      frame.data = out.buffer; controller.enqueue(frame);
    },
  })).pipeTo(writable).catch(() => {});
}
export const frameCryptoSupported = () => typeof (globalThis as any).RTCRtpSender !== 'undefined' && 'createEncodedStreams' in (globalThis as any).RTCRtpSender.prototype;
