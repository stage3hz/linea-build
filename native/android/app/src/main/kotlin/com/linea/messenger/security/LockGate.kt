package com.linea.messenger.security

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Outline
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import com.linea.messenger.R
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.settings.SettingsButton
import java.lang.ref.WeakReference

/** The lock over the whole app («Код-пароль»): a layer of its own above every page of the window, shown on start when a
 *  code is set, on return after the autolock delay, or at once on leaving with «Сразу». Nothing under it is touchable
 *  until the right code (or the fingerprint) opens it. (The previous app: `mobile/src/lock/LockGate.tsx` — on Android
 *  a full-screen layer and no cover in the app switcher, `onLeave(…, ios = false)`; iOS Security/LockGate.swift.) */
object LockGate {
  private var window = WeakReference<Activity>(null)
  private var layer: FrameLayout? = null
  var locked = false
    private set
  private var unreadable = false
  private var wasBackground = false
  /** Posted on the main thread when the lock went up or down. */
  val changed = com.linea.messenger.net.Live.Signal<Unit>()

  /** True while the lock (or the stand-in for an unreadable store) is up. */
  val isUp: Boolean get() = layer?.parent != null

  /** Called once with the app's window (MainActivity): reads the settings and locks when a code is set. */
  fun attach(activity: Activity) {
    window = WeakReference(activity)
    LockStore.attach(activity)
    load()
  }

  private fun load() {
    try {
      LockStore.load()
      unreadable = false
      if (LockRules.shouldLockOnLaunch(LockStore.current, LockRules.nowMs())) lock() else show()
    } catch (_: Exception) {
      // A read error must never open the app: an opaque cover with «Повторить».
      unreadable = true
      show()
    }
  }

  /** Locks the app now; nothing happens when no code is set. */
  fun lock() {
    if (LockStore.current.record == null) return
    if (locked) return show()
    locked = true
    // Locked is also what is saved: a kill-and-relaunch inside the autolock delay must not skip the code.
    LockStore.update { it.copy(backgroundAt = null) }
    show()
  }

  fun unlock() {
    locked = false
    LockStore.recordSuccess()
    show()
  }

  // ---- The app's moments (MainActivity's onStop / onStart) ----

  fun wentAway() {
    wasBackground = true
    val action = LockRules.onLeave(LockStore.current, locked, background = true)
    if (action.recordBackgroundAt) { val now = LockRules.nowMs(); LockStore.update { it.copy(backgroundAt = now) } }
    if (action.lock == "now") lock()
  }

  fun cameBack() {
    val settings = LockStore.current
    if (!locked && LockRules.shouldLockOnReturn(settings, wasBackground, LockRules.nowMs())) {
      wasBackground = false
      return lock()
    }
    wasBackground = false
    show()
    if (locked) (layer?.getChildAt(0) as? LockScreen)?.offerBiometrics()
  }

  // ---- The layer ----

