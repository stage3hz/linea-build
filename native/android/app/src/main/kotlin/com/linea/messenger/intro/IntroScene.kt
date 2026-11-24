package com.linea.messenger.intro

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import com.linea.messenger.R
import com.linea.messenger.design.Fonts
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** The intro's pictures, made once: the word INVIZ as a picture (I, V, I, Z in the app's Unbounded face; N is the
 *  app's own sign, taken from the launcher icon's artwork), the two digits a particle shows close up, and where the
 *  strokes of the cipher's signs are. */
class IntroArt(
  /** The word, white on clear, `width` × `height`; `alpha` is its coverage row by row from the top (0…255). */
  val width: Int, val height: Int, val alpha: ByteArray,
  /** Each letter's left edge and width in the picture, px: I, N, V, I, Z. */
  val spans: Array<FloatArray>,
  /** «0» and «1» side by side, 128 × 64, coverage. */
  val digits: ByteArray,
  /** The points of the strokes of 0…9, A…F, each (x, y) within about ±0.33 × ±0.5 (y up). */
  val glyphs: Array<FloatArray>,
) {
  /** The word's right end in the picture, px. */
  val wordEnd: Float get() = spans[4][0] + spans[4][1]

  fun covered(px: Double, py: Double): Boolean {
    val x = px.toInt(); val y = py.toInt()
    if (x < 0 || y < 0 || x >= width || y >= height) return false
    return (alpha[y * width + x].toInt() and 0xFF) > 127
  }

  /** The word as a bitmap (white, with its coverage), for the still stages. */
  fun bitmap(): Bitmap {
    val pixels = IntArray(width * height) { ((alpha[it].toInt() and 0xFF) shl 24) or 0xFFFFFF }
    return Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
  }

  companion object {
    /** The letters' height in the picture, px; the baseline; the picture's height; the word's left edge. */
    const val CAP = 300f
    const val BASE = 360f
    const val HEIGHT = 420
    const val LEFT = 30f
    /** Scene units per px: the letters are 10 high. */
    const val UNIT = 10.0 / CAP
    const val DIGITS_W = 128
    const val DIGITS_H = 64
    const val SIGNS = "0123456789ABCDEF"

    fun make(context: Context): IntroArt {
      val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
      paint.color = Color.WHITE
      paint.typeface = try { context.resources.getFont(R.font.unbounded_extrabold) } catch (_: Throwable) { Fonts.title }
      // The size at which a capital is CAP px high.
      paint.textSize = 300f
      val bounds = Rect()
      paint.getTextBounds("I", 0, 1, bounds)
      val size = 300f * CAP / max(1, -bounds.top)
      paint.textSize = size
      val gap = size * 0.13f

      // N: the launcher icon's sign, by its own outline (the part of the artwork that is not clear).
      val options = BitmapFactory.Options().apply { inScaled = false }
      val icon = try { BitmapFactory.decodeResource(context.resources, R.drawable.app_icon_default_fg, options) } catch (_: Throwable) { null }
      val sign = icon?.let { bounds(it) }
      val signWidth = if (sign != null && sign.height() > 0) CAP * sign.width() / sign.height() else CAP * 237f / 221f

      val word = "INVIZ"
      val spans = Array(5) { FloatArray(2) }
      var x = LEFT
      for (i in 0 until 5) {
        val w = if (i == 1) signWidth else paint.measureText(word, i, i + 1)
        spans[i][0] = x; spans[i][1] = w
        x += w + gap
      }
      val width = (x - gap + LEFT).roundToInt() + 1
      val picture = Bitmap.createBitmap(width, HEIGHT, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(picture)
      for (i in 0 until 5) {
        if (i != 1) { canvas.drawText(word, i, i + 1, spans[i][0], BASE, paint); continue }
        val place = RectF(spans[1][0], BASE - CAP, spans[1][0] + signWidth, BASE)
        if (icon != null && sign != null) {
          val white = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
          white.colorFilter = PorterDuffColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN)
          canvas.drawBitmap(icon, sign, place, white)
        } else {
          canvas.drawText("N", spans[1][0], BASE, paint)
        }
      }
      icon?.recycle()
      val pixels = IntArray(width * HEIGHT)
      picture.getPixels(pixels, 0, width, 0, 0, width, HEIGHT)
      picture.recycle()
      val alpha = ByteArray(pixels.size) { (pixels[it] ushr 24).toByte() }

      // The two digits and the cipher's signs: the system's monospace, bold.
      val mono = Paint(Paint.ANTI_ALIAS_FLAG)
      mono.color = Color.WHITE
      mono.typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
      mono.textSize = 58f
      mono.textAlign = Paint.Align.CENTER
      val two = Bitmap.createBitmap(DIGITS_W, DIGITS_H, Bitmap.Config.ARGB_8888)
      Canvas(two).apply { drawText("0", 32f, 54f, mono); drawText("1", 96f, 54f, mono) }
      val twoPixels = IntArray(DIGITS_W * DIGITS_H)
      two.getPixels(twoPixels, 0, DIGITS_W, 0, 0, DIGITS_W, DIGITS_H)
      two.recycle()
      val digits = ByteArray(twoPixels.size) { (twoPixels[it] ushr 24).toByte() }

      val cell = Bitmap.createBitmap(40, 60, Bitmap.Config.ARGB_8888)
      val cellCanvas = Canvas(cell)
      val cellPixels = IntArray(40 * 60)
      val glyphs = Array(SIGNS.length) { k ->
        cell.eraseColor(0)
        cellCanvas.drawText(SIGNS, k, k + 1, 20f, 52f, mono)
        cell.getPixels(cellPixels, 0, 40, 0, 0, 40, 60)
        val points = ArrayList<Float>()
        for (y in 0 until 60) for (px in 0 until 40) if ((cellPixels[y * 40 + px] ushr 24) > 120) { points.add((px - 20) / 60f); points.add((30 - y) / 60f) }
        if (points.isEmpty()) { points.add(0f); points.add(0f) }
        points.toFloatArray()
      }
      cell.recycle()
      return IntroArt(width, HEIGHT, alpha, spans, digits, glyphs)
    }

    /** The box of everything in the picture that is not clear. */
    private fun bounds(picture: Bitmap): Rect? {
      val w = picture.width; val h = picture.height
      val pixels = IntArray(w * h)
      picture.getPixels(pixels, 0, w, 0, 0, w, h)
      var left = w; var top = h; var right = -1; var bottom = -1
      for (y in 0 until h) for (x in 0 until w) if ((pixels[y * w + x] ushr 24) > 127) {
        if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y
      }
      return if (right < left) null else Rect(left, top, right + 1, bottom + 1)
    }
  }
}

