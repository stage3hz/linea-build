// Old chats on a new device: the format of the encrypted pages, the transfer and backup keys, and the
// backup secret as the person sees it (docs/HISTORY-TRANSFER.md). Pure: no React Native here, so the
// same code runs in the tests and generates the native core's vectors (native/core/tests).
//
// A page is the JSON of a batch of cached messages (CryptoService.historyExport), encrypted with
// AES-256-GCM-SIV — the cipher attachments use, through the same bridge — under a 32-byte key and a
// random 12-byte nonce; the associated data names what the page belongs to. The uploaded body is
// base64(nonce || ciphertext+tag).
//   Transfer (variant A): a random key per transfer, sealed with Signal for the target device only
//   (CryptoService.sealNote, lane `history`), with the number of pages, after the last page is up.
//   Backup (variant B): key = HKDF-SHA256(backup secret, salt from the server, «…key…» + account). The
//   secret is 160 random bits made on a device; the server only gets the salt it made and a key check
//   HKDF(secret, salt, «…check…» + account), which says whether a typed secret is right and nothing
//   that helps to guess one.
import { fromByteArray, toByteArray } from 'base64-js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import type { SignalBridge } from './types';

type Cipher = Pick<SignalBridge, 'seal' | 'open'>;
/** Random bytes from the system's source (expo-crypto getRandomBytes in the app). */
export type RandomBytes = (count: number) => Uint8Array;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9+/]{43}=$/;
const utf8 = (text: string) => new TextEncoder().encode(text);
const b64utf8 = (text: string) => fromByteArray(utf8(text));

export const transferAd = (transferId: string, index: number) => `linea-history-v1:${transferId}:${index}`;
export const backupAd = (userId: string, generation: number) => `linea-backup-v1:${userId}:${generation}`;

/** A fresh 32-byte key, base64. */
export const newPageKey = (random: RandomBytes) => fromByteArray(random(32));

/** Seals one page: `items` (and whether it is the last of a transfer). `nonce`: only for vectors. */
export async function sealPage(cipher: Cipher, key: string, ad: string, items: unknown[], last: boolean, random: RandomBytes, nonce?: Uint8Array): Promise<string> {
  const iv = nonce ?? random(12);
  if (!KEY.test(key) || iv.length !== 12) throw new Error('Неверный ключ страницы.');
  const plain = JSON.stringify({ v: 1, items, ...(last ? { last: true } : {}) });
  const sealed = toByteArray(await cipher.seal(b64utf8(plain), key, fromByteArray(iv), b64utf8(ad)));
  const body = new Uint8Array(12 + sealed.length);
  body.set(iv, 0); body.set(sealed, 12);
  return fromByteArray(body);
}

/** Opens a page; anything changed, or under another key or name, is refused. */
export async function openPage(cipher: Cipher, key: string, ad: string, body: string): Promise<{ items: unknown[]; last: boolean }> {
  let bytes: Uint8Array;
  try { bytes = toByteArray(body); } catch { throw new Error('Страница копии повреждена.'); }
  if (bytes.length < 12 + 16 || !KEY.test(key)) throw new Error('Страница копии повреждена.');
  let plain: string;
  try { plain = new TextDecoder('utf-8', { fatal: true }).decode(toByteArray(await cipher.open(fromByteArray(bytes.subarray(12)), key, fromByteArray(bytes.subarray(0, 12)), b64utf8(ad)))); }
  catch { throw new Error('Не удалось расшифровать копию переписок.'); }
  let value: { v?: unknown; items?: unknown; last?: unknown };
  try { value = JSON.parse(plain); } catch { throw new Error('Неизвестный формат копии переписок.'); }
  if (!value || typeof value !== 'object' || value.v !== 1 || !Array.isArray(value.items) || (value.last !== undefined && value.last !== true)) throw new Error('Неизвестный формат копии переписок.');
  return { items: value.items, last: value.last === true };
}

