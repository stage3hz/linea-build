import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const { MIN_SCALE, MAX_SCALE, DOUBLE_TAP_SCALE, clampScale, clampOffset, pinchTransform, doubleTapTarget } = loadTs(new URL('../src/media/zoomMath.ts', import.meta.url));

test('scale stays between the whole picture and the 5× limit, even for garbage input', () => {
  assert.equal(clampScale(0.3), MIN_SCALE); assert.equal(clampScale(2.2), 2.2); assert.equal(clampScale(40), MAX_SCALE);
  assert.equal(clampScale(NaN), MIN_SCALE); assert.equal(clampScale(Infinity), MIN_SCALE);
});
test('a zoomed picture can be panned only as far as its overflow; at 1× it cannot move at all', () => {
  assert.equal(clampOffset(500, 1, 400), 0); assert.equal(clampOffset(-500, 1, 400), 0);
  assert.equal(clampOffset(150, 2, 400), 150); assert.equal(clampOffset(500, 2, 400), 200); assert.equal(clampOffset(-500, 2, 400), -200);
  assert.equal(clampOffset(NaN, 3, 400), 0);
});
test('pinching keeps the point under the fingers still (focal zoom) and clamps the result', () => {
  const box = { width: 400, height: 800, baseScale: 1, baseX: 0, baseY: 0 };
  const centre = pinchTransform({ ...box, focalX: 200, focalY: 400, scale: 2 });
  assert.deepEqual(centre, { scale: 2, x: 0, y: 0 });
  // Fingers at the top-left quarter: the picture shifts towards the bottom-right so that point stays put.
  const corner = pinchTransform({ ...box, focalX: 100, focalY: 200, scale: 2 });
  assert.equal(corner.x, 100); assert.equal(corner.y, 200);
  // The same content point is under the fingers after the change: (f − t)/s is unchanged.
  assert.equal((100 - 200 - corner.x) / corner.scale, (100 - 200 - 0) / 1);
  // Beyond the edge the translation is clamped; beyond 5× the scale is clamped.
  const far = pinchTransform({ ...box, focalX: 0, focalY: 0, scale: 9 });
  assert.equal(far.scale, MAX_SCALE); assert.equal(far.x, 400 * (MAX_SCALE - 1) / 2); assert.equal(far.y, 800 * (MAX_SCALE - 1) / 2);
  // Continuing from an existing zoom uses the saved base, not 1×.
  const again = pinchTransform({ ...box, baseScale: 2, baseX: 100, baseY: 200, focalX: 100, focalY: 200, scale: 2 });
  assert.deepEqual(again, { scale: 2, x: 100, y: 200 });
});
test('double tap zooms to 2.5× around the finger and back to the whole picture when already zoomed', () => {
  const box = { width: 400, height: 800 };
  const zoomIn = doubleTapTarget({ ...box, x: 200, y: 400, scale: 1 });
  assert.deepEqual(zoomIn, { scale: DOUBLE_TAP_SCALE, x: 0, y: 0 });
  const edge = doubleTapTarget({ ...box, x: 0, y: 0, scale: 1 });
  assert.equal(edge.scale, DOUBLE_TAP_SCALE); assert.equal(edge.x, 400 * (DOUBLE_TAP_SCALE - 1) / 2); assert.equal(edge.y, 800 * (DOUBLE_TAP_SCALE - 1) / 2);
  assert.deepEqual(doubleTapTarget({ ...box, x: 10, y: 10, scale: 2.5 }), { scale: MIN_SCALE, x: 0, y: 0 });
  assert.deepEqual(doubleTapTarget({ ...box, x: 10, y: 10, scale: 1.3 }), { scale: MIN_SCALE, x: 0, y: 0 });
});
