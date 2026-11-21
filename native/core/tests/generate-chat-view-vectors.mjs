// Produces tests/vectors/chat-view.json: what a chat shows (foldChat) and the chat-list / reply / fallback lines,
// as the reference itself (mobile/src/messageMeta.ts and the helpers it calls) answers for many generated chats.
// Run from the repository root:  node native/core/tests/generate-chat-view-vectors.mjs
//
// One case per line (each line is JSON.stringify's own text; the Rust test checks that it reads and writes every
// line back to the same text, so the expected values are compared as the reference's JSON text):
//  {"kind":"chat","messages":[…],"userId","hidden":[…],"now", "fold":{messages,pinned,rules,nextExpiry},
//     "list": listPreviewMessage(messages) | null, "ends": [index in messages of each dedupeCallEnds(messages) item],
//     "rows": [[flags, chatListText, replyPreview] per message]}       flags: 1 isQuietAction, 2 isAction,
//     4 isCallSignal, 8 skippedInList, 16 isCallEnd
//  {"kind":"line","message":{…},"key": messageKey, "list": chatListText, "reply": replyPreview}
//  {"kind":"time","sent","edit","now","inTime": editInTime(sent, edit),"open": editWindowOpen(sent, now)}
//  {"kind":"fallback","action":{…},"target","text": actionFallback(action, target) | null (undefined)}
//  {"kind":"call","action":{…},"text": callPreview(action)}
//  {"kind":"poll","poll":{…},"text": pollFallback(poll)}
// The reference's `byClientId` Map is not written: it is checked here to be exactly `messages` by clientId.
//
// Branch coverage of the reference is measured with V8's own block coverage (node:inspector) over the functions the
// Rust module ports; the run fails if any block of them never ran.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { Session } from 'node:inspector/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const file = name => join(root, 'mobile/src', name);

// Coverage has to be on before the reference is compiled.
const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const ref = await import(pathToFileURL(file('messageMeta.ts')).href);
const { foldChat, listPreviewMessage, chatListText, replyPreview, pollFallback, actionFallback, callPreview, editInTime, editWindowOpen,
  isQuietAction, isAction, isCallSignal, skippedInList, isCallEnd, dedupeCallEnds, messageKey, validMeta, REACTIONS, AUTO_DELETE, EDIT_WINDOW_MS, EDIT_CLOCK_SKEW_MS } = ref;

