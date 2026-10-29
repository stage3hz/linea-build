import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

function unavailableCrypto() {
  const calls = { weak: 0, secure: 0 };
  return { calls, provider: {
    CryptoDigestAlgorithm: { SHA256: 'SHA256' },
    digestStringAsync: async () => 'a'.repeat(64), randomUUID,
    getRandomBytes(length) { calls.weak++; return new Uint8Array(length).fill(42); },
    async getRandomBytesAsync() { calls.secure++; throw new Error('Native CSPRNG unavailable'); },
  } };
}

test('an unavailable secure RNG prevents creating or saving a vault key without a synchronous fallback', async () => {
  const crypto = unavailableCrypto(), saved = [], statements = [];
  const db = {
    async getFirstAsync(sql) { return sql.includes('cipher_version') ? { cipher_version: '4.6' } : { count: 0 }; },
    async execAsync(sql) { statements.push(sql); },
    async closeAsync() {},
  };
  const { openVault } = loadTs(new URL('../src/e2ee/vault.native.ts', import.meta.url), {
    'expo-crypto': crypto.provider,
    'expo-sqlite': { openDatabaseAsync: async () => db },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: async (...args) => saved.push(args), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' },
  });
  await assert.rejects(openVault('https://synthetic.invalid', randomUUID()), /хранилищ|CSPRNG|ключ/i);
  assert.equal(crypto.calls.secure, 1);
  assert.equal(crypto.calls.weak, 0, 'weak synchronous fallback must never be consulted');
  assert.equal(saved.length, 0);
  assert.equal(statements.some(sql => sql.includes('PRAGMA key')), false, 'a weak key must never reach SQLCipher');
});

test('an unavailable secure RNG stops attachment encryption before a key, ciphertext or upload is produced', async () => {
  const crypto = unavailableCrypto(), calls = { sealed: 0, uploaded: 0, written: 0 };
  const { encryptAndUpload } = loadTs(new URL('../src/e2ee/attachments.ts', import.meta.url), {
    'expo-crypto': crypto.provider,
    'react-native': { Platform: { OS: 'android' } },
    'expo-file-system/legacy': {
      cacheDirectory: 'file:///tmp/', EncodingType: { Base64: 'base64' },
      getInfoAsync: async () => ({ exists: true, isDirectory: false, size: 8 }),
      readAsStringAsync: async () => Buffer.from('contents').toString('base64'),
      writeAsStringAsync: async () => { calls.written++; }, deleteAsync: async () => {},
    },
    'expo-sharing': {},
    // This non-media fixture never needs native image/video thumbnail APIs.
    '../media/thumbnail': { makeThumbnail: async () => undefined },
    './signal': { getSignalBridge: () => ({ seal: async () => { calls.sealed++; return 'Y2lwaGVydGV4dA=='; } }) },
    'base64-js': { fromByteArray: bytes => Buffer.from(bytes).toString('base64'), toByteArray: value => new Uint8Array(Buffer.from(value, 'base64')) },
  });
  const api = { request: async () => { calls.uploaded++; return { id: randomUUID(), size: 24 }; } };
  await assert.rejects(encryptAndUpload(api, { uri: 'file:///synthetic.txt', name: 'synthetic.txt', mimeType: 'text/plain' }), /CSPRNG/i);
  assert.equal(crypto.calls.weak, 0);
  assert.equal(crypto.calls.secure, 1);
  assert.deepEqual(calls, { sealed: 0, uploaded: 0, written: 0 });
});
