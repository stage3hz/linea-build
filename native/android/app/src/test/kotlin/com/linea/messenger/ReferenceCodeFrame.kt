package com.linea.messenger

import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import com.linea.messenger.avatars.DecorEase
import com.linea.messenger.avatars.decorRand
import com.linea.messenger.avatars.lookColor
import com.linea.messenger.avatars.svgPath
import kotlin.math.cos
import kotlin.math.sin

/** The code-drawn frames exactly as they were first ported (vector shapes, new gradients every draw): kept only to
 *  check that the cached, sprite-based CodeFrameView looks the same (DecorPerformanceTest). */
class ReferenceCodeFrame(val frameId: String, var live: Boolean = false, var seconds: Double = 0.0) {
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
  private val heart = "M12 21.6 L10.3 20 C4.2 14.5 0.2 10.9 0.2 6.4 C0.2 2.8 3 0 6.6 0 C8.6 0 10.6 1 12 2.5 C13.4 1 15.4 0 17.4 0 C21 0 23.8 2.8 23.8 6.4 C23.8 10.9 19.8 14.5 13.7 20 Z"
  private val tongue = "M5 0 C7 4 10 7 10 11 C10 14 7.8 16 5 16 C2.2 16 0 14 0 11 C0 7 3 4 5 0 Z"
  private val sparkle = "M5 0 L6 4 L10 5 L6 6 L5 10 L4 6 L0 5 L4 4 Z"
  private var shapesFor = 0f
  private var tonguePath = Path(); private var tongueShader: Shader? = null
  private val heartPaths = HashMap<Int, Path>()
  private val starPaths = HashMap<Int, Path>()

  private companion object { const val STILL = 0.15 }

  /** Degrees of a turn every `duration` seconds (negative `turns`: the other way). */
  private fun turn(duration: Double, turns: Double = 1.0): Float =
    (360.0 * turns * (if (live) (seconds % duration) / duration else STILL)).toFloat()

  private fun circle(canvas: Canvas, cx: Float, cy: Float, r: Float, paint: Paint) = canvas.drawCircle(cx, cy, r, paint)

