package expo.modules.lineasnow

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/** The numbers of the approved demo (scratchpad flake/phone.approved.html) — keep identical to ios/. All lengths in dp. */
object SnowRules {
  const val COL = 3f              // width of one snow column
  const val BRUSH = 30f           // radius of the sweeping finger
  const val GAIN = .5f            // cap growth per landed flake, × flake radius
  const val FLAKES = 70           // flakes per REF_AREA
  const val FLAKES_MAX = 160
  const val REF_AREA = 393f * 852f
  const val SPRITES = 10          // aggregate flake sprites
  const val FAR = .35f            // flakes with z below this are plain dots
  const val PARTICLES = 1600      // clumps + grains + drops
  const val BLOBS = 5             // circles per clump, at most
  const val GRAVITY = 1200f
  const val TAP_SLOP = 10f
  const val KNOCK_REACH = 46f     // a tap clears this far on a wide ledge
  const val WIDE = 130f           // wider ledges lose only the part under the finger
  const val HEAT_EASE = .25f      // applied heat moves towards the target this much per second
  const val MAX_DT = .05f
  const val COLUMNS_MAX = 2000    // sanity bound for one ledge

  const val GRAIN = 0
  const val CLUMP = 1
  const val DROP = 2

  /** PowerManager.THERMAL_STATUS_* → heat: NONE 0, LIGHT .4, MODERATE .7, SEVERE and above 1. */
  fun thermal(status: Int): Float = when {
    status <= 0 -> 0f
    status == 1 -> .4f
    status == 2 -> .7f
    else -> 1f
  }
}

/** One ledge as JS reports it (window dp). */
class LedgeSpec(
  val id: String, val x: Float, val y: Float, val width: Float, val height: Float,
  val radius: Float, val max: Float, val glass: Boolean,
)

/** A ledge with its drift. Column i spans x + i·COL … x + (i+1)·COL; `rel` is the top outline relative to y
 *  (so the drift survives a move), `cap` the ceiling and `h` the snow lying there. */
class Ledge(val id: String) {
  var x = 0f; var y = 0f; var width = 0f; var height = 0f; var radius = 0f; var max = 0f; var glass = false
  var n = 0; private set
  var rel = FloatArray(0); private set
  var cap = FloatArray(0); private set
  var h = FloatArray(0); private set
  /** Stable per-id values: the shape of the lumps and of the rime. */
  val seed: Float
  val frostSeed: Int
  /** Renderer's attachment (the rime bitmap); the model never reads it. */
  var tag: Any? = null

  init {
    var hash = -0x7ee3623b // FNV-1a
    for (c in id) hash = (hash xor c.code) * 0x01000193
    val positive = hash and 0x7fffffff
    seed = (positive % 10000) / 100f
    frostSeed = positive % 997 + 1
  }

  fun base(i: Int): Float = y + rel[i]

  /** Rebuilds the columns; the snow already lies (85% of the ceiling). */
  fun rebuild() {
    val count = min(SnowRules.COLUMNS_MAX, max(0, floor(width / SnowRules.COL).toInt()))
    if (count != n) { n = count; rel = FloatArray(count); cap = FloatArray(count); h = FloatArray(count) }
    val rad = max(0f, min(radius, min(height / 2, width / 2)))
    for (i in 0 until count) {
      val cx = (i + .5f) * SnowRules.COL
      val d = min(cx, width - cx)
      // The cap follows the corner arc and thins out where the edge gets too steep (below ~60% of the radius).
      val drop = if (d < rad) rad - sqrt(max(0f, rad * rad - (rad - d) * (rad - d))) else 0f
      val hold = if (rad > 0f) max(0f, 1 - drop / (rad * .6f)) else 1f
      val px = i * SnowRules.COL
      val lumps = .5f + .5f * (sin(px / 47 + seed) * .5f + sin(px / 19 + seed * 2.3f) * .3f + sin(px / 8 + seed * 5.1f) * .2f)
      rel[i] = drop + 1
      cap[i] = max * (.55f + .45f * lumps) * sqrt(hold)
      h[i] = cap[i] * .85f
    }
  }
}

/** The whole simulation, main thread only, no Android types: flakes, drifts, knocked-off snow, meltwater.
 *  Struct-of-arrays so that a frame allocates nothing. */
class SnowModel(private val random: Random = Random.Default) {
  var width = 0f; private set
  var height = 0f; private set
  val ledges = ArrayList<Ledge>()

