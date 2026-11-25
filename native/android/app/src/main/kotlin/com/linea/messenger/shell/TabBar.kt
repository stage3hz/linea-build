package com.linea.messenger.shell

import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Color
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextPaint
import android.text.TextUtils
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import com.linea.messenger.R
import com.linea.messenger.avatars.DecorTicker
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Icons
import com.linea.messenger.design.Theme
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** One section as the bar knows it: its icon, its name for a screen reader and the list, what waits in it. */
data class TabEntry(val id: String, val label: String, val symbol: String, val badge: Int = 0, val dot: String = "")

/** A colour from `#RRGGBB`. */
private fun tabColor(hex: String): Int? {
  val text = hex.trim().removePrefix("#")
  if (text.length != 6) return null
  return text.toIntOrNull(16)?.let { 0xFF000000.toInt() or it }
}

// ChatsPlus: the reference's badgeText — exact up to 999, then «4,3K» (chatsplus/ChatListStatus.kt).
private fun badgeWords(count: Int): String = com.linea.messenger.chatsplus.ChatListStatus.badgeText(count)

/** ChatsPlus: each icon's own little motion on a tap (TabBar.tsx `TabIcon`): the gear turns once (760 ms, out-back
 *  1.7), the chat bubble hops (650 ms, out-quad: up 4 dp and 22 % larger at the top), any other icon wobbles. */
private fun tabKick(view: View, id: String) {
  val off = try { android.provider.Settings.Global.getFloat(view.context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f } catch (_: Exception) { false }
  if (off) return
  val d = view.resources.displayMetrics.density
  val gear = id == "profile"
  (view.getTag(R.id.action_more_sections) as? ValueAnimator)?.cancel()
  val kick = ValueAnimator.ofFloat(0f, 1f).apply {
    duration = if (gear) 760 else 650
    interpolator = android.view.animation.LinearInterpolator()
    addUpdateListener {
      val t = it.animatedValue as Float
      if (gear) {
        val s = 1.7f; val u = 1 - t
        view.rotation = (1 - u * u * ((s + 1) * u - s)) * 360f
      } else {
        val k = 1 - (1 - t) * (1 - t)
        val bump = Math.sin(k * Math.PI).toFloat()
        if (id == "chats") {
          view.translationY = -bump * 4f * d
          view.scaleX = 1 + bump * 0.22f; view.scaleY = 1 + bump * 0.22f
        } else {
          view.rotation = Math.sin(k * Math.PI * 2).toFloat() * 18f
          view.scaleX = 1 + bump * 0.3f; view.scaleY = 1 + bump * 0.3f
        }
      }
    }
    addListener(object : android.animation.AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: android.animation.Animator) { view.rotation = 0f; view.translationY = 0f; view.scaleX = 1f; view.scaleY = 1f }
    })
  }
  view.setTag(R.id.action_more_sections, kick)
  kick.start()
}

private const val BADGE_RED = 0xFFFF4D5E.toInt()
private const val WHITE = 0xFFFFFFFF.toInt()

/** Look 9's numbers (the same in iOS Shell/TabBar.swift `TabFlow`): the sketch «2. Сияние» — three lights rising from
 *  the bar's lower edge (`.aur`: radial-gradient(46% 70% at 50% 100%, #ff5fb0cc, transparent 70%), the same 40% 60% at
 *  34% #7a2cffaa and at 68% #35d6ffaa, blur 14px over a box 150 tall for a bar 96 tall), and a white 54×3 line on the
 *  top edge above the chosen tab with a glow of the centre light's colour. The hues then drift for good; the music
 *  and the phone's movement move the lights. */
internal object TabFlow {
  /** The look's number (the default). */
  const val LOOK = 9
  /** The sketch's colours as hue, saturation, brightness — left (violet #7a2cff), centre (pink #ff5fb0, under the
   *  chosen tab), right (cyan #35d6ff): the very first state; from there the hues drift on (`hues`). */
  val HUE0 = doubleArrayOf(0.7283, 0.9156, 0.5338)
  val SATURATION = floatArrayOf(0.827f, 0.627f, 0.792f)
  const val BRIGHTNESS = 1f
  /** The sketch's alphas (cc, aa, aa), before the music. */
  val ALPHA = floatArrayOf(0.667f, 0.8f, 0.667f)
  /** The most a light's heart gets. */
  const val ALPHA_MAX = 0.95f
  /** Where the side lights stand (× the bar's width); the centre one stands under the chosen tab (the middle without one). */
  val SIDE_AT = floatArrayOf(0.34f, 0.68f)
  /** Visible half-width (× the bar's width) and height (× the bar's height) of each light: 0.7 of the sketch's radii
   *  (the gradient is clear at 70 %), the box 150/96 of the bar. */
  val REACH_X = floatArrayOf(0.28f, 0.322f, 0.28f)
  val REACH_Y = floatArrayOf(0.656f, 0.766f, 0.656f)
  /** The sketch's 14 px blur, as extra reach (× the bar's height) and a soft fall: alpha × `FALL` at `STOPS`. */
  const val BLUR_REACH = 0.22f
  val STOPS = floatArrayOf(0f, 0.3f, 0.55f, 0.8f, 1f)
  val FALL = floatArrayOf(1f, 0.85f, 0.55f, 0.2f, 0f)
  /** The line on the top edge: white; its glow the centre's colour, lightened, at 0.8. Half the sketch's size by the
   *  owner's rule (the sketch: 54×3, box-shadow 0 0 18px 5px). */
  const val LINE_WIDTH = 27f
  const val LINE_HEIGHT = 1.5f
  const val LINE_GLOW = 0.8f
  const val LINE_BLUR = 9f
  const val LINE_SPREAD = 2.5f
  /** How much white is mixed into the line's glow (#ff5fb0 → about #ff8cc6). */
  const val LINE_WHITE = 0.3f
  const val GRAIN = 0.08f

  // The colours' drift: all three hues turn together at an uneven pace — one turn of the circle in about 3 minutes, the
  // pace swinging ±40 % by three slow sines of incommensurate periods (so it never repeats) — and each light wanders
  // ±0.07 of the circle around its place by two slow sines of its own; the lights stay at least 60° apart. The clock
  // and the turn are kept on the device: the next launch goes on from them.
  const val TURN_RATE = 1.0 / 180
  const val PACE_SWING = 0.4
  /** (period s, weight, phase in turns). */
  val PACE = arrayOf(doubleArrayOf(71.0, 1.0, 0.0), doubleArrayOf(113.0, 0.6, 1.3), doubleArrayOf(29.0, 0.35, 0.4))
  const val WANDER_AMOUNT = 0.07
  val WANDER = arrayOf(
    arrayOf(doubleArrayOf(53.0, 1.0, 0.0), doubleArrayOf(89.0, 0.5, 0.0)),
    arrayOf(doubleArrayOf(67.0, 1.0, 0.0), doubleArrayOf(131.0, 0.5, 0.0)),
    arrayOf(doubleArrayOf(47.0, 1.0, 0.0), doubleArrayOf(101.0, 0.5, 0.0)),
  )
  const val APART = 1.0 / 6
  const val STORE_KEY = "linea.tabflow.v1"

  /** A smooth value in −1…1: the weighted sum of sines. */
  fun noise(time: Double, parts: Array<DoubleArray>): Double {
    var sum = 0.0; var total = 0.0
    for (part in parts) { sum += part[1] * sin(2 * PI * (time / part[0] + part[2])); total += part[1] }
    return if (total > 0) sum / total else 0.0
  }

