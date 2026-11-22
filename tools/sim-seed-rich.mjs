// The realistic data of the side-by-side comparison (.github/workflows/native-compare.yml), on top of what
// tools/sim-seed.mjs sends with SIM_SEED_RICH=1. Imported by sim-seed.mjs only (never run by itself), so the people,
// their Signal sessions and the chats stay those of that one run. Everything goes to the LOCAL test server only.
//
//   beforeTimur(ctx)   Тимур's chat (the first of the list, the one the native app's `-openchat 1` opens) gets every
//                      kind of message the apps draw, BEFORE his usual texts, so the bottom of the chat (photo, file,
//                      voice, «Как тебе фото») stays as the older comparison shots expect it:
//                      short / long / big-emoji texts, a forwarded message, a photo with a caption, a reply quoting
//                      that photo (the quote has a thumbnail), an album of three, a video with a caption, a round
//                      video, a music file, a link, a poll with a vote, call rows (missed, 3:12, declined video),
//                      reactions, an edited message that is also pinned (the pinned bar).
//   afterSeed(ctx)     the account and the people around it: Тимур pinned, two chats muted, two archived, one
//                      person blocked by the account (Игорь) and one who blocked the account (Вера: the account's
//                      message to her fails), friends and an outgoing request, Platina for the account and Тимур with a
//                      banner, a frame, a nameplate, an emoji status and a pattern, posts and stories (Анна, Тимур, the
//                      account), gifts, a room.
//   serve(ctx, port)   stays running for the whole job (the workflow starts sim-seed.mjs in the background with
//                      SIM_SEED_SERVE=<port>): Ксюша keeps «печатает…», Тимур and Анна stay online, and two addresses
//                      on 127.0.0.1 let the Maestro flows ring the account (GET /ring: Анна calls, the incoming call
//                      screen shows) and stop the ring (GET /hangup: the call ends as missed).
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** A w×h PNG: a diagonal gradient between two colours with soft circles, so photos are told apart at a glance. */
export function picture(w, h, a, b, seed = 0) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const spots = [[0.3, 0.35, 0.18], [0.7, 0.6, 0.24], [0.45, 0.82, 0.12]].map(([x, y, r], i) => [((x + seed * 0.13 * (i + 1)) % 1) * w, ((y + seed * 0.07 * (i + 1)) % 1) * h, r * Math.min(w, h)]);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      let light = 0;
      for (const [sx, sy, r] of spots) { const d = Math.hypot(x - sx, y - sy); if (d < r) light = Math.max(light, 0.55 * (1 - d / r)); }
      const at = y * (w * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) { const v = a[c] + (b[c] - a[c]) * t; raw[at + c] = Math.round(v + (255 - v) * light); }
      raw[at + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xFFFFFFFF; for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A mono 16-bit WAV of a soft chord, `seconds` long. */
function tone(seconds, freqs = [220, 277, 330]) {
  const rate = 8000, samples = rate * seconds, pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(freqs.reduce((sum, f) => sum + Math.sin(i * 2 * Math.PI * f / rate), 0) / freqs.length * 9000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF'); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

const step = async (what, work) => { try { return await work(); } catch (error) { console.log(`rich seed: ${what} not done: ${error.message}`); return null; } };
const byName = (ctx, name) => ctx.people[ctx.names.indexOf(name)];

/** Sends an already uploaded attachment (a video, a round video) as a message of `from`. */
async function sayAttachment(ctx, from, attachment, text = '', meta) {
  const clientId = randomUUID();
  await from.api.sendEncrypted(from.chatId, clientId, await from.service.encrypt(from.chatId, ctx.found.id, clientId, text, attachment, meta));
  await from.service.delivered(from.chatId, clientId);
  return clientId;
}

export async function beforeTimur(ctx) {
  const { say, sayFile, found } = ctx;
  const t = ctx.people[ctx.people.length - 1], to = found.id;
  let sent = 0;
  const said = async (...args) => { const id = await step('a message', () => say(t, to, ...args)); if (id) sent++; return id; };
  await said('Привет! Собрал всё, что обещал 👇');
  const long = await said('Короче, по поездке: выезжаем в субботу в восемь утра от метро, едем на двух машинах. Палатки берёт Олег, '
    + 'котелок и горелку — я, с тебя спальник и фонарик. Если пойдёт дождь, переносим на воскресенье, я напишу в пятницу вечером.');
  await said('👍');
  await said('😂😂😂');
  await said('Встреча переносится на пятницу, 19:00', { forward: { from: 'Анна Лебедева' } });
  const photo = await step('the photo with a caption', () => sayFile(t, to, picture(640, 480, [52, 120, 190], [240, 170, 90], 1),
    { name: 'dacha.png', mimeType: 'image/png', media: { width: 640, height: 480, hdr: 'sdr' } }, 'Это мы на даче'));
  if (photo) { sent++; await said('Вот здесь, у озера', { reply: { clientId: photo, senderId: t.id, preview: 'Это мы на даче' } }); }
  const album = randomUUID();
  for (let index = 0; index < 3; index++) {
    const ok = await step(`album photo ${index + 1}`, () => sayFile(t, to, picture(480, index === 1 ? 640 : 480, [[90, 160, 90], [200, 90, 70], [120, 100, 210]][index], [240, 220, 120], index + 2),
      { name: `walk-${index + 1}.png`, mimeType: 'image/png', media: { width: 480, height: index === 1 ? 640 : 480, hdr: 'sdr' } }, index === 0 ? 'Три кадра с прогулки' : '', { album: { id: album, index, count: 3 } }));
    if (ok) sent++;
  }
  // A video and a round one («кружок»: the name circle-<ms>.mp4 makes both apps draw it round).
  await step('the videos', async () => {
    const { mp4Fixture, atom } = await import(new URL('mp4-fixture.mjs', ctx.support));
    const video = mp4Fixture({ metadata: false }).bytes;
    const plain = await ctx.uploadSmall(ctx.nodeSignalBridge, ctx.base, t.api.authHeaders, video, { name: 'video.mp4', mimeType: 'video/mp4', media: { width: 2, height: 2, durationMs: 2000, hdr: 'sdr' } });
    await sayAttachment(ctx, t, plain, 'Короткое видео'); sent++;
    const round = await ctx.uploadChunked(ctx.nodeSignalBridge, ctx.base, t.api.authHeaders, Buffer.concat([video, atom('free', Buffer.alloc(20000, 3))]),
      { name: `circle-${Date.now()}.mp4`, mimeType: 'video/mp4', media: { width: 2, height: 2, durationMs: 2000 } });
    await sayAttachment(ctx, t, round); sent++;
  });
  if (await step('the music file', () => sayFile(t, to, tone(4), { name: 'Северный ветер.wav', mimeType: 'audio/wav', media: { durationMs: 4000 } }))) sent++;
  await said('Глянь статью: https://example.com/article');
  const poll = await said('Куда идём в субботу?', { poll: { question: 'Куда идём в субботу?', options: ['В кино', 'В парк', 'Останемся дома'], multiple: false } });
  if (poll) await said('🗳 Голос в опросе', { action: { type: 'vote', target: poll, options: [1] } });
  await said('📞 Пропущенный звонок', { action: { type: 'call', call: randomUUID(), step: 'end', reason: 'missed', caller: true } });
  await said('📞 Звонок · 3:12', { action: { type: 'call', call: randomUUID(), step: 'end', reason: 'hangup', duration: 192, caller: true } });
  await said('📹 Отклонённый видеозвонок', { action: { type: 'call', call: randomUUID(), step: 'end', reason: 'declined', video: true, caller: false } });
  if (photo) await said('❤️ Реакция на сообщение', { action: { type: 'react', target: photo, emoji: '❤️' } });
  if (long) await said('🔥 Реакция на сообщение', { action: { type: 'react', target: long, emoji: '🔥' } });
  const meet = await said('Встречаемся в 18:00');
  if (meet) {
    await said('✏️ Изменено: Встречаемся в 19:00', { action: { type: 'edit', target: meet, text: 'Встречаемся в 19:00' } });
    await said('Закреплено сообщение', { action: { type: 'pin', target: meet } });
  }
  console.log(`rich seed: ${sent} messages in Тимур's chat`);
  return sent;
}

async function upload(ctx, api, bytes, name, purpose = '') {
  const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), name);
  const response = await fetch(ctx.base + '/uploads' + (purpose ? `?purpose=${purpose}` : ''), { method: 'POST', headers: api.authHeaders, body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || String(response.status));
  return body.attachment.id;
}

export async function afterSeed(ctx) {
  const { Api, base, found, login, password, word } = ctx;
  if (!login || !password) { console.log('rich seed: no sign-in of the account given, its side is not seeded'); return; }
  const mine = new Api(base, (await new Api(base).login(login, password, word || '')).token);
  const timur = ctx.people[ctx.people.length - 1], anna = ctx.people[0], ksyusha = byName(ctx, 'Ксюша');
  const chat = person => person?.chatId;
  // The list: Тимур pinned (he stays the first chat), Максим and Павел muted, Софья and Олег in the archive.
  await step('pin', () => mine.chatSettings(chat(timur), { pinned: true }));
  for (const name of ['Максим Голубев', 'Павел Крылов']) await step(`mute ${name}`, () => mine.chatSettings(chat(byName(ctx, name)), { muted: true }));
  for (const name of ['Софья Миронова', 'Олег Смирнов']) await step(`archive ${name}`, () => mine.chatSettings(chat(byName(ctx, name)), { archived: true }));
  // Blocks: the account blocked Игорь (the blocked list, the chat's «Разблокировать»); Вера blocked the account
  // (the message the reference sends her in the comparison's setup is refused: a failed message).
  await step('block Игорь', () => mine.block(byName(ctx, 'Игорь').id));
  await step('Вера blocks', () => byName(ctx, 'Вера').api.block(found.id));
  // Friends (stories and posts are for friends): Тимур and Ксюша besides Анна; an outgoing request to Наташа.
  for (const person of [timur, ksyusha]) await step('friends', async () => { await person.api.addContact(found.id); await mine.addContact(person.id); });
  await step('outgoing request', () => mine.addContact(byName(ctx, 'Наташа Белова').id));
  // Platina for the account and Тимур, through the server's own administrator tool (as for the others in sim-seed).
  if (ctx.dataDir) {
    const { execFileSync } = await import('node:child_process');
    for (const id of [found.id, timur.id]) await step('Platina', async () => execFileSync(process.execPath, [new URL('../server/src/platina-admin.js', import.meta.url).pathname, 'grant-permanent', '--data-dir', ctx.dataDir, '--user-id', id, '--reason', 'simulator comparison'], { stdio: 'pipe' }));
  }
  // The account's own look: a picture avatar, a bio, a banner, a frame, a nameplate, a pattern, an emoji status.
  await step('own avatar', async () => mine.profile({ avatarId: await upload(ctx, mine, picture(256, 256, [120, 90, 220], [240, 120, 160], 4), 'avatar.png') }));
  await step('own profile', () => mine.profile({ bio: 'Проверяю, как всё выглядит', bannerPreset: 'glacier', avatarFrame: 'frost', nameplate: 'aurora', profilePattern: '⭐' }));
  await step('own status', () => mine.changeStatusEmoji('🦋'));
  await step('Тимур profile', () => timur.api.profile({ bio: 'Фотограф. Горы, озёра, плёнка.', bannerPreset: 'ocean', avatarFrame: 'aurora', nameplate: 'deep' }));
  await step('Тимур status', () => timur.api.changeStatusEmoji('🔥'));
  // Posts and stories: Анна (a post and a story), Тимур (a story and a post), the account (a post and a story).
  const publish = async (person, api, kind, caption, colors, seed) => step(`${kind} of ${person}`, async () =>
    api.publishPost(await upload(ctx, api, picture(720, kind === 'story' ? 1280 : 720, ...colors, seed), `${kind}.png`, kind), kind, caption));
  await publish('Анна', anna.api, 'post', 'Новая кофейня на углу', [[94, 123, 255], [240, 200, 120]], 5);
  await publish('Анна', anna.api, 'story', 'Утро', [[154, 107, 255], [255, 180, 120]], 6);
  await publish('Тимур', timur.api, 'story', 'Вид с перевала', [[40, 110, 170], [200, 230, 250]], 7);
  await publish('Тимур', timur.api, 'post', 'Озеро на рассвете', [[30, 80, 140], [250, 190, 120]], 8);
  await publish('аккаунт', mine, 'post', 'Первая запись', [[120, 90, 220], [240, 120, 160]], 9);
  await publish('аккаунт', mine, 'story', '', [[60, 170, 200], [250, 230, 160]], 10);
  // Gifts to the account (its profile's «Подарки»).
  await step('gift from Анна', () => anna.api.sendGift(found.id, 'bouquet', 'С праздником!'));
  await step('gift from Тимур', () => timur.api.sendGift(found.id, 'rocket'));
  // A room of «свои»: Анна, the account and Ксюша. Only friends can be called into a room: Анна and Ксюша become
  // friends first (Анна and the account already are, sim-seed.mjs).
  await step('Анна and Ксюша friends', async () => { await anna.api.addContact(ksyusha.id); await ksyusha.api.addContact(anna.id); });
  await step('room', () => anna.api.createRoom([found.id, ksyusha.id], 'Вечерний созвон'));
  console.log('rich seed: the account side seeded');
}

const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
  + 'c=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:sim1\r\na=ice-pwd:simulatorsimulatorsimul\r\na=fingerprint:sha-256 '
  + Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':')
  + '\r\na=setup:actpass\r\na=mid:0\r\na=sendrecv\r\na=rtcp-mux\r\na=rtpmap:111 opus/48000/2\r\n';

/** Keeps a person's live connection open (online), optionally typing in their chat with the account. */
function live(ctx, person, typing) {
  const open = () => {
    let timer = null;
    const socket = new WebSocket(ctx.base.replace(/^http/, 'ws') + '/ws');
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'auth', token: person.api.token, lean: true }));
      timer = setInterval(() => {
        try { socket.send(JSON.stringify(typing && person.chatId ? { type: 'typing', chatId: person.chatId, isTyping: true } : { type: 'ping' })); } catch { /* reconnects below */ }
      }, 3000);
    });
    socket.addEventListener('close', event => { clearInterval(timer); console.log(`rich seed: live line closed (${event.code}), again in 5 s`); setTimeout(open, 5000); });
    socket.addEventListener('error', () => {});
  };
  open();
}

