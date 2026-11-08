import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  renderPlan, mapPoint, unmapPoint, sourceToOutput, previewLayout, viewportToSource, sourceToViewport, orientedSize,
  rotateLeft, rotateCropLeft, flipCrop, clipPolyline, round6, ROTATIONS,
} from '../src/photo/geometry.ts';
import { photoSizePlan } from '../src/photo/editorModel.ts';

const golden = JSON.parse(readFileSync(new URL('./fixtures/geometry-cases.json', import.meta.url), 'utf8'));
const r6 = point => ({ x: round6(point.x), y: round6(point.y) });

test('golden table: plan sizes, decode sizes and crop bounds match the shared formula', () => {
  assert.ok(golden.cases.length >= 100);
  for (const item of golden.cases) {
    const plain = item.scale === 1 && !item.effects;
    const plan = renderPlan(item.source, { rotation: item.rotation, crop: item.crop ?? undefined, resolution: item.resolution, scale: item.scale, plain });
    assert.deepEqual({ crop: plan.crop, width: plan.baseWidth, height: plan.baseHeight, downsampled: plan.downsampled, decodeWidth: plan.decodeWidth, decodeHeight: plan.decodeHeight, cropSourceTooLarge: plan.cropSourceTooLarge }, item.expected, JSON.stringify(item));
    for (const point of item.points) {
      assert.deepEqual(r6(mapPoint(point.source, item.rotation, item.flip)), point.rotated);
      assert.deepEqual(r6(sourceToOutput(point.source, item.source, { rotation: item.rotation, flip: item.flip }, item.crop ?? undefined)), point.output);
    }
  }
});

test('golden spot checks were verified by hand', () => {
  const plan = renderPlan({ width: 4000, height: 3000 }, { rotation: 90, crop: { x: .1, y: .2, width: .5, height: .5 }, scale: 1, plain: true });
  assert.deepEqual(plan.crop, { x: 300, y: 800, width: 1500, height: 2000 });
  assert.equal(plan.decodeWidth, 3000); assert.equal(plan.decodeHeight, 4000);
  assert.deepEqual(mapPoint({ x: 0, y: 0 }, 90, false), { x: 1, y: 0 });
  assert.deepEqual(mapPoint({ x: 0, y: 0 }, 90, true), { x: 0, y: 0 });
});

test('mapPoint and unmapPoint are inverse for every rotation and mirror', () => {
  for (const rotation of ROTATIONS) for (const flip of [false, true]) for (const point of [{ x: .1, y: .7 }, { x: 0, y: 1 }, { x: .5, y: .5 }]) {
    assert.deepEqual(r6(unmapPoint(mapPoint(point, rotation, flip), rotation, flip)), r6(point));
  }
});

test('photoSizePlan of the editor model agrees with the native plan including rotation', () => {
  const caps = { maxPlainPixels: 16000000, maxProcessingPixels: 4000000, maxOutputPixels: 8000000 };
  for (const item of golden.cases) {
    const options = { background: 'keep', document: item.effects ? 'color' : 'none', scale: item.scale, strokes: [], resolution: item.resolution, crop: item.crop ?? undefined, rotation: item.rotation };
    const plan = photoSizePlan(item.source, options, caps);
    assert.equal(plan.baseWidth, item.expected.width); assert.equal(plan.baseHeight, item.expected.height);
  }
});

test('preview layout: 4 rotations x mirror place the crop window and round-trip touch points', () => {
  const source = { width: 400, height: 200 }, viewport = { width: 300, height: 300 };
  for (const rotation of ROTATIONS) for (const flip of [false, true]) {
    const transform = { rotation, flip }, crop = { x: .25, y: .25, width: .5, height: .5 };
    const layout = previewLayout(source, transform, crop, viewport);
    const rotated = orientedSize(source, rotation);
    assert.ok(Math.abs(layout.window.width / layout.window.height - rotated.width / rotated.height) < 1e-9);
    assert.ok(layout.window.x >= 0 && layout.window.y >= 0 && layout.window.width <= 300.000001 && layout.window.height <= 300.000001);
    assert.equal(layout.scaleX, flip ? -1 : 1); assert.equal(layout.rotation, rotation);
    // The image box is centred in the rotated box, so a rotation about its centre fills it exactly.
    assert.ok(Math.abs(layout.image.x * 2 + layout.image.width - layout.rotated.width) < 1e-9);
    const point = { x: .4, y: .6 }, screen = sourceToViewport(point, layout, transform);
    assert.deepEqual(r6(viewportToSource(screen, layout, transform)), r6(point));
    assert.equal(viewportToSource({ x: layout.window.x - 5, y: layout.window.y }, layout, transform), null);
    assert.ok(viewportToSource({ x: layout.window.x - 5, y: layout.window.y }, layout, transform, true));
  }
  assert.equal(previewLayout({ width: 0, height: 1 }, { rotation: 0, flip: false }, undefined, viewport), null);
});

