import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

function preferences(initial = {}) {
  const values = new Map(Object.entries(initial));
  const storage = loadTs(new URL('../src/storage.ts', import.meta.url), {
    '@react-native-async-storage/async-storage': { getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); } },
    'expo-secure-store': {}, 'react-native': { Platform: { OS: 'web' } },
  });
  return { storage, values };
}

test('first launch follows the system and preserves the previous navy dark default', async () => {
  const { storage } = preferences();
  assert.equal(await storage.readTheme(), 'system');
  assert.equal(await storage.readDarkTheme(), 'dark');
});

test('all manual modes survive storage round trips; black does not revert to system', async () => {
  const { storage, values } = preferences();
  for (const mode of ['light', 'dark', 'black', 'system']) {
    await storage.writeTheme(mode);
    assert.equal(await preferences(Object.fromEntries(values)).storage.readTheme(), mode);
  }
  await storage.writeDarkTheme('black');
  assert.equal(await preferences(Object.fromEntries(values)).storage.readDarkTheme(), 'black');
});

test('invalid preferences recover to system with navy rather than an unknown palette', async () => {
  const { storage } = preferences({ 'linea.theme.v1': 'old-custom', 'linea.dark-theme.v1': 'light' });
  assert.equal(await storage.readTheme(), 'system');
  assert.equal(await storage.readDarkTheme(), 'dark');
});

test('manual appearance ignores OS changes while automatic mode uses the selected dark variant', () => {
  const { resolveTheme } = loadTs(new URL('../src/themePreference.ts', import.meta.url));
  for (const manual of ['light', 'dark', 'black']) for (const os of ['light', 'dark', null]) assert.equal(resolveTheme(manual, 'black', os), manual);
  assert.equal(resolveTheme('system', 'dark', 'dark'), 'dark');
  assert.equal(resolveTheme('system', 'black', 'dark'), 'black');
  assert.equal(resolveTheme('system', 'black', 'light'), 'light');
  assert.equal(resolveTheme('system', 'black', null), 'light');
  assert.equal(resolveTheme('system', 'black', 'unspecified'), 'light');
});

test('rapid preference writes are ordered and a rejected save does not block later saves', async () => {
  const calls = []; let finish;
  const storage = loadTs(new URL('../src/storage.ts', import.meta.url), {
    '@react-native-async-storage/async-storage': {
      getItem: async () => null,
      setItem: async (key, value) => { calls.push([key, value]); if (value === 'light') await new Promise((_, reject) => { finish = reject; }); },
    }, 'expo-secure-store': {}, 'react-native': { Platform: { OS: 'web' } },
  });
  const first = storage.writeTheme('light'); const caught = assert.rejects(first, /disk/);
  const last = storage.writeTheme('black');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['linea.theme.v1', 'light']]);
  finish(new Error('disk')); await caught; await last;
  assert.deepEqual(calls, [['linea.theme.v1', 'light'], ['linea.theme.v1', 'black']]);
});

test('black has an RGB-zero base and neutral glass; the existing navy palette is retained', () => {
  const { palette } = loadTs(new URL('../src/theme.tsx', import.meta.url));
  assert.equal(palette.dark.bg, '#080F1E');
  assert.equal(palette.dark.glass, 'rgba(19,31,53,0.52)');
  assert.equal(palette.black.bg, '#000000');
  assert.equal(palette.black.glassOpaque, '#000000');
  for (const key of ['glass', 'glassClear', 'glassTint', 'surface', 'surface2']) assert.match(palette.black[key], /^rgba\(0,0,0,/);
  assert.deepEqual(palette.black.bgGradient, ['#000000', '#000000', '#000000']);
});
