import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTs } from './support/load-ts.mjs';

const { PixelTrailModel, TRAIL, trailColor, trailFade, trailFalloff, trailGlide } = loadTs(new URL('../src/pixelTrailModel.ts', import.meta.url), {});

const FRAME = 1000 / 60;
const at = (field, c, r) => (c < field.c0 || r < field.r0 || c >= field.c0 + field.cols || r >= field.r0 + field.rows) ? 0 : field.alpha[(r - field.r0) * field.cols + (c - field.c0)];
const cell = v => Math.floor(v / TRAIL.PITCH);
/** Runs frames from `from` until `until` (ms), calling `each(t)` before every step; returns the next frame time. */
const run = (model, from, until, each = () => {}) => { let t = from; for (; t < until; t += FRAME) { each(t); model.step(t); } return t; };

test('colour contrasts with the theme', () => {
  assert.equal(trailColor(true), '#FFFFFF');
  assert.equal(trailColor(false), '#000000');
});

test('the tiles form a fine mesh: small squares with a thin gap', () => {
  assert.equal(TRAIL.PITCH - TRAIL.DOT, 1);
  assert.ok(TRAIL.DOT >= 3 && TRAIL.DOT <= 6);
  assert.ok(TRAIL.PEAK > 0 && TRAIL.PEAK < 1, 'a glow, never solid');
});

test('falloff = smoothstep(1 − d): 1 at the centre, smooth, 0 at and beyond the edge', () => {
  assert.equal(trailFalloff(0), 1);
  assert.equal(trailFalloff(0.5), 0.5);
  assert.equal(trailFalloff(1), 0);
  assert.equal(trailFalloff(3), 0);
  assert.equal(trailFalloff(NaN), 0);
  for (let d = 0; d < 1; d += 0.05) assert.ok(trailFalloff(d) >= trailFalloff(d + 0.05));
  assert.ok(trailFalloff(0.98) < 0.002);
});

test('fade: smoothstep over the trail life, linear when held; the glide is LERP per 60 Hz frame at any refresh rate', () => {
  assert.equal(trailFade(0), 1);
  assert.equal(trailFade(TRAIL.LIFE), 0);
  assert.equal(trailFade(Infinity), 0);
  assert.ok(Math.abs(trailFade(TRAIL.LIFE / 2) - 0.5) < 1e-12, 'smoothstep at the midpoint');
  assert.ok(Math.abs(trailFade(TRAIL.HOLD / 4, TRAIL.HOLD) - 0.75) < 1e-12, 'held finger dims linearly');
  assert.ok(TRAIL.HOLD >= 1000 && TRAIL.HOLD <= 4000 && TRAIL.LIFE < 500, 'a short trail, a resting light that fades within a couple of seconds');
  assert.ok(Math.abs(trailGlide(FRAME) - TRAIL.LERP) < 1e-12);
  // Two 120 Hz frames glide as far as one 60 Hz frame.
  const half = trailGlide(FRAME / 2);
  assert.ok(Math.abs(1 - (1 - half) * (1 - half) - TRAIL.LERP) < 1e-12);
});

test('nothing is lit and no frames are asked for until a pointer appears', () => {
  const model = new PixelTrailModel();
  assert.equal(model.step(0), false);
  assert.equal(model.compute(0).lit, 0);
  assert.equal(model.bloom(0).alpha, 0);
});

test('a touch lights a soft circle right under the finger, on the fixed screen grid', () => {
  const model = new PixelTrailModel();
  model.down(202.5, 302.5, 0);// a tile centre
  assert.equal(model.step(0), true);
  const field = model.compute(0);
  assert.ok(Math.abs(at(field, cell(202.5), cell(302.5)) - TRAIL.PEAK) < 1e-6);
  let previous = Infinity;
  for (let c = cell(202.5); c < cell(202.5 + TRAIL.RADIUS) + 2; c++) { const a = at(field, c, cell(302.5)); assert.ok(a <= previous + 1e-7); previous = a; }
  assert.equal(at(field, cell(202.5 + TRAIL.RADIUS) + 1, cell(302.5)), 0);
  for (let r = field.r0; r < field.r0 + field.rows; r++) for (let c = field.c0; c < field.c0 + field.cols; c++) {
    const a = at(field, c, r);
    assert.ok(Math.abs(a - model.alphaAt(c * TRAIL.PITCH + TRAIL.PITCH / 2, r * TRAIL.PITCH + TRAIL.PITCH / 2, 0)) < 1e-6);
    assert.ok(a === 0 || a >= TRAIL.PEAK * TRAIL.MIN_WEIGHT - 1e-7);
  }
  const bloom = model.bloom(0);
  assert.deepEqual([bloom.x, bloom.y], [202.5, 302.5]);
  assert.ok(Math.abs(bloom.alpha - TRAIL.BLOOM) < 1e-9);
});

