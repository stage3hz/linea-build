import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTs } from './support/load-ts.mjs';

const { PixelTrailModel, TRAIL, trailAlpha, trailColor, trailHash } = loadTs(new URL('../src/pixelTrailModel.ts', import.meta.url), {});

// A seeded generator so the spawn pattern is reproducible.
const seeded = (seed = 1) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const live = (model, now) => { let n = 0; for (let i = 0; i < TRAIL.MAX_LIVE; i++) if (now - model.born[i] < model.life[i]) n++; return n; };

test('colour contrasts with the theme', () => {
  assert.equal(trailColor(true), '#FFFFFF');
  assert.equal(trailColor(false), '#000000');
});

test('hash is a stable 32-bit mix in [0, 1) (the Swift and Kotlin ports reproduce these values)', () => {
  assert.equal(trailHash(0, 0), 0);
  assert.equal(trailHash(1, 2).toFixed(12), '0.054057230009');
  assert.equal(trailHash(-123456789, 7).toFixed(12), '0.457903033355');
  assert.equal(trailHash(2147483647, 99).toFixed(12), '0.475562395528');
  for (let i = 0; i < 1000; i++) { const h = trailHash(i * 7919, i); assert.ok(h >= 0 && h < 1); }
});

test('alpha starts at the birth opacity, falls with age, is 0 after the life, and flickers off sometimes', () => {
  assert.equal(trailAlpha(-1, 500, 1), 0);
  assert.equal(trailAlpha(500, 500, 1), 0);
  assert.equal(trailAlpha(900, 500, 1), 0);
  let shown = 0, hidden = 0, previous = Infinity;
  for (let seed = 1; seed < 400; seed++) {
    const a = trailAlpha(250, 500, seed);
    if (a === 0) hidden++; else { shown++; assert.ok(Math.abs(a - TRAIL.BIRTH_ALPHA * 0.5) < 1e-9); }
  }
  assert.ok(shown > hidden && hidden > 0, `flicker hides some cells (${hidden}/${shown + hidden})`);
  // Never brighter than at birth, and fading as it ages.
  for (let age = 0; age < 500; age += 48) { const a = trailAlpha(age, 500, 3); if (a) { assert.ok(a <= TRAIL.BIRTH_ALPHA && a <= previous + 1e-9); previous = a; } }
});

test('the first point of a stroke only anchors it; moving lights cells about every SPACING pt along the path', () => {
  const model = new PixelTrailModel(seeded(5));
  assert.equal(model.move(1, 10, 10, 0), 0);
  assert.equal(model.alive(0), false);
  const lit = model.move(1, 110, 10, 16);
  assert.ok(lit >= 100 / TRAIL.SPACING, `lit ${lit}`);
  assert.equal(model.alive(16), true);
  // Every lit cell sits on the grid within SCATTER (+1 for a 2×2 block) cells of the path.
  for (let i = 0; i < TRAIL.MAX_LIVE; i++) {
    if (!(16 - model.born[i] < model.life[i])) continue;
    assert.ok(model.size[i] === 1 || model.size[i] === 2);
    assert.ok(Math.abs(model.cy[i] - Math.floor(10 / TRAIL.GRID)) <= TRAIL.SCATTER);
    assert.ok(model.cx[i] >= Math.floor(10 / TRAIL.GRID) - TRAIL.SCATTER && model.cx[i] <= Math.floor(110 / TRAIL.GRID) + TRAIL.SCATTER);
    assert.ok(model.life[i] >= TRAIL.LIFE_MIN && model.life[i] <= TRAIL.LIFE_MAX);
  }
  // Everything is gone after the longest life: the animation loop can stop.
  assert.equal(model.alive(16 + TRAIL.LIFE_MAX + 1), false);
});

test('spacing carries over between small moves', () => {
  const model = new PixelTrailModel(() => 0.99);// no extras, no big blocks
  model.move(1, 0, 0, 0);
  let lit = 0;
  for (let x = 1; x <= 50; x++) lit += model.move(1, x, 0, x);
  assert.equal(lit, 50 / TRAIL.SPACING);
});

