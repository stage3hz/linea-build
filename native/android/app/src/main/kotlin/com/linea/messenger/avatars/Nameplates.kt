package com.linea.messenger.avatars

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.util.Base64
import android.view.View
import java.io.ByteArrayOutputStream

/** Nameplates (the reference's platina/Nameplates.tsx; iOS Avatars/Nameplates.swift): a picture that fills the
 *  whole row behind a person's name in the chat list and in member lists, fading into the row on the left so the
 *  name and the preview stay readable. All the artwork is drawn here, shape for shape as the reference's SVG (a
 *  400 × 84 box), with its deterministic generator — the same plate looks the same on every phone. */
object Nameplates {
  const val WIDTH = 400f
  const val HEIGHT = 84f
  private const val SCALE = 3f
  private val baked = HashMap<String, Bitmap>()

  /** The reference's small generator (an LCG seeded by the plate's id). */
  class Generator(id: String) {
    private var state: Long
    init {
      var seed = 7L
      for (unit in id) seed = (seed * 31 + unit.code) and 0xFFFFFFFFL
      state = seed and 0xFFFFFFFFL
    }
    fun next(): Float {
      state = (state * 1_664_525L + 1_013_904_223L) and 0xFFFFFFFFL
      return (state.toDouble() / 4_294_967_296.0).toFloat()
    }
  }