test('the light sits right under the pointer and leaves a short tail that fades behind it', () => {
  const model = new PixelTrailModel();
  model.point(0, 200, 0);
  let x = 0;
  const end = run(model, 0, 300, () => { x += 12; model.point(x, 200, 0); });
  assert.equal(model.px, model.tx, 'the light is exactly under the pointer (no lag)');
  const field = model.compute(end - FRAME);
  const r = cell(200);
  const head = at(field, cell(model.px), r), middle = at(field, cell(model.px - 110), r), tail = at(field, cell(model.px - 200), r);
  assert.ok(head > middle && middle > tail, `head ${head} > middle ${middle} > tail ${tail}`);
  assert.ok(middle > 0);
});

test('when the light settles under a held finger it stays and fades by itself over a few seconds', () => {
  const model = new PixelTrailModel();
  model.down(100, 100, 0);
  let x = 100;
  let t = run(model, 0, 200, () => { x += 8; model.point(x, 100, 0); });
  t = run(model, t, t + 150);// the light catches up and settles
  const centre = () => at(model.compute(t - FRAME), cell(x), cell(100));
  assert.ok(centre() > TRAIL.PEAK * 0.8, `fresh at rest ${centre()}`);
  t = run(model, t, t + TRAIL.HOLD / 2);
  const later = centre();
  assert.ok(later > TRAIL.PEAK * 0.35 && later < TRAIL.PEAK * 0.65, `dimmer half-way through HOLD: ${later}`);
  let frames = 0;
  while (model.step(t)) { t += FRAME; frames++; }
  assert.ok(frames * FRAME < TRAIL.HOLD, 'gone within HOLD');
  assert.equal(model.compute(t).lit, 0);
  // At rest the light waits at the pointer.
  assert.deepEqual([model.px, model.py], [x, 100]);
});

test('when the pointer stops, the light starts fading at once (no waiting) and is gone within HOLD', () => {
  const model = new PixelTrailModel();
  model.point(100, 100);
  let x = 100;
  let t = run(model, 0, 200, () => { x += 8; model.point(x, 100); });
  const stop = t;
  t = run(model, t, t + 300);// the light glides in, but already dims from the stop
  const v = at(model.compute(t - FRAME), cell(x), cell(100));
  const expected = TRAIL.PEAK * (1 - (t - FRAME - stop) / TRAIL.HOLD);
  assert.ok(Math.abs(v - expected) < TRAIL.PEAK * 0.1, `dimming since the stop: ${v} vs ${expected}`);
  let frames = 0;
  while (model.step(t)) { t += FRAME; frames++; }
  assert.ok(t - stop <= TRAIL.HOLD + 3 * FRAME, `gone ${t - stop} ms after the stop`);
});

test('a still, held finger dims from the first moment; lifting it changes nothing (no jump, same fade)', () => {
  const model = new PixelTrailModel();
  model.down(400, 400, 0);
  let t = run(model, 0, 300);
  const v = at(model.compute(t - FRAME), cell(400), cell(400));
  assert.ok(v < TRAIL.PEAK * 0.9 && v > TRAIL.PEAK * 0.7, `already dimming: ${v}`);
  model.release(t - FRAME);
  assert.ok(Math.abs(at(model.compute(t - FRAME), cell(400), cell(400)) - v) < 1e-6, 'no jump at release');
  while (model.step(t)) t += FRAME;
  assert.ok(t <= TRAIL.HOLD + 3 * FRAME, `gone ${t} ms after the touch`);
});

test('moving away after a rest does not leave a second slow spot behind', () => {
  const model = new PixelTrailModel();
  model.down(200, 200, 0);
  let t = run(model, 0, 600);// held still for a moment: still bright
  assert.ok(at(model.compute(t - FRAME), cell(200), cell(200)) > TRAIL.PEAK * 0.5);
  let x = 200;
  t = run(model, t, t + 600, () => { x += 15; model.point(x, 200, 0); });
  // The old spot faded as fast as the trail (as a HOLD light it would still glow for seconds).
  assert.equal(at(model.compute(t - FRAME), cell(200), cell(200)), 0);
});