  // Falling flakes; the first `falling` are simulated and drawn (heat thins the snowfall).
  var flakes = 0; private set
  var falling = 0; private set
  val flakeX = FloatArray(SnowRules.FLAKES_MAX); val flakeY = FloatArray(SnowRules.FLAKES_MAX)
  val flakeR = FloatArray(SnowRules.FLAKES_MAX); val flakeA = FloatArray(SnowRules.FLAKES_MAX)
  val flakeZ = FloatArray(SnowRules.FLAKES_MAX); val flakeRot = FloatArray(SnowRules.FLAKES_MAX)
  val flakeSprite = IntArray(SnowRules.FLAKES_MAX)
  private val flakeV = FloatArray(SnowRules.FLAKES_MAX); private val flakePhase = FloatArray(SnowRules.FLAKES_MAX)
  private val flakeSpin = FloatArray(SnowRules.FLAKES_MAX)

  // Particles: clumps and grains of knocked-off snow, meltwater drops. Never faded, only fall off the window.
  var particles = 0; private set
  val kind = IntArray(SnowRules.PARTICLES)
  val partX = FloatArray(SnowRules.PARTICLES); val partY = FloatArray(SnowRules.PARTICLES)
  val partVy = FloatArray(SnowRules.PARTICLES); val partR = FloatArray(SnowRules.PARTICLES)
  val partRot = FloatArray(SnowRules.PARTICLES)
  /** Drops: the y where the drop leaves the control and falls. */
  val partEnd = FloatArray(SnowRules.PARTICLES)
  /** Clumps: blob count and (dx, dy, radius) per blob. */
  val blobCount = IntArray(SnowRules.PARTICLES)
  val blobs = FloatArray(SnowRules.PARTICLES * SnowRules.BLOBS * 3)
  private val partVx = FloatArray(SnowRules.PARTICLES); private val partDrag = FloatArray(SnowRules.PARTICLES)
  private val partSpin = FloatArray(SnowRules.PARTICLES)

  /** Applied heat (eased) and where it is heading. */
  var heat = 0f; private set
  var heatTarget = 0f
    set(value) { field = if (value.isNaN()) 0f else value.coerceIn(0f, 1f) }
  /** Hot, everything melted and fallen: the frame loop may stop until the heat drops or a ledge appears. */
  var asleep = false; private set

  private var finger = false
  private var fingerX = 0f; private var fingerY = 0f; private var prevX = 0f; private var prevY = 0f
  private var tapId: String? = null
  private var tapX = 0f; private var tapY = 0f

  fun resize(w: Float, h: Float) {
    if (w == width && h == height) return
    width = max(0f, w); height = max(0f, h)
    val want = if (width <= 0f || height <= 0f) 0
      else (SnowRules.FLAKES * width * height / SnowRules.REF_AREA).roundToInt().coerceIn(1, SnowRules.FLAKES_MAX)
    for (k in flakes until want) spawn(k, true)
    flakes = want
  }

  fun clear() {
    ledges.clear(); flakes = 0; falling = 0; particles = 0; width = 0f; height = 0f
    heat = 0f; asleep = false; finger = false; tapId = null
  }

  /** The complete set of ledges. A drift is kept by id; it is rebuilt only when the ledge's shape changes. */
  fun setLedges(specs: List<LedgeSpec>) {
    val old = ArrayList(ledges)
    ledges.clear()
    for (spec in specs) {
      if (find(spec.id) != null) continue
      var ledge: Ledge? = null
      for (candidate in old) if (candidate.id == spec.id) { ledge = candidate; break }
      val fresh = ledge == null
      val target = ledge ?: Ledge(spec.id)
      // Sub-dp jitter of a re-measure must not reset the drift.
      val reshaped = fresh || abs(target.width - spec.width) > .25f || abs(target.radius - spec.radius) > .25f || abs(target.max - spec.max) > .01f
      target.x = spec.x; target.y = spec.y; target.height = spec.height; target.glass = spec.glass
      if (reshaped) { target.width = spec.width; target.radius = spec.radius; target.max = spec.max; target.rebuild() }
      ledges.add(target)
    }
  }

  private fun find(id: String?): Ledge? {
    if (id == null) return null
    for (k in ledges.indices) if (ledges[k].id == id) return ledges[k]
    return null
  }

  // ---- touches (observed only) ----

  fun down(x: Float, y: Float) {
    finger = true; fingerX = x; fingerY = y; prevX = x; prevY = y
    tapId = null; tapX = x; tapY = y
    // The topmost glass ledge under the finger is the one a tap knocks.
    for (k in ledges.indices.reversed()) {
      val s = ledges[k]
      if (s.glass && x >= s.x && x <= s.x + s.width && y >= s.y && y <= s.y + s.height) { tapId = s.id; break }
    }
  }

