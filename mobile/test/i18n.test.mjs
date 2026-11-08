import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadTs } from './support/load-ts.mjs';

const require = createRequire(import.meta.url);
const store = new Map();
const i18n = loadTs(new URL('../src/i18n/index.ts', import.meta.url), {
  '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async k => store.get(k) ?? null, setItem: async (k, v) => { store.set(k, v); } } },
  './en.json': require('../src/i18n/en.json'), react: { useSyncExternalStore: () => 'ru' },
});

test('Russian stays as written; English replaces interface strings and keeps spaces', () => {
  assert.equal(i18n.tr('Настройки'), 'Настройки');
  assert.equal(i18n.tr('Настройки', 'en'), 'Settings');
  assert.equal(i18n.tr(' Отмена ', 'en'), ' Cancel ');
  assert.equal(i18n.tr('Привет, как дела?', 'en'), 'Привет, как дела?', 'unknown text is left alone');
  assert.deepEqual(i18n.trChildren(['Твой профиль —', '\n', 'заметнее любого другого'], 'en'), ['Your profile —', '\n', 'stands out more than any other']);
});

test('accessibility labels and hints are translated like Text, and only the props that are set', () => {
  assert.deepEqual(i18n.trA11y({ accessibilityLabel: 'Закрыть', accessibilityHint: 'Открыть чат' }, 'en'), { accessibilityLabel: 'Close', accessibilityHint: 'Open chat' });
  assert.deepEqual(i18n.trA11y({ accessibilityLabel: 'Анна' }, 'en'), { accessibilityLabel: 'Анна' }, 'a name is not an interface string');
  assert.deepEqual(i18n.trA11y({}, 'en'), {});
  assert.deepEqual(i18n.trA11y({ accessibilityLabel: 'Закрыть' }, 'ru'), {});
});

test('the language choice is saved and survives a restart', async () => {
  i18n.setLanguage('en');
  assert.equal(i18n.getLanguage(), 'en');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get('linea.language.v1'), 'en');
  i18n.setLanguage('ru'); await i18n.loadLanguage();
  assert.equal(i18n.getLanguage(), 'ru');
});

test('every dictionary entry is a non-empty translation', () => {
  const en = require('../src/i18n/en.json');
  for (const [ru, value] of Object.entries(en)) assert.ok(typeof value === 'string' && value.trim(), ru);
  assert.ok(Object.keys(en).length > 1700);
});
