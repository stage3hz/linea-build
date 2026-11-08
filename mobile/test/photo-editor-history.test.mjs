import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reduce, createHistory, initialEditState, canUndo, canRedo, HISTORY_LIMIT, rotated, flipped, withCrop, withStroke, withDrawing,
  renderOptions, previewOptions, effectKey, isUnedited, losesHdr, sameEdit,
} from '../src/photo/editorHistory.ts';
import { mapPoint, sourceToOutput, round6 } from '../src/photo/geometry.ts';

const stroke = (x, y) => ({ radius: .02, points: [{ x, y }] });
const drawing = (x, y) => ({ color: '#FF3B30', width: .012, points: [{ x, y }, { x: x + .1, y }] });

test('commit, undo, redo and reset; every commit clears the redo list', () => {
  let h = createHistory();
  const a = withStroke(h.present, stroke(.1, .1));
  h = reduce(h, { type: 'commit', next: a });
  const b = withStroke(h.present, stroke(.2, .2));
  h = reduce(h, { type: 'commit', next: b });
  assert.equal(h.present.strokes.length, 2); assert.ok(canUndo(h)); assert.ok(!canRedo(h));
  h = reduce(h, { type: 'undo' });
  assert.equal(h.present, a); assert.ok(canRedo(h));
  h = reduce(h, { type: 'redo' });
  assert.equal(h.present, b);
  h = reduce(h, { type: 'undo' });
  h = reduce(h, { type: 'commit', next: rotated(h.present) });
  assert.ok(!canRedo(h), 'a new edit drops the redo branch');
  h = reduce(h, { type: 'reset' });
  assert.ok(isUnedited(h.present));
  h = reduce(h, { type: 'undo' });
  assert.equal(h.present.rotation, 270, 'reset is a step that can be undone');
  assert.equal(reduce(createHistory(), { type: 'undo' }).past.length, 0);
});

test('history keeps at most 50 steps', () => {
  let h = createHistory();
  for (let i = 0; i < 80; i++) h = reduce(h, { type: 'commit', next: withStroke(initialEditState(), stroke(i / 100, .5)) });
  assert.equal(h.past.length, HISTORY_LIMIT);
  let undone = 0;
  while (canUndo(h)) { h = reduce(h, { type: 'undo' }); undone++; }
  assert.equal(undone, HISTORY_LIMIT);
});

test('dragging a crop previews without history and commits one step on release', () => {
  let h = createHistory();
  for (const width of [.9, .8, .7]) h = reduce(h, { type: 'preview', next: withCrop(h.present, { x: 0, y: 0, width, height: 1 }) });
  assert.equal(h.past.length, 0); assert.equal(h.present.crop.width, .7);
  h = reduce(h, { type: 'commit', next: h.present });
  assert.equal(h.past.length, 1);
  h = reduce(h, { type: 'undo' });
  assert.equal(h.present.crop, undefined);
  h = reduce(h, { type: 'preview', next: withCrop(h.present, { x: .1, y: .1, width: .5, height: .5 }) });
  h = reduce(h, { type: 'cancelPreview' });
  assert.equal(h.present.crop, undefined); assert.equal(h.anchor, undefined);
});

test('past states are never mutated by later edits', () => {
  let h = createHistory();
  const first = withStroke(h.present, stroke(.3, .3));
  h = reduce(h, { type: 'commit', next: first });
  const snapshot = JSON.stringify(first);
  const input = drawing(.1, .1);
  h = reduce(h, { type: 'commit', next: withDrawing(h.present, input) });
  input.points[0].x = .9;
  h = reduce(h, { type: 'commit', next: rotated(flipped(h.present)) });
  assert.equal(JSON.stringify(first), snapshot);
  assert.equal(h.present.drawings[0].points[0].x, .1, 'a stroke is copied when committed');
});

test('rotation, mirror and crop keep the mask and drawings; their pixels follow the photo', () => {
  const source = { width: 4000, height: 3000 };
  let state = withDrawing(withStroke(initialEditState(), stroke(.25, .25)), drawing(.5, .5));
  state = withCrop(rotated(flipped(state)), { x: .1, y: .1, width: .8, height: .8 });
  assert.equal(state.strokes.length, 1); assert.equal(state.drawings.length, 1);
  const options = renderOptions(state, source);
  assert.equal(options.rotation, state.rotation); assert.equal(options.flip, true);
  const expected = sourceToOutput({ x: .25, y: .25 }, source, state, state.crop);
  assert.deepEqual({ x: round6(options.strokes[0].points[0].x), y: round6(options.strokes[0].points[0].y) }, { x: round6(expected.x), y: round6(expected.y) });
  // The mapped point in the rotated frame stays inside the photo.
  const rotatedPoint = mapPoint({ x: .25, y: .25 }, state.rotation, state.flip);
  assert.ok(rotatedPoint.x >= 0 && rotatedPoint.x <= 1);
  // Lengths are rescaled from min(source) to min(crop): 3000 → 0.8·3000 = 2400 px.
  assert.ok(Math.abs(options.strokes[0].radius - .02 * 3000 / 2400) < 1e-9);
  assert.equal(options.drawings[0].color, '#FF3B30');
});

