package com.linea.messenger.avatars

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.os.SystemClock
import android.view.View
import kotlin.math.cos
import kotlin.math.sin

/** A view that draws itself for a moment in time: while `live` and on the screen it draws again on every frame of
 *  the shared clock (DecorTicker: at most 60 a second, one callback for all of them, off while the app's animations
 *  are off); otherwise it holds its still picture. */
abstract class LiveCanvasView(context: Context) : View(context) {
  private val born = SystemClock.uptimeMillis()
  private val clock = DecorTicker.Link(this)
  private var wanted = false

  /** Moves: asked by the owner, and the app's animations are on (read as `false` while they are off, so the
   *  subclasses draw their still frame). */
  var live: Boolean
    get() = wanted && DecorTicker.allowed
    set(value) { if (wanted != value) { wanted = value; clock.want(value); invalidate() } }

  /** Tests: a fixed moment (seconds) instead of the clock; negative: the clock. */
  internal var fixedSeconds = -1.0

  /** Seconds since the view was made (the loops' clock). */
  protected val seconds: Double get() = if (fixedSeconds >= 0) fixedSeconds else (SystemClock.uptimeMillis() - born) / 1000.0

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); clock.attached(true) }
  override fun onDetachedFromWindow() { clock.attached(false); super.onDetachedFromWindow() }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    clock.shown(isVisible)
    if (isVisible && live) invalidate()
  }

  override fun onDraw(canvas: Canvas) = paint(canvas, width.toFloat(), height.toFloat())

  protected abstract fun paint(canvas: Canvas, width: Float, height: Float)
}

/** Animated avatar frames drawn in code (the reference's platina/CodeFrames.tsx, SVG + Reanimated; iOS
 *  Avatars/CodeFrames.swift), shape for shape and timing for timing: sharp at any size, no image files. The view is
 *  the art's box — 1.3× the avatar, centred over it. `live` plays the motion (profiles, the chosen tile); lists get
 *  the still frame (each loop held at 0.15 of its way, as the reference).
 *
 *  Cheap on every frame: everything that does not change while the frame moves — gradients, colours, the tongues,
 *  hearts, sparkles and bolts, the dashed and tilted rings — is made once per size (the shapes drawn once into small
 *  pictures, "sprites", at 1.25× their largest size), and each frame only places them: circles, rects and pictures
 *  moved, turned and faded. No path, dash or new object on the frame's way (the GPU never rasterises a path per
 *  frame — what took a software-drawn emulator down). */
class CodeFrameView(context: Context, val frameId: String) : LiveCanvasView(context) {
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

  /** A shape drawn once into a picture `k` times its size; (left, top): where its box starts in the shape's own
   *  coordinates. */
  private class Sprite(val bitmap: Bitmap, val left: Float, val top: Float, val k: Float)

  private var shapesFor = 0f
  // The shapes of the current size (only the frame's own are made).
  private var shader: Shader? = null
  private var shader2: Shader? = null
  private var sprite: Sprite? = null
  private var sprite2: Sprite? = null
  private val sprites = arrayOfNulls<Sprite>(8)
  // A dashed ring as its arcs (start°, sweep°, …) on `ring`: drawn as arcs, never as a dashed path.
  private val ring = RectF()
  private var arcs = FloatArray(0)
  private var arcs2 = FloatArray(0)

