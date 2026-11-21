// Produces the vectors the Rust core is checked against, by running the reference implementations themselves.
// Run from the repository root:  node native/core/tests/generate-vectors.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signRequest, verifyAttest } from '../../../server/src/attest.js';
import { deviceMessage } from '../../../server/src/devicebind.js';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { classify, addSample, timeoutFor, autoload } from '../../../mobile/src/network/quality.ts';
import { validMeta, REACTIONS } from '../../../mobile/src/messageMeta.ts';
import { validEntities, validLinkUrl } from '../../../mobile/src/format/entities.ts';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { normalizeServer, verifyServerList, chooseServer, fallbackServer } from '../../../mobile/src/servers/list.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), 'vectors');

const attestCases = [
  ['k', 1700000000, 'GET', '/me'],
  ['a-per-build-key-0123456789abcdef', 1763660000, 'POST', '/chats/42/messages?lean=1'],
  ['ключ с юникодом ✓', 1763660001, 'put', '/me/push'],
  ['x'.repeat(200), 1763660002, 'DELETE', '/chats/7'],
  ['key', 999999999, 'PATCH', '/me/privacy?a=1&b=%D0%B0'],
];
writeFileSync(join(out, 'attest.json'), JSON.stringify(attestCases.map(([key, ts, method, url]) => {
  const hex = signRequest(key, ts, method, url);
  // The server's own verifier must accept what the reference signer made.
  if (verifyAttest(`${ts}.${hex}`, { key, method, url, nowSeconds: ts }) !== null) throw new Error('reference disagrees with itself');
  return { key, ts, method, url, hex };
}), null, 1) + '\n');
console.log('attest.json', attestCases.length);

// JSON exactly as JavaScript reads and writes it: each text is parsed and written back by Node itself.
const jsonTexts = [
  'null', 'true', 'false', '0', '-0', '1', '-1', '1.5', '0.1', '1e21', '1e-7', '123456789012345680000', '1.7976931348623157e308', '5e-324',
  '0.000001', '0.0000001', '100', '1e2', '1E+2', '12345.6789', '9007199254740993', '0.30000000000000004', '2.5e-10', '123e-20', '4.35', '1e300', '-2.5e+25',
  '""', '"plain"', '"кириллица и 😀 эмодзи"', '"quote \\" and \\\\ and \\/ slash"', '"\\b\\f\\n\\r\\t"', '"\\u0000\\u001f\\u007f\\u00e9"',
  '"\\ud83d\\ude00"', '"\\ud83d"', '"\\ude00"', '"a\\ud800b"', '"\\u2028\\u2029"', '"\u2028 raw"',
  '[]', '{}', '[1,[2,[3,[]]],{"a":[]}]', ' { "a" : 1 , "b" : [ true , null ] } ',
  '{"b":1,"a":2}', '{"2":"two","b":1,"1":"one","a":2,"0":"zero"}', '{"a":1,"a":2,"b":3,"a":4}', '{"01":1,"1":2,"10":3,"9":4,"4294967295":5,"4294967294":6,"-1":7,"1.5":8}',
  '{"":0,"\\u0041":1,"A":2}', '{"scheme":"signal-v1","envelopes":[{"deviceId":"d1","type":3,"body":"AAEC"},{"deviceId":"d2","type":2,"body":"/+8="}],"sender":{"userId":"u-1","deviceId":"d0"}}',
];
writeFileSync(join(out, 'json.json'), JSON.stringify(jsonTexts.map(text => ({ text, written: JSON.stringify(JSON.parse(text)) })), null, 1) + '\n');
const numbers = [0, 1, -1, 0.5, 1/3, 2/3, 1e21, 1e20, 123456789, 1.5e-7, 1e-6, 1e-7, 255, 4294967296, 9007199254740991, 9007199254740992, 1.1, 2.2, 3.3, 100.5, 0.000123, 6.02214076e23, 1.602e-19, 1763660000123, 12.5, 99.99, 1e100];
writeFileSync(join(out, 'numbers.json'), JSON.stringify(numbers.map(n => ({ bits: Buffer.from(new Float64Array([n]).buffer).reverse().toString('hex'), text: String(n) })), null, 1) + '\n');
console.log('json.json', jsonTexts.length, 'numbers.json', numbers.length);

// What the device signs, as the server builds it.
const messages = [['bind', 'session-1', 'c1'], ['proof', 'session-1', 'c2'], ['bind', '0f8fad5b-d9cb-469f-a165-70867728950e', 'Zm9vYmFyLV9hYmM'], ['proof', 'сессия', 'вызов ✓']];
writeFileSync(join(out, 'device-message.json'), JSON.stringify(messages.map(([purpose, sessionId, challenge]) => ({ purpose, sessionId, challenge, message: deviceMessage(purpose, sessionId, challenge).toString('utf8') })), null, 1) + '\n');
console.log('device-message.json', messages.length);

