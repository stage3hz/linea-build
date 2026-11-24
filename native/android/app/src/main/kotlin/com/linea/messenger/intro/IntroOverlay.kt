package com.linea.messenger.intro

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Activity
import android.app.ActivityManager
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.Shader
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import com.linea.messenger.effects.Motion

/** The first-launch intro over the sign-in screen: once per install, at a start with no session, in a window of its
 *  own above the app's (the sign-in screen stays untouched under it). The person goes through its four steps by
 *  swiping up — there is no skip; when the fourth is complete the sign-in screen comes out of the blur the scene has
 *  melted into (it sharpens while the overlay fades, where the system can blur a view; a plain cross-fade elsewhere)
 *  and the overlay is gone. Only then is the intro marked seen.
 *  With a screen reader on there is no intro at all: straight to the sign-in screen, marked seen. With motion reduced
 *  (the system's animator scale 0 or the app's «Анимации», effects/Motion.kt), or where the phone cannot draw the
 *  scene, four calm still stages instead of the flights.
 *  While the app is away nothing moves and nothing is felt; it goes on from the same place when the app is back, and
 *  after a rotation or a new window too. */
object IntroOverlay {
  /** The one-time flag, in the app's own preferences file of such flags (as chatsplus/BarHint.kt keeps its own). */
  private const val PREFERENCES = "linea.intro"
  const val SEEN_KEY = "linea.intro.seen.v1"

  private var dialog: Dialog? = null
  private var view: IntroView? = null
  private var haptics: IntroHaptics? = null
  private var ending = false
  private var sharpening: ValueAnimator? = null
  private var blurred: View? = null
  /** The person's way through the intro, kept until it is finished: a new window goes on from the same place. */
  private var kept: IntroFlow? = null

  fun seen(context: Context): Boolean =
    try { context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(SEEN_KEY, false) } catch (_: Exception) { true }

  fun markSeen(context: Context) {
    try { context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean(SEEN_KEY, true).apply() } catch (_: Exception) {}
  }

  /** A screen reader that reads what is under the finger is on. */
  fun screenReader(context: Context): Boolean = try {
    val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
    manager != null && manager.isEnabled && manager.isTouchExplorationEnabled
  } catch (_: Exception) { false }

