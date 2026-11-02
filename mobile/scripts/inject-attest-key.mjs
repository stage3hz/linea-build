#!/usr/bin/env node
// Writes the request-signing key into src/attest/key.ts for a release build.
// Runs in the build's own workspace only (CI step or a local release build);
// the repository keeps the empty file. Without ATTEST_KEY signing stays off.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const key = (process.env.ATTEST_KEY || '').trim();
const target = fileURLToPath(new URL('../src/attest/key.ts', import.meta.url));
if (!key) {
  console.log('ATTEST_KEY не задан: подпись запросов в этой сборке выключена.');
  process.exit(0);
}
if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) {
  console.error('ATTEST_KEY должен быть 32–128 символов [A-Za-z0-9_-].');
  process.exit(1);
}
writeFileSync(target, `// Injected for this build only. Do not commit.\nexport const ATTEST_KEY = ${JSON.stringify(key)};\n`);
console.log('Ключ подписи запросов записан в сборку.');