// Servers: the address rule, the signed list, the choice.
const addresses = ['https://api.invizent.com', 'https://api.invizent.com/', 'HTTPS://API.INVIZENT.COM', 'https://api.invizent.com:443', 'https://api.invizent.com:444', 'http://api.invizent.com',
  'https://invizent.com', 'https://invizent.ru', 'https://a.b-c.invizent.ru/', 'https://evilinvizent.com', 'https://invizent.com.evil.org', 'https://api.invizent.org', 'https://user@api.invizent.com',
  'https://user:pw@api.invizent.com', 'https://api.invizent.com/path', 'https://api.invizent.com/?', 'https://api.invizent.com/?a=1', 'https://api.invizent.com/#', 'https://api.invizent.com/#x',
  'https://141-133-194-51.nip.io', 'https://x.141-133-194-51.nip.io', 'https://invizent-api.invizent-8165e2.workers.dev/', 'https://other.invizent-8165e2.workers.dev', 'https://api..invizent.com',
  ' https://api.invizent.com ', 'https://api.invizent.com.', 'https://api_x.invizent.com', 'https://xn--80a.invizent.com', 'https://пример.invizent.com', 'https://[::1]', 'https://127.0.0.1', 'ftp://api.invizent.com',
  'api.invizent.com', '', 'https://', 'https://API.Invizent.RU:443/', 'https://api.invizent.com\\x', 'https:api.invizent.com', 'https://api.invizent.com:0443', 'wss://api.invizent.com'];
