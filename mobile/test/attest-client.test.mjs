import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { attestHeaders } from '../src/attest/index.ts';

test('the public repository never contains a real signing key', () => {
  const source = readFileSync(new URL('../src/attest/key.ts', import.meta.url), 'utf8');
  assert.match(source, /export const ATTEST_KEY = '';/, 'key.ts must stay empty in git; release builds inject it');
});

test('without a key the app sends no signature (signing is off)', () => {
  assert.deepEqual(attestHeaders('POST', '/auth/login'), {});
  assert.deepEqual(attestHeaders('GET', '/me'), {});
});
