package com.linea.messenger.intro

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.os.SystemClock
import android.view.Choreographer
import android.view.View
import java.nio.ByteBuffer
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** The first-launch intro drawn for time t (intro/IntroModel.kt has every number): the graphite background, the
 *  honeycomb field lit by its ring wave, the plate of light behind N, N's slab with its thickness (the back and the
 *  side as offset layers, the front face with its honeycomb), the particles as small squares sorted back to front,
 *  and a soft glow — the bright layers drawn once more into a small alpha bitmap, blurred and laid over at 0.7.
 *  Plays on the frame clock (Choreographer); `hold(t)` freezes it at t. iOS: Sources/Intro/IntroView.swift. */
@SuppressLint("ViewConstructor")
class IntroView(context: Context) : View(context), Choreographer.FrameCallback {
  /** Called on every frame with the time, s (the overlay ends the intro by it). */
  var onTime: ((Double) -> Unit)? = null

  private val world = IntroModel.scene
  private val field = IntroModel.field
  private val face = IntroModel.faceCells
  private val plate = IntroModel.plate(world)
  private val density = resources.displayMetrics.density

  /** The time shown now, s. */
  var time = 0.0
    private set
  private var started = -1L
  private var running = false

  // Work arrays: no allocation per frame.
  private val count = world.particles.size
  private val state = DoubleArray(6)
  private val quads = DoubleArray(count * 8)
  private val depth = DoubleArray(count)
  private val bright = DoubleArray(count)
  private val order = IntArray(count) { it }
  private val point = DoubleArray(3)
  private val point2 = DoubleArray(3)
  private val fieldGlow = DoubleArray(field.count)

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  private val glowPaint = Paint(Paint.FILTER_BITMAP_FLAG).apply { color = Color.rgb(242, 244, 255); alpha = (0.7 * 255).roundToInt() }
  private val path = Path()
  private val levels = 16
  private val paths = Array(levels) { Path() }
  private val fieldLines = Array(levels) { FloatArray(field.count * 4) }
  private val fieldUsed = IntArray(levels)
  private val faceLines = FloatArray(face.size)

  private var glow: Bitmap? = null
  private var glowCanvas: Canvas? = null
  private var glowBytes: ByteArray = ByteArray(0)
  private var glowWork: ByteArray = ByteArray(0)

  init {
    setBackgroundColor(0)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    contentDescription = "Инвиз"
    isFocusable = true
    isClickable = true
  }

  /** Starts the clock at the next frame. `begin` gets the uptime (ms) of t = 0, for the haptics. */
  fun play(begin: (Long) -> Unit) {
    started = SystemClock.uptimeMillis()
    begin(started)
    running = true
    Choreographer.getInstance().postFrameCallback(this)
  }

  /** Shows the frame at t and stays there. */
  fun hold(t: Double) {
    stop()
    time = t
    invalidate()
  }

  fun stop() {
    running = false
    Choreographer.getInstance().removeFrameCallback(this)
  }

  override fun doFrame(frameTimeNanos: Long) {
    if (!running) return
    time = (SystemClock.uptimeMillis() - started) / 1000.0
    invalidate()
    onTime?.invoke(time)
    if (running) Choreographer.getInstance().postFrameCallback(this)
  }

  override fun onDetachedFromWindow() {
    stop()
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width; val h = height
    if (w <= 0 || h <= 0) return
    val t = min(time, IntroModel.DURATION)
    canvas.drawColor(BACKGROUND)
    val projector = IntroModel.Projector(IntroModel.camera(t, world), w.toDouble(), h.toDouble())
    prepare(projector, t)
    drawScene(canvas, projector, t, 1f, false)
    drawGlow(canvas, projector, t, w, h)
  }

