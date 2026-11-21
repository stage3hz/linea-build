// Produces the vectors the Rust core is checked against, by running the reference implementations themselves.
// Run from the repository root:  node native/core/tests/generate-vectors.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signRequest, verifyAttest } from '../../../server/src/attest.js';
import { deviceMessage } from '../../../server/src/devicebind.js';

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
