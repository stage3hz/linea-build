package com.linea.messenger.intro

import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.tan

/** The first-launch intro, its pure side: no views, no clock, no graphics. The times of the ident (the word appears
 *  behind a streak of light, stands, falls into squares; N stays and comes to the centre), the four steps the person
 *  makes by swiping up (`IntroFlow`), the camera, the lights, the swell of the haptics and the rules of when the intro
 *  is shown. Scene units: N is 10 high, its middle at x 0, the floor at y 0. The drawing is intro/IntroRenderer.kt. */
object IntroModel {
  // ---- The ident's clock, s ----

  /** The streak of light starts to sweep, and how long it takes to cross the word. */
  const val REVEAL_START = 0.25
  const val REVEAL_LENGTH = 0.95
  /** The streak is gone and the word is whole. */
  const val REVEAL_END = 1.3
  /** The letters begin to crumble: the right front starts toward N (the word has stood for about a second). */
  const val CRUMBLE_START = 2.2
  const val RIGHT_LENGTH = 1.4
  /** The left front starts a little later and is quicker (one letter only). */
  const val LEFT_START = 2.6
  const val LEFT_LENGTH = 0.9
  /** The camera goes from the whole word to N. */
  const val CENTRE_START = 3.4
  const val CENTRE_LENGTH = 1.4
  /** N is at the centre. */
  const val CENTRED = CENTRE_START + CENTRE_LENGTH
  /** The solid N turns into N made of particles. */
  const val GRAIN_START = 3.8
  const val GRAIN_LENGTH = 0.9
  /** The ident is over: from here the person leads. */
  const val IDENT_END = 4.9

  // ---- The steps ----

  const val STEPS = 4
  /** One step animates to its end in this long. */
  const val STEP_SECONDS = 1.3
  /** A step of the still stages (reduced motion): a calm cross-fade. */
  const val STILL_SECONDS = 0.7
  /** A step that was dragged almost to its end still takes at least this long to finish. */
  const val STEP_SHORTEST = 0.3
  /** The hint comes back after this long without a touch. */
  const val HINT_IDLE = 5.0
  /** The sign-in screen comes out of the blur in this long. */
  const val HANDOVER = 0.6

  // ---- The scene ----

  /** The page behind everything. */
  const val BACKGROUND = 0xFF05060A.toInt()
  /** The share of the screen's width left free on each side of the word. */
  const val MARGIN = 0.08
  /** The camera's vertical field of view at rest, degrees; it widens by up to `FOV_RUSH` with the speed of a step. */
  const val FOV = 30.0
  const val FOV_RUSH = 11.0
  /** How far the camera stands from N when N is at the centre (less on a wide screen, where the word itself is nearer). */
  const val N_DISTANCE = 74.0
  /** Where the camera stops in front of N at the end of step 1. */
  const val N_NEAR = 5.5
  /** The flat honeycomb layer in front of N. */
  const val SHIELD_Z = 22.0
  /** N's middle. */
  const val N_Y = 5.0

  fun clamp(x: Double, a: Double, b: Double): Double = min(b, max(a, x))
  fun lerp(a: Double, b: Double, t: Double): Double = a + (b - a) * t
  /** Smooth start and stop. */
  fun ease(value: Double): Double { val x = clamp(value, 0.0, 1.0); return x * x * (3 - 2 * x) }
  /** A smoother one, for a whole step. */
  fun smoother(value: Double): Double { val x = clamp(value, 0.0, 1.0); return x * x * x * (x * (x * 6 - 15) + 10) }

  /** A small seeded generator: the same numbers in [0, 1) for the same seed, so the scene is the same on every start. */
  class Random(seed: Int) {
    private var a = seed
    fun next(): Double {
      a += 0x6D2B79F5
      var t = (a xor (a ushr 15)) * (1 or a)
      t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
      return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
    }
  }

  // ---- The ident ----

  /** Where the streak of light is across the word, 0 (left of it) … 1 (right of it). */
  fun reveal(t: Double): Double = ease((t - REVEAL_START) / REVEAL_LENGTH)
  /** How bright the streak is. */
  fun sweep(t: Double): Double = if (t < REVEAL_END) 0.55 * sin(PI * clamp((t - REVEAL_START) / REVEAL_LENGTH, 0.0, 1.0)) else 0.0
  /** How far the right and the left fronts have run toward N, 0…1. */
  fun rightFront(t: Double): Double = clamp((t - CRUMBLE_START) / RIGHT_LENGTH, 0.0, 1.0)
  fun leftFront(t: Double): Double = clamp((t - LEFT_START) / LEFT_LENGTH, 0.0, 1.0)
  /** The camera's way from the word to N, 0…1. */
  fun centring(t: Double): Double = ease((t - CENTRE_START) / CENTRE_LENGTH)
  /** N made of particles, 0 (the solid N) … 1. */
  fun grain(t: Double): Double = ease((t - GRAIN_START) / GRAIN_LENGTH)