  companion object {
    private const val STILL = 0.15
    /** Sprites are drawn this much larger than their size (the frames grow them up to 1.2×). */
    private const val K = 1.25f
    private const val HEART = "M12 21.6 L10.3 20 C4.2 14.5 0.2 10.9 0.2 6.4 C0.2 2.8 3 0 6.6 0 C8.6 0 10.6 1 12 2.5 C13.4 1 15.4 0 17.4 0 C21 0 23.8 2.8 23.8 6.4 C23.8 10.9 19.8 14.5 13.7 20 Z"
    private const val TONGUE = "M5 0 C7 4 10 7 10 11 C10 14 7.8 16 5 16 C2.2 16 0 14 0 11 C0 7 3 4 5 0 Z"
    private const val SPARKLE = "M5 0 L6 4 L10 5 L6 6 L5 10 L4 6 L0 5 L4 4 Z"

    // Colours, parsed once.
    private val NEON = lookColor("#22E4FF")
    private val NEON_RING = intArrayOf(lookColor("#FF2BD6"), lookColor("#22E4FF"), lookColor("#7C5CFF"))
    private val TONGUE_COLORS = intArrayOf(lookColor("#FF3D00"), lookColor("#FF9A1F"), lookColor("#FFE680"))
    private val FLAME = lookColor("#FF7A1A")
    private val FLAME_EDGE = lookColor("#FF2E00")
    private val GLITCH = intArrayOf(lookColor("#FF2A55", 0.85f), lookColor("#00F0FF", 0.85f))
    private val AURORA_1 = intArrayOf(lookColor("#00FFA3"), lookColor("#00C2FF"), lookColor("#7B61FF"), lookColor("#00FFA3"))
    private val AURORA_2 = intArrayOf(lookColor("#FF6AD5"), lookColor("#C774E8"), lookColor("#94D0FF"))
    private val LIGHTNING_RING = lookColor("#8FB8FF", 0.55f)
    private val BOLT = lookColor("#6FA8FF")
    private val HEARTS_RING = lookColor("#FF5FA2", 0.5f)
    private val HEART_COLORS = intArrayOf(lookColor("#FF4F8B"), lookColor("#FF9CC2"))
    private val ORBIT_RINGS = intArrayOf(lookColor("#9FD3FF", 0.7f), lookColor("#FFD39F", 0.7f))
    private val PLANETS = intArrayOf(lookColor("#5EC8FF"), lookColor("#FFB347"))

    // Stardust: each dot's angle, size (× art) and colour, worked out once (the reference's generator).
    private class Dust(count: Int, seed: Double, color: String) {
      val cos = FloatArray(count); val sin = FloatArray(count); val size = FloatArray(count); val color = IntArray(count)
      init {
        for (index in 0 until count) {
          val i = index.toDouble()
          val angle = index.toDouble() / count * Math.PI * 2 + decorRand(seed + i) * 0.4
          cos[index] = cos(angle).toFloat(); sin[index] = sin(angle).toFloat()
          size[index] = (0.012 + decorRand(seed + i * 3) * 0.018).toFloat()
          this.color[index] = lookColor(color, (0.55 + decorRand(seed + i * 7) * 0.45).toFloat())
        }
      }
    }
    private val DUST_1 = Dust(18, 1.0, "#FFF4C2")
    private val DUST_2 = Dust(11, 9.0, "#C9B8FF")

    // Keyframes (seconds between, values): the glitch's jumps (× the shift) and the bolts' flashes.
    private val GLITCH_STEPS = Array(2) { val seed = it + 1; doubleArrayOf((900 + seed * 130) / 1000.0, 0.04, 0.05, 0.04, 0.04) }
    private val GLITCH_VALUES = Array(2) { val sign = if ((it + 1) % 2 == 1) 1.0 else -1.0; doubleArrayOf(0.0, 0.0, sign, -0.6, 0.3, 0.0) }
    private val BOLT_STEPS = Array(3) { doubleArrayOf(0.06, 0.07, 0.05, 0.26, (700 + it * 420) / 1000.0) }
    private val BOLT_VALUES = Array(3) { doubleArrayOf(if (it == 0) 1.0 else 0.0, 1.0, 0.2, 1.0, 0.0, 0.0) }

    /** The still frame as a picture of an `avatar`-px avatar (the chat list draws it from DecorStore). */
    fun still(context: Context, frameId: String, avatar: Int): Bitmap {
      val art = Math.round(avatar * AvatarCatalog.codeFrameScale).coerceAtLeast(1)
      val bitmap = Bitmap.createBitmap(art, art, Bitmap.Config.ARGB_8888)
      CodeFrameView(context, frameId).paint(Canvas(bitmap), art.toFloat(), art.toFloat())
      return bitmap
    }

    /** The dashes (`on`, `off`, from the circle's rightmost point, clockwise) of a circle of radius `r` as arcs:
     *  start and sweep in degrees, pair after pair. As Skia dashes a closed circle (DashPathEffect on drawCircle):
     *  the first dash is drawn last, as one with the final dash when that one runs up to the end. */
    fun dashArcs(r: Float, on: Float, off: Float): FloatArray {
      val length = 2 * Math.PI * r
      val spans = ArrayList<Double>()
      var at = 0.0; var index = 0; var added = false
      while (at < length) {
        val step = (if (index % 2 == 0) on else off).toDouble()
        added = false
        if (index % 2 == 0 && index != 0) { spans.add(at); spans.add(minOf(at + step, length)); added = true }
        at += step; index += 1
        if (step <= 0) break
      }
      if (added) spans[spans.size - 1] = length + on else { spans.add(0.0); spans.add(on.toDouble()) }
      val degrees = 180 / (Math.PI * r)
      return FloatArray(spans.size) { i -> if (i % 2 == 0) (spans[i] * degrees).toFloat() else ((spans[i] - spans[i - 1]) * degrees).toFloat() }
    }

    private fun withAlpha(color: Int, alpha: Float): Int = (color and 0xFFFFFF) or (Math.round(alpha * 255) shl 24)

    /** Keyframes: the value at `t` seconds of a loop through `values` with `steps` seconds between (ease in-out). */
    private fun keyframes(t: Double, steps: DoubleArray, values: DoubleArray): Double {
      var total = 0.0
      for (step in steps) total += step
      var at = t % total
      for (i in steps.indices) {
        if (at <= steps[i]) {
          val k = if (steps[i] <= 0) 1.0 else at / steps[i]
          val e = DecorEase.inOutSine(k)
          return values[i] + (values[i + 1] - values[i]) * e
        }
        at -= steps[i]
      }
      return values.last()
    }

    /** Draws `draw` (in the shape's coordinates, its box from (minX, minY) to (maxX, maxY)) into a picture `k` times
     *  larger, with a pixel to spare around for the edge's smoothing. */
    private inline fun sprite(minX: Float, minY: Float, maxX: Float, maxY: Float, k: Float, draw: (Canvas) -> Unit): Sprite {
      val pad = 2f
      val left = minX - pad / k; val top = minY - pad / k
      val w = Math.ceil(((maxX - minX) * k + 2 * pad).toDouble()).toInt().coerceAtLeast(1)
      val h = Math.ceil(((maxY - minY) * k + 2 * pad).toDouble()).toInt().coerceAtLeast(1)
      val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      canvas.scale(k, k)
      canvas.translate(-left, -top)
      draw(canvas)
      return Sprite(bitmap, left, top, k)
    }
  }

