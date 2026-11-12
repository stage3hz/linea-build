// How the user's own picture is fitted to the chat (Обои чатов › предпросмотр): pinch to zoom, drag to choose the
// part that shows. Pure maths — the drawing is in WallpaperPicker.tsx.
//  - `aspect`: the picture's width / height;
//  - `zoom`: 1 (the picture just covers the screen) … FIT_MAX;
//  - `fx`, `fy`: how far the picture is moved from the centre, as a share of the screen's width / height
//    (so the same choice looks the same on another screen size or after a rotation).
export const FIT_MAX = 4;
export type WallpaperFit = { zoom: number; fx: number; fy: number };
export const NO_FIT: WallpaperFit = { zoom: 1, fx: 0, fy: 0 };

const finite = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The size the picture is drawn at to cover a `width` × `height` screen at zoom 1 (nothing of the screen is bare). */
export function coverSize(aspect: number, width: number, height: number): { width: number; height: number } {
  'worklet';
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : width / height;
  return a > width / height ? { width: height * a, height } : { width, height: width / a };
}

/** The fit kept inside its limits: the zoom within 1…FIT_MAX, the picture never moved so far that an edge shows. */
export function clampFit(fit: Partial<WallpaperFit> | null | undefined, aspect: number, width: number, height: number): WallpaperFit {
  'worklet';
  const zoom = Math.min(FIT_MAX, Math.max(1, typeof fit?.zoom === 'number' && Number.isFinite(fit.zoom) ? fit.zoom : 1));
  if (!(width > 0) || !(height > 0)) return { zoom, fx: 0, fy: 0 };
  const cover = coverSize(aspect, width, height);
  const maxX = Math.max(0, (cover.width * zoom - width) / 2 / width), maxY = Math.max(0, (cover.height * zoom - height) / 2 / height);
  const fx = typeof fit?.fx === 'number' && Number.isFinite(fit.fx) ? fit.fx : 0, fy = typeof fit?.fy === 'number' && Number.isFinite(fit.fy) ? fit.fy : 0;
  return { zoom, fx: Math.min(maxX, Math.max(-maxX, fx)), fy: Math.min(maxY, Math.max(-maxY, fy)) };
}

/** A stored value read back: numbers only, in a sane range (the exact limits are applied when it is drawn). */
export function storedFit(item: { zoom?: unknown; fx?: unknown; fy?: unknown; aspect?: unknown } | null | undefined): WallpaperFit & { aspect: number } {
  const aspect = finite(item?.aspect, 0);
  return {
    zoom: Math.min(FIT_MAX, Math.max(1, finite(item?.zoom, 1))),
    fx: Math.min(FIT_MAX, Math.max(-FIT_MAX, finite(item?.fx, 0))),
    fy: Math.min(FIT_MAX, Math.max(-FIT_MAX, finite(item?.fy, 0))),
    aspect: aspect > 0.05 && aspect < 20 ? aspect : 0,
  };
}