test('a still, held finger is not refreshed: its light fades too; a new touch lights again at once', () => {
  const model = new PixelTrailModel();
  model.down(300, 300, 0);
  const t = run(model, 0, TRAIL.HOLD + 100);
  assert.equal(model.alive(t), false);
  model.down(600, 300, t);
  assert.equal(model.step(t), true);
  assert.ok(at(model.compute(t), cell(600), cell(300)) > 0);
  assert.equal(at(model.compute(t), cell(300), cell(300)), 0);
});

test('a hovering cursor starts a trail after a rest; a touch puts the light right under the finger', () => {
  const model = new PixelTrailModel();
  model.point(50, 50);
  let t = run(model, 0, TRAIL.HOLD + 100);
  assert.equal(model.alive(t), false);
  model.point(80, 50);
  assert.equal(model.step(t), true, 'the cursor moved on: the light follows it');
  assert.equal(model.px, 80);
  t = run(model, t, t + TRAIL.HOLD + 100);
  model.down(800, 500, t);
  assert.deepEqual([model.px, model.py], [800, 500]);
});

test('samples are capped at MAX_SAMPLES and the tile buffer covers the band', () => {
  const model = new PixelTrailModel();
  model.point(0, 0, 0);
  let x = 0;
  const t = run(model, 0, 2000, () => { x += 30; model.point(x, x % 700, 0); });
  assert.equal(model.ts.length, TRAIL.MAX_SAMPLES);
  const field = model.compute(t - FRAME);
  assert.ok(field.lit > 0 && field.cols * field.rows <= field.alpha.length);
});

test('bad input is ignored; clear drops everything', () => {
  const model = new PixelTrailModel();
  model.down(NaN, 0, 0);
  model.point(0, Infinity, 0);
  assert.equal(model.step(0), false);
  model.down(10, 10, 0);
  model.clear();
  assert.equal(model.alive(0), false);
  assert.equal(model.compute(0).lit, 0);
});

test('native ports mirror the shared constants', () => {
  const swift = readFileSync(new URL('../modules/linea-trail/ios/LineTrailModule.swift', import.meta.url), 'utf8');
  const kotlin = readFileSync(new URL('../modules/linea-trail/android/src/main/java/expo/modules/lineatrail/TrailModel.kt', import.meta.url), 'utf8');
  const num = (text, pattern) => Number(text.match(pattern)?.[1]);
  for (const [key, swiftName] of [['PITCH', 'pitch'], ['DOT', 'dot'], ['RADIUS', 'radius'], ['PEAK', 'peak'], ['BLOOM', 'bloom'], ['BLOOM_SCALE', 'bloomScale'], ['LIFE', 'life'], ['HOLD', 'hold'], ['RELEASE', 'release'], ['LERP', 'lerp'], ['SAMPLE_STEP', 'sampleStep'], ['MAX_SAMPLES', 'maxSamples'], ['FILL_STEP', 'fillStep'], ['FILL_MAX', 'fillMax'], ['STILL_MS', 'stillMs'], ['MIN_WEIGHT', 'minWeight'], ['MOVING', 'moving']]) {
    assert.equal(num(swift, new RegExp(`static let ${swiftName}(?:: \\w+)? = ([\\d.]+)`)), TRAIL[key], `Swift ${swiftName}`);
    assert.equal(num(kotlin, new RegExp(`const val ${key} = ([\\d.]+)`)), TRAIL[key], `Kotlin ${key}`);
  }
});

