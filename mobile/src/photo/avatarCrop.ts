// Avatar crop (Telegram-style): the photo covers a round viewport of side `viewport`, the user pans
// (tx, ty = offset of the photo centre from the viewport centre, in screen points) and zooms (`zoom`
// ≥ 1 on top of the "cover" scale). Result: the square of the source image under the circle.

export type CropInput = { width: number; height: number; viewport: number; zoom: number; tx: number; ty: number };
export type CropRect = { originX: number; originY: number; width: number; height: number };

export const MAX_AVATAR_ZOOM = 5;

/** Scale at which the photo exactly covers the viewport (its shorter side fills it). */
export const coverScale = (width: number, height: number, viewport: number) => viewport / Math.min(width, height);

/** Largest offset that still keeps the viewport covered by the photo, for the given zoom. */
export function maxOffset(width: number, height: number, viewport: number, zoom: number): { x: number; y: number } {
  const s = coverScale(width, height, viewport) * zoom;
  return { x: Math.max(0, (width * s - viewport) / 2), y: Math.max(0, (height * s - viewport) / 2) };
}

export function clampOffset(input: CropInput): { tx: number; ty: number } {
  const m = maxOffset(input.width, input.height, input.viewport, input.zoom);
  return { tx: Math.max(-m.x, Math.min(m.x, input.tx)), ty: Math.max(-m.y, Math.min(m.y, input.ty)) };
}

export function avatarCrop(input: CropInput): CropRect {
  const zoom = Math.max(1, Math.min(MAX_AVATAR_ZOOM, input.zoom));
  const { tx, ty } = clampOffset({ ...input, zoom });
  const s = coverScale(input.width, input.height, input.viewport) * zoom; // source px → screen pt
  const side = Math.min(input.width, input.height, input.viewport / s);
  // The photo centre sits at (tx, ty) from the viewport centre, so the viewport centre is at
  // (−tx, −ty) from the photo centre, in screen points.
  let originX = input.width / 2 - tx / s - side / 2;
  let originY = input.height / 2 - ty / s - side / 2;
  originX = Math.max(0, Math.min(input.width - side, originX));
  originY = Math.max(0, Math.min(input.height - side, originY));
  return { originX: Math.round(originX), originY: Math.round(originY), width: Math.floor(side), height: Math.floor(side) };
}
