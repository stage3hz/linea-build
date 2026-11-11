// «Пиксельный след»: the pure model of the glowing tile mesh under the finger (phone) and the cursor (PC).
// Kept free of React Native imports: it is tested in Node (test/pixel-trail.test.mjs) and drawn by
// src/PixelTrail.tsx on a canvas (web). The native overlays (modules/linea-trail: ios/LineTrailModule.swift,
// android/.../TrailModel.kt) mirror the SAME constants and rules — change them in all three places.
//
// Model:
//  - The screen carries a fixed mesh of square tiles (DOT-pt squares every PITCH pt, a thin gap between them,
//    snapped to the screen — never to the pointer), invisible except where the light falls.
//  - The light glides after the pointer: every frame pos += (target − pos) · LERP (at 60 Hz; the same glide at
//    any refresh rate). While it moves, a sample of its position is taken each frame: a new one (life LIFE) when it
//    is SAMPLE_STEP pt or more from the newest, otherwise the newest is refreshed (t = now, life = LIFE).
//  - When the light settles (|target − pos| ≤ MOVING) while a finger / button is DOWN, the newest sample is switched
//    ONCE to life HOLD with t = now and is not refreshed after that: a finger held still keeps a light that fades by
//    itself over a few seconds, until the next touch or movement. (A resting cursor without a button just lets the
//    trail fade over LIFE.) On release every sample living longer than RELEASE is switched to RELEASE keeping its
//    current brightness: left = 1 − (now − t) / life, t = now − (1 − left) · RELEASE. When the light moves again, every HOLD sample switches to life
//    LIFE keeping its current brightness (t = now − (1 − left) · LIFE), so no slow spot stays behind. A touch / button down puts the light right there (no glide) with a
//    fresh HOLD sample. At most MAX_SAMPLES samples.
//  - Tile weight = max over samples of smoothstep(1 − d / RADIUS) · smoothstep(age), age = 1 − (now − t) / life;
//    tiles below MIN_WEIGHT are skipped; tile opacity = PEAK · weight.
//  - Under the mesh, a soft radial bloom at the newest sample: radius RADIUS · BLOOM_SCALE, opacity BLOOM · age at
//    the centre, 0 at the edge. (Web also softens the tile edges with a BLUR px blur; the phones skip it.)
//  - Once every sample has expired the frame loop stops and the light rests at the pointer.

export const TRAIL = {
  /** Grid pitch, pt (CSS px on PC). */
  PITCH: 5,
  /** Tile side, pt (the gap is PITCH − DOT). */
  DOT: 4,
  /** Light radius, pt. */
  RADIUS: 140,
  /** Tile opacity at the centre of a fresh light. */
  PEAK: 0.44,
  /** Bloom opacity at its centre (fresh), and its radius as a multiple of RADIUS. */
  BLOOM: 0.128,
  BLOOM_SCALE: 1.15,
  /** Life of a sample left by a moving light, ms. */
  LIFE: 150,
  /** Life of the light under a finger (or a held mouse button) at rest, ms. */
  HOLD: 1500,
  /** On release the light fades within this, ms, from its current brightness. */
  RELEASE: 300,
  /** The pointer counts as stopped once it has not moved for this long (ms); the light starts fading from that moment. */
  STILL_MS: 40,
  /** Glide per 60 Hz frame. */
  LERP: 0.22,
  FRAME_MS: 1000 / 60,
  /** New sample when the light is this far (pt) from the newest one. */
  SAMPLE_STEP: 4,
  MAX_SAMPLES: 64,
  /** A fast swipe moves the light far in one frame: the gap from the previous sample is filled every FILL_STEP pt
   *  (at most FILL_MAX per frame) so the band stays continuous instead of separate spots. */
  FILL_STEP: 20,
  FILL_MAX: 8,
  MIN_WEIGHT: 0.008,
  /** The light counts as moving while it is farther than this (pt) from the pointer. */
  MOVING: 0.3,
  /** Tile edge blur on web, canvas px. */
  BLUR: 0.45,
} as const;

/** Tile colour for the current theme: white on dark themes, black on light ones. */
export const trailColor = (dark: boolean) => dark ? '#FFFFFF' : '#000000';

/** smoothstep(1 − d): 1 at the centre, 0 at and beyond the edge. */
export function trailFalloff(d: number): number {
  if (!(d < 1)) return 0;
  if (d <= 0) return 1;
  const k = 1 - d;
  return k * k * (3 - 2 * k);
}

/** Smooth fade: smoothstep(age) with age = 1 − ms / life (0 when dead) — eases in and out. */
export function trailFade(ms: number, life: number = TRAIL.LIFE): number {
  if (ms < 0) return 1;
  if (!(ms < life)) return 0;
  const age = 1 - ms / life;
  // A still, held finger dims evenly (linear); the moving trail and the release ease in and out.
  return life === TRAIL.HOLD ? age : age * age * (3 - 2 * age);
}

/** The age on the eased (smoothstep) curve that has the same brightness as `trailFade(ms, life)`:
 * switching a sample to another life keeps its brightness, with no jump. Inverse smoothstep. */