test('the light is part of the background: drawn inside the backdrop layers, never as an overlay on top', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const host = read('../src/PixelTrail.tsx'), glass = read('../src/glass.tsx');
  // Every backdrop (both the plain and the gradient one) ends with the layer; glass.tsx owns the Android blur target.
  const backdrop = glass.slice(glass.indexOf('export function GlassBackdrop'), glass.indexOf('export function GlassStage'));
  assert.equal(backdrop.match(/<PixelTrailLayer\/>/g)?.length, 2);
  assert.match(read('../src/auth/AuthBackdrop.tsx'), /<PixelTrailLayer \/>/);
  const wallpaper = read('../src/WallpaperPicker.tsx');
  assert.equal(wallpaper.match(/trail \? <PixelTrailLayer/g)?.length, 2, 'over a preset and over a picture wallpaper');
  assert.match(read('../src/ChatScreen.tsx'), /<ChatWallpaper choice=\{wallpaper\}[^>]* trail\/>/);
  // Web: a canvas inside the layer, no fixed full-window overlay.
  assert.doesNotMatch(host, /position: 'fixed'|zIndex|document\.body\.appendChild/);
  assert.match(host, /pointerEvents: 'none'/);
  // Native: a view component, no view added on top of the window / decor view.
  const swift = read('../modules/linea-trail/ios/LineTrailModule.swift');
  assert.match(swift, /View\(TrailBackgroundView\.self\)/);
  assert.doesNotMatch(swift, /window\.addSubview|bringSubviewToFront/);
  assert.match(swift, /cancelsTouchesInView = false/);
  const dir = '../modules/linea-trail/android/src/main/java/expo/modules/lineatrail/';
  const kotlin = read(dir + 'LineTrailModule.kt') + read(dir + 'TrailBackground.kt');
  assert.match(kotlin, /View\(TrailBackgroundView::class\)/);
  assert.doesNotMatch(kotlin, /decor\.addView|decorView|bringToFront/);
  assert.match(kotlin, /return inner\.dispatchTouchEvent\(event\)/);
});

test('the setting defaults to on and survives bad stored values', () => {
  const { parsePreferences } = loadTs(new URL('../src/chatPreferences.ts', import.meta.url), { '@react-native-async-storage/async-storage': {}, react: { useSyncExternalStore: () => null } });
  assert.equal(parsePreferences(null).pixelTrail, true);
  assert.equal(parsePreferences('{}').pixelTrail, true);
  assert.equal(parsePreferences('{"pixelTrail":"no"}').pixelTrail, true);
  assert.equal(parsePreferences('{"pixelTrail":false}').pixelTrail, false);
});

test('a fast swipe leaves one continuous band, not separate spots', () => {
  const model = new PixelTrailModel();
  model.down(50, 300, 0);
  let x = 50;
  const t = run(model, 0, 120, () => { x += 60; model.point(x, 300, 0); });// ~60 pt per frame
  const field = model.compute(t - FRAME);
  // Every tile along the travelled path (inside the band) is lit.
  let gaps = 0;
  for (let px = 120; px < Math.min(x, 380); px += 5) if (!(at(field, cell(px), cell(300)) > 0)) gaps++;
  assert.equal(gaps, 0, 'no unlit tiles along the swipe');
});

test('the end of a fast swipe fades exactly like a finger held still (HOLD), and only one finger leads on web', () => {
  const swipe = new PixelTrailModel();
  swipe.down(100, 100, 0);
  let y = 100;
  let t = run(swipe, 0, 160, () => { y += 50; swipe.point(100, y, 0); });
  swipe.release(t - FRAME);
  const s0 = at(swipe.compute(t - FRAME), cell(100), cell(y));
  const t1 = run(swipe, t, t + TRAIL.HOLD / 2);
  const s1 = at(swipe.compute(t1 - FRAME), cell(100), cell(y));
  assert.ok(Math.abs(s1 / s0 - 0.5) < 0.06, `half-way after the lift: ${s1 / s0}`);
  // The tail behind is short: the start of the swipe is dark long before that.
  assert.equal(at(swipe.compute(t + TRAIL.LIFE + 2 * FRAME), cell(100), cell(100)), 0);

  const still = new PixelTrailModel();
  still.down(300, 300, 0);
  const u = run(still, 0, TRAIL.HOLD / 2);
  const h = at(still.compute(u - FRAME), cell(300), cell(300)) / TRAIL.PEAK;
  assert.ok(Math.abs(h - 0.5) < 0.06, `half-way while held: ${h}`);

  const host = readFileSync(new URL('../src/PixelTrail.tsx', import.meta.url), 'utf8');
  assert.match(host, /event\.pointerId === finger/);
  const kotlin = readFileSync(new URL('../modules/linea-trail/android/src/main/java/expo/modules/lineatrail/TrailBackground.kt', import.meta.url), 'utf8');
  assert.match(kotlin, /findPointerIndex\(lead\)/);
  const swift = readFileSync(new URL('../modules/linea-trail/ios/LineTrailModule.swift', import.meta.url), 'utf8');
  assert.match(swift, /if lead == nil, let first = touches\.first/);
});