  // ---- The steps' lights ----

  /** N's particles spread into the cipher, 0…1. It starts before the camera reaches N, so there is always something
   *  lit in front of the camera. */
  fun spread(p: Double): Double = clamp((p - 0.8) / 0.7, 0.0, 1.0)
  /** The cipher melts into the far field, 0…1. */
  fun melt(p: Double): Double = ease((p - 3.25) / 0.75)
  /** The whole picture goes soft and dim, 0…1. */
  fun blur(p: Double): Double = ease((p - 3.2) / 0.7)
  /** How bright the particles are. */
  fun gain(t: Double, p: Double): Double {
    val flight = lerp(0.62, lerp(0.5, 0.7, ease((p - 0.9) / 0.5)), ease(p / 0.15))
    val dip = 1.0 - 0.12 * ease((p - 0.2) / 0.5) * (1.0 - ease((p - 0.85) / 0.3))
    return ease(t / 0.9) * (1.0 - 0.25 * melt(p)) * dip * (if (p <= 0) 0.62 else flight)
  }
  /** How soft a particle's dot is (0 the softest). */
  fun sharp(p: Double): Double = 0.6 * (1 - ease(p / 0.4))
  /** The honeycomb layer's light by where the camera is: it grows as the camera comes, flares at the pass, and is gone. */
  fun shield(p: Double, cameraZ: Double): Double {
    if (p <= 0 || p >= 1.2) return 0.0
    val dz = cameraZ - SHIELD_Z
    return if (dz > 0) 0.5 * exp(-((dz - 10) / 20).pow(2)) else 0.39 * exp(-(dz / 3).pow(2))
  }
  /** The short flash of the whole picture at the pass. */
  fun flash(p: Double, cameraZ: Double): Double = if (p > 0 && p < 1) 0.12 * exp(-((cameraZ - SHIELD_Z) / 2.4).pow(2)) else 0.0

  // ---- The camera ----

  class Camera {
    var x = 0.0; var y = 0.0; var z = 0.0
    var lookX = 0.0; var lookY = 0.0; var lookZ = 0.0
    /** The turn about the view axis, radians, and the vertical field of view, degrees. */
    var roll = 0.0; var fov = FOV
  }

  private val tanHalf = tan(FOV / 2 * PI / 180)

  /** How far the camera stands for the whole word: the word takes the screen's width less the margins, whatever the
   *  screen's shape (`aspect` = width / height); on a very wide screen the word's height sets it. */
  fun wordDistance(total: Double, aspect: Double): Double =
    max(total / (2 * tanHalf * aspect * (1 - 2 * MARGIN)), 16.0 / (2 * tanHalf))

  /** How far the camera stands from N at the centre: N never wider than 0.7 of the screen, never farther than the word. */
  fun nDistance(total: Double, aspect: Double): Double =
    max(min(N_DISTANCE, wordDistance(total, aspect) * 0.8), 10.7 / (2 * tanHalf * aspect * 0.7))

  /** The camera's z on the way through the steps. */
  fun cameraZ(p: Double, nDistance: Double): Double = when {
    p < 1 -> N_NEAR + (nDistance - N_NEAR) * (1 - max(p, 0.0)).pow(1.7)
    p < 2 -> N_NEAR - 23.5 * ease(p - 1)
    else -> -18 - (p - 2) * 66
  }

  /** The progress at which the camera passes the honeycomb layer. */
  fun shieldPass(nDistance: Double): Double {
    if (nDistance <= SHIELD_Z + 1) return 0.05
    return clamp(1 - ((SHIELD_Z - N_NEAR) / (nDistance - N_NEAR)).pow(1 / 1.7), 0.05, 0.95)
  }

  /** The camera for the ident's time `t` and the progress `p`. `left` and `right` are the word's ends (N's middle is
   *  x 0), `clock` the running time (a slight sway on the way to N), `speed` the speed of the step (per second). */
  fun camera(t: Double, p: Double, clock: Double, speed: Double, left: Double, right: Double, aspect: Double, out: Camera) {
    val total = right - left
    val far = wordDistance(total, aspect)
    val near = nDistance(total, aspect)
    if (p <= 0) {
      val g = centring(t)
      val drift = 1 - 0.035 * min(t, CENTRE_START) / CENTRE_START
      val tx = lerp((left + right) / 2, 0.0, g)
      out.x = tx; out.y = N_Y + lerp(1.2, 0.4, g); out.z = lerp(far * drift, near, g)
      out.lookX = tx; out.lookY = N_Y; out.lookZ = 0.0
      out.roll = 0.0; out.fov = FOV
      return
    }
    val z = cameraZ(p, near)
    val rush = clamp(speed / 1.44, 0.0, 1.0)
    val sway = clamp(p * 4, 0.0, 1.0) * clamp(1 - p, 0.0, 1.0)
    out.x = sin(clock * 0.55) * 0.5 * sway
    out.y = lerp(N_Y + 0.4, N_Y, ease(p / 0.8)) + sin(clock * 0.43 + 1) * 0.2 * sway
    out.z = z
    out.lookX = out.x; out.lookY = N_Y + (out.y - lerp(N_Y + 0.4, N_Y, ease(p / 0.8))); out.lookZ = min(0.0, z - 10)
    out.roll = sin(clock * 0.5) * 0.012 * sway + rush * 0.05 * sin(p * 3.1) + (if (p >= 2) sin(PI * (p - 2) / 2) * 0.16 else 0.0)
    out.fov = FOV + FOV_RUSH * rush
  }