  private fun show() {
    val activity = window.get() ?: return
    val lockShown = LockStore.current.record != null && locked
    val decor = activity.window?.decorView as? ViewGroup ?: return
    if (!lockShown && !unreadable) {
      layer?.let { (it.parent as? ViewGroup)?.removeView(it); changed.post(Unit) }
      layer = null
      return
    }
    val holder = layer ?: Blocker(activity).also { layer = it }
    val current = holder.getChildAt(0)
    val fits = (lockShown && current is LockScreen) || (!lockShown && current is LockCover)
    if (!fits) {
      holder.removeAllViews()
      val made: View = if (lockShown) LockScreen(activity).also { it.onUnlock = { unlock() } } else LockCover(activity).also { it.onRetry = { load() } }
      holder.addView(made, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }
    (holder.getChildAt(0) as? LockCover)?.setRetry(unreadable)
    if (holder.parent == null) {
      decor.addView(holder, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      changed.post(Unit)
    } else if (decor.getChildAt(decor.childCount - 1) !== holder) holder.bringToFront()
  }

  /** The layer itself: opaque, it takes every touch so nothing under it can be reached. */
  private class Blocker(context: Context) : FrameLayout(context) {
    init {
      setBackgroundColor(Theme.bg)
      isClickable = true
      isFocusable = true
      elevation = 1000f
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent?): Boolean = true
  }

  /** The emulator check (`--es lockdemo digits|wrong|password`): the lock screen with a sample code (nothing is read or kept). */
  fun demo(activity: Activity, kind: String) {
    window = WeakReference(activity)
    val decor = activity.window?.decorView as? ViewGroup ?: return
    val screen = LockScreen(activity, sampleKind = if (kind == "password") "password" else "digits")
    val holder = Blocker(activity).also { layer = it }
    holder.addView(screen, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    decor.addView(holder, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    if (kind == "wrong") holder.postDelayed({ screen.demoWrong() }, 900)
  }
}

/** The app's mark as the lock shows it: the «Синяя» icon, 64 dp, rounded. */
private fun logo(context: Context): ImageView = ImageView(context).apply {
  setImageResource(R.drawable.app_icon_default_preview)
  scaleType = ImageView.ScaleType.CENTER_CROP
  val corner = 15f * resources.displayMetrics.density
  outlineProvider = object : ViewOutlineProvider() { override fun getOutline(view: View, outline: Outline) { outline.setRoundRect(0, 0, view.width, view.height, corner) } }
  clipToOutline = true
  importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
}

/** The opaque stand-in when the settings could not be read. */
class LockCover(context: Context) : LinearLayout(context) {
  var onRetry: (() -> Unit)? = null
  private val words = context.words("Не удалось прочитать настройки код-пароля", 16f, Theme.text)
  private val again = SettingsButton(context, "Повторить", SettingsButton.Kind.PRIMARY, icon = "refresh-outline")

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER
    setBackgroundColor(Theme.bg)
    setPadding(context.px(28f), 0, context.px(28f), 0)
    addView(logo(context), LayoutParams(context.px(64f), context.px(64f)))
    words.gravity = Gravity.CENTER
    addView(words, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(18f) })
    again.onPress = { onRetry?.invoke() }
    addView(again, LayoutParams(LayoutParams.MATCH_PARENT, context.px(50f)).apply { topMargin = context.px(18f) })
  }

  fun setRetry(on: Boolean) {
    words.visibility = if (on) VISIBLE else GONE
    again.visibility = if (on) VISIBLE else GONE
  }
}

/** The lock screen: the logo, «ИНВИЗ», and the code entry with the fingerprint when it is on. */
@SuppressLint("ViewConstructor")
class LockScreen(context: Context, private val sampleKind: String? = null) : FrameLayout(context) {
  var onUnlock: (() -> Unit)? = null
  private val entry: CodeEntryView
  private var wrong = false
  private var checking = false
  private var prompting = false
  private var bioLabel: String? = null
  private val ticker = Handler(Looper.getMainLooper())
  private val tick = object : Runnable { override fun run() { refreshWords(); ticker.postDelayed(this, 500) } }

  init {
    setBackgroundColor(Theme.bg)
    val kind = sampleKind ?: LockStore.current.record?.kind ?: "digits"
    val column = LinearLayout(context)
    column.orientation = LinearLayout.VERTICAL
    column.gravity = Gravity.CENTER_HORIZONTAL
    column.addView(logo(context), LinearLayout.LayoutParams(context.px(64f), context.px(64f)))
    val name = context.words("ИНВИЗ", 13f, Theme.muted, 700).apply { letterSpacing = 1.6f / 13f }
    column.addView(name, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(14f) })
    entry = CodeEntryView(context, kind)
    entry.onSubmit = { code -> submit(code) }
    column.addView(entry, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(28f) })
    val scroll = ScrollView(context)
    scroll.isFillViewport = true
    scroll.isVerticalScrollBarEnabled = false
    val middle = FrameLayout(context)
    middle.addView(column, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { topMargin = context.px(24f); bottomMargin = context.px(28f) })
    scroll.addView(middle, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    if (sampleKind == null && LockStore.current.biometrics) LockBiometrics.label(context)?.let { label ->
      bioLabel = label
      entry.biometric = Triple("ion:finger-print-outline", label) { tryBiometrics() }
    }
    refreshWords()
  }

  /** The system bars and the keyboard: the code stays clear of them. */
  @Suppress("DEPRECATION")
  override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
    setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
    return insets
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    requestApplyInsets()
    ticker.postDelayed(tick, 500)
    entry.focus()
    post { offerBiometrics() }
  }

  override fun onDetachedFromWindow() { ticker.removeCallbacksAndMessages(null); super.onDetachedFromWindow() }

  /** The fingerprint is offered straight away when it is on and the window is on the screen. */
  fun offerBiometrics() {
    if (bioLabel == null || !isShown) return
    tryBiometrics()
  }

  private fun tryBiometrics() {
    if (prompting) return
    val activity = context as? Activity ?: return
    prompting = true
    LockBiometrics.authenticate(activity) { success ->
      prompting = false
      if (success) { performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); onUnlock?.invoke() }
    }
  }

  private fun refreshWords() {
    val wait = if (sampleKind != null) 0.0 else LockStore.waitMs
    val digits = entry.kind == "digits"
    val hint = if (wait > 0) LockRules.retryHint(wait) else if (digits) "Введи код-пароль, чтобы открыть Инвиз" else "Введи пароль, чтобы открыть Инвиз"
    entry.setTitle(if (digits) "Введи код-пароль" else "Введи пароль", hint, if (wrong && wait <= 0) "Неверный код-пароль" else "")
    entry.disabled = checking || wait > 0
  }

  /** The emulator check: a wrong code was typed (the shake and the red line); nothing is kept. */
  fun demoWrong() {
    wrong = true
    entry.shake()
    refreshWords()
  }

  private fun submit(code: String) {
    if (sampleKind != null) return demoWrong()
    if (checking || LockStore.waitMs > 0) return
    checking = true
    refreshWords()
    LockStore.check(code) { right ->
      checking = false
      if (right) {
        performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        onUnlock?.invoke()
        return@check
      }
      wrong = true
      LockStore.recordFailure()
      entry.shake()
      refreshWords()
    }
  }
}
