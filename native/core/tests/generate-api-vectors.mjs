// Produces tests/vectors/api.json: the table of server endpoints (class `Api` in mobile/src/api.ts, from `health`
// to the end of the class) as the reference itself builds each request. The members are cut out of the source,
// stripped of types and evaluated inside a class whose `request(path, options)` only records what it was given.
// Run from the repository root:  node native/core/tests/generate-api-vectors.mjs
//
// One case per line: {op, args, device, method, path, body} (+ "throws":"URIError" with method/path/body null where
// the reference throws while building the path). `args` are the member's arguments as the Rust core takes them:
// `null` at an OPTIONAL position stands for `undefined` (it is turned into `undefined` before the member is called).
// `device` is what the member's helpers read: the DeviceInfo of deviceInfo.ts (deviceInfo() returns it, the real
// deviceFields() and the real `const deviceName = …` line run on it) and `networkTier` (what networkTier() returns).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const apiSource = readFileSync(join(root, 'mobile/src/api.ts'), 'utf8');
const deviceSource = readFileSync(join(root, 'mobile/src/deviceInfo.ts'), 'utf8');
const cutFrom = (source, name, from, to) => { const start = source.indexOf(from); const end = source.indexOf(to, start); if (start < 0 || end < 0) throw new Error(`${name} changed: ${from}`); return source.slice(start, end); };

// The members: everything from `health` to the brace that closes the class.
const membersText = cutFrom(apiSource, 'api.ts', '  health = ', '\n}\n');
const deviceNameLine = cutFrom(apiSource, 'api.ts', 'const deviceName = ', '\n');
if (deviceNameLine !== 'const deviceName = deviceInfo().deviceName;') throw new Error('api.ts changed: deviceName is no longer deviceInfo().deviceName');
const deviceFieldsText = cutFrom(deviceSource, 'deviceInfo.ts', 'export function deviceFields', '\n}\n').replace('export function', 'function') + '\n}\n';
const errorClass = cutFrom(apiSource, 'api.ts', 'export class ApiError', '\n// AI media jobs').replace('export class', 'class');
const classCode = stripTypeScriptTypes(`type DeviceInfo = any;\n${errorClass}\n${deviceFieldsText}\n${deviceNameLine}\nclass Api {\n  constructor(record) { this.record = record; }\n  request(path, options) { this.record({ method: options?.method ?? 'GET', path, body: options?.body }); return Promise.resolve({}); }\n${membersText}\n}\n`, { mode: 'transform' });
// Everything else the class body names (uploads) is never reached by the members replayed here.
const makeApi = new Function('deviceInfo', 'networkTier', 'inboxPrefetch', `${classCode}; return Api;`);