  fun move(x: Float, y: Float) { if (finger) { fingerX = x; fingerY = y } }

  fun up(x: Float, y: Float) {
    val ledge = find(tapId)
    if (finger && ledge != null && hypot(x - tapX, y - tapY) <= SnowRules.TAP_SLOP) knock(ledge, x)
    finger = false; tapId = null
  }

  fun cancel() { finger = false; tapId = null }

  /** A tap shakes the snow off: it falls as clumps and grains, a thin uneven crust stays. */
  private fun knock(s: Ledge, cx: Float) {
    val col = SnowRules.COL
    val wide = s.n * col > SnowRules.WIDE
    val reach = SnowRules.KNOCK_REACH
    val mid = s.x + s.n * col / 2
    var i = 0
    while (i < s.n) {
      val px = s.x + (i + 1.5f) * col
      val d = abs(px - cx)
      if (!wide || d <= reach) {
        var amount = 0f
        var top = Float.MAX_VALUE
        for (q in i until min(s.n, i + 3)) {
          val keep = min(1f, (if (wide) (d / reach).pow(2.4f) else 0f) + random.nextFloat() * .12f)
          amount += s.h[q] * (1 - keep) * col
          top = min(top, s.base(q) - s.h[q])
          s.h[q] *= keep
        }
        if (amount > 1) shed(px, top + 2, amount * 1.6f, if (wide) (px - cx) * .8f else (px - mid) * 1.6f, -22f, col * 3)
      }
      i += 3
    }
  }

  /** The moving finger sweeps the snow within BRUSH of it. */
  private fun brush() {
    if (!finger || hypot(fingerX - prevX, fingerY - prevY) < .5f) return
    val col = SnowRules.COL; val reach = SnowRules.BRUSH
    for (k in ledges.indices) {
      val s = ledges[k]
      val from = max(0, floor((fingerX - reach - s.x) / col).toInt())
      val to = min(s.n - 1, ceil((fingerX + reach - s.x) / col).toInt())
      for (i in from..to) {
        if (s.h[i] <= .3f) continue
        val cx = s.x + i * col
        val d = hypot(cx - fingerX, s.base(i) - s.h[i] / 2 - fingerY)
        if (d > reach) continue
        val take = min(s.h[i], s.h[i] * (1 - d / reach) * .9f + .4f)
        s.h[i] -= take
        if (take > .5f) shed(cx, s.base(i) - s.h[i], take * col, (fingerX - prevX) * 5, -8f, col)
      }
    }
  }

  /** The removed volume splits into a few clumps and a trail of grains. */
  private fun shed(x: Float, y: Float, amount: Float, vx: Float, vy: Float, spread: Float) {
    var left = amount
    while (left > 6) {
      val r = min(5.5f, 1.2f + random.nextFloat().pow(2.2f) * sqrt(left) * .7f)
      clump(x + (random.nextFloat() - .5f) * spread, y - random.nextFloat() * 3, vx + (random.nextFloat() - .5f) * 46, vy - random.nextFloat() * 45, r)
      left -= r * r * 2.2f
    }
    val grains = min(60f, 6 + amount * .9f)
    var k = 0
    while (k < grains) {
      grain(x + (random.nextFloat() - .5f) * spread, y - random.nextFloat() * 4, vx * .8f + (random.nextFloat() - .5f) * 90, vy * .6f - random.nextFloat() * 70)
      k++
    }
  }

  private fun add(type: Int, x: Float, y: Float, vx: Float, vy: Float, r: Float, drag: Float): Int {
    if (particles >= SnowRules.PARTICLES) return -1
    val k = particles++
    kind[k] = type; partX[k] = x; partY[k] = y; partVx[k] = vx; partVy[k] = vy; partR[k] = r; partDrag[k] = drag
    partRot[k] = 0f; partSpin[k] = 0f; partEnd[k] = 0f; blobCount[k] = 0
    return k
  }