  /** The plate's art (background gradient and drawing, no readability fade), 1200 × 252 px. */
  fun image(id: String): Bitmap? {
    baked[id]?.let { return it }
    val plate = AvatarCatalog.plate(id) ?: return null
    val made = Bitmap.createBitmap((WIDTH * SCALE).toInt(), (HEIGHT * SCALE).toInt(), Bitmap.Config.ARGB_8888)
    val canvas = Canvas(made)
    canvas.scale(SCALE, SCALE)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, WIDTH, 0f, lookColor(plate.colors.first), lookColor(plate.colors.second), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, WIDTH, HEIGHT, paint)
    draw(id, canvas)
    baked[id] = made
    return made
  }

  /** The plate as a PNG in base64 (what DecorStore.setPlates takes). */
  fun base64(id: String): String? {
    val image = image(id) ?: return null
    val out = ByteArrayOutputStream()
    image.compress(Bitmap.CompressFormat.PNG, 100, out)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  private fun fill(canvas: Canvas, path: Path, color: String, alpha: Float) {
    paint.style = Paint.Style.FILL; paint.pathEffect = null; paint.shader = null
    paint.color = lookColor(color, alpha)
    canvas.drawPath(path, paint)
  }

  private fun stroke(canvas: Canvas, path: Path, color: String, alpha: Float, width: Float, dash: FloatArray? = null, round: Boolean = false) {
    paint.style = Paint.Style.STROKE; paint.shader = null
    paint.strokeWidth = width
    paint.pathEffect = dash?.let { DashPathEffect(it, 0f) }
    paint.strokeCap = if (round) Paint.Cap.ROUND else Paint.Cap.BUTT
    paint.color = lookColor(color, alpha)
    canvas.drawPath(path, paint)
    paint.pathEffect = null; paint.strokeCap = Paint.Cap.BUTT
  }

  private fun ellipse(cx: Float, cy: Float, rx: Float, ry: Float): Path = Path().apply { addOval(RectF(cx - rx, cy - ry, cx + rx, cy + ry), Path.Direction.CW) }

  /** A path turned by `degrees` about (x, y), as SVG's `rotate(a x y)`. */
  private fun turned(path: Path, degrees: Float, x: Float, y: Float): Path = Path(path).apply { transform(Matrix().apply { setRotate(degrees, x, y) }) }

  private fun draw(id: String, canvas: Canvas) {
    val g = Generator(id)
    val w = WIDTH; val h = HEIGHT
    when (id) {
      "crows" -> repeat(14) {
        val x = 120 + g.next() * 270; val y = 8 + g.next() * 66; val s = 4 + g.next() * 9
        val path = Path()
        path.moveTo(x - s, y - s * 0.25f)
        path.quadTo(x - s * 0.45f, y - s * 0.55f, x, y)
        path.quadTo(x + s * 0.45f, y - s * 0.55f, x + s, y - s * 0.25f)
        path.quadTo(x + s * 0.45f, y - s * 0.2f, x, y + s * 0.22f)
        path.quadTo(x - s * 0.45f, y - s * 0.2f, x - s, y - s * 0.25f)
        path.close()
        fill(canvas, path, "#0B0C10", 0.55f + g.next() * 0.4f)
      }
      "leopard" -> repeat(34) {
        val x = 90 + g.next() * 320; val y = g.next() * h; val s = 4 + g.next() * 6
        stroke(canvas, ellipse(x, y, s * 1.25f, s), "#1E1E22", 0.8f, s * 0.55f, floatArrayOf(s * 1.4f, s * 0.6f))
        fill(canvas, ellipse(x, y, s * 0.55f, s * 0.42f), "#6E6A60", 0.55f)
      }
      "sparkle" -> repeat(16) {
        val x = 110 + g.next() * 285; val y = 6 + g.next() * 72; val s = 2 + g.next() * 7
        val path = Path()
        path.moveTo(x, y - s * 2)
        path.quadTo(x + s * 0.25f, y - s * 0.25f, x + s * 2, y)
        path.quadTo(x + s * 0.25f, y + s * 0.25f, x, y + s * 2)
        path.quadTo(x - s * 0.25f, y + s * 0.25f, x - s * 2, y)
        path.quadTo(x - s * 0.25f, y - s * 0.25f, x, y - s * 2)
        path.close()
        fill(canvas, path, "#FFFFFF", 0.5f + g.next() * 0.5f)
      }
      "deep" -> {
        for (index in 0 until 4) {
          val i = index * 14f
          val path = Path()
          path.moveTo(0f, 30 + i)
          path.cubicTo(100f, 18 + i, 200f, 44 + i, 300f, 28 + i)
          path.cubicTo(400f, 12 + i, 400f, 36 + i, 420f, 30 + i)
          path.lineTo(420f, 90f); path.lineTo(0f, 90f); path.close()
          fill(canvas, path, "#4F8CFF", 0.12f + index * 0.05f)
        }
        repeat(10) {
          val cx = 200 + g.next() * 200; val cy = g.next() * h; val r = 1.5f + g.next() * 3.5f
          stroke(canvas, ellipse(cx, cy, r, r), "#BFD8FF", 0.6f, 1f)
        }
      }
      "aurora" -> {
        val bands = listOf("#2EE6C8" to 0f, "#7B5CFF" to 16f, "#36A8FF" to 30f)
        bands.forEachIndexed { index, band ->
          val o = band.second
          val path = Path()
          path.moveTo(120f, 70 - o)
          path.cubicTo(200f, 10 - o / 2, 260f, 80 - o, 330f, 20f)
          path.cubicTo(400f, 40 - 80 + o, 400f, 40 - o / 2, 420f, 10f)
          stroke(canvas, path, band.first, 0.38f, 18 - index * 4f, round = true)
        }
        repeat(12) {
          val cx = g.next() * w; val cy = g.next() * 40; val r = 0.8f + g.next()
          fill(canvas, ellipse(cx, cy, r, r), "#FFFFFF", 0.7f)
        }
      }
      "ember" -> {
        for (index in 0 until 9) {
          val x = 150 + index * 30f + g.next() * 10; val hh = 30 + g.next() * 40
          val path = Path()
          path.moveTo(x - 16, h)
          path.cubicTo(x - 18, h - hh * 0.5f, x - 2, h - hh * 0.6f, x, h - hh)
          path.cubicTo(x + 4, h - hh * 0.55f, x + 18, h - hh * 0.45f, x + 16, h)
          path.close()
          fill(canvas, path, if (index % 2 == 1) "#FF7A2E" else "#FF3D1F", 0.55f)
        }
        repeat(14) {
          val cx = 160 + g.next() * 240; val cy = g.next() * 50; val r = 1 + g.next() * 1.8f
          fill(canvas, ellipse(cx, cy, r, r), "#FFC36B", 0.85f)
        }
      }
      "night" -> {
        repeat(26) {
          val cx = g.next() * w; val cy = g.next() * h; val r = 0.6f + g.next() * 1.5f
          fill(canvas, ellipse(cx, cy, r, r), "#FFFFFF", 0.4f + g.next() * 0.6f)
        }
        fill(canvas, ellipse(352f, 38f, 22f, 22f), "#F3E9C6", 0.9f)
        fill(canvas, ellipse(364f, 31f, 20f, 20f), "#2A1C66", 1f)
      }
      "sakura" -> for (index in 0 until 18) {
        val x = 120 + g.next() * 280; val y = g.next() * h; val s = 3 + g.next() * 4; val a = g.next() * 180
        fill(canvas, turned(ellipse(x, y, s * 1.6f, s), a, x, y), if (index % 3 != 0) "#FFB3CC" else "#FFD6E4", 0.75f)
      }
      "mint" -> repeat(12) {
        val x = 140 + g.next() * 260; val y = g.next() * h; val s = 6 + g.next() * 8; val a = g.next() * 180
        val path = Path()
        path.moveTo(x - s, y)
        path.quadTo(x, y - s * 0.8f, x + s, y)
        path.quadTo(x, y + s * 0.8f, x - s, y)
        path.close()
        fill(canvas, turned(path, a, x, y), "#5BE3A6", 0.4f)
      }
      "platinum" -> for (index in 0 until 7) {
        val x = 150 + index * 40f
        val rect = Path().apply { addRect(RectF(x, -40f, x + 6 + (index % 3) * 5f, 130f), Path.Direction.CW) }
        fill(canvas, turned(rect, 25f, x, 40f), "#FFFFFF", 0.08f + (index % 2) * 0.08f)
      }
    }
  }
}