test('a cell passed again is re-lit, not stacked', () => {
  const model = new PixelTrailModel(() => 0.99);
  model.move(1, 0, 2, 0);
  model.move(1, 5, 2, 0);
  model.move(1, 0, 2, 100);
  model.move(1, 5, 2, 200);
  assert.equal(live(model, 200), 2);
});

test('live cells are capped, the oldest slot is reused', () => {
  const model = new PixelTrailModel(seeded(9));
  model.move(1, 0, 0, 0);
  for (let i = 1; i <= 100; i++) model.move(1, (i % 2 ? 200 : 0), i * 3, i);
  assert.ok(live(model, 100) <= TRAIL.MAX_LIVE);
  assert.equal(model.born.length, TRAIL.MAX_LIVE);
});

test('a long jump starts a new stroke; long fast moves are bounded; lift ends a stroke; bad input is ignored', () => {
  const model = new PixelTrailModel(() => 0.99);
  model.move(1, 0, 0, 0);
  assert.equal(model.move(1, TRAIL.MAX_JUMP + 50, 0, 1), 0);
  assert.ok(model.move(1, TRAIL.MAX_JUMP + 50 + TRAIL.MAX_JUMP - 1, 0, 2) <= TRAIL.MAX_STEPS);
  model.lift(1);
  assert.equal(model.move(1, 0, 0, 3), 0);
  assert.equal(model.move(1, NaN, 0, 4), 0);
  // Two fingers are tracked separately.
  model.move(2, 300, 300, 5);
  assert.ok(model.move(2, 330, 300, 6) > 0);
  model.clear();
  assert.equal(model.alive(6), false);
});

test('native ports mirror the shared constants', () => {
  const swift = readFileSync(new URL('../modules/linea-trail/ios/LineTrailModule.swift', import.meta.url), 'utf8');
  const kotlin = readFileSync(new URL('../modules/linea-trail/android/src/main/java/expo/modules/lineatrail/TrailModel.kt', import.meta.url), 'utf8');
  const num = (text, pattern) => Number(text.match(pattern)?.[1]);
  for (const [key, swiftName, factor] of [['GRID', 'grid', 1], ['SPACING', 'spacing', 1], ['SCATTER', 'scatter', 1], ['EXTRA_CHANCE', 'extraChance', 1], ['BIG_CHANCE', 'bigChance', 1], ['LIFE_MIN', 'lifeMin', 1000], ['LIFE_MAX', 'lifeMax', 1000], ['MAX_LIVE', 'maxLive', 1], ['BIRTH_ALPHA', 'birthAlpha', 1], ['FLICKER_MS', 'flicker', 1000], ['FLICKER_BASE', 'flickerBase', 1], ['FLICKER_GROW', 'flickerGrow', 1], ['MAX_JUMP', 'maxJump', 1], ['MAX_STEPS', 'maxSteps', 1]]) {
    assert.ok(Math.abs(num(swift, new RegExp(`static let ${swiftName}(?:: \\w+)? = ([\\d.]+)`)) * factor - TRAIL[key]) < 1e-9, `Swift ${swiftName}`);
    assert.equal(num(kotlin, new RegExp(`const val ${key} = ([\\d.]+)`)), TRAIL[key], `Kotlin ${key}`);
  }
});

test('the setting defaults to on and survives bad stored values', () => {
  const { parsePreferences } = loadTs(new URL('../src/chatPreferences.ts', import.meta.url), { '@react-native-async-storage/async-storage': {}, react: { useSyncExternalStore: () => null } });
  assert.equal(parsePreferences(null).pixelTrail, true);
  assert.equal(parsePreferences('{}').pixelTrail, true);
  assert.equal(parsePreferences('{"pixelTrail":"no"}').pixelTrail, true);
  assert.equal(parsePreferences('{"pixelTrail":false}').pixelTrail, false);
});