  /** How fast the common turn goes at `time` (turns a second). */
  fun turnSpeed(time: Double): Double = TURN_RATE * (1 + PACE_SWING * noise(time, PACE))

  /** The three hues (0…1: left, centre, right) at `time` seconds of the clock with the common turn at `turn`. */
  fun hues(time: Double, turn: Double, out: DoubleArray) {
    for (light in 0 until 3) out[light] = HUE0[light] + turn + WANDER_AMOUNT * noise(time, WANDER[light])
    // Never closer than 60°: two that come nearer are pushed apart, each half of the way.
    repeat(3) {
      for (pair in PAIRS) {
        val a = pair[0]; val b = pair[1]
        var gap = out[b] - out[a]
        gap -= floor(gap + 0.5)
        if (abs(gap) < APART) {
          val push = (APART - abs(gap)) / 2 * (if (gap < 0) -1 else 1)
          out[a] -= push; out[b] += push
        }
      }
    }
    for (light in 0 until 3) out[light] -= floor(out[light])
  }
  private val PAIRS = arrayOf(intArrayOf(0, 1), intArrayOf(1, 2), intArrayOf(0, 2))

  // The music, by bands: the left light follows the mids, the centre one the bass, the right one the highs. (The
  // platform's MediaPlayer gives no sound to measure without the microphone permission: here each band is a beat
  // of its own from the playback's position — `synthetic`.) What a full level does to each light: brighter, taller,
  // wider; how far (× the bar's width) and how fast (Hz) it sways — the mids slowly, the highs as a quick shimmer.
  val PUNCH_ALPHA = floatArrayOf(0.45f, 0.6f, 0.45f)
  val PUNCH_TALL = floatArrayOf(0.3f, 0.4f, 0.2f)
  val PUNCH_WIDE = floatArrayOf(0.12f, 0.2f, 0.1f)
  val SWAY_WIDTH = floatArrayOf(0.04f, 0f, 0.015f)
  val SWAY_RATE = doubleArrayOf(0.5, 0.0, 6.0)


  /** The person's own colour («Свечение панели» › «Свой цвет», `BarGlow`): all three lights in it, no drift — the centre
   *  the colour itself, the left a little deeper (more saturated, darker), the right a little paler and brighter, so the
   *  one colour still reads as three lights. Written into `out` (left, centre, right), opaque. */
  const val OWN_LEFT_SATURATION = 1.12f
  const val OWN_LEFT_BRIGHTNESS = 0.78f
  const val OWN_RIGHT_SATURATION = 0.72f
  const val OWN_RIGHT_LIFT = 0.12f

  fun ownTones(color: Int, out: IntArray) {
    val hsv = FloatArray(3)
    Color.colorToHSV(color, hsv)
    out[0] = Color.HSVToColor(floatArrayOf(hsv[0], min(1f, hsv[1] * OWN_LEFT_SATURATION), hsv[2] * OWN_LEFT_BRIGHTNESS))
    out[1] = color or 0xFF000000.toInt()
    out[2] = Color.HSVToColor(floatArrayOf(hsv[0], hsv[1] * OWN_RIGHT_SATURATION, min(1f, hsv[2] + OWN_RIGHT_LIFT)))
  }

  /** A level for light `light` from the playback's position: the bass a kick on every beat (120 a minute), the mids a
   *  hit on the off-beats over a slow swell, the highs a quick tick on every eighth, shimmering. */
  fun synthetic(position: Double, light: Int): Double = when (light) {
    1 -> { val beat = position * 2; 0.2 + 0.75 * exp(-(beat - floor(beat)) * 6) }
    0 -> {
      val beat = position + 0.5
      val swell = 0.5 + 0.5 * sin(2 * PI * position * 0.23)
      min(1.0, 0.2 + 0.5 * exp(-(beat - floor(beat)) * 4) + 0.25 * swell)
    }
    else -> {
      val beat = position * 4
      val shimmer = 0.5 + 0.5 * sin(2 * PI * position * 0.37)
      min(1.0, 0.15 + 0.45 * exp(-(beat - floor(beat)) * 10) * (0.5 + 0.5 * shimmer) + 0.2 * shimmer)
    }
  }
}

/** «Свечение панели» in «Оформление» (settings/AppearanceEffects.kt): look 9's lights on or off, and the person's own
 *  colour for them (null: the colours drift — «Переливается»). Kept on this device in the app's preferences store
 *  (ThemeStore's), under keys of their own; every bar follows at once (`changed`). The same in iOS Shell/TabBar.swift. */
object BarGlow {
  const val ON_KEY = "linea.bar-glow.v1"
  const val COLOR_KEY = "linea.bar-glow-color.v1"
  /** Posted on the main thread after every change. */
  val changed = com.linea.messenger.net.Live.Signal<Unit>()
  /** Without a store (a check that gave none) the choices live in memory. */
  private val memory = HashMap<String, String?>()
  /** A colour being tried (the picker under the finger): shown by the bar, not kept yet. */
  private var trying: String? = null

  private fun read(key: String): String? { val store = com.linea.messenger.settings.ThemeStore.kept; return if (store != null) store.get(key) else memory[key] }
  private fun write(key: String, value: String?) { val store = com.linea.messenger.settings.ThemeStore.kept; if (store != null) store.set(key, value) else memory[key] = value }

  /** The lights are on (the default). Off: the bar is plain glass — no lights, no line, no clock, no sensor. */
  var on: Boolean
    get() = read(ON_KEY) != "off"
    set(value) { write(ON_KEY, if (value) null else "off"); changed.post(Unit) }

  /** The own colour as `#RRGGBB`, or null for the drift. */
  var color: String?
    get() = trying ?: read(COLOR_KEY)?.let { normal(it) }
    set(value) { trying = null; write(COLOR_KEY, value?.let { normal(it) }); changed.post(Unit) }

  /** Shows `value` on the bar without keeping it (null: back to what is kept). */
  fun tryColor(value: String?) { trying = value?.let { normal(it) }; changed.post(Unit) }

  /** `#RRGGBB` in capitals from «RRGGBB» or «#rrggbb»; null for anything else. */
  fun normal(text: String): String? {
    val digits = text.trim().removePrefix("#")
    if (digits.length != 6 || digits.any { Character.digit(it, 16) < 0 }) return null
    return "#" + digits.uppercase(java.util.Locale.ROOT)
  }

  /** `#RRGGBB` of a colour. */
  fun hex(color: Int): String = String.format(java.util.Locale.ROOT, "#%06X", color and 0xFFFFFF)
}

/** Look 9's lights as a liquid sealed in the glass capsule (the same numbers in iOS Shell/TabBar.swift `TabLiquid`): each
 *  light is a blob along the bar with inertia — a spring to its place (0.9 Hz, damping ratio 0.25: it settles in a
 *  second or two), pushed by the phone's acceleration along the bar (the tilt's gravity and the hand's movement, in g,
 *  at most ±2.5 g), kept off its neighbours by a soft push, bouncing off the capsule's ends with half its speed left,
 *  squashing (taller and narrower for a moment, a 3 Hz spring) and brightening at the wall. Fixed steps of 1/120 s.
 *  Positions are × the bar's width, from each blob's place. Shape and brightness only: never the colour. */
