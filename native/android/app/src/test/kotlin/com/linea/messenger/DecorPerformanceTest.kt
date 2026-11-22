package com.linea.messenger

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.view.View
import android.widget.FrameLayout
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.avatars.AvatarMotion
import com.linea.messenger.avatars.CodeFrameView
import com.linea.messenger.avatars.DecorTicker
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.avatars.DecorationArtView
import com.linea.messenger.avatars.NameplateView
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.avatars.PlatinaNameView
import com.linea.messenger.avatars.PlatinaSealView
import com.linea.messenger.people.Person
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/** The moving decorations are cheap: each live frame drawn 120 times makes (almost) nothing new and stays inside a
 *  time budget; the cached drawing looks like the first port, pixel for pixel within the smoothing of a picture;
 *  and one shared clock drives them only while they are on screen and the app's animations are on. (The CI emulator,
 *  drawing in software, went down on the page of eight live code-drawn frames.) */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DecorPerformanceTest {
  private val context: android.content.Context get() = RuntimeEnvironment.getApplication()
  // java.lang.management is not on the Android compile path; the test JVM (HotSpot) has it.
  private val threads: Any = Class.forName("java.lang.management.ManagementFactory").getMethod("getThreadMXBean").invoke(null)!!
  private val allocatedBytes = Class.forName("com.sun.management.ThreadMXBean").getMethod("getThreadAllocatedBytes", Long::class.javaPrimitiveType)
  private fun allocated(): Long = allocatedBytes.invoke(threads, Thread.currentThread().id) as Long

  /** At most this many bytes per draw beyond what measuring itself costs (a stray boxed number, not a gradient). */
  private val allocationBound = 96L
  /** Average time of one software draw of one decoration on the JVM (generous: CI machines are slow). */
  private val budgetMicros = 4000L

  @After fun motionBack() { AvatarMotion.override = null; DecorTicker.refresh() }

  private class Cost(val bytes: Long, val micros: Long)

  /** A canvas that draws nothing: what a draw allocates is then the app's own (Robolectric's software canvas
   *  allocates inside its own bindings on every call, which a phone's canvas does not). */
  private class NullCanvas : Canvas() {
    override fun save(): Int = 1
    override fun saveLayer(bounds: RectF?, paint: Paint?): Int = 1
    override fun restore() {}
    override fun restoreToCount(saveCount: Int) {}
    override fun translate(dx: Float, dy: Float) {}
    override fun scale(sx: Float, sy: Float) {}
    override fun rotate(degrees: Float) {}
    override fun concat(matrix: Matrix?) {}
    override fun clipRect(rect: RectF): Boolean = true
    override fun clipRect(left: Float, top: Float, right: Float, bottom: Float): Boolean = true
    override fun drawColor(color: Int) {}
    override fun drawCircle(cx: Float, cy: Float, radius: Float, paint: Paint) {}
    override fun drawRect(left: Float, top: Float, right: Float, bottom: Float, paint: Paint) {}
    override fun drawRect(rect: RectF, paint: Paint) {}
    override fun drawOval(oval: RectF, paint: Paint) {}
    override fun drawOval(left: Float, top: Float, right: Float, bottom: Float, paint: Paint) {}
    override fun drawRoundRect(left: Float, top: Float, right: Float, bottom: Float, rx: Float, ry: Float, paint: Paint) {}
    override fun drawRoundRect(rect: RectF, rx: Float, ry: Float, paint: Paint) {}
    override fun drawPath(path: Path, paint: Paint) {}
    override fun drawBitmap(bitmap: Bitmap, left: Float, top: Float, paint: Paint?) {}
    override fun drawBitmap(bitmap: Bitmap, src: Rect?, dst: RectF, paint: Paint?) {}
    override fun drawBitmap(bitmap: Bitmap, matrix: Matrix, paint: Paint?) {}
    override fun drawText(text: String, x: Float, y: Float, paint: Paint) {}
    override fun drawArc(oval: RectF, startAngle: Float, sweepAngle: Float, useCenter: Boolean, paint: Paint) {}
  }

  /** Draws 120 times (after 20 to warm up): the bytes made on a canvas that draws nothing, and the average time of
   *  a real software draw. `draw` gets the canvas and the draw's number. */
  private fun measure(side: Int, draw: (Canvas, Int) -> Unit): Cost {
    val canvas = Canvas(Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888))
    val empty = NullCanvas()
    repeat(20) { draw(canvas, it); draw(empty, it) }
    // The smaller of two rounds: something made once (a class loaded, a cache filled) is not made on every draw.
    var bytes = Long.MAX_VALUE
    repeat(2) {
      val before = allocated()
      for (index in 0 until 120) draw(empty, index)
      bytes = minOf(bytes, (allocated() - before) / 120)
    }
    val start = System.nanoTime()
    for (index in 0 until 120) draw(canvas, index)
    val micros = (System.nanoTime() - start) / 120 / 1000
    return Cost(bytes, micros)
  }

  private val overhead: Long by lazy { measure(16) { canvas, _ -> canvas.drawColor(0) }.bytes }

  private val costly = ArrayList<String>()

  private fun check(name: String, cost: Cost) {
    println("decor cost $name: ${cost.bytes} B/draw (measuring: $overhead), ${cost.micros} µs/draw")
    if (cost.bytes - overhead > allocationBound) costly.add("$name makes ${cost.bytes} B on every draw")
    // Time is only judged on a developer machine: shared CI runners are too uneven for a time budget.
    if (System.getenv("CI") == null && cost.micros > budgetMicros) costly.add("$name takes ${cost.micros} µs a draw")
  }

  @After fun nothingCostly() { assertTrue(costly.joinToString("; "), costly.isEmpty()) }

  private fun sized(view: View, side: Int): View {
    view.measure(View.MeasureSpec.makeMeasureSpec(side, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(side, View.MeasureSpec.EXACTLY))
    view.layout(0, 0, side, side)
    return view
  }

  /** Mean difference per premultiplied channel (0…255) and the share of pixels off by more than 48 in some channel. */
  private fun difference(a: Bitmap, b: Bitmap): Pair<Double, Double> {
    var sum = 0L; var far = 0
    val n = a.width * a.height
    val pa = IntArray(n); val pb = IntArray(n)
    a.getPixels(pa, 0, a.width, 0, 0, a.width, a.height); b.getPixels(pb, 0, b.width, 0, 0, b.width, b.height)
    for (i in 0 until n) {
      val p = pa[i]; val q = pb[i]
      var most = 0
      // Premultiplied (as the screen blends them): the colour of an almost clear pixel does not count.
      val ap = p ushr 24; val aq = q ushr 24
      for (shift in intArrayOf(24, 16, 8, 0)) {
        val u = (p ushr shift) and 0xFF; val v = (q ushr shift) and 0xFF
        val d = if (shift == 24) abs(u - v) else abs(u * ap / 255 - v * aq / 255)
        sum += d; if (d > most) most = d
      }
      if (most > 48) far += 1
    }
    return sum / (4.0 * n) to far.toDouble() / n
  }

  // An 80 dp avatar at 420 dpi: the art's box is 1.3 × 210 px.
  private val art = 273

  @Test fun theCodeFramesMakeNothingOnTheirFramesAndStayInBudget() {
    for (item in AvatarCatalog.codeFrames) {
      val view = CodeFrameView(context, item.id)
      view.live = true
      sized(view, art)
      check(item.id, measure(art) { canvas, index -> view.fixedSeconds = 0.5 + index / 60.0; view.draw(canvas) })
    }
  }

  @Test fun theCodeFramesLookAsTheFirstPort() {
    val wrong = ArrayList<String>()
    for (item in AvatarCatalog.codeFrames) for (moment in listOf(-1.0, 0.0, 0.37, 1.25, 2.9, 6.4)) {
      val view = CodeFrameView(context, item.id)
      val live = moment >= 0
      view.live = live
      if (live) view.fixedSeconds = moment
      val now = Bitmap.createBitmap(art, art, Bitmap.Config.ARGB_8888)
      sized(view, art).draw(Canvas(now))
      val was = Bitmap.createBitmap(art, art, Bitmap.Config.ARGB_8888)
      ReferenceCodeFrame(item.id, live, moment.coerceAtLeast(0.0)).paint(Canvas(was), art.toFloat(), art.toFloat())
      val (mean, far) = difference(now, was)
      println("decor look ${item.id} @$moment: mean ${"%.3f".format(mean)}, far ${"%.4f".format(far)}")
      if (mean >= 1.0 || far >= 0.004) wrong.add("${item.id} at $moment: mean $mean, far $far")
    }
    assertTrue(wrong.joinToString("; "), wrong.isEmpty())
  }

  @Test fun theArtMakesNothingOnItsFramesAndLooksAsBefore() {
    val wrong = ArrayList<String>()
    for (decoration in AvatarCatalog.decorations) {
      val side = Math.round(210 * decoration.scale)
      val view = DecorationArtView(context, decoration)
      view.live = true
      sized(view, side)
      check(decoration.id, measure(side) { canvas, index -> view.fixedSeconds = 2.0 + index / 60.0; view.draw(canvas) })
      // The sweep (masked by the art without a layer), the glow and the sparks as the first port drew them.
      for (moment in listOf(0.3, 0.75, 1.2, 3.0, 5.1)) {
        view.fixedSeconds = moment
        val now = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(now))
        val was = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        ReferenceDecorationArt(context, decoration, true, moment).paint(Canvas(was), side.toFloat(), side.toFloat())
        val (mean, far) = difference(now, was)
        if (System.getenv("DECOR_DUMP") != null) {
          java.io.File("build/decor").mkdirs()
          java.io.File("build/decor/${decoration.id}-$moment-now.png").outputStream().use { now.compress(Bitmap.CompressFormat.PNG, 100, it) }
          java.io.File("build/decor/${decoration.id}-$moment-was.png").outputStream().use { was.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        println("decor look ${decoration.id} @$moment: mean ${"%.3f".format(mean)}, far ${"%.4f".format(far)}")
        if (mean >= 1.0 || far >= 0.004) wrong.add("${decoration.id} at $moment: mean $mean, far $far")
      }
    }
    assertTrue(wrong.joinToString("; "), wrong.isEmpty())
  }

  private fun person(look: Map<String, Any?>) = Person("p1", "vera", "Вера Соколова", "", "", 0x9B6BF2, "", look = PersonLook.from(look))

  @Test fun theTurningRingsPlatesAndMetalMakeNothingOnTheirFrames() {
    val side = 210
    for (frame in AvatarCatalog.frames) {
      val avatar = DecoratedAvatarView(context)
      val someone = person(mapOf("avatarFrame" to frame.id, "seal" to "platina"))
      avatar.show(someone, someone.look, "", animated = true)
      sized(avatar, side)
      check("ring ${frame.id}", measure(side * 2) { canvas, _ -> avatar.draw(canvas) })
    }
    for (plate in AvatarCatalog.plates) {
      val view = NameplateView(context).apply { show(plate.id, 40f) }
      view.measure(View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(168, View.MeasureSpec.EXACTLY))
      view.layout(0, 0, 1000, 168)
      check("plate ${plate.id}", measure(1000) { canvas, _ -> view.draw(canvas) })
    }
    val seal = PlatinaSealView(context)
    seal.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    seal.layout(0, 0, seal.measuredWidth, seal.measuredHeight)
    check("seal", measure(400) { canvas, _ -> seal.draw(canvas) })
  }

  @Test fun oneClockDrivesThemOnlyWhileTheyAreShownAndAnimationsAreOn() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val root = FrameLayout(activity)
    activity.setContentView(root)
    val frames = AvatarCatalog.codeFrames.map { CodeFrameView(activity, it.id).apply { live = true } }
    val name = PlatinaNameView(activity).apply { show("Вера", platina = true) }
    for (view in frames) root.addView(view, FrameLayout.LayoutParams(art, art))
    root.addView(name)
    shadowOf(activity.mainLooper).idleFor(200, TimeUnit.MILLISECONDS)
    val mine = frames + name
    assertTrue(mine.all { DecorTicker.ticking(it) })
    // Hidden or gone from the window: off the clock.
    frames[0].visibility = View.GONE
    shadowOf(activity.mainLooper).idle()
    assertFalse(DecorTicker.ticking(frames[0]))
    root.removeView(frames[1])
    assertFalse(DecorTicker.ticking(frames[1]))
    assertTrue(DecorTicker.ticking(frames[2]))
    // Animations off (power saving, «Удалить анимации», the app's switch): the frames hold their still picture.
    AvatarMotion.override = { false }
    DecorTicker.refresh()
    assertFalse(DecorTicker.allowed)
    assertFalse(frames[2].live)
    AvatarMotion.override = null
    DecorTicker.refresh()
    assertTrue(frames[2].live)
    root.removeAllViews()
    assertTrue(mine.none { DecorTicker.ticking(it) })
  }
}
