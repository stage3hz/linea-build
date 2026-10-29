import assert from 'node:assert/strict';
import test from 'node:test';
import { containRect, normalizedPoint, boundedPoint, centeredCrop, cropFromDrag, cropPixelBounds, photoSizePlan, appendBrushPoint } from '../src/photo/editorModel.ts';
import { isPhotoCandidate } from '../src/photo/formats.ts';
import { PreviewSession } from '../src/photo/PreviewSession.ts';

const caps = { maxPlainPixels: 16000000, maxProcessingPixels: 4000000, maxOutputPixels: 8000000 };
const plain = { background: 'keep', document: 'none', scale: 1, strokes: [], allowDownsample: false };

test('landscape preview maps the visible photograph, excluding letterbox gutters', () => {
  const rect = containRect({ width: 4000, height: 2000 }, { width: 300, height: 300 });
  assert.deepEqual(rect, { x: 0, y: 75, width: 300, height: 150 });
  assert.equal(normalizedPoint({ x: 150, y: 74 }, rect), null);
  assert.deepEqual(normalizedPoint({ x: 150, y: 150 }, rect), { x: .5, y: .5 });
  assert.deepEqual(normalizedPoint({ x: 300, y: 225 }, rect), { x: 1, y: 1 });
});

test('portrait preview preserves aspect ratio and rejects invalid coordinates', () => {
  const rect = containRect({ width: 1000, height: 2000 }, { width: 300, height: 200 });
  assert.deepEqual(rect, { x: 100, y: 0, width: 100, height: 200 });
  assert.equal(normalizedPoint({ x: 50, y: 100 }, rect), null);
  assert.equal(normalizedPoint({ x: NaN, y: 100 }, rect), null);
  assert.equal(containRect({ width: 0, height: 2000 }, { width: 300, height: 200 }), null);
});

test('dragging a crop in reverse or beyond the photograph keeps a valid normalized frame', () => {
  const rect = containRect({ width: 4000, height: 2000 }, { width: 300, height: 300 });
  assert.deepEqual(boundedPoint({ x: 500, y: 10 }, rect), { x: 1, y: 0 });
  const crop = cropFromDrag({ x: .75, y: .8 }, { x: .25, y: .2 });
  assert.equal(crop.x, .25); assert.equal(crop.y, .2); assert.equal(crop.width, .5);
  assert.ok(Math.abs(crop.height - .6) < 1e-12);
  assert.equal(cropFromDrag({ x: .5, y: .5 }, { x: .501, y: .9 }), null);
  assert.equal(cropFromDrag({ x: NaN, y: .5 }, { x: .1, y: .9 }), null);
});

test('portrait crop presets describe pixel aspect ratio rather than normalized-coordinate aspect ratio', () => {
  const source = { width: 2000, height: 4000 };
  const crop = centeredCrop(source, 4 / 3);
  assert.deepEqual(crop, { x: 0, y: .3125, width: 1, height: .375 });
  assert.deepEqual(cropPixelBounds(source, crop), { x: 0, y: 1250, width: 2000, height: 1500 });
});

test('plain PNG keeps 12 MP; effects explicitly predict the reduced source and output', () => {
  const size = { width: 4000, height: 3000 };
  assert.deepEqual(photoSizePlan(size, plain, caps), { width: 4000, height: 3000, baseWidth: 4000, baseHeight: 3000, downsampled: false });
  assert.deepEqual(photoSizePlan(size, { ...plain, document: 'color' }, caps), { width: 2309, height: 1732, baseWidth: 2309, baseHeight: 1732, downsampled: true });
  assert.deepEqual(photoSizePlan({ width: 8000, height: 6000 }, plain, caps), { width: 4618, height: 3464, baseWidth: 4618, baseHeight: 3464, downsampled: true });
});