internal class TabLiquid {
  companion object {
    const val FREQUENCY = 0.9
    const val ZETA = 0.25
    /** The bar's widths a second² for 1 g along the bar: a tilt of half the gravity leans a blob 12 % of the width. */
    const val GAIN = 7.7
    const val INPUT_MOST = 2.5
    /** How far a blob's middle may go (× the bar's width) before it meets the capsule's end. */
    const val WALL_LEFT = 0.12
    const val WALL_RIGHT = 0.88
    /** The speed left after a wall (the rest is lost). */
    const val BOUNCE = 0.55
    /** The closest two blobs' middles come (× the bar's width) before they push each other, and how hard. */
    const val GAP = 0.14
    const val PUSH = 400.0
    const val SPEED_MOST = 3.0
    const val SQUASH_FREQUENCY = 3.0
    const val SQUASH_ZETA = 0.35
    /** A wall turns this much of the blob's speed into squash (taller by SQUASH_TALL, narrower by SQUASH_WIDE at 1). */
    const val SQUASH_KICK = 1.6
    const val SQUASH_WIDE = 0.35
    const val SQUASH_TALL = 0.5
    /** A moving blob stands a little taller (the slosh), fully at this speed. */
    const val SLOSH_TALL = 0.12
    const val SLOSH_SPEED = 0.6
    /** A wall's flash: brighter by this much at its strongest, fading in FLASH_FADE s; full at an impact of 0.8. */
    const val FLASH = 0.5
    const val FLASH_FADE = 0.25
    const val STEP = 1.0 / 120
  }

  val offset = DoubleArray(3)
  private val speed = DoubleArray(3)
  private val squash = DoubleArray(3)
  private val squashSpeed = DoubleArray(3)
  private val glow = DoubleArray(3)
  private val accel = DoubleArray(3)
  private val order = intArrayOf(0, 1, 2)
  private var left = 0.0

  /** Nothing is moving. */
  val quiet: Boolean get() = (0 until 3).none { abs(offset[it]) > 0.002 || abs(speed[it]) > 0.002 || abs(squash[it]) > 0.01 || glow[it] > 0.01 }

  fun reset() { offset.fill(0.0); speed.fill(0.0); squash.fill(0.0); squashSpeed.fill(0.0); glow.fill(0.0); left = 0.0 }

  /** Runs the liquid on by `dt` seconds under `force` (g along the bar, + to the right) with the blobs' places `rest`. */
  fun advance(dt: Double, force: Double, rest: DoubleArray) {
    val pushed = force.coerceIn(-INPUT_MOST, INPUT_MOST)
    val omega = 2 * PI * FREQUENCY; val stiff = omega * omega; val damp = 2 * ZETA * omega
    val squashOmega = 2 * PI * SQUASH_FREQUENCY; val squashStiff = squashOmega * squashOmega; val squashDamp = 2 * SQUASH_ZETA * squashOmega
    // The blobs from left to right by their places (three: a tiny sort).
    order[0] = 0; order[1] = 1; order[2] = 2
    for (i in 0 until 2) for (j in 0 until 2 - i) if (rest[order[j]] > rest[order[j + 1]]) { val t = order[j]; order[j] = order[j + 1]; order[j + 1] = t }
    val fade = exp(-STEP / FLASH_FADE)
    left += dt
    var steps = 0
    while (left >= STEP && steps < 24) {
      left -= STEP
      steps += 1
      for (index in 0 until 3) accel[index] = GAIN * pushed - stiff * offset[index] - damp * speed[index]
      for (pair in 0 until 2) {
        val a = order[pair]; val b = order[pair + 1]
        val apart = (rest[b] + offset[b]) - (rest[a] + offset[a])
        if (apart < GAP) { val shove = PUSH * (GAP - apart); accel[a] -= shove; accel[b] += shove }
      }
      for (index in 0 until 3) {
        speed[index] = (speed[index] + accel[index] * STEP).coerceIn(-SPEED_MOST, SPEED_MOST)
        offset[index] += speed[index] * STEP
        val place = rest[index] + offset[index]
        if (place < WALL_LEFT && speed[index] < 0) hit(index, WALL_LEFT - rest[index])
        else if (place > WALL_RIGHT && speed[index] > 0) hit(index, WALL_RIGHT - rest[index])
        squashSpeed[index] += (-squashStiff * squash[index] - squashDamp * squashSpeed[index]) * STEP
        squash[index] += squashSpeed[index] * STEP
        glow[index] *= fade
      }
    }
    if (steps >= 24) left = 0.0
  }

  private fun hit(index: Int, place: Double) {
    val impact = abs(speed[index])
    offset[index] = place
    speed[index] = -speed[index] * BOUNCE
    squashSpeed[index] += impact * SQUASH_KICK
    glow[index] = max(glow[index], min(1.0, impact / 0.8))
  }

  fun wide(index: Int): Float = (1 - SQUASH_WIDE * squash[index].coerceIn(-1.0, 1.0)).toFloat()
  fun tall(index: Int): Float = (1 + SQUASH_TALL * squash[index].coerceIn(-1.0, 1.0) + SLOSH_TALL * min(1.0, abs(speed[index]) / SLOSH_SPEED)).toFloat()
  fun bright(index: Int): Float = (1 + FLASH * glow[index]).toFloat()
}

/** A small tile of random grey, made once, for the grain over the glow (a gradient reads as material, without bands). */
private val tabNoise: Bitmap by lazy {
  val side = 96
  val random = java.util.Random(7)
  val pixels = IntArray(side * side) { val v = random.nextInt(256); Color.rgb(v, v, v) }
  Bitmap.createBitmap(pixels, side, side, Bitmap.Config.ARGB_8888)
}

/** What the bar draws with: white on a dark theme, black on a light one, as the iPhone's bar (`setDark`). */
private val ink: Int get() = if (Theme.dark) WHITE else 0xFF000000.toInt()

/** One icon of the bar; an accessibility element of its own. */
@SuppressLint("ViewConstructor")
private class TabIconView(context: Context) : View(context) {
  var symbol = ""
  var on = false
  var badge = ""
  var dot: Int? = null
  /** The name of the extra action of the first tab («Остальные разделы») and what it does. */
  var moreWords = ""
  var onMore: (() -> Unit)? = null

  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val words = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10f * d; typeface = Theme.weight(700); textAlign = Paint.Align.CENTER; color = WHITE }

  override fun onDraw(canvas: Canvas) {
    val midX = width / 2f; val midY = height / 2f
    Icons.draw(canvas, symbol, midX, midY, 27f * d, Theme.alpha(ink, if (on) 1f else 0.58f), filled = on)
    if (badge.isNotEmpty()) {
      val wide = max(18f * d, words.measureText(badge) + 10f * d)
      fill.color = BADGE_RED
      canvas.drawRoundRect(midX + 4f * d, midY - 22f * d, midX + 4f * d + wide, midY - 4f * d, 9f * d, 9f * d, fill)
      canvas.drawText(badge, midX + 4f * d + wide / 2, midY - 13f * d - (words.ascent() + words.descent()) / 2, words)
    } else dot?.let { fill.color = it; canvas.drawCircle(midX + 13f * d, midY - 13f * d, 4f * d, fill) }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.isSelected = on
    if (onMore != null && moreWords.isNotEmpty()) info.addAction(AccessibilityNodeInfo.AccessibilityAction(R.id.action_more_sections, moreWords))
  }

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    if (action == R.id.action_more_sections) { onMore?.invoke(); return true }
    return super.performAccessibilityAction(action, arguments)
  }
}