/** The intro's scene as numbers for the graphics chip: every particle's two places (in N, in the cipher) and the
 *  squares the letters fall into. Built once from the word's picture; the same on every start. All motion is then
 *  computed by the vertex shaders from these. */
class IntroGeometry(
  /** Per particle PARTICLE numbers: its place in N (3), its place in the cipher (3), three chances and whether it
   *  belongs to N (4), its light in N and in the cipher (2). N's own particles come first. */
  val particles: FloatArray, val count: Int, val ownCount: Int,
  /** Per corner of each square (six corners) TILE numbers: the corner (2), the square's middle (2), when it leaves
   *  (1), which way (3) and how far (1). */
  val tiles: FloatArray, val tileCount: Int,
  /** The word's ends and N's sides (N's middle is x 0). */
  val left: Float, val right: Float, val signLeft: Float, val signRight: Float,
  /** The two fronts: where each starts (outside the word) and ends (at N's side). */
  val rightFrom: Float, val rightTo: Float, val leftFrom: Float, val leftTo: Float,
  /** The word's picture in the scene: x from, x to, y from (bottom), y to (top). */
  val rect: FloatArray,
) {
  companion object {
    const val PARTICLE = 12
    const val TILE = 9
    /** The honeycomb N is made of: the cells' outer radius. */
    const val CELL_RADIUS = 0.62
    /** The squares: a letter is 17 of them high; each is drawn at 0.8 of its place. */
    const val SQUARE = 10.0 / 17
    const val SQUARE_FILL = 0.8
    /** The cipher's layers, how far behind N. */
    val LAYERS = doubleArrayOf(-34.0, -58.0, -82.0, -112.0, -138.0)

    /** Whether a point lies on the lines of the honeycomb (pointy-top cells of outer radius `r`). */
    fun onLine(x: Double, y: Double, r: Double): Boolean {
      val w = r * sqrt(3.0)
      val row = Math.round(y / (r * 1.5))
      val off = if (row % 2L != 0L) w / 2 else 0.0
      val cx = Math.round((x - off) / w) * w + off
      val cy = row * r * 1.5
      val dx = abs(x - cx); val dy = abs(y - cy)
      return max(dx * 0.866 + dy * 0.5, dx) > w * 0.5 * 0.84
    }

    fun build(art: IntroArt, count: Int, seed: Int = 21): IntroGeometry {
      val random = IntroModel.Random(seed)
      val unit = IntroArt.UNIT
      val base = IntroArt.BASE.toDouble(); val cap = IntroArt.CAP.toDouble()
      val signX = art.spans[1][0].toDouble(); val signW = art.spans[1][1].toDouble()
      val ox = signX + signW / 2
      val left = (IntroArt.LEFT - ox) * unit
      val right = (art.wordEnd - ox) * unit

      // A point of N: mostly on the honeycomb's lines, some inside the cells.
      val point = DoubleArray(3)
      fun sign() {
        for (k in 0 until 400) {
          val px = signX + random.next() * signW; val py = base - cap + random.next() * cap
          if (!art.covered(px, py)) continue
          val x = (px - ox) * unit; val y = (base - py) * unit
          val line = onLine(x, y, CELL_RADIUS)
          if (!line && random.next() < 0.72) continue
          point[0] = x; point[1] = y; point[2] = if (line) 1.0 else 0.0
          return
        }
        point[0] = 0.0; point[1] = 5.0; point[2] = 0.0
      }
      var signLeft = 1e9; var signRight = -1e9
      for (k in 0 until 4000) { sign(); signLeft = min(signLeft, point[0]); signRight = max(signRight, point[0]) }
      val rightFrom = right + 0.6; val rightTo = signRight + 0.2
      val leftFrom = left - 0.6; val leftTo = signLeft - 0.2

      // The cipher: rows of signs on each layer, in groups of two or four with gaps; one in six is bright.
      val cells = ArrayList<DoubleArray>() // x, y, z, size, sign, light
      for ((l, z) in LAYERS.withIndex()) {
        val size = 2.6 + (l % 3) * 0.7; val stepX = size * 0.66; val stepY = size * 1.25
        var y = -34.0
        while (y <= 34.0) {
          var x = -22 + random.next() * 2
          while (x < 22) {
            val n = if (random.next() < 0.5) 2 else 4
            val on = random.next() < 0.6
            for (k in 0 until n) {
              if (on) cells.add(doubleArrayOf(x, y, z + (random.next() - 0.5) * 1.5, size, floor(random.next() * 16), if (random.next() < 0.16) 1.0 else 0.42))
              x += stepX
            }
            x += stepX * 0.8
          }
          y += stepY
        }
      }

      val own = count / 4
      val particles = FloatArray(count * PARTICLE)
      for (i in 0 until count) {
        val o = i * PARTICLE
        sign()
        particles[o] = point[0].toFloat(); particles[o + 1] = point[1].toFloat(); particles[o + 2] = ((random.next() - 0.5) * 1.9).toFloat()
        val light = if (point[2] > 0.5) 1.0 else 0.3
        val cell = cells[min(cells.size - 1, (random.next() * cells.size).toInt())]
        val strokes = art.glyphs[cell[4].toInt().coerceIn(0, art.glyphs.size - 1)]
        val q = min(strokes.size / 2 - 1, (random.next() * (strokes.size / 2)).toInt())
        particles[o + 3] = (cell[0] + strokes[2 * q] * cell[3] + (random.next() - 0.5) * 0.03).toFloat()
        particles[o + 4] = (IntroModel.N_Y + cell[1] + strokes[2 * q + 1] * cell[3] + (random.next() - 0.5) * 0.03).toFloat()
        particles[o + 5] = (cell[2] + (random.next() - 0.5) * 0.2).toFloat()
        particles[o + 6] = random.next().toFloat(); particles[o + 7] = random.next().toFloat(); particles[o + 8] = random.next().toFloat()
        particles[o + 9] = if (i < own) 1f else 0f
        particles[o + 10] = (if (i < own) light else max(light, 0.55)).toFloat()
        particles[o + 11] = cell[5].toFloat()
      }

      // The squares of I, V, I, Z: each waits a moment behind its front, then leaves along a straight line away from N.
      val step = cap / 17
      val tiles = ArrayList<Float>()
      val half = (SQUARE * SQUARE_FILL / 2).toFloat()
      val corners = floatArrayOf(-half, -half, half, -half, half, half, -half, -half, half, half, -half, half)
      for (i in intArrayOf(0, 2, 3, 4)) {
        val lx = art.spans[i][0].toDouble(); val w = art.spans[i][1].toDouble()
        var py = base - cap
        while (py < base - 0.01) {
          var px = lx
          while (px < lx + w) {
            if (art.covered(px + step / 2, py + step / 2)) {
              val cx = (px + step / 2 - ox) * unit; val cy = (base - py - step / 2) * unit
              fun chance(k: Int): Double { val v = sin(cx * 127.1 + cy * 311.7 + k * 19.19) * 43758.5453; return v - floor(v) }
              val toRight = cx > 0
              val reached = if (toRight) IntroModel.CRUMBLE_START + IntroModel.RIGHT_LENGTH * (rightFrom - cx) / (rightFrom - rightTo)
              else IntroModel.LEFT_START + IntroModel.LEFT_LENGTH * (cx - leftFrom) / (leftTo - leftFrom)
              val leaves = reached + 0.05 + chance(1) * chance(1) * 0.5
              val vx = if (toRight) 1.0 else -1.0
              val vy = (cy - 5) / 5 * 0.22 + (chance(2) - 0.5) * 0.22
              val vz = (chance(3) - 0.5) * 0.35
              val length = hypot(hypot(vx, vy), vz)
              val fly = 9 + chance(4) * chance(4) * 46
              for (c in 0 until 6) {
                tiles.add(corners[2 * c]); tiles.add(corners[2 * c + 1])
                tiles.add(cx.toFloat()); tiles.add(cy.toFloat()); tiles.add(leaves.toFloat())
                tiles.add((vx / length).toFloat()); tiles.add((vy / length).toFloat()); tiles.add((vz / length).toFloat()); tiles.add(fly.toFloat())
              }
            }
            px += step
          }
          py += step
        }
      }
      val rect = floatArrayOf(((0 - ox) * unit).toFloat(), ((art.width - ox) * unit).toFloat(), ((base - art.height) * unit).toFloat(), (base * unit).toFloat())
      return IntroGeometry(
        particles, count, own, tiles.toFloatArray(), tiles.size / (TILE * 6),
        left.toFloat(), right.toFloat(), signLeft.toFloat(), signRight.toFloat(),
        rightFrom.toFloat(), rightTo.toFloat(), leftFrom.toFloat(), leftTo.toFloat(), rect,
      )
    }
  }
}
