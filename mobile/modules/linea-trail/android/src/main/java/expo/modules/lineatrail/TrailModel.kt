package expo.modules.lineatrail

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/** Mirrors TRAIL in src/pixelTrailModel.ts (and TrailRules in ios/LineTrailModule.swift) — keep the values identical. */
object TrailRules {
  const val PITCH = 5f           // grid pitch, dp
  const val DOT = 4f             // tile side, dp
  const val RADIUS = 140.0       // light radius, dp
  const val PEAK = 0.44          // tile opacity at the centre of a fresh light
  const val BLOOM = 0.128        // bloom opacity at its centre
  const val BLOOM_SCALE = 1.15   // bloom radius / RADIUS
  const val LIFE = 150.0         // life of a sample left by a moving light, ms
  const val HOLD = 1500.0        // life of the light under a finger at rest, ms
  const val RELEASE = 300.0      // fade after the finger lifts, ms
  const val LERP = 0.22          // glide per 60 Hz frame
  const val FRAME_MS = 1000.0 / 60
  const val SAMPLE_STEP = 4.0    // dp
  const val MAX_SAMPLES = 64
  const val FILL_STEP = 20.0      // a fast swipe's gap is filled every FILL_STEP pt
  const val FILL_MAX = 8          // at most this many fill samples per frame
  const val STILL_MS = 40.0       // the pointer counts as stopped after this long without moving, ms
  const val MIN_WEIGHT = 0.008
  const val MOVING = 0.3         // dp

  /** trailCarry: the eased age with the same brightness (inverse smoothstep), so a life switch never jumps. */
  fun carry(ms: Double, life: Double): Double { val v = min(1.0, max(0.0, fade(ms, life))); return 0.5 - kotlin.math.sin(kotlin.math.asin(1 - 2 * v) / 3) }
  /** trailFade: smoothstep(age), age = 1 − ms / life. */
  fun fade(ms: Double, life: Double): Double = if (ms < 0) 1.0 else if (!(ms < life)) 0.0 else (1 - ms / life).let { if (life == HOLD) it else it * it * (3 - 2 * it) } // held finger: even (linear) dimming

  /** trailGlide: LERP at 60 Hz, the same speed at any refresh rate. */
  fun glide(dt: Double): Double = 1 - (1 - LERP).pow(max(0.0, dt) / FRAME_MS)
}

/** PixelTrailModel in src/pixelTrailModel.ts. Coordinates in dp, time in ms. No allocation per frame once the
 *  tile buffer has grown to the band size. */
class TrailModel {
  private val xs = DoubleArray(TrailRules.MAX_SAMPLES)
  private val ys = DoubleArray(TrailRules.MAX_SAMPLES)
  private val ts = DoubleArray(TrailRules.MAX_SAMPLES) { Double.NEGATIVE_INFINITY }
  private val ls = DoubleArray(TrailRules.MAX_SAMPLES) { TrailRules.LIFE }
  private var head = 0
  private var newest = -1
  // Pointer (target) and light (glides after it).
  private var tx = Double.NaN; private var ty = Double.NaN
  private var px = Double.NaN; private var py = Double.NaN
  private var lastStep = Double.NaN
  private var held = false
  private var ox = Double.NaN; private var oy = Double.NaN; private var moveAt = Double.NEGATIVE_INFINITY // last seen pointer, when it last moved

  // The lit tiles of the last compute: columns c0 until c0+cols, rows r0 until r0+rows.
  var c0 = 0; private set
  var r0 = 0; private set
  var cols = 0; private set
  var rows = 0; private set
  var lit = 0; private set
  var alpha = FloatArray(0); private set
  // The bloom of the last step: centre (dp) and opacity (0 = none).
  var bloomX = 0.0; private set
  var bloomY = 0.0; private set
  var bloomAlpha = 0.0; private set

  /** The finger is at (x, y); the light glides there from where it rests. */
  fun point(x: Double, y: Double) {
    if (x.isNaN() || y.isNaN() || x.isInfinite() || y.isInfinite()) return
    if (px.isNaN()) { px = x; py = y }
    tx = x; ty = y
  }

  /** A finger went down: the light is right there (no glide), with a fresh HOLD sample. */
  fun down(x: Double, y: Double, now: Double) {
    if (x.isNaN() || y.isNaN() || x.isInfinite() || y.isInfinite()) return
    tx = x; px = x; ty = y; py = y; held = true
    ox = x; oy = y; moveAt = now - TrailRules.STILL_MS // a still touch starts fading at once
    push(x, y, now, TrailRules.HOLD)
  }

  /** Lift/cancel: ends like a still finger — the light fades from the moment the pointer stopped. */
  @Suppress("UNUSED_PARAMETER") fun release(now: Double) { held = false }

  fun clear() { ts.fill(Double.NEGATIVE_INFINITY); newest = -1; lastStep = Double.NaN; held = false; ox = Double.NaN; oy = Double.NaN; moveAt = Double.NEGATIVE_INFINITY; cols = 0; rows = 0; lit = 0; bloomAlpha = 0.0 }

  private fun live(i: Int, now: Double) = now - ts[i] < ls[i]

  fun alive(now: Double): Boolean {
    for (i in 0 until TrailRules.MAX_SAMPLES) if (live(i, now)) return true
    return false
  }