  /** The phone can draw the scene (OpenGL ES 3.0). */
  fun canDrawScene(context: Context): Boolean = try {
    val version = (context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.deviceConfigurationInfo?.reqGlEsVersion ?: 0
    if (version < 0x30000) android.util.Log.e("intro", "OpenGL ES 0x" + Integer.toHexString(version) + ": the still stages")
    version >= 0x30000
  } catch (_: Exception) { false }

  /** How the intro is shown at this start (IntroModel.mode with this phone's answers). A start with a screen reader
   *  on marks the intro seen without showing it. */
  fun mode(context: Context, hasSession: Boolean): IntroModel.Mode {
    Motion.start(context)
    val seen = seen(context)
    val reader = screenReader(context)
    if (IntroModel.seenWithoutShowing(seen, hasSession, reader)) markSeen(context)
    return IntroModel.mode(seen, hasSession, Motion.enabled, reader, canDrawScene(context))
  }

  /** Called by the start with no session (MainActivity.start), right after the sign-in screen is set. */
  fun firstStart(activity: Activity) {
    if (Build.FINGERPRINT == "robolectric") return // the JVM page tests: no frame clock, no second window
    val mode = mode(activity, hasSession = false)
    if (mode == IntroModel.Mode.NONE) { kept = null; return }
    val flow = kept ?: IntroFlow(stills = mode == IntroModel.Mode.STILLS)
    if (mode == IntroModel.Mode.STILLS) flow.toStills()
    kept = flow
    show(activity, flow, real = true)
  }

  /** The emulator check: the intro frozen at the ident's time `t` over the sign-in screen, no haptics, the seen flag
   *  untouched (`--es intro hold --es introat 2.9`). */
  fun hold(activity: Activity, t: Double) = show(activity, IntroFlow(stills = !canDrawScene(activity)).apply { freeze(t, 0.0) }, real = false)

  /** The same, frozen at a progress through the steps, 0…4 (`--es intro step --es introat 1.5`); `stills` — the still
   *  stages (`--es intro still --es introat 2`). */
  fun step(activity: Activity, p: Double, stills: Boolean = false) =
    show(activity, IntroFlow(stills = stills || !canDrawScene(activity)).apply { freeze(IntroModel.IDENT_END, p) }, real = false)

  private fun show(activity: Activity, flow: IntroFlow, real: Boolean) {
    close()
    if (activity.isFinishing || activity.isDestroyed) return
    val made = IntroView(activity, flow)
    val window = Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar)
    window.setContentView(made, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window.window?.let { w ->
      w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      w.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED)
      w.setWindowAnimations(0)
      @Suppress("DEPRECATION")
      run { w.statusBarColor = Color.TRANSPARENT; w.navigationBarColor = Color.TRANSPARENT }
      if (Build.VERSION.SDK_INT >= 30) {
        w.setDecorFitsSystemWindows(false)
        w.insetsController?.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
      }
      if (Build.VERSION.SDK_INT >= 28) w.attributes = w.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
    }
    // No skip: Back does not close the intro, it leaves the app as it would from the first screen.
    window.setCancelable(false)
    window.setOnKeyListener { _, code, event ->
      if (code == KeyEvent.KEYCODE_BACK) {
        if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) try { activity.moveTaskToBack(true) } catch (_: Exception) {}
        true
      } else false
    }
    dialog = window; view = made; ending = false
    if (real) {
      val touch = IntroHaptics(activity)
      haptics = touch
      made.onEvents = { events ->
        if (events and IntroFlow.SWELL != 0) touch.swell()
        if (events and IntroFlow.PASS != 0) touch.tick()
        if (events and IntroFlow.FINISHED != 0) finish(activity)
      }
    }
    window.show()
    made.step(0.0)
    made.play()
    // A kept way that was already complete (the window was lost during the hand-over): straight on.
    if (real && flow.finished) finish(activity)
  }

  /** The fourth step is complete: the intro is seen; the sign-in screen comes out of the blur and the overlay goes. */
  private fun finish(activity: Activity) {
    if (ending) return
    ending = true
    markSeen(activity)
    kept = null
    val made = view ?: return close()
    made.onEvents = null
    val length = (IntroModel.HANDOVER * 1000).toLong()
    val under = try { activity.findViewById<View>(android.R.id.content) } catch (_: Exception) { null }
    if (Build.VERSION.SDK_INT >= 31 && under != null) {
      val most = 22f * activity.resources.displayMetrics.density
      val animator = ValueAnimator.ofFloat(1f, 0f).setDuration(length)
      animator.addUpdateListener {
        val radius = most * (it.animatedValue as Float)
        try { under.setRenderEffect(if (radius > 0.5f) RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP) else null) } catch (_: Exception) {}
      }
      animator.addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) { sharp() }
      })
      blurred = under; sharpening = animator
      animator.start()
    }
    made.animate().alpha(0f).setDuration(length).withEndAction { close() }.start()
  }

  /** The sign-in screen is as it always is. */
  private fun sharp() {
    val under = blurred
    blurred = null; sharpening = null
    if (Build.VERSION.SDK_INT >= 31) try { under?.setRenderEffect(null) } catch (_: Exception) {}
  }

  /** Gone at once (the intro is over, or the activity ends): the haptics stop, the graphics are given back. An
   *  unfinished way through the intro is kept for the next window. */
  fun close() {
    haptics?.stop(); haptics = null
    sharpening?.let { it.removeAllListeners(); it.cancel() }
    sharp()
    view?.let { it.animate().cancel(); it.release() }
    view = null
    try { dialog?.dismiss() } catch (_: Exception) {}
    dialog = null
    ending = false
  }

  /** The app went to the background mid-intro: it waits (nothing moves, nothing is felt). */
  fun wentAway() {
    haptics?.stop()
    view?.pause()
  }

  /** The app is back: the intro goes on from where it was. */
  fun cameBack() {
    if (dialog != null) view?.play()
  }
}