// kinds: s string · n number · o object · a array · b boolean · z string|null · q the options of `scheduled`; `?` optional.
const SPEC = {
  health: '', me: '', login: 's s s', register: 's s s s s s?', verifyRecovery: 's s', recoveryStatus: 's', resetPassword: 's s', recoveryRequests: '',
  cancelRecovery: 's', security: '', changePassword: 's s s?', changeConfirmationWord: 's s s?', changeRecoveryWord: 's s s?', sessions: '', revokeSession: 's',
  revokeOtherSessions: '', registerCryptoDevice: 's o', cryptoDevices: 's', ownCryptoDevices: '', claimPreKey: 's s', revokeCryptoDevice: 's', inboxPage: 's s n',
  logout: '', chats: '', users: 's', createChat: 's', userProfile: 's', profilePosts: 's', publishPost: 's s s?', deletePost: 's', storiesFeed: '', viewStory: 's',
  storyViewers: 's', profileGifts: 's', sendGift: 's s s?', removeGift: 's', blocks: '', block: 's', unblock: 's', report: 'o s s?', deleteAccount: 's s', contacts: '',
  addContact: 's', friendRequests: '', acceptFriend: 's', dropFriendRequest: 's', removeContact: 's', chatSettings: 's o', messages: 's n?',
  sendEncrypted: 's s o s?', scheduleEncrypted: 's s o s s?', scheduled: 'q?', deleteScheduled: 's', sendScheduledNow: 's', registerPush: 's s', unregisterPush: '',
  read: 's n', privacy: '', updatePrivacy: 'o', lastSeenRules: '', setLastSeenRule: 's s', removeLastSeenRule: 's', callRules: '', setCallRule: 's s', removeCallRule: 's',
  callPermission: 's s?', profile: 'o', changeLoginName: 's s s?', callIce: '', usernameStatus: '', changeUsername: 's', changeStatusEmoji: 'z',
  rooms: '', createRoom: 'a s?', renameRoom: 's s', leaveRoom: 's', ringRoom: 's', communities: '', createCommunity: 'o', community: 's', updateCommunity: 's o',
  deleteChatForEveryone: 's', readDate: 's n', readChannel: 's s n', communityMe: 's o', deleteCommunity: 's', leaveCommunity: 's', communityMembers: 's',
  banMember: 's s s?', unbanMember: 's s', communityBans: 's', setMemberVoice: 's s o', kickMember: 's s', setMemberRoles: 's s a', createRole: 's o', updateRole: 's s o',
  deleteRole: 's s', createChannel: 's o', updateChannel: 's s o', deleteChannel: 's s', channelMessages: 's s n?', sendChannelMessage: 's s o', editChannelMessage: 's s n s',
  reactChannelMessage: 's s n s', deleteChannelMessage: 's s n', createInvite: 's', invite: 's', acceptInvite: 's',
  requestHistory: 's', outgoingHistory: 's', incomingHistory: 's', claimHistory: 's s', putHistoryPage: 's n s s', completeHistory: 's s o n', historyPage: 's n s',
  ackHistory: 's s', cancelHistory: 's s', backupState: 's', enableBackup: 's n s', disableBackup: 's', putBackupNote: 's s n o', appendBackupPage: 's n s b',
  startRestore: 's', backupPage: 'n s',
};
// Members of the class that are not entries of the endpoint table (each one named, so a new member cannot slip by).
const SKIP = {
  cryptoInbox: 'a cache in front of inboxPage (prefetch store), builds no request of its own',
  pushField: 'state of sendEncrypted', scheduledSupported: 'state of scheduleEncrypted/scheduled', supportsScheduled: 'getter of that state',
  fileUrl: 'a download address built from the endpoint, not a request', socketUrl: 'the socket address', inviteUrl: 'a link built from the base, not a request',
  uploadChannelFile: 'upload', upload: 'upload', uploadPlain: 'upload', sendMultipart: 'upload',
};

