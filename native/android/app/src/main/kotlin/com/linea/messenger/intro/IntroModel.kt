package com.linea.messenger.intro

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/** The first-launch intro, its pure side: no views, no clock. The word INVIZ made of particles, the timeline (4.6 s),
 *  the camera, the field, the light behind «N» and the taps of the haptics — the formulas of the approved preview
 *  (`build()`, `frame(t)`, `TAPS`), deterministic (the preview's seeded generator, mulberry32, seed 5). Everything is
 *  in the preview's scene units (N is 10 high); a frame is drawn in 2D from the points `Projector` gives.
 *  iOS: Sources/Intro/IntroModel.swift — the same numbers, line for line. */
object IntroModel {
  /** The whole timeline, s. */
  const val DURATION = 4.6
  /** The fade that reveals the sign-in screen at the end (or after a tap), s. */
  const val FADE = 0.35
  /** The phases (s): the word appears whole; the break-in; the field; it settles. */
  const val BREAK_START = 1.1
  const val FIELD_START = 2.6
  const val SETTLED = 3.5

  // ---- The seeded generator and the curves of the preview ----

  /** mulberry32, as the preview's `rng(a)`: the same doubles in [0, 1) for the same seed. */
  class Mulberry32(seed: Int) {
    private var a = seed
    fun next(): Double {
      a += 0x6D2B79F5
      var t = (a xor (a ushr 15)) * (1 or a)
      t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
      return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
    }
  }

  fun clamp(x: Double, a: Double, b: Double): Double = min(b, max(a, x))
  fun ease(value: Double): Double { val x = clamp(value, 0.0, 1.0); return x * x * (3 - 2 * x) }
  fun easeOut(value: Double): Double = 1 - (1 - clamp(value, 0.0, 1.0)).pow(3)

  // ---- The shapes ----

  /** The letters I, V, Z: the app's own face, Unbounded ExtraBold (res/font/unbounded_extrabold.ttf), outlines in
   *  font units (1000 per em, baseline at 0, y up), with the advance. All three are straight lines. */
  class Glyph(val advance: Double, val outline: DoubleArray)

  val glyphI = Glyph(362.0, doubleArrayOf(65.0, 750.0, 298.0, 750.0, 298.0, 0.0, 65.0, 0.0))
  val glyphV = Glyph(951.0, doubleArrayOf(527.0, 106.0, 430.0, 106.0, 708.0, 750.0, 952.0, 750.0, 608.0, 0.0, 343.0, 0.0, -1.0, 750.0, 248.0, 750.0))
  val glyphZ = Glyph(819.0, doubleArrayOf(42.0, 0.0, 42.0, 167.0, 512.0, 615.0, 685.0, 570.0, 46.0, 570.0, 46.0, 751.0, 773.0, 751.0, 773.0, 584.0, 304.0, 135.0, 157.0, 180.0, 776.0, 180.0, 776.0, 0.0))
  /** The cap height of N in the same face: what the preview fits to 220 px. */
  private const val CAP = 750.0