export async function serve(ctx, port) {
  const { createServer } = await import('node:http');
  const anna = ctx.people[0], ksyusha = byName(ctx, 'Ксюша'), timur = ctx.people[ctx.people.length - 1];
  live(ctx, ksyusha, true); live(ctx, timur, false); live(ctx, anna, false);
  let call = null;
  const send = async (meta, text, push) => {
    const clientId = randomUUID();
    await anna.api.sendEncrypted(anna.chatId, clientId, await anna.service.encrypt(anna.chatId, ctx.found.id, clientId, text, null, meta), push);
    await anna.service.delivered(anna.chatId, clientId);
  };
  createServer(async (request, response) => {
    try {
      if (request.url === '/ring') { call = randomUUID(); await send({ action: { type: 'call', call, step: 'offer', video: false, sdp: SDP } }, '📞 Звонок', 'call'); }
      else if (request.url === '/hangup' && call) { await send({ action: { type: 'call', call, step: 'end', reason: 'missed', caller: true } }, '📞 Пропущенный звонок', 'missed'); call = null; }
      else if (request.url !== '/health') { response.writeHead(404).end('unknown'); return; }
      console.log(`rich seed: ${request.url} done`);
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    } catch (error) {
      console.log(`rich seed: ${request.url} failed: ${error.message}`);
      response.writeHead(500).end(error.message);
    }
  }).listen(port, '127.0.0.1', () => console.log(`rich seed: serving on 127.0.0.1:${port}`));
  await new Promise(() => {}); // until the job ends
}