// Every member the source declares must be either replayed or named as skipped; and the declared parameters must be
// those the table above assumes (how many, which are optional).
const declared = [...membersText.matchAll(/^  (?:private\s+)?(?:async\s+)?(?:get\s+)?([A-Za-z_]\w*)\s*[=(]/gm)].map(match => match[1]);
for (const name of declared) if (!(name in SPEC) && !(name in SKIP)) throw new Error(`api.ts has a member this generator does not know: ${name}`);
for (const name of [...Object.keys(SPEC), ...Object.keys(SKIP)]) if (!declared.includes(name)) throw new Error(`api.ts no longer has the member ${name}`);
function declaredParams(name) {
  const head = new RegExp(`^  ${name} = (?:async )?\\(`, 'm').exec(membersText);
  if (!head) throw new Error(`cannot find the parameters of ${name}`);
  let at = head.index + head[0].length, depth = 0, current = '';
  const params = [];
  for (;; at++) {
    const char = membersText[at];
    if (char === undefined) throw new Error(`unbalanced parameters of ${name}`);
    if (char === ')' && depth === 0) break;
    if ('({[<'.includes(char)) depth++; else if (')}]>'.includes(char)) depth--;
    if (char === ',' && depth === 0) { params.push(current); current = ''; } else current += char;
  }
  if (current.trim()) params.push(current);
  return params.map(text => {
    let level = 0, hasDefault = false;
    for (let i = 0; i < text.length; i++) { const c = text[i]; if ('({[<'.includes(c)) level++; else if (')}]>'.includes(c) && text[i - 1] !== '=') level--; else if (c === '=' && level === 0 && text[i + 1] !== '>') hasDefault = true; }
    return { name: /^\s*(\w+)/.exec(text)[1], optional: hasDefault || /^\s*\w+\?\s*:/.test(text) };
  });
}
const KINDS = {};
for (const [op, spec] of Object.entries(SPEC)) {
  const kinds = spec ? spec.split(' ') : [];
  const params = declaredParams(op);
  if (params.length !== kinds.length) throw new Error(`${op}: api.ts declares ${params.length} parameters, the table ${kinds.length}`);
  params.forEach((param, index) => { if (param.optional !== kinds[index].endsWith('?')) throw new Error(`${op}: parameter ${param.name} optional=${param.optional} in api.ts, not as in the table`); });
  KINDS[op] = kinds;
}

// ---- argument pools -------------------------------------------------------------------------------------------
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const STR = ['u-1', UUID, '', ' ', 'a b', 'a/b/../c', '?&#%+', 'x=1&y=2#frag', 'Привет, мир', 'ёЁ їґ', '😀👍🏽', 'quote " and \' and \\ back', "-_.!~*'()", ';,/?:@&=+$#[]', 'line\nbreak\ttab\r\u0000\u001f',
  '  ', '\u007f\u0080߿ࠀ￿', 'é ñ ﬁ', '%41%zz', '中文 日本語 한국어', 'عربى', '<script>alert(1)</script>', '{"json":true}', '0', 'null', 'ABCxyz0189',
  'x'.repeat(400), 'я€😀'.repeat(40),
  // Not well-formed UTF-16: encodeURIComponent throws on these, JSON.stringify writes them as \udXXX.
  '\ud800', '\udc00', 'a\ud83d', '\ude00b', '\ud83d😀', '\ude00\ud83d', 'ok😀\udfff'];
const NUM = [42, 0, -0, 1, -1, 1.5, -2.25, 0.1, 1e-7, 1e21, 123456789012, 9007199254740991, 9007199254740993, 4294967296, 5e-324, 1.7976931348623157e308, 100, 1763660000123];
const ARR = [['u-1', 'u-2'], [], ['😀', 'a b', ''], [UUID], ['"q"', 'Имя\n'], [1, null, true, { x: 1 }, ['n']], ['\ud800']];
const ODD_OBJECTS = [{}, { 2: 1, b: 2, 1: 3, a: null, 0: 'z' }, { 'ключ "q"': 'значение\n', '😀': [1, { x: null }] }, { ['__proto__']: 1, constructor: 'x', toString: null }, { a: { b: { c: { d: [[], {}, [[1.5e300]]] } } } },
  { '\ud800': '\udfff x', ok: 'a\ud83d' }, { '': '', ' ': ' ' }, { n: -0, m: 1e21, k: 1e-7, big: 123456789012345680000, f: 0.1 }, { 10: 'a', 9: 'b', '01': 'c', 4294967294: 'd', 4294967295: 'e', '-1': 'f', '1.5': 'g' }];
const MIXED = [true, false, null, 0, 1, 1.5, '', 'text', 'Привет 😀', '2027-01-01T00:00:00.000Z', [], ['a', 1], { nested: true }];
let seed = 0x1a2b3c4d;
const random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = list => list[Math.floor(random() * list.length)];
const fromEntries = entries => { const made = {}; for (const [key, value] of entries) Object.defineProperty(made, key, { value, enumerable: true, writable: true, configurable: true }); return made; };
/** Objects over the given keys: with few keys every subset with every value; with many — each key alone, all of them, random subsets in random order. */
function objects(fields, { exhaustive = false } = {}) {
  const keys = Object.keys(fields), out = [];
  if (exhaustive) {
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const chosen = keys.filter((_, i) => mask >> i & 1);
      let made = [[]];
      for (const key of chosen) made = made.flatMap(entries => fields[key].map(value => [...entries, [key, value]]));
      out.push(...made.map(fromEntries));
    }
    out.push(fromEntries([...keys].reverse().map(key => [key, fields[key][0]])));
  } else {
    out.push(fromEntries(keys.map(key => [key, fields[key][0]])), {});
    for (const key of keys) for (const value of fields[key]) out.push({ [key]: value });
    for (let i = 0; i < 40; i++) { const chosen = keys.filter(() => random() < 0.5).sort(() => random() - 0.5); out.push(fromEntries(chosen.map(key => [key, random() < 0.8 ? pick(fields[key]) : pick(MIXED)]))); }
  }
  for (const key of keys.slice(0, 3)) for (const value of MIXED) out.push({ [key]: value });
  return [...out, ...ODD_OBJECTS];
}
const bool = [true, false], text = ['Имя', '', 'a "b" c', 'x'.repeat(300)];
const ENCRYPTED = [
  { scheme: 'signal-v1', envelopes: [{ deviceId: UUID, type: 3, body: 'AAEC' }, { deviceId: 'd2', type: 2, body: '/+8=' }], sender: { userId: 'u-1', deviceId: 'd0' } },
  { scheme: 'signal-v1', envelopes: [], sender: { userId: 'u', deviceId: 'd' }, extra: null }, {}, { push: 'inside', clientId: 'inside', deliverAt: 'inside' }, { envelopes: [{ body: 'A'.repeat(500) }] }, ...ODD_OBJECTS];
