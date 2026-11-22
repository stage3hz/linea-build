// Vectors of old chats on a new device (docs/HISTORY-TRANSFER.md), made by running the reference itself:
// mobile/src/e2ee/history.ts (pages, notes, the backup secret and keys) and mobile/src/e2ee/qr.ts (its QR code),
// with Node's AES-256-GCM-SIV in place of the Signal bridge's seal/open (the same cipher).
// Run from the repository root:  node native/core/tests/generate-history-vectors.mjs
import { writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { loadTs } from '../../../mobile/test/support/load-ts.mjs';

const history = loadTs(new URL('../../../mobile/src/e2ee/history.ts', import.meta.url));
const { qrMatrix } = loadTs(new URL('../../../mobile/src/e2ee/qr.ts', import.meta.url));
const b = text => Buffer.from(text, 'base64');
export const cipher = {
  async seal(plain, key, nonce, ad) { const c = createCipheriv('aes-256-gcm-siv', b(key), b(nonce)); c.setAAD(b(ad)); const out = Buffer.concat([c.update(b(plain)), c.final(), c.getAuthTag()]); return out.toString('base64'); },
  async open(sealed, key, nonce, ad) { const bytes = b(sealed); const d = createDecipheriv('aes-256-gcm-siv', b(key), b(nonce)); d.setAAD(b(ad)); d.setAuthTag(bytes.subarray(bytes.length - 16)); return Buffer.concat([d.update(bytes.subarray(0, bytes.length - 16)), d.final()]).toString('base64'); },
};
const seeded = label => { let n = 0; return count => { const out = Buffer.alloc(count); for (let i = 0; i < count; i += 32) createHash('sha256').update(`${label}:${n++}`).digest().copy(out, i); return new Uint8Array(out.subarray(0, count)); }; };
const attempt = async work => { try { return { ok: await work() }; } catch (error) { return { error: error.message }; } };

const USER = '0f8fad5b-d9cb-469f-a165-70867728950e', TRANSFER = 'a0000000-0000-4000-8000-000000000001';
const secrets = [];
for (let i = 0; i < 8; i++) {
  const bytes = seeded(`secret${i}`)(20);
  const secret = history.newBackupSecret(() => bytes);
  const salt = Buffer.from(seeded(`salt${i}`)(32)).toString('base64');
  const formatted = history.formatSecret(secret);
  const inputs = [secret, formatted, formatted.toLowerCase(), history.secretQr(secret), `  ${history.secretQr(secret).toUpperCase()}  `, secret.replace(/0/g, 'o').replace(/1/g, 'l'), secret.replace(/1/g, 'I'), secret.slice(0, 35), secret + 'A', secret.slice(0, 32) + 'ZZZZ', formatted.replace(/ /g, '-'), 'U'.repeat(36), ''];
  secrets.push({ bytes: Buffer.from(bytes).toString('base64'), secret, formatted, qr: history.secretQr(secret), parsed: inputs.map(input => [input, history.parseSecret(input)]), salt, keys: history.backupKeys(secret, salt, USER), otherUser: history.backupKeys(secret, salt, TRANSFER) });
}
const items = [
  { chatId: 'c0000000-0000-4000-8000-000000000001', senderId: USER, clientId: 'e0000001-0000-4000-8000-000000000001', fingerprint: 'a'.repeat(64), text: 'Привет 👋 «кавычки» \\ "', attachment: null, sentAt: '2026-11-21T07:00:00.000Z' },
  { chatId: 'c0000000-0000-4000-8000-000000000001', senderId: USER, clientId: 'e0000001-0000-4000-8000-000000000002', fingerprint: 'b'.repeat(64), text: '', attachment: { id: 'f0000000-0000-4000-8000-000000000001', name: 'a.pdf', mimeType: 'application/pdf', size: 10, encryption: { scheme: 'aes-256-gcm-siv', key: 'A'.repeat(43) + '=', nonce: 'b'.repeat(16), fileKeyId: 'f0000000-0000-4000-8000-000000000002' } }, sentAt: '2026-11-21T07:00:01.000Z', meta: { x: 1 } },
];
const pages = [];
for (const [index, [list, last]] of [[[], true], [items, false], [items, true], [[items[0]], false]].entries()) {
  const key = history.newPageKey(seeded(`key${index}`));
  const nonce = seeded(`nonce${index}`)(12);
  const ad = index % 2 ? history.transferAd(TRANSFER, index) : history.backupAd(USER, index + 1);
  const body = await history.sealPage(cipher, key, ad, list, last, () => nonce, nonce);
  const tampered = Buffer.from(body, 'base64'); tampered[tampered.length - 1] ^= 1;
  pages.push({ key, nonce: Buffer.from(nonce).toString('base64'), ad, items: list, last, body,
    opened: await attempt(() => history.openPage(cipher, key, ad, body)),
    wrongAd: await attempt(() => history.openPage(cipher, key, ad + 'x', body)),
    tampered: await attempt(() => history.openPage(cipher, key, ad, tampered.toString('base64'))),
    short: await attempt(() => history.openPage(cipher, key, ad, body.slice(0, 20))) });
}
// A page whose plaintext is not the format: sealed by hand.
const odd = [];
for (const plain of ['{"v":2,"items":[]}', '{"v":1,"items":{}}', '{"v":1,"items":[],"last":false}', 'не json', '{"v":1,"items":[1,2]}']) {
  const key = 'B'.repeat(42) + 'A=', nonce = Buffer.alloc(12, 3), ad = 'linea-history-v1:x:0';
  const sealed = b(await cipher.seal(Buffer.from(plain).toString('base64'), key, nonce.toString('base64'), Buffer.from(ad).toString('base64')));
  const body = Buffer.concat([nonce, sealed]).toString('base64');
  odd.push({ key, ad, body, opened: await attempt(() => history.openPage(cipher, key, ad, body)) });
}
const key = 'C'.repeat(43) + '=';
const notes = {
  transfer: history.transferNote(TRANSFER, key, 3),
  transferParsed: [history.transferNote(TRANSFER, key, 3), history.transferNote('other', key, 3), history.transferNote(TRANSFER, 'short', 3), history.transferNote(TRANSFER, key, 0), history.transferNote(TRANSFER, key, 1025), history.transferNote(TRANSFER, key, 1.5), '{}', '[1]'].map(text => [text, (() => { try { return history.parseTransferNote(text, TRANSFER); } catch { return null; } })()]),
  secret: history.secretNote(USER, 2, secrets[0].secret),
  secretParsed: [history.secretNote(USER, 2, secrets[0].secret), history.secretNote(USER, 2, history.formatSecret(secrets[0].secret)), history.secretNote(TRANSFER, 2, secrets[0].secret), history.secretNote(USER, 0, secrets[0].secret), history.secretNote(USER, 2, 'x')].map(text => [text, (() => { try { return history.parseSecretNote(text, USER); } catch { return null; } })()]),
};
const qr = ['LINEA-BACKUP:' + secrets[0].secret, 'LINEA-BACKUP:' + secrets[1].secret, 'A', 'HELLO WORLD', '0123456789'.repeat(6), 'A'.repeat(61), 'A'.repeat(62), 'lower', ''].map(text => [text, qrMatrix(text)?.map(row => row.map(dark => (dark ? '1' : '0')).join('')) ?? null]);
const ads = [[history.transferAd(TRANSFER, 0), TRANSFER, 0], [history.transferAd(TRANSFER, 17), TRANSFER, 17]];
writeFileSync(new URL('./vectors/history.json', import.meta.url), JSON.stringify({ user: USER, secrets, pages, odd, notes, qr, ads }, null, 1) + '\n');
console.log('secrets', secrets.length, 'pages', pages.length, 'qr', qr.length);
