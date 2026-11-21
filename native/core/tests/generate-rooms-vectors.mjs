// Produces tests/vectors/rooms.json: the rules of rooms («комнаты») as the reference itself answers them
// (mobile/src/rooms/rooms.ts, mobile/src/communities/voiceAuth.ts, `voiceRestartOfferer` of calls/reconnect.ts,
// and the «music for everyone» wire of rooms/roomMusic.tsx and communities/voice.ts).
// Run from the repository root:  node native/core/tests/generate-rooms-vectors.mjs
//
// One case per line (JSON.stringify's own text): {"name", "args", "want"} — `name` and `args` are what the apps
// hand to the core (`rooms::view`), `want` is the reference's answer put together the way the core's doc says.
// The Rust test (tests/rooms_vectors.rs) reads and writes every line back to the same text and compares the
// answers as JSON text (the seats: number by number, see there).
//
// rooms.ts, voiceAuth.ts and reconnect.ts are imported as they are (Node strips the types); what rooms.ts imports
// from the phone (React, the voice engine, the navigation) is replaced by stubs that do nothing. The rules of the
// music wire are written inside a React component and inside the voice engine, which cannot run here: their lines
// are copied below, and the run fails if the reference no longer holds those very lines (`pinned`).
//
// The lines about time («спит · были вчера в 18:20») are made in the time zone Europe/Berlin, which has summer
// time: the core is handed the local midnights and the offset, as a phone would hand them.
process.env.TZ = 'Europe/Berlin';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import { Session } from 'node:inspector/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const file = name => join(root, 'mobile/src', name);
const stub = source => ({ url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react') return stub('export const useSyncExternalStore = () => { throw new Error("not on a phone"); }; export default {};');
    if (context.parentURL?.endsWith('/mobile/src/rooms/rooms.ts')) {
      if (specifier === '../communities/voice') return stub('export const joinVoice = async () => {}; export const leaveVoice = () => {};');
      if (specifier === '../navigation') return stub('export const navigate = () => {};');
    }
    if (specifier.startsWith('.') && context.parentURL?.includes('/mobile/src/') && !/\.[a-z]+$/.test(specifier)) {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// `handleRoomEvent` reads the clock itself (when a ring arrived): the clock it reads is set here.
const RealDate = Date;
let clock = 1_795_244_400_000;
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(clock); else super(...args); }
  static now() { return clock; }
};

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const rooms = await import(pathToFileURL(file('rooms/rooms.ts')).href);
const auth = await import(pathToFileURL(file('communities/voiceAuth.ts')).href);
const reconnect = await import(pathToFileURL(file('calls/reconnect.ts')).href);

/** The reference must still hold this very text (rules that cannot be run here are copied from it). */
function pinned(name, text) {
  if (!readFileSync(file(name), 'utf8').includes(text)) throw new Error(`${name} changed: ${text.slice(0, 90)}`);
}

// ---- a deterministic generator ----
let seed = 0x2007c0de;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = n => Math.floor(rnd() * n);
const between = (a, b) => a + int(b - a + 1);
const chance = p => rnd() < p;
const pick = list => list[int(list.length)];
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[int(16)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

const lines = [];
const count = {};
const write = (name, args, want) => {
  const line = JSON.stringify({ name, args, want: want === undefined ? null : want });
  // What the apps hand over is JSON: a case must survive the trip unchanged.
  if (JSON.stringify(JSON.parse(line)) !== line) throw new Error(`not stable JSON: ${name}`);
  lines.push(line); count[name] = (count[name] ?? 0) + 1;
};

// ---- the constants ----
pinned('rooms/RoomScreen.tsx', 'maxLength={48}');
pinned('rooms/RoomScreen.tsx', "const TALK = '#3EE08E';");
pinned('rooms/RoomScreen.tsx', '}, 350);');
pinned('rooms/RoomsSection.tsx', 'const RING_MS = 30_000;');
pinned('rooms/roomMusic.tsx', 'const DRIFT = 2.5;');
pinned('rooms/roomMusic.tsx', 'const BEAT_MS = 4000;');
pinned('communities/voice.ts', 'const AUTH_TIMEOUT_MS = 20_000;');
pinned('communities/voice.ts', "const REFUSED = 'Не удалось подтвердить шифрование с участником — соединение с ним отключено.';");
pinned('communities/voice.ts', 'linkTimer = setInterval(() => { void checkLinks(); }, 4000);');
pinned('communities/voice.ts', "if (typeof report?.audioLevel !== 'number' || report.audioLevel <= 0.02) return;");
write('roomRules', [], { limit: rooms.ROOM_LIMIT, maxName: 48, ringMs: 30000, authTimeoutMs: 20000, linkPollMs: 4000, speakingPollMs: 350, speakingLevel: 0.02, musicDrift: 2.5, musicBeatMs: 4000,
  musicOff: JSON.stringify({ type: 'music', off: true }), talk: '#3EE08E', refused: 'Не удалось подтвердить шифрование с участником — соединение с ним отключено.' });

// ---- people and rooms ----
const NAMES = ['Лариса', 'Тимур Ахметов', 'Анна', 'Глеб Соколов', 'Мира', 'Ян', 'Зоя Никитина', 'Олег', 'Ева 🌿', 'Саша', 'Ника', 'Родион'];
const member = (id = uuid()) => ({ id, username: 'u' + hex(5), displayName: pick(NAMES), avatarColor: '#' + hex(6).toUpperCase(), avatarId: chance(0.3) ? uuid() : null });
const BASE = RealDate.parse('2026-11-21T10:00:00.000Z');
const stamp = () => new RealDate(BASE - int(40 * 86_400_000)).toISOString();
function room(me, size = between(2, 6)) {
  const members = [member(me), ...Array.from({ length: size - 1 }, () => member())];
  const inside = members.filter(() => chance(0.3)).map(item => ({ userId: item.id, muted: chance(0.3) }));
  const awake = inside.length > 0 || chance(0.3);
  return { id: uuid(), name: chance(0.5) ? 'Свои' : members.slice(1).map(item => item.displayName).join(', '), auto: chance(0.5), members, inside, awake,
    lastActiveAt: chance(0.25) ? null : chance(0.06) ? pick(['', 'вчера']) : stamp(), createdAt: chance(0.05) ? 'давно' : stamp() };
}

// ---- the order of the list ----
for (let i = 0; i < 110; i++) {
  const me = uuid();
  const list = Array.from({ length: between(0, 7) }, () => room(me, between(2, 3)));
  // Ties, so the order of equals is seen to be kept.
  if (list.length > 2 && chance(0.5)) { const copy = { ...list[0], id: uuid() }; list.splice(between(1, list.length), 0, copy); }
  if (list.length > 3 && chance(0.3)) for (const item of list) { item.inside = []; item.awake = chance(0.5); if (chance(0.5)) item.lastActiveAt = list[0].lastActiveAt; }
  write('roomSort', [list], rooms.sortRooms(list));
}

// ---- a group call from the chat list ----
{
  let asked = null;
  const api = { createRoom: async ids => { asked = ids; return { room: room(ids[0]) }; }, ringRoom: async () => { if (chance(0.3)) throw new Error('Ты уже звал в эту комнату. Подожди немного.'); return { ok: true, rang: 1 }; }, callIce: async () => ({ iceServers: [] }) };
  for (let i = 0; i < 250; i++) {
    const me = uuid();
    const pool = Array.from({ length: between(0, 15) }, uuid);
    const ids = [];
    for (const id of pool) { ids.push(id); if (chance(0.15)) ids.push(id); if (chance(0.1)) ids.push(me); if (chance(0.08)) ids.push(''); }
    if (chance(0.2)) ids.sort(() => rnd() - 0.5);
    asked = null;
    let want;
    try { await rooms.startRoomCall(api, {}, me, ids); want = { ids: asked }; } catch (failure) { want = { error: failure.message }; }
    write('roomCallCheck', [ids, me], want);
  }
  rooms.resetRooms();
}

// ---- what the live line says about rooms ----
{
  const snapshot = () => { const now = rooms.roomsNow(); return { rooms: now.rooms, openId: now.openId, ring: now.ring }; };
  for (let run = 0; run < 36; run++) {
    const me = uuid();
    rooms.resetRooms();
    const known = Array.from({ length: between(0, 4) }, () => room(me, between(2, 4)));
    if (chance(0.85)) await rooms.loadRooms({ rooms: async () => ({ rooms: known }) }, me);
    for (let step = 0; step < 14; step++) {
      clock += between(1, 90_000);
      const have = rooms.roomsNow().rooms || [];
      const some = () => (have.length && chance(0.85) ? pick(have) : room(me, between(2, 4)));
      const target = some();
      let event;
      const kind = int(13);
      if (kind === 0) event = { type: 'room.created', room: room(me, between(2, 4)) };
      else if (kind === 1) event = { type: 'room.updated', room: { ...target, name: pick(NAMES), auto: false, members: chance(0.5) ? target.members : [...target.members, member()] } };
      else if (kind === 2) event = { type: 'room.removed', roomId: target.id };
      else if (kind <= 5) {
        const inside = target.members.filter(() => chance(0.4)).map(item => ({ userId: item.id, muted: chance(0.3) }));
        event = { type: 'room.state', roomId: target.id, inside: chance(0.06) ? pick([null, 'нет', 5]) : inside, awake: chance(0.1) ? pick([1, 0, 'да', '', null]) : inside.length > 0 || chance(0.4) };
        if (chance(0.8)) event.lastActiveAt = chance(0.15) ? null : new RealDate(clock).toISOString();
        if (chance(0.05)) delete event.inside;
        if (chance(0.05)) delete event.awake;
      } else if (kind <= 8) {
        const from = chance(0.75) ? pick(target.members) : member();
        event = { type: 'room.ring', roomId: target.id, name: target.name, fromId: chance(0.1) ? me : from.id, fromName: from.displayName };
        if (chance(0.15)) delete event.fromName;
        if (chance(0.1)) event.name = pick([null, 5]);
        if (chance(0.05)) event.fromId = pick([null, 7]);
      } else if (kind === 9) { rooms.openRoom(chance(0.8) ? target.id : null); continue; }
      else if (kind === 10) event = pick([{ type: 'room.created', room: null }, { type: 'room.updated', room: {} }, { type: 'room.updated' }, { type: 'room.removed', roomId: 5 }, { type: 'room.removed' }, { type: 'room.state', roomId: null, inside: [] }, { type: 'room.ring', roomId: 9, fromId: uuid() }, { type: 'room.else', roomId: target.id }, { type: 'room.' }]);
      else if (kind === 11) event = pick([{ type: 'voice.state', channelId: target.id, roomId: target.id, members: [] }, { type: 'message' }, { type: 'rooms' }, { type: 'Room.removed', roomId: target.id }, { type: 5 }, {}, null, 7, 'room.removed', ['room.removed'], { type: null }]);
      else { if (chance(0.5)) rooms.dismissRing(); else rooms.forgetRoom(target.id); continue; }
      const before = snapshot();
      const handled = rooms.handleRoomEvent(event, me);
      write('roomEvent', [before, event, me, clock], handled ? snapshot() : null);
    }
  }
  rooms.resetRooms();
}

// ---- seats ----
{
  const ODD = ['я', '🙂', 'a', '', 'ab', 'Z', '\ud83d', '0', '１２'];
  for (let i = 0; i < 300; i++) {
    const me = chance(0.95) ? uuid() : pick(ODD);
    const others = Array.from({ length: between(0, 12) }, () => ({ id: chance(0.93) ? uuid() : pick(ODD) }));
    const members = chance(0.9) ? [{ id: me }, ...others] : others;
    if (others.length && chance(0.1)) members.push({ id: others[0].id });
    const value = { id: chance(0.95) ? uuid() : pick(ODD), members };
    write('roomSeats', [value, me], [...rooms.seats(value, me)].map(([id, place]) => ({ id, x: place.x, y: place.y })));
  }
  for (let members = 0; members <= 14; members++) for (const stage of [0, 1, 200, 320, 360, 366, 367, 368, 375, 390, 393, 414, 430, 500, 620, 1024, 364.5, 364.6, 302.0833333333333, 368.42105263157896, 359.375, 100.5, 2.0833333333333335])
    write('roomSeatSize', [members, stage], rooms.seatSize(members, stage));
}

// ---- the words ----
for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 100, -1, 1.5, 0.5, 4.5]) write('roomInsideLine', [n], rooms.insideLine(n));
{
  const midnight = ms => new RealDate(ms).setHours(0, 0, 0, 0);
  const offset = ms => -new RealDate(ms).getTimezoneOffset();
  const line = (at, now) => write('roomSleepLine', [at, now, at ? midnight(RealDate.parse(at)) : 0, midnight(now), at ? offset(RealDate.parse(at)) : 0], rooms.sleepLine({ lastActiveAt: at }, now));
  line(null, BASE); line('', BASE);
  // Around the nights the clocks change (29 March and 25 October 2026 in Berlin) and around midnight.
  const DAYS = ['2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26', '2026-11-21', '2026-01-01', '2025-12-31', '2024-02-29', '2026-07-15'];
  const TIMES = ['00:00:00.000', '00:00:01.000', '00:59:59.999', '01:30:00.000', '02:30:00.000', '03:05:00.000', '09:07:00.000', '12:00:00.000', '18:20:00.000', '21:59:59.000', '22:00:00.000', '22:59:59.999', '23:00:00.000', '23:59:59.999'];
  for (const day of DAYS) for (const time of TIMES) {
    const at = `${day}T${time}Z`, ms = RealDate.parse(at);
    for (const later of [0, 1, 60_000, 3_600_000, 6 * 3_600_000, 23 * 3_600_000, 86_400_000, 25 * 3_600_000, 47 * 3_600_000, 2 * 86_400_000, 9 * 86_400_000, -3_600_000, -86_400_000]) line(at, ms + later);
  }
  for (let i = 0; i < 300; i++) { const ms = BASE - int(500 * 86_400_000); line(new RealDate(ms).toISOString(), ms + (chance(0.5) ? int(3 * 86_400_000) : int(400 * 86_400_000))); }
}