/** One row of the list of sections. */
@SuppressLint("ViewConstructor")
private class TabRowView(context: Context, val entry: TabEntry) : View(context) {
  var lit = false
    set(value) { if (field != value) { field = value; invalidate() } }

  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val label = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 16f * d; typeface = Theme.weight(600) }
  private val count = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; typeface = Theme.weight(700); textAlign = Paint.Align.CENTER; color = WHITE }

  init { contentDescription = if (entry.badge > 0) "${entry.label}, ${entry.badge}" else entry.label }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (lit) { fill.color = Theme.alpha(ink, if (Theme.dark) 0.14f else 0.08f); canvas.drawRoundRect(0f, 0f, w, h, 16f * d, 16f * d, fill) }
    Icons.draw(canvas, entry.symbol, 24f * d, h / 2, 21f * d, Theme.alpha(ink, if (lit) 1f else 0.62f))
    var badgeWidth = 0f
    if (entry.badge > 0) {
      val text = badgeWords(entry.badge)
      badgeWidth = max(20f * d, count.measureText(text) + 12f * d)
      fill.color = BADGE_RED
      canvas.drawRoundRect(w - 10f * d - badgeWidth, h / 2 - 10f * d, w - 10f * d, h / 2 + 10f * d, 10f * d, 10f * d, fill)
      canvas.drawText(text, w - 10f * d - badgeWidth / 2, h / 2 - (count.ascent() + count.descent()) / 2, count)
    }
    label.color = Theme.alpha(ink, if (lit) 1f else 0.72f)
    val shown = TextUtils.ellipsize(entry.label, label, w - 48f * d - badgeWidth - 16f * d, TextUtils.TruncateAt.END)
    canvas.drawText(shown, 0, shown.length, 48f * d, h / 2 - (label.ascent() + label.descent()) / 2, label)
  }
}

/** The list of the sections that have no icon in the bar. Lies over the whole window, above everything. */
@SuppressLint("ViewConstructor")
private class TabListOverlay(context: Context, entries: List<TabEntry>, behind: GlassSource?) : ViewGroup(context) {
  var onPick: (TabEntry) -> Unit = {}
  var onClose: () -> Unit = {}
  /** The list takes taps itself: on a row — open it, beside — close the list. Otherwise the finger that opened
   *  it is still down and the bar tells the list what is lit. */
  var sticky = false
  var lit = ""
    private set

  private val d = resources.displayMetrics.density
  private val rows = entries.map { TabRowView(context, it) }
  private var anchorLeft = 0
  private var anchorTop = 0
  private var anchorWidth = 0

  /** The plate the rows stand on. */
  private val panel = object : ViewGroup(context) {
    val glass = Glass(this).apply { source = behind }
    init { setWillNotDraw(false) }
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
      val row = (ROW_DP * d).toInt(); val inset = (6f * d).toInt()
      rows.forEachIndexed { index, view ->
        view.measure(MeasureSpec.makeMeasureSpec(right - left - 2 * inset, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(row, MeasureSpec.EXACTLY))
        view.layout(inset, inset + index * row, right - left - inset, inset + (index + 1) * row)
      }
    }
    override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 24f * d)
  }

  init {
    for (row in rows) {
      // For a screen reader and a keyboard; a finger is handled by the overlay as a whole.
      row.setOnClickListener { onPick(row.entry) }
      panel.addView(row)
    }
    addView(panel)
  }

  /** The panel stands above the bar (its corner and width in this view's coordinates), centred on it. */
  fun place(barLeft: Int, barTop: Int, barWidth: Int) {
    anchorLeft = barLeft; anchorTop = barTop; anchorWidth = barWidth
    requestLayout()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val wide = (WIDTH_DP * d).toInt(); val tall = (rows.size * ROW_DP * d + 12f * d).toInt(); val edge = (8f * d).toInt()
    val x = min(max(edge, anchorLeft + anchorWidth / 2 - wide / 2), max(edge, right - left - wide - edge))
    val y = anchorTop - (12f * d).toInt() - tall
    panel.measure(MeasureSpec.makeMeasureSpec(wide, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(tall, MeasureSpec.EXACTLY))
    panel.layout(x, y, x + wide, y + tall)
  }

  /** The entry whose row is under a point (this view's coordinates), with a little room at the sides. */
  fun entryAt(x: Float, y: Float): TabEntry? {
    val px = x - panel.left; val py = y - panel.top; val room = 40f * d
    return rows.firstOrNull { px >= it.left - room && px <= it.right + room && py >= it.top && py < it.bottom }?.entry
  }

  fun light(id: String) {
    if (id == lit) return
    lit = id
    for (row in rows) row.lit = row.entry.id == id
  }

  /** Takes a screen reader to the first row. */
  fun focusFirst() { rows.firstOrNull()?.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null) }

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean = true

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (!sticky) return false
    if (event.actionMasked == MotionEvent.ACTION_UP) {
      val entry = entryAt(event.x, event.y)
      if (entry != null) onPick(entry) else onClose()
    }
    return true
  }

  companion object { const val ROW_DP = 44f; const val WIDTH_DP = 216f }
}

/** The phone's tab bar, drawn and driven by plain views.
 *  - The bar is a plate of glass (see Glass: the page behind it, blurred, on Android 12 and later): dark on a dark
 *    theme, light with dark icons on a light one.
 *  - The chosen tab stands on a light capsule; choosing another tab sends the capsule there with a spring and a
 *    faint second capsule follows a little late and fades — the trail.
 *  - A light lives in the glass (look 9, the default, `TabFlow`; the sketch «2. Сияние»): violet at the left, pink
 *    under the chosen tab (the bar's middle in a section without an icon), cyan at the right, rising from the lower
 *    edge over the glass's fill and under its rim, and a white line on the top edge above the chosen tab glowing in
 *    the centre's colour. The hues drift on slowly and never repeat (kept across launches). With music the lights
 *    punch and sway by bands (bass the centre, mids the left, highs the right); the platform's MediaPlayer gives no
 *    sound to measure (only the Visualizer would, and it asks for the microphone), so each band is a beat of its own
 *    from the playback's position. The lights are a liquid sealed in the capsule (`TabLiquid`): the tilt leans them to
 *    the low side, a shake sloshes them from end to end, bouncing off the capsule's ends (the accelerometer, no
 *    permission). One frame clock (DecorTicker) and the sensor only while the bar is shown and animations are on (the
 *    sensor also rests in power saving); otherwise the gradient holds still. «Оформление» › «Свечение панели» (`BarGlow`)
 *    turns the lights off (plain glass, no line, no clock, no sensor) or gives all three one own colour (no drift). Looks 0 (the first three lights, still) and 6 (a small halo behind the
 *    chosen icon) stay for comparison: `--es barlook N` in the debug build.
 *  - The first tab also holds the other sections: hold it (or move the finger up from it) and their list appears
 *    above the bar; the row under the finger is lit, letting go on a row opens it. A plain hold leaves the list
 *    open: a tap on a row opens it, a tap beside closes the list.
 *  The owner gives the items and the open section and hears `onSelect` / `onPreview`. */
class TabBarView(context: Context) : ViewGroup(context) {
  /** A section was chosen: by a tap on its icon or from the list. */
  var onSelect: (id: String) -> Unit = {}
  /** The finger rests on a row of the list: the page behind shows that section for a look ("" = back to the
   *  section that was open). */
  var onPreview: (id: String) -> Unit = {}
  /** The list of sections opened or closed. */
  var onListChange: (open: Boolean) -> Unit = {}
  /** What a screen reader calls the first tab's extra action: opening the list. */
  var moreWords = ""
    set(value) { field = value; paintIcons() }
  /** The page the bar's glass shows blurred. */
  var behind: GlassSource?
    get() = glass.source
    set(value) { glass.source = value; invalidate() }
  val listOpen: Boolean get() = overlay != null