  /** Puts a sprite where its shape stands in the canvas's current coordinates. */
  private fun place(canvas: Canvas, sprite: Sprite, alpha: Int = 255) {
    picture.alpha = alpha
    if (sprite.k == 1f) canvas.drawBitmap(sprite.bitmap, sprite.left, sprite.top, picture)
    else {
      canvas.save()
      canvas.scale(1f / sprite.k, 1f / sprite.k)
      canvas.drawBitmap(sprite.bitmap, sprite.left * sprite.k, sprite.top * sprite.k, picture)
      canvas.restore()
    }
  }

  private fun arcs(canvas: Canvas, arcs: FloatArray, paint: Paint) {
    var i = 0
    while (i + 1 < arcs.size) { canvas.drawArc(ring, arcs[i], arcs[i + 1], false, paint); i += 2 }
  }

  /** Degrees of a turn every `duration` seconds (negative `turns`: the other way). */
  private fun turn(duration: Double, turns: Double = 1.0): Float =
    (360.0 * turns * (if (live) (seconds % duration) / duration else STILL)).toFloat()

  override fun paint(canvas: Canvas, width: Float, height: Float) {
    val art = minOf(width, height)
    if (art <= 0f) return
    if (shapesFor != art) { shapesFor = art; prepare(art) }
    when (frameId) {
      "fx-neon" -> neon(canvas, art)
      "fx-flame" -> flame(canvas, art)
      "fx-stardust" -> stardust(canvas, art)
      "fx-glitch" -> glitch(canvas, art)
      "fx-aurora" -> aurora(canvas, art)
      "fx-lightning" -> lightning(canvas, art)
      "fx-hearts" -> hearts(canvas, art)
      else -> orbit(canvas, art)
    }
  }