  /** The app's sign, N: the three pieces of the bundled app icon's mark (AppIcon-Light / app_icon_light_fg — the
   *  same picture as mobile/assets/icons/light.png, the dark N on it), traced into outlines. Coordinates in the
   *  preview's crop of the icon (x 138, y 144, 237 × 221 of the 512-px icon) at twice that: 474 × 442, y down. */
  val markPieces: List<DoubleArray> = listOf(
    doubleArrayOf(331.0, 69.0, 337.0, 56.0, 346.0, 48.0, 448.0, 2.0, 457.0, 1.0, 462.0, 2.0, 468.0, 6.0, 473.0, 17.0, 473.0, 304.0, 471.0, 310.0, 467.0, 313.0, 460.0, 313.0, 458.0, 312.0, 433.0, 286.0, 333.0, 175.0, 331.0, 170.0),
    doubleArrayOf(0.0, 34.0, 2.0, 27.0, 6.0, 19.0, 15.0, 11.0, 22.0, 7.0, 30.0, 5.0, 114.0, 5.0, 125.0, 8.0, 134.0, 13.0, 154.0, 33.0, 237.0, 122.0, 466.0, 377.0, 471.0, 386.0, 473.0, 395.0, 473.0, 402.0, 471.0, 411.0, 464.0, 424.0, 452.0, 435.0, 443.0, 439.0, 429.0, 442.0, 372.0, 442.0, 360.0, 440.0, 351.0, 436.0, 346.0, 432.0, 5.0, 55.0, 0.0, 44.0),
    doubleArrayOf(0.0, 133.0, 2.0, 128.0, 5.0, 125.0, 13.0, 125.0, 36.0, 147.0, 133.0, 250.0, 135.0, 257.0, 135.0, 381.0, 134.0, 386.0, 131.0, 392.0, 121.0, 401.0, 25.0, 440.0, 13.0, 440.0, 5.0, 435.0, 0.0, 426.0),
  )
  private const val MARK_W = 474.0
  private const val MARK_H = 442.0

  /** Even-odd point-in-polygon (x0, y0, x1, y1, …). */
  fun inside(poly: DoubleArray, x: Double, y: Double): Boolean {
    var hit = false
    val n = poly.size / 2
    var j = n - 1
    for (i in 0 until n) {
      val xi = poly[2 * i]; val yi = poly[2 * i + 1]; val xj = poly[2 * j]; val yj = poly[2 * j + 1]
      if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit
      j = i
    }
    return hit
  }

  // ---- The word made into particles (the preview's `build`) ----

  /** One small square of the letters. Home (x0, y0) in scene units; `fly` how far it goes along (vx, vy); `lost`
   *  shrinks away; `t0` when its turn comes; `s` and `b` the size and brightness it ends at; `letter` 0 I, 2 V, 3 I, 4 Z. */
  class Particle(
    val x0: Double, val y0: Double, val vx: Double, val vy: Double, val fly: Double, val lost: Boolean,
    val z: Double, val s: Double, val b: Double, val t0: Double, val spin: Double, val scatter: Double, val letter: Int,
  )

  /** The whole scene: the particles, the edge of a particle's cell, N's outlines (scene units, y up, N's middle at
   *  x 0), and the span of the word either side of N's middle. */
  class Scene(
    val particles: List<Particle>, val cell: Double, val mark: List<DoubleArray>,
    val span: Double, val leftSpan: Double,
  ) {
    val total: Double get() = span + leftSpan
    val mid: Double get() = (span - leftSpan) / 2
  }

  private const val PX = 220.0
  private const val BASE = 270.0
  private const val U = 10.0 / PX

  val scene: Scene by lazy { build() }

