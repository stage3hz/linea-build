import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Black-and-white document scan: paper estimated with a stroke-sized local maximum, no
// absolute «dark = ink» cut-off (it turned shadows, creases and stains into black blots).
test('Ч/б документ follows shadows and creases on iOS and Android alike', () => {
  const kt = readFileSync(new URL('../modules/linea-photo/android/src/main/java/expo/modules/lineaphoto/PhotoPixels.kt', import.meta.url), 'utf8');
  const swift = readFileSync(new URL('../modules/linea-photo/ios/PhotoPixels.swift', import.meta.url), 'utf8');
  assert.match(kt, /val paperRadius=max\(2,side\/130\)/);
  assert.match(swift, /let paperRadius = max\(2,side\/130\)/);
  assert.match(kt, /BW_INK=120f/); assert.match(kt, /BW_PAPER=200f/);
  assert.match(swift, /bwInk: Float = 120/); assert.match(swift, /bwPaper: Float = 200/);
  for (const src of [kt, swift]) assert.doesNotMatch(src, /ALWAYS_INK|value < 150/);
});