  /** The frame's unchanging parts for an `art`-px box. */
  private fun prepare(art: Float) {
    shader = null; shader2 = null; sprite = null; sprite2 = null; sprites.fill(null)
    val c = art / 2
    val shape = Paint(Paint.ANTI_ALIAS_FLAG)
    when (frameId) {
      "fx-neon" -> { val r = art * 0.405f; shader = LinearGradient(c - r, c - r, c + r, c + r, NEON_RING, null, Shader.TileMode.CLAMP) }
      "fx-flame" -> {
        shader = RadialGradient(c, c, art / 2, intArrayOf(FLAME and 0xFFFFFF, FLAME and 0xFFFFFF, withAlpha(FLAME, 0.7f), FLAME_EDGE and 0xFFFFFF), floatArrayOf(0f, 0.72f, 0.8f, 1f), Shader.TileMode.CLAMP)
        val w = art * 0.08f; val h = art * 0.13f
        val path = svgPath(TONGUE, 10f, 16f, w, h)
        shape.shader = LinearGradient(0f, h, 0f, 0f, TONGUE_COLORS, floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
        sprite = sprite(0f, 0f, w, h, K) { it.drawPath(path, shape) }
      }
      "fx-stardust" -> {
        val s = art * 0.09f
        val path = svgPath(SPARKLE, 10f, 10f, s, s)
        shape.color = 0xFFFFFFFF.toInt()
        sprite = sprite(0f, 0f, s, s, K) { it.drawPath(path, shape) }
      }
      "fx-glitch" -> {
        val r = art * 0.405f
        ring.set(c - r, c - r, c + r, c + r)
        arcs = dashArcs(r, art * 0.3f, art * 0.04f)
        arcs2 = dashArcs(r, art * 0.22f, art * 0.06f)
      }
      "fx-aurora" -> {
        val r = art * 0.41f
        ring.set(c - r, c - r, c + r, c + r)
        shader = LinearGradient(c - r, c - r, c + r, c + r, AURORA_1, floatArrayOf(0f, 1f / 3, 2f / 3, 1f), Shader.TileMode.CLAMP)
        shader2 = LinearGradient(c - r, c - r, c + r, c + r, AURORA_2, floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
        arcs = dashArcs(r, art * 0.5f, art * 0.3f)
      }
      "fx-lightning" -> {
        val r = art * 0.41f
        val path = Path()
        val segments = 7
        for (index in 0..segments) {
          val t = index.toDouble() / segments
          val a = -0.55 + t * 1.1
          val rr = r + (if (index % 2 == 1) 1 else -1) * art * 0.035f
          val x = c + cos(a).toFloat() * rr; val y = c + sin(a).toFloat() * rr
          if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        val bounds = RectF(); path.computeBounds(bounds, true)
        shape.style = Paint.Style.STROKE; shape.strokeJoin = Paint.Join.ROUND
        for (index in 0 until 2) {
          shape.strokeWidth = if (index == 0) art * 0.045f else art * 0.016f
          shape.color = if (index == 0) BOLT else 0xFFFFFFFF.toInt()
          val out = shape.strokeWidth
          val made = sprite(bounds.left - out, bounds.top - out, bounds.right + out, bounds.bottom + out, 1f) { it.drawPath(path, shape) }
          if (index == 0) sprite = made else sprite2 = made
        }
      }
      "fx-hearts" -> for (index in 0 until 8) {
        val s = art * (0.07 + decorRand(index + 2.0) * 0.03).toFloat()
        val path = svgPath(HEART, 24f, 22f, s, s)
        shape.color = HEART_COLORS[if (index % 3 != 0) 0 else 1]
        sprites[index] = sprite(0f, 0f, s, s, K) { it.drawPath(path, shape) }
      }
      else -> {
        val s = art * 0.075f
        shape.style = Paint.Style.STROKE; shape.strokeJoin = Paint.Join.ROUND; shape.strokeWidth = art * 0.01f
        for (index in 0 until 2) {
          val rx = if (index == 0) art * 0.48f else art * 0.46f; val ry = rx * 0.32f
          val tilt = if (index == 0) -22f else 28f
          shape.color = ORBIT_RINGS[index]
          val oval = RectF(c - rx, c - ry, c + rx, c + ry)
          val made = sprite(0f, 0f, art, art, 1f) { it.rotate(tilt, c, c); it.drawOval(oval, shape) }
          if (index == 0) sprite = made else sprite2 = made
          // The planet's glow, about its centre (moved there on each frame).
          val glow = PLANETS[index]
          val halo = RadialGradient(0f, 0f, s * 1.5f, intArrayOf(withAlpha(glow, 0.55f), withAlpha(glow, 0f)), null, Shader.TileMode.CLAMP)
          if (index == 0) shader = halo else shader2 = halo
        }
      }
    }
  }

  private fun neon(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.405f
    val p = if (live) DecorEase.inOutSine(DecorEase.phase(seconds, 1.7)) else STILL
    line.shader = null
    line.strokeWidth = art * 0.07f
    line.color = withAlpha(NEON, (0.35 * (0.45 + 0.4 * sin(p * Math.PI))).toFloat())
    canvas.drawCircle(c, c, r, line)
    canvas.save()
    canvas.rotate(turn(2.6), c, c)
    line.strokeWidth = art * 0.028f
    line.shader = shader
    line.color = 0xFF000000.toInt()
    canvas.drawCircle(c, c, r, line)
    line.shader = null
    fill.shader = null; fill.color = 0xFFFFFFFF.toInt()
    canvas.drawCircle(c, c - r, art * 0.022f, fill)
    canvas.restore()
  }

  private fun flame(canvas: Canvas, art: Float) {
    val c = art / 2
    fill.shader = shader
    canvas.drawRect(0f, 0f, art, art, fill)
    fill.shader = null
    val tongue = sprite ?: return
    val r = art * 0.39f; val count = 14
    val w = art * 0.08f; val h = art * 0.13f
    for (index in 0 until count) {
      val seed = index.toDouble()
      val angle = index.toFloat() / count * 360f
      val p = if (live) DecorEase.inOutSine(DecorEase.phase(seconds, (520 + decorRand(seed) * 380) / 1000, decorRand(seed + 3) * 400 / 1000)) else STILL
      val sx = (0.9 + 0.15 * cos(p * Math.PI * 2)).toFloat(); val sy = (0.75 + 0.45 * sin(p * Math.PI)).toFloat()
      canvas.save()
      canvas.translate(c, c)
      canvas.rotate(angle)
      canvas.translate(0f, -r - h * 0.35f)
      canvas.scale(sx, sy)
      canvas.translate(-w / 2, -h / 2)
      place(canvas, tongue)
      canvas.restore()
    }
  }

  private fun dust(canvas: Canvas, art: Float, dust: Dust, radius: Float, degrees: Float) {
    val c = art / 2
    canvas.save(); canvas.rotate(degrees, c, c)
    for (index in dust.size.indices) {
      fill.color = dust.color[index]
      canvas.drawCircle(c + dust.cos[index] * radius, c + dust.sin[index] * radius, art * dust.size[index], fill)
    }
    canvas.restore()
  }

  private fun stardust(canvas: Canvas, art: Float) {
    val c = art / 2
    fill.shader = null
    dust(canvas, art, DUST_1, art * 0.42f, turn(9.0))
    dust(canvas, art, DUST_2, art * 0.47f, turn(5.2, -1.0))
    val star = sprite ?: return
    val s = art * 0.09f
    for (index in 0 until 4) {
      val seed = index.toDouble()
      val a = decorRand(seed + 2) * Math.PI * 2; val rr = art * (0.4 + decorRand(seed + 4) * 0.08).toFloat()
      val p = if (live) DecorEase.inOutSine(DecorEase.phase(seconds, (1400 + decorRand(seed) * 1200) / 1000, decorRand(seed + 5) * 1200 / 1000)) else STILL
      val opacity = sin(p * Math.PI).toFloat().coerceIn(0f, 1f)
      if (live && seconds < decorRand(seed + 5) * 1.2) continue
      val grow = (0.4 + sin(p * Math.PI) * 0.8).toFloat()
      canvas.save()
      canvas.translate(c + cos(a).toFloat() * rr, c + sin(a).toFloat() * rr)
      canvas.scale(grow, grow)
      canvas.rotate((p * 90).toFloat())
      canvas.translate(-s / 2, -s / 2)
      place(canvas, star, Math.round(opacity * 255))
      canvas.restore()
    }
  }

  private fun glitch(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.405f; val w = art * 0.03f
    line.shader = null
    line.strokeWidth = w
    for (index in 0 until 2) {
      val x = if (live) (keyframes(seconds, GLITCH_STEPS[index], GLITCH_VALUES[index]) * art * 0.025).toFloat()
        else if (index == 0) art * 0.012f else -art * 0.012f
      line.color = GLITCH[index]
      canvas.save(); canvas.translate(x, -x * 0.4f)
      arcs(canvas, if (index == 0) arcs else arcs2, line)
      canvas.restore()
    }
    line.strokeWidth = w * 0.55f
    line.color = 0xFFFFFFFF.toInt()
    canvas.drawCircle(c, c, r, line)
  }

  private fun aurora(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.41f
    canvas.save(); canvas.rotate(turn(7.0), c, c)
    line.shader = shader
    line.color = 0xFF000000.toInt()
    line.strokeWidth = art * 0.05f
    canvas.drawCircle(c, c, r, line)
    line.shader = null
    canvas.restore()
    canvas.save(); canvas.rotate(turn(4.8, -1.0), c, c)
    line.shader = shader2
    line.color = withAlpha(0xFF000000.toInt(), 0.7f)
    line.strokeWidth = art * 0.022f
    line.strokeCap = Paint.Cap.ROUND
    arcs(canvas, arcs, line)
    line.shader = null; line.strokeCap = Paint.Cap.BUTT; line.alpha = 255
    canvas.restore()
  }

  private fun lightning(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.41f
    line.shader = null
    line.strokeWidth = art * 0.018f
    line.color = LIGHTNING_RING
    canvas.drawCircle(c, c, r, line)
    val glow = sprite ?: return
    val core = sprite2 ?: return
    for (index in 0 until 3) {
      val seed = index.toDouble()
      val start = decorRand(seed) * 360
      val opacity: Double; val degrees: Double
      if (live) {
        val delay = if (index > 0) seed * 0.38 else 0.0
        val t = seconds - delay
        opacity = if (t < 0) 0.0 else keyframes(t, BOLT_STEPS[index], BOLT_VALUES[index])
        val spin = (6000 + seed * 900) / 1000
        degrees = start + (seconds % spin) / spin * 360
      } else {
        opacity = if (index == 0) 1.0 else 0.0
        degrees = start
      }
      if (opacity <= 0.01) continue
      canvas.save(); canvas.rotate(degrees.toFloat(), c, c)
      place(canvas, glow, Math.round((0.6 * opacity).toFloat().coerceIn(0f, 1f) * 255))
      place(canvas, core, Math.round(opacity.toFloat().coerceIn(0f, 1f) * 255))
      canvas.restore()
    }
  }

  private fun hearts(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.43f; val count = 8
    line.shader = null
    line.strokeWidth = art * 0.014f
    line.color = HEARTS_RING
    canvas.drawCircle(c, c, art * 0.4f, line)
    canvas.save(); canvas.rotate(turn(8.0), c, c)
    for (index in 0 until count) {
      val shape = sprites[index] ?: continue
      val seed = index.toDouble()
      val angle = index.toDouble() / count * Math.PI * 2
      val s = art * (0.07 + decorRand(seed + 2) * 0.03).toFloat()
      val p = if (live) DecorEase.inOutSine(DecorEase.phase(seconds, (1100 + decorRand(seed) * 500) / 1000, decorRand(seed + 1) * 600 / 1000)) else STILL
      val grow = (0.8 + 0.3 * sin(p * Math.PI)).toFloat()
      canvas.save()
      canvas.translate(c + cos(angle).toFloat() * r, c + sin(angle).toFloat() * r)
      canvas.scale(grow, grow)
      canvas.translate(-s / 2, -s / 2)
      place(canvas, shape)
      canvas.restore()
    }
    canvas.restore()
  }

  private fun orbit(canvas: Canvas, art: Float) {
    val c = art / 2; val s = art * 0.075f
    for (index in 0 until 2) {
      val ring = (if (index == 0) sprite else sprite2) ?: continue
      val duration = if (index == 0) 3.6 else 5.4
      val tilt = if (index == 0) -22f else 28f
      val rx = if (index == 0) art * 0.48f else art * 0.46f; val ry = rx * 0.32f
      place(canvas, ring)
      canvas.save(); canvas.rotate(tilt, c, c)
      val p = if (live) (seconds % duration) / duration else STILL
      val t = p * Math.PI * 2
      val x = c + cos(t).toFloat() * rx; val y = c + sin(t).toFloat() * ry
      canvas.translate(x, y)
      fill.shader = if (index == 0) shader else shader2
      canvas.drawCircle(0f, 0f, s * 1.5f, fill)
      fill.shader = null
      fill.color = PLANETS[index]
      canvas.drawCircle(0f, 0f, s / 2, fill)
      canvas.restore()
    }
  }
}