  fun build(): Scene {
    // The letters laid out as the preview's canvas does: N's height fitted to 220 px, a gap of 0.13 em between letters.
    val scale = PX / CAP
    val fs = 1000 * scale
    val gap = fs * 0.13
    val wN = PX * 237 / 221
    val word = listOf(glyphI, null, glyphV, glyphI, glyphZ)
    val placed = ArrayList<DoubleArray>()
    val letterOf = ArrayList<Int>()
    var x = 20.0
    var xN = 0.0
    word.forEachIndexed { index, glyph ->
      if (glyph == null) { xN = x; x += wN + gap; return@forEachIndexed }
      val o = glyph.outline
      placed.add(DoubleArray(o.size) { k -> if (k % 2 == 0) x + o[k] * scale else BASE - o[k] * scale })
      letterOf.add(index)
      x += glyph.advance * scale + gap
    }
    val tw = x - gap
    fun letterAt(px: Double, py: Double): Int {
      for (k in placed.indices) if (inside(placed[k], px, py)) return letterOf[k]
      return -1
    }
    val cubes = ArrayList<Particle>()
    val random = Mulberry32(5)
    val cell = PX / 17
    val reach = tw * 0.6
    val s0 = tw / 0.99
    var py = BASE - PX
    while (py < BASE) {
      var px = 20.0
      while (px < tw + 20) {
        val cx = px + cell / 2; val cy = py + cell / 2
        val letter = if (cx >= xN && cx <= xN + wN) -1 else letterAt(cx, cy)
        if (letter >= 0) {
          val left = px < xN
          val d = if (left) xN - px else px - (xN + wN)
          val t = if (left) min(0.48, 0.26 + d / (reach * 0.9)) else min(1.0, d / reach)
          val r1 = random.next(); val r2 = random.next(); val r3 = random.next(); val r4 = random.next()
          val x0 = (px + cell / 2 - xN - wN / 2) * U
          val y0 = (BASE - py - cell / 2) * U
          var vx = x0
          var vy = (y0 - 5) * 1.5 + (r3 - 0.5) * 10 * 0.5 * t
          val vl = hypot(vx, vy).let { if (it == 0.0) 1.0 else it }
          vx /= vl; vy /= vl
          val lost = r1 < t.pow(1.3) * 0.82 + 0.08
          val fly = (0.25 + r2 * r2 * 1.6) * t * t * s0 * 0.11 * U
          // When its turn comes: the far end of the word goes first, the wave runs toward N.
          val far = if (left) 0.55 else clamp(d / (tw - (xN + wN - 20)), 0.0, 1.0)
          val t0 = 1.1 + (1 - far) * 0.95 + r4 * 0.25
          cubes.add(Particle(x0, y0, vx, vy, if (lost) fly + 6 + r2 * 22 else fly, lost, (r4 - 0.5) * t * t * 5, 0.95 - 0.4 * t, 1 - 0.25 * t, t0, (r3 - 0.5) * 3, t, letter))
        }
        px += cell
      }
      py += cell
    }
    val mark = markPieces.map { piece -> DoubleArray(piece.size) { k -> if (k % 2 == 0) (xN + piece[k] / MARK_W * wN - xN - wN / 2) * U else (BASE - (BASE - PX + piece[k] / MARK_H * PX)) * U } }
    return Scene(cubes, cell * U, mark, (tw + 20 - xN - wN / 2) * U, (xN + wN / 2 - 20) * U)
  }

  // ---- A particle at time t ----

  /** Where a particle is at t: scene units, `size` the edge of its square, `brightness` 0…1 (white × it), `angle`
   *  its turn about the view axis, radians. */
  data class ParticleState(val x: Double, val y: Double, val z: Double, val size: Double, val brightness: Double, val angle: Double)

  fun appear(t: Double): Double = ease(t / 0.9)

  /** The preview's `frame(t)` for one cube. `out` gets x, y, z, size, brightness, angle from `offset`. */
  fun particle(q: Particle, t: Double, cell: Double, out: DoubleArray, offset: Int = 0) {
    val appear = appear(t)
    val p = easeOut((t - q.t0) / 1.15)
    val f = q.fly * p
    val s = (if (q.lost) 1 - p else 1.0) * (1 - (1 - q.s) * p) * (0.2 + 0.8 * appear)
    out[offset] = q.x0 + q.vx * f
    out[offset + 1] = q.y0 + q.vy * f + (1 - appear) * -2
    out[offset + 2] = q.z * p
    out[offset + 3] = cell * 0.8 * max(s, 0.0)
    out[offset + 4] = (1 - (1 - q.b) * p) * (0.82 - 0.2 * ease((t - 1.0) / 0.8)) * appear
    out[offset + 5] = if (q.lost) q.spin * p else 0.0
  }

  fun particle(q: Particle, t: Double, cell: Double = scene.cell): ParticleState {
    val out = DoubleArray(6)
    particle(q, t, cell, out)
    return ParticleState(out[0], out[1], out[2], out[3], out[4], out[5])
  }

