// Geometry for pinch/double-tap zoom of a photo (pure, covered by test/media-zoom.test.mjs).
// Every function is a worklet so the gesture handlers can call it on the UI thread.
export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
export const DOUBLE_TAP_SCALE = 2.5;

export function clampScale(scale: number): number {
  'worklet';
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The picture is centred and fills the box, so at `scale` it may move by half the overflow each way. */
export function clampOffset(offset: number, scale: number, size: number): number {
  'worklet';
  const max = Math.max(0, (size * (scale - 1)) / 2);
  if (!Number.isFinite(offset)) return 0;
  return Math.min(max, Math.max(-max, offset)) || 0;
}

/** New translation that keeps the point under the fingers (focal, in box coordinates) still while the scale changes. */
export function pinchTransform({ focalX, focalY, width, height, baseScale, baseX, baseY, scale }: {
  focalX: number; focalY: number; width: number; height: number; baseScale: number; baseX: number; baseY: number; scale: number;
}): { scale: number; x: number; y: number } {
  'worklet';
  const next = clampScale(scale);
  const fx = focalX - width / 2, fy = focalY - height / 2;
  // The content point under the fingers before the change, then placed back under them after it.
  const px = (fx - baseX) / baseScale, py = (fy - baseY) / baseScale;
  return { scale: next, x: clampOffset(fx - px * next, next, width), y: clampOffset(fy - py * next, next, height) };
}

/** Double tap: zoom in around the tapped point, or back to the whole picture when already zoomed. */
export function doubleTapTarget({ x, y, width, height, scale }: { x: number; y: number; width: number; height: number; scale: number }): { scale: number; x: number; y: number } {
  'worklet';
  if (scale > MIN_SCALE + 0.01) return { scale: MIN_SCALE, x: 0, y: 0 };
  const next = DOUBLE_TAP_SCALE;
  return { scale: next, x: clampOffset((width / 2 - x) * (next - 1), next, width), y: clampOffset((height / 2 - y) * (next - 1), next, height) };
}