const PUSH = ['message', 'call', 'missed', 'none', 'silent', '', 'x', 'Тихо "!"', null];
const POOLS = {
  'registerCryptoDevice.1': [{ identityKey: 'BQ' + 'a'.repeat(42), registrationId: 12345, signedPreKey: { keyId: 1, publicKey: 'BXk=', signature: 'c2ln' }, preKeys: [{ keyId: 1, publicKey: 'BQ==' }, { keyId: 2, publicKey: 'BR==' }], kyberPreKey: { keyId: 7, publicKey: 'a3k=', signature: 'cw==' } },
    {}, { deviceId: 'from-bundle' }, { deviceName: 'from-bundle' }, { deviceName: null, deviceId: 5, identityKey: 'k' }, { identityKey: 'k', deviceName: 'late', 0: 'index', deviceId: 'late too' }, { preKeys: [] }, ...ODD_OBJECTS],
  'publishPost.1': ['post', 'story', 'Post', '', 'reel', 'история'],
  'report.0': [{ userId: 'u-1' }, { communityId: 'c-1' }, {}, { userId: 'u-1', communityId: 'c-1' }, { communityId: 'c', userId: 'u' }, { reason: 'own reason', userId: 'u' }, { userId: 'u', comment: 'own comment' }, { comment: 'c', reason: 'r' },
    { userId: null }, { 5: 'five', userId: 'u', 1: 'one' }, { userId: UUID, extra: { a: [1] } }, ...ODD_OBJECTS],
  'report.1': ['spam', 'abuse', 'other', '', 'Причина "x"', 'a\ud800'],
  'report.2': ['', 'spam here', ' ', '  \t\n ', ' text ', '\n\tx ', '﻿x﻿', '\u0085x\u0085', '᠎x᠎', '​x​', ' x ', '　 x  ', '             abc ',
    '\u000b\u000c', '\u001cx\u001f', 'a  b', ' Привет 😀 ', ' ', '﻿', '\u0085', ' \ud800 ', '⁠x', '‎x', null],
  'chatSettings.1': objects({ pinned: bool, archived: bool, muted: bool, mutedUntil: ['2027-01-01T00:00:00.000Z', null] }, { exhaustive: true }),
  'sendEncrypted.2': ENCRYPTED, 'sendEncrypted.3': PUSH,
  'scheduleEncrypted.2': ENCRYPTED, 'scheduleEncrypted.3': ['2027-01-01T00:00:00.000Z', '', 'завтра', '2026-11-21T10:00:00+03:00'], 'scheduleEncrypted.4': ['silent', '', 'x', null],
  'scheduled.0': [{}, null, ...objects({ chatId: [UUID, '', 'a b&c', 'Чат 😀', null], lean: [true, false, null] }, { exhaustive: true })
    // only options of the declared kinds: the reference reads these two keys instead of sending them (the Rust core refuses the rest)
    .filter(value => !ODD_OBJECTS.includes(value) && ['string', 'undefined'].includes(typeof (value.chatId ?? undefined)) && ['boolean', 'undefined'].includes(typeof (value.lean ?? undefined))),
    { chatId: 'c', lean: true, other: 1 }, { other: 'ignored' }, { lean: true, chatId: 'c' }, { chatId: '\ud800' }, { chatId: 'x\udc00', lean: true }, { chatId: 'x'.repeat(500) }, { 1: 'a', chatId: 'c' }],
  'registerPush.1': ['android', 'ios', 'web', '', 'Айос'],
  'updatePrivacy.0': objects({ allowNewChats: bool, showAvatar: bool, readReceipts: bool, showLastSeen: bool, lastSeen: ['everyone', 'contacts', 'nobody'], hideReadTime: bool, calls: ['everyone', 'contacts', 'allowed'], posts: ['friends', 'everyone'] }),
  'setLastSeenRule.1': ['allow', 'deny', '', 'Allow', 'нет'], 'setCallRule.1': ['allow', 'deny', '', 'Allow', 'нет'],
  'callPermission.1': ['outgoing', 'incoming', 'Incoming', '', 'incoming ', 'входящий', null],
  'profile.0': objects({ displayName: text, bio: ['О себе\nвторая строка', ''], birthday: ['2000-02-29', null], gender: ['male', 'female', null], avatarColor: ['#ff0000'], avatarId: [UUID, null], avatarVideoId: [UUID, null], avatarFrame: ['gold', null],
    bannerId: [UUID, null], bannerPreset: ['aurora', null], profileEffect: ['snow', null], nameplate: ['neon', null], profilePattern: ['dots', null] }),
  'createCommunity.0': objects({ kind: ['server', 'blog'], name: text, description: ['Описание', ''], avatarId: [UUID, null], category: ['games', ''] }),
  'updateCommunity.1': objects({ name: text, description: ['Описание', ''], avatarId: [UUID, null], category: ['games', ''], closed: bool }),
  'communityMe.1': objects({ muted: bool, lastReadId: [0, 17, 9007199254740991] }, { exhaustive: true }),
  'setMemberVoice.2': objects({ muted: bool, deafened: bool }, { exhaustive: true }),
  'createRole.1': objects({ name: text, color: ['#00ff00', ''], perms: [0, 255, 4294967295] }, { exhaustive: true }),
  'updateRole.2': objects({ name: text, color: ['#00ff00', ''], perms: [0, 255, 4294967295] }, { exhaustive: true }),
  'createChannel.1': objects({ kind: ['text', 'voice'], name: text, topic: ['Тема', ''], category: ['Общее', ''], roleIds: [[], ['r1', 'r2']] }),
  'updateChannel.2': objects({ name: text, topic: ['Тема', ''], category: ['Общее', ''], roleIds: [[], ['r1', 'r2']] }),
  'sendChannelMessage.2': objects({ text: ['Привет 😀', '', 'x'.repeat(400)], attachmentId: [UUID], replyTo: [1, 123456], clientKey: ['k'.repeat(64), 'key-1'] }, { exhaustive: true }),
};
const poolFor = (op, index, kind) => {
  const base = POOLS[`${op}.${index}`] ?? { s: STR, n: NUM, a: ARR, b: [true, false], z: [...STR, null], o: [{ a: 1 }, ...ODD_OBJECTS] }[kind.replace('?', '')];
  if (!base) throw new Error(`no values for ${op} argument ${index}`);
  return kind.endsWith('?') && !base.includes(null) ? [...base, null] : base;
};