  /** The per-frame numbers both passes use: the particles' squares on the screen in depth order, the field's light. */
  private fun prepare(projector: IntroModel.Projector, t: Double) {
    val cell = world.cell
    for (i in 0 until count) {
      IntroModel.particle(world.particles[i], t, cell, state)
      val half = state[3] / 2
      val c = cos(state[5]); val s = sin(state[5])
      bright[i] = state[4]
      for (k in 0 until 4) {
        val sx = if (k == 0 || k == 3) -half else half
        val sy = if (k < 2) -half else half
        projector.project(state[0] + sx * c - sy * s, state[1] + sx * s + sy * c, state[2], point)
        quads[i * 8 + k * 2] = point[0]; quads[i * 8 + k * 2 + 1] = point[1]
      }
      projector.project(state[0], state[1], state[2], point)
      depth[i] = if (half <= 0) -1.0 else point[2]
    }
    // Back to front (insertion sort: the order hardly changes from one frame to the next).
    for (i in 1 until count) {
      val v = order[i]; var j = i - 1
      while (j >= 0 && depth[order[j]] < depth[v]) { order[j + 1] = order[j]; j-- }
      order[j + 1] = v
    }
    for (i in 0 until field.count) fieldGlow[i] = IntroModel.edgeGlow(field, i, t)
  }

  /** One pass of the scene. `scale` maps the view's pixels to the canvas (the glow's small bitmap: < 1); `light`
   *  draws only the bright layers, as alpha (the glow pass). */
  private fun drawScene(canvas: Canvas, projector: IntroModel.Projector, t: Double, scale: Float, light: Boolean) {
    canvas.save()
    canvas.scale(scale, scale)
    drawField(canvas, projector, scale, light)
    drawPlate(canvas, projector, t, light)
    drawParticles(canvas, light)
    drawSlab(canvas, projector, t, scale, light)
    canvas.restore()
  }

  private fun drawField(canvas: Canvas, projector: IntroModel.Projector, scale: Float, light: Boolean) {
    fieldUsed.fill(0)
    val l = field.lines
    for (i in 0 until field.count) {
      val v = fieldGlow[i]
      if (v < 0.01) continue
      val level = min(levels - 1, (min(1.0, v) * levels).toInt())
      projector.project(l[4 * i], l[4 * i + 1], IntroModel.FIELD_Z, point)
      projector.project(l[4 * i + 2], l[4 * i + 3], IntroModel.FIELD_Z, point2)
      val into = fieldLines[level]; val at = fieldUsed[level]
      into[at] = point[0].toFloat(); into[at + 1] = point[1].toFloat(); into[at + 2] = point2[0].toFloat(); into[at + 3] = point2[1].toFloat()
      fieldUsed[level] = at + 4
    }
    linePaint.strokeWidth = max(1f / scale, 0.8f * density)
    for (level in 0 until levels) {
      if (fieldUsed[level] == 0) continue
      val v = (level + 0.5f) / levels
      linePaint.color = if (light) Color.argb((v * 255).roundToInt(), 255, 255, 255) else Color.argb((v * 255).roundToInt(), 236, 240, 255)
      canvas.drawLines(fieldLines[level], 0, fieldUsed[level], linePaint)
    }
  }

  private fun outline(projector: IntroModel.Projector, pieces: List<DoubleArray>, z: Double): Path {
    path.rewind()
    for (piece in pieces) {
      for (k in piece.indices step 2) {
        projector.project(piece[k], piece[k + 1], z, point)
        if (k == 0) path.moveTo(point[0].toFloat(), point[1].toFloat()) else path.lineTo(point[0].toFloat(), point[1].toFloat())
      }
      path.close()
    }
    return path
  }

  private fun drawPlate(canvas: Canvas, projector: IntroModel.Projector, t: Double, light: Boolean) {
    val hal = IntroModel.clamp(IntroModel.flare(t), 0.0, 1.0)
    paint.style = Paint.Style.FILL
    paint.shader = null
    paint.color = if (light) Color.argb((hal * 0.9 * 255).roundToInt(), 255, 255, 255) else gray(hal)
    canvas.drawPath(outline(projector, plate, IntroModel.PLATE_Z), paint)
  }