  private fun clump(x: Float, y: Float, vx: Float, vy: Float, r: Float) {
    val k = add(SnowRules.CLUMP, x, y, vx, vy, r, .25f + 1.2f / r)
    if (k < 0) return
    val count = 3 + random.nextInt(3)
    val at = k * SnowRules.BLOBS * 3
    blobs[at] = 0f; blobs[at + 1] = 0f; blobs[at + 2] = r
    for (b in 1 until count) {
      val a = random.nextFloat() * 6.283f
      val d = r * (.45f + random.nextFloat() * .45f)
      blobs[at + b * 3] = cos(a) * d; blobs[at + b * 3 + 1] = sin(a) * d; blobs[at + b * 3 + 2] = r * (.45f + random.nextFloat() * .4f)
    }
    blobCount[k] = count
    partRot[k] = random.nextFloat() * 6.28f; partSpin[k] = (random.nextFloat() - .5f) * 6
  }

  private fun grain(x: Float, y: Float, vx: Float, vy: Float) {
    add(SnowRules.GRAIN, x, y, vx, vy, .45f + random.nextFloat() * .75f, 2.2f + random.nextFloat() * 2.2f)
  }

  /** Heat melts every cap down to (1 − heat) of its ceiling; meltwater leaves as drops. True while something melts. */
  private fun melt(dt: Float): Boolean {
    if (heat <= 0f) return false
    var melting = false
    for (k in ledges.indices) {
      val s = ledges[k]
      for (i in 0 until s.n) {
        val limit = s.cap[i] * (1 - heat)
        if (s.h[i] <= limit + .05f) continue
        melting = true
        s.h[i] = max(limit, s.h[i] - (1.2f + heat * 5) * dt)
        if (random.nextFloat() < dt * (.12f + heat * .5f)) {
          val p = add(SnowRules.DROP, s.x + (i + .5f) * SnowRules.COL, s.base(i) + 1, 0f, 6 + random.nextFloat() * 10, .9f + random.nextFloat() * .8f, 0f)
          if (p >= 0) partEnd[p] = s.base(i) + s.height * (.5f + random.nextFloat() * .5f)
        }
      }
    }
    return melting
  }

  private fun spawn(k: Int, anywhere: Boolean) {
    val z = random.nextFloat()
    flakeX[k] = random.nextFloat() * width
    flakeY[k] = if (anywhere) random.nextFloat() * height else -5f
    flakeR[k] = .5f + z * z * 1.5f; flakeV[k] = 20 + z * 46; flakePhase[k] = random.nextFloat() * 6.28f
    flakeA[k] = .25f + z * .6f; flakeZ[k] = z; flakeSprite[k] = random.nextInt(SnowRules.SPRITES)
    flakeRot[k] = random.nextFloat() * 6.28f; flakeSpin[k] = (random.nextFloat() - .5f) * 1.6f
  }

  private fun fall(now: Double, dt: Float) {
    val wind = (sin(now / 5200) * 12 + sin(now / 1700) * 4).toFloat()
    val sway = now / 900
    val col = SnowRules.COL
    val share = 1 - heat
    falling = (flakes * (1 - heat * .85f)).roundToInt().coerceIn(0, flakes)
    for (k in 0 until falling) {
      flakeY[k] += flakeV[k] * dt
      flakeX[k] += (wind * flakeR[k] * .5f + sin(sway + flakePhase[k]).toFloat() * 9) * dt
      if (flakeX[k] < -4) flakeX[k] = width + 4 else if (flakeX[k] > width + 4) flakeX[k] = -4f
      var landed = flakeY[k] > height + 5
      if (!landed) for (j in ledges.indices) {
        val s = ledges[j]
        val i = floor((flakeX[k] - s.x) / col).toInt()
        if (i < 0 || i >= s.n) continue
        val top = s.base(i) - s.h[i]
        if (flakeY[k] >= top && flakeY[k] < top + 7) {
          val limit = s.cap[i] * share
          if (s.h[i] < limit) s.h[i] = min(limit, s.h[i] + flakeR[k] * SnowRules.GAIN)
          landed = true
          break
        }
      }
      if (landed) spawn(k, false) else flakeRot[k] += flakeSpin[k] * dt
    }
  }

  private fun drift(dt: Float) {
    var k = particles - 1
    while (k >= 0) {
      val gone: Boolean
      if (kind[k] == SnowRules.DROP) {
        // A drop creeps down the glass, gathers speed, lets go at the lower edge and falls.
        partVy[k] += (if (partY[k] < partEnd[k]) 22f else SnowRules.GRAVITY) * dt
        partY[k] += partVy[k] * dt
        gone = partY[k] > height + 10
      } else {
        partVy[k] += SnowRules.GRAVITY * dt
        val keep = max(0f, 1 - partDrag[k] * dt)
        partVx[k] *= keep; partVy[k] *= keep
        partX[k] += partVx[k] * dt; partY[k] += partVy[k] * dt
        partRot[k] += partSpin[k] * dt
        gone = partY[k] > height + 20
      }
      if (gone) remove(k)
      k--
    }
  }

