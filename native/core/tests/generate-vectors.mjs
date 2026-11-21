// Produces the vectors the Rust core is checked against, by running the reference implementations themselves.
// Run from the repository root:  node native/core/tests/generate-vectors.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signRequest, verifyAttest } from '../../../server/src/attest.js';
import { deviceMessage } from '../../../server/src/devicebind.js';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
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
