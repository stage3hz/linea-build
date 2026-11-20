// Produces the vectors the Rust core is checked against, by running the reference implementations themselves.
// Run from the repository root:  node native/core/tests/generate-vectors.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signRequest, verifyAttest } from '../../../server/src/attest.js';

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
