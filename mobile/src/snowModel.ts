// «Снег» (PC): the rules of a snowdrift lying on a ledge. Pure maths, no drawing — see src/Snow.tsx.
// A drift is a row of columns COL px wide; each holds the height of the snow above the ledge.
export const SNOW = {
  COL: 3,        // column width, px
  MAX: 14,       // tallest drift on a ledge, px
  FLOOR_MAX: 22, // tallest drift on the bottom of the window, px
  FLAKES: 140,   // flakes in a 1280×800 window; scales with the area
  BRUSH: 26,     // radius the cursor sweeps snow away with, px
  GAIN: 0.42,    // height one flake adds, per px of its radius
  ROUND: 12,     // the drift rounds down to nothing over this many px at each end
  TOP: '#FFFFFF', BOTTOM: '#C6D0E2', // lit top, cold shade where the drift meets the ledge
} as const;

export const snowColumns = (width: number, radius: number) => Math.max(1, Math.floor((width - radius * 1.2) / SNOW.COL));

/** A flake of radius `r` lands on column `i`: it rolls to a lower neighbour (so the drift comes out smooth),
 *  then adds to it. Nothing is added above `cap`. Returns the column that grew, or -1. */
export function snowDeposit(h: Float32Array, i: number, r: number, cap: number): number {
  if (i < 0 || i >= h.length || h[i] >= cap) return -1;
  let k = i;
  for (let step = 0; step < 3; step++) {
    const left = k > 0 ? h[k - 1] : Infinity, right = k < h.length - 1 ? h[k + 1] : Infinity;
    if (left < h[k] - 0.6 && left <= right) k--; else if (right < h[k] - 0.6) k++; else break;
  }
  h[k] = Math.min(cap, h[k] + r * SNOW.GAIN);
  return k;
}

/** The cursor at (mx, my) sweeps the drift whose ledge starts at (x, y). `swept(column, taken)` is called for every
 *  column that lost snow. Columns farther than BRUSH from the cursor are untouched. */
export function snowBrush(h: Float32Array, x: number, y: number, mx: number, my: number, swept?: (column: number, taken: number) => void): number {
  const B = SNOW.BRUSH, C = SNOW.COL;
  const from = Math.max(0, Math.floor((mx - B - x) / C)), to = Math.min(h.length - 1, Math.ceil((mx + B - x) / C));
  let total = 0;
  for (let i = from; i <= to; i++) {
    if (h[i] <= 0.3) continue;
    const distance = Math.hypot(x + i * C - mx, y - h[i] / 2 - my);
    if (distance > B) continue;
    const taken = Math.min(h[i], h[i] * (1 - distance / B) * 0.9 + 0.4);
    h[i] -= taken; total += taken;
    swept?.(i, taken);
  }
  return total;
}

/** Height of the drawn surface over column `i`: neighbours averaged, so the outline has no steps. */
export const snowSurface = (h: Float32Array, i: number) => ((i ? h[i - 1] : 0) + 2 * h[i] + (i < h.length - 1 ? h[i + 1] : 0)) / 4;

/** The tallest a drift may be over column `i` of `n`: a lumpy cap (bumps of several widths, different for every
 *  `seed`) that rounds down to the ledge at both ends — snow lying on a window sill, not a level strip. */
export function snowCeiling(i: number, n: number, max: number, seed: number): number {
  const x = i * SNOW.COL;
  const lumps = 0.5 + 0.5 * (Math.sin(x / 61 + seed) * 0.5 + Math.sin(x / 23 + seed * 2.3) * 0.3 + Math.sin(x / 9 + seed * 5.1) * 0.2);
  const edge = Math.min(1, (Math.min(i, n - 1 - i) + 0.5) * SNOW.COL / SNOW.ROUND);
  return max * (0.55 + 0.45 * lumps) * Math.sqrt(1 - (1 - edge) * (1 - edge));
}

// ── Phone: where the Dynamic Island / camera cutout is ──────────────────────────────────────────────────────────
/** The Dynamic Island's size in points. */
export const ISLAND = { WIDTH: 126, HEIGHT: 37.33, BELOW: 48 } as const;
/**
 * The ledge on top of the screen's cutout, in window points, or null when there is none to lie on.
 *  - iPhone: iOS has no call that returns the island's rectangle, so it is derived from the top safe-area inset:
 *    phones with the island report 59 pt or more (a notch: 44–50), the island is centred, and its top is the
 *    inset minus ISLAND.BELOW. Portrait only (in landscape the island is on the side).
 *  - Android: the system reports the cutout; only a hole or pill clear of the screen's top edge and no wider than
 *    half the screen holds snow (a wide notch that touches the top edge has no top to lie on).
 */
export function islandLedge(os: 'ios' | 'android', width: number, height: number, topInset: number, cutout: { x: number; y: number; width: number; height: number } | null): { x: number; y: number; width: number; height: number; radius: number } | null {
  if (!(width > 0) || !(height > width)) return null;
  if (os === 'ios') {
    if (!(topInset >= 59) || topInset > 70) return null;
    return { x: (width - ISLAND.WIDTH) / 2, y: topInset - ISLAND.BELOW, width: ISLAND.WIDTH, height: ISLAND.HEIGHT, radius: ISLAND.HEIGHT / 2 };
  }
  if (!cutout || !(cutout.width >= 8) || !(cutout.height >= 8) || cutout.width > width / 2 || cutout.y < 2) return null;
  return { x: cutout.x, y: cutout.y, width: cutout.width, height: cutout.height, radius: Math.min(cutout.width, cutout.height) / 2 };
}
