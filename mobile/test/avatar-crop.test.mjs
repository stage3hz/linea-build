import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarCrop, clampOffset, coverScale } from '../src/photo/avatarCrop.ts';

test('avatar crop: no pan or zoom takes the centred square of the shorter side', () => {
  assert.deepEqual(avatarCrop({ width: 4000, height: 3000, viewport: 300, zoom: 1, tx: 0, ty: 0 }), { originX: 500, originY: 0, width: 3000, height: 3000 });
});

test('avatar crop: moving the photo right shows its left part; zoom 2× takes half the side', () => {
  // cover scale 0.1 pt/px; photo moved right by 50 pt = 500 px of the source.
  assert.equal(coverScale(4000, 3000, 300), 0.1);
  assert.deepEqual(avatarCrop({ width: 4000, height: 3000, viewport: 300, zoom: 1, tx: 50, ty: 0 }), { originX: 0, originY: 0, width: 3000, height: 3000 });
  assert.deepEqual(avatarCrop({ width: 4000, height: 3000, viewport: 300, zoom: 2, tx: 0, ty: 0 }), { originX: 1250, originY: 750, width: 1500, height: 1500 });
});

test('avatar crop: the circle never leaves the photo', () => {
  const c = clampOffset({ width: 4000, height: 3000, viewport: 300, zoom: 1, tx: 999, ty: -999 }); assert.equal(c.tx, 50); assert.equal(c.ty + 0, 0);
  const r = avatarCrop({ width: 1080, height: 1920, viewport: 320, zoom: 3, tx: -9999, ty: 9999 });
  assert.ok(r.originX >= 0 && r.originY >= 0 && r.originX + r.width <= 1080 && r.originY + r.height <= 1920);
});
