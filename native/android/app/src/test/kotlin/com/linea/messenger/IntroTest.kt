package com.linea.messenger

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import com.linea.messenger.effects.Motion
import com.linea.messenger.intro.IntroHaptics
import com.linea.messenger.intro.IntroModel
import com.linea.messenger.intro.IntroOverlay
import com.linea.messenger.intro.IntroView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import kotlin.math.hypot

/** The first-launch intro (intro/): the pure timeline against the approved preview's formulas, the swell of the
 *  haptics, the rules of when it plays, and pictures of four moments in build/pages/. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class IntroTest {
  private val scene = IntroModel.scene

  @Test fun generatorIsThePreviewsMulberry32() {
    // The preview's rng(5), first five values (node, the preview's own function).
    val r = IntroModel.Mulberry32(5)
    val expected = doubleArrayOf(0.68977491091936827, 0.77274327329359949, 0.21976301027461886, 0.62317882222123444, 0.085137201240286231)
    for (value in expected) assertEquals(value, r.next(), 1e-15)
  }

  @Test fun theWordIsBuiltAsThePreviewBuildsIt() {
    // Reference: the preview's build() run in node with the same outlines (scratch ref.js): 565 cubes, 282 lost.
    assertEquals(565, scene.particles.size)
    assertEquals(282, scene.particles.count { it.lost })
    assertEquals(39.8977485259838, scene.span, 1e-9)
    assertEquals(11.9219909502262, scene.leftSpan, 1e-9)
    val first = scene.particles[0]
    assertEquals(-11.0396380090498, first.x0, 1e-9); assertEquals(9.70588235294118, first.y0, 1e-9)
    assertEquals(-0.865286230703619, first.vx, 1e-9); assertEquals(0.501278105401307, first.vy, 1e-9)
    assertEquals(1.55547104249183, first.fly, 1e-9); assertFalse(first.lost); assertEquals(1.68329470555531, first.t0, 1e-9)
    val last = scene.particles.last()
    assertEquals(38.3721266968327, last.x0, 1e-9); assertEquals(14.4032716722234, last.fly, 1e-9); assertTrue(last.lost)
    val at = IntroModel.particle(last, 2.0)
    assertEquals(51.9972592165182, at.x, 1e-9); assertEquals(-2.92118736257987, at.y, 1e-9); assertEquals(-1.47103478133060, at.z, 1e-9)
    assertEquals(0.469346541321127, at.brightness, 1e-9)
  }

  @Test fun theModelIsDeterministic() {
    val again = IntroModel.build()
    assertEquals(scene.particles.size, again.particles.size)
    for (i in scene.particles.indices) {
      val a = scene.particles[i]; val b = again.particles[i]
      assertEquals(a.x0, b.x0, 0.0); assertEquals(a.y0, b.y0, 0.0); assertEquals(a.fly, b.fly, 0.0); assertEquals(a.t0, b.t0, 0.0); assertEquals(a.lost, b.lost)
      for (t in doubleArrayOf(0.5, 1.9, 3.3)) assertEquals(IntroModel.particle(a, t), IntroModel.particle(b, t, again.cell))
    }
  }

  @Test fun nStandsStill() {
    // N is no particle: none of the squares starts on N, and N's outlines, plate and honeycomb do not depend on time.
    for (q in scene.particles) for (piece in scene.mark) assertFalse(IntroModel.inside(piece, q.x0, q.y0))
    val again = IntroModel.build()
    for (k in scene.mark.indices) assertTrue(scene.mark[k].contentEquals(again.mark[k]))
    assertTrue(IntroModel.faceCells.isNotEmpty())
    // N's middle is the scene's origin (x 0, 5 high): the plate is 1.06 of N about it.
    val plate = IntroModel.plate()
    assertEquals(scene.mark[0][0] * 1.06, plate[0][0], 1e-12)
  }

  @Test fun atTheStartEveryParticleIsHome() {
    for (q in scene.particles) {
      val s = IntroModel.particle(q, 0.0)
      assertEquals(q.x0, s.x, 1e-12); assertEquals(0.0, s.z, 1e-12); assertEquals(0.0, s.brightness, 1e-12)
      // The word rises 2 units into place while it appears, then stands whole until the break-in.
      assertEquals(q.y0 - 2, s.y, 1e-12)
      val whole = IntroModel.particle(q, 1.0)
      assertEquals(q.x0, whole.x, 1e-12); assertEquals(q.y0, whole.y, 1e-12); assertEquals(0.0, whole.angle, 1e-12)
      assertEquals(scene.cell * 0.8, whole.size, 1e-12)
    }
  }

  private fun scatter(letter: Int, t: Double): Double {
    val group = scene.particles.filter { it.letter == letter }
    return group.sumOf { q -> val s = IntroModel.particle(q, t); hypot(s.x - q.x0, s.y - q.y0) } / group.size
  }

  @Test fun theFarLetterBreaksMoreThanTheNearOne() {
    for (t in doubleArrayOf(2.6, 3.5, 4.6)) assertTrue("t=$t", scatter(4, t) > 3 * scatter(2, t)) // Z, V
    // The wave starts at the far end: at 1.6 s Z has begun, V not yet.
    assertTrue(scatter(4, 1.6) > 0.0)
    assertEquals(0.0, scatter(2, 1.6), 1e-12)
  }

  @Test fun theCameraComesCloserAndTurns() {
    val a = IntroModel.camera(0.0); val b = IntroModel.camera(4.6)
    assertEquals(0.0, a.yaw, 1e-12); assertEquals(-0.3, b.yaw, 1e-3)
    assertTrue(b.z < a.z)
    // A shake only during the break-in.
    assertEquals(0.0, IntroModel.shake(1.0), 0.0); assertEquals(0.0, IntroModel.shake(2.7), 0.0)
    // The word fits across the preview's phone at the start.
    val p = IntroModel.Projector(a, 390.0, 845.0); val out = DoubleArray(3)
    p.project(-scene.leftSpan, 5.0, 0.0, out); assertTrue(out[0] > 0)
    p.project(scene.span, 5.0, 0.0, out); assertTrue(out[0] < 390)
  }

  @Test fun theFieldWaitsForTheBreakIn() {
    assertEquals(0.0, IntroModel.fieldGlow(0.0, 2.5), 0.0)
    assertTrue(IntroModel.fieldWave(3.0) > 0)
    // The ring is brightest where the wave is.
    val r = IntroModel.fieldWave(3.0)
    assertTrue(IntroModel.fieldGlow(r, 3.0) > IntroModel.fieldGlow(r + 15, 3.0))
    assertTrue(IntroModel.flare(2.75) > IntroModel.flare(2.0))
  }

  @Test fun theHapticsAreOneSoftSwell() {
    // 0 before 1.1 s and after 4.1 s; rises monotonically to its top 0.72 at 2.68 s, falls monotonically after; ≤ 1.
    var top = 0.0; var topAt = 0.0
    var previous = 0.0
    var t = 0.0
    while (t <= IntroModel.DURATION) {
      val v = IntroModel.haptic(t)
      if (t <= 1.1 || t >= 4.1) assertEquals(0.0, v, 0.0)
      assertTrue(v in 0.0..1.0)
      if (t > 1.1 && t < 2.68) assertTrue(v >= previous)
      if (t > 2.68 && t < 4.1) assertTrue(v <= previous)
      if (v > top) { top = v; topAt = t }
      previous = v
      t += 0.001
    }
    assertEquals(0.72, IntroModel.haptic(2.68), 1e-12)
    assertEquals(0.72, top, 1e-3)
    assertEquals(2.68, topAt, 0.002)
    // Barely felt at first, grows slowly; one continuous swell (never back to 0 in between).
    assertTrue(IntroModel.haptic(1.3) < 0.02)
    var k = 1.11
    while (k < 4.09) { assertTrue(IntroModel.haptic(k) > 0); k += 0.01 }
    // Nothing remains of the taps.
    val names = IntroModel::class.java.declaredFields.map { it.name.lowercase() } + IntroModel::class.java.declaredMethods.map { it.name.lowercase() }
    assertTrue(names.none { it.contains("tap") || it.contains("thud") })
    assertTrue(IntroModel::class.java.declaredClasses.none { it.simpleName == "Tap" })
  }

  @Test fun theHapticsPlanNeverBuzzes() {
    // Without amplitude control: no haptics at all.
    assertNull(IntroHaptics.plan(amplitude = false))
    // With it: one waveform of 20 ms steps over the 3 s of the swell, soft (≤ 110 of 255), following the curve.
    val wave = IntroHaptics.plan(amplitude = true)!!
    assertEquals(150, wave.timings.size); assertEquals(wave.timings.size, wave.amplitudes.size)
    assertTrue(wave.timings.all { it == IntroHaptics.STEP_MS })
    assertTrue(wave.amplitudes.all { it in 0..110 })
    assertTrue(wave.amplitudes.max() >= 105)
    val peak = wave.amplitudes.indexOf(wave.amplitudes.max())
    assertEquals(2.68, 1.1 + (peak + 0.5) * 0.02, 0.03)
    for (i in 1..peak) assertTrue(wave.amplitudes[i] >= wave.amplitudes[i - 1])
    for (i in peak + 1 until wave.amplitudes.size) assertTrue(wave.amplitudes[i] <= wave.amplitudes[i - 1])
    for ((i, a) in wave.amplitudes.withIndex()) assertEquals(Math.round(IntroModel.haptic(1.1 + (i + 0.5) * 0.02) * 255 * 0.6).toInt().coerceAtMost(110), a)
    assertEquals(0, IntroHaptics.strength(1.0)); assertEquals(0, IntroHaptics.strength(4.2))
    // Nothing remains of the taps.
    assertTrue(IntroHaptics::class.java.declaredClasses.none { it.simpleName == "Way" || it.simpleName == "Plan" })
  }

  @Test fun itPlaysOncePerInstallWithoutASessionAndWithMotion() {
    assertTrue(IntroModel.shouldPlay(seen = false, hasSession = false, motionAllowed = true))
    assertFalse(IntroModel.shouldPlay(seen = true, hasSession = false, motionAllowed = true)) // signed out of a seen install
    assertFalse(IntroModel.shouldPlay(seen = false, hasSession = true, motionAllowed = true))
    assertFalse(IntroModel.shouldPlay(seen = false, hasSession = false, motionAllowed = false))
    // Reduce Motion: the system's animator scale 0 (or «Анимации» off) — the sign-in screen directly.
    assertFalse(IntroModel.shouldPlay(false, false, Motion.motionAllowed("auto", Motion.Power(reduceMotion = true), 0.25)))
    assertFalse(IntroModel.shouldPlay(false, false, Motion.motionAllowed("off", Motion.Power(), 0.25)))
    // The seen flag in the app's preferences.
    val app = RuntimeEnvironment.getApplication()
    app.getSharedPreferences("linea.intro", 0).edit().clear().commit()
    assertFalse(IntroOverlay.seen(app))
    IntroOverlay.markSeen(app)
    assertTrue(IntroOverlay.seen(app))
    assertFalse(IntroOverlay.wanted(app, hasSession = false))
    assertEquals(1.0, IntroModel.overlayAlpha(4.0), 0.0)
    assertEquals(0.0, IntroModel.overlayAlpha(IntroModel.DURATION + IntroModel.FADE), 1e-9)
  }

  @Test fun picturesOfFourMoments() {
    val app = RuntimeEnvironment.getApplication()
    val w = 1080; val h = 2340
    val folder = File("build/pages").apply { mkdirs() }
    for (t in doubleArrayOf(0.9, 1.8, 2.9, 4.6)) {
      val view = IntroView(app)
      view.layout(0, 0, w, h)
      view.hold(t)
      val picture = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
      view.draw(Canvas(picture))
      File(folder, "intro-$t.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
      // The background is the graphite before the field comes up; the word is lit in the middle band.
      if (t < IntroModel.FIELD_START) assertEquals(IntroView.BACKGROUND, picture.getPixel(8, 8))
      var bright = 0
      for (y in h / 3 until 2 * h / 3 step 4) for (x in 0 until w step 4) { val c = picture.getPixel(x, y); if (Color.red(c) > 120) bright++ }
      assertTrue("t=$t", bright > 50)
    }
  }
}
