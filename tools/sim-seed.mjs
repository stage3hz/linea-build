// Seeds the simulator's LOCAL test server (ios-simulator-ui.yml) with people to talk to: a few accounts with picture
// avatars, each in a chat with the walked test account, sending really Signal-encrypted messages (short, long,
// emoji, a burst). Uses the app's own code — mobile/src/api.ts and mobile/src/e2ee/core.ts — the way mobile/test
// does. Never talks to anything but the address given (the workflow passes http://127.0.0.1:<port>).
//   node tools/sim-seed.mjs <base url> <public @username of the test account>
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const [base, handle] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '') || !handle) { console.error('usage: sim-seed.mjs http://127.0.0.1:<port> <handle>'); process.exit(2); }
const root = new URL('../', import.meta.url);
process.env.LINEA_SIGNAL_TEST_TOOLS ||= new URL('desktop', root).pathname;
const support = new URL('mobile/test/support/', root);
const { loadTs } = await import(new URL('load-ts.mjs', support));
const { CryptoService, MemoryVault, sha256 } = await import(new URL('crypto-harness.mjs', support));
const { nodeSignalBridge } = await import(new URL('signal-node.mjs', support));
const { Api } = loadTs(new URL('mobile/src/api.ts', root).pathname, {
  'react-native': { Platform: { OS: 'android' } }, 'expo-file-system': { File: class { constructor(uri) { this.uri = uri; } get size() { return 0; } } }, 'expo-file-system/legacy': {}, 'expo-sharing': {},
});
const PASSWORD = 'Synthetic!Simulator.42', CONFIRMATION = 'AmberGardenPrism', RECOVERY = 'SilverHarborLantern';