test('strokes outside the crop are dropped from the final render request', () => {
  const state = withCrop(withStroke(initialEditState(), stroke(.05, .05)), { x: .5, y: .5, width: .5, height: .5 });
  assert.equal(renderOptions(state, { width: 1000, height: 1000 }).strokes.length, 0);
});

test('the effect preview has no geometry, is small and SDR; its cache key ignores geometry', () => {
  const state = withStroke({ ...initialEditState(), background: 'white' }, stroke(.4, .4));
  const preview = previewOptions(state, 9e9);
  assert.equal(preview.preview.maxPixels, 2000000); assert.equal(preview.dynamicRange, 'sdr');
  assert.equal(preview.crop, undefined); assert.equal(preview.rotation, undefined); assert.equal(preview.drawings, undefined);
  assert.equal(effectKey(state), effectKey(withCrop(rotated(state), { x: .1, y: .1, width: .5, height: .5 })));
  assert.notEqual(effectKey(state), effectKey({ ...state, document: 'bw', background: 'keep' }));
});

test('labelled SDR modes and explicit consent reach the render options', () => {
  assert.ok(losesHdr({ background: 'transparent', document: 'none', format: 'jpeg' }));
  assert.ok(losesHdr({ background: 'keep', document: 'bw', format: 'jpeg' }));
  assert.ok(!losesHdr({ background: 'white', document: 'none', format: 'jpeg' }));
  assert.equal(renderOptions(initialEditState('jpeg'), { width: 10, height: 10 }).dynamicRange, undefined);
  assert.equal(renderOptions({ ...initialEditState('jpeg'), dynamicRange: 'sdr' }, { width: 10, height: 10 }).dynamicRange, 'sdr');
  assert.ok(sameEdit(withCrop(initialEditState(), { x: 0, y: 0, width: 1, height: 1 }), initialEditState()));
});

test('the new editor has undo/redo and reset with Russian labels and no «apply first» step', async () => {
  const { readFileSync } = await import('node:fs');
  const read = name => readFileSync(new URL(`../src/photo/${name}`, import.meta.url), 'utf8');
  const screen = read('editor/PhotoEditorScreen.tsx'), panels = read('editor/EditorPanels.tsx'), canvas = read('editor/EditorCanvas.tsx');
  const all = screen + panels + canvas + read('PhotoEditor.tsx');
  assert.equal(/Сначала примени|Применить и посмотреть/.test(all), false);
  for (const label of ['Отменить действие', 'Повторить действие', 'Сбросить все изменения', 'Отправить фото'])
    assert.ok(screen.includes(`accessibilityLabel="${label}"`) || screen.includes(label), label);
  for (const tab of ['Обрезка', 'Рисование', 'Убрать объект', 'Фон', 'Улучшить', 'Размер и формат']) assert.ok(panels.includes(`label: '${tab}'`), tab);
  assert.ok(panels.includes('Повернуть на 90°') && panels.includes('Отразить'));
  // Every accessibilityLabel literal in the editor is Russian.
  for (const match of all.matchAll(/accessibilityLabel="([^"]+)"/g)) assert.match(match[1], /[а-яё]/i, match[1]);
  assert.ok(read('PhotoEditor.web.tsx').includes("from './editorHistory.ts'"), 'desktop uses the shared history');
});

test('a frame dragged back to its start is no step; a changed format is an edit', () => {
  let h = createHistory();
  h = reduce(h, { type: 'preview', next: withCrop(h.present, { x: .1, y: .1, width: .5, height: .5 }) });
  h = reduce(h, { type: 'commit', next: { ...initialEditState() } });
  assert.equal(h.past.length, 0);
  assert.equal(isUnedited({ ...initialEditState('jpeg'), format: 'png' }, 'jpeg'), false);
  assert.equal(isUnedited(initialEditState('jpeg'), 'jpeg'), true);
});