  // ---- The camera ----

  /** The camera at t: it comes closer and turns a little to the side (the word group turns by `yaw`), with a slight
   *  shake during the break-in. Vertical field of view 30°. */
  class Camera(val yaw: Double, val x: Double, val y: Double, val z: Double, val lookX: Double, val lookY: Double, val lookZ: Double) {
    val fovY: Double get() = 30.0 * PI / 180
  }

  fun shake(t: Double): Double = if (t > 1.1 && t < 2.6) 0.12 * ease((t - 1.1) / 1.5) * sin(t * 61) * sin(t * 37) else 0.0

  fun camera(t: Double, world: Scene = scene): Camera {
    val yaw = -0.3 * ease((t - 0.4) / 3.2)
    val dist = world.total * (5.9 - 0.9 * easeOut(t / 3.6))
    val mx = world.mid * cos(yaw) * 0.95
    return Camera(yaw, mx + shake(t), 6.5 + world.total * 0.05, dist, mx, 5.2, 0.0)
  }

  /** A simple perspective: the group's turn about the vertical axis, the camera's look-at basis, the divide.
   *  `project` writes the screen x, y (points/pixels of a `width` × `height` view, y down) and the depth (distance
   *  along the view axis; bigger = farther). The vertical field of view widens on a view narrower than the preview's
   *  phone (9 : 19.5) so the word always fits across. */
  class Projector(camera: Camera, private val width: Double, private val height: Double) {
    private val cy = cos(camera.yaw); private val sy = sin(camera.yaw)
    private val ex = camera.x; private val ey = camera.y; private val ez = camera.z
    private val fx: Double; private val fy: Double; private val fz: Double
    private val rx: Double; private val rz: Double
    private val ux: Double; private val uy: Double; private val uz: Double
    /** Pixels per unit at depth 1. */
    val focal: Double

    init {
      var ax = camera.lookX - ex; var ay = camera.lookY - ey; var az = camera.lookZ - ez
      val al = sqrt(ax * ax + ay * ay + az * az); ax /= al; ay /= al; az /= al
      fx = ax; fy = ay; fz = az
      // right = forward × up(0, 1, 0)
      var bx = -az; var bz = ax
      val bl = sqrt(bx * bx + bz * bz); bx /= bl; bz /= bl
      rx = bx; rz = bz
      // up = right × forward
      ux = -bz * fy; uy = bz * fx - bx * fz; uz = bx * fy
      val aspect = width / height
      val tanHalf = tan(camera.fovY / 2) * max(1.0, (9.0 / 19.5) / aspect)
      focal = (height / 2) / tanHalf
    }

    fun project(x: Double, y: Double, z: Double, out: DoubleArray, offset: Int = 0) {
      val wx = x * cy + z * sy
      val wz = -x * sy + z * cy
      val dx = wx - ex; val dy = y - ey; val dz = wz - ez
      val xc = dx * rx + dz * rz
      val yc = dx * ux + dy * uy + dz * uz
      val zc = max(1e-3, dx * fx + dy * fy + dz * fz)
      out[offset] = width / 2 + xc / zc * focal
      out[offset + 1] = height / 2 - yc / zc * focal
      out[offset + 2] = zc
    }
  }

  // ---- N, the field, the light ----

  /** The light plate behind N (white × it): quiet at first, flares when the field comes up. */
  fun flare(t: Double): Double {
    val up = ease((t - 2.6) / 0.5)
    return 0.25 * appear(t) + 0.75 * up + 0.35 * exp(-((t - 2.7) / 0.18).pow(2))
  }

  /** The slab's own light (its colours × it). */
  fun body(t: Double): Double = 0.35 + 0.65 * appear(t)

