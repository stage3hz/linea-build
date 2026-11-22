// Encrypted files for the simulator/emulator checks, exactly as the reference app seals them (mobile/src/e2ee/
// attachments.ts): a small file is one AES-256-GCM-SIV block bound to `linea-attachment-v1:<fileKeyId>`; a big
// file goes in 4 MiB chunks, each with its own nonce (the base nonce with the index mixed into its last 4 bytes)
// and its place and count authenticated (`linea-attachment-v2:<fileKeyId>:<index>:<count>`). The cipher itself is
// the official library's (mobile/test/support/signal-node.mjs). Only the LOCAL test server is ever spoken to.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const CHUNK = 4 * 1024 * 1024;
const TAG = 16;
export const chunkCount = size => Math.max(1, Math.ceil(size / CHUNK));
export function chunkNonce(base, index) {
  const bytes = Buffer.from(base, 'base64');
  if (bytes.length !== 12) throw new Error('bad nonce');
  bytes.writeUInt32BE((bytes.readUInt32BE(8) ^ index) >>> 0, 8);
  return bytes.toString('base64');
}
export const chunkAd = (fileKeyId, index, count) => Buffer.from(`linea-attachment-v2:${fileKeyId}:${index}:${count}`).toString('base64');
const smallAd = fileKeyId => Buffer.from(`linea-attachment-v1:${fileKeyId}`).toString('base64');
export const sha256hex = bytes => createHash('sha256').update(bytes).digest('hex');

/** Seals and uploads a small file; gives the attachment object that travels inside the message. */
export async function uploadSmall(bridge, base, headers, bytes, { name, mimeType, media }) {
  const fileKeyId = randomUUID(), key = randomBytes(32).toString('base64'), nonce = randomBytes(12).toString('base64');
  const cipher = Buffer.from(await bridge.seal(bytes.toString('base64'), key, nonce, smallAd(fileKeyId)), 'base64');
  const form = new FormData(); form.append('file', new Blob([cipher], { type: 'application/octet-stream' }), 'encrypted.bin');
  const response = await fetch(base + '/e2ee/files', { method: 'POST', headers, body: form });
  const uploaded = await response.json();
  if (!response.ok) throw new Error(uploaded.error || String(response.status));
  return { id: uploaded.id, name, mimeType, size: bytes.length, encryption: { scheme: 'aes-256-gcm-siv', key, nonce, fileKeyId }, ...(media ? { media } : {}) };
}

/** Seals and uploads a file chunk by chunk (the reference's `uploadChunks`); gives the attachment object. */
export async function uploadChunked(bridge, base, headers, bytes, { name, mimeType, media, kind = 'video' }) {
  const fileKeyId = randomUUID(), key = randomBytes(32).toString('base64'), nonce = randomBytes(12).toString('base64');
  const json = { ...headers, 'Content-Type': 'application/json' };
  const started = await fetch(base + '/e2ee/uploads', { method: 'POST', headers: json, body: JSON.stringify({ size: bytes.length, kind }) });
  const session = await started.json();
  if (!started.ok) throw new Error(session.error || String(started.status));
  const count = chunkCount(bytes.length);
  for (let index = 0; index < count; index++) {
    const plain = bytes.subarray(index * CHUNK, Math.min(bytes.length, (index + 1) * CHUNK));
    const cipher = Buffer.from(await bridge.seal(plain.toString('base64'), key, chunkNonce(nonce, index), chunkAd(fileKeyId, index, count)), 'base64');
    const put = await fetch(`${base}/e2ee/uploads/${session.id}?offset=${index * (CHUNK + TAG)}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: cipher });
    if (!put.ok) throw new Error(`chunk ${index}: ${put.status} ${await put.text()}`);
  }
  const completed = await fetch(`${base}/e2ee/uploads/${session.id}/complete`, { method: 'POST', headers });
  const done = await completed.json();
  if (!completed.ok) throw new Error(done.error || String(completed.status));
  return { id: done.id, name, mimeType, size: bytes.length, encryption: { scheme: 'aes-256-gcm-siv-chunked', key, nonce, fileKeyId, chunkSize: CHUNK }, ...(media ? { media } : {}) };
}

/** Downloads an attachment and opens it with the key from its message; every byte is checked by the cipher. */
export async function openAttachment(bridge, base, headers, attachment) {
  const response = await fetch(`${base}/files/${encodeURIComponent(attachment.id)}`, { headers });
  if (!response.ok) throw new Error(`download ${attachment.name}: ${response.status}`);
  const cipher = Buffer.from(await response.arrayBuffer());
  const { scheme, key, nonce, fileKeyId } = attachment.encryption || {};
  if (scheme === 'aes-256-gcm-siv') {
    if (cipher.length !== attachment.size + TAG) throw new Error(`${attachment.name}: wrong size`);
    return Buffer.from(await bridge.open(cipher.toString('base64'), key, nonce, smallAd(fileKeyId)), 'base64');
  }
  if (scheme !== 'aes-256-gcm-siv-chunked' || attachment.encryption.chunkSize !== CHUNK) throw new Error(`${attachment.name}: no key`);
  const count = chunkCount(attachment.size);
  if (cipher.length !== attachment.size + count * TAG) throw new Error(`${attachment.name}: wrong size`);
  const parts = [];
  for (let index = 0; index < count; index++) {
    const part = cipher.subarray(index * (CHUNK + TAG), Math.min(cipher.length, (index + 1) * (CHUNK + TAG)));
    parts.push(Buffer.from(await bridge.open(part.toString('base64'), key, chunkNonce(nonce, index), chunkAd(fileKeyId, index, count)), 'base64'));
  }
  return Buffer.concat(parts);
}