  // ---- The haptics: one long soft swell ----

  /** The swell begins exactly when the letters begin to crumble, is strongest while the last squares leave, and lets
   *  go as N comes to the centre. `SWELL_TOP` is its strength at the peak (0…1). */
  const val SWELL_START = CRUMBLE_START
  const val SWELL_PEAK = 3.7
  const val SWELL_END = CENTRED
  const val SWELL_TOP = 0.72

  /** The strength of the motor (0…1) at the ident's time: barely felt at first, growing slowly to the peak, then
   *  letting go slowly. No taps, no clicks. */
  fun haptic(t: Double): Double {
    if (t <= SWELL_START || t >= SWELL_END) return 0.0
    if (t < SWELL_PEAK) return SWELL_TOP * ((t - SWELL_START) / (SWELL_PEAK - SWELL_START)).pow(2.1)
    return SWELL_TOP * (1 - (t - SWELL_PEAK) / (SWELL_END - SWELL_PEAK)).pow(2.0)
  }

  // ---- When and how it is shown ----

  enum class Mode {
    /** No intro: straight to the sign-in screen. */
    NONE,
    /** The whole scene. */
    FULL,
    /** Four calm still stages (reduced motion, or a phone that cannot draw the scene). */
    STILLS,
  }

  /** Once per install, at a start with no session. With a screen reader on there is no intro at all (and it counts as
   *  seen — `seenWithoutShowing`). With motion reduced (the system's setting or the app's own), or where the phone
   *  cannot draw the scene, the still stages. */
  fun mode(seen: Boolean, hasSession: Boolean, motionAllowed: Boolean, screenReader: Boolean, canDrawScene: Boolean): Mode = when {
    seen || hasSession || screenReader -> Mode.NONE
    motionAllowed && canDrawScene -> Mode.FULL
    else -> Mode.STILLS
  }

  /** A first start with a screen reader on: the intro is marked seen without being shown. */
  fun seenWithoutShowing(seen: Boolean, hasSession: Boolean, screenReader: Boolean): Boolean = !seen && !hasSession && screenReader

  /** How many particles this phone gets: by its memory class (MB) and whether the system calls it a low-memory phone. */
  fun particleCount(memoryClass: Int, lowMemory: Boolean): Int = when {
    lowMemory || memoryClass < 192 -> 60_000
    memoryClass < 384 -> 100_000
    else -> 150_000
  }

  /** Fewer particles shine a little more each, so the picture keeps its light. */
  fun countGain(count: Int): Double = min(1.7, (150_000.0 / max(count, 1)).pow(0.6))
}

/** The person's way through the intro: the ident's clock, then four steps. Fed with the time that passed (`tick`) and
 *  the touches; it has no clock of its own, so it can be paused, kept across a new window, and tested.
 *
 *  A step, once started, completes by itself: a swipe up of any length (or a fling) starts the next step and it runs
 *  to its end; while the finger is down the step follows it (`scrub`), and letting go completes it — forward, if the
 *  finger moved up at all. A completed step never goes back. There is no way to skip. */