  /** The plate: N's outlines 1.06 times larger about N's middle, just behind the slab. */
  const val PLATE_Z = -1.25
  const val SLAB_BACK = -1.2
  const val SLAB_FRONT = 1.2
  fun plate(world: Scene = scene): List<DoubleArray> = world.mark.map { piece -> DoubleArray(piece.size) { k -> if (k % 2 == 0) piece[k] * 1.06 else 5 + (piece[k] - 5) * 1.06 } }

  /** The radius of the field's ring wave at t (scene units), negative before it starts. */
  fun fieldWave(t: Double): Double = (t - 2.6) * 42

  /** How lit a point of the field is at t, by its distance from N's middle: the ring and the glow it leaves inside. */
  fun fieldGlow(distance: Double, t: Double): Double {
    if (t <= 2.6) return 0.0
    val wave = fieldWave(t)
    return 0.6 * exp(-((distance - wave) / 5).pow(2)) + if (distance < wave) 0.16 * exp(-distance / 60) else 0.0
  }

  const val FIELD_Z = -3.2

  /** The field's honeycomb: each edge once (x1, y1, x2, y2), and how many cells share it (1 or 2 — the preview draws
   *  each cell's six edges, so a shared one shines twice). */
  class Edges(val lines: DoubleArray, val shared: IntArray) { val count: Int get() = shared.size }

  val field: Edges by lazy { fieldEdges() }

  private fun fieldEdges(): Edges {
    val fr = 3.4; val fw = fr * sqrt(3.0)
    val seen = HashMap<Pair<Long, Long>, Int>()
    val lines = ArrayList<Double>()
    val counts = ArrayList<Int>()
    fun key(x: Double, y: Double): Long = (Math.round(x * 100) shl 32) xor (Math.round(y * 100) and 0xFFFFFFFFL)
    for (row in -9..12) for (c in -9..16) {
      val cx = c * fw + (if (row % 2 != 0) fw / 2 else 0.0); val cy = 5 + row * fr * 1.5
      for (i in 0 until 6) {
        val a0 = PI / 6 + i * PI / 3; val a1 = a0 + PI / 3
        val x1 = cx + fr * cos(a0); val y1 = cy + fr * sin(a0); val x2 = cx + fr * cos(a1); val y2 = cy + fr * sin(a1)
        val k1 = key(x1, y1); val k2 = key(x2, y2)
        val edge = if (k1 < k2) Pair(k1, k2) else Pair(k2, k1)
        val at = seen[edge]
        if (at != null) { counts[at] = counts[at] + 1; continue }
        seen[edge] = counts.size
        lines.add(x1); lines.add(y1); lines.add(x2); lines.add(y2); counts.add(1)
      }
    }
    return Edges(lines.toDoubleArray(), counts.toIntArray())
  }

  /** The light of one field edge at t: the mean of its two ends' (the preview's vertex colours), times the cells
   *  that share it. */
  fun edgeGlow(edges: Edges, index: Int, t: Double): Double {
    if (t <= 2.6) return 0.0
    val l = edges.lines
    val a = fieldGlow(hypot(l[4 * index], l[4 * index + 1] - 5), t)
    val b = fieldGlow(hypot(l[4 * index + 2], l[4 * index + 3] - 5), t)
    return (a + b) / 2 * edges.shared[index]
  }

  /** The honeycomb on N's face (the preview's per-cell colouring: pointy-top cells, outer radius 0.62): the edges
   *  of the cells that touch N's outlines, scene units. The face's lighter lines are these, clipped to N. */
  val faceCells: DoubleArray by lazy { faceEdges() }
  const val FACE_RADIUS = 0.62