  /** Advances the light by one frame and samples it. Returns whether another frame is needed. */
  /** Lights the current position with a sample born at `t` (refreshing the newest one when close), filling a fast swipe's gap. */
  private fun sample(t: Double, life: Double, dt: Double) {
    val n = newest; val last = n >= 0 && ts[n] + ls[n] > t
    if (last && hypot(xs[n] - px, ys[n] - py) < TrailRules.SAMPLE_STEP) { ts[n] = t; ls[n] = life; return }
    if (last) {
      val x0 = xs[n]; val y0 = ys[n]; val dx = px - x0; val dy = py - y0
      val k = min(TrailRules.FILL_MAX, floor(hypot(dx, dy) / TrailRules.FILL_STEP).toInt())
      for (j in 1..k) { val f = j.toDouble() / (k + 1); push(x0 + dx * f, y0 + dy * f, t - (1 - f) * dt, life) }
    }
    push(px, py, t, life)
  }

  fun step(now: Double): Boolean {
    if (!tx.isNaN()) {
      if (tx != ox || ty != oy) { ox = tx; oy = ty; moveAt = now }
      val pointerMoving = now - moveAt < TrailRules.STILL_MS
      val dt = if (!lastStep.isNaN()) min(100.0, now - lastStep) else TrailRules.FRAME_MS
      val k = TrailRules.glide(dt)
      px += (tx - px) * k; py += (ty - py) * k
      val n = newest; val last = n >= 0 && live(n, now)
      if (pointerMoving) {
        // Moving again after a rest: a held light keeps its brightness but fades as fast as the trail.
        for (i in 0 until TrailRules.MAX_SAMPLES) {
          if (ls[i] != TrailRules.HOLD || !live(i, now)) continue
          val left = TrailRules.carry(now - ts[i], TrailRules.HOLD)
          ls[i] = TrailRules.LIFE; ts[i] = now - (1 - left) * TrailRules.LIFE
        }
        sample(now, TrailRules.LIFE, dt)
      } else if (hypot(tx - px, ty - py) > TrailRules.MOVING) {
        // The pointer stopped but the light still glides to it: it fades from the stop moment (no waiting).
        sample(moveAt, TrailRules.HOLD, 0.0)
      } else if (last && ls[n] != TrailRules.HOLD) {
        ts[n] = moveAt; ls[n] = TrailRules.HOLD
      }
    }
    lastStep = now
    if (alive(now)) {
      val n = newest
      if (n >= 0 && live(n, now)) { bloomX = xs[n]; bloomY = ys[n]; bloomAlpha = TrailRules.BLOOM * (1 - (now - ts[n]) / ls[n]) } else bloomAlpha = 0.0
      return true
    }
    px = tx; py = ty; lastStep = Double.NaN; bloomAlpha = 0.0
    return false
  }

  fun compute(now: Double) {
    val p = TrailRules.PITCH.toDouble(); val r = TrailRules.RADIUS
    var minX = Double.POSITIVE_INFINITY; var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY; var maxY = Double.NEGATIVE_INFINITY
    for (i in 0 until TrailRules.MAX_SAMPLES) if (live(i, now)) { minX = min(minX, xs[i]); maxX = max(maxX, xs[i]); minY = min(minY, ys[i]); maxY = max(maxY, ys[i]) }
    lit = 0
    if (minX > maxX) { cols = 0; rows = 0; return }
    c0 = floor((minX - r) / p).toInt(); r0 = floor((minY - r) / p).toInt()
    cols = floor((maxX + r) / p).toInt() - c0 + 1; rows = floor((maxY + r) / p).toInt() - r0 + 1
    val size = cols * rows
    if (alpha.size < size) alpha = FloatArray(size + size / 2)
    alpha.fill(0f, 0, size)
    // Each sample writes the max into the tiles inside its own circle (per row, only the columns that can be inside).
    for (i in 0 until TrailRules.MAX_SAMPLES) {
      val strength = TrailRules.fade(now - ts[i], ls[i])
      if (!(strength > 0)) continue
      val x = xs[i]; val y = ys[i]
      val r1 = max(r0, floor((y - r) / p).toInt()); val r2 = min(r0 + rows - 1, floor((y + r) / p).toInt())
      for (row in r1..r2) {
        val dy = row * p + p / 2 - y
        if (dy * dy >= r * r) continue
        val half = sqrt(r * r - dy * dy); val base = (row - r0) * cols - c0
        val c1 = max(c0, ceil((x - half) / p - 0.5).toInt()); val c2 = min(c0 + cols - 1, floor((x + half) / p - 0.5).toInt())
        for (c in c1..c2) {
          val dx = c * p + p / 2 - x; val d = sqrt(dx * dx + dy * dy) / r
          if (d >= 1) continue
          val k = 1 - d
          val v = (strength * k * k * (3 - 2 * k)).toFloat()
          if (v > alpha[base + c]) alpha[base + c] = v
        }
      }
    }
    for (i in 0 until size) {
      if (alpha[i] >= TrailRules.MIN_WEIGHT) { alpha[i] = (alpha[i] * TrailRules.PEAK).toFloat(); lit++ } else alpha[i] = 0f
    }
  }

  private fun push(x: Double, y: Double, now: Double, life: Double) {
    xs[head] = x; ys[head] = y; ts[head] = now; ls[head] = life
    newest = head
    head = (head + 1) % TrailRules.MAX_SAMPLES
  }
}