class IntroFlow(
  /** The still stages: no ident, no following of the finger, a calm cross-fade per step. */
  stills: Boolean = false,
) {
  var stills = stills
    private set

  companion object {
    /** What `tick` reports (bits). */
    const val SWELL = 1    // the letters begin to crumble: the haptic swell starts now
    const val PASS = 2     // the camera passes the honeycomb layer: one short tick
    const val FINISHED = 4 // the fourth step is complete: the sign-in screen comes out
  }

  /** The ident's time, s (stops at its end). */
  var t = if (stills) IntroModel.IDENT_END else 0.0
    private set
  /** The progress through the steps, 0…4. */
  var p = 0.0
    private set
  /** The steps completed. */
  var done = 0
    private set
  /** The speed of the progress, per second (only while a step runs by itself). */
  var speed = 0.0
    private set
  /** All the time that has passed, s: the scene's slow life. */
  var clock = 0.0
    private set
  /** The time since the ident ended, s (up to 2): the last squares finish leaving in it. */
  var past = 0.0
    private set
  /** The progress at which the camera passes the honeycomb layer (it depends on the screen's shape). */
  var passAt = IntroModel.shieldPass(IntroModel.N_DISTANCE)

  private var touching = false
  private var armed = false      // this touch may lead the step (it began after the ident, with no step running)
  private var movedUp = false    // the finger has been above where it came down
  private var running = false
  private var queued = false     // a swipe made while a step was running: the next step follows at once
  private var from = 0.0
  private var runTime = 0.0
  private var runLength = 0.0
  private var idle = 0.0
  private var passed = false
  private var pending = 0
  /** Frozen for a still picture (`freeze`). */
  var frozen = false
    private set

  val identOver: Boolean get() = t >= IntroModel.IDENT_END
  val finished: Boolean get() = done >= IntroModel.STEPS
  val stepRunning: Boolean get() = running

  /** «Проведи вверх» is on the screen: at once when the ident ends; after a completed step only when nothing has
   *  touched the screen for five seconds; never while a finger is down or a step is running. */
  val hintVisible: Boolean
    get() = identOver && !finished && !touching && !running && p == done.toDouble() &&
      idle >= (if (done == 0) 0.0 else IntroModel.HINT_IDLE)

  /** The scene cannot be drawn after all: the still stages from here (the ident, if it was still running, is over). */
  fun toStills() {
    if (stills) return
    stills = true
    if (!identOver) { t = IntroModel.IDENT_END; idle = 0.0 }
    if (!running) p = done.toDouble()
  }

  /** Frozen at a moment, for a still picture: the time of the ident or a progress. Nothing moves it. */
  fun freeze(time: Double, progress: Double) {
    frozen = true
    t = IntroModel.clamp(time, 0.0, IntroModel.IDENT_END)
    p = IntroModel.clamp(progress, 0.0, IntroModel.STEPS.toDouble())
    if (p > 0) t = IntroModel.IDENT_END
    done = p.toInt()
    clock = t + p * IntroModel.STEP_SECONDS
  }

  /** `dt` seconds have passed. Returns what happened in them (SWELL, PASS, FINISHED). */
  fun tick(dt: Double): Int {
    if (frozen || dt <= 0) return take()
    clock += dt
    if (!touching) idle += dt
    if (!identOver) {
      val before = t
      t = kotlin.math.min(IntroModel.IDENT_END, t + dt)
      if (before < IntroModel.CRUMBLE_START && t >= IntroModel.CRUMBLE_START) pending = pending or SWELL
      if (identOver) idle = 0.0
      return take()
    }
    past = kotlin.math.min(2.0, past + dt)
    if (running) {
      runTime += dt
      val u = IntroModel.clamp(runTime / runLength, 0.0, 1.0)
      val target = (done + 1).toDouble()
      val next = from + (target - from) * IntroModel.smoother(u)
      speed = (next - p) / dt
      move(next)
      if (u >= 1.0) {
        p = target; done += 1; running = false; speed = 0.0; idle = 0.0
        if (finished) pending = pending or FINISHED
        else if (queued) begin()
        queued = false
      }
    }
    return take()
  }

  private fun take(): Int { val events = pending; pending = 0; return events }

  private fun move(next: Double) {
    if (!stills && !passed && p < passAt && next >= passAt) { passed = true; pending = pending or PASS }
    p = next
  }

  private fun begin() {
    from = p
    val left = (done + 1) - p
    val whole = if (stills) IntroModel.STILL_SECONDS else IntroModel.STEP_SECONDS
    runLength = kotlin.math.max(IntroModel.STEP_SHORTEST, whole * left)
    runTime = 0.0
    running = true
  }

  /** A finger came down. */
  fun touchDown() {
    if (frozen) return
    touching = true; idle = 0.0; movedUp = false
    armed = identOver && !finished && !running
  }

  /** The finger is `up` of a step above where it came down (1 = a whole step; negative below). */
  fun drag(up: Double) {
    if (frozen || !touching) return
    idle = 0.0
    if (up > 0) movedUp = true
    if (armed && !stills) move(done + IntroModel.clamp(up, 0.0, 1.0))
  }

  /** The finger left the screen; `fling` — it left moving up fast. */
  fun touchUp(fling: Boolean = false) {
    if (frozen || !touching) return
    touching = false; idle = 0.0
    val forward = movedUp || fling
    if (armed) {
      armed = false
      if (forward || p > done) begin()
    } else if (forward && running && done + 1 < IntroModel.STEPS) {
      queued = true
    }
  }

  /** The touch was taken away (the app left the screen): as a finger that left without a fling. */
  fun touchCancel() = touchUp(false)
}
