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
  for (const mode of ['light', 'dark', 'black', 'graphite', 'system']) {
    await storage.writeTheme(mode);
    assert.equal(await preferences(Object.fromEntries(values)).storage.readTheme(), mode);
  }
  await storage.writeDarkTheme('black');
  assert.equal(await preferences(Object.fromEntries(values)).storage.readDarkTheme(), 'black');
  await storage.writeDarkTheme('graphite');
  assert.equal(await preferences(Object.fromEntries(values)).storage.readDarkTheme(), 'graphite');
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

test('black follows Linear: near-black steps (page, card, raised), hairline separators; the navy palette is retained', () => {
  const { palette } = loadTs(new URL('../src/theme.tsx', import.meta.url), { './i18n': { getLanguage: () => 'ru' } });
  assert.equal(palette.dark.bg, '#080F1E');
  assert.equal(palette.dark.glass, 'rgba(19,31,53,0.52)');
  assert.equal(palette.black.bg, '#08090A');
  assert.equal(palette.black.glassOpaque, '#0F1011');
  assert.equal(palette.black.border, '#23252A');
  // Neutral greys only (no tint): every glass/surface colour has R≈G≈B.
  for (const key of ['glass', 'glassClear', 'glassTint', 'surface', 'surface2']) {
    const [r, g, b] = palette.black[key].match(/\d+/g).map(Number);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2 && Math.max(r, g, b) <= 24, key);
  }
  assert.deepEqual(palette.black.bgGradient, ['#08090A', '#08090A', '#08090A']);
});

test('the «Оформление» row names the theme on screen: the night theme at night, the day theme otherwise', () => {
  const { themeFor } = loadTs(new URL('../src/themePreference.ts', import.meta.url));
  assert.equal(themeFor('black', 'dark', true), 'dark');
  assert.equal(themeFor('black', 'dark', false), 'black');
  assert.equal(themeFor('system', 'black', true), 'black');
  assert.equal(themeFor('system', 'black', false), 'light');
});

test('switch knob: onAccent reads on the accent track in every built-in theme (white would vanish in «Чёрная»/«Графит»)', () => {
  const { palette } = loadTs(new URL('../src/theme.tsx', import.meta.url), { './i18n': { getLanguage: () => 'ru' } });
  const channel = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = hex => { const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map(x => parseInt(x, 16)); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const id of ['light', 'dark', 'black', 'graphite']) assert.ok(contrast(palette[id].onAccent, palette[id].accent) >= 3, `${id}: ${contrast(palette[id].onAccent, palette[id].accent)}`);
  assert.ok(contrast('#FFFFFF', palette.black.accent) < 1.5);
});