test('2x scaling describes the reduced processing base when the output cap applies', () => {
  const plan = photoSizePlan({ width: 2000, height: 2000 }, { ...plain, scale: 2 }, caps);
  assert.deepEqual(plan, { width: 2828, height: 2828, baseWidth: 1414, baseHeight: 1414, downsampled: true });
  assert.ok(plan.width * plan.height <= caps.maxOutputPixels);
  assert.deepEqual(photoSizePlan({ width: 800, height: 600 }, { ...plain, scale: 2 }, caps), { width: 1600, height: 1200, baseWidth: 800, baseHeight: 600, downsampled: false });
});

test('cropping uses outward pixel bounds before halving each side', () => {
  const plan = photoSizePlan({ width: 4033, height: 3025 }, {
    ...plain, crop: { x: .1, y: .2, width: .5, height: .5 }, resolution: .5,
  }, caps);
  assert.deepEqual(plan, { width: 1008, height: 756, baseWidth: 1008, baseHeight: 756, downsampled: false });
});

test('explicit 50% resolution is not hidden downsampling and precedes 2x enlargement', () => {
  const plan = photoSizePlan({ width: 1600, height: 1200 }, { ...plain, resolution: .5, scale: 2 }, caps);
  assert.deepEqual(plan, { width: 1600, height: 1200, baseWidth: 800, baseHeight: 600, downsampled: false });
});

test('4x enlargement respects the output cap and requests further reduction consent', () => {
  const plan = photoSizePlan({ width: 2000, height: 2000 }, { ...plain, scale: 4 }, caps);
  assert.deepEqual(plan, { width: 2828, height: 2828, baseWidth: 707, baseHeight: 707, downsampled: true });
});

test('image MIME and photo extensions from the file picker enter the editor', () => {
  assert.equal(isPhotoCandidate({ name: 'scan.PnG', mimeType: 'application/octet-stream' }), true);
  assert.equal(isPhotoCandidate({ name: 'unknown', mimeType: 'image/heic' }), true);
  assert.equal(isPhotoCandidate({ name: 'invoice.pdf', mimeType: 'application/pdf' }), false);
  assert.equal(isPhotoCandidate({ name: 'photo.jpg.exe', mimeType: 'application/octet-stream' }), false);
});

test('brush sampling avoids redundant points and respects the UI point budget', () => {
  const first = [{ x: .5, y: .5 }];
  assert.equal(appendBrushPoint(first, { x: .5001, y: .5001 }, .025, 10), first);
  assert.deepEqual(appendBrushPoint(first, { x: .6, y: .6 }, .025, 10), [...first, { x: .6, y: .6 }]);
  assert.equal(appendBrushPoint(first, { x: .6, y: .6 }, .025, 1), first);
});

function output(id, removed) { return { id, dispose: async () => { removed.push(id); } }; }

test('a result for previous settings is disposed and cannot be submitted', async () => {
  const removed = [], session = new PreviewSession();
  const revision = session.revision;
  session.revise();
  assert.equal(session.accept(revision, output('old', removed)), false);
  assert.equal(session.acquire(), null);
  await session.drain();
  assert.deepEqual(removed, ['old']);
});

test('closing during rendering disposes the eventual result instead of reviving the editor', async () => {
  const removed = [], session = new PreviewSession();
  const revision = session.revision;
  session.close();
  assert.equal(session.accept(revision, output('late', removed)), false);
  assert.equal(session.acquire(), null);
  await session.drain();
  assert.deepEqual(removed, ['late']);
});

test('an upload lease keeps the exact preview alive until the consumer finishes', async () => {
  const removed = [], session = new PreviewSession();
  const result = output('sending', removed);
  assert.equal(session.accept(session.revision, result), true);
  const lease = session.acquire();
  assert.equal(lease.value, result);
  session.close();
  await session.drain();
  assert.deepEqual(removed, []);
  lease.release();
  lease.release();
  await session.drain();
  assert.deepEqual(removed, ['sending']);
});

test('replacement and repeated close dispose each unleased preview once', async () => {
  const removed = [], session = new PreviewSession();
  session.accept(session.revision, output('first', removed));
  session.accept(session.revision, output('second', removed));
  session.close();
  session.close();
  await session.drain();
  assert.deepEqual(removed, ['first', 'second']);
});
