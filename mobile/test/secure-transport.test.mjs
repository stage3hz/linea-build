import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

function policy(t, development, optIn) {
  const oldDev = globalThis.__DEV__, oldFlag = process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP;
  globalThis.__DEV__ = development;
  if (optIn === undefined) delete process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP;
  else process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP = optIn;
  t.after(() => {
    if (oldDev === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = oldDev;
    if (oldFlag === undefined) delete process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP;
    else process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP = oldFlag;
  });
  return loadTs(new URL('../src/storage.ts', import.meta.url), {
    '@react-native-async-storage/async-storage': {}, 'expo-secure-store': {},
    'react-native': { Platform: { OS: 'android' } },
  }).normalizeServer;
}

test('release requires HTTPS even for local endpoints and a mistakenly enabled development flag', t => {
  const normalize = policy(t, false, '1');
  for (const url of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001', 'http://192.168.1.10:3001', 'http://server.local:3001', 'http://chat.example.com']) {
    assert.throws(() => normalize(url), /HTTPS/, url);
  }
  assert.equal(normalize(' https://chat.example.com/ '), 'https://chat.example.com');
});

test('a debug runtime still requires explicit opt-in before local HTTP is accepted', t => {
  const normalize = policy(t, true, undefined);
  assert.throws(() => normalize('http://10.0.2.2:3001'), /HTTPS/);
});

test('explicit development HTTP is limited to local endpoints and never permits URL credentials or tokens', t => {
  const normalize = policy(t, true, '1');
  for (const url of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001', 'http://192.168.1.10:3001', 'http://server.local:3001']) {
    assert.equal(normalize(url), url);
  }
  for (const url of ['http://chat.example.com', 'http://172.32.1.1', 'https://user:password@example.com', 'https://example.com?token=x', 'https://example.com/path', 'https://example.com#token', 'ftp://localhost']) {
    assert.throws(() => normalize(url));
  }
});