/** What is sealed with Signal for the target device once every page of a transfer is uploaded. */
export const transferNote = (transferId: string, key: string, pageCount: number) => JSON.stringify({ v: 1, kind: 'history-transfer', transferId, key, pageCount });
export function parseTransferNote(text: string, transferId: string): { key: string; pageCount: number } {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || value.v !== 1 || value.kind !== 'history-transfer' || value.transferId !== transferId || typeof value.key !== 'string' || !KEY.test(value.key)
    || !Number.isSafeInteger(value.pageCount) || (value.pageCount as number) < 1 || (value.pageCount as number) > 1024) throw new Error('Ключ переноса не подходит к этому переносу.');
  return { key: value.key, pageCount: value.pageCount as number };
}

/** The backup secret sealed with Signal for another own device. */
export const secretNote = (userId: string, generation: number, secret: string) => JSON.stringify({ v: 1, kind: 'backup-secret', userId, generation, secret });
export function parseSecretNote(text: string, userId: string): { generation: number; secret: string } {
  const value = JSON.parse(text) as Record<string, unknown>;
  const secret = typeof value?.secret === 'string' ? parseSecret(value.secret) : null;
  if (!value || value.v !== 1 || value.kind !== 'backup-secret' || value.userId !== userId || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 || !secret) throw new Error('Ключ резервной копии повреждён.');
  return { generation: value.generation as number, secret };
}

// ── The backup secret ───────────────────────────────────────────────────────────────────────────────────
// 160 random bits written in Crockford's base32 (no I, L, O, U: nothing to confuse), 32 characters, and
// 4 characters of check (20 bits of SHA-256 of the secret) so a typo is caught on the device, without
// spending one of the server's restore attempts. Shown as 9 groups of 4.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_BYTES = 20;
export const BACKUP_QR_PREFIX = 'linea-backup:';

function base32(bytes: Uint8Array): string {
  let out = '', buffer = 0, bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
    buffer &= (1 << bits) - 1;
  }
  if (bits) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}
function unbase32(text: string): Uint8Array | null {
  const out: number[] = []; let buffer = 0, bits = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char); if (value < 0) return null;
    buffer = (buffer << 5) | value; bits += 5;
    if (bits >= 8) { out.push((buffer >>> (bits - 8)) & 255); bits -= 8; buffer &= (1 << bits) - 1; }
  }
  return new Uint8Array(out);
}
const checkOf = (data: string) => base32(sha256(utf8(`linea-backup-secret-v1:${data}`)).subarray(0, 3)).slice(0, 4);

/** A new secret: 36 characters, the last 4 are the check. */
export function newBackupSecret(random: RandomBytes): string {
  const bytes = random(SECRET_BYTES);
  if (bytes.length !== SECRET_BYTES) throw new Error('Нет источника случайных чисел.');
  const data = base32(bytes);
  return data + checkOf(data);
}
/** «ABCD EFGH …» for the screen. */
export const formatSecret = (secret: string) => secret.match(/.{1,4}/g)!.join(' ');
export const secretQr = (secret: string) => BACKUP_QR_PREFIX + secret;
/**
 * What the person typed or the camera read, as the canonical secret, or null. Spaces, dashes and case do not
 * matter; O is read as 0 and I, L as 1 (as Crockford's base32 does).
 */
export function parseSecret(input: string): string | null {
  if (typeof input !== 'string' || input.length > 200) return null;
  let text = input.trim();
  if (text.toLowerCase().startsWith(BACKUP_QR_PREFIX)) text = text.slice(BACKUP_QR_PREFIX.length);
  text = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{36}$/.test(text)) return null;
  const data = text.slice(0, 32);
  const bytes = unbase32(data);
  if (!bytes || bytes.length !== SECRET_BYTES || base32(bytes) !== data) return null;
  return checkOf(data) === text.slice(32) ? text : null;
}

/** The backup key and the key check (both base64, 32 bytes) for this account and the server's salt. */
export function backupKeys(secret: string, salt: string, userId: string): { key: string; keyCheck: string } {
  const canonical = parseSecret(secret);
  const saltBytes = toByteArray(salt);
  if (!canonical || saltBytes.length < 16 || !UUID.test(userId)) throw new Error('Неверный ключ резервной копии.');
  const ikm = unbase32(canonical.slice(0, 32))!;
  return {
    key: fromByteArray(hkdf(sha256, ikm, saltBytes, utf8(`linea-backup-v1:key:${userId}`), 32)),
    keyCheck: fromByteArray(hkdf(sha256, ikm, saltBytes, utf8(`linea-backup-v1:check:${userId}`), 32)),
  };
}