const DEVICES = [
  { platform: 'ios', deviceName: 'iPhone', deviceModel: 'iPhone', osVersion: 'iOS 18.1', appVersion: '0.16.3', networkTier: 'fast' },
  { platform: 'android', deviceName: 'Android', deviceModel: null, osVersion: 'Android', appVersion: '1.0.0', networkTier: 'slow' },
  { networkTier: 'medium', appVersion: '2.10.0-beta "x"', osVersion: 'Android 15', deviceName: 'Samsung SM-S921B «Мой» 😀', platform: 'android', deviceModel: 'Samsung SM-S921B' },
  { platform: 'ios', deviceName: 'iPad', appVersion: '0.16.3' },
  { platform: '', deviceName: '', deviceModel: '', osVersion: '', appVersion: '', networkTier: 'other', extra: { ignored: true }, username: 'not a field', 0: 'index' },
  { platform: 'ios', deviceName: 'a\ud800 "\n"', deviceModel: 'Mac', osVersion: null, appVersion: '9', networkTier: null },
];
const USES_DEVICE = ['login', 'register', 'verifyRecovery', 'registerCryptoDevice', 'messages'];

// ---- running the reference ------------------------------------------------------------------------------------
// -0 is kept in the text (JSON.stringify would write 0), so that what Rust reads is what the reference was given.
const NEG0 = '\u0001-0\u0001';
const write = value => JSON.stringify(value, (_key, item) => Object.is(item, -0) ? NEG0 : item).replaceAll(JSON.stringify(NEG0), '-0');
const lines = new Set();
let thrown = 0;
const perOp = {};
async function add(op, args, device) {
  const kinds = KINDS[op];
  // The member is given exactly what the line holds once it is read back.
  const given = JSON.parse(write(args)), deviceGiven = JSON.parse(write(device));
  const passed = given.map((value, index) => value === null && kinds[index].endsWith('?') ? undefined : value);
  const seen = [];
  const Api = makeApi(() => deviceGiven, () => deviceGiven.networkTier, null);
  const api = new Api(request => seen.push(request));
  if (typeof api[op] !== 'function') throw new Error(`the reference has no callable member ${op}`);
  let failure = null;
  try { await api[op](...passed); } catch (error) { failure = error; }
  let line;
  if (failure) {
    if (!(failure instanceof URIError) || seen.length) throw new Error(`${op}(${write(args)}) failed in the reference: ${failure?.stack || failure}`);
    line = { op, args: given, device: deviceGiven, method: null, path: null, body: null, throws: 'URIError' };
  } else {
    if (seen.length !== 1) throw new Error(`${op}(${write(args)}) made ${seen.length} requests, expected exactly one`);
    const { method, path, body } = seen[0];
    if (typeof method !== 'string' || typeof path !== 'string' || !(body === undefined || typeof body === 'string')) throw new Error(`${op}(${write(args)}): not a plain request`);
    line = { op, args: given, device: deviceGiven, method, path, body: body ?? null };
  }
  const textLine = write(line);
  if (!lines.has(textLine)) { lines.add(textLine); perOp[op] = (perOp[op] || 0) + 1; if (failure) thrown++; }
}