  fun paint(canvas: Canvas, width: Float, height: Float) {
    val art = minOf(width, height)
    if (art <= 0f) return
    if (shapesFor != art) {
      shapesFor = art
      val w = art * 0.08f; val h = art * 0.13f
      tonguePath = svgPath(tongue, 10f, 16f, w, h)
      tongueShader = LinearGradient(0f, h, 0f, 0f, intArrayOf(lookColor("#FF3D00"), lookColor("#FF9A1F"), lookColor("#FFE680")), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
      heartPaths.clear(); starPaths.clear()
    }
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

  private fun neon(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.405f
    val p = if (live) DecorEase.loop(seconds, 1.7, ease = DecorEase::inOutSine) else STILL
    line.shader = null; line.pathEffect = null
    line.strokeWidth = art * 0.07f
    line.color = lookColor("#22E4FF", (0.35 * (0.45 + 0.4 * sin(p * Math.PI))).toFloat())
    circle(canvas, c, c, r, line)
    canvas.save()
    canvas.rotate(turn(2.6), c, c)
    line.strokeWidth = art * 0.028f
    line.shader = LinearGradient(c - r, c - r, c + r, c + r, intArrayOf(lookColor("#FF2BD6"), lookColor("#22E4FF"), lookColor("#7C5CFF")), null, Shader.TileMode.CLAMP)
    line.color = 0xFF000000.toInt()
    circle(canvas, c, c, r, line)
    line.shader = null
    fill.shader = null; fill.color = 0xFFFFFFFF.toInt()
    circle(canvas, c, c - r, art * 0.022f, fill)
    canvas.restore()
  }

  private fun flame(canvas: Canvas, art: Float) {
    val c = art / 2
    val orange = lookColor("#FF7A1A")
    fill.shader = RadialGradient(c, c, art / 2, intArrayOf(orange and 0xFFFFFF, orange and 0xFFFFFF, withAlpha(orange, 0.7f), lookColor("#FF2E00") and 0xFFFFFF), floatArrayOf(0f, 0.72f, 0.8f, 1f), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, art, art, fill)
    fill.shader = null
    val r = art * 0.39f; val count = 14
    val w = art * 0.08f; val h = art * 0.13f
    for (index in 0 until count) {
      val seed = index.toDouble()
      val angle = index.toFloat() / count * 360f
      val p = if (live) DecorEase.loop(seconds, (520 + decorRand(seed) * 380) / 1000, decorRand(seed + 3) * 400 / 1000, DecorEase::inOutSine) else STILL
      val sx = (0.9 + 0.15 * cos(p * Math.PI * 2)).toFloat(); val sy = (0.75 + 0.45 * sin(p * Math.PI)).toFloat()
      canvas.save()
      canvas.translate(c, c)
      canvas.rotate(angle)
      canvas.translate(0f, -r - h * 0.35f)
      canvas.scale(sx, sy)
      canvas.translate(-w / 2, -h / 2)
      fill.shader = tongueShader
      canvas.drawPath(tonguePath, fill)
      fill.shader = null
      canvas.restore()
    }
  }

  private fun withAlpha(color: Int, alpha: Float): Int = (color and 0xFFFFFF) or (Math.round(alpha * 255) shl 24)

  private fun stardust(canvas: Canvas, art: Float) {
    val c = art / 2
    fun ring(count: Int, radius: Float, seed: Double, color: String, degrees: Float) {
      canvas.save(); canvas.rotate(degrees, c, c)
      for (index in 0 until count) {
        val i = index.toDouble()
        val angle = index.toDouble() / count * Math.PI * 2 + decorRand(seed + i) * 0.4
        val size = art * (0.012 + decorRand(seed + i * 3) * 0.018).toFloat()
        fill.color = lookColor(color, (0.55 + decorRand(seed + i * 7) * 0.45).toFloat())
        circle(canvas, c + cos(angle).toFloat() * radius, c + sin(angle).toFloat() * radius, size, fill)
      }
      canvas.restore()
    }
    ring(18, art * 0.42f, 1.0, "#FFF4C2", turn(9.0))
    ring(11, art * 0.47f, 9.0, "#C9B8FF", turn(5.2, -1.0))
    val s = art * 0.09f
    val star = starPaths.getOrPut(0) { svgPath(sparkle, 10f, 10f, s, s) }
    for (index in 0 until 4) {
      val seed = index.toDouble()
      val a = decorRand(seed + 2) * Math.PI * 2; val rr = art * (0.4 + decorRand(seed + 4) * 0.08).toFloat()
      val p = if (live) DecorEase.loop(seconds, (1400 + decorRand(seed) * 1200) / 1000, decorRand(seed + 5) * 1200 / 1000, DecorEase::inOutSine) else STILL
      val opacity = sin(p * Math.PI).toFloat().coerceIn(0f, 1f)
      if (live && seconds < decorRand(seed + 5) * 1.2) continue
      val grow = (0.4 + sin(p * Math.PI) * 0.8).toFloat()
      canvas.save()
      canvas.translate(c + cos(a).toFloat() * rr, c + sin(a).toFloat() * rr)
      canvas.scale(grow, grow)
      canvas.rotate((p * 90).toFloat())
      canvas.translate(-s / 2, -s / 2)
      fill.color = withAlpha(0xFFFFFFFF.toInt(), opacity)
      canvas.drawPath(star, fill)
      canvas.restore()
    }
  }

  /** Keyframes: the value at `t` seconds of a loop through `values` with `steps` seconds between (ease in-out). */
  private fun keyframes(t: Double, steps: List<Double>, values: List<Double>): Double {
    val total = steps.sum()
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

  private fun glitch(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.405f; val w = art * 0.03f
    line.shader = null
    for ((color, seed) in listOf("#FF2A55" to 1, "#00F0FF" to 2)) {
      val dash = if (seed == 1) floatArrayOf(art * 0.3f, art * 0.04f) else floatArrayOf(art * 0.22f, art * 0.06f)
      val x = if (live) {
        val d = art * 0.025; val sign = if (seed % 2 == 1) 1.0 else -1.0
        val rest = (900 + seed * 130) / 1000.0
        keyframes(seconds, listOf(rest, 0.04, 0.05, 0.04, 0.04), listOf(0.0, 0.0, d * sign, -d * 0.6, d * 0.3, 0.0)).toFloat()
      } else if (seed == 1) art * 0.012f else -art * 0.012f
      line.strokeWidth = w
      line.pathEffect = DashPathEffect(dash, 0f)
      line.color = lookColor(color, 0.85f)
      canvas.save(); canvas.translate(x, -x * 0.4f)
      circle(canvas, c, c, r, line)
      canvas.restore()
    }
    line.pathEffect = null
    line.strokeWidth = w * 0.55f
    line.color = 0xFFFFFFFF.toInt()
    circle(canvas, c, c, r, line)
  }

  private fun aurora(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.41f
    fun ring(colors: List<String>, width: Float, dash: FloatArray?, degrees: Float, alpha: Float) {
      canvas.save(); canvas.rotate(degrees, c, c)
      val stops = FloatArray(colors.size) { it.toFloat() / maxOf(1, colors.size - 1) }
      line.shader = LinearGradient(c - r, c - r, c + r, c + r, colors.map { lookColor(it) }.toIntArray(), stops, Shader.TileMode.CLAMP)
      line.color = withAlpha(0xFF000000.toInt(), alpha)
      line.alpha = Math.round(alpha * 255)
      line.strokeWidth = width
      line.strokeCap = Paint.Cap.ROUND
      line.pathEffect = dash?.let { DashPathEffect(it, 0f) }
      circle(canvas, c, c, r, line)
      line.shader = null; line.pathEffect = null; line.strokeCap = Paint.Cap.BUTT; line.alpha = 255
      canvas.restore()
    }
    ring(listOf("#00FFA3", "#00C2FF", "#7B61FF", "#00FFA3"), art * 0.05f, null, turn(7.0), 1f)
    ring(listOf("#FF6AD5", "#C774E8", "#94D0FF"), art * 0.022f, floatArrayOf(art * 0.5f, art * 0.3f), turn(4.8, -1.0), 0.7f)
  }

  private fun lightning(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.41f
    line.shader = null; line.pathEffect = null
    line.strokeWidth = art * 0.018f
    line.color = lookColor("#8FB8FF", 0.55f)
    circle(canvas, c, c, r, line)
    val path = Path()
    val segments = 7
    for (index in 0..segments) {
      val t = index.toDouble() / segments
      val a = -0.55 + t * 1.1
      val rr = r + (if (index % 2 == 1) 1 else -1) * art * 0.035f
      val x = c + cos(a).toFloat() * rr; val y = c + sin(a).toFloat() * rr
      if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    for (index in 0 until 3) {
      val seed = index.toDouble()
      val start = decorRand(seed) * 360
      val opacity: Double; val degrees: Double
      if (live) {
        val delay = if (index > 0) seed * 0.38 else 0.0
        val t = seconds - delay
        opacity = if (t < 0) 0.0 else keyframes(t, listOf(0.06, 0.07, 0.05, 0.26, (700 + seed * 420) / 1000), listOf(if (index == 0) 1.0 else 0.0, 1.0, 0.2, 1.0, 0.0, 0.0))
        val spin = (6000 + seed * 900) / 1000
        degrees = start + (seconds % spin) / spin * 360
      } else {
        opacity = if (index == 0) 1.0 else 0.0
        degrees = start
      }
      if (opacity <= 0.01) continue
      canvas.save(); canvas.rotate(degrees.toFloat(), c, c)
      line.strokeWidth = art * 0.045f
      line.color = lookColor("#6FA8FF", (0.6 * opacity).toFloat())
      canvas.drawPath(path, line)
      line.strokeWidth = art * 0.016f
      line.color = withAlpha(0xFFFFFFFF.toInt(), opacity.toFloat())
      canvas.drawPath(path, line)
      canvas.restore()
    }
  }

  private fun hearts(canvas: Canvas, art: Float) {
    val c = art / 2; val r = art * 0.43f; val count = 8
    line.shader = null; line.pathEffect = null
    line.strokeWidth = art * 0.014f
    line.color = lookColor("#FF5FA2", 0.5f)
    circle(canvas, c, c, art * 0.4f, line)
    canvas.save(); canvas.rotate(turn(8.0), c, c)
    for (index in 0 until count) {
      val seed = index.toDouble()
      val angle = index.toDouble() / count * Math.PI * 2
      val s = art * (0.07 + decorRand(seed + 2) * 0.03).toFloat()
      val shape = heartPaths.getOrPut(index) { svgPath(heart, 24f, 22f, s, s) }
      val p = if (live) DecorEase.loop(seconds, (1100 + decorRand(seed) * 500) / 1000, decorRand(seed + 1) * 600 / 1000, DecorEase::inOutSine) else STILL
      val grow = (0.8 + 0.3 * sin(p * Math.PI)).toFloat()
      canvas.save()
      canvas.translate(c + cos(angle).toFloat() * r, c + sin(angle).toFloat() * r)
      canvas.scale(grow, grow)
      canvas.translate(-s / 2, -s / 2)
      fill.color = lookColor(if (index % 3 != 0) "#FF4F8B" else "#FF9CC2")
      canvas.drawPath(shape, fill)
      canvas.restore()
    }
    canvas.restore()
  }

  private fun orbit(canvas: Canvas, art: Float) {
    fun ring(duration: Double, tilt: Float, color: String, planet: String, rx: Float) {
      val c = art / 2; val ry = rx * 0.32f; val s = art * 0.075f
      canvas.save(); canvas.rotate(tilt, c, c)
      line.shader = null; line.pathEffect = null
      line.strokeWidth = art * 0.01f
      line.color = lookColor(color, 0.7f)
      canvas.drawOval(RectF(c - rx, c - ry, c + rx, c + ry), line)
      val p = if (live) (seconds % duration) / duration else STILL
      val t = p * Math.PI * 2
      val x = c + cos(t).toFloat() * rx; val y = c + sin(t).toFloat() * ry
      val glow = lookColor(planet)
      fill.shader = RadialGradient(x, y, s * 1.5f, intArrayOf(withAlpha(glow, 0.55f), withAlpha(glow, 0f)), null, Shader.TileMode.CLAMP)
      circle(canvas, x, y, s * 1.5f, fill)
      fill.shader = null
      fill.color = glow
      circle(canvas, x, y, s / 2, fill)
      canvas.restore()
    }
    ring(3.6, -22f, "#9FD3FF", "#5EC8FF", art * 0.48f)
    ring(5.4, 28f, "#FFD39F", "#FFB347", art * 0.46f)
  }

}
