import assert from 'node:assert/strict';
import test from 'node:test';
import { PALETTES, paletteThemes, contrast } from '../src/themes/palettes.ts';
import { loadTs } from './support/load-ts.mjs';

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
