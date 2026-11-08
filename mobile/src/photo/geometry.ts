// Shared photo geometry: the editor preview, the desktop editor and the native renderers
// (PhotoDimensions.plan in Kotlin/Swift) follow the same formulas, checked by the golden table
// test/fixtures/geometry-cases.json in node and JVM tests.
//
// Frames:
//  - source:  the photo after its EXIF orientation (what PhotoInfo.width/height describe);
//  - rotated: source turned clockwise by `rotation`, then mirrored horizontally when `flip`;
//  - output:  the crop of the rotated frame, then resolution, pixel limits and scale.
// Brush masks and pen drawings are stored in normalized source coordinates, so rotating,
// flipping or cropping never wipes them; they are mapped to the output frame for rendering.

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rect = Size & Point;
export type Rotation = 0 | 90 | 180 | 270;
export type Crop = { x: number; y: number; width: number; height: number };
export type Transform = { rotation: Rotation; flip: boolean };

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

export function normalizeRotation(value: number): Rotation {
  const turned = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return turned as Rotation;
}

export function orientedSize(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}

/** Normalized source point → normalized rotated-frame point. */
export function mapPoint(point: Point, rotation: Rotation, flip: boolean): Point {
  let x: number, y: number;
  switch (rotation) {
    case 90: x = 1 - point.y; y = point.x; break;
    case 180: x = 1 - point.x; y = 1 - point.y; break;
    case 270: x = point.y; y = 1 - point.x; break;
    default: x = point.x; y = point.y;
  }
  return { x: flip ? 1 - x : x, y };
}

/** Normalized rotated-frame point → normalized source point (inverse of mapPoint). */
export function unmapPoint(point: Point, rotation: Rotation, flip: boolean): Point {
  const x = flip ? 1 - point.x : point.x, y = point.y;
  switch (rotation) {
    case 90: return { x: y, y: 1 - x };
    case 180: return { x: 1 - x, y: 1 - y };
    case 270: return { x: 1 - y, y: x };
    default: return { x, y };
  }
}

/** The screen turns 90° counter-clockwise (Telegram's rotate button). A mirrored photo turns the other way in source terms. */
export function rotateLeft(transform: Transform): Transform {
  return { rotation: normalizeRotation(transform.rotation + (transform.flip ? 90 : -90)), flip: transform.flip };
}

/** The crop frame follows a counter-clockwise screen rotation. */
export function rotateCropLeft(crop: Crop | undefined): Crop | undefined {
  if (!crop) return undefined;
  return { x: crop.y, y: 1 - crop.x - crop.width, width: crop.height, height: crop.width };
}

export function flipCrop(crop: Crop | undefined): Crop | undefined {
  if (!crop) return undefined;
  return { x: 1 - crop.x - crop.width, y: crop.y, width: crop.width, height: crop.height };
}

export function isFullCrop(crop: Crop | undefined): boolean {
  return !crop || (crop.x <= 1e-6 && crop.y <= 1e-6 && crop.width >= 1 - 1e-6 && crop.height >= 1 - 1e-6);
}

