import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ACCENT_CHOICES, BUBBLE_CHOICES, colorHsv, customTheme, hsvColor, storedColor } from '../src/themes/custom.ts';
import { contrast } from '../src/themes/palettes.ts';
import { loadTs } from './support/load-ts.mjs';

const { palette } = loadTs(new URL('../src/theme.tsx', import.meta.url), { './i18n': { getLanguage: () => 'ru' }, react: { createContext: value => value, useContext: value => value } });
const { parsePreferences } = loadTs(new URL('../src/chatPreferences.ts', import.meta.url), { '@react-native-async-storage/async-storage': {}, react: { useSyncExternalStore: () => null } });

// «Свои цвета»: the user's accent and message colours over any theme, always legible.
const solid = color => { const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color); return m ? '#' + m.slice(1, 4).map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase() : color.toUpperCase(); };

test('a stored colour is #RRGGBB or nothing', () => {
  assert.equal(storedColor('#ff9500'), '#FF9500');
  assert.equal(storedColor(' #3568E7 '), '#3568E7');
  for (const bad of ['red', '#FFF', '#GGGGGG', 'rgb(1,2,3)', '', null, 42, '#3568E7FF']) assert.equal(storedColor(bad), null);
  const read = parsePreferences(JSON.stringify({ accentColor: '#ff3b5c', bubbleColor: 'javascript:alert(1)' }));
  assert.equal(read.accentColor, '#FF3B5C');
  assert.equal(read.bubbleColor, null);
  assert.equal(parsePreferences(null).accentColor, null);
});

test('the sliders: hue, saturation and brightness go to a colour and back', () => {
  assert.equal(hsvColor(0, 1, 1), '#FF0000');
  assert.equal(hsvColor(120, 1, 1), '#00FF00');
  assert.equal(hsvColor(240, 1, 0.5), '#000080');
  assert.equal(hsvColor(0, 0, 1), '#FFFFFF');
  assert.equal(hsvColor(360, 1, 1), '#FF0000');
  for (const color of [...ACCENT_CHOICES, ...BUBBLE_CHOICES, '#123456', '#FEDCBA']) { const { h, s, v } = colorHsv(color); assert.equal(hsvColor(h, s, v), color); }
});

test('nothing chosen: the theme is exactly as it was', () => {
  for (const theme of Object.values(palette)) { assert.equal(customTheme(theme, null, null), theme); assert.equal(customTheme(theme, 'nonsense', undefined), theme); }
});

test('in every theme any chosen accent reads on the background, and its button text reads on it', () => {
  for (const [id, theme] of Object.entries(palette)) for (const accent of [...ACCENT_CHOICES, '#000000', '#FFFFFF', '#101010', '#F5F5F5', '#808080']) {
    const result = customTheme(theme, accent, null);
    assert.ok(contrast(solid(result.accent), solid(theme.bg)) >= 3, `${id} ${accent} → ${result.accent} on ${theme.bg}`);
    assert.ok(contrast(result.onAccent, solid(result.accent)) >= 3, `${id} ${accent}: button text`);
    assert.equal(result.bubble, theme.bubble, 'the bubbles are not touched by the accent');
    assert.equal(result.bg, theme.bg);
    assert.equal(result.accentGradient.length, 2);
  }
});

test('in every theme the text of my messages reads on any chosen bubble colour', () => {
  for (const [id, theme] of Object.entries(palette)) for (const bubble of [...BUBBLE_CHOICES, '#FFFFFF', '#000000', '#FFE600', '#7F7F7F']) {
    const result = customTheme(theme, null, bubble);
    assert.ok(contrast(solid(result.bubble), solid(theme.text)) >= 4.5, `${id} ${bubble} → ${result.bubble} under ${theme.text}`);
    assert.equal(result.accent, theme.accent);
    assert.equal(result.incoming, theme.incoming, 'the other side keeps the theme\'s colour');
  }
});

test('a colour that already reads is kept exactly as chosen', () => {
  const dark = palette.dark;
  assert.equal(customTheme(dark, '#FF9500', null).accent, '#FF9500');
  assert.equal(solid(customTheme(dark, null, '#2B5BD7').bubble), '#2B5BD7');
});

test('the app lays the colours over the theme in one place and offers them in «Оформление»', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.ok(read('../App.tsx').includes('customTheme(palette[themeFor(shownMode,shownDark,night)],preferences.accentColor,preferences.bubbleColor)'));
  assert.ok(read('../src/SettingsScreen.tsx').includes('<Group label="Свои цвета"><ColorSettings /></Group>'));
  const screen = read('../src/ColorSettings.tsx');
  for (const text of ['Цвет интерфейса', 'Цвет своих сообщений', 'Как в теме', 'Свой цвет', 'Оттенок', 'Насыщенность', 'Яркость']) assert.ok(screen.includes(text), text);
});