// ---- the end-to-end check of a connection ----
const fp = () => Array.from({ length: 32 }, () => hex(2)).join(':');
function fingerprintLine() {
  const algo = chance(0.75) ? 'sha-256' : pick(['SHA-256', 'sha-1', 'Sha-384', 'sha_256', 'ш-256', 'x', '']);
  const value = chance(0.6) ? fp().toUpperCase() : chance(0.6) ? fp() : pick(['AB:CD', 'ab', ':', 'zz:zz', 'AB:CG', '']);
  const gap = chance(0.9) ? ' ' : pick(['  ', '\t', '', ' ', ' ', ' \r ']);
  const lead = chance(0.9) ? '' : pick([' ', '\t', '  ', '  ']);
  const tail = chance(0.85) ? '' : pick([' ', '\t ', ' x', ' ', '﻿', ';']);
  const start = chance(0.94) ? 'a=fingerprint:' : pick(['A=fingerprint:', 'a=fingerprint', 'a=Fingerprint:', 'xa=fingerprint:', 'a=fingerprint: ', 'a=fingerprint:\t']);
  return `${lead}${start}${algo}${gap}${value}${tail}`;
}
function sdp(prints = between(0, 3)) {
  const eol = pick(['\r\n', '\r\n', '\n', '\r']);
  const out = ['v=0', `o=- ${between(1, 9e9)} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0 1'];
  const own = Array.from({ length: prints }, fingerprintLine);
  if (own.length > 1 && chance(0.3)) own.push(own[0]);
  if (own.length && chance(0.2)) own.push(own[0].toLowerCase());
  for (const section of ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel']) {
    out.push(section, 'c=IN IP4 0.0.0.0', `a=ice-ufrag:${hex(4)}`, `a=ice-pwd:${hex(22)}`);
    if (own.length) out.push(own.shift());
    out.push('a=setup:actpass', 'a=mid:0');
  }
  out.push(...own);
  return out.join(eol) + (chance(0.8) ? eol : '');
}
const good = () => { const eol = pick(['\r\n', '\n']); return ['v=0', 's=-', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', `a=fingerprint:sha-256 ${fp().toUpperCase()}`, 'a=setup:actpass', ''].join(eol); };
const SOCKETS = ['a', 'b', 'aa', 'A', '', 'я', '￿', '😀', '\ud83d', '10', '9', 'socket-1', 'socket-10'];
const socket = () => (chance(0.85) ? uuid() : pick(SOCKETS));
for (let i = 0; i < 400; i++) {
  const [channelId, self, peer] = [uuid(), socket(), socket()];
  const [localSdp, remoteSdp] = [chance(0.6) ? good() : chance(0.05) ? '' : sdp(), chance(0.6) ? good() : chance(0.05) ? '' : sdp()];
  let text = null;
  try { text = auth.authText(channelId, self, peer, localSdp, remoteSdp); } catch { text = null; }
  write('roomAuthText', [channelId, self, peer, localSdp, remoteSdp], text);
}
for (let i = 0; i < 600; i++) {
  const [channelId, self, peer] = [uuid(), socket(), socket()];
  const [localSdp, remoteSdp] = [chance(0.85) ? good() : sdp(), chance(0.85) ? good() : sdp()];
  // The note the other side would write about the same connection: its «mine» is our «remote».
  let note = null;
  try { note = JSON.parse(auth.authText(channelId, peer, self, remoteSdp, localSdp)); } catch { note = null; }
  let text;
  const turn = int(16);
  if (!note || turn === 0) text = pick(['', 'не JSON', 'null', '5', '"v"', '[]', '{}', '{"v":1}', '[1]', 'true', '{"v":1,"mine":"a","yours":"b"}']);
  else {
    if (turn === 1) note.v = pick([2, '1', 0, null, true, 1.5]);
    else if (turn === 2) note.channelId = uuid();
    else if (turn === 3) [note.from, note.to] = [note.to, note.from];
    else if (turn === 4) [note.mine, note.yours] = [note.yours, note.mine];
    else if (turn === 5) note.mine = pick([5, null, '', note.mine.toLowerCase(), note.mine + ' ', 'sha-256 ' + fp().toUpperCase()]);
    else if (turn === 6) note.yours = pick([5, null, '', 'sha-256 ' + fp().toUpperCase()]);
    else if (turn === 7) delete note[pick(['v', 'channelId', 'from', 'to', 'mine', 'yours'])];
    else if (turn === 8) note.from = pick([null, 5, uuid()]);
    else if (turn === 9) note.to = pick([null, 5, uuid()]);
    else if (turn === 10) note = { extra: true, ...note, v: 1.0 };
    text = turn === 11 ? ' ' + JSON.stringify(note, null, 2) + '\n' : turn === 12 ? JSON.stringify(note) + 'x' : JSON.stringify(note);
  }
  const expected = { channelId, self, peer, localSdp, remoteSdp };
  write('roomCheckAuth', [text, expected], auth.checkAuth(text, expected));
}
for (let i = 0; i < 300; i++) { const [a, b] = [socket(), chance(0.1) ? null : socket()]; const self = a, peer = b ?? a; write('roomRestartOfferer', [self, peer], reconnect.voiceRestartOfferer(self, peer)); }
for (const a of SOCKETS) for (const b of SOCKETS) write('roomRestartOfferer', [a, b], reconnect.voiceRestartOfferer(a, b));

// ---- music for everyone ----
// The lines of the reference these rules are copied from (they sit inside a component and inside the voice engine).
pinned('rooms/roomMusic.tsx', "const validTrack = (t: Wire['t']): t is NonNullable<Wire['t']> => !!t && typeof t.id === 'string' && t.id.length <= 120 && (t.source === 'audius' || t.source === 'soundcloud')\n  && (t.sourceId === undefined || (typeof t.sourceId === 'string' && t.sourceId.length <= 80)) && typeof t.title === 'string' && typeof t.artist === 'string' && Number.isFinite(t.duration);");
pinned('rooms/roomMusic.tsx', "if (data.off) { if (hostRef.current === peer) {");
pinned('rooms/roomMusic.tsx', "if (!validTrack(data.t) || typeof data.pos !== 'number' || !Number.isFinite(data.pos)) return;");
pinned('rooms/roomMusic.tsx', 'const now = live.current, wanted = data.t!, place = Math.max(0, Math.min(data.pos!, wanted.duration || data.pos!));');
pinned('rooms/roomMusic.tsx', 'if (live.current.playing !== !!data.playing && !live.current.loading) await live.current.togglePlayback();');
pinned('rooms/roomMusic.tsx', "if (!current || current.source === 'local') return;");
pinned('rooms/roomMusic.tsx', 'sendRoomMusic({ t: { id: current.id, source: current.source, sourceId: current.sourceId, title: current.title.slice(0, 70), artist: current.artist.slice(0, 50), duration: Math.round(current.duration) }, pos: Math.round(now.position * 10) / 10, playing: now.playing });');
pinned('communities/voice.ts', "const text = JSON.stringify({ type: 'music', ...data });\n  if (text.length > 512) return false;");
pinned('communities/voice.ts', "if (typeof event.data === 'string' && event.data.length <= 512) {\n      let extra: any = null; try { extra = JSON.parse(event.data); } catch { /* not ours */ }");
pinned('communities/voice.ts', "if (extra?.type === 'music') { if (verified.has(peer)) musicListeners.forEach(listener => listener(peer, extra)); return; }");
const validTrack = t => !!t && typeof t.id === 'string' && t.id.length <= 120 && (t.source === 'audius' || t.source === 'soundcloud')
  && (t.sourceId === undefined || (typeof t.sourceId === 'string' && t.sourceId.length <= 80)) && typeof t.title === 'string' && typeof t.artist === 'string' && Number.isFinite(t.duration);
function musicIn(text) {
  if (!(typeof text === 'string' && text.length <= 512)) return null;
  let extra = null; try { extra = JSON.parse(text); } catch { /* not ours */ }
  if (extra?.type !== 'music') return null;
  const data = extra;
  if (data.off) return { off: true };
  if (!validTrack(data.t) || typeof data.pos !== 'number' || !Number.isFinite(data.pos)) return null;
  const wanted = data.t, place = Math.max(0, Math.min(data.pos, wanted.duration || data.pos));
  return { track: wanted, place, playing: !!data.playing };
}
function musicOut(current, position, playing) {
  if (!current || current.source === 'local') return null;
  const data = { t: { id: current.id, source: current.source, sourceId: current.sourceId, title: current.title.slice(0, 70), artist: current.artist.slice(0, 50), duration: Math.round(current.duration) }, pos: Math.round(position * 10) / 10, playing };
  const text = JSON.stringify({ type: 'music', ...data });
  if (text.length > 512) return null;
  return text;
}
const WORDS = ['Night Drive', 'Утро', 'Тихий океан 🌊', 'a', '', 'Очень длинное название трека, которое не помещается в строку и будет обрезано по семидесяти знакам ровно', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𝔱𝔦𝔱𝔩𝔢 𝔴𝔦𝔱𝔥 𝔰𝔲𝔯𝔯𝔬𝔤𝔞𝔱𝔢𝔰 𝔱𝔥𝔞𝔱 𝔦𝔰 𝔠𝔲𝔱 𝔦𝔫 𝔱𝔥𝔢 𝔪𝔦𝔡𝔡𝔩𝔢 𝔬𝔣 𝔞 𝔭𝔞𝔦𝔯 𝔥𝔢𝔯𝔢', '"quoted" \\ name', 'x'.repeat(200)];
const track = () => {
  const out = { id: chance(0.9) ? `${pick(['audius', 'soundcloud'])}:${hex(8)}` : pick(['', 'x'.repeat(120), 'x'.repeat(121), 'я'.repeat(120), 'z'.repeat(330), 'z'.repeat(420)]), source: chance(0.85) ? pick(['audius', 'soundcloud']) : pick(['local', 'local', 'Audius', '', 'youtube']),
    title: pick(WORDS), artist: pick(WORDS), duration: chance(0.9) ? pick([0, 1, 187, 187.4, 187.5, 188.5, 3600, 0.4, -3]) : rnd() * 600 };
  if (chance(0.6)) out.sourceId = chance(0.9) ? hex(10) : pick(['', 'x'.repeat(80), 'x'.repeat(81)]);
  return out;
};
for (let i = 0; i < 520; i++) {
  const current = track();
  const position = chance(0.8) ? pick([0, 0.04, 0.05, 0.15, 0.25, 12.34, 12.35, 99.95, 187, 4000, -1]) : rnd() * 300;
  const playing = chance(0.5);
  const text = musicOut(current, position, playing);
  write('roomMusicOut', [current, position, playing], text);
  if (text !== null) write('roomMusicIn', [text], musicIn(text));
}
for (let i = 0; i < 520; i++) {
  const t = chance(0.9) ? track() : pick([null, 5, 'track', [], {}]);
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const turn = int(14);
    if (turn === 0) t.sourceId = pick([null, 5, true]);
    else if (turn === 1) t.title = pick([null, 5]);
    else if (turn === 2) t.artist = pick([null, 5, undefined]);
    else if (turn === 3) t.duration = pick([null, '187', true, undefined]);
    else if (turn === 4) t.id = pick([null, 5, undefined]);
    else if (turn === 5) delete t.source;
  }
  const data = { type: chance(0.93) ? 'music' : pick(['Music', 'screen', 'caps', null, 5, undefined]), t, pos: chance(0.85) ? pick([0, 12.5, 187, 4000, -5, 0.1, 1e9]) : pick([null, '12', true, undefined]), playing: chance(0.8) ? chance(0.5) : pick([1, 0, 'да', '', null, undefined]) };
  if (chance(0.12)) data.off = pick([true, false, 1, 0, 'да', '', null]);
  if (chance(0.05)) delete data.t;
  let text = JSON.stringify(data);
  if (chance(0.04)) text = pick(['', 'музыка', '{', 'null', '5', '[]', '"music"', '{"type":"music"}', '{"type":"music","off":true}', '[{"type":"music"}]', ' {"type":"music","off":1} ']);
  write('roomMusicIn', [text], musicIn(text));
}
// The 512 characters of the channel, to the character (counted as JavaScript counts them).
for (const size of [500, 505, 510, 511, 512, 513, 514, 520, 600]) for (const fill of ['x', 'я', '🙂']) {
  const head = '{"type":"music","off":true,"pad":"', tail = '"}';
  let pad = ''; while ((head + pad + fill + tail).length <= size) pad += fill;
  const text = head + pad + tail;
  write('roomMusicIn', [text], musicIn(text));
}

// ---- coverage of the reference's own branches ----
const { result } = await session.post('Profiler.takePreciseCoverage');
const PORTED = [
  ['rooms/rooms.ts', 'export function sortRooms', 'const upsert'],
  ['rooms/rooms.ts', 'export function handleRoomEvent', 'export const openRoom'],
  ['rooms/rooms.ts', 'export async function startRoomCall', '// ---- Seats ----'],
  ['rooms/rooms.ts', 'const hash = ', null],
  ['communities/voiceAuth.ts', 'export function sdpFingerprints', null],
];
let unreached = 0, blocks = 0;
for (const [name, from, to] of PORTED) {
  const source = readFileSync(file(name), 'utf8');
  const start = source.indexOf(from), end = to === null ? source.length : source.indexOf(to, start + from.length);
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
writeFileSync(join(here, 'vectors', 'rooms.json'), lines.join('\n') + '\n');
console.log('rooms.json', lines.length, 'cases,', Math.round(lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) / 1024), 'KiB');