  /** Swap-remove: the last particle (already stepped this frame) takes the slot. */
  private fun remove(k: Int) {
    val last = --particles
    if (k == last) return
    kind[k] = kind[last]; partX[k] = partX[last]; partY[k] = partY[last]; partVx[k] = partVx[last]; partVy[k] = partVy[last]
    partR[k] = partR[last]; partDrag[k] = partDrag[last]; partRot[k] = partRot[last]; partSpin[k] = partSpin[last]
    partEnd[k] = partEnd[last]; blobCount[k] = blobCount[last]
    val size = SnowRules.BLOBS * 3
    System.arraycopy(blobs, last * size, blobs, k * size, size)
  }

  /** One frame: `now` in ms (phases of wind and sway), `dt` in seconds. False = nothing left to animate (see asleep). */
  fun step(now: Double, dt: Float): Boolean {
    val t = if (dt.isNaN()) 0f else dt.coerceIn(0f, SnowRules.MAX_DT)
    val gap = heatTarget - heat
    val ease = SnowRules.HEAT_EASE * t
    heat = if (abs(gap) <= ease) heatTarget else heat + (if (gap > 0) ease else -ease)
    brush()
    prevX = fingerX; prevY = fingerY
    val melting = melt(t)
    fall(now, t)
    drift(t)
    asleep = heat >= .99f && heatTarget >= .99f && !melting && particles == 0
    return !asleep
  }
}

/** The rime on one glass ledge, as in a frozen window: a matte haze from the rim inward with a ragged inner
 *  boundary. Pure maths (the demo's `frost()`); the view turns it into a bitmap and adds specks and feathers. */
class FrostField(val w: Float, val h: Float, radius: Float, private val seed: Int, val light: Boolean) {
  val r = max(0f, min(radius, min(h / 2, w / 2)))
  val reach = min(h * .2f, 8f)
  private var state = seed * 9301 + 49297

  /** The demo's small LCG: the same ledge always gets the same rime. */
  fun rand(): Float { state = (state * 9301 + 49297) % 233280; return state / 233280f }

  private fun hash(x: Double, y: Double): Double { val n = sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453; return n - floor(n) }

  private fun noise(x: Double, y: Double): Double {
    val xi = floor(x); val yi = floor(y); val xf = x - xi; val yf = y - yi
    val u = xf * xf * (3 - 2 * xf); val v = yf * yf * (3 - 2 * yf)
    return (hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u) * (1 - v) + (hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u) * v
  }

  /** Distance to the rounded rectangle's rim, positive inside. */
  fun inside(px: Float, py: Float): Float {
    val qx = abs(px - w / 2) - (w / 2 - r); val qy = abs(py - h / 2) - (h / 2 - r)
    return r - (hypot(max(qx, 0f), max(qy, 0f)) + min(max(qx, qy), 0f))
  }

  /** Strength of the rime at a point, 0…1: strongest at the rim, gone before the middle. */
  fun power(px: Float, py: Float): Float {
    val e = inside(px, py)
    // Beyond 2·reach the formula below cannot be positive: skip the noise.
    if (e < 0 || reach <= 0f || e > reach * 2) return 0f
    val big = noise(px / 26.0, py / 26.0); val mid = noise(px / 9.0 + 40, py / 9.0 + 40)
    val edge = 1 - e / (reach * (.45 + big * 1.15))
    return (edge * 1.15 + (mid - .5) * .55).coerceIn(0.0, 1.0).toFloat()
  }

  /** The haze as non-premultiplied ARGB pixels, `scale` pixels per dp. */
  fun fill(out: IntArray, pw: Int, ph: Int, scale: Float) {
    val rgb = if (light) (150 shl 16) or (185 shl 8) or 235 else (228 shl 16) or (240 shl 8) or 255
    val peak = if (light) .42 else .3
    for (py in 0 until ph) for (px in 0 until pw) {
      val x = px / scale; val y = py / scale
      val p = power(x, y)
      if (p <= 0f) { out[py * pw + px] = 0; continue }
      val grain = .72 + .28 * noise(x * 2.3 + 9, y * 2.3 + 9) + (rand() - .5) * .16
      val a = p.toDouble().pow(1.7) * peak * grain
      out[py * pw + px] = ((a * 255).toInt().coerceIn(0, 255) shl 24) or rgb
    }
  }
}