test('rotating left turns the screen counter-clockwise, mirrored photos included, and the crop follows', () => {
  for (const flip of [false, true]) {
    let transform = { rotation: 0, flip };
    const point = { x: .2, y: .1 }, before = mapPoint(point, transform.rotation, flip);
    transform = rotateLeft(transform);
    const after = mapPoint(point, transform.rotation, flip);
    // A counter-clockwise screen turn maps (x, y) to (y, 1 - x).
    assert.deepEqual(r6(after), r6({ x: before.y, y: 1 - before.x }));
  }
  const turned = rotateCropLeft({ x: .1, y: .2, width: .3, height: .4 });
  assert.deepEqual([turned.x, turned.y, turned.width, turned.height].map(round6), [.2, .6, .4, .3]);
  let crop = { x: .1, y: .2, width: .3, height: .4 };
  for (let i = 0; i < 4; i++) crop = rotateCropLeft(crop);
  assert.deepEqual(r6({ x: crop.x, y: crop.y }), { x: .1, y: .2 });
  const mirrored = flipCrop({ x: .1, y: .2, width: .3, height: .4 });
  assert.deepEqual([mirrored.x, mirrored.y].map(round6), [.6, .2]);
});

test('polylines crossing the crop are split at its expanded edge; outside strokes vanish', () => {
  assert.deepEqual(clipPolyline([{ x: -5, y: .5 }, { x: .5, y: .5 }], .1).map(run => run.map(r6)), [[{ x: -.1, y: .5 }, { x: .5, y: .5 }]]);
  const runs = clipPolyline([{ x: .5, y: .5 }, { x: 3, y: .5 }, { x: 3, y: .6 }, { x: .5, y: .6 }], 0);
  assert.equal(runs.length, 2);
  assert.deepEqual(clipPolyline([{ x: 4, y: 4 }], 0), []);
  assert.deepEqual(clipPolyline([{ x: .3, y: .3 }], 0), [[{ x: .3, y: .3 }]]);
});

test('crop frame: handles, aspect lock and bounds', async () => {
  const { hitCrop, cropDrag, centeredAspectCrop } = await import('../src/photo/geometry.ts');
  const crop = { x: .2, y: .2, width: .6, height: .6 }, tolerance = { x: .05, y: .05 };
  assert.equal(hitCrop({ x: .21, y: .19 }, crop, tolerance), 'nw');
  assert.equal(hitCrop({ x: .79, y: .81 }, crop, tolerance), 'se');
  assert.equal(hitCrop({ x: .5, y: .5 }, crop, tolerance), 'move');
  assert.equal(hitCrop({ x: .05, y: .5 }, crop, tolerance), 'new');
  const moved = cropDrag('move', { x: .5, y: .5 }, { x: .9, y: .5 }, crop, null, { width: 100, height: 100 });
  assert.deepEqual([moved.x, moved.width].map(round6), [.4, .6]);
  const square = cropDrag('se', { x: .8, y: .8 }, { x: 1, y: .9 }, crop, 1, { width: 200, height: 100 });
  assert.ok(Math.abs(square.width * 200 - square.height * 100) < 1e-6, 'pixel aspect 1:1');
  assert.equal(cropDrag('new', { x: .5, y: .5 }, { x: .51, y: .51 }, crop, null, { width: 100, height: 100 }), null);
  const preset = centeredAspectCrop({ width: 4000, height: 3000 }, 1);
  assert.deepEqual([preset.width * 4000, preset.height * 3000].map(Math.round), [3000, 3000]);
  assert.equal(centeredAspectCrop({ width: 4000, height: 3000 }, 4 / 3), undefined);
});