writeFileSync(join(out, 'server-address.json'), JSON.stringify(addresses.map(address => ({ address, normal: normalizeServer(address) })), null, 1) + '\n');
const pair = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { key: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64'), privateKey }; };
const owner = pair(), stranger = pair();
const signed = (payload, by = owner) => ({ payload, sig: edSign(null, Buffer.from(payload, 'utf8'), by.privateKey).toString('base64') });
const good = JSON.stringify({ version: 3, issuedAt: '2026-11-01T00:00:00Z', servers: [{ url: 'https://api.invizent.com', region: 'eu' }, { url: 'https://b.invizent.ru/' }] });
const listCases = [
  ['good', signed(good), 0], ['replayed older', signed(good), 4], ['exact version', signed(good), 3], ['stranger key', signed(good, stranger), 0],
  ['edited payload', { ...signed(good), payload: good.replace('"version":3', '"version":9') }, 0],
  ['foreign server', signed(JSON.stringify({ version: 1, servers: [{ url: 'https://evil.org' }] })), 0],
  ['duplicate', signed(JSON.stringify({ version: 1, servers: [{ url: 'https://api.invizent.com' }, { url: 'https://API.invizent.com/' }] })), 0],
  ['no servers', signed(JSON.stringify({ version: 1, servers: [] })), 0], ['fraction version', signed(JSON.stringify({ version: 1.5, servers: [{ url: 'https://api.invizent.com' }] })), 0],
  ['text version', signed(JSON.stringify({ version: '2', servers: [{ url: 'https://api.invizent.com' }] })), 0], ['not json', signed('nope'), 0],
  ['long region dropped', signed(JSON.stringify({ version: 2, issuedAt: 5, servers: [{ url: 'https://api.invizent.com', region: 'r'.repeat(41) }] })), 0],
  ['no date', signed(JSON.stringify({ version: 2, servers: [{ url: 'https://api.invizent.com', region: 7 }] })), 0],
  ['bad signature text', { payload: good, sig: 'short' }, 0], ['33 servers', signed(JSON.stringify({ version: 1, servers: Array.from({ length: 33 }, (_, i) => ({ url: `https://s${i}.invizent.com` })) })), 0],
];
writeFileSync(join(out, 'server-list.json'), JSON.stringify({ keys: [owner.key], cases: listCases.map(([name, list, minVersion]) => ({ name, payload: list.payload, sig: list.sig, minVersion, list: verifyServerList(list, [owner.key], minVersion) })) }, null, 1) + '\n');
const A = 'https://a.invizent.com', B = 'https://b.invizent.com', C = 'https://c.invizent.com', D = 'https://d.invizent.com';
const chooseCases = [[null, { [A]: 120, [B]: 80 }], [A, { [A]: 120, [B]: 80 }], [A, { [A]: 120, [B]: 100 }], [A, { [A]: 200, [B]: 139 }], [A, { [A]: 200, [B]: 140 }], [A, { [A]: 100, [B]: 60 }], [A, { [A]: 100, [B]: 61 }],
  [A, { [A]: null, [B]: 300 }], [A, { [A]: null, [B]: null }], [null, { [A]: null }], [null, {}], [C, { [A]: 50, [B]: 50 }], [null, { [B]: 50, [A]: 50 }], [B, { [A]: 10, [B]: 10 }]];
writeFileSync(join(out, 'server-choose.json'), JSON.stringify(chooseCases.map(([current, rtt]) => ({ current, rtt: Object.entries(rtt), chosen: chooseServer(current, rtt) })), null, 1) + '\n');
const fallbackCases = [
  [A, [A, B, C], { [B]: 90, [C]: 40 }, {}, 1000], [A, [A, B, C], { [B]: null, [C]: 70 }, {}, 1000], [A, [A, B, C], { [B]: null }, {}, 1000], [A, [A, B, C], { [B]: null, [C]: null }, {}, 1000],
  [A, [A, B, C], { [B]: 30, [C]: 20 }, { [C]: 900 }, 1000], [A, [A, B, C], { [B]: 30, [C]: 20 }, { [C]: 900, [B]: 950 }, 1000], [A, [A, B, C], { [B]: 30, [C]: 20 }, { [C]: 100 }, 100000],
  [A, [A], {}, {}, 1000], [A, [B, C], { [B]: null, [C]: null }, {}, 1000], [A, [A, B, C, D], {}, { [B]: 990, [C]: 980, [D]: 970 }, 1000], [A, [A, B, C, D], { [D]: 5 }, { [B]: 990 }, 1000], [A, [A, B, C], {}, {}, 1000],
];
writeFileSync(join(out, 'server-fallback.json'), JSON.stringify(fallbackCases.map(([failed, all, rtt, down, now]) => ({ failed, all, rtt: Object.entries(rtt), down: Object.entries(down), now, downMs: 60000, next: fallbackServer(failed, all, rtt, down, now, 60000) })), null, 1) + '\n');
console.log('servers', addresses.length, listCases.length, chooseCases.length, fallbackCases.length);

// Network quality (pure functions of the reference).
const tiers = ['slow', 'medium', 'fast'];
const classifyCases = [[null, null], [100, null], [351, null], [350, null], [901, null], [900, null], [null, 199], [null, 200], [null, 1999], [null, 2000], [1000, 5000], [100, 100], [400, 3000]];
let q = { rttMs: null, kbps: null, tier: 'fast' };
const samples = [[120, 300], [80, 1000], [0, 10], [50, -1], [900, 2000], [2000, 20000], [400, 100000], [30, 5000], [1500, 100], [1500, 200], [10, 16384], [3000, 16384], [100, 4095], [100, 4096]];
const sampleSteps = samples.map(([ms, bytes]) => { q = addSample(q, { ms, bytes }); return { ms, bytes, rttMs: q.rttMs, kbps: q.kbps, tier: q.tier }; });
writeFileSync(join(out, 'network.json'), JSON.stringify({
  classify: classifyCases.map(([rttMs, kbps]) => ({ rttMs, kbps, tier: classify(rttMs, kbps) })), samples: sampleSteps,
  timeouts: ['send', 'read', 'upload'].flatMap(kind => tiers.map(tier => ({ kind, tier, ms: timeoutFor(kind, tier) }))),
  autoload: ['photo', 'video', 'animatedAvatar', 'cover'].flatMap(kind => tiers.map(tier => ({ kind, tier, loads: autoload(kind, tier) }))),
}, null, 1) + '\n');
// The reference's own ApiError class and requestTimeout function, taken from its source text and run as they are.
const apiSource = readFileSync(new URL('../../../mobile/src/api.ts', import.meta.url), 'utf8');
const cut = (from, to) => { const start = apiSource.indexOf(from); const end = apiSource.indexOf(to, start); if (start < 0 || end < 0) throw new Error('api.ts changed: ' + from); return apiSource.slice(start, end); };
const errorClass = stripTypeScriptTypes(cut('export class ApiError', '\n// AI media jobs').replace('export class', 'class'), { mode: 'transform' });
const ApiError = new Function(`${errorClass}; return ApiError;`)();
const timeoutText = cut('const AI_TIMEOUTS', '\nexport class NetworkError');
const timeoutSource = stripTypeScriptTypes(timeoutText.slice(0, timeoutText.lastIndexOf('\n}') + 2), { mode: 'transform' });
const errorBodies = [{}, { error: 'Нет доступа', code: 'device_proof' }, { error: 5, code: 7 }, { attemptsRemaining: 2, attemptsLeft: 5, retryAfterSeconds: 12.5, readyAt: 'r', serverTime: 's', expiresAt: 'e', received: 4096 },
  { attemptsRemaining: 4, attemptsLeft: 6, retryAfterSeconds: -1, received: -1 }, { attemptsRemaining: 1.5, attemptsLeft: '3', received: 1.5, readyAt: 1 }, { attemptsRemaining: 0, attemptsLeft: 0, retryAfterSeconds: 0, received: 0 },
  { received: 9007199254740991 }, { received: 9007199254740992 }, { error: '', code: '' }];
const field = v => (v === undefined ? null : v);
writeFileSync(join(out, 'api-error.json'), JSON.stringify(errorBodies.map(body => { const e = new ApiError(typeof body.error === 'string' ? body.error : 'Не удалось выполнить запрос. Попробуй ещё раз.', 400, body);
  return { body: JSON.stringify(body), message: e.message, code: field(e.code), attemptsRemaining: field(e.attemptsRemaining), attemptsLeft: field(e.attemptsLeft), retryAfterSeconds: field(e.retryAfterSeconds), readyAt: field(e.readyAt), serverTime: field(e.serverTime), expiresAt: field(e.expiresAt), received: field(e.received) }; }), null, 1) + '\n');
const timeoutPaths = [['/me', 'GET'], ['/chats/1/messages?lean=1', 'POST'], ['/chats/1/messages', 'POST'], ['/chats/1/messages?lean=1', 'GET'], ['/chats/1/messages/5/read-date', 'POST'], ['/communities/2/channels/3/messages', 'DELETE'],
  ['/uploads', 'POST'], ['/uploads?purpose=post', 'POST'], ['/e2ee/files', 'POST'], ['/e2ee/uploads/abc', 'PUT'], ['/uploads/sessions/abc', 'PUT'], ['/e2ee/uploads/abc', 'GET'], ['/e2ee/uploads', 'POST'],
  ['/auth/login', 'POST'], ['/auth/register', 'POST'], ['/auth/recovery/verify', 'POST'], ['/auth/recovery/reset', 'POST'], ['/auth/password', 'POST'], ['/auth/confirmation-word', 'POST'], ['/auth/recovery-word', 'POST'],
  ['/auth/login', 'GET'], ['/auth/logout', 'POST'], ['/auth/login?x=1', 'POST'], ['/ai/chat', 'POST'], ['/ai/image', 'POST'], ['/ai/speech', 'POST'], ['/ai/transcribe', 'POST'], ['/ai/video', 'POST'], ['/ai/models', 'GET'], ['/ai/chat?x=1', 'POST']];
writeFileSync(join(out, 'request-timeout.json'), JSON.stringify(timeoutPaths.flatMap(([path, method]) => tiers.map(tier => {
  const requestTimeout = new Function('timeoutFor', 'networkTier', 'SIMULATOR_TEST_BUILD', `${timeoutSource}; return requestTimeout;`)(timeoutFor, () => tier, false);
  return { path, method, tier, ms: requestTimeout(path, method) }; })), null, 1) + '\n');
console.log('network', classifyCases.length, samples.length, 'api-error', errorBodies.length, 'timeouts', timeoutPaths.length * 3);

// The shape rules of what travels inside an encrypted message. Valid samples of every kind, then every sample
// with each of its fields removed, replaced by values of other types, and with an unknown field added.
const U = '0f8fad5b-d9cb-469f-a165-70867728950e', V = '7C9E6679-7425-40DE-944B-E07FC1F90AE7';
const metaSamples = [
  { reply: { clientId: U, senderId: V, preview: 'привет' } }, { reply: { clientId: U, senderId: V, preview: '' } }, { forward: { from: 'Анна' } }, { silent: true },
  { story: { id: U, ownerId: V } }, { entities: [{ type: 'bold', offset: 0, length: 4 }, { type: 'text_link', offset: 5, length: 3, url: 'https://example.org/a?b=1' }, { type: 'pre', offset: 9, length: 2, language: 'rust' }] },
  { album: { id: U, index: 0, count: 2 } }, { album: { id: U, index: 9, count: 10 } }, { poll: { question: 'Когда?', options: ['Сегодня', 'Завтра'], multiple: false } },
  { reply: { clientId: U, senderId: V, preview: 'x' }, forward: { from: 'A' }, entities: [{ type: 'spoiler', offset: 0, length: 1 }], silent: true, album: { id: U, index: 1, count: 3 } },
  { action: { type: 'edit', target: U, text: 'новый текст' } }, { action: { type: 'edit', target: U, text: 'bold', entities: [{ type: 'bold', offset: 0, length: 4 }] } },
  { action: { type: 'delete', target: U } }, { action: { type: 'react', target: U, emoji: '👍' } }, { action: { type: 'react', target: U, emoji: '❤️' } }, { action: { type: 'react', target: U, emoji: null } },
  { action: { type: 'pin', target: U } }, { action: { type: 'pin', target: null } }, { action: { type: 'vote', target: U, options: [0, 3, 9] } }, { action: { type: 'vote', target: U, options: [] } },
  { action: { type: 'call', call: U, step: 'offer', video: true, sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1' } }, { action: { type: 'call', call: U, step: 'answer', sdp: 'v=0' } },
  { action: { type: 'call', call: U, step: 'end', reason: 'hangup', duration: 192, caller: true } }, { action: { type: 'call', call: U, step: 'end' } },
  { action: { type: 'call', call: U, step: 'restart', gen: 1, sdp: 'v=0' } }, { action: { type: 'call', call: U, step: 'restart-answer', gen: 100000, sdp: 'v=0 x' } },
  { action: { type: 'settings', ttl: 86400, noCopy: true } }, { action: { type: 'settings', ttl: 0, noCopy: false } }, { action: { type: 'clear' } },
];
const odd = [null, true, false, 0, 1, -1, 1.5, 10, 11, 100001, 604801, 1e21, '', ' ', '\u00a0\ufeff', 'x', U, U.toUpperCase(), U.slice(1), U + '0', 'g' + U.slice(1), 'v=1', 'http://a', 'HTTPS://A b', 'ftp://a', '😀', [], [0, 0], [10], [-1], [1.5], ['a', ''], {}, { type: 'clear' }, 'x'.repeat(201), 'x'.repeat(8001)];
const metaValues = [undefined, null, 5, 'meta', [], {}, { unknown: 1 }];
const seenMeta = new Set(metaValues.map(v => JSON.stringify(v) ?? 'undefined'));
const addMeta = v => { const key = JSON.stringify(v); if (!seenMeta.has(key)) { seenMeta.add(key); metaValues.push(v); } };
const walk = (root, node, path) => {
  for (const key of Object.keys(node)) {
    const at = [...path, key];
    const set = value => { const copy = structuredClone(root); let target = copy; for (const step of at.slice(0, -1)) target = target[step]; if (value === walk) { if (Array.isArray(target)) target.splice(Number(key), 1); else delete target[key]; } else target[key] = value; return copy; };
    addMeta(set(walk));
    for (const value of odd) addMeta(set(value));
    if (node[key] && typeof node[key] === 'object') {
      if (!Array.isArray(node[key])) { const extra = structuredClone(root); let target = extra; for (const step of at) target = target[step]; target.extra = 1; addMeta(extra); }
      walk(root, node[key], at);
    }
  }
};
for (const sample of metaSamples) { addMeta(sample); addMeta({ ...sample, silent: true }); addMeta({ ...sample, reply: { clientId: U, senderId: V, preview: 'q' } }); addMeta({ ...sample, poll: { question: 'Q', options: ['a', 'b'], multiple: true } }); walk(sample, sample, []); }
for (const emoji of REACTIONS) addMeta({ action: { type: 'react', target: U, emoji } });
addMeta({ action: { type: 'react', target: U, emoji: '❤' } }); addMeta({ action: { type: 'vote', target: U, options: [1, 1] } }); addMeta({ action: { type: 'vote', target: U, options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0] } });
addMeta({ poll: { question: 'q'.repeat(256), options: ['a', 'b'], multiple: false } }); addMeta({ poll: { question: 'q', options: Array(11).fill('a'), multiple: false } }); addMeta({ poll: { question: 'q', options: ['a', 'o'.repeat(101)], multiple: false } });
addMeta({ entities: Array.from({ length: 101 }, (_, i) => ({ type: 'bold', offset: i, length: 1 })) }); addMeta({ entities: [{ type: 'bold', offset: 7999, length: 1 }] }); addMeta({ entities: [{ type: 'bold', offset: 7999, length: 2 }] });
addMeta({ action: { type: 'edit', target: U, text: 'ab', entities: [{ type: 'bold', offset: 1, length: 2 }] } }); addMeta({ action: { type: 'edit', target: U, text: '😀', entities: [{ type: 'bold', offset: 0, length: 2 }] } }); addMeta({ action: { type: 'edit', target: U, text: 'ab', entities: [] } });
addMeta({ action: { type: 'call', call: U, step: 'end', duration: 604800 } }); addMeta({ action: { type: 'call', call: U, step: 'end', duration: 604801 } }); addMeta({ action: { type: 'call', call: U, step: 'offer', sdp: 'v=0' + 'x'.repeat(59997) } }); addMeta({ action: { type: 'call', call: U, step: 'offer', sdp: 'v=0' + 'x'.repeat(59998) } });
addMeta({ entities: [{ type: 'text_link', offset: 0, length: 1, url: 'https://' + 'a'.repeat(2040) }] }); addMeta({ entities: [{ type: 'text_link', offset: 0, length: 1, url: 'https://' + 'a'.repeat(2041) }] }); addMeta({ entities: [{ type: 'pre', offset: 0, length: 1, language: 'l'.repeat(33) }] }); addMeta({ entities: [{ type: 'bold', offset: 0, length: 1, language: 'x' }] });
writeFileSync(join(out, 'message-meta.json'), '[\n' + metaValues.map(value => JSON.stringify({ meta: value === undefined ? null : JSON.stringify(value), valid: validMeta(value) })).join(',\n') + '\n]\n');
const links = ['https://a', 'http://a', 'HTTP://A', 'hTtPs://x.y/z?q=1#f', 'https://', 'http:/a', 'https://a b', 'https://a\n', ' https://a', 'https://a\u00a0b', 'https://a\ufeffb', 'https://a\u0085b', 'https://\ud83d', 'ftp://a', '', 5, null, 'https://' + 'a'.repeat(2040), 'https://' + 'a'.repeat(2041)];
writeFileSync(join(out, 'links.json'), JSON.stringify(links.map(url => ({ url: JSON.stringify(url), valid: validLinkUrl(url) })), null, 1) + '\n');
console.log('message-meta', metaValues.length, 'valid', metaValues.filter(validMeta).length, 'links', links.length, typeof validEntities);

// An encrypted message on the wire: the reference's own validators and canonical form, cut from its source.
const coreSource = readFileSync(new URL('../../../mobile/src/e2ee/core.ts', import.meta.url), 'utf8');
const coreCut = (from, to) => { const start = coreSource.indexOf(from); const end = coreSource.indexOf(to, start); if (start < 0 || end < 0) throw new Error('core.ts changed: ' + from); return coreSource.slice(start, end); };
const base64js = createRequire(new URL('../../../mobile/package.json', import.meta.url))('base64-js');
const wireCode = stripTypeScriptTypes(coreCut('export function canonicalEncrypted', '// Voice waveform travels').replace('export function', 'function'), { mode: 'transform' });
const wire = new Function('toByteArray', 'fromByteArray', `const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; ${wireCode}; return { canonicalEncrypted, validEncrypted };`)(base64js.toByteArray, base64js.fromByteArray);
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const ids = ['0f8fad5b-d9cb-469f-a165-70867728950e', '7c9e6679-7425-40de-944b-e07fc1f90ae7', '7C9E6679-7425-40DE-944B-E07FC1F90AE7', '7c9e6679-7425-40de-944b-E07FC1F90AE7', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'AAAAAAAA-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaA', '00000000-0000-0000-0000-000000000000', '99999999-9999-9999-9999-999999999999', 'a0000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', 'fFfFfFfF-ffff-ffff-ffff-ffffffffffff', 'FfFfFfFf-ffff-ffff-ffff-ffffffffffff', '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', '1B9D6BCD-bbfd-4b2d-9b5d-ab8dfbbd4bed', '9a000000-0000-0000-0000-000000000000', 'a9000000-0000-0000-0000-000000000000'];
const order = [];
for (const a of ids) for (const b of ids) order.push({ a: `${a}:${ids[0]}`, b: `${b}:${ids[0]}`, sign: Math.sign(`${a}:${ids[0]}`.localeCompare(`${b}:${ids[0]}`)) }, { a: `${ids[0]}.${a}`, b: `${ids[0]}.${b}`, sign: Math.sign(`${ids[0]}.${a}`.localeCompare(`${ids[0]}.${b}`)) });
writeFileSync(join(out, 'id-order.json'), '[\n' + order.map(row => JSON.stringify(row)).join(',\n') + '\n]\n');
const body = bytes => Buffer.from(bytes).toString('base64');
const envelope = (userId, deviceId, type = 3, bytes = [1, 2, 3]) => ({ userId, deviceId, type, body: body(bytes) });
const goodMessages = [
  { scheme: 'signal-v1', senderDeviceId: ids[0], envelopes: [envelope(ids[1], ids[4])] },
  { scheme: 'signal-v1', senderDeviceId: ids[0], envelopes: [envelope(ids[1], ids[4], 2, [255]), envelope(ids[0], ids[7], 3, [0, 0]), envelope(ids[2], ids[8], 3, [9, 9, 9, 9])], attachmentIds: [ids[11], ids[3], ids[0]] },
  { scheme: 'signal-v1', senderDeviceId: ids[2], envelopes: [envelope(ids[4], ids[15]), envelope(ids[5], ids[16]), envelope(ids[6], ids[9])], attachmentIds: [], lane: 'scheduled' },
  { scheme: 'signal-v1', senderDeviceId: ids[0], envelopes: Array.from({ length: 10 }, (_, i) => envelope(ids[i % 3], `${String(i).repeat(8)}-0000-0000-0000-000000000000`, i % 2 ? 2 : 3, Array(i + 1).fill(i))), attachmentIds: Array.from({ length: 10 }, (_, i) => `${String(9 - i).repeat(8)}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`) },
  { scheme: 'signal-v1', senderDeviceId: ids[0], envelopes: [envelope(ids[1], ids[4], 3, Array(65536).fill(7))] },
];
const wireValues = [null, 5, 'x', [], {}];
const seenWire = new Set(wireValues.map(v => JSON.stringify(v)));
const addWire = v => { const key = JSON.stringify(v); if (!seenWire.has(key)) { seenWire.add(key); wireValues.push(v); } };
const wireOdd = [null, true, 0, 1, 2, 3, 4, 2.5, '', 'signal-v2', 'scheduled', 'voice', ids[0], ids[0].toUpperCase(), ids[0].slice(1), 'AQID', 'AQI=', 'AQ==', 'AQ=', 'AQI', 'AR==', 'AQJ=', '!!!!', 'AQID AQID', '====', [], {}, [ids[0]], [ids[0], ids[0].toUpperCase()]];
const walkWire = (root, node, path) => {
  for (const key of Object.keys(node)) {
    const at = [...path, key];
    if (JSON.stringify(node[key]).length > 4000) continue;
    const set = value => { const copy = structuredClone(root); let target = copy; for (const step of at.slice(0, -1)) target = target[step]; if (value === walkWire) { if (Array.isArray(target)) target.splice(Number(key), 1); else delete target[key]; } else target[key] = value; return copy; };
    addWire(set(walkWire));
    for (const value of wireOdd) addWire(set(value));
    if (node[key] && typeof node[key] === 'object') { if (!Array.isArray(node[key])) { const extra = structuredClone(root); let target = extra; for (const step of at) target = target[step]; target.extra = 1; addWire(extra); } walkWire(root, node[key], at); }
  }
};
for (const message of goodMessages.slice(0, 3)) { addWire(message); addWire({ ...message, extra: 1 }); walkWire(message, message, []); }
addWire(goodMessages[3]); addWire(goodMessages[4]);
addWire({ ...goodMessages[0], envelopes: [envelope(ids[1], ids[4], 3, Array(65537).fill(7))] });
addWire({ ...goodMessages[0], envelopes: Array.from({ length: 11 }, (_, i) => envelope(ids[1], `${String(i % 10).repeat(8)}-0000-0000-0000-00000000000${i > 9 ? 'a' : '0'}`)) });
addWire({ ...goodMessages[0], attachmentIds: Array.from({ length: 11 }, (_, i) => `${String(i % 10).repeat(8)}-aaaa-aaaa-aaaa-aaaaaaaaaaa${i > 9 ? 'b' : 'a'}`) });
addWire({ ...goodMessages[0], envelopes: [envelope(ids[1], ids[1]), envelope(ids[0], ids[2])] });
writeFileSync(join(out, 'encrypted.json'), '[\n' + wireValues.map(value => { const valid = wire.validEncrypted(value); return JSON.stringify({ value: JSON.stringify(value), valid, ...(valid ? { fingerprint: sha(wire.canonicalEncrypted(value)), canonical: JSON.stringify(value).length < 3000 ? wire.canonicalEncrypted(value) : null } : {}) }); }).join(',\n') + '\n]\n');
// The codes people compare and the fingerprint of a conversation's devices, computed the way `snapshot` does.
const snapshotCode = coreCut("const pair=[selfIdentity,", 'return {...device');
if (!snapshotCode.includes("linea-safety-code-v1\\u0000${pair.join('\\u0000')}")) throw new Error('core.ts changed: the safety code');
const identity = (userId, deviceId, identityKey, registrationId) => ({ userId, deviceId, identityKey, registrationId });
const people = [identity(ids[0], ids[4], 'A'.repeat(43) + '=', 1), identity(ids[1], ids[7], 'BQ' + 'x'.repeat(42), 16383), identity(ids[1], ids[8], 'b'.repeat(44), 77), identity(ids[2], ids[9], '/+' + 'Z'.repeat(42), 4242)];
const line = d => `${d.userId}.${d.deviceId}:${d.identityKey}:${d.registrationId}`;
const codes = [];
for (const own of people) for (const other of people) { const pair = [line(own), line(other)].sort(); codes.push({ own, other, code: sha(`linea-safety-code-v1\u0000${pair.join('\u0000')}`).toUpperCase().match(/.{1,4}/g).join(' ') }); }
const sets = [people, people.slice(0, 2), [people[3], people[0]], []].map(devices => { const sorted = [...devices].sort((a, b) => `${a.userId}.${a.deviceId}`.localeCompare(`${b.userId}.${b.deviceId}`)); return { devices, sorted: sorted.map(d => d.deviceId), fingerprint: sha(JSON.stringify(sorted.map(d => [d.userId, d.deviceId, d.identityKey, d.registrationId]))) }; });
writeFileSync(join(out, 'trust.json'), JSON.stringify({ codes, sets }, null, 1) + '\n');
console.log('id-order', order.length, 'encrypted', wireValues.length, 'valid', wireValues.filter(wire.validEncrypted).length, 'codes', codes.length);

// Media descriptions and attachments: the reference's own functions, cut from its source.
const previewSource = readFileSync(new URL('../../../mobile/src/media/previewModel.ts', import.meta.url), 'utf8');
const previewCut = (from, to) => { const start = previewSource.indexOf(from); const end = previewSource.indexOf(to, start); if (start < 0 || end < 0) throw new Error('previewModel.ts changed: ' + from); return previewSource.slice(start, end); };
const mediaCode = stripTypeScriptTypes(['const record=', 'const dimension=', 'const only='].map(name => previewCut(name, '\n')).join('\n') + '\n' + previewCut('export function validMedia', '\n/**').replace('export function', 'function') + '\n' + previewSource.slice(previewSource.indexOf('export function wireMedia')).replace('export function', 'function'), { mode: 'transform' });
const media = new Function(`${mediaCode}; return { validMedia, wireMedia };`)();
const okPreview = value => value === undefined || value === 'OK';
const attachCode = stripTypeScriptTypes(coreCut('function hasOnlyKeys', 'function validCiphertextBody') + coreCut('const WAVEFORM', '\nexport class CryptoService').replace('export function', 'function'), { mode: 'transform' });
const attach = new Function('validMedia', 'validPreview', `const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; ${attachCode}; return { validAttachment, wireBody, withWaveform };`)(media.validMedia, okPreview);
const mediaGood = [{}, { width: 1, height: 20000 }, { width: 1280, height: 720, durationMs: 0, hdr: 'sdr' }, { durationMs: 86400000, waveform: 'AZaf09'.replace('09', 'AB') + 'ABCDEF' }, { hdr: 'pq' }, { hdr: 'hlg' }, { hdr: 'gainmap', width: 4000, height: 3000 }, { waveform: 'A'.repeat(100) }, { hdr: ['sdr'] }, { hdr: [['pq']] }];
const mediaOdd = [null, true, false, 0, 1, -1, 1.5, 20000, 20001, 86400000, 86400001, 1e21, '', 'sdr', 'SDR', 'gainmap', 'hdr', 'ABCDEFG', 'ABCDEFGH', 'ABCDEFGg', 'A'.repeat(101), [], ['sdr'], ['sdr', 'pq'], [null, 'pq'], {}, { a: 1 }];
const mediaValues = [undefined, null, 5, 'x', [], [1]];
const seenMedia = new Set(mediaValues.map(v => JSON.stringify(v) ?? 'undefined'));
const addMedia = v => { const key = JSON.stringify(v); if (!seenMedia.has(key)) { seenMedia.add(key); mediaValues.push(v); } };
for (const sample of mediaGood) { addMedia(sample); addMedia({ ...sample, extra: 1 }); for (const key of ['width', 'height', 'durationMs', 'hdr', 'waveform']) for (const value of mediaOdd) addMedia({ ...sample, [key]: value }); }
writeFileSync(join(out, 'media.json'), '[\n' + mediaValues.map(value => JSON.stringify({ value: value === undefined ? null : JSON.stringify(value), valid: media.validMedia(value), wire: value === undefined ? null : JSON.stringify(media.wireMedia(value) ?? null) })).join(',\n') + '\n]\n');
const KEY = 'A'.repeat(43) + '=', NONCE = 'b'.repeat(16);
const small = { id: U, name: 'photo.jpg', mimeType: 'image/jpeg', size: 12345, encryption: { scheme: 'aes-256-gcm-siv', key: KEY, nonce: NONCE, fileKeyId: V } };
const big = { id: U, name: 'video.mp4', mimeType: 'video/mp4', size: 10 * 1024 * 1024 * 1024, encryption: { scheme: 'aes-256-gcm-siv-chunked', key: KEY, nonce: NONCE, fileKeyId: V, chunkSize: 4 * 1024 * 1024 }, media: { width: 1920, height: 1080, durationMs: 60000 } };
const voice = { ...small, name: 'voice.m4a', mimeType: 'audio/mp4', media: { durationMs: 16000, waveform: 'ABCDEFGHabcdef' }, preview: 'OK' };
const attachOdd = [null, true, 0, 1, -1, 1.5, 12345, 20 * 1024 * 1024, 20 * 1024 * 1024 + 1, 10 * 1024 * 1024 * 1024 + 1, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 9007199254740993, '', 'x', 'OK', U, [U], [[U]], [U, U], V.toUpperCase(), KEY, [KEY], KEY.slice(1), KEY.replace('=', 'A'), NONCE, [NONCE], NONCE + 'b', 'n'.repeat(240), 'n'.repeat(241), 'm'.repeat(150), 'm'.repeat(151), 'aes-256-gcm-siv', 'aes-256-gcm-siv-chunked', 'aes-256-gcm', [], {}, { width: 5 }, { width: 0 }];
const attachValues = [null, 5, 'x', [], {}];
const seenAttach = new Set(attachValues.map(v => JSON.stringify(v)));
const addAttach = v => { const key = JSON.stringify(v); if (!seenAttach.has(key)) { seenAttach.add(key); attachValues.push(v); } };
const walkAttach = (root, node, path) => { for (const key of Object.keys(node)) { const at = [...path, key];
  const put = value => { const copy = structuredClone(root); let target = copy; for (const step of at.slice(0, -1)) target = target[step]; if (value === walkAttach) delete target[key]; else target[key] = value; return copy; };
  addAttach(put(walkAttach)); for (const value of attachOdd) addAttach(put(value));
  if (node[key] && typeof node[key] === 'object' && !Array.isArray(node[key])) { const extra = structuredClone(root); let target = extra; for (const step of at) target = target[step]; target.extra = 1; addAttach(extra); walkAttach(root, node[key], at); } } };
for (const sample of [small, big, voice]) { addAttach(sample); addAttach({ ...sample, extra: 1 }); walkAttach(sample, sample, []); }
addAttach({ ...small, encryption: { ...small.encryption, chunkSize: 4 * 1024 * 1024 } }); addAttach({ ...big, size: 0 }); addAttach({ ...small, size: 0 });
writeFileSync(join(out, 'attachment.json'), '[\n' + attachValues.map(value => JSON.stringify({ value: JSON.stringify(value), valid: attach.validAttachment(value) })).join(',\n') + '\n]\n');
const plains = [{ text: 'hi', attachment: null, sentAt: '2026-11-21T00:00:00.000Z' }, { text: '', attachment: voice, sentAt: 's', meta: { silent: true } }, { text: '', attachment: { ...small, media: { waveform: 'ABCDEFGH' } }, sentAt: 's' },
  { text: 't', attachment: small, sentAt: 's' }, { text: 't', attachment: big, sentAt: 's' }, { attachment: { media: { waveform: 5, width: 1 }, id: 1 }, text: 't' }, { text: 't', attachment: { ...small, media: { waveform: null } }, sentAt: 's' }];
const waves = [undefined, 'ABCDEFGH', 'short', 5, 'A'.repeat(101), 'abcdefgh'];
const attachments = [null, small, voice, big, { ...small, media: {} }, { ...small, media: { width: 3 } }];
writeFileSync(join(out, 'waveform.json'), JSON.stringify({ wire: plains.map(plain => ({ plain: JSON.stringify(plain), wire: JSON.stringify(attach.wireBody(plain)) })),
  back: attachments.flatMap(attachment => waves.map(waveform => ({ attachment: JSON.stringify(attachment), waveform: waveform === undefined ? null : JSON.stringify(waveform), result: JSON.stringify(attach.withWaveform(attachment, waveform)) }))) }, null, 1) + '\n');
console.log('media', mediaValues.length, 'valid', mediaValues.filter(media.validMedia).length, 'attachment', attachValues.length, 'valid', attachValues.filter(attach.validAttachment).length);
