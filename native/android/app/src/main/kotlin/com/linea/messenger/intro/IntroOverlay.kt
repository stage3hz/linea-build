package com.linea.messenger.intro

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.ViewGroup
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import com.linea.messenger.effects.Motion

/** The first-launch intro over the sign-in screen: once per install, at a start with no session, in a window of its
 *  own above the app's (the sign-in screen stays untouched under it, and nothing the app lays over its pages — the
 *  snow — comes above it). At the end it fades out (0.35 s) and the sign-in screen is there; a tap anywhere (or
 *  Back) skips it at once and the haptics stop. Never with reduced motion (the system's animator scale 0
 *  or the app's «Анимации», effects/Motion.kt): the sign-in screen is shown directly. For TalkBack it is one element,
 *  «Инвиз», gone by itself at the end. iOS: Sources/Intro/IntroOverlay.swift. */
object IntroOverlay {
  /** The one-time flag, in the app's own preferences file of such flags (as chatsplus/BarHint.kt keeps its own). */
  private const val PREFERENCES = "linea.intro"
  const val SEEN_KEY = "linea.intro.seen.v1"

  private var dialog: Dialog? = null
  private var view: IntroView? = null
  private var haptics: IntroHaptics? = null
  private var ending = false

  fun seen(context: Context): Boolean =
    try { context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(SEEN_KEY, false) } catch (_: Exception) { true }

  fun markSeen(context: Context) {
    try { context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean(SEEN_KEY, true).apply() } catch (_: Exception) {}
  }

  /** Whether the intro plays at this start (IntroModel.shouldPlay with this phone's answers). */
  fun wanted(context: Context, hasSession: Boolean): Boolean {
    Motion.start(context)
    return IntroModel.shouldPlay(seen(context), hasSession, Motion.enabled)
  }

  /** Called by the start with no session (MainActivity.start), right after the sign-in screen is set. */
  fun firstStart(activity: Activity) {
    if (Build.FINGERPRINT == "robolectric") return // the JVM page tests: no frame clock, no second window
    if (!wanted(activity, hasSession = false)) return
    markSeen(activity)
    show(activity, hold = null)
  }

  /** The emulator check: the intro frozen at `t` over the sign-in screen, no haptics (`--es intro hold --es introat 2.9`). */
  fun hold(activity: Activity, t: Double) = show(activity, hold = t)

  private fun show(activity: Activity, hold: Double?) {
    close()
    if (activity.isFinishing || activity.isDestroyed) return
    val made = IntroView(activity)
    val window = Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar)
    window.setContentView(made, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window.window?.let { w ->
      w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      w.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS)
      w.setWindowAnimations(0)
      @Suppress("DEPRECATION")
      run { w.statusBarColor = Color.TRANSPARENT; w.navigationBarColor = Color.TRANSPARENT }
      if (Build.VERSION.SDK_INT >= 30) {
        w.setDecorFitsSystemWindows(false)
        w.insetsController?.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
      }
      if (Build.VERSION.SDK_INT >= 28) w.attributes = w.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
    }
    window.setCancelable(hold == null)
    window.setOnCancelListener { skip() }
    dialog = window; view = made; ending = false
    if (hold != null) {
      made.hold(hold)
      window.show()
      return
    }
    made.setOnClickListener { skip() }
    made.onTime = { t -> if (t >= IntroModel.DURATION) end() }
    val swell = IntroHaptics(activity)
    haptics = swell
    window.show()
    made.play { begin -> swell.start(begin) }
    made.post { made.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_FOCUSED) }
  }

  /** A tap: haptics stop, the overlay fades out now. */
  fun skip() = end()

  private fun end() {
    if (ending) return
    ending = true
    haptics?.stop(); haptics = null
    val made = view ?: return close()
    made.stop()
    made.isClickable = false
    made.animate().alpha(0f).setDuration((IntroModel.FADE * 1000).toLong()).withEndAction { close() }.start()
  }

  /** Gone at once (the window left, the activity ends). */
  fun close() {
    haptics?.stop(); haptics = null
    view?.stop(); view = null
    try { dialog?.dismiss() } catch (_: Exception) {}
    dialog = null
    ending = false
  }

  /** The app went to the background mid-intro: it is over (no haptics while away). */
  fun wentAway() { if (dialog != null) close() }
}