  private val d = resources.displayMetrics.density
  private val glass = Glass(this)
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = max(1f, d) }
  private val lights = Array(3) { Paint(Paint.ANTI_ALIAS_FLAG) }
  /** The grain over look 9's lights. */
  private val grain = Paint().apply {
    shader = BitmapShader(tabNoise, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply { setLocalMatrix(Matrix().apply { setScale(d, d) }) }
    xfermode = PorterDuffXfermode(PorterDuff.Mode.OVERLAY)
    alpha = (255 * TabFlow.GRAIN).toInt()
  }
  /** Look 9's frame clock: on while the bar is in a window and shown and the look is on (DecorTicker stops it while
   *  the app's animations are off or the system saves power). */
  private val clock = DecorTicker.Link(this)
  /** Which glow look is on: 9 (`TabFlow`), the owner's choice; 0 and 6 stay for comparison (any other number draws 9). */
  var look: Int = normalLook(demoLook ?: TabFlow.LOOK)
    set(value) { field = normalLook(value); flowKeys.fill(-1L); paintGlow(); clock.want(flowWanted); refreshSensors() }
  /** «Свечение панели» (`BarGlow`): look 9's lights on, and the own colour of all three (null: the drift). */
  private var glowOn = BarGlow.on
  private var ownColor: Int? = BarGlow.color?.let { tabColor(it) }
  /** Look 9 is drawn and moves: its clock and its sensor may run. */
  private val flowWanted: Boolean get() = look == TabFlow.LOOK && glowOn
  private val glowListener: (Unit) -> Unit = { readGlow() }
  // Look 9's state: the drift's clock (seconds) and the common turn (kept across launches); the music's bands (left =
  // mids, centre = bass, right = highs: levels 0…1 smoothed) and how much of the music shows; the wave's own copy of
  // the playback's position; the lights as a liquid moved by the phone, and the push along the bar (g, + right).
  private var flowTime = 0.0
  private var flowTurn = 0.0
  private var flowLast = 0L
  private val waveLevel = DoubleArray(3)
  private var waveAmount = 0.0
  private var waveClock = 0.0
  private var waveSeen = -1.0
  private val liquid = TabLiquid()
  private val liquidRest = DoubleArray(3)
  private var liquidForce = 0.0
  private val hues = DoubleArray(3)
  /** The three lights' colours of this moment (left, centre, right). */
  private val flowColors = IntArray(3)
  /** The colour each light's gradient was made for (3: the line's glow; −1: none yet): made again only when it changes. */
  private val flowKeys = LongArray(4) { -1L }
  private val lineGlow = Paint(Paint.ANTI_ALIAS_FLAG)
  private val lineFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = WHITE }
  private val stopColors = IntArray(5)
  private var attachedNow = false
  private var shownNow = true
  private var sensing = false
  private var frames = 0
  private val sensorListener = object : android.hardware.SensorEventListener {
    override fun onSensorChanged(event: android.hardware.SensorEvent) {
      // The push on the liquid along the bar (g, + to the right): this sensor reads the hand's movement less the
      // gravity, so the tilt's gravity and the lag behind the hand both come out with the sign turned.
      val along = -event.values[0] / android.hardware.SensorManager.GRAVITY_EARTH
      liquidForce += (along - liquidForce) * 0.5
    }
    override fun onAccuracyChanged(sensor: android.hardware.Sensor?, accuracy: Int) {}
  }
  /** Look 9 draws the lights inside the glass (over its fill, under its rim). */
  private val insideGlass: (Canvas) -> Unit = { canvas -> drawLights(canvas, width.toFloat(), height.toFloat()) }
  private val clip = Path()
  private var icons: List<TabIconView> = emptyList()

  private var items: List<TabEntry> = emptyList()
  private var bar: List<String> = emptyList()
  private var active = ""
  private var glow: List<Int> = emptyList()
  private var laidOut = 0L

  // What is drawn now; animators move these.
  private var capsuleX = 0f
  private var capsuleAlpha = 0f
  private var spotX = 0f
  private var trailX = 0f
  private var trailAlpha = 0f
  private var liftScale = 1f
  private val running = arrayOfNulls<ValueAnimator>(6)

  // The touch in progress.
  private val timers = Handler(Looper.getMainLooper())
  private val holdTimer = Runnable { openList(sticky = false) }
  private var previewTimer: Runnable? = null
  private var overlay: TabListOverlay? = null
  private var overlaySticky = false
  private var previewed = ""
  private val here = IntArray(2)
  private val there = IntArray(2)

  private val touch = BarTouch(object : BarTouch.Host {
    override val barWidth get() = width.toFloat()
    override val barHeight get() = height.toFloat()
    override val tabCount get() = bar.size
    override val hasOthers get() = others.isNotEmpty()
    override val listOpen get() = overlay != null
    override val listSticky get() = overlaySticky
    override fun lift(on: Boolean) = this@TabBarView.lift(on)
    override fun hold(start: Boolean) { timers.removeCallbacks(holdTimer); if (start) timers.postDelayed(holdTimer, BarTouch.HOLD_MS) }
    override fun openList(sticky: Boolean) = this@TabBarView.openList(sticky)
    override fun rowAt(x: Float, y: Float): String? {
      val list = overlay ?: return null
      getLocationInWindow(here); list.getLocationInWindow(there)
      return list.entryAt(x + here[0] - there[0], y + here[1] - there[1])?.id
    }
    override fun light(id: String?) = this@TabBarView.light(id)
    override fun pick(id: String) { entry(id)?.let { this@TabBarView.pick(it) } }
    override fun closeList(restore: Boolean) = this@TabBarView.closeList(restore)
    override fun stick() = this@TabBarView.stick()
    override fun choose(index: Int) = this@TabBarView.choose(index)
  }, d)

  init {
    setWillNotDraw(false)
    clipChildren = false
    paintGlow()
    clock.want(flowWanted)
    restoreFlow()
  }

  companion object {
    /** The debug build's `--es barlook N`: the look of the bars made from now on. */
    var demoLook: Int? = null
    private fun normalLook(value: Int): Int = if (value == 0 || value == 6) value else TabFlow.LOOK
  }

  // MARK: What the owner sets

  fun setItems(next: List<TabEntry>) {
    if (next == items) return
    items = next
    rebuildIcons()
  }

  fun setBar(next: List<String>) {
    if (next == bar) return
    bar = next
    rebuildIcons()
  }

  fun setActive(id: String) {
    if (id == active) return
    val before = activeIndex
    active = id
    paintIcons()
    moveCapsule(before, animated = laidOut != 0L)
  }

  /** Three colours of the playing track's cover (centre, left, right) as `#RRGGBB`; none = the calm silver. */
  fun setGlow(hexes: List<String>) {
    val next = hexes.mapNotNull { tabColor(it) }
    if (next == glow) return
    glow = next
    paintGlow()
  }

  // MARK: Layout

  private val activeIndex: Int get() = bar.indexOf(active)
  private val cell: Float get() = if (bar.isEmpty()) 0f else width.toFloat() / bar.size
  private fun capsuleLeft(index: Int): Float = max(0, index) * cell + 4f * d
  private fun spotCentre(index: Int): Float = if (index < 0) width / 2f else (index + 0.5f) * cell

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val w = right - left; val h = bottom - top
    if (w <= 0 || h <= 0) return
    icons.forEachIndexed { index, icon ->
      val from = (index * cell).toInt(); val to = ((index + 1) * cell).toInt()
      icon.measure(MeasureSpec.makeMeasureSpec(to - from, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
      icon.layout(from, 0, to, h)
    }
    val size = (w.toLong() shl 32) or h.toLong()
    if (size == laidOut) return
    laidOut = size
    moveCapsule(activeIndex, animated = false)
  }

  // MARK: Looks

  private fun paintGlow() {
    if (look == TabFlow.LOOK) { flowKeys.fill(-1L); invalidate(); return } // made as it is drawn (flowShader)
    // Calm: a cool silver. With colours (a track's cover): centre, left, right.
    val coloured = glow.size == 3
    val dark = Theme.dark
    val colors = if (coloured) glow
      else if (dark) listOf(0xFFE8EDF5.toInt(), 0xFF808FA8.toInt(), 0xFFC9D1E0.toInt())
      else listOf(0xFF8F99AD.toInt(), 0xFFB5BDCC.toInt(), 0xFF99A6B8.toInt())
    val strength = if (coloured) 1f else if (dark) 0.7f else 0.45f
    if (look == 0) {
      // The first look: each light in a square of one unit, stretched to its place: bright at the bar's lower edge.
      for (index in 0 until 3) {
        val color = colors[index]
        lights[index].shader = RadialGradient(0f, 0f, 1f, Theme.alpha(color, (if (index == 0) 0.8f else 0.6f) * strength), Theme.alpha(color, 0f), Shader.TileMode.CLAMP)
      }
      invalidate()
      return
    }
    // Look 6: one small round glow right behind the chosen icon; a track's colour a little softened.
    val hsv = FloatArray(3)
    Color.colorToHSV(colors[0], hsv)
    if (coloured) hsv[1] *= 0.8f
    val color = Color.HSVToColor(hsv)
    lights[0].shader = RadialGradient(0f, 0f, 1f, Theme.alpha(color, 0.55f * strength), Theme.alpha(color, 0f), Shader.TileMode.CLAMP)
    invalidate()
  }

  private fun shine(canvas: Canvas, left: Float, wide: Float, paint: Paint, tall: Float = height.toFloat()) {
    canvas.save()
    canvas.translate(left + wide / 2, height.toFloat())
    canvas.scale(wide / 2, tall)
    canvas.drawRect(-1f, -1f, 1f, 0f, paint)
    canvas.restore()
  }

  /** Look 9: moves its clock on by the time since the last frame (nothing while the clock is off: the colours stay
   *  where they stood, the music and the hand let go). */
  private fun stepFlow() {
    if (!(DecorTicker.allowed && DecorTicker.ticking(this))) {
      if (flowLast != 0L) storeFlow()
      flowLast = 0L; waveLevel.fill(0.0); waveAmount = 0.0
      if (sensing) refreshSensors()
      return
    }
    val now = SystemClock.uptimeMillis()
    val dt = if (flowLast == 0L) 1.0 / 60 else ((now - flowLast) / 1000.0).coerceIn(0.0, 0.1)
    flowLast = now
    if (dt <= 0.0) return
    frames += 1
    if (frames % 30 == 1) refreshSensors()
    flowTime += dt
    flowTurn += TabFlow.turnSpeed(flowTime) * dt
    flowTurn -= floor(flowTurn)
    if (flowTime > 1_000_000) flowTime = 0.0
    val player = com.linea.messenger.music.MusicPlayer.shared
    val playing = player.playing
    if (playing) {
      // The wave's own clock follows the playback: set again when the player's position moves somewhere else (a seek,
      // a new track), runs on by itself between the player's updates and where its position stands still.
      waveClock += dt
      val position = player.position
      if (position != waveSeen) {
        if (abs(position - waveClock) > 0.6) waveClock = position
        waveSeen = position
      }
    }
    // Each band rises quickly and falls slowly; the whole music fades in and out with playback.
    for (index in 0 until 3) {
      val target = if (playing) TabFlow.synthetic(waveClock, index) else 0.0
      val rate = if (target > waveLevel[index]) 0.05 else 0.22
      waveLevel[index] += (target - waveLevel[index]) * (1 - exp(-dt / rate))
    }
    waveAmount += ((if (playing) 1.0 else 0.0) - waveAmount) * (1 - exp(-dt / 0.6))
    // The liquid: pushed along the bar by the tilt's gravity and against the hand's movement.
    val w = width.toFloat()
    liquidRest[0] = TabFlow.SIDE_AT[0].toDouble(); liquidRest[2] = TabFlow.SIDE_AT[1].toDouble()
    liquidRest[1] = if (w > 0f) (spotX / w).toDouble() else 0.5
    liquid.advance(dt, if (sensing) liquidForce else 0.0, liquidRest)
  }

  /** The accelerometer runs only while look 9 moves on the screen and power is not being saved. */
  private fun refreshSensors() {
    val want = flowWanted && attachedNow && shownNow && DecorTicker.allowed && !com.linea.messenger.effects.Motion.saving
    if (want == sensing) return
    val manager = context.getSystemService(Context.SENSOR_SERVICE) as? android.hardware.SensorManager
    if (want) {
      val sensor = manager?.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER) ?: return
      liquidForce = 0.0
      // GAME (about 50 a second): a shake is quick; UI's 16 a second would miss most of it.
      sensing = manager.registerListener(sensorListener, sensor, android.hardware.SensorManager.SENSOR_DELAY_GAME, Handler(Looper.getMainLooper()))
    } else {
      manager?.unregisterListener(sensorListener)
      sensing = false
      liquidForce = 0.0; liquid.reset()
    }
  }

  /** The drift's clock and turn, kept for the next launch. */
  private fun storeFlow() {
    try { context.getSharedPreferences("linea.shell", Context.MODE_PRIVATE).edit().putString(TabFlow.STORE_KEY, "$flowTime,$flowTurn").apply() } catch (_: Exception) {}
  }

  private fun restoreFlow() {
    val kept = try { context.getSharedPreferences("linea.shell", Context.MODE_PRIVATE).getString(TabFlow.STORE_KEY, null) } catch (_: Exception) { null } ?: return
    val parts = kept.split(",").mapNotNull { it.toDoubleOrNull()?.takeIf { value -> value.isFinite() } }
    if (parts.size != 2) return
    flowTime = max(0.0, parts[0])
    flowTurn = parts[1] - floor(parts[1])
  }

  /** «Свечение панели» changed in «Оформление»: the bar follows at once. */
  private fun readGlow() {
    val on = BarGlow.on
    val own = BarGlow.color?.let { tabColor(it) }
    if (on == glowOn && own == ownColor) return
    glowOn = on; ownColor = own
    flowKeys.fill(-1L)
    clock.want(flowWanted)
    refreshSensors()
    invalidate()
  }

  /** The three lights' colours of this moment into `flowColors`: the person's own colour (`TabFlow.ownTones`), or the
   *  drifting hues (in 1° steps, so a gradient is made again only when its colour moves). */
  private fun flowColorsNow() {
    val own = ownColor
    if (own != null) { TabFlow.ownTones(own, flowColors); return }
    TabFlow.hues(flowTime, flowTurn, hues)
    for (light in 0 until 3) {
      val step = (hues[light] * 360).toInt() % 360
      flowColors[light] = Color.HSVToColor(floatArrayOf(step.toFloat(), TabFlow.SATURATION[light], TabFlow.BRIGHTNESS))
    }
  }

  /** Light `index`'s gradient in `color`, at the strongest alpha (the paint's alpha lowers it); 3: the line's glow in
   *  the centre's colour, lightened. */
  private fun flowShader(index: Int, color: Int) {
    val key = color.toLong() and 0xFFFFFFFFL
    if (flowKeys[index] == key) return
    flowKeys[index] = key
    if (index == 3) {
      val white = TabFlow.LINE_WHITE
      val r = Color.red(color); val g = Color.green(color); val b = Color.blue(color)
      val glow = Color.rgb((r + (255 - r) * white).toInt(), (g + (255 - g) * white).toInt(), (b + (255 - b) * white).toInt())
      lineGlow.shader = RadialGradient(0f, 0f, 1f, intArrayOf(Theme.alpha(glow, TabFlow.LINE_GLOW), Theme.alpha(glow, TabFlow.LINE_GLOW * 0.75f), Theme.alpha(glow, 0f)), floatArrayOf(0f, 0.4f, 1f), Shader.TileMode.CLAMP)
      return
    }
    for (stop in 0 until 5) stopColors[stop] = Theme.alpha(color, TabFlow.ALPHA_MAX * TabFlow.FALL[stop])
    lights[index].shader = RadialGradient(0f, 0f, 1f, stopColors.copyOf(), TabFlow.STOPS, Shader.TileMode.CLAMP)
  }

  /** Look 9: the sketch's three lights (violet left, pink under the chosen tab, cyan right) rising from the lower edge
   *  in the colours of this moment, raised by the music's bands, moved as a liquid by the phone. */
  private fun drawFlow(canvas: Canvas, w: Float, h: Float) {
    stepFlow()
    flowColorsNow()
    val blur = TabFlow.BLUR_REACH * h
    for (index in 0 until 3) {
      flowShader(index, flowColors[index])
      val push = (waveLevel[index] * waveAmount).toFloat()
      val alpha = min(TabFlow.ALPHA_MAX, TabFlow.ALPHA[index] * (1 + TabFlow.PUNCH_ALPHA[index] * push) * liquid.bright(index))
      lights[index].alpha = (255 * alpha / TabFlow.ALPHA_MAX).toInt().coerceIn(0, 255)
      val mid = when (index) { 0 -> w * TabFlow.SIDE_AT[0]; 1 -> spotX; else -> w * TabFlow.SIDE_AT[1] }
      val halfWide = (TabFlow.REACH_X[index] * w + blur) * (1 + TabFlow.PUNCH_WIDE[index] * push) * liquid.wide(index)
      val tall = (TabFlow.REACH_Y[index] * h + blur) * (1 + TabFlow.PUNCH_TALL[index] * push) * liquid.tall(index)
      val sway = (sin(2 * PI * flowTime * TabFlow.SWAY_RATE[index]) * TabFlow.SWAY_WIDTH[index] * w * push).toFloat()
      val flow = (liquid.offset[index] * w).toFloat()
      shine(canvas, mid - halfWide + sway + flow, halfWide * 2, lights[index], tall)
    }
    canvas.drawRect(0f, 0f, w, h, grain)
  }

  /** The lights, clipped to the bar's capsule. */
  private fun drawLights(canvas: Canvas, w: Float, h: Float) {
    clip.reset(); clip.addRoundRect(0f, 0f, w, h, h / 2, h / 2, Path.Direction.CW)
    canvas.save(); canvas.clipPath(clip)
    when (look) {
      // Look 9's gradient spans the bar: it stays in a section without an icon too.
      TabFlow.LOOK -> drawFlow(canvas, w, h)
      0 -> {
        for (index in 1..2) lights[index].alpha = 255
        shine(canvas, -w * 0.16f, w * 0.72f, lights[1])
        shine(canvas, w * 0.46f, w * 0.72f, lights[2])
        val spot = max(110f * d, w * 0.7f)
        // In a section without an icon on the bar there is no spot (it showed as a smudge between the icons).
        lights[0].alpha = (255 * capsuleAlpha).toInt().coerceIn(0, 255)
        shine(canvas, spotX - spot / 2, spot, lights[0])
      }
      else -> {
        // Look 6: the glow behind the chosen icon, a circle almost the bar's height, centred on the icon.
        val halo = h * 0.95f / 2
        lights[0].alpha = (255 * capsuleAlpha).toInt().coerceIn(0, 255)
        canvas.save(); canvas.translate(spotX, h / 2); canvas.scale(halo, halo)
        canvas.drawCircle(0f, 0f, 1f, lights[0])
        canvas.restore()
      }
    }
    canvas.restore()
  }

  /** Look 9: the white line on the top edge above the chosen tab, its glow in the centre light's colour. */
  private fun drawLine(canvas: Canvas) {
    if (capsuleAlpha <= 0f) return
    flowShader(3, flowColors[1])
    val half = TabFlow.LINE_WIDTH / 2 * d; val tall = TabFlow.LINE_HEIGHT * d
    val reachX = (TabFlow.LINE_WIDTH / 2 + TabFlow.LINE_SPREAD + TabFlow.LINE_BLUR) * d
    val reachY = (TabFlow.LINE_HEIGHT / 2 + TabFlow.LINE_SPREAD + TabFlow.LINE_BLUR) * d
    lineGlow.alpha = (255 * capsuleAlpha).toInt().coerceIn(0, 255)
    canvas.save(); canvas.translate(spotX, tall / 2); canvas.scale(reachX, reachY)
    canvas.drawRect(-1f, -1f, 1f, 1f, lineGlow)
    canvas.restore()
    lineFill.alpha = (255 * capsuleAlpha).toInt().coerceIn(0, 255)
    canvas.drawRoundRect(spotX - half, 0f, spotX + half, tall, tall, tall, lineFill)
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    // The lights live in the glass: over its fill, under its rim. «Свечение панели» off: plain glass, no line.
    if (look == TabFlow.LOOK && !glowOn) glass.draw(canvas, 0f, 0f, w, h, h / 2)
    else glass.draw(canvas, 0f, 0f, w, h, h / 2, insideGlass)
    if (flowWanted) drawLine(canvas)

    val top = 4f * d; val wide = cell - 8f * d; val tall = h - 8f * d; val round = tall / 2
    if (trailAlpha > 0f) {
      fill.color = Theme.alpha(ink, (if (Theme.dark) 0.16f else 0.08f) * trailAlpha)
      canvas.drawRoundRect(trailX, top, trailX + wide, top + tall, round, round, fill)
    }
    if (capsuleAlpha > 0f) {
      canvas.save(); canvas.scale(liftScale, liftScale, capsuleX + wide / 2, h / 2)
      fill.color = Theme.alpha(ink, (if (Theme.dark) 0.14f else 0.07f) * capsuleAlpha)
      canvas.drawRoundRect(capsuleX, top, capsuleX + wide, top + tall, round, round, fill)
      rim.color = Theme.alpha(WHITE, (if (Theme.dark) 0.22f else 0.8f) * capsuleAlpha)
      val half = rim.strokeWidth / 2
      canvas.drawRoundRect(capsuleX + half, top + half, capsuleX + wide - half, top + tall - half, round - half, round - half, rim)
      canvas.restore()
    }
  }

  private fun rebuildIcons() {
    icons.forEach { removeView(it) }
    icons = bar.indices.map { index ->
      TabIconView(context).also { icon ->
        // For a screen reader and a keyboard; a finger is followed by the bar as a whole.
        icon.setOnClickListener { choose(index) }
        addView(icon)
      }
    }
    laidOut = 0L
    paintIcons()
    requestLayout()
  }

  private fun entry(id: String): TabEntry? = items.firstOrNull { it.id == id }
  private val others: List<TabEntry> get() = items.filter { it.id !in bar }

  private fun paintIcons() {
    val waiting = others.sumOf { it.badge }
    val awake = others.firstOrNull { it.dot.isNotEmpty() }?.dot ?: ""
    icons.forEachIndexed { index, icon ->
      val item = bar.getOrNull(index)?.let { entry(it) } ?: return@forEachIndexed
      val on = item.id == active
      icon.symbol = item.symbol
      icon.on = on
      // The first tab also carries what waits in the sections without an icon.
      val count = item.badge + if (index == 0) waiting else 0
      icon.badge = if (count > 0) badgeWords(count) else ""
      val dot = if (count > 0) "" else if (item.dot.isEmpty() && index == 0) awake else item.dot
      icon.dot = tabColor(dot)
      icon.contentDescription = if (count > 0) "${item.label}, $count" else item.label
      icon.isSelected = on
      val more = index == 0 && moreWords.isNotEmpty() && others.isNotEmpty()
      icon.moreWords = if (more) moreWords else ""
      icon.onMore = if (more) ({ openList(sticky = true) }) else null
      icon.invalidate()
    }
  }

  // MARK: The capsule and its trail

  private fun run(slot: Int, from: Float, to: Float, millis: Long, delay: Long, curve: TimeInterpolator, set: (Float) -> Unit) {
    running[slot]?.cancel()
    running[slot] = ValueAnimator.ofFloat(from, to).apply {
      duration = millis; startDelay = delay; interpolator = curve
      addUpdateListener { set(it.animatedValue as Float); invalidate() }
      start()
    }
  }

  private fun moveCapsule(before: Int, animated: Boolean) {
    val index = activeIndex
    if (width <= 0) return
    val target = capsuleLeft(index)
    if (!animated) {
      for (slot in 0..4) { running[slot]?.cancel(); running[slot] = null }
      capsuleX = target; capsuleAlpha = if (index < 0) 0f else 1f
      spotX = spotCentre(index); trailX = target; trailAlpha = 0f
      invalidate()
      return
    }
    val ease = DecelerateInterpolator()
    if (index < 0 || before < 0) {
      // Appearing or leaving: a fade, nothing travels.
      if (index >= 0) { running[0]?.cancel(); capsuleX = target }
      run(1, capsuleAlpha, if (index < 0) 0f else 1f, 200, 0, ease) { capsuleAlpha = it }
      run(2, spotX, spotCentre(index), 200, 0, ease) { spotX = it }
      return
    }
    // The trail starts where the capsule stands now, follows late and fades as it arrives.
    trailX = capsuleX
    trailAlpha = 0.6f
    run(0, capsuleX, target, 420, 0, SpringCurve(0.82f, 0.4f * 0.42f)) { capsuleX = it }
    run(1, capsuleAlpha, 1f, 420, 0, ease) { capsuleAlpha = it }
    run(2, spotX, spotCentre(index), 420, 0, SpringCurve(0.82f, 0.4f * 0.42f)) { spotX = it }
    run(3, trailX, target, 620, 50, SpringCurve(0.9f)) { trailX = it }
    run(4, trailAlpha, 0f, 340, 260, ease) { trailAlpha = it }
  }

  private fun lift(on: Boolean) {
    run(5, liftScale, if (on) 1.05f else 1f, 250, 0, SpringCurve(0.75f)) { liftScale = it }
  }

  private fun choose(index: Int) {
    val id = bar.getOrNull(index) ?: return
    // ChatsPlus: the reference's own motion of each icon (the gear turns, the bubble hops).
    icons.getOrNull(index)?.let { icon -> tabKick(icon, id) }
    // The capsule goes at once; the owner confirms with `setActive`.
    if (id != active) {
      val before = activeIndex
      active = id
      paintIcons()
      moveCapsule(before, animated = true)
    }
    onSelect(id)
  }

  // MARK: Touches

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean = true

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        // The finger may leave the bar for the list: nobody above takes the gesture away.
        parent?.requestDisallowInterceptTouchEvent(true)
        touch.down(event.x, event.y)
      }
      MotionEvent.ACTION_MOVE -> touch.move(event.x, event.y)
      MotionEvent.ACTION_UP -> touch.up(event.x, event.y)
      MotionEvent.ACTION_CANCEL -> touch.cancel()
    }
    return true
  }

  // MARK: The list

  fun openList(sticky: Boolean) {
    timers.removeCallbacks(holdTimer)
    if (overlay != null || others.isEmpty() || !isAttachedToWindow) return
    val window = rootView.findViewById<ViewGroup>(android.R.id.content) ?: return
    val list = TabListOverlay(context, others, glass.source)
    list.onPick = { pick(it) }
    list.onClose = { closeList(restore = false) }
    window.addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    getLocationInWindow(here); window.getLocationInWindow(there)
    list.place(here[0] - there[0], here[1] - there[1], width)
    list.sticky = sticky
    list.alpha = 0f
    list.translationY = 8f * d
    list.animate().alpha(1f).translationY(0f).setDuration(180).setInterpolator(DecelerateInterpolator()).start()
    overlay = list
    overlaySticky = sticky
    previewed = ""
    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    onListChange(true)
    if (sticky) list.post { list.focusFirst() }
  }

  /** Closes the list if it is open (the system's Back does this). */
  fun closeList() { if (overlay != null) closeList(restore = true) }

  /** The finger was lifted without moving: the list stays, rows and the space around take taps. */
  private fun stick() {
    overlaySticky = true
    overlay?.sticky = true
    overlay?.light("")
  }

  private fun light(entryId: String?) {
    val list = overlay ?: return
    val id = entryId ?: ""
    if (id == list.lit) return
    list.light(id)
    if (id.isNotEmpty()) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    // The page behind follows only a row the finger has stayed on.
    previewTimer?.let { timers.removeCallbacks(it) }
    val timer = Runnable {
      if (overlay?.lit == id && previewed != id) { previewed = id; onPreview(id) }
    }
    previewTimer = timer
    timers.postDelayed(timer, 140)
  }

  private fun pick(entry: TabEntry) {
    dismissList()
    val before = activeIndex
    active = entry.id
    paintIcons()
    moveCapsule(before, animated = true)
    onSelect(entry.id)
  }

  private fun closeList(restore: Boolean) {
    val shown = previewed
    dismissList()
    if (restore && shown.isNotEmpty()) onPreview("")
  }

  private fun dismissList(now: Boolean = false) {
    previewTimer?.let { timers.removeCallbacks(it) }
    previewTimer = null
    previewed = ""
    val list = overlay ?: return
    overlay = null
    overlaySticky = false
    list.sticky = false
    val remove = Runnable { (list.parent as? ViewGroup)?.removeView(list) }
    if (now) remove.run()
    else list.animate().alpha(0f).setDuration(140).setInterpolator(AccelerateInterpolator()).withEndAction(remove).start()
    onListChange(false)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attachedNow = true
    BarGlow.changed.watch(glowListener)
    readGlow()
    clock.attached(true)
    refreshSensors()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    shownNow = isVisible
    clock.shown(isVisible)
    refreshSensors()
    if (isVisible) invalidate() else storeFlow()
  }

  override fun onDetachedFromWindow() {
    attachedNow = false
    BarGlow.changed.unwatch(glowListener)
    clock.attached(false)
    refreshSensors()
    storeFlow()
    timers.removeCallbacks(holdTimer)
    dismissList(now = true)
    super.onDetachedFromWindow()
  }
}
