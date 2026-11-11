package expo.modules.lineatrail

import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.random.Random

/** Mirrors TRAIL in src/pixelTrailModel.ts (and TrailRules in ios/LineTrailModule.swift) — keep the values identical. */
object TrailRules {
  const val GRID = 5f            // pt (dp)
  const val SPACING = 5f         // dp
  const val SCATTER = 2          // cells
  const val EXTRA_CHANCE = 0.4
  const val BIG_CHANCE = 0.15
  const val LIFE_MIN = 420.0     // ms
  const val LIFE_MAX = 700.0     // ms
  const val MAX_LIVE = 150
  const val BIRTH_ALPHA = 0.85
  const val FLICKER_MS = 48.0
  const val FLICKER_BASE = 0.08
  const val FLICKER_GROW = 0.5
  const val MAX_JUMP = 240f      // dp
  const val MAX_STEPS = 40

  /** trailHash in src/pixelTrailModel.ts (same bits: Int multiplication wraps like Math.imul). */
  fun hash(seed: Int, step: Int): Double {
    var h = seed xor (step * 0x9E3779B1L.toInt())
    h = (h xor (h ushr 16)) * 0x85EBCA6BL.toInt()
    h = (h xor (h ushr 13)) * 0xC2B2AE35L.toInt()
    h = h xor (h ushr 16)
    return (h.toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
  }

  /** trailAlpha in src/pixelTrailModel.ts; 0 = not drawn. */
  fun alpha(age: Double, life: Double, seed: Int): Double {
    if (!(age >= 0) || age >= life) return 0.0
    val t = age / life
    if (hash(seed, floor(age / FLICKER_MS).toInt()) < FLICKER_BASE + FLICKER_GROW * t) return 0.0
    return BIRTH_ALPHA * (1 - t)
  }
}

/** PixelTrailModel in src/pixelTrailModel.ts: a fixed ring of MAX_LIVE cells, no allocation while drawing. Coordinates in dp, time in ms. */
class TrailModel(private val random: Random = Random.Default) {
  val cx = IntArray(TrailRules.MAX_LIVE)
  val cy = IntArray(TrailRules.MAX_LIVE)
  val size = IntArray(TrailRules.MAX_LIVE)
  val born = DoubleArray(TrailRules.MAX_LIVE) { Double.NEGATIVE_INFINITY }
  val life = DoubleArray(TrailRules.MAX_LIVE)
  val seed = IntArray(TrailRules.MAX_LIVE)
  private var head = 0
  private var until = Double.NEGATIVE_INFINITY
  // Strokes by pointer id (Android pointer ids are small: 0..31).
  private val strokeX = FloatArray(32)
  private val strokeY = FloatArray(32)
  private val carry = FloatArray(32)
  private val down = BooleanArray(32)

  fun begin(id: Int, x: Float, y: Float) {
    if (id !in 0 until 32) return
    strokeX[id] = x; strokeY[id] = y; carry[id] = 0f; down[id] = true
  }

  fun lift(id: Int) { if (id in 0 until 32) down[id] = false }
  fun liftAll() { down.fill(false) }
  fun alive(now: Double) = now < until
  fun alpha(i: Int, now: Double) = TrailRules.alpha(now - born[i], life[i], seed[i])

  fun clear() { born.fill(Double.NEGATIVE_INFINITY); until = Double.NEGATIVE_INFINITY; liftAll() }

  /** Returns how many cells lit up. */
  fun move(id: Int, x: Float, y: Float, now: Double): Int {
    if (id !in 0 until 32 || !down[id] || x.isNaN() || y.isNaN()) return 0
    val dx = x - strokeX[id]; val dy = y - strokeY[id]; val length = hypot(dx, dy)
    if (length > TrailRules.MAX_JUMP) { begin(id, x, y); return 0 }
    var lit = 0; var steps = 0
    var at = TrailRules.SPACING - carry[id]
    while (at <= length && steps < TrailRules.MAX_STEPS) {
      val k = at / length
      lit += light(strokeX[id] + dx * k, strokeY[id] + dy * k, now)
      at += TrailRules.SPACING; steps++
    }
    carry[id] = if (steps >= TrailRules.MAX_STEPS) 0f else length - (at - TrailRules.SPACING)
    strokeX[id] = x; strokeY[id] = y
    return lit
  }

  private fun light(x: Float, y: Float, now: Double): Int {
    val gx = floor(x / TrailRules.GRID).toInt(); val gy = floor(y / TrailRules.GRID).toInt()
    var lit = cell(gx, gy, if (random.nextDouble() < TrailRules.BIG_CHANCE) 2 else 1, now)
    if (random.nextDouble() < TrailRules.EXTRA_CHANCE) {
      val ox = ((random.nextDouble() * 2 - 1) * TrailRules.SCATTER).roundToInt()
      val oy = ((random.nextDouble() * 2 - 1) * TrailRules.SCATTER).roundToInt()
      if (ox != 0 || oy != 0) lit += cell(gx + ox, gy + oy, 1, now)
    }
    return lit
  }

  private fun cell(gx: Int, gy: Int, blocks: Int, now: Double): Int {
    val lifetime = TrailRules.LIFE_MIN + random.nextDouble() * (TrailRules.LIFE_MAX - TrailRules.LIFE_MIN)
    var slot = -1
    for (i in 0 until TrailRules.MAX_LIVE) {
      if (cx[i] == gx && cy[i] == gy && size[i] == blocks && now - born[i] < life[i]) { slot = i; break }
    }
    if (slot < 0) { slot = head; head = (head + 1) % TrailRules.MAX_LIVE }
    cx[slot] = gx; cy[slot] = gy; size[slot] = blocks
    born[slot] = now; life[slot] = lifetime; seed[slot] = random.nextInt()
    until = max(until, now + lifetime)
    return 1
  }
}