// ---- a deterministic generator ----
let seed = 0x1e2a7c35;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = n => Math.floor(rnd() * n);
const between = (a, b) => a + int(b - a + 1);
const chance = p => rnd() < p;
const pick = list => list[int(list.length)];
const weighted = table => { let at = rnd() * table.reduce((sum, row) => sum + row[0], 0); for (const row of table) { at -= row[0]; if (at < 0) return row[1]; } return table[table.length - 1][1]; };
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[int(16)]).join('');
const uuid = () => { const id = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`; return chance(0.05) ? id.toUpperCase() : id; };

const count = {};
const hit = (name, by = 1) => { count[name] = (count[name] ?? 0) + by; };

const WORDS = ['привет', 'как дела?', 'ok', 'Завтра в 10', 'смотри 👀', '❤️', '👍🏽', '👨‍👩‍👧 семья', 'line one\nline two', 'tabs\tand  spaces', ' leading', 'trailing ', ' nbsp ', 'a b', '🇷🇺 флаг',
  'секрет: 1234', 'пароль qwerty', 'https://example.org/x?y=1', '«цитата»', 'Очень длинное сообщение, которое не помещается в одну строку списка чатов и будет обрезано', '1', 'да', 'нет', '😀😀😀', '   ', '\n\n', 'x\ud83dy', '\ude00 lone'];
const someText = () => {
  if (chance(0.03)) return '';
  if (chance(0.02)) { const filler = pick(['я', '😀', 'ab ', '𝒳']); return filler.repeat(between(60, 260)).slice(0, between(190, 420)); }
  return Array.from({ length: between(1, 3) }, () => pick(WORDS)).join(pick([' ', ' ', '  ', '\n', '']));
};
const ENTITY_TYPES = ['bold', 'italic', 'underline', 'strikethrough', 'code', 'pre', 'spoiler', 'quote', 'text_link'];
// Valid for a text of `length` code units when `strict` (an edit), else only within the 8000 of validMeta.
const someEntities = (length, strict) => {
  const list = [];
  for (let i = between(1, 4); i > 0; i--) {
    const type = chance(0.55) ? 'spoiler' : pick(ENTITY_TYPES);
    let offset = int(Math.max(1, length)), size = between(1, Math.max(1, length - offset));
    if (!strict && chance(0.2)) { offset = between(0, length + 5); size = between(1, 30); }
    if (strict && offset + size > length) continue;
    list.push({ type, offset, length: size, ...(type === 'text_link' ? { url: 'https://example.org/a' } : {}), ...(type === 'pre' && chance(0.5) ? { language: 'rust' } : {}) });
  }
  return list;
};
const ATTACHMENTS = [
  () => ({ name: `voice-${between(1, 1e15)}.m4a`, mimeType: 'audio/mp4', media: pick([{ durationMs: between(1, 4000000) }, { durationMs: 0 }, { durationMs: 999 }, { durationMs: 61000, waveform: 'ABCDEFGH' }, {}]) }),
  () => ({ name: `voice-${between(1, 1e9)}.m4a`, mimeType: 'audio/mp4' }),
  () => ({ name: pick(['voice-.m4a', 'voice-12345678901234567.m4a', 'voice-12.m4a\n', 'xvoice-1.m4a', 'voice-1x.m4a', 'voice-1.M4A']), mimeType: 'audio/mp4', media: { durationMs: 5000 } }),
  () => ({ name: 'voice-77.m4a', mimeType: pick(['audio/mpeg', 'audio/mp4 ', 'video/mp4']), media: { durationMs: 5000 } }),
  () => ({ name: `circle-${between(1, 1e12)}.mp4`, mimeType: 'video/mp4', media: { durationMs: 12000, width: 384, height: 384 } }),
  () => ({ name: pick(['circle-1.mp4', 'circle-.mp4', 'circle-1.mov', 'circle-12345678901234567.mp4']), mimeType: pick(['video/mp4', 'video/quicktime', 'image/gif']) }),
  () => ({ name: 'IMG_0001.jpg', mimeType: pick(['image/jpeg', 'image/png', 'image/']), media: { width: 4000, height: 3000 } }),
  () => ({ name: 'clip.mov', mimeType: pick(['video/quicktime', 'video/mp4', 'video/']) }),
  () => ({ name: pick(['Договор.pdf', 'archive.zip', '', 'file with  spaces.txt', '😀.bin', 'д'.repeat(230)]), mimeType: pick(['application/pdf', 'application/octet-stream', 'Image/jpeg', 'audio/mp4', '']) }),
];
const someAttachment = () => ({ id: uuid(), ...pick(ATTACHMENTS)(), size: between(1, 5000000) });
const iso = ms => new Date(ms).toISOString();
// Spellings both Date.parse and the core's ISO reader take (and a few neither does).
const otherSpelling = ms => { const text = iso(ms); return pick([text.replace('.000Z', 'Z').replace(/\.\d{3}Z$/, 'Z'), text.slice(0, 10), text.slice(0, 16) + 'Z', text.slice(0, 19) + '+03:00', text.slice(0, 23) + '-05:30', text.slice(0, 21) + 'Z']); };
const BAD_DATES = ['', 'не дата', 'invalid', '2026-13-01T00:00:00.000Z', '2026-11-21T25:00:00Z', 'x2026-11-21T07:00:00Z', '2026-11-21T07:61:00Z'];
const STATES = ['failed', 'no-key', 'invalid', 'legacy', 'unverified'];
const DAY = 86400000;

function makeChat(size) {
  const A = uuid(), B = uuid(), C = uuid();
  const chatId = chance(0.15) ? uuid() : 'c' + int(1000);
  const out = [];
  const content = []; // rows that are not actions (and call ends): what an action can aim at
  let t = Date.UTC(2026, between(0, 10), between(1, 28), int(24), int(60), int(60), int(1000));
  let nextId = between(1, 5000);
  const leanChat = chance(0.15);
  const sender = () => weighted([[46, A], [46, B], [5, C], [1, '']]);
  const tick = () => { t += weighted([[60, () => between(1, 300) * 1000 + int(1000)], [20, () => between(1, 20) * 3600000], [12, () => between(1, 3) * DAY], [8, () => between(20, 40) * DAY]])(); return t; };
  const push = (senderId, fields, at = tick()) => {
    const message = { id: nextId, chatId, senderId, clientId: uuid(), text: '', attachment: null, createdAt: iso(at), cryptoState: 'decrypted', ...fields };
    nextId += weighted([[80, 1], [15, between(2, 9)], [5, 0]]);
    message.at = at; // the generator's own note of the time, removed before writing
    out.push(message);
    return message;
  };
  const target = (own) => {
    // Mostly a real message; sometimes an action's clientId (not something shown) or one that does not exist.
    const pool = own === undefined ? content : content.filter(row => (row.senderId === own.id) === own.same);
    const kind = weighted([[82, 'real'], [8, 'action'], [10, 'missing']]);
    if (kind === 'real' && pool.length) return pick(pool);
    const actions = out.filter(row => row.meta?.action);
    if (kind === 'action' && actions.length) return pick(actions);
    return { clientId: uuid(), missing: true, at: t };
  };
  const plain = () => {
    const text = someText(), meta = {};
    if (chance(0.3) && text.length) { const entities = someEntities(text.length, false); if (entities.length) meta.entities = entities; }
    if (chance(0.12) && content.length) { const to = pick(content); meta.reply = { clientId: to.clientId.length === 36 ? to.clientId : uuid(), senderId: /^[0-9a-f-]{36}$/i.test(to.senderId) ? to.senderId : A, preview: to.text.slice(0, 200) }; }
    else if (chance(0.04)) meta.story = { id: uuid(), ownerId: B };
    if (chance(0.05)) meta.forward = { from: 'Анна' };
    if (chance(0.05)) meta.silent = true;
    const attachment = chance(0.22) ? someAttachment() : null;
    if (attachment && chance(0.2)) meta.album = { id: uuid(), index: 0, count: 2 };
    const row = push(sender(), { text: attachment && chance(0.6) ? '' : text, attachment, ...(Object.keys(meta).length ? { meta } : {}) });
    if (chance(0.03)) row.meta = pick([null, {}]) ?? null; // an empty or null meta is still «no action»
    content.push(row); hit('row: text/attachment');
  };
  const poll = () => {
    const options = Array.from({ length: between(2, 10) }, (_, index) => pick(['да', 'нет', 'может быть', 'вариант', '😀']) + ' ' + index);
    const meta = { poll: { question: pick(['Когда встреча?', 'Пицца или суши?', 'q'.repeat(255)]), options, multiple: chance(0.5) } };
    if (chance(0.1)) meta.entities = [{ type: 'spoiler', offset: 0, length: 3 }];
    content.push(push(sender(), { text: pollFallback(meta.poll), meta })); hit('row: poll');
  };
  const act = (senderId, action, at) => push(senderId, { text: actionFallback(action) ?? '', meta: { action } }, at);
  const edit = () => {
    const who = sender();
    const to = target(weighted([[75, { id: who, same: true }], [15, { id: who, same: false }], [10, undefined]]));
    const text = chance(0.9) ? someText().trim() || 'исправлено' : 'x'.repeat(between(1, 30));
    const action = { type: 'edit', target: to.clientId, text };
    if (chance(0.35)) { const entities = someEntities(text.length, true); if (entities.length) action.entities = entities; }
    const limit = to.at + EDIT_WINDOW_MS + EDIT_CLOCK_SKEW_MS;
    // In time, on the very edge of the window (± 1 ms), past it, or «before» the message (clocks differ).
    const at = weighted([[55, () => tick()], [8, () => limit], [8, () => limit + 1], [8, () => limit - 1], [6, () => to.at + EDIT_WINDOW_MS], [8, () => limit + between(2, 5 * DAY)], [7, () => to.at - between(0, DAY)]])();
    act(who, action, at); hit('action: edit');
  };
  const remove = () => { act(sender(), { type: 'delete', target: target().clientId }); hit('action: delete'); };
  const react = () => {
    const to = target();
    for (let i = weighted([[70, 1], [20, 2], [10, 4]]); i > 0; i--) {
      // An emoji outside the list cannot pass validMeta; the fold would still take it, and the vectors pin how.
      const emoji = weighted([[52, () => pick(REACTIONS)], [8, () => REACTIONS[int(3)]], [20, () => to.emoji ?? pick(REACTIONS)], [14, () => null], [6, () => pick(['🦄', '🧨', ''])]])();
      if (emoji) to.emoji = emoji; // the next one may put the same emoji on it
      act(sender(), { type: 'react', target: to.clientId, emoji }); hit(emoji === null ? 'action: react (remove)' : REACTIONS.includes(emoji) ? 'action: react' : 'action: react (emoji outside the list — not valid meta)');
    }
  };
  const pin = () => { const action = { type: 'pin', target: chance(0.25) ? null : target().clientId }; act(sender(), action); hit(action.target ? 'action: pin' : 'action: unpin'); };
  const vote = () => {
    const polls = content.filter(row => row.meta?.poll);
    const to = polls.length && chance(0.85) ? pick(polls) : target();
    const size = to.meta?.poll?.options.length ?? 4;
    for (let i = weighted([[60, 1], [25, 2], [15, 3]]); i > 0; i--) {
      const all = Array.from({ length: 10 }, (_, index) => index).sort(() => rnd() - 0.5);
      const options = weighted([[45, () => [int(size)]], [25, () => all.filter(index => index < size).slice(0, between(2, 4))], [15, () => []], [10, () => all.slice(0, between(1, 3))], [5, () => [size > 9 ? 9 : size]]])();
      act(sender(), { type: 'vote', target: to.clientId, options }); hit(options.length ? 'action: vote' : 'action: vote (retract)');
    }
  };
  const settings = () => { act(sender(), { type: 'settings', ttl: pick(AUTO_DELETE), noCopy: chance(0.4) }); hit('action: settings'); };
  const clear = () => { act(sender(), { type: 'clear' }); hit('action: clear'); };
  const call = () => {
    const id = uuid(), caller = sender(), callee = caller === A ? B : A, video = chance(0.3);
    const sdp = 'v=0\r\no=-';
    const end = (who, withDuration) => {
      const action = { type: 'call', call: id, step: 'end' };
      if (chance(0.5)) action.video = video;
      const reason = pick([undefined, 'hangup', 'declined', 'busy', 'missed', 'failed']);
      if (reason) action.reason = reason;
      if (withDuration) action.duration = pick([0, 5, 59, 60, 192, 3599, 3600, 3725, 86400, 604800]);
      if (chance(0.6)) action.caller = who === caller;
      const row = act(who, action); hit('action: call end');
      if (chance(0.5)) content.push(row); // also something a later action may aim at
      return row;
    };
    const shape = weighted([[30, 'full'], [20, 'missed'], [15, 'two ends'], [10, 'three ends'], [10, 'lone end'], [15, 'signalling only']]);
    if (shape !== 'lone end') { act(caller, { type: 'call', call: id, step: 'offer', sdp, ...(video ? { video } : {}) }); hit('action: call offer'); }
    if (shape === 'full' || shape === 'two ends' || shape === 'three ends' || (shape === 'signalling only' && chance(0.5))) { act(callee, { type: 'call', call: id, step: 'answer', sdp }); hit('action: call answer'); }
    if (shape === 'signalling only' || chance(0.15)) { const gen = between(1, 3); act(caller, { type: 'call', call: id, step: 'restart', sdp, gen }); act(callee, { type: 'call', call: id, step: 'restart-answer', sdp, gen }); hit('action: call restart', 2); }
    if (shape === 'full' || shape === 'lone end') end(pick([caller, callee]), chance(0.7));
    if (shape === 'missed') end(caller, false);
    if (shape === 'two ends' || shape === 'three ends') {
      // Both phones sent one: with and without the duration, in either order.
      const first = chance(0.5); end(caller, first); end(callee, chance(0.5) ? !first : first);
      if (shape === 'three ends') end(pick([caller, callee]), chance(0.5));
    }
  };
  const makers = [[34, plain], [6, poll], [12, edit], [7, remove], [11, react], [6, pin], [8, vote], [5, settings], [1.5, clear], [7, call]];
  while (out.length < size) (content.length < 2 && chance(0.7) ? plain : weighted(makers))();
  out.length = size;

  // The odd rows of a real history.
  for (const row of [...out]) {
    if (chance(0.03)) { row.createdAt = pick(BAD_DATES); hit('row: unreadable date'); }
    else if (chance(0.05)) row.createdAt = otherSpelling(row.at);
    if (chance(0.14)) {
      // Not decrypted (or no state at all — a server row): usually nothing readable is left, sometimes the meta is.
      if (chance(0.4)) { delete row.cryptoState; hit('row: no cryptoState'); }
      else { row.cryptoState = pick(STATES); hit('row: cryptoState ' + row.cryptoState); if (chance(0.6)) { delete row.meta; row.text = ''; } if (row.cryptoState === 'legacy') row.legacy = true; }
    }
    if (leanChat || chance(0.05)) { row.lean = true; hit('row: lean'); }
    else if (chance(0.1)) row.encrypted = { scheme: 'signal-v1', senderDeviceId: A, envelopes: [] };
    if (chance(0.04)) { row.id = pick([0, -1, -between(2, 1000), nextId + between(1, 50), between(1, 5000)]); hit('row: id out of order / not positive'); }
    if (chance(0.03) && out.length > 1) { row.id = pick(out).id; hit('row: id repeated'); }
    if (chance(0.04)) {
      // A Mesh copy of the same message (the same clientId), and a foreign row that reuses a clientId.
      const copy = { ...row, id: pick([row.id, nextId + int(20), -between(1, 99)]), mesh: true };
      if (chance(0.3)) { copy.senderId = pick([A, B]); copy.text = someText(); delete copy.meta; hit('row: clientId reused by another row'); } else hit('row: mesh copy');
      out.push(copy);
    }
  }
  if (chance(0.25)) out.sort(() => rnd() - 0.5);
  if (out.length > 60) out.length = 60;

  const userId = weighted([[45, A], [45, B], [10, C]]);
  const hidden = [];
  for (const row of out) {
    if (chance(0.05)) hidden.push(messageKey(row));
    else if (chance(0.02)) hidden.push(messageKey({ senderId: row.senderId === A ? B : A, clientId: row.clientId }));
  }
  const ttl = pick(AUTO_DELETE.filter(Boolean)) * 1000, some = out.length ? pick(out) : { at: t };
  const now = weighted([[25, () => t + between(0, 3600000)], [45, () => some.at + ttl + pick([-1, 0, 1, 1, between(-DAY, DAY)])], [15, () => t + between(1, 90) * DAY], [15, () => t - between(30, 400) * DAY]])();
  for (const row of out) {
    delete row.at; delete row.emoji;
    if (row.meta && Object.keys(row.meta).length && !validMeta(row.meta) && !(row.meta.action?.type === 'react' && !REACTIONS.includes(row.meta.action.emoji))) throw new Error('the generator made a meta the reference refuses: ' + JSON.stringify(row.meta));
  }
  return { messages: out, userId, hidden, now };
}

const lines = [];
const write = value => lines.push(JSON.stringify(value));
const flags = row => (isQuietAction(row) ? 1 : 0) | (isAction(row) ? 2 : 0) | (isCallSignal(row) ? 4 : 0) | (skippedInList(row) ? 8 : 0) | (isCallEnd(row) ? 16 : 0);

// ---- chats ----
const CHATS = 1600; // about 7 KiB of vectors each
for (let index = 0; index < CHATS; index++) {
  const size = index < 3 ? index : weighted([[55, () => between(0, 7)], [33, () => between(5, 18)], [12, () => between(20, 60)]])();
  // The reference is given exactly what the core is given: the JSON text, read back.
  const made = JSON.parse(JSON.stringify(makeChat(size)));
  const { messages, userId, hidden } = made;
  let { now } = made;
  // Half of the time `now` stands right at a moment a message expires (± 1 ms): the reference itself says when
  // (the earliest expiry after a given moment), so the edge is met whatever the dates look like.
  if (chance(0.5)) {
    let edge = foldChat(messages, userId, new Set(hidden), -1e18).nextExpiry;
    for (let steps = int(4); steps > 0 && Number.isFinite(edge); steps--) { const next = foldChat(messages, userId, new Set(hidden), edge).nextExpiry; if (!Number.isFinite(next)) break; edge = next; }
    if (Number.isFinite(edge)) { now = edge + pick([-1, 0, 0, 1]); hit(now === edge ? 'chat: now exactly at an expiry' : 'chat: now 1 ms off an expiry'); }
  }
  const before = JSON.stringify(messages);
  const view = foldChat(messages, userId, new Set(hidden), now);
  if (view.byClientId.size !== view.messages.length || !view.messages.every(item => view.byClientId.get(item.clientId) === item)) throw new Error('byClientId is no longer messages by clientId');
  const fold = { messages: view.messages, pinned: view.pinned, rules: view.rules, nextExpiry: view.nextExpiry };
  const ends = dedupeCallEnds(messages).map(item => messages.indexOf(item));
  const list = listPreviewMessage(messages);
  write({ kind: 'chat', messages, userId, hidden, now, fold, list, ends, rows: messages.map(row => [flags(row), chatListText(row), replyPreview(row)]) });
  if (JSON.stringify(messages) !== before) throw new Error('the reference changed its input');

  // What came out, for the count at the end.
  hit('chats'); hit('rows', messages.length); hit('shown', fold.messages.length);
  if (!messages.length) hit('chat: empty');
  if (fold.pinned) hit('fold: pinned shown'); if (messages.some(row => row.meta?.action?.type === 'pin' && row.meta.action.target && row.cryptoState === 'decrypted') && !fold.pinned) hit('fold: pin of nothing shown');
  if (fold.rules.ttl) hit('fold: rules.ttl on'); if (fold.rules.noCopy) hit('fold: rules.noCopy on');
  if (typeof view.nextExpiry === 'number') hit(Number.isNaN(view.nextExpiry) ? 'fold: nextExpiry NaN (written null)' : 'fold: nextExpiry set');
  for (const item of fold.messages) {
    if (item.edited) hit('fold: edited'); if (item.edited && !item.meta) hit('fold: edit left no meta'); if (item.edited && item.meta?.entities) hit('fold: edit brought entities');
    if (item.reactions.length) hit('fold: with reactions'); if (item.reactions.length > 1) hit('fold: several emoji on one'); if (item.reactions.some(r => r.count > 1)) hit('fold: emoji counted twice'); if (item.reactions.some(r => r.mine)) hit('fold: my reaction');
    if (item.poll) hit('fold: poll'); if (item.poll?.voters) hit('fold: poll with votes'); if (item.poll?.voters > 1) hit('fold: poll, several voters'); if (item.poll?.mine.length) hit('fold: my vote'); if (item.poll?.mine.length > 1) hit('fold: my vote, several options');
    if (item.meta?.action?.type === 'call') hit('fold: call row'); if (item.mesh) hit('fold: mesh row shown'); if (item.cryptoState !== 'decrypted') hit('fold: undecrypted row shown');
  }
  const shown = new Set(fold.messages.map(item => item.clientId));
  const deleted = new Set(messages.filter(row => row.meta?.action?.type === 'delete' && row.cryptoState === 'decrypted').map(row => row.meta.action.target));
  for (const row of messages) {
    if (shown.has(row.clientId) || (isAction(row) && !isCallEnd(row))) continue;
    hit(deleted.has(row.clientId) ? 'fold: dropped — deleted' : hidden.includes(messageKey(row)) ? 'fold: dropped — hidden for me' : 'fold: dropped — cleared / expired / second call end');
  }
  hit(list === null ? 'list: nothing to show' : list.text !== messages.find(row => row.id === list.id && row.clientId === list.clientId && row.senderId === list.senderId)?.text ? 'list: text edited or masked' : 'list: as sent');
}

// ---- single lines ----
const row = (fields) => ({ id: 1, chatId: 'c', senderId: 'a', clientId: 'b', text: '', attachment: null, createdAt: iso(0), ...fields });
const lineCases = [];
for (let i = 0; i < 700; i++) {
  const text = someText(), meta = {};
  if (chance(0.7) && text.length) meta.entities = [...someEntities(text.length, false), ...(chance(0.3) ? [{ type: 'spoiler', offset: between(0, text.length), length: between(1, 9000) }] : [])];
  lineCases.push(row({ text: chance(0.25) ? '' : text, attachment: chance(0.5) ? someAttachment() : null, ...(Object.keys(meta).length ? { meta } : {}) }));
}
// Odd shapes the type allows or JSON can carry: the port must answer as the reference does.
for (const entities of [[{ type: 'spoiler', offset: 2, length: 3 }, { type: 'spoiler', offset: 2, length: 1 }], [{ type: 'spoiler', offset: 4, length: 2 }, { type: 'spoiler', offset: 0, length: 5 }], [{ type: 'spoiler', offset: 0, length: 8000 }],
  [{ type: 'spoiler', offset: 7999, length: 1 }], [{ type: 'bold', offset: 0, length: 2 }], [], [{ type: 'spoiler', offset: 1, length: 1 }, { type: 'spoiler', offset: 1, length: 1 }, { type: 'spoiler', offset: 0, length: 3 }],
  [{ type: 'spoiler', offset: -2, length: 4 }], [{ type: 'spoiler', offset: 1.5, length: 2 }], [{ type: 'spoiler', offset: 1, length: 2.5 }, { type: 'spoiler', offset: 4, length: 1 }], [{ type: 'spoiler', offset: 1 }], [{ type: 'spoiler', length: 2 }], [{ type: 'spoiler', offset: 3, length: 0 }], [{ type: 'spoiler', offset: 2, length: -1 }]]) {
  for (const text of ['секретное слово', '😀😀😀😀😀😀😀😀', 'a b\tc\nd', 'x', '', ' \n ', '0123456789abcdefghijklmnop', '\ud83d \ude00😀', '12😀 4']) lineCases.push(row({ text, meta: { entities } }));
}
for (const durationMs of [1, 999, 1000, 59999, 60000, 3599000, 3600000, 86400000, 1e15, 1e21, 2.5e22, -5, 0.5, 1500.7, 'x', '5000', true, null, [], {}]) lineCases.push(row({ attachment: { id: 'x', name: 'voice-1.m4a', mimeType: 'audio/mp4', size: 1, media: { durationMs } } }));
lineCases.push(row({ attachment: { id: 'x', name: 'voice-1.m4a', mimeType: 'audio/mp4', size: 1, media: null } }), row({ text: ' \n\t ', attachment: someAttachment() }), row({ text: '  a \n\n b  c  ' }), row({ meta: { poll: { question: '😀'.repeat(120), options: ['a', 'b'], multiple: false } }, text: 'x' }),
  row({ meta: { poll: { question: 'q'.repeat(197) + '😀', options: ['a', 'b'], multiple: true } } }), row({ text: 'я'.repeat(199) + '😀 дальше' }), row({ text: 'a'.repeat(198) + '😀😀' }), row({ text: '', attachment: { id: 'x', name: 'ж'.repeat(197) + '😀.pdf', mimeType: 'application/pdf', size: 1 } }),
  row({ text: 'call', meta: { action: { type: 'call', call: uuid(), step: 'end', reason: 'missed', video: true } } }), row({ text: 'offer', meta: { action: { type: 'call', call: uuid(), step: 'offer', sdp: 'v=0' } } }), row({ meta: null, text: 'null meta' }), row({ senderId: '', clientId: 'x:y' }), row({ senderId: 'a:b', clientId: '' }), row({ senderId: uuid(), clientId: uuid() }), row({ meta: {}, text: 'empty meta' }));
for (const message of JSON.parse(JSON.stringify(lineCases))) { write({ kind: 'line', message, key: messageKey(message), list: chatListText(message), reply: replyPreview(message) }); hit('lines'); }

// ---- the edit window ----
const T0 = Date.UTC(2026, 10, 21, 7, 0, 0, 0), LIMIT = EDIT_WINDOW_MS + EDIT_CLOCK_SKEW_MS;
const sentDates = [iso(T0), iso(T0).replace('.000Z', 'Z'), iso(T0).slice(0, 10), iso(T0).slice(0, 16) + 'Z', '2026-11-21T10:00:00+03:00', '2026-11-21T01:30:00.250-05:30', iso(0), iso(951782400000), ...BAD_DATES];
for (const sent of sentDates) {
  const base = Number.isFinite(Date.parse(sent)) ? Date.parse(sent) : T0;
  for (const delta of [0, 1, -1, EDIT_WINDOW_MS - 1, EDIT_WINDOW_MS, EDIT_WINDOW_MS + 1, LIMIT - 1, LIMIT, LIMIT + 1, LIMIT + DAY, -LIMIT, -400 * DAY, 3600000, between(0, 4 * DAY), between(0, 4 * DAY), 'bad']) {
    const edit = delta === 'bad' ? pick(BAD_DATES) : chance(0.2) ? iso(base + delta).replace(/\.\d{3}Z$/, m => m === '.000Z' ? 'Z' : m) : iso(base + delta);
    const now = delta === 'bad' ? base + between(-DAY, 3 * DAY) : pick([base + delta, base + delta + 0.5, base + delta - 0.5]);
    write({ kind: 'time', sent, edit, now, inTime: editInTime(sent, edit), open: editWindowOpen(sent, now) }); hit('times');
  }
}

// ---- fallback texts ----
const actions = [];
const targets = ['', '   ', 'короткий', '  с пробелами по краям \n', 'я'.repeat(59) + '😀 хвост', 'x'.repeat(200), '«уже в кавычках»', '\ud83d'];
for (const emoji of [...REACTIONS.slice(0, 6), REACTIONS[41], null, '', '🦄']) actions.push({ type: 'react', target: uuid(), emoji });
actions.push({ type: 'edit', target: uuid(), text: 'новый текст' }, { type: 'edit', target: uuid(), text: 'я'.repeat(8000) }, { type: 'edit', target: uuid(), text: 'a'.repeat(7985) + '😀😀' }, { type: 'edit', target: uuid(), text: 'x', entities: [{ type: 'bold', offset: 0, length: 1 }] },
  { type: 'delete', target: uuid() }, { type: 'pin', target: uuid() }, { type: 'pin', target: null }, { type: 'vote', target: uuid(), options: [] }, { type: 'vote', target: uuid(), options: [0] }, { type: 'vote', target: uuid(), options: [3, 1] }, { type: 'clear' },
  { type: 'unknown' }, {}, { type: 'settings', ttl: 5, noCopy: false }, { type: 'settings', ttl: 86400.5, noCopy: true });
for (const ttl of AUTO_DELETE) for (const noCopy of [false, true]) actions.push({ type: 'settings', ttl, noCopy });
const calls = [];
for (const step of ['offer', 'answer', 'restart', 'restart-answer']) for (const video of [undefined, false, true]) calls.push({ type: 'call', call: uuid(), step, sdp: 'v=0', ...(video === undefined ? {} : { video }), ...(step.startsWith('restart') ? { gen: 1 } : {}) });
for (const reason of [undefined, 'hangup', 'declined', 'busy', 'missed', 'failed']) for (const video of [undefined, false, true]) for (const duration of [undefined, 0, 1, 42, 59, 60, 192, 599, 600, 3599, 3600, 3725, 36000, 86399, 86400, 604800])
  calls.push({ type: 'call', call: uuid(), step: 'end', ...(reason ? { reason } : {}), ...(video === undefined ? {} : { video }), ...(duration === undefined ? {} : { duration }), ...(chance(0.5) ? { caller: chance(0.5) } : {}) });
// Not valid actions; the texts are still the reference's.
for (const duration of [null, '90', -5, 1.9, 61.5, 1e9, 1e21, 3e22, true, [], {}]) calls.push({ type: 'call', call: uuid(), step: 'end', duration });
calls.push({ type: 'call', call: uuid(), step: 'end', reason: 'other' }, { type: 'call', call: uuid(), step: 'end', video: 1, reason: 'busy' }, { type: 'call', call: uuid(), step: 'end', video: 0, duration: 7 }, { type: 'call', call: uuid(), step: 'elsewhere', video: 'yes' });
for (const action of JSON.parse(JSON.stringify([...actions, ...calls]))) for (const target of action.type === 'call' && action.step === 'end' ? targets.slice(0, 2) : targets) { write({ kind: 'fallback', action, target, text: actionFallback(action, target) ?? null }); hit('fallbacks'); }
for (const action of JSON.parse(JSON.stringify(calls))) { write({ kind: 'call', action, text: callPreview(action) }); hit('call previews'); }
for (let i = 0; i < 120; i++) {
  const poll = { question: pick(['Когда?', 'q'.repeat(255), '  вопрос  ', '😀'.repeat(100)]), options: Array.from({ length: between(2, 10) }, () => chance(0.1) ? 'о'.repeat(100) : pick(WORDS).trim() || 'вариант'), multiple: chance(0.5) };
  write({ kind: 'poll', poll, text: pollFallback(poll) }); hit('poll fallbacks');
}
for (const poll of [{ question: 'я'.repeat(4000), options: ['ж'.repeat(3990), 'конец 😀😀😀'], multiple: false }, { question: 'q', options: Array.from({ length: 12 }, (_, i) => 'x'.repeat(799) + i), multiple: true }, { question: '', options: [], multiple: false }]) { write({ kind: 'poll', poll, text: pollFallback(poll) }); hit('poll fallbacks'); }

// ---- did every branch of the reference run? ----
const { result } = await session.post('Profiler.takePreciseCoverage');
// The functions the core ports, as [file, from, to] marks in the source (the stripped source keeps every offset).
const PORTED = [
  ['messageMeta.ts', 'export const autoDeleteLabel', 'export type ChatRules'], ['messageMeta.ts', 'export function actionFallback', '/** One message from Telegram'],
  ['format/entities.ts', 'export function maskSpoilers', '\n/**\n * A text_link whose visible text'], ['calls/callModel.ts', 'export function formatCallDuration', '\n/**'],
  ['voice/voice.ts', 'export function isVoice', '/** Recording timer'], ['voice/voice.ts', 'export function formatVoiceTime(', '/** The chat list\'s line for an attachment'], ['voice/voice.ts', 'export function isVideoNote', '\n\n'],
];
let unreached = 0, blocks = 0;
for (const [name, from, to] of PORTED) {
  const source = readFileSync(file(name), 'utf8');
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`${name} changed: ${from}`);
  const script = result.find(entry => entry.url === pathToFileURL(file(name)).href);
  if (!script) throw new Error(`no coverage for ${name}`);
  for (const fn of script.functions) for (const range of fn.ranges) {
    if (range.startOffset < start || range.endOffset > end) continue;
    blocks++;
    if (range.count > 0) continue;
    unreached++;
    console.log(`NEVER RAN  ${name}:${source.slice(0, range.startOffset).split('\n').length}  ${JSON.stringify(source.slice(range.startOffset, Math.min(range.endOffset, range.startOffset + 110)))}`);
  }
}
await session.post('Profiler.stopPreciseCoverage');
session.disconnect();

for (const name of Object.keys(count).sort()) console.log(String(count[name]).padStart(7), name);
console.log(`reference coverage: ${blocks - unreached} of ${blocks} blocks (functions and branches) of the ported code ran`);
if (unreached) { console.error('not every branch of the reference was reached — vectors not written'); process.exit(1); }
writeFileSync(join(here, 'vectors', 'chat-view.json'), lines.join('\n') + '\n');
console.log('chat-view.json', lines.length, 'cases,', Math.round(lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) / 1024), 'KiB');