  private fun faceEdges(): DoubleArray {
    val hr = FACE_RADIUS; val hw = hr * sqrt(3.0)
    val out = ArrayList<Double>()
    val seen = HashSet<Pair<Long, Long>>()
    fun key(x: Double, y: Double): Long = (Math.round(x * 1000) shl 32) xor (Math.round(y * 1000) and 0xFFFFFFFFL)
    val mark = scene.mark
    var minX = Double.MAX_VALUE; var maxX = -Double.MAX_VALUE; var minY = Double.MAX_VALUE; var maxY = -Double.MAX_VALUE
    for (piece in mark) for (k in piece.indices step 2) { minX = min(minX, piece[k]); maxX = max(maxX, piece[k]); minY = min(minY, piece[k + 1]); maxY = max(maxY, piece[k + 1]) }
    val rowLow = Math.floor((minY - hr) / (hr * 1.5)).toInt(); val rowHigh = Math.ceil((maxY + hr) / (hr * 1.5)).toInt()
    for (row in rowLow..rowHigh) {
      val off = if (row % 2 != 0) hw / 2 else 0.0
      val colLow = Math.floor((minX - hw - off) / hw).toInt(); val colHigh = Math.ceil((maxX + hw - off) / hw).toInt()
      for (c in colLow..colHigh) {
        val cx = c * hw + off; val cy = row * hr * 1.5
        for (i in 0 until 6) {
          val a0 = PI / 6 + i * PI / 3; val a1 = a0 + PI / 3
          val x1 = cx + hr * cos(a0); val y1 = cy + hr * sin(a0); val x2 = cx + hr * cos(a1); val y2 = cy + hr * sin(a1)
          val k1 = key(x1, y1); val k2 = key(x2, y2)
          if (!seen.add(if (k1 < k2) Pair(k1, k2) else Pair(k2, k1))) continue
          val mx = (x1 + x2) / 2; val my = (y1 + y2) / 2
          if (mark.none { inside(it, mx, my) || inside(it, x1, y1) || inside(it, x2, y2) }) continue
          out.add(x1); out.add(y1); out.add(x2); out.add(y2)
        }
      }
    }
    return out.toDoubleArray()
  }

  // ---- The haptics: taps only ----

  /** One tap of the phone's haptic engine: when (s), how strong (0…1), and its kind — a light `TAP` or the one soft
   *  `THUD` when the field comes up. Never a continuous vibration. */
  data class Tap(val time: Double, val strength: Double, val kind: Kind) {
    enum class Kind { TAP, THUD }
  }

  /** The preview's `TAPS`: light taps that get denser while the letters crumble (every 0.22 s down to 0.07 s, 0.25 →
   *  0.45), one soft thud at 2.62 s, three fading taps after it. */
  val taps: List<Tap> by lazy {
    val out = ArrayList<Tap>()
    var t = 1.1
    while (t < 2.56) {
      val k = (t - 1.1) / 1.46
      out.add(Tap(t, 0.25 + 0.2 * k, Tap.Kind.TAP))
      t += 0.22 - 0.15 * k
    }
    out.add(Tap(2.62, 0.8, Tap.Kind.THUD))
    for ((at, strength) in listOf(2.78 to 0.3, 2.95 to 0.2, 3.15 to 0.12)) out.add(Tap(at, strength, Tap.Kind.TAP))
    out
  }

  /** The preview's line of the haptics (strength 0…1 over time): each tap a narrow bump (0.018 s; the thud 0.05 s). */
  fun haptic(t: Double): Double {
    var v = 0.0
    for (tap in taps) {
      val d = (t - tap.time) / (if (tap.kind == Tap.Kind.THUD) 0.05 else 0.018)
      if (d > -3 && d < 3) v = max(v, tap.strength * exp(-d * d))
    }
    return v
  }

  // ---- When it plays ----

  /** The intro plays at a start with no session, once per install, and never when motion is reduced (the system's
   *  setting or the app's «Анимации»); the person who signed out of an install that has seen it never sees it again. */
  fun shouldPlay(seen: Boolean, hasSession: Boolean, motionAllowed: Boolean): Boolean = !seen && !hasSession && motionAllowed

  /** The overlay's opacity at t when it plays through: whole until the end, then the fade. */
  fun overlayAlpha(t: Double): Double = 1 - clamp((t - DURATION) / FADE, 0.0, 1.0)
}
