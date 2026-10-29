import type { PhotoCapabilities, PhotoCrop, PhotoOptions } from '../../modules/linea-photo';

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rect = Size & Point;

export function containRect(image: Size, viewport: Size): Rect | null {
  const values = [image.width, image.height, viewport.width, viewport.height];
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return null;
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height);
  const width = image.width * scale, height = image.height * scale;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}

export function normalizedPoint(point: Point, rect: Rect | null): Point | null {
  if (!rect || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const x = (point.x - rect.x) / rect.width, y = (point.y - rect.y) / rect.height;
  return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
}

/** A drag can leave the photo; the frame stays inside its visible edges. */
export function boundedPoint(point: Point, rect: Rect | null): Point | null {
  if (!rect || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: Math.max(0, Math.min(1, (point.x - rect.x) / rect.width)), y: Math.max(0, Math.min(1, (point.y - rect.y) / rect.height)) };
}

export function cropFromDrag(start: Point, end: Point): PhotoCrop | null {
  const x = Math.max(0, Math.min(start.x, end.x)), y = Math.max(0, Math.min(start.y, end.y));
  const width = Math.min(1, Math.max(start.x, end.x)) - x;
  const height = Math.min(1, Math.max(start.y, end.y)) - y;
  if (![x, y, width, height].every(Number.isFinite) || width < .01 || height < .01) return null;
  return { x, y, width, height };
}

/** Matches native outward rounding in the oriented original. */
export function cropPixelBounds(size: Size, crop?: PhotoCrop): Rect {
  if (!crop) return { x: 0, y: 0, ...size };
  const x = Math.max(0, Math.min(size.width - 1, Math.floor(crop.x * size.width)));
  const y = Math.max(0, Math.min(size.height - 1, Math.floor(crop.y * size.height)));
  const right = Math.max(x + 1, Math.min(size.width, Math.ceil((crop.x + crop.width) * size.width)));
  const bottom = Math.max(y + 1, Math.min(size.height, Math.ceil((crop.y + crop.height) * size.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function centeredCrop(size: Size, aspect: number): PhotoCrop {
  const sourceAspect = size.width / size.height;
  const width = Math.min(1, aspect / sourceAspect), height = Math.min(1, sourceAspect / aspect);
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

export function photoSizePlan(size: Size, options: PhotoOptions, caps: Pick<PhotoCapabilities, 'maxPlainPixels' | 'maxProcessingPixels' | 'maxOutputPixels'>) {
  const crop = cropPixelBounds(size, options.crop);
  const resolution = options.resolution ?? 1;
  const width = Math.max(1, Math.floor(crop.width * resolution));
  const height = Math.max(1, Math.floor(crop.height * resolution));
  const isPlain = options.background === 'keep' && options.document === 'none' && options.scale === 1 && options.strokes.length === 0;
  const budget = isPlain ? caps.maxPlainPixels : Math.min(caps.maxProcessingPixels, caps.maxOutputPixels / (options.scale * options.scale));
  const ratio = Math.min(1, Math.sqrt(budget / (width * height)));
  const baseWidth = Math.max(1, Math.floor(width * ratio));
  const baseHeight = Math.max(1, Math.floor(height * ratio));
  return { width: baseWidth * options.scale, height: baseHeight * options.scale, baseWidth, baseHeight, downsampled: ratio < 1 };
}

export function appendBrushPoint(points: Point[], point: Point, radius: number, budget: number): Point[] {
  if (points.length >= budget) return points;
  const last = points[points.length - 1];
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < radius / 3) return points;
  return [...points, point];
}