export function trailCarry(ms: number, life: number): number {
  const v = Math.min(1, Math.max(0, trailFade(ms, life)));
  return 0.5 - Math.sin(Math.asin(1 - 2 * v) / 3);
}

/** The glide factor for a frame of `dt` ms: LERP at 60 Hz, the same speed at any refresh rate. */
export const trailGlide = (dt: number) => 1 - Math.pow(1 - TRAIL.LERP, Math.max(0, dt) / TRAIL.FRAME_MS);

/** The lit tiles of one frame: a window of the grid (columns c0.., rows r0..) with an opacity per tile. */
export type TrailField = { c0: number; r0: number; cols: number; rows: number; alpha: Float32Array; lit: number };

export class PixelTrailModel {
  readonly xs = new Float64Array(TRAIL.MAX_SAMPLES);
  readonly ys = new Float64Array(TRAIL.MAX_SAMPLES);
  readonly ts = new Float64Array(TRAIL.MAX_SAMPLES).fill(-Infinity);
  /** Life of each sample, ms (LIFE or HOLD). */
  readonly ls = new Float64Array(TRAIL.MAX_SAMPLES).fill(TRAIL.LIFE);
  private head = 0;
  private newest = -1;
  /** Pointer (target) and light (glides after it). */
  tx = NaN; ty = NaN; px = NaN; py = NaN;
  private lastStep = NaN;
  /** Where the pointer was last seen and when it last moved: the fade of a still finger starts at that moment, not later. */
  private ox = NaN; private oy = NaN; private moveAt = -Infinity;
  private held = false;
  readonly field: TrailField = { c0: 0, r0: 0, cols: 0, rows: 0, alpha: new Float32Array(0), lit: 0 };