  private fun drawParticles(canvas: Canvas, light: Boolean) {
    for (p in paths) p.rewind()
    for (n in 0 until count) {
      val i = order[n]
      if (depth[i] < 0) continue
      val level = min(levels - 1, (IntroModel.clamp(bright[i], 0.0, 1.0) * levels).toInt())
      val into = paths[level]; val q = i * 8
      into.moveTo(quads[q].toFloat(), quads[q + 1].toFloat())
      into.lineTo(quads[q + 2].toFloat(), quads[q + 3].toFloat())
      into.lineTo(quads[q + 4].toFloat(), quads[q + 5].toFloat())
      into.lineTo(quads[q + 6].toFloat(), quads[q + 7].toFloat())
      into.close()
    }
    paint.style = Paint.Style.FILL
    paint.shader = null
    for (level in 0 until levels) {
      if (paths[level].isEmpty) continue
      val v = (level + 0.5) / levels
      paint.color = if (light) Color.argb((v * 255).roundToInt(), 255, 255, 255) else gray(v)
      canvas.drawPath(paths[level], paint)
    }
  }

  private fun drawSlab(canvas: Canvas, projector: IntroModel.Projector, t: Double, scale: Float, light: Boolean) {
    val body = IntroModel.body(t)
    paint.style = Paint.Style.FILL
    paint.shader = null
    if (!light) {
      // The back and the side: the outline drawn at depths from the back to the front, darker behind.
      for (layer in 0 until SLAB_LAYERS) {
        val k = layer.toDouble() / SLAB_LAYERS
        val z = IntroModel.SLAB_BACK + (IntroModel.SLAB_FRONT - IntroModel.SLAB_BACK) * k
        paint.color = rgb(mix(SIDE_BACK, SIDE_FRONT, k), body)
        canvas.drawPath(outline(projector, world.mark, z), paint)
      }
    }
    // The front face: dark and glossy, the honeycomb lighter on it.
    val front = outline(projector, world.mark, IntroModel.SLAB_FRONT)
    canvas.save()
    canvas.clipPath(front)
    if (!light) {
      paint.color = rgb(FACE, body)
      canvas.drawPath(front, paint)
      projector.project(-6.0, 10.5, IntroModel.SLAB_FRONT, point)
      projector.project(4.0, 0.0, IntroModel.SLAB_FRONT, point2)
      paint.shader = LinearGradient(point[0].toFloat(), point[1].toFloat(), point2[0].toFloat(), point2[1].toFloat(),
        intArrayOf(Color.argb((0.22 * body * 255).roundToInt(), 255, 255, 255), Color.argb(0, 255, 255, 255), Color.argb((0.08 * body * 255).roundToInt(), 255, 255, 255)),
        floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
      canvas.drawPath(front, paint)
      paint.shader = null
    }
    for (k in face.indices step 4) {
      projector.project(face[k], face[k + 1], IntroModel.SLAB_FRONT, point)
      projector.project(face[k + 2], face[k + 3], IntroModel.SLAB_FRONT, point2)
      faceLines[k] = point[0].toFloat(); faceLines[k + 1] = point[1].toFloat(); faceLines[k + 2] = point2[0].toFloat(); faceLines[k + 3] = point2[1].toFloat()
    }
    // The lines' width: 0.15 scene units (the preview's border band of each cell) at N's depth.
    projector.project(0.0, 5.0, IntroModel.SLAB_FRONT, point)
    linePaint.strokeWidth = max(1f / scale, (0.15 * projector.focal / point[2]).toFloat())
    linePaint.color = if (light) Color.argb((0.15 * body * 255).roundToInt(), 255, 255, 255) else rgb(FACE_LINES, body)
    canvas.drawLines(faceLines, 0, face.size, linePaint)
    canvas.restore()
  }

  /** The glow: the bright layers into a small alpha bitmap, blurred, laid over the frame (white × alpha × 0.7 —
   *  the preview's screen-blended bloom). */
  private fun drawGlow(canvas: Canvas, projector: IntroModel.Projector, t: Double, w: Int, h: Int) {
    val down = max(3f, 2.7f * density)
    val gw = max(1, (w / down).roundToInt()); val gh = max(1, (h / down).roundToInt())
    var bitmap = glow
    if (bitmap == null || bitmap.width != gw || bitmap.height != gh) {
      bitmap = Bitmap.createBitmap(gw, gh, Bitmap.Config.ALPHA_8)
      glow = bitmap; glowCanvas = Canvas(bitmap)
      glowBytes = ByteArray(bitmap.rowBytes * gh); glowWork = ByteArray(glowBytes.size)
    }
    val small = glowCanvas ?: return
    bitmap.eraseColor(0)
    drawScene(small, projector, t, gw.toFloat() / w, true)
    val buffer = ByteBuffer.wrap(glowBytes)
    bitmap.copyPixelsToBuffer(buffer)
    IntroBlur.box(glowBytes, glowWork, gw, gh, bitmap.rowBytes, 2)
    IntroBlur.box(glowBytes, glowWork, gw, gh, bitmap.rowBytes, 2)
    buffer.rewind()
    bitmap.copyPixelsFromBuffer(buffer)
    canvas.save()
    canvas.scale(w.toFloat() / gw, h.toFloat() / gh)
    canvas.drawBitmap(bitmap, 0f, 0f, glowPaint)
    canvas.restore()
  }

  private fun gray(v: Double): Int { val c = (IntroModel.clamp(v, 0.0, 1.0) * 255).roundToInt(); return Color.rgb(c, c, c) }
  private fun rgb(c: DoubleArray, k: Double): Int = Color.rgb(
    (IntroModel.clamp(c[0] * k, 0.0, 1.0) * 255).roundToInt(), (IntroModel.clamp(c[1] * k, 0.0, 1.0) * 255).roundToInt(), (IntroModel.clamp(c[2] * k, 0.0, 1.0) * 255).roundToInt())
  private fun mix(a: DoubleArray, b: DoubleArray, k: Double): DoubleArray = doubleArrayOf(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k)

  companion object {
    /** The graphite of the preview's stage. */
    val BACKGROUND = Color.rgb(11, 12, 16)
    /** N's colours (0…1), lit: the face, its honeycomb lines, the side at the front and at the back. */
    val FACE = doubleArrayOf(0.13, 0.145, 0.175)
    val FACE_LINES = doubleArrayOf(0.5, 0.55, 0.66)
    val SIDE_FRONT = doubleArrayOf(0.3, 0.33, 0.39)
    val SIDE_BACK = doubleArrayOf(0.08, 0.09, 0.11)
    const val SLAB_LAYERS = 10
  }
}

/** A separable box blur of an 8-bit plane, in place (`work` the same size). Twice ≈ a soft Gaussian. */
object IntroBlur {
  fun box(plane: ByteArray, work: ByteArray, w: Int, h: Int, stride: Int, radius: Int) {
    val span = 2 * radius + 1
    for (y in 0 until h) {
      val row = y * stride
      var sum = 0
      for (k in -radius..radius) sum += plane[row + k.coerceIn(0, w - 1)].toInt() and 255
      for (x in 0 until w) {
        work[row + x] = (sum / span).toByte()
        sum += (plane[row + min(w - 1, x + radius + 1)].toInt() and 255) - (plane[row + max(0, x - radius)].toInt() and 255)
      }
    }
    for (x in 0 until w) {
      var sum = 0
      for (k in -radius..radius) sum += work[k.coerceIn(0, h - 1) * stride + x].toInt() and 255
      for (y in 0 until h) {
        plane[y * stride + x] = (sum / span).toByte()
        sum += (work[min(h - 1, y + radius + 1) * stride + x].toInt() and 255) - (work[max(0, y - radius) * stride + x].toInt() and 255)
      }
    }
  }
}