/** A 96×96 PNG: a two-colour diagonal gradient with a lighter disc, so avatars are told apart at a glance. */
function png(a, b) {
  const size = 96, raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size), disc = Math.hypot(x - 48, y - 40) < 20 || (y > 62 && Math.hypot(x - 48, y - 96) < 36);
      const at = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) { const v = a[c] + (b[c] - a[c]) * t; raw[at + c] = Math.round(disc ? v + (255 - v) * 0.6 : v); }
      raw[at + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xFFFFFFFF; for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function peer(username, displayName, colors) {
  const session = await new Api(base).register(username, PASSWORD, displayName, CONFIRMATION, RECOVERY);
  const api = new Api(base, session.token);
  const service = new CryptoService(session.user.id, api, nodeSignalBridge, new MemoryVault(), randomUUID, sha256, { autoTrust: true });
  await service.initialize();
  if (colors) {
    // The avatar goes up as the app sends it: one multipart file, then the profile points at it. Not fatal.
    try {
      const form = new FormData(); form.append('file', new Blob([png(...colors)], { type: 'image/png' }), 'avatar.png');
      const response = await fetch(base + '/uploads', { method: 'POST', headers: api.authHeaders, body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || String(response.status));
      await api.profile({ avatarId: body.attachment.id });
    } catch (error) { console.log(`avatar of ${username} not set: ${error.message}`); }
  }
  return { api, service, id: session.user.id, chatId: null };
}
// A message with every kind of formatting, for the native list's formatting check: [text, entities].
const FORMATTED = (() => {
  const text = 'Жирный, курсив, подчёркнутый, зачёркнутый, код и спойлер.\nЦитата из письма\nСайт www.example.com, подробности тут, пиши @simpeer';
  const at = (word, type, extra = {}) => ({ type, offset: text.indexOf(word), length: word.length, ...extra });
  return [text, [at('Жирный', 'bold'), at('курсив', 'italic'), at('подчёркнутый', 'underline'), at('зачёркнутый', 'strikethrough'), at('код', 'code'),
    at('спойлер', 'spoiler'), at('Цитата из письма', 'quote'), at('подробности тут', 'text_link', { url: 'https://example.com/details' })]];
})();
async function say(from, to, message) {
  const [text, entities] = Array.isArray(message) ? message : [message, null];
  if (!from.chatId) from.chatId = (await from.api.createChat(to)).chat.id;
  const clientId = randomUUID();
  const encrypted = await from.service.encrypt(from.chatId, to, clientId, text, null, entities ? { entities } : undefined);
  await from.api.sendEncrypted(from.chatId, clientId, encrypted);
  await from.service.delivered(from.chatId, clientId);
}

const stamp = Date.now().toString(36).slice(-5);
const PEOPLE = [
  ['Анна Лебедева', [[94, 123, 255], [154, 107, 255]], ['Привет! Ты где?', 'Мы уже на месте, занял столик у окна', 'Выходи из метро направо, там вывеска с совой 🦉', 'Ок, жду']],
  ['Максим Голубев', [[39, 179, 154], [59, 208, 192]], ['Скинул документы на почту, проверь, пожалуйста, когда будет минутка: там договор, приложение к нему и счёт на оплату. Если что-то не так с реквизитами — напиши сразу, поправлю до вечера.', 'И ещё вопрос по срокам']],
  ['Ксюша', [[224, 128, 59], [240, 168, 96]], ['😂😂😂', 'Ну ты даёшь', 'Давай в семь у метро']],
  ['Dimas', null, ['Го вечером?', 'Я освобожусь после шести']],
  ['Лариса Новикова', [[176, 74, 122], [224, 106, 154]], Array.from({ length: 24 }, (_, i) => `Сообщение номер ${i + 1}${i % 5 === 4 ? ' — подлиннее, чтобы перенеслось на вторую строку и было видно, как ведёт себя пузырь' : ''}`)],
  ['Тимур Богданов', [[61, 139, 208], [94, 176, 240]], ['Список покупок:\n— молоко\n— хлеб\n— сыр', FORMATTED, 'Не забудь!']],
];
const people = [];
for (const [index, [name, colors]] of PEOPLE.entries()) people.push(await peer(`simpeer${index}_${stamp}`, name, colors));
const found = (await people[0].api.users('@' + handle)).users[0];
if (!found) { console.error(`the test account @${handle} was not found`); process.exit(1); }
let sent = 0;
for (const [index, [, , texts]] of PEOPLE.entries()) for (const text of texts) { await say(people[index], found.id, text); sent++; }
// An encrypted photo and an encrypted file from the last person (their chat is then the first in the list), sent
// the way the app sends them: sealed with a fresh key, uploaded as ciphertext, the key travelling inside the
// message. Not fatal: an older server without the files route just has no attachments to show.
async function sayFile(from, to, bytes, { name, mimeType, media }, text = '') {
  const { randomBytes } = await import('node:crypto');
  if (!from.chatId) from.chatId = (await from.api.createChat(to)).chat.id;
  const fileKeyId = randomUUID(), key = randomBytes(32).toString('base64'), nonce = randomBytes(12).toString('base64');
  const ad = Buffer.from(`linea-attachment-v1:${fileKeyId}`).toString('base64');
  const cipher = Buffer.from(await nodeSignalBridge.seal(bytes.toString('base64'), key, nonce, ad), 'base64');
  const form = new FormData(); form.append('file', new Blob([cipher], { type: 'application/octet-stream' }), 'encrypted.bin');
  const response = await fetch(base + '/e2ee/files', { method: 'POST', headers: from.api.authHeaders, body: form });
  const uploaded = await response.json();
  if (!response.ok) throw new Error(uploaded.error || String(response.status));
  const attachment = { id: uploaded.id, name, mimeType, size: bytes.length, encryption: { scheme: 'aes-256-gcm-siv', key, nonce, fileKeyId }, ...(media ? { media } : {}) };
  const clientId = randomUUID();
  await from.api.sendEncrypted(from.chatId, clientId, await from.service.encrypt(from.chatId, to, clientId, text, attachment));
  await from.service.delivered(from.chatId, clientId);
}
try {
  const last = people[people.length - 1];
  await sayFile(last, found.id, Buffer.from('%PDF-1.4\n% a made-up file for the simulator\n', 'utf8'), { name: 'Договор.pdf', mimeType: 'application/pdf' }, 'Посмотри договор');
  await sayFile(last, found.id, png([61, 139, 208], [240, 168, 96]), { name: 'photo.png', mimeType: 'image/png', media: { width: 96, height: 96, hdr: 'sdr' } });
  sent += 2;
} catch (error) { console.log(`attachments not sent: ${error.message}`); }
// A community with two channels and a blog, when the test account's sign-in is given (the fifth to seventh
// arguments: login, password, confirmation word): the account joins by invite as a person would. Not fatal.
const [seedLogin, seedPassword, seedWord] = process.argv.slice(5);
if (seedLogin && seedPassword) {
  try {
    const owner = people[0].api;
    const { community } = await owner.createCommunity({ kind: 'server', name: 'Клан «Север»', description: 'Собираемся по вечерам.' });
    const [general, news] = community.channels.filter(channel => channel.kind === 'text');
    const { invite } = await owner.createInvite(community.id);
    const session = await new Api(base).login(seedLogin, seedPassword, seedWord || '');
    await new Api(base, session.token).acceptInvite(invite.code);
    for (const person of people.slice(1, 4)) await person.api.acceptInvite(invite.code);
    const first = (await owner.sendChannelMessage(community.id, general.id, { text: 'Всем привет! Сбор в восемь.' })).message;
    await people[1].api.sendChannelMessage(community.id, general.id, { text: 'Буду', replyTo: first.id });
    await people[2].api.reactChannelMessage(community.id, general.id, first.id, '🔥');
    for (let i = 0; i < 60; i++) await people[1 + i % 3].api.sendChannelMessage(community.id, general.id, { text: `Сообщение ${i + 1}${i % 7 === 3 ? ' — подлиннее, чтобы перенеслось на вторую строку' : ''}` });
    await people[3].api.sendChannelMessage(community.id, general.id, { text: `@${handle} глянь, пожалуйста` });
    if (news) await owner.sendChannelMessage(community.id, news.id, { text: 'Турнир в субботу, начало в полдень.' });
    await owner.createCommunity({ kind: 'blog', name: 'Заметки', category: 'blog' });
    console.log('communities seeded');
  } catch (error) { console.log(`communities not seeded: ${error.message}`); }
}
// Platina looks (the metal name, the platinum ring, a nameplate, a colour frame) for three of the people, when the
// local server's data folder is given: the grant goes through the server's own administrator tool, as in production.
const dataDir = process.argv[4];
if (dataDir) {
  const { execFileSync } = await import('node:child_process');
  const looks = [{ nameplate: 'crows' }, {}, { avatarFrame: 'aurora' }];
  for (const [index, look] of looks.entries()) {
    try {
      execFileSync(process.execPath, [new URL('../server/src/platina-admin.js', import.meta.url).pathname, 'grant-permanent', '--data-dir', dataDir, '--user-id', people[index].id, '--reason', 'simulator walk'], { stdio: 'pipe' });
      if (Object.keys(look).length) await people[index].api.profile(look);
    } catch (error) { console.log(`Platina look of person ${index} not set: ${error.message}`); }
  }
}
for (const person of people) await person.service.close();
console.log(JSON.stringify({ people: people.length, messages: sent, to: found.id }));
