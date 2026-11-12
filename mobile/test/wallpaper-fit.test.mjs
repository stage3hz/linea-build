import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FIT_MAX, clampFit, coverSize, storedFit } from '../src/wallpaperFit.ts';

// «Обои чатов»: your own picture is fitted with the fingers; no edge of it may ever show.
const W = 390, H = 844;

test('at zoom 1 the picture covers the screen whatever its shape', () => {
  assert.deepEqual(coverSize(W / H, W, H), { width: W, height: H });
  const wide = coverSize(16 / 9, W, H);
  assert.equal(wide.height, H);
  assert.ok(wide.width > W);
  const tall = coverSize(0.3, W, H);
  assert.equal(tall.width, W);
  assert.ok(tall.height > H);
  assert.deepEqual(coverSize(0, W, H), { width: W, height: H }, 'an unknown shape fills the screen (older wallpapers)');
});

test('the picture is never moved so far that the screen behind shows', () => {
  // A landscape photo: free to move sideways over its overflow, not at all up or down.
  const wide = coverSize(16 / 9, W, H), maxX = (wide.width - W) / 2 / W;
  assert.deepEqual(clampFit({ zoom: 1, fx: 9, fy: 9 }, 16 / 9, W, H), { zoom: 1, fx: maxX, fy: 0 });
  assert.deepEqual(clampFit({ zoom: 1, fx: -9, fy: -9 }, 16 / 9, W, H), { zoom: 1, fx: -maxX, fy: -0 });
  // Zoomed in twice there is half a screen of travel more in each direction.
  const zoomed = clampFit({ zoom: 2, fx: 9, fy: 9 }, W / H, W, H);
  assert.deepEqual(zoomed, { zoom: 2, fx: 0.5, fy: 0.5 });
  // Whatever is asked, the drawn picture still covers every edge.
  for (const fit of [{ zoom: 1.7, fx: 0.4, fy: -3 }, { zoom: 4, fx: -8, fy: 8 }, { zoom: 1, fx: 0.2, fy: 0.2 }]) for (const aspect of [0.4, W / H, 1, 2.2]) {
    const c = clampFit(fit, aspect, W, H), cover = coverSize(aspect, W, H);
    const left = W / 2 + c.fx * W - cover.width * c.zoom / 2, top = H / 2 + c.fy * H - cover.height * c.zoom / 2;
    assert.ok(left <= 1e-6 && left + cover.width * c.zoom >= W - 1e-6 && top <= 1e-6 && top + cover.height * c.zoom >= H - 1e-6, JSON.stringify({ fit, aspect }));
  }
});

test('the zoom stays within 1…4 and nonsense values are read as «not fitted»', () => {
  assert.equal(clampFit({ zoom: 0.2 }, 1, W, H).zoom, 1);
  assert.equal(clampFit({ zoom: 99 }, 1, W, H).zoom, FIT_MAX);
  assert.deepEqual(clampFit(null, 1, W, W), { zoom: 1, fx: 0, fy: 0 });
  assert.deepEqual(clampFit({ zoom: NaN, fx: Infinity, fy: 'x' }, 1, W, W), { zoom: 1, fx: 0, fy: 0 });
  assert.deepEqual(clampFit({ zoom: 2, fx: 1, fy: 1 }, 1, 0, 0), { zoom: 2, fx: 0, fy: 0 }, 'before the area is measured nothing is moved');
  assert.deepEqual(storedFit({ zoom: '3', fx: null, aspect: -1 }), { zoom: 1, fx: 0, fy: 0, aspect: 0 });
  assert.deepEqual(storedFit({ zoom: 2.5, fx: 0.25, fy: -0.5, aspect: 1.5 }), { zoom: 2.5, fx: 0.25, fy: -0.5, aspect: 1.5 });
  assert.deepEqual(storedFit(undefined), { zoom: 1, fx: 0, fy: 0, aspect: 0 });
});

test('the preview opens only after the list of wallpapers has closed; the picture is fitted in the preview', () => {
  const picker = readFileSync(new URL('../src/WallpaperPicker.tsx', import.meta.url), 'utf8');
  // Two native windows at the same moment: on the iPhone the second one never appeared.
  assert.ok(picker.includes("<Sheet visible={visible && !draft && stage === 'list'}"));
  assert.ok(picker.includes("{draft && stage === 'preview' ? <WallpaperPreview"));
  assert.ok(picker.includes("onClosed={() => { if (draft) setStage('preview'); }}"));
  assert.ok(picker.includes('const fitting = Gesture.Simultaneous(drag, pinch);'));
  assert.ok(picker.includes('useSwipeDismiss({ onDismiss: onCancel, enabled: !image })'), 'a drag moves the picture, it does not close the preview');
  assert.ok(picker.includes("aspect: small.width > 0 && small.height > 0 ? small.width / small.height : 0, zoom: 1, fx: 0, fy: 0"));
  assert.ok(readFileSync(new URL('../src/wallpapers.ts', import.meta.url), 'utf8').includes('...storedFit(item)'), 'the fit is kept with the wallpaper');
});
