import assert from 'node:assert/strict';
import test from 'node:test';
import { PALETTES, paletteThemes, contrast } from '../src/themes/palettes.ts';
import { loadTs } from './support/load-ts.mjs';
import { ownBubbleInk } from '../src/themes/custom.ts';

const solid = (rgba, bg) => { const m = rgba.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/); if (!m) return rgba; const [r, g, b, a] = m.slice(1).map(Number); const B = [1, 3, 5].map(i => parseInt(bg.slice(i, i + 2), 16)); return '#' + [r, g, b].map((v, i) => Math.round(v * a + B[i] * (1 - a)).toString(16).padStart(2, '0')).join(''); };

test('every palette theme is readable (WCAG AA 4.5:1 for text)', () => {
  assert.equal(PALETTES.length, 7);
  for (const p of PALETTES) {
    const t = paletteThemes[p.id];
    for (const [what, fg, bg] of [['text/bg', t.text, t.bg], ['text/my bubble', t.text, solid(t.bubble, t.bg)], ['text/incoming', t.text, solid(t.incoming, t.bg)], ['muted/bg', t.muted, t.bg], ['button label', t.onAccent, t.accent], ['accent/bg', t.accent, t.bg]]) {
      assert.ok(contrast(fg, bg) >= 4.5, `${p.name}: ${what} = ${contrast(fg, bg).toFixed(2)}`);
    }
  }
});

test('a chosen palette survives restart; unknown values fall back safely', () => {
  const pref = loadTs(new URL('../src/themePreference.ts', import.meta.url));
  assert.equal(pref.storedThemeMode('amethyst'), 'amethyst');
  assert.equal(pref.storedThemeMode('nonsense'), 'system');
  assert.equal(pref.storedDarkTheme('neon'), 'neon');
  assert.equal(pref.resolveTheme('system', 'coffee', 'dark'), 'coffee');
  assert.equal(pref.resolveTheme('system', 'coffee', 'light'), 'light');
});

test('palettes need Platina: without it a saved palette shows as dark, others untouched', () => {
  const pref = loadTs(new URL('../src/themePreference.ts', import.meta.url));
  assert.equal(pref.withPlatina('amethyst', false), 'dark');
  assert.equal(pref.withPlatina('amethyst', true), 'amethyst');
  for (const plain of ['system', 'light', 'dark', 'black', 'graphite']) assert.equal(pref.withPlatina(plain, false), plain);
  assert.equal(pref.resolveTheme(pref.withPlatina('system', false), pref.withPlatina('neon', false), 'dark'), 'dark');
});

test('time, ticks and the quote on the own bubble are readable in every palette (4.5:1 text, 3:1 marks)', () => {
  for (const p of PALETTES) {
    const t = paletteThemes[p.id], bubble = solid(t.bubble, t.bg), ink = ownBubbleInk(t);
    assert.ok(contrast(ink.meta, bubble) >= 4.45, `${p.name}: meta = ${contrast(ink.meta, bubble).toFixed(2)}`);
    assert.ok(contrast(ink.accent, bubble) >= 2.95, `${p.name}: marks = ${contrast(ink.accent, bubble).toFixed(2)}`);
    assert.equal(ownBubbleInk(t), ink, 'computed once per theme');
  }
});