let turn = 0;
for (const [op, kinds] of Object.entries(KINDS)) {
  const pools = kinds.map((kind, index) => poolFor(op, index, kind));
  const typical = pools.map(pool => pool[0]);
  const required = kinds.filter(kind => !kind.endsWith('?')).length;
  const devices = USES_DEVICE.includes(op) ? DEVICES : null;
  const sets = [typical];
  // Each argument through all its values while the others stay ordinary…
  pools.forEach((pool, index) => { for (const value of pool) sets.push(typical.map((other, at) => at === index ? value : other)); });
  // …the optional ones left out…
  for (let length = required; length < kinds.length; length++) { sets.push(typical.slice(0, length)); for (let i = 0; i < 4; i++) sets.push(pools.slice(0, length).map(pick)); }
  // …and combinations.
  if (kinds.length) for (let i = 0; i < (kinds.length > 1 ? 40 : 10); i++) { const made = pools.map(pick); sets.push(random() < 0.2 ? made.slice(0, required + Math.floor(random() * (kinds.length - required + 1))) : made); }
  for (const args of sets) {
    if (devices) { for (const device of sets.indexOf(args) < 12 || random() < 0.25 ? devices : [pick(devices)]) await add(op, args, device); }
    else await add(op, args, DEVICES[turn++ % DEVICES.length]);
  }
  // A member without arguments still meets every device.
  if (!kinds.length) for (const device of DEVICES) await add(op, [], device);
  // The network tier decides the page size of `messages`, whatever the text.
  if (op === 'messages') for (const networkTier of ['slow', 'medium', 'fast', 'SLOW', '', 0, null, undefined, 15]) for (const args of [['c-1'], ['c-1', 100], ['c-1', 0], ['c-1', null]]) await add(op, args, { ...DEVICES[0], networkTier });
}
for (const op of Object.keys(KINDS)) if (!perOp[op]) throw new Error(`no case was produced for ${op}`);

writeFileSync(join(here, 'vectors', 'api.json'), [...lines].join('\n') + '\n');
console.log('api.json', lines.size, 'cases,', Object.keys(KINDS).length, 'members,', thrown, 'where the reference throws URIError; skipped:', Object.keys(SKIP).join(', '));