  /** The pointer (a hovering cursor or a moving finger) is at (x, y); the light glides there from where it rests. */
  point(x: number, y: number, _now?: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!Number.isFinite(this.px)) { this.px = x; this.py = y; }
    this.tx = x; this.ty = y;
  }

  /** A finger / button went down at (x, y): the light is right there, with a fresh HOLD sample. */
  down(x: number, y: number, now: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.tx = this.px = x; this.ty = this.py = y; this.held = true;
    this.ox = x; this.oy = y; this.moveAt = now - TRAIL.STILL_MS;// a still touch starts fading at once
    this.push(x, y, now, TRAIL.HOLD);
  }

  /** The finger lifted / the button was released (or the touch was cancelled): the light ends the same way as a
   * still finger — it fades from the moment the pointer stopped. */
  release(_now: number) { this.held = false; }

  clear() { this.ts.fill(-Infinity); this.newest = -1; this.lastStep = NaN; this.held = false; this.ox = this.oy = NaN; this.moveAt = -Infinity; this.field.cols = this.field.rows = this.field.lit = 0; }

  private live(i: number, now: number) { return now - this.ts[i] < this.ls[i]; }

  /** Some sample is still alive: the picture still changes, keep the frame loop running. */
  alive(now: number) {
    for (let i = 0; i < TRAIL.MAX_SAMPLES; i++) if (this.live(i, now)) return true;
    return false;
  }

  /** Lights the light's current position with a sample born at `t` living `life` (refreshing the newest one when it is
   *  close), filling the gap of a fast swipe every FILL_STEP pt so the band stays continuous. */
  private sample(t: number, life: number, dt: number) {
    const n = this.newest, last = n >= 0 && this.ts[n] + this.ls[n] > t;
    if (last && Math.hypot(this.xs[n] - this.px, this.ys[n] - this.py) < TRAIL.SAMPLE_STEP) { this.ts[n] = t; this.ls[n] = life; return; }
    if (last) {
      const dx = this.px - this.xs[n], dy = this.py - this.ys[n], k = Math.min(TRAIL.FILL_MAX, Math.floor(Math.hypot(dx, dy) / TRAIL.FILL_STEP));
      for (let j = 1; j <= k; j++) { const f = j / (k + 1); this.push(this.xs[n] + dx * f, this.ys[n] + dy * f, t - (1 - f) * dt, life); }
    }
    this.push(this.px, this.py, t, life);
  }

  /** Advances the light by one frame and samples it. Returns whether another frame is needed. */
  step(now: number): boolean {
    if (Number.isFinite(this.tx)) {
      if (this.tx !== this.ox || this.ty !== this.oy) { this.ox = this.tx; this.oy = this.ty; this.moveAt = now; }
      const pointerMoving = now - this.moveAt < TRAIL.STILL_MS;
      const dt = Number.isFinite(this.lastStep) ? Math.min(100, now - this.lastStep) : TRAIL.FRAME_MS;
      const k = trailGlide(dt);
      this.px += (this.tx - this.px) * k; this.py += (this.ty - this.py) * k;
      const n = this.newest, last = n >= 0 && this.live(n, now);
      if (pointerMoving) {
        // Moving again after a rest: a held light keeps its current brightness but fades as fast as the trail,
        // so no second slow spot stays behind.
        for (let i = 0; i < TRAIL.MAX_SAMPLES; i++) {
          if (this.ls[i] !== TRAIL.HOLD || !this.live(i, now)) continue;
          const left = trailCarry(now - this.ts[i], TRAIL.HOLD);
          this.ls[i] = TRAIL.LIFE; this.ts[i] = now - (1 - left) * TRAIL.LIFE;
        }
        this.sample(now, TRAIL.LIFE, dt);
      } else if (Math.hypot(this.tx - this.px, this.ty - this.py) > TRAIL.MOVING) {
        // The pointer stopped but the light still glides to it: everything it lights now fades from the moment the
        // pointer stopped (HOLD), so a still finger starts dimming at once — no waiting for the light to arrive.
        this.sample(this.moveAt, TRAIL.HOLD, 0);
      } else if (last && this.ls[n] !== TRAIL.HOLD) {
        this.ts[n] = this.moveAt; this.ls[n] = TRAIL.HOLD;
      }
    }
    this.lastStep = now;
    if (this.alive(now)) return true;
    // At rest: the light waits at the pointer.
    this.px = this.tx; this.py = this.ty; this.lastStep = NaN;
    return false;
  }

  /** The bloom under the mesh at `now`: centre and opacity (0 = none). */
  bloom(now: number): { x: number; y: number; alpha: number } {
    const i = this.newest;
    if (i < 0 || !this.live(i, now)) return { x: 0, y: 0, alpha: 0 };
    return { x: this.xs[i], y: this.ys[i], alpha: TRAIL.BLOOM * (1 - (now - this.ts[i]) / this.ls[i]) };
  }

  /** Opacity of the tile centred at (x, y) pt — the reference the field computation must agree with. */
  alphaAt(x: number, y: number, now: number): number {
    let best = 0;
    for (let i = 0; i < TRAIL.MAX_SAMPLES; i++) {
      const fade = trailFade(now - this.ts[i], this.ls[i]);
      if (fade > best) best = Math.max(best, fade * trailFalloff(Math.hypot(x - this.xs[i], y - this.ys[i]) / TRAIL.RADIUS));
    }
    return best >= TRAIL.MIN_WEIGHT ? TRAIL.PEAK * best : 0;
  }

  /** Computes the lit tiles at `now` into `this.field` (no allocation once the buffer is big enough). */
  compute(now: number): TrailField {
    const f = this.field, P = TRAIL.PITCH, R = TRAIL.RADIUS;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < TRAIL.MAX_SAMPLES; i++) {
      if (!this.live(i, now)) continue;
      const x = this.xs[i], y = this.ys[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    f.lit = 0;
    if (minX > maxX) { f.cols = f.rows = 0; return f; }
    f.c0 = Math.floor((minX - R) / P); f.r0 = Math.floor((minY - R) / P);
    f.cols = Math.floor((maxX + R) / P) - f.c0 + 1; f.rows = Math.floor((maxY + R) / P) - f.r0 + 1;
    const size = f.cols * f.rows;
    if (f.alpha.length < size) f.alpha = new Float32Array(Math.ceil(size * 1.5));
    f.alpha.fill(0, 0, size);
    // Each sample writes the max into the tiles inside its own circle (per row, only the columns that can be inside).
    for (let i = 0; i < TRAIL.MAX_SAMPLES; i++) {
      const strength = trailFade(now - this.ts[i], this.ls[i]);
      if (!(strength > 0)) continue;
      const x = this.xs[i], y = this.ys[i];
      const r1 = Math.max(f.r0, Math.floor((y - R) / P)), r2 = Math.min(f.r0 + f.rows - 1, Math.floor((y + R) / P));
      for (let r = r1; r <= r2; r++) {
        const dy = r * P + P / 2 - y;
        if (dy * dy >= R * R) continue;
        const half = Math.sqrt(R * R - dy * dy), row = (r - f.r0) * f.cols - f.c0;
        const c1 = Math.max(f.c0, Math.ceil((x - half) / P - 0.5)), c2 = Math.min(f.c0 + f.cols - 1, Math.floor((x + half) / P - 0.5));
        for (let c = c1; c <= c2; c++) {
          const dx = c * P + P / 2 - x, d = Math.sqrt(dx * dx + dy * dy) / R;
          if (d >= 1) continue;
          const k = 1 - d, v = strength * k * k * (3 - 2 * k);
          if (v > f.alpha[row + c]) f.alpha[row + c] = v;
        }
      }
    }
    for (let i = 0; i < size; i++) {
      if (f.alpha[i] >= TRAIL.MIN_WEIGHT) { f.alpha[i] *= TRAIL.PEAK; f.lit++; } else f.alpha[i] = 0;
    }
    return f;
  }

  private push(x: number, y: number, now: number, life: number) {
    this.xs[this.head] = x; this.ys[this.head] = y; this.ts[this.head] = now; this.ls[this.head] = life;
    this.newest = this.head;
    this.head = (this.head + 1) % TRAIL.MAX_SAMPLES;
  }
}
