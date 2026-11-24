package com.linea.messenger

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.view.accessibility.AccessibilityManager
import com.linea.messenger.intro.IntroArt
import com.linea.messenger.intro.IntroFlow
import com.linea.messenger.intro.IntroGeometry
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
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.tan

/** The first-launch intro (intro/): the ident's times, the four steps the person makes (each completes by itself,
 *  none goes back, no skip), the hint's rules, the haptics, when and how the intro is shown (reduced motion, a screen
 *  reader, the seen flag), the scene's numbers, and pictures of the still stages in build/pages/. The drawing of the
 *  scene itself needs a graphics chip and is not tested here. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class IntroTest {
  private val frame = 1.0 / 60

  /** Lets `seconds` pass frame by frame; returns everything that happened. */
  private fun run(flow: IntroFlow, seconds: Double): Int {
    var events = 0
    var left = seconds
    while (left > 1e-9) { events = events or flow.tick(minOf(frame, left)); left -= frame }
    return events
  }

  private fun afterIdent(): IntroFlow = IntroFlow().also { run(it, IntroModel.IDENT_END + 0.05) }

  private fun swipe(flow: IntroFlow, up: Double = 0.08) { flow.touchDown(); flow.drag(up); flow.touchUp() }

  // ---- The ident ----

  @Test fun theIdentsTimesAreInOrder() {
    // The streak crosses, the word stands whole for about a second, then crumbles; N is at the centre before the end.
    assertEquals(0.0, IntroModel.reveal(IntroModel.REVEAL_START), 0.0)
    assertEquals(1.0, IntroModel.reveal(IntroModel.REVEAL_START + IntroModel.REVEAL_LENGTH), 1e-12)
    assertTrue(IntroModel.CRUMBLE_START - IntroModel.REVEAL_END in 0.85..1.2)
    assertEquals(0.0, IntroModel.sweep(IntroModel.REVEAL_END + 0.01), 0.0)
    assertTrue(IntroModel.sweep(0.7) > 0.4)
    assertEquals(0.0, IntroModel.rightFront(IntroModel.CRUMBLE_START), 0.0)
    assertEquals(0.0, IntroModel.leftFront(IntroModel.CRUMBLE_START + 0.2), 0.0)
    val frontsDone = maxOf(IntroModel.CRUMBLE_START + IntroModel.RIGHT_LENGTH, IntroModel.LEFT_START + IntroModel.LEFT_LENGTH)
    assertTrue(frontsDone < IntroModel.CENTRED)
    // The left front ends before the right one (the picture's cut relies on it).
    assertTrue(IntroModel.LEFT_START + IntroModel.LEFT_LENGTH <= IntroModel.CRUMBLE_START + IntroModel.RIGHT_LENGTH)
    assertEquals(0.0, IntroModel.centring(IntroModel.CENTRE_START), 0.0)
    assertEquals(1.0, IntroModel.centring(IntroModel.CENTRED), 1e-12)
    assertEquals(1.0, IntroModel.grain(IntroModel.GRAIN_START + IntroModel.GRAIN_LENGTH), 1e-12)
    assertTrue(IntroModel.CENTRED <= IntroModel.IDENT_END)
    assertEquals(4.9, IntroModel.IDENT_END, 1e-12)
  }

  @Test fun theIdentRunsByTimeAndCannotBeSkipped() {
    val flow = IntroFlow()
    assertFalse(flow.hintVisible)
    // Swipes and taps during the ident change nothing.
    run(flow, 1.0)
    swipe(flow, 0.5); flow.touchDown(); flow.touchUp(fling = true)
    assertEquals(1.0, flow.t, 1e-6); assertEquals(0.0, flow.p, 0.0); assertEquals(0, flow.done)
    // The swell starts exactly when the letters begin to crumble, once.
    assertEquals(0, run(flow, IntroModel.CRUMBLE_START - 1.0 - 0.02))
    assertEquals(IntroFlow.SWELL, run(flow, 0.04))
    assertEquals(0, run(flow, 2.0))
    assertFalse(flow.identOver); assertFalse(flow.hintVisible)
    run(flow, 1.0)
    assertTrue(flow.identOver)
    assertEquals(IntroModel.IDENT_END, flow.t, 0.0)
    // More time changes nothing: from here the person leads.
    run(flow, 30.0)
    assertEquals(0.0, flow.p, 0.0); assertEquals(0, flow.done); assertFalse(flow.finished)
  }

  // ---- The steps ----

  @Test fun aSwipeUpStartsAStepAndItCompletesByItself() {
    val flow = afterIdent()
    swipe(flow)
    assertTrue(flow.stepRunning)
    var previous = flow.p
    var time = 0.0
    while (flow.stepRunning && time < 5) { flow.tick(frame); time += frame; assertTrue(flow.p >= previous); previous = flow.p }
    assertEquals(1.0, flow.p, 0.0); assertEquals(1, flow.done)
    assertTrue("took $time", time in 1.0..IntroModel.STEP_SECONDS + 0.05)
    assertEquals(0.0, flow.speed, 0.0)
    // A fling of no length does the same.
    flow.touchDown(); flow.touchUp(fling = true)
    assertTrue(flow.stepRunning)
    run(flow, IntroModel.STEP_SECONDS + 0.1)
    assertEquals(2, flow.done)
  }

  @Test fun aTapOrAMoveDownStartsNothing() {
    val flow = afterIdent()
    flow.touchDown(); flow.touchUp()
    assertFalse(flow.stepRunning)
    flow.touchDown(); flow.drag(-0.4); flow.touchUp()
    assertFalse(flow.stepRunning)
    run(flow, 2.0)
    assertEquals(0.0, flow.p, 0.0); assertEquals(0, flow.done)
  }

  @Test fun theFingerLeadsTheStepAndLettingGoCompletesIt() {
    val flow = afterIdent()
    flow.touchDown()
    flow.drag(0.3); assertEquals(0.3, flow.p, 1e-12)
    flow.drag(0.6); assertEquals(0.6, flow.p, 1e-12)
    flow.drag(0.2); assertEquals(0.2, flow.p, 1e-12) // back within the step
    flow.drag(5.0); assertEquals(1.0, flow.p, 1e-12) // never beyond it
    flow.drag(0.5)
    run(flow, 3.0)
    assertEquals(0.5, flow.p, 1e-12) // it waits under the finger
    assertFalse(flow.hintVisible)
    flow.touchUp()
    // Forward, although the finger was coming back: it moved up at all.
    run(flow, IntroModel.STEP_SECONDS)
    assertEquals(1.0, flow.p, 0.0); assertEquals(1, flow.done)
    // Up and all the way back down before letting go: still forward.
    flow.touchDown(); flow.drag(0.4); flow.drag(-0.1); flow.touchUp()
    run(flow, IntroModel.STEP_SECONDS + 0.1)
    assertEquals(2, flow.done)
  }

  @Test fun aCompletedStepNeverGoesBack() {
    val flow = afterIdent()
    swipe(flow); run(flow, 1.5)
    assertEquals(1, flow.done)
    flow.touchDown(); flow.drag(-0.9)
    assertEquals(1.0, flow.p, 0.0)
    flow.touchUp(); run(flow, 2.0)
    assertEquals(1.0, flow.p, 0.0); assertEquals(1, flow.done)
    // While a step runs the finger does not pull it anywhere.
    swipe(flow); run(flow, 0.4)
    val mid = flow.p
    flow.touchDown(); flow.drag(-0.5)
    assertEquals(mid, flow.p, 0.0)
    flow.touchUp(); run(flow, 2.0)
    assertEquals(2.0, flow.p, 0.0)
  }

  @Test fun fourStepsFinishTheIntroAndThereIsNoShortcut() {
    val flow = afterIdent()
    var events = 0
    for (step in 1..4) {
      assertFalse(flow.finished)
      swipe(flow)
      events = events or run(flow, IntroModel.STEP_SECONDS + 0.1)
      assertEquals(step, flow.done)
    }
    assertTrue(flow.finished)
    assertTrue(events and IntroFlow.FINISHED != 0)
    assertEquals(4.0, flow.p, 0.0)
    // Nothing after the end.
    swipe(flow, 0.9)
    assertEquals(0, run(flow, 3.0))
    assertEquals(4.0, flow.p, 0.0); assertFalse(flow.hintVisible)
    // One very long swipe is still one step.
    val other = afterIdent()
    swipe(other, 50.0); run(other, 3.0)
    assertEquals(1, other.done)
    // A swipe made while a step runs lets the next follow at once — one, however many swipes.
    val quick = afterIdent()
    swipe(quick); run(quick, 0.3); swipe(quick); swipe(quick); swipe(quick)
    run(quick, 2 * IntroModel.STEP_SECONDS + 0.2)
    assertEquals(2, quick.done)
    run(quick, 3.0)
    assertEquals(2, quick.done)
  }

  @Test fun theHoneycombLayerIsPassedOnceInTheFirstStep() {
    val flow = afterIdent()
    assertTrue(flow.passAt in 0.4..0.7)
    // At that progress the camera is at the layer.
    assertEquals(IntroModel.SHIELD_Z, IntroModel.cameraZ(flow.passAt, IntroModel.N_DISTANCE), 1e-9)
    swipe(flow)
    assertEquals(IntroFlow.PASS, run(flow, 1.5))
    for (step in 2..4) { swipe(flow); assertEquals(0, run(flow, 1.5) and IntroFlow.PASS) }
    // Led by the finger back and forth: still once.
    val led = afterIdent()
    led.touchDown(); led.drag(0.9); led.drag(0.1); led.drag(0.9); led.touchUp()
    assertEquals(IntroFlow.PASS, run(led, 1.5) and IntroFlow.PASS)
    assertEquals(0, run(led, 1.0))
    // The layer shines as the camera comes and is gone after N is reached.
    assertTrue(IntroModel.shield(flow.passAt, IntroModel.SHIELD_Z) > 0.3)
    assertEquals(0.0, IntroModel.shield(0.0, 74.0), 0.0); assertEquals(0.0, IntroModel.shield(1.3, 0.0), 0.0)
    assertTrue(IntroModel.flash(0.5, IntroModel.SHIELD_Z) > IntroModel.flash(0.5, IntroModel.SHIELD_Z + 8))
  }

  // ---- The hint ----

  @Test fun theHintComesAtOnceThenOnlyAfterFiveQuietSeconds() {
    val flow = IntroFlow()
    run(flow, IntroModel.IDENT_END - 0.05)
    assertFalse(flow.hintVisible)
    run(flow, 0.1)
    assertTrue(flow.hintVisible) // at once when the ident ends
    // Hidden while a finger is down; back at once before the first step.
    flow.touchDown(); assertFalse(flow.hintVisible)
    flow.touchUp(); assertTrue(flow.hintVisible)
    // Hidden during a step and after it…
    swipe(flow)
    assertFalse(flow.hintVisible)
    run(flow, IntroModel.STEP_SECONDS + 0.1)
    assertEquals(1, flow.done); assertFalse(flow.hintVisible)
    // …until five seconds have passed without a touch.
    run(flow, 4.6); assertFalse(flow.hintVisible)
    run(flow, 0.3); assertTrue(flow.hintVisible)
    // A touch hides it and the five seconds start again when the finger leaves.
    flow.touchDown(); assertFalse(flow.hintVisible)
    run(flow, 6.0); assertFalse(flow.hintVisible) // the finger is still down
    flow.touchUp()
    run(flow, 4.9); assertFalse(flow.hintVisible)
    run(flow, 0.2); assertTrue(flow.hintVisible)
    // After the last step it never comes.
    for (step in 2..4) { swipe(flow); run(flow, 1.5) }
    run(flow, 10.0)
    assertTrue(flow.finished); assertFalse(flow.hintVisible)
  }

  // ---- Reduced motion, a screen reader, the seen flag ----

  @Test fun reducedMotionShowsStillStages() {
    val flow = IntroFlow(stills = true)
    // No ident: the word stands, the hint is there at once.
    assertTrue(flow.identOver); assertTrue(flow.hintVisible)
    assertEquals(0, run(flow, 6.0)) // no swell
    // The finger does not lead a still; a swipe cross-fades to the next, calmly.
    flow.touchDown(); flow.drag(0.5)
    assertEquals(0.0, flow.p, 0.0)
    flow.touchUp()
    assertTrue(flow.stepRunning); assertFalse(flow.hintVisible)
    run(flow, IntroModel.STILL_SECONDS + 0.05)
    assertEquals(1, flow.done)
    run(flow, 4.5); assertFalse(flow.hintVisible)
    run(flow, 0.6); assertTrue(flow.hintVisible) // the same rule of five seconds
    var events = 0
    for (step in 2..4) { swipe(flow); events = events or run(flow, 1.0) }
    assertEquals(IntroFlow.FINISHED, events) // no tick of the honeycomb, only the end
    assertTrue(flow.finished)
    // A scene that could not be drawn turns into the stills where it is.
    val broken = IntroFlow()
    run(broken, 2.0)
    broken.toStills()
    assertTrue(broken.stills); assertTrue(broken.identOver); assertTrue(broken.hintVisible)
  }

  @Test fun whenAndHowItIsShown() {
    val full = IntroModel.Mode.FULL; val stills = IntroModel.Mode.STILLS; val none = IntroModel.Mode.NONE
    assertEquals(full, IntroModel.mode(seen = false, hasSession = false, motionAllowed = true, screenReader = false, canDrawScene = true))
    assertEquals(none, IntroModel.mode(seen = true, hasSession = false, motionAllowed = true, screenReader = false, canDrawScene = true))
    assertEquals(none, IntroModel.mode(seen = false, hasSession = true, motionAllowed = true, screenReader = false, canDrawScene = true))
    // Reduced motion (the system's animator scale 0, or «Анимации» off): the still stages, not nothing.
    assertEquals(stills, IntroModel.mode(false, false, com.linea.messenger.effects.Motion.motionAllowed("auto", com.linea.messenger.effects.Motion.Power(reduceMotion = true), 0.25), false, true))
    assertEquals(stills, IntroModel.mode(false, false, com.linea.messenger.effects.Motion.motionAllowed("off", com.linea.messenger.effects.Motion.Power(), 0.25), false, true))
    // No OpenGL ES 3: the still stages.
    assertEquals(stills, IntroModel.mode(false, false, motionAllowed = true, screenReader = false, canDrawScene = false))
    // A screen reader: no intro at all, and it counts as seen.
    assertEquals(none, IntroModel.mode(false, false, motionAllowed = true, screenReader = true, canDrawScene = true))
    assertEquals(none, IntroModel.mode(false, false, motionAllowed = false, screenReader = true, canDrawScene = true))
    assertTrue(IntroModel.seenWithoutShowing(seen = false, hasSession = false, screenReader = true))
    assertFalse(IntroModel.seenWithoutShowing(seen = false, hasSession = false, screenReader = false))
    assertFalse(IntroModel.seenWithoutShowing(seen = false, hasSession = true, screenReader = true))
    // The particles by the phone.
    assertEquals(60_000, IntroModel.particleCount(512, lowMemory = true))
    assertEquals(60_000, IntroModel.particleCount(128, lowMemory = false))
    assertEquals(100_000, IntroModel.particleCount(256, lowMemory = false))
    assertEquals(150_000, IntroModel.particleCount(512, lowMemory = false))
    assertEquals(1.0, IntroModel.countGain(150_000), 1e-12)
    assertTrue(IntroModel.countGain(60_000) > 1.3)
  }

  @Test fun theSeenFlagAndTheScreenReader() {
    val app = RuntimeEnvironment.getApplication()
    app.getSharedPreferences("linea.intro", 0).edit().clear().commit()
    assertFalse(IntroOverlay.seen(app))
    // An ordinary first start: the intro is shown, and it is not yet seen (only going through it marks it).
    assertFalse(IntroOverlay.screenReader(app))
    assertTrue(IntroOverlay.mode(app, hasSession = false) != IntroModel.Mode.NONE)
    assertFalse(IntroOverlay.seen(app))
    // With a session nothing is shown and nothing is marked.
    assertEquals(IntroModel.Mode.NONE, IntroOverlay.mode(app, hasSession = true))
    assertFalse(IntroOverlay.seen(app))
    // A screen reader on: straight to the sign-in screen, marked seen — and never shown later either.
    val manager = app.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
    Shadows.shadowOf(manager).setEnabled(true)
    Shadows.shadowOf(manager).setTouchExplorationEnabled(true)
    assertTrue(IntroOverlay.screenReader(app))
    assertEquals(IntroModel.Mode.NONE, IntroOverlay.mode(app, hasSession = false))
    assertTrue(IntroOverlay.seen(app))
    Shadows.shadowOf(manager).setTouchExplorationEnabled(false)
    Shadows.shadowOf(manager).setEnabled(false)
    assertEquals(IntroModel.Mode.NONE, IntroOverlay.mode(app, hasSession = false))
    // The flag itself.
    app.getSharedPreferences("linea.intro", 0).edit().clear().commit()
    IntroOverlay.markSeen(app)
    assertTrue(IntroOverlay.seen(app))
    assertEquals(IntroModel.Mode.NONE, IntroOverlay.mode(app, hasSession = false))
    app.getSharedPreferences("linea.intro", 0).edit().clear().commit()
  }

  // ---- The camera and the screen's shape ----

  /** The share of the screen's width the word takes when the camera stands `distance` away. */
  private fun share(total: Double, distance: Double, aspect: Double): Double =
    total / (2 * distance * tan(IntroModel.FOV / 2 * PI / 180) * aspect)

  @Test fun theWordTakesTheWidthLessTheMarginsOnAnyScreen() {
    val left = -11.9; val right = 39.0; val total = right - left
    val camera = IntroModel.Camera()
    for (aspect in doubleArrayOf(9 / 21.0, 9 / 19.5, 9 / 16.0, 3 / 4.0, 1.0, 4 / 3.0, 19.5 / 9)) {
      IntroModel.camera(0.0, 0.0, 0.0, 0.0, left, right, aspect, camera)
      // At the start the camera looks at the word's middle from the word's distance: 8 % free on each side.
      assertEquals((left + right) / 2, camera.x, 1e-9); assertEquals(camera.x, camera.lookX, 0.0)
      assertEquals(1 - 2 * IntroModel.MARGIN, share(total, camera.z, aspect), 1e-9)
      // The word's height (with its mirror image) fits too.
      assertTrue(16.0 <= 2 * camera.z * tan(IntroModel.FOV / 2 * PI / 180) + 1e-9)
      // At the ident's end N is at the centre, nearer than the word was and not wider than 0.7 of the screen.
      IntroModel.camera(IntroModel.IDENT_END, 0.0, 9.0, 0.0, left, right, aspect, camera)
      assertEquals(0.0, camera.x, 1e-9); assertEquals(0.0, camera.lookX, 1e-9); assertEquals(IntroModel.N_Y, camera.lookY, 1e-9)
      val near = IntroModel.nDistance(total, aspect)
      assertEquals(near, camera.z, 1e-9)
      assertTrue(near <= IntroModel.N_DISTANCE + 1e-9)
      assertTrue(near < IntroModel.wordDistance(total, aspect))
      assertTrue(share(10.7, near, aspect) <= 0.7 + 1e-9)
      // The first step starts from exactly there: no jump when the person takes over.
      val before = doubleArrayOf(camera.x, camera.y, camera.z, camera.lookX, camera.lookY, camera.lookZ, camera.roll, camera.fov)
      IntroModel.camera(IntroModel.IDENT_END, 1e-6, 9.0, 0.0, left, right, aspect, camera)
      val after = doubleArrayOf(camera.x, camera.y, camera.z, camera.lookX, camera.lookY, camera.lookZ, camera.roll, camera.fov)
      for (k in before.indices) assertEquals("aspect $aspect, value $k", before[k], after[k], 1e-3)
      // The camera passes the honeycomb layer somewhere inside the first step.
      val pass = IntroModel.shieldPass(near)
      assertTrue(pass in 0.05..0.95)
      assertEquals(IntroModel.N_NEAR, IntroModel.cameraZ(1.0, near), 1e-9)
    }
    // On the film's own phone N stands where the film has it.
    assertEquals(IntroModel.N_DISTANCE, IntroModel.nDistance(total, 450 / 975.0), 1e-9)
    // The flight goes on into N and through the layers of the cipher, never back.
    var previous = Double.MAX_VALUE
    var p = 0.0
    while (p <= 4.0) { val z = IntroModel.cameraZ(p, 74.0); assertTrue(z <= previous + 1e-9); previous = z; p += 0.01 }
    assertTrue(IntroModel.cameraZ(4.0, 74.0) < IntroGeometry.LAYERS.min())
    // The speed of a step widens the view, a still camera does not.
    IntroModel.camera(4.9, 0.5, 0.0, 1.44, left, right, 0.46, camera)
    assertEquals(IntroModel.FOV + IntroModel.FOV_RUSH, camera.fov, 1e-9)
  }

  @Test fun theHandOverFromNToTheCipherIsNeverDark() {
    // N's particles start to spread before the camera reaches N, and the light never drops by much on the way.
    assertEquals(0.0, IntroModel.spread(0.8), 0.0)
    assertTrue(IntroModel.spread(1.0) > 0.25)
    assertEquals(1.0, IntroModel.spread(1.5), 1e-12)
    var p = 0.0
    while (p <= 3.0) { assertTrue("p=$p", IntroModel.gain(IntroModel.IDENT_END, p) >= 0.42); p += 0.01 }
    assertEquals(IntroModel.gain(IntroModel.IDENT_END, 0.0), IntroModel.gain(IntroModel.IDENT_END, 1e-6), 1e-4)
    // The end: everything melts and goes soft and dim exactly at the fourth step's end.
    assertEquals(0.0, IntroModel.blur(3.0), 0.0); assertEquals(1.0, IntroModel.blur(4.0), 1e-12)
    assertEquals(0.0, IntroModel.melt(3.2), 0.0); assertEquals(1.0, IntroModel.melt(4.0), 1e-12)
  }

  @Test fun rotationKeepsTheProgress() {
    val app = RuntimeEnvironment.getApplication()
    val flow = IntroFlow(stills = true)
    swipe(flow); run(flow, 1.0)
    swipe(flow); run(flow, 0.3)
    val p = flow.p; val done = flow.done
    assertEquals(1, done); assertTrue(p > 1.0 && p < 2.0)
    // The same window turned: the view is laid out anew, the way through the intro is where it was.
    val view = IntroView(app, flow)
    view.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2340, View.MeasureSpec.EXACTLY))
    view.layout(0, 0, 1080, 2340)
    view.measure(View.MeasureSpec.makeMeasureSpec(2340, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY))
    view.layout(0, 0, 2340, 1080)
    assertEquals(p, flow.p, 0.0); assertEquals(done, flow.done)
    view.release()
    // A new window (the activity was made anew) goes on with the same way.
    val again = IntroView(app, flow)
    again.layout(0, 0, 2340, 1080)
    assertEquals(p, flow.p, 0.0); assertEquals(done, flow.done)
    run(flow, 1.0)
    assertEquals(2, flow.done)
    again.release()
    // The scene's flow on another shape of screen: only where the layer is passed moves, not the progress.
    val scene = afterIdent()
    swipe(scene); run(scene, 0.2)
    val mid = scene.p
    scene.passAt = IntroModel.shieldPass(IntroModel.nDistance(50.9, 2340 / 1080.0))
    assertEquals(mid, scene.p, 0.0)
    assertTrue(run(scene, 1.5) and IntroFlow.PASS != 0)
    assertEquals(1, scene.done)
  }

  // ---- The haptics ----

  @Test fun theHapticsAreOneSoftSwellFromTheCrumbleToTheCentre() {
    assertEquals(IntroModel.CRUMBLE_START, IntroModel.SWELL_START, 0.0)
    assertEquals(IntroModel.CENTRED, IntroModel.SWELL_END, 0.0)
    var top = 0.0; var topAt = 0.0; var previous = 0.0
    var t = 0.0
    while (t <= IntroModel.IDENT_END) {
      val v = IntroModel.haptic(t)
      if (t <= IntroModel.SWELL_START || t >= IntroModel.SWELL_END) assertEquals(0.0, v, 0.0)
      assertTrue(v in 0.0..1.0)
      if (t > IntroModel.SWELL_START && t < IntroModel.SWELL_PEAK) assertTrue(v >= previous)
      if (t > IntroModel.SWELL_PEAK && t < IntroModel.SWELL_END) assertTrue(v <= previous)
      if (v > top) { top = v; topAt = t }
      previous = v
      t += 0.001
    }
    assertEquals(IntroModel.SWELL_TOP, top, 1e-3)
    assertEquals(IntroModel.SWELL_PEAK, topAt, 0.002)
    // Barely felt at first; one continuous swell (never back to 0 in between).
    assertTrue(IntroModel.haptic(IntroModel.SWELL_START + 0.2) < 0.02)
    var k = IntroModel.SWELL_START + 0.01
    while (k < IntroModel.SWELL_END - 0.01) { assertTrue(IntroModel.haptic(k) > 0); k += 0.01 }
  }

  @Test fun theHapticsPlanNeverBuzzes() {
    // Without amplitude control: no swell at all.
    assertNull(IntroHaptics.plan(amplitude = false))
    // With it: one waveform of 20 ms steps over the swell, soft (≤ 110 of 255), following the curve.
    val wave = IntroHaptics.plan(amplitude = true)!!
    assertEquals(Math.round((IntroModel.SWELL_END - IntroModel.SWELL_START) * 1000 / 20).toInt(), wave.timings.size)
    assertEquals(wave.timings.size, wave.amplitudes.size)
    assertTrue(wave.timings.all { it == IntroHaptics.STEP_MS })
    assertTrue(wave.amplitudes.all { it in 0..110 })
    assertTrue(wave.amplitudes.max() >= 105)
    val peak = wave.amplitudes.indexOf(wave.amplitudes.max())
    assertEquals(IntroModel.SWELL_PEAK, IntroModel.SWELL_START + (peak + 0.5) * 0.02, 0.03)
    for (i in 1..peak) assertTrue(wave.amplitudes[i] >= wave.amplitudes[i - 1])
    for (i in peak + 1 until wave.amplitudes.size) assertTrue(wave.amplitudes[i] <= wave.amplitudes[i - 1])
    assertEquals(0, IntroHaptics.strength(IntroModel.SWELL_START - 0.1)); assertEquals(0, IntroHaptics.strength(IntroModel.SWELL_END + 0.1))
    // The tick is short and soft.
    assertTrue(IntroHaptics.TICK_MS <= 15); assertTrue(IntroHaptics.TICK_STRENGTH <= 80)
  }

  // ---- The scene's numbers ----

  @Test fun theSceneIsBuiltFromTheWordsPicture() {
    val app = RuntimeEnvironment.getApplication()
    val art = IntroArt.make(app)
    // Five letters left to right with gaps, each with something drawn in it; the picture fits any phone's textures.
    assertTrue(art.width <= 2048); assertEquals(IntroArt.HEIGHT, art.height)
    for (i in 1 until 5) assertTrue(art.spans[i][0] > art.spans[i - 1][0] + art.spans[i - 1][1])
    for (i in 0 until 5) {
      var covered = 0
      for (y in 60 until 360 step 4) { var x = art.spans[i][0]; while (x < art.spans[i][0] + art.spans[i][1]) { if (art.covered(x.toDouble(), y.toDouble())) covered++; x += 4 } }
      assertTrue("letter $i", covered > 100)
    }
    // N is the launcher icon's sign: as wide for its height as the artwork.
    assertEquals(237.0 / 221, art.spans[1][1] / IntroArt.CAP.toDouble(), 0.04)
    assertEquals(16, art.glyphs.size)
    assertTrue(art.glyphs.all { it.size >= 40 })
    assertTrue(art.digits.count { (it.toInt() and 0xFF) > 127 } > 200)

    val count = 4000
    val scene = IntroGeometry.build(art, count)
    assertEquals(count, scene.count); assertEquals(count / 4, scene.ownCount)
    assertEquals(count * IntroGeometry.PARTICLE, scene.particles.size)
    assertTrue(scene.left < scene.signLeft && scene.signLeft < 0 && 0 < scene.signRight && scene.signRight < scene.right)
    assertEquals(0.0, (scene.signLeft + scene.signRight) / 2.0, 0.2) // N's middle is the scene's origin
    for (i in 0 until count) {
      val o = i * IntroGeometry.PARTICLE
      // Every particle has a place in N (10 high) and a place on one of the cipher's layers behind it.
      assertTrue(abs(scene.particles[o]) <= art.spans[1][1] / 2 * IntroArt.UNIT + 1e-3)
      assertTrue(scene.particles[o + 1] in -0.01f..10.01f)
      assertTrue(abs(scene.particles[o + 2]) <= 0.96f)
      val z = scene.particles[o + 5]
      assertTrue(IntroGeometry.LAYERS.any { abs(z - it) < 1.0 })
      assertEquals(if (i < count / 4) 1f else 0f, scene.particles[o + 9], 0f)
      assertTrue(scene.particles[o + 10] in 0.29f..1f); assertTrue(scene.particles[o + 11] in 0.4f..1f)
    }
    // N is a honeycomb: most of its particles lie on the cells' lines.
    val onLines = (0 until count).count { IntroGeometry.onLine(scene.particles[it * IntroGeometry.PARTICLE].toDouble(), scene.particles[it * IntroGeometry.PARTICLE + 1].toDouble(), IntroGeometry.CELL_RADIUS) }
    assertTrue(onLines > count * 2 / 5)
    // The squares: of the other letters only, each leaving after the crumble began, away from N, before long.
    assertTrue(scene.tileCount > 150)
    assertEquals(scene.tileCount * 6 * IntroGeometry.TILE, scene.tiles.size)
    var latest = 0f
    for (k in 0 until scene.tileCount) {
      val o = k * 6 * IntroGeometry.TILE
      val cx = scene.tiles[o + 2]; val leaves = scene.tiles[o + 4]; val vx = scene.tiles[o + 5]
      assertTrue(cx < scene.signLeft || cx > scene.signRight)
      assertTrue(cx in scene.left..scene.right)
      assertTrue(leaves >= IntroModel.CRUMBLE_START.toFloat())
      assertTrue(if (cx > 0) vx > 0.9f else vx < -0.9f)
      latest = maxOf(latest, leaves)
    }
    // The last square has left (a second of flight) within what the scene gives it after the ident.
    assertTrue(latest + 1 <= IntroModel.IDENT_END + 2.0)
    // The fronts run from outside the word to N's sides.
    assertTrue(scene.rightFrom > scene.right && scene.rightTo > scene.signRight && scene.rightTo < scene.rightFrom)
    assertTrue(scene.leftFrom < scene.left && scene.leftTo < scene.signLeft && scene.leftTo > scene.leftFrom)
    // The same on every start.
    val again = IntroGeometry.build(art, count)
    assertTrue(scene.particles.contentEquals(again.particles)); assertTrue(scene.tiles.contentEquals(again.tiles))
  }

  @Test fun picturesOfTheStillStages() {
    val app = RuntimeEnvironment.getApplication()
    val w = 1080; val h = 2340
    val folder = File("build/pages").apply { mkdirs() }
    val lit = IntArray(5)
    for (stage in 0..4) {
      val flow = IntroFlow(stills = true).apply { freeze(IntroModel.IDENT_END, stage.toDouble()) }
      val view = IntroView(app, flow)
      view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
      view.layout(0, 0, w, h)
      // Two frames: the stage and the hint are told where the flow is.
      view.step(0.016); view.step(0.016)
      val picture = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
      view.draw(Canvas(picture))
      File(folder, "intro-still-$stage.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
      if (stage < 3) assertEquals(IntroModel.BACKGROUND, picture.getPixel(4, 4)) // the haze of the end covers the whole page
      for (y in h / 4 until 3 * h / 4 step 4) for (x in 0 until w step 4) if (Color.red(picture.getPixel(x, y)) > 150) lit[stage]++
      view.release()
    }
    // The word and N are lit in the middle; the cipher has its bright signs; the blur has nothing bright or sharp.
    assertTrue(lit[0] > 500); assertTrue(lit[1] > 500); assertTrue(lit[2] > 20)
    assertEquals(0, lit[3]); assertEquals(0, lit[4])
  }
}
