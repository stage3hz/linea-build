// «Пиксельный след»: the pure model of the pixel trail under the finger (phone) and the cursor (PC).
// Kept free of React Native imports: it is tested in Node (test/pixel-trail.test.mjs) and drawn by
// src/PixelTrail.tsx on a canvas (web). The native overlays (modules/linea-trail: ios/LineTrailModule.swift,
// TrailOverlay.kt on Android) mirror the SAME constants and rules — change them in all three places.
//
// Model (grid recolour): the screen is divided into a fixed grid of GRID-pt cells. While the pointer moves,
// a point is taken every SPACING pt along the path from the previous position; the cell under that point
// lights up, sometimes with one neighbour up to SCATTER cells away (and sometimes as a 2×2 block). A lit cell
// fades from BIRTH_ALPHA to 0 over its life (LIFE_MIN..LIFE_MAX ms) and flickers off for single FLICKER_MS
// frames more and more often as it fades, so it dissolves rather than just dimming. A cell passed again is
// re-lit, not duplicated. At most MAX_LIVE cells live at once: the oldest slot is reused (a ring).

export const TRAIL = {
  /** Cell size, pt (CSS px on PC). */
  GRID: 5,
  /** Distance along the path between two lit points, pt. */
  SPACING: 5,
  /** Neighbour scatter radius, in cells. */
  SCATTER: 2,
  /** Chance that a lit point also lights one scattered neighbour. */
  EXTRA_CHANCE: 0.4,
  /** Chance that a lit cell is a 2×2 block. */
  BIG_CHANCE: 0.15,
  LIFE_MIN: 420,
  LIFE_MAX: 700,
  MAX_LIVE: 150,
  BIRTH_ALPHA: 0.85,
  FLICKER_MS: 48,
  /** Flicker-off chance at birth and how much it grows by the end of life. */
  FLICKER_BASE: 0.08,
  FLICKER_GROW: 0.5,
  /** A jump longer than this (pt) starts a new stroke instead of drawing a line (cursor left and came back). */
  MAX_JUMP: 240,
  /** At most this many points per move event (a fast flick on a slow frame). */
  MAX_STEPS: 40,
} as const;

/** Trail colour for the current theme: white on dark themes, black on light ones. */
export const trailColor = (dark: boolean) => dark ? '#FFFFFF' : '#000000';

/** Deterministic 32-bit hash → [0, 1). Ported 1:1 to Swift (UInt32 &*) and Kotlin (Int, wrapping *). */
export function trailHash(seed: number, step: number): number {
  let h = (seed ^ Math.imul(step | 0, 0x9E3779B1)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Opacity of a cell `age` ms after it lit up, with life `life` and flicker seed `seed`; 0 = not drawn. */
export function trailAlpha(age: number, life: number, seed: number): number {
  if (!(age >= 0) || age >= life) return 0;
  const t = age / life;
  const off = TRAIL.FLICKER_BASE + TRAIL.FLICKER_GROW * t;
  if (trailHash(seed, Math.floor(age / TRAIL.FLICKER_MS)) < off) return 0;
  return TRAIL.BIRTH_ALPHA * (1 - t);
}

type Stroke = { x: number; y: number; carry: number };

export class PixelTrailModel {
  /** Cell coordinates (multiply by GRID for pt) and size in cells (1 or 2). */
  readonly cx = new Int32Array(TRAIL.MAX_LIVE);
  readonly cy = new Int32Array(TRAIL.MAX_LIVE);
  readonly size = new Uint8Array(TRAIL.MAX_LIVE);
  readonly born = new Float64Array(TRAIL.MAX_LIVE).fill(-Infinity);
  readonly life = new Float64Array(TRAIL.MAX_LIVE);
  readonly seed = new Int32Array(TRAIL.MAX_LIVE);
  private head = 0;
  private until = -Infinity;
  private strokes = new Map<number, Stroke>();

  constructor(private random: () => number = Math.random) {}

  /** The pointer `id` moved to (x, y) pt at `now` ms. Returns how many cells lit up. */
  move(id: number, x: number, y: number, now: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const stroke = this.strokes.get(id);
    if (!stroke) { this.strokes.set(id, { x, y, carry: 0 }); return 0; }
    const dx = x - stroke.x, dy = y - stroke.y, length = Math.hypot(dx, dy);
    if (length > TRAIL.MAX_JUMP) { stroke.x = x; stroke.y = y; stroke.carry = 0; return 0; }
    let lit = 0, at = TRAIL.SPACING - stroke.carry, steps = 0;
    while (at <= length && steps < TRAIL.MAX_STEPS) {
      const k = at / length;
      lit += this.light(stroke.x + dx * k, stroke.y + dy * k, now);
      at += TRAIL.SPACING; steps++;
    }
    // The distance already walked past the last lit point carries over to the next move.
    stroke.carry = steps >= TRAIL.MAX_STEPS ? 0 : length - (at - TRAIL.SPACING);
    stroke.x = x; stroke.y = y;
    return lit;
  }

  /** The pointer `id` lifted (or left the window): the next move starts a new stroke. */
  lift(id: number) { this.strokes.delete(id); }
  liftAll() { this.strokes.clear(); }

  /** True while some cell may still be drawn at `now` (the animation loop stops once this is false). */
  alive(now: number) { return now < this.until; }

  /** Drops every cell (setting turned off, theme switched mid-trail is fine — colour is applied at draw time). */
  clear() { this.born.fill(-Infinity); this.until = -Infinity; this.strokes.clear(); }

  /** Opacity of slot `i` at `now` (0 = skip it). */
  alpha(i: number, now: number) { return trailAlpha(now - this.born[i], this.life[i], this.seed[i]); }

  private light(x: number, y: number, now: number): number {
    const cx = Math.floor(x / TRAIL.GRID), cy = Math.floor(y / TRAIL.GRID);
    let lit = this.cell(cx, cy, this.random() < TRAIL.BIG_CHANCE ? 2 : 1, now);
    if (this.random() < TRAIL.EXTRA_CHANCE) {
      const ox = Math.round((this.random() * 2 - 1) * TRAIL.SCATTER), oy = Math.round((this.random() * 2 - 1) * TRAIL.SCATTER);
      if (ox || oy) lit += this.cell(cx + ox, cy + oy, 1, now);
    }
    return lit;
  }

  private cell(cx: number, cy: number, size: number, now: number): number {
    const life = TRAIL.LIFE_MIN + this.random() * (TRAIL.LIFE_MAX - TRAIL.LIFE_MIN);
    const seed = (this.random() * 4294967296) | 0;
    let slot = -1;
    // A cell passed again is re-lit, not stacked.
    for (let i = 0; i < TRAIL.MAX_LIVE; i++) if (this.cx[i] === cx && this.cy[i] === cy && this.size[i] === size && now - this.born[i] < this.life[i]) { slot = i; break; }
    if (slot < 0) { slot = this.head; this.head = (this.head + 1) % TRAIL.MAX_LIVE; }
    this.cx[slot] = cx; this.cy[slot] = cy; this.size[slot] = size;
    this.born[slot] = now; this.life[slot] = life; this.seed[slot] = seed;
    this.until = Math.max(this.until, now + life);
    return 1;
  }
}