/** The plate behind a row (Nameplates.tsx `Nameplate`): fills its bounds, the art right-aligned and cropped to fill,
 *  a hairline border, and — unless `compact` — the readability fade from the left. */
class NameplateView(context: Context) : View(context) {
  private var art: Bitmap? = null
  private var radius = 0f
  var compact = false
    set(value) { field = value; invalidate() }
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val fade = Paint(Paint.ANTI_ALIAS_FLAG)
  private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = 0x29FFFFFF }
  private val matrix = Matrix()
  // The art's shader and the fade, kept while the plate and the size stay (rows redraw often while scrolling).
  private var madeFor: Bitmap? = null
  private var madeW = 0f; private var madeH = 0f

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  /** Empty or unknown: nothing is shown (the view hides itself). `radius` in px. */
  fun show(plate: String, radius: Float = 0f) {
    art = Nameplates.image(plate)
    this.radius = radius
    visibility = if (art == null) GONE else VISIBLE
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val image = art ?: return
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0 || h <= 0) return
    if (madeFor !== image || madeW != w || madeH != h) {
      val scale = maxOf(w / image.width, h / image.height)
      matrix.setScale(scale, scale)
      matrix.postTranslate(w - image.width * scale, (h - image.height * scale) / 2)
      picture.shader = BitmapShader(image, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(matrix) }
      fade.shader = LinearGradient(0f, 0f, w, 0f, intArrayOf(0x9E000000.toInt(), 0x52000000, 0x0D000000), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
      madeFor = image; madeW = w; madeH = h
    }
    canvas.drawRoundRect(0f, 0f, w, h, radius, radius, picture)
    if (!compact) canvas.drawRoundRect(0f, 0f, w, h, radius, radius, fade)
    border.strokeWidth = maxOf(1f, resources.displayMetrics.density / 3f)
    canvas.drawRoundRect(0.5f, 0.5f, w - 0.5f, h - 0.5f, radius, radius, border)
  }
}
