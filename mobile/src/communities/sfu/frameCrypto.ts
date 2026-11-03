// End-to-end encryption of media frames sent through the SFU. The server forwards frames it
// cannot read. AES-GCM per frame with a fresh 96-bit IV; the first bytes of a VP8 frame stay
// readable (10 for a key frame, 3 otherwise) because the codec needs them to detect key frames,
// and 1 byte of an Opus frame (its TOC). Layout: [clear head][ciphertext+tag][IV 12][keyId 1].
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