/** Outward pixel rounding of a normalized crop (same as native PhotoDimensions.plan). */
export function cropPixelBounds(size: Size, crop?: Crop): Rect {
  if (!crop) return { x: 0, y: 0, width: size.width, height: size.height };
  const x = Math.max(0, Math.min(size.width - 1, Math.floor(crop.x * size.width)));
  const y = Math.max(0, Math.min(size.height - 1, Math.floor(crop.y * size.height)));
  const right = Math.max(x + 1, Math.min(size.width, Math.ceil((crop.x + crop.width) * size.width)));
  const bottom = Math.max(y + 1, Math.min(size.height, Math.ceil((crop.y + crop.height) * size.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export type PlanInput = {
  rotation?: Rotation; crop?: Crop; resolution?: 1 | 0.5; scale: 1 | 2 | 4; plain: boolean; maxPixels?: number;
};
export type PlanLimits = { maxPlainPixels: number; maxProcessingPixels: number; maxOutputPixels: number };
export type RenderPlan = {
  crop: Rect; width: number; height: number; baseWidth: number; baseHeight: number; downsampled: boolean;
  /** Size the decoder is asked for, in the rotated frame, before the crop. */
  decodeWidth: number; decodeHeight: number;
  /** Exact crops decode the whole source; natives refuse that above 16 MP (CROP_SOURCE_TOO_LARGE). */
  cropSourceTooLarge: boolean;
};

export const DEFAULT_LIMITS: PlanLimits = { maxPlainPixels: 16_000_000, maxProcessingPixels: 4_000_000, maxOutputPixels: 8_000_000 };

/** Native PhotoDimensions.fit: floor(side·√(limit/pixels)), at least one pixel. */
export function fitPixels(width: number, height: number, limit: number): Size {
  const pixels = width * height;
  if (pixels <= limit) return { width, height };
  const scale = Math.sqrt(limit / pixels);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function renderPlan(source: Size, input: PlanInput, limits: PlanLimits = DEFAULT_LIMITS): RenderPlan {
  const rotated = orientedSize(source, input.rotation ?? 0);
  const crop = cropPixelBounds(rotated, input.crop);
  const resolution = input.resolution ?? 1;
  const requestedWidth = Math.max(1, Math.floor(crop.width * resolution));
  const requestedHeight = Math.max(1, Math.floor(crop.height * resolution));
  let limit = input.plain ? limits.maxPlainPixels : Math.min(limits.maxProcessingPixels, Math.floor(limits.maxOutputPixels / (input.scale * input.scale)));
  if (input.maxPixels !== undefined) limit = Math.min(limit, input.maxPixels);
  const fitted = fitPixels(requestedWidth, requestedHeight, limit);
  const downsampled = fitted.width !== requestedWidth || fitted.height !== requestedHeight;
  const full = crop.x === 0 && crop.y === 0 && crop.width === rotated.width && crop.height === rotated.height;
  return {
    crop, width: fitted.width * input.scale, height: fitted.height * input.scale, baseWidth: fitted.width, baseHeight: fitted.height, downsampled,
    decodeWidth: full ? fitted.width : rotated.width, decodeHeight: full ? fitted.height : rotated.height,
    cropSourceTooLarge: !full && rotated.width * rotated.height > 16_000_000,
  };
}

/** Layout of the live preview: the rotated photo is placed inside a clipping window of the crop size. */
export type PreviewLayout = {
  /** Visible window (crop), in viewport coordinates. */
  window: Rect;
  /** The whole rotated photo, relative to the window. */
  rotated: Rect;
  /** The unrotated source image box, relative to the rotated box; turned by `rotation` and mirrored by `scaleX` around its centre. */
  image: Rect;
  rotation: Rotation;
  scaleX: 1 | -1;
  scale: number;
};

export function previewLayout(source: Size, transform: Transform, crop: Crop | undefined, viewport: Size): PreviewLayout | null {
  const values = [source.width, source.height, viewport.width, viewport.height];
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return null;
  const rotated = orientedSize(source, transform.rotation);
  const frame = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const cropWidth = rotated.width * frame.width, cropHeight = rotated.height * frame.height;
  const scale = Math.min(viewport.width / cropWidth, viewport.height / cropHeight);
  const window = { width: cropWidth * scale, height: cropHeight * scale, x: 0, y: 0 };
  window.x = (viewport.width - window.width) / 2; window.y = (viewport.height - window.height) / 2;
  const box = { x: -frame.x * rotated.width * scale, y: -frame.y * rotated.height * scale, width: rotated.width * scale, height: rotated.height * scale };
  const imageWidth = source.width * scale, imageHeight = source.height * scale;
  return {
    window, rotated: box,
    image: { x: (box.width - imageWidth) / 2, y: (box.height - imageHeight) / 2, width: imageWidth, height: imageHeight },
    rotation: transform.rotation, scaleX: transform.flip ? -1 : 1, scale,
  };
}

/** Viewport point → normalized source point through a preview layout (null outside the window). */
export function viewportToSource(point: Point, layout: PreviewLayout, transform: Transform, bounded = false): Point | null {
  let x = (point.x - layout.window.x - layout.rotated.x) / layout.rotated.width;
  let y = (point.y - layout.window.y - layout.rotated.y) / layout.rotated.height;
  if (![x, y].every(Number.isFinite)) return null;
  const left = -layout.rotated.x / layout.rotated.width, top = -layout.rotated.y / layout.rotated.height;
  const right = left + layout.window.width / layout.rotated.width, bottom = top + layout.window.height / layout.rotated.height;
  if (bounded) { x = Math.max(left, Math.min(right, x)); y = Math.max(top, Math.min(bottom, y)); }
  else if (x < left - 1e-9 || y < top - 1e-9 || x > right + 1e-9 || y > bottom + 1e-9) return null;
  return unmapPoint({ x, y }, transform.rotation, transform.flip);
}

/** Normalized source point → viewport point through a preview layout. */
export function sourceToViewport(point: Point, layout: PreviewLayout, transform: Transform): Point {
  const rotated = mapPoint(point, transform.rotation, transform.flip);
  return { x: layout.window.x + layout.rotated.x + rotated.x * layout.rotated.width, y: layout.window.y + layout.rotated.y + rotated.y * layout.rotated.height };
}

/** Source-normalized point → output-normalized point (0…1 inside the crop). */
export function sourceToOutput(point: Point, source: Size, transform: Transform, crop?: Crop): Point {
  const rotated = orientedSize(source, transform.rotation), bounds = cropPixelBounds(rotated, crop);
  const p = mapPoint(point, transform.rotation, transform.flip);
  return { x: (p.x * rotated.width - bounds.x) / bounds.width, y: (p.y * rotated.height - bounds.y) / bounds.height };
}

/** A length relative to min(source side) → relative to min(output crop side). Rotation keeps pixel lengths. */
export function sourceLengthToOutput(length: number, source: Size, transform: Transform, crop?: Crop): number {
  const bounds = cropPixelBounds(orientedSize(source, transform.rotation), crop);
  return length * Math.min(source.width, source.height) / Math.min(bounds.width, bounds.height);
}

/** Liang–Barsky clip of a segment to an axis-aligned box. */
function clipSegment(a: Point, b: Point, min: number, max: number): [Point, Point] | null {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const checks: [number, number][] = [[-dx, a.x - min], [dx, max - a.x], [-dy, a.y - min], [dy, max - a.y]];
  for (const [p, q] of checks) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}

const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12;

/** Splits an output-space polyline into runs that stay within [-margin, 1+margin]. */
export function clipPolyline(points: Point[], margin: number): Point[][] {
  const min = -margin, max = 1 + margin, inside = (p: Point) => p.x >= min && p.x <= max && p.y >= min && p.y <= max;
  if (points.length === 1) return inside(points[0]) ? [[points[0]]] : [];
  const runs: Point[][] = [];
  let current: Point[] = [];
  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegment(points[i - 1], points[i], min, max);
    if (!clipped) { if (current.length) runs.push(current); current = []; continue; }
    const [start, end] = clipped;
    if (!current.length || !samePoint(current[current.length - 1], start)) { if (current.length) runs.push(current); current = [start]; }
    current.push(end);
    if (!samePoint(end, points[i])) { runs.push(current); current = []; }
  }
  if (current.length) runs.push(current);
  return runs;
}

export const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

// ---- Crop frame dragging (mobile and desktop editors) ----

export type CropHandle = 'nw' | 'ne' | 'sw' | 'se' | 'move' | 'new';
export const MIN_CROP = 0.04;
const FULL: Crop = { x: 0, y: 0, width: 1, height: 1 };

/** Which part of the frame a touch grabs; `tolerance` is in normalized units per axis. */
export function hitCrop(point: Point, crop: Crop | undefined, tolerance: Point): CropHandle {
  const c = crop ?? FULL, near = (a: number, b: number, t: number) => Math.abs(a - b) < t;
  const left = near(point.x, c.x, tolerance.x), right = near(point.x, c.x + c.width, tolerance.x);
  const top = near(point.y, c.y, tolerance.y), bottom = near(point.y, c.y + c.height, tolerance.y);
  if (left && top) return 'nw'; if (right && top) return 'ne'; if (left && bottom) return 'sw'; if (right && bottom) return 'se';
  return point.x > c.x && point.x < c.x + c.width && point.y > c.y && point.y < c.y + c.height ? 'move' : 'new';
}

/** Keeps a pixel aspect ratio (width / height of the rotated photo's pixels) anchored at the opposite corner. */
function withAspect(crop: Crop, anchor: CropHandle, aspect: number | null, rotated: Size): Crop {
  if (!aspect) return crop;
  const target = aspect * rotated.height / rotated.width; // normalized width / height
  let { width, height } = crop;
  if (width / height > target) width = height * target; else height = width / target;
  const x = anchor === 'nw' || anchor === 'sw' ? crop.x + crop.width - width : crop.x;
  const y = anchor === 'nw' || anchor === 'ne' ? crop.y + crop.height - height : crop.y;
  return { x, y, width, height };
}

const clamp01 = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The frame after a drag from `start` to `point` (normalized rotated frame); null when it would be invalid. */
export function cropDrag(handle: CropHandle, start: Point, point: Point, initial: Crop | undefined, aspect: number | null, rotated: Size): Crop | null {
  const c = initial ?? FULL, p = { x: clamp01(point.x, 0, 1), y: clamp01(point.y, 0, 1) };
  let next: Crop;
  if (handle === 'move') next = { ...c, x: clamp01(c.x + p.x - start.x, 0, 1 - c.width), y: clamp01(c.y + p.y - start.y, 0, 1 - c.height) };
  else if (handle === 'new') next = withAspect({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) }, 'se', aspect, rotated);
  else {
    const left = handle === 'nw' || handle === 'sw' ? p.x : c.x, right = handle === 'ne' || handle === 'se' ? p.x : c.x + c.width;
    const top = handle === 'nw' || handle === 'ne' ? p.y : c.y, bottom = handle === 'sw' || handle === 'se' ? p.y : c.y + c.height;
    next = withAspect({ x: Math.min(left, right), y: Math.min(top, bottom), width: Math.abs(right - left), height: Math.abs(bottom - top) }, handle, aspect, rotated);
  }
  if (next.width < MIN_CROP || next.height < MIN_CROP || next.x < -1e-9 || next.y < -1e-9 || next.x + next.width > 1.0001 || next.y + next.height > 1.0001) return null;
  return { x: Math.max(0, next.x), y: Math.max(0, next.y), width: Math.min(next.width, 1 - Math.max(0, next.x)), height: Math.min(next.height, 1 - Math.max(0, next.y)) };
}

/** A centred frame with a pixel aspect ratio in the rotated photo. */
export function centeredAspectCrop(rotated: Size, aspect: number): Crop | undefined {
  const target = aspect * rotated.height / rotated.width;
  const width = target > 1 ? 1 : target, height = target > 1 ? 1 / target : 1;
  return width >= 0.9999 && height >= 0.9999 ? undefined : { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}
