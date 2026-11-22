package com.linea.messenger.auth

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import android.view.animation.PathInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.Demo
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.shell.Screen
import java.text.Normalizer
import java.time.Instant
import java.util.Locale
import kotlin.math.ceil

/** The sign-in screen (`mobile/src/AuthScreen.tsx`), one step at a time:
 *  - signing in: the login, the password, the confirmation word — all three go to the server together at the
 *    last step, and which of them was wrong is never told;
 *  - creating an account: the login, the public profile, the password, the confirmation word, the recovery word;
 *  - a forgotten password: the login with the recovery word, the waiting period, the new password.
 *  What is typed is kept only in the fields, and the secrets are forgotten on every way out of a flow. */
@SuppressLint("ViewConstructor")
class AuthScreen(context: Context, private val server: Server) : Screen(context) {
  private enum class Mode {
    LOGIN_NAME, LOGIN_PASSWORD, LOGIN_WORD,
    REGISTER_NAME, REGISTER_PROFILE, REGISTER_PASSWORD, REGISTER_CONFIRMATION, REGISTER_RECOVERY,
    RECOVER, WAITING, RESET,
  }

  /** What the server said about the recovery attempts of one login. `lockedUntil`: on the clock that only counts
   *  forward (`SystemClock.elapsedRealtime`); 0 = not locked. */
  private class RecoveryFeedback(val username: String, val remaining: Int?, val lockedUntil: Long)

  /** Called with the session's token and the account (`user` of the server's answer) once signed in. */
  var onSignedIn: ((token: String, user: Map<String, Any?>) -> Unit)? = null

  /** A server operation by its name; the answer comes on any thread. (Replaced in the tests.) */
  internal var ask: (name: String, args: List<Any?>, done: (Result<Any?>) -> Unit) -> Unit = { name, args, done -> server.op(name, args, done) }
  /** Closes on the server a session nobody waits for any more. (Replaced in the tests.) */
  internal var endSession: (token: String) -> Unit = { token -> Server(server.base, token).op("logout", emptyList()) { } }

  private var mode = Mode.LOGIN_NAME
  private var shownMode: Mode? = null
  private var shownBusy = false
  /** The permission to set a new password, while a recovery is under way. */
  private var grant: RecoveryGrant? = null
  /** The server's clock minus this phone's (`nowMs`), in milliseconds. */
  private var serverOffset = 0.0
  private var entered = false
  private var pending = false
  private var checking = false
  private var statusPending = false
  private var generation = 0
  private var statusGeneration = 0
  /** The three below: on the clock that only counts forward; 0 = never / not locked. */
  private var lastStatusCheck = 0L
  private var loginLockUntil = 0L
  private var feedback: RecoveryFeedback? = null
  private var errorText = ""
  private var noticeText = ""
  /** A made-up request shown for the emulator check: nothing is asked from the server and nothing is kept. */
  private var sample = false
  private var started = false

  private val main = Handler(Looper.getMainLooper())
  private val ticker = object : Runnable { override fun run() { tick(); main.postDelayed(this, 1000) } }

  // L: the reference's sign-in (AuthScreen.tsx, App.tsx `ThemeAccess`): the steps live on a glass card (GlassSurface
  // «regular», radius 32, 22 inside), and a glass pill at the top right names the theme on screen and opens the choice.
  // Nothing scrolls: the parts are put in place by `place` (AuthFit), and the card is drawn by `plate` under them.
  private val plate = View(context)
  private val brandBox = FrameLayout(context)
  private val themePill = AuthThemePill(context)
  private val brand = com.linea.messenger.effects.WordmarkView(context, 60f) // Effects: «Инвиз» in moving platinum, the reference's Wordmark (effects/AppearingText.kt)
  private val motto = context.words("Твоя линия связи.", 17f, Theme.muted)
  private val heading = com.linea.messenger.effects.AppearingTextView(context, 22f, Theme.text, 600) // Effects: the title's words rise in one after another
  private val hint = context.words("", 15f, Theme.muted)
  private val switcher = LinearLayout(context)
  private val switches = listOf(context.words("Войти", 13f, Theme.muted, 500), context.words("Создать аккаунт", 13f, Theme.muted, 500))
  private val progress = LinearLayout(context)
  private val bars = ArrayList<View>()
  private val progressLabel = context.words("", 11f, Theme.muted)

  private val nameEntry = AuthEntry(context, "Логин", "Введите логин", secret = false)
  private val loginWarning = AuthNotice(context, error = false)
  private val displayEntry = AuthEntry(context, "Имя", "Как тебя видят в чатах", secret = false)
  private val handleEntry = AuthEntry(context, "Публичный @юзернейм", "Для поиска, не как логин", secret = false)
  private val profileHelp = note("По @юзернейму тебя найдут. Логин для входа другой, его не видит никто.")
  private val passwordEntry = AuthEntry(context, "Пароль", "Твой пароль", secret = true)
  private val confirmationEntry = AuthEntry(context, "Слово подтверждения", "Твоё слово для входа", secret = true)
  private val confirmationHelp = note("")
  private val recoveryEntry = AuthEntry(context, "Слово восстановления", "Отдельное слово для восстановления", secret = true)
  private val recoveryHelp = note(WORD_HELP)
  private val recoveryExtra = note("")
  private val waitingBox = LinearLayout(context)
  private val clock = context.words("", 43f, Theme.text, 700)
  private val clockOwner = note("")
  private val resetValidity = note("")
  private val recoveryLock = AuthNotice(context, error = true)
  private val attemptsNote = note("")
  private val manualNote = note("Только ручной ввод. Вставка и автозаполнение отключены.", 11f, Theme.subtle)
  private val notice = AuthNotice(context, error = false)
  private val failure = AuthNotice(context, error = true)
  private val loginLock = AuthNotice(context, error = true)
  private val proceed = com.linea.messenger.effects.ActionButton(context, "Продолжить") // Effects: the button with states (effects/ActionButton.kt)
  private val forgot = context.words("Забыл пароль?", 14f, Theme.text, 700)
  private val back = context.words("", 15f, Theme.muted)

  private fun note(words: String, size: Float = 12f, color: Int = Theme.muted): TextView = context.words(words, size, color)

  /** The parts of the card from the top, «Продолжить» and the links under it. */
  private val cardParts: List<View> = listOf(
    switcher, progress, nameEntry, loginWarning, displayEntry, handleEntry, profileHelp, passwordEntry, confirmationEntry,
    confirmationHelp, recoveryEntry, recoveryHelp, recoveryExtra, waitingBox, resetValidity, recoveryLock, attemptsNote, manualNote,
    notice, failure, loginLock)
  private val links: List<View> = listOf(forgot, back)
  /** What may leave when there is no room, in the order AuthFit keeps them (the first stays longest). */
  private val helpParts: List<View> = listOf(confirmationHelp, recoveryHelp, profileHelp, resetValidity, loginWarning)
  private val chromeParts: List<View> = listOf(progress, switcher)
  private val extraParts: List<View> = listOf(recoveryExtra, back, forgot, manualNote)
  private val messageParts: List<View> = listOf(recoveryLock, attemptsNote, notice, failure, loginLock)

  /** How far the screen is in the keyboard's arrangement: 0 — none, 1 — all the way. */
  private var compactness = 0f
  /** Where it is going. */
  private var compactGoal = 0f
  private var compactFrom = 0f
  /** The keyboard's own motion is under way (Android 11 and later): its fraction moves the screen. */
  private var keyboardMoving = false
  private var keyboardFraction = 1f
  /** The height of the keyboard the compact arrangement stands on (the last one that was up), and while it changes. */
  private var keyboardHeight = 0
  private var keyboardFrom = 0f
  private var keyboardTo = 0f
  /** The compact arrangement stays while a request is under way (the field is closed then and the keyboard leaves
   *  for a moment): nothing moves before the answer. */
  private var held = false
  private var placed = false
  private var settle: ValueAnimator? = null

  init {
    setBackgroundColor(Theme.bg)
    build()
    restore()
    Demo.authMode?.let { simulate(it) }
    render()
  }

  // The screen

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    main.removeCallbacks(ticker)
    main.postDelayed(ticker, 1000)
    if (!started) {
      started = true
      if (mode == Mode.WAITING) checkRecovery()
    }
    if (Build.VERSION.SDK_INT >= 30) KeyboardMotion.follow(this)
    focus()
    // The emulator check: `--es authfocus 2` gives the keyboard to the second field of the step (debug builds).
    if (Demo.authFocus > 0) main.postDelayed({ focusField(Demo.authFocus) }, 400)
  }

  override fun onDetachedFromWindow() {
    // The screen is leaving: answers still on their way are not for it any more, and nothing typed stays.
    main.removeCallbacks(ticker)
    generation += 1
    statusGeneration += 1
    pending = false
    statusPending = false
    checking = false
    entered = false
    held = false
    settle?.cancel()
    clearSecrets()
    keyboard()?.hideSoftInputFromWindow(windowToken, 0)
    super.onDetachedFromWindow()
  }

  // Nothing scrolls. Two arrangements (AuthFit): without the keyboard — the wordmark, the motto, the step's title and
  // description, the card; with it — the title at the top and the card right under it down to the keyboard, «Продолжить»
  // at the card's bottom. The screen moves from one to the other once, frame by frame with the keyboard's own motion
  // (`KeyboardMotion`, Android 11 and later; a short animation of the same length before that).

  private fun lerp(from: Float, to: Float, at: Float): Float = from + (to - from) * at

  private val keyboardUp: Boolean get() = edges.keyboard > AuthFit.KEYBOARD * d

  private val compactWanted: Boolean get() = keyboardUp || (held && keyboardHeight > 0)

  override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
    val result = super.onApplyWindowInsets(insets)
    if (keyboardUp) {
      keyboardHeight = edges.keyboard
      held = false
    }
    return result
  }

  /** The keyboard's motion begins (Android 11 and later): the screen follows it from where it is now. */
  internal fun keyboardStarts() {
    settle?.cancel()
    keyboardMoving = true
    keyboardFraction = 0f
    compactFrom = compactness
    keyboardFrom = keyboardHeight.toFloat()
  }

  /** The keyboard's end is known (its insets came before this): where the screen goes. */
  internal fun keyboardAims() {
    compactGoal = if (compactWanted) 1f else 0f
    keyboardTo = keyboardHeight.toFloat()
    // From the full arrangement the card goes straight to the keyboard's end; between two keyboards it follows.
    if (compactFrom < 1f || keyboardFrom <= 0f) keyboardFrom = keyboardTo
  }

  internal fun keyboardMoves(fraction: Float) {
    keyboardFraction = fraction
    compactness = lerp(compactFrom, compactGoal, fraction)
    placeNow()
  }

  internal fun keyboardStops() {
    keyboardMoving = false
    keyboardFraction = 1f
    compactGoal = if (compactWanted) 1f else 0f
    compactness = compactGoal
    placeNow()
  }

  private fun placeNow() {
    if (width > 0 && height > 0) place(width, height)
  }

  /** Without the keyboard's own motion (before Android 11, a hardware keyboard, the end of a request): the same move
   *  in a short animation. */
  private fun moveTo(goal: Float) {
    settle?.cancel()
    compactGoal = goal
    val motion = ValueAnimator.ofFloat(compactness, goal)
    motion.duration = 250
    motion.interpolator = PathInterpolator(0.2f, 0f, 0f, 1f)
    motion.addUpdateListener { compactness = it.animatedValue as Float; placeNow() }
    settle = motion
    motion.start()
  }

  /** Lets the compact arrangement go once a request has ended: right away when no field has the keyboard (the waiting
   *  period), or when the keyboard does not come back to the field. */
  private fun releaseHold() {
    if (!held) return
    if (findFocus() == null) {
      held = false
      requestLayout()
      return
    }
    main.postDelayed({
      if (held && !pending && !entered) {
        held = false
        requestLayout()
      }
    }, 600)
  }

  private fun wanted(view: View): Boolean = view.visibility != View.GONE
  private fun id(view: View): String = System.identityHashCode(view).toString()
  private fun optional(view: View): Boolean = view in helpParts || view in chromeParts || view in extraParts

  /** One arrangement: where each part stands and which of them show. */
  private class Frame {
    val top = HashMap<View, Float>()
    val shown = HashSet<View>()
    var plateTop = 0f
    var plateBottom = 0f
  }

  override fun place(width: Int, height: Int) {
    val goal = if (compactWanted) 1f else 0f
    if (!placed) {
      placed = true
      compactness = goal
      compactGoal = goal
    } else if (!keyboardMoving && goal != compactGoal) {
      moveTo(goal)
    }
    // L: the theme pill: 20 from the right, 7 under the status bar; it steps aside while the keyboard is up.
    themePill.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(dp(44f), MeasureSpec.EXACTLY))
    put(themePill, width - dp(20f) - themePill.measuredWidth, edges.top + dp(7f), themePill.measuredWidth, dp(44f))
    themePill.alpha = 1f - compactness
    themePill.visibility = if (compactness < 0.99f) View.VISIBLE else View.INVISIBLE

    val unit = d
    val left = dp(22f)
    val columnWidth = width - dp(44f)
    val innerLeft = left + dp(22f)
    val innerWidth = columnWidth - dp(44f)
    val heights = HashMap<View, Float>()
    fun measured(view: View, wide: Int): Float {
      view.measure(MeasureSpec.makeMeasureSpec(wide.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      return view.measuredHeight.toFloat()
    }
    for (view in listOf(brandBox, motto, heading, hint)) heights[view] = measured(view, columnWidth)
    for (view in cardParts + links + listOf(proceed)) if (wanted(view)) heights[view] = measured(view, innerWidth)
    fun h(view: View): Float = heights[view] ?: 0f
    fun gapAfter(view: View, compact: Boolean): Float =
      (if (view in chromeParts) (if (compact) AuthFit.COMPACT_CHROME_GAP else AuthFit.CHROME_GAP) else AuthFit.GAP) * unit
    fun cost(view: View, compact: Boolean): Float = if (view in links) h(view) + AuthFit.LINK_GAP * unit else h(view) + gapAfter(view, compact)
    fun parts(from: List<View>, compact: Boolean): List<AuthFit.Part> = from.filter { wanted(it) }.map { AuthFit.Part(id(it), cost(it, compact)) }
    var core = h(proceed)
    var messages = 0f
    for (view in cardParts) {
      if (!wanted(view) || optional(view)) continue
      if (view in messageParts) messages += cost(view, false) else core += cost(view, false)
    }

    // Without the keyboard.
    val small = if (keyboardUp) 0 else edges.keyboard
    val fullTop = edges.top + AuthFit.PILL_ROW * unit
    val fullBottom = height - maxOf(small, edges.bottom) - AuthFit.EDGE * unit
    val plan = AuthFit.full(fullBottom - fullTop, h(brandBox), h(motto), h(heading), h(hint), 2 * AuthFit.PAD * unit + core + messages,
      parts(helpParts, false), parts(chromeParts, false), parts(extraParts, false), unit)
    val full = Frame()
    var y = fullTop + plan.gap
    full.top[brandBox] = y
    if (plan.brand) { full.shown.add(brandBox); y += h(brandBox) + AuthFit.afterBrand(plan.motto) * unit }
    full.top[motto] = y
    if (plan.motto) { full.shown.add(motto); y += h(motto) + AuthFit.AFTER_MOTTO * unit }
    full.top[heading] = y
    y += h(heading) + AuthFit.afterHeading(plan.hint) * unit
    full.top[hint] = y
    if (plan.hint) { full.shown.add(hint); y += h(hint) + AuthFit.AFTER_HINT * unit }
    full.plateTop = y
    y += AuthFit.PAD * unit
    for (view in cardParts) {
      if (!wanted(view)) continue
      full.top[view] = y
      if (!optional(view) || id(view) in plan.kept) { full.shown.add(view); y += h(view) + gapAfter(view, false) }
    }
    full.top[proceed] = y
    y += h(proceed)
    var first = true
    for (view in links) {
      if (!wanted(view)) continue
      if (id(view) in plan.kept) {
        if (first) y += AuthFit.LINK_GAP * unit
        first = false
        full.shown.add(view)
        full.top[view] = y
        y += h(view)
      } else {
        full.top[view] = y
      }
    }
    full.plateBottom = y + AuthFit.PAD * unit

    // With the keyboard: the title at the top, the card down to the keyboard (the parts that stay are chosen for the
    // keyboard's end, so they do not change while it moves).
    val compact = Frame()
    val headingTop = edges.top + AuthFit.COMPACT_TOP * unit
    val shift = headingTop - (full.top[heading] ?: 0f)
    for (view in listOf(brandBox, motto, heading, hint)) compact.top[view] = (full.top[view] ?: 0f) + shift
    compact.plateTop = headingTop + h(heading) + AuthFit.COMPACT_HEADING_GAP * unit
    val keyboardNow = if (keyboardMoving) lerp(keyboardFrom, keyboardTo, keyboardFraction) else keyboardHeight.toFloat()
    val keyboardEnd = if (keyboardMoving) keyboardTo else keyboardHeight.toFloat()
    val room = height - keyboardEnd - AuthFit.COMPACT_EDGE * unit - compact.plateTop - 2 * AuthFit.COMPACT_PAD * unit
    var compactCore = h(proceed)
    for (view in cardParts) if (wanted(view) && !optional(view) && view !in messageParts) compactCore += cost(view, true)
    val kept = AuthFit.compact(room, compactCore, messages, parts(helpParts, true), parts(chromeParts, true), parts(extraParts, true))
    y = compact.plateTop + AuthFit.COMPACT_PAD * unit
    for (view in cardParts) {
      if (!wanted(view)) continue
      compact.top[view] = y
      if (!optional(view) || id(view) in kept) { compact.shown.add(view); y += h(view) + gapAfter(view, true) }
    }
    compact.plateBottom = height - keyboardNow - AuthFit.COMPACT_EDGE * unit
    var bottom = compact.plateBottom - AuthFit.COMPACT_PAD * unit
    val shownLinks = links.filter { wanted(it) && id(it) in kept }
    for (index in shownLinks.indices.reversed()) {
      val view = shownLinks[index]
      bottom -= h(view)
      compact.top[view] = bottom
      compact.shown.add(view)
      if (index == 0) bottom -= AuthFit.LINK_GAP * unit
    }
    compact.top[proceed] = bottom - h(proceed)
    val buttonShift = (compact.top[proceed] ?: 0f) - (full.top[proceed] ?: 0f)
    for (view in links) if (wanted(view) && view !in compact.shown) compact.top[view] = (full.top[view] ?: 0f) + buttonShift

    // Between the two, as far as the keyboard has come.
    val at = compactness
    fun at(view: View): Int = Math.round(lerp(full.top[view] ?: 0f, compact.top[view] ?: 0f, at))
    fun fade(view: View, from: Boolean, to: Boolean) {
      val alpha = lerp(if (from) 1f else 0f, if (to) 1f else 0f, at)
      view.alpha = alpha
      view.visibility = if (alpha > 0.01f) View.VISIBLE else View.INVISIBLE
    }
    for (view in listOf(brandBox, motto, hint)) {
      put(view, left, at(view), columnWidth, Math.round(h(view)))
      fade(view, view in full.shown, false)
    }
    put(heading, left, at(heading), columnWidth, Math.round(h(heading)))
    val plateTop = Math.round(lerp(full.plateTop, compact.plateTop, at))
    val plateBottom = Math.round(lerp(full.plateBottom, compact.plateBottom, at))
    put(plate, left, plateTop, columnWidth, plateBottom - plateTop)
    for (view in cardParts + listOf(proceed) + links) {
      if (!wanted(view)) continue
      put(view, innerLeft, at(view), innerWidth, Math.round(h(view)))
      if (optional(view)) fade(view, view in full.shown, view in compact.shown)
    }
  }

  private fun keyboard(): InputMethodManager? = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

  /** Adds a part of the card to the screen (put in place by `place`). */
  private fun part(view: View) {
    addView(view)
  }

  private fun build() {
    if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true

    switcher.orientation = LinearLayout.HORIZONTAL
    switcher.background = context.plate(Theme.surface2, 9f)
    switcher.setPadding(context.px(2f), context.px(2f), context.px(2f), context.px(2f))
    switches.forEachIndexed { index, item ->
      item.gravity = Gravity.CENTER
      item.isClickable = true
      item.isFocusable = true
      item.setOnClickListener { switched(register = index == 1) }
      switcher.addView(item, LinearLayout.LayoutParams(0, context.px(32f), 1f))
    }

    val barRow = LinearLayout(context)
    barRow.orientation = LinearLayout.HORIZONTAL
    for (index in registerSteps.indices) {
      val bar = View(context)
      bars.add(bar)
      barRow.addView(bar, LinearLayout.LayoutParams(0, context.px(4f), 1f).apply { if (index > 0) leftMargin = context.px(8f) })
    }
    progressLabel.fontFeatureSettings = "tnum"
    progress.orientation = LinearLayout.HORIZONTAL
    progress.gravity = Gravity.CENTER_VERTICAL
    progress.addView(barRow, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    progress.addView(progressLabel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(13f) })
    progress.isFocusable = true

    loginWarning.words = "Это твой логин для входа. Его видишь только ты, и сменить его потом нельзя. Публичный @юзернейм задашь на следующем шаге — он будет другим. Запомни логин или запиши в надёжное место."
    nameEntry.limit = 24
    displayEntry.limit = 50
    displayEntry.field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    displayEntry.field.imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
    handleEntry.limit = 25
    handleEntry.noSpaces = true
    // Return: to the next field of the step (fields of a step stand still), on the last field — «Продолжить».
    for (entry in listOf(nameEntry, handleEntry, passwordEntry, confirmationEntry, recoveryEntry)) entry.onReturn = { submit() }
    nameEntry.onReturn = { if (mode == Mode.RECOVER) recoveryEntry.field.requestFocus() else submit() }
    displayEntry.onReturn = { handleEntry.field.requestFocus() }

    clock.gravity = Gravity.CENTER
    clock.fontFeatureSettings = "tnum"
    clock.contentDescription = "Осталось до проверки сервером"
    clockOwner.gravity = Gravity.CENTER
    val waitingAbout = note("На устройствах с открытым аккаунтом этот запрос можно отменить. Если запрос сохранён, можно закрыть приложение и вернуться. Готовность проверяется на сервере каждые 10 секунд.")
    val waitingLeave = note("Переход ко входу удалит запрос с этого устройства. Продолжить его здесь после этого не получится.")
    waitingBox.orientation = LinearLayout.VERTICAL
    for ((item, after) in listOf(clock to 10f, clockOwner to 18f, waitingAbout to 10f, waitingLeave to 0f)) {
      waitingBox.addView(item, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = context.px(after) })
    }

    proceed.onPress = { submit() }
    for (link in listOf(forgot, back)) {
      link.gravity = Gravity.CENTER
      link.minHeight = context.px(44f)
      link.isClickable = true
      link.isFocusable = true
    }
    forgot.setOnClickListener { forgotPassword() }
    back.setOnClickListener { goBack() }

    // In the order a screen reader reads them; the card's glass under its parts.
    brandBox.addView(brand, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    addView(brandBox); addView(motto); addView(heading); addView(hint)
    plate.background = com.linea.messenger.design.GlassDrawable(plate, context.px(32f).toFloat(), clear = false)
    // A touch on the card itself does not put the keyboard away (a touch beside it does).
    plate.isClickable = true
    plate.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(plate)
    for (item in cardParts) part(item)
    part(proceed); part(forgot); part(back)
    // A touch beside the card puts the keyboard away (there is nothing to scroll it away with).
    setOnClickListener {
      findFocus()?.clearFocus()
      keyboard()?.hideSoftInputFromWindow(windowToken, 0)
    }
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    // The sign-in screen is not part of the app's shell: it is made again in the new colours.
    themePill.onChanged = {
      val fresh = AuthScreen(context, server)
      fresh.onSignedIn = onSignedIn
      (parent as? com.linea.messenger.shell.Navigation)?.setRoot(fresh)
    }
    addView(themePill)
  }

  /** A recovery request kept from an earlier launch brings the screen back to its waiting period. */
  private fun restore() {
    try {
      val saved = RecoveryStore.read(context, server.base) ?: return
      nameEntry.value = saved.username
      grant = saved.grant
      serverOffset = saved.grant.serverMs - nowMs
      mode = Mode.WAITING
      noticeText = "Запрос восстановления найден. Проверяем его состояние на сервере."
    } catch (_: Exception) {
      noticeText = "Не удалось прочитать сохранённый запрос восстановления. Можно начать новый запрос."
    }
  }

  /** The emulator check (debug builds; see `Demo.authMode`): `register` / `recover` open the first step of that
   *  flow, `profile` the second step of creating an account (two fields); `waiting` / `reset` show those two screens
   *  with a made-up request (no server is asked, nothing is kept). */
  private fun simulate(wanted: String) {
    if (wanted == "register" || wanted == "recover" || wanted == "profile") {
      grant = null
      noticeText = ""
      nameEntry.value = ""
      mode = if (wanted == "register") Mode.REGISTER_NAME else if (wanted == "profile") Mode.REGISTER_PROFILE else Mode.RECOVER
      return
    }
    if (wanted != "waiting" && wanted != "reset") return
    val now = Instant.now()
    val ready = if (wanted == "waiting") now.plusSeconds(9 * 60 + 41) else now.minusSeconds(60)
    val made = RecoveryGrant.from(mapOf("resetToken" to "sample", "requestId" to "sample", "readyAt" to ready.toString(),
      "expiresAt" to ready.plusSeconds(20 * 60).toString(), "serverTime" to now.toString())) ?: return
    sample = true
    grant = made
    serverOffset = made.serverMs - nowMs
    nameEntry.value = Demo.authLogin
    noticeText = if (wanted == "reset") "Сервер разрешил сменить пароль. Оба секретных слова останутся прежними." else ""
    mode = if (wanted == "waiting") Mode.WAITING else Mode.RESET
  }

  // What is on the screen

  private val elapsed: Long get() = SystemClock.elapsedRealtime()
  /** This phone's clock for the countdowns: the one that only counts forward, so setting the phone's time does
   *  not move them. Only its distance to the server's clock (`serverOffset`) is ever used. */
  private val nowMs: Double get() = elapsed.toDouble()
  private val login: String get() = AuthRules.name(nameEntry.value)
  private val isLogin: Boolean get() = mode in loginSteps
  private val isRegister: Boolean get() = mode in registerSteps

  /** Five wrong sign-ins close the entrance for five minutes (the server enforces it; this shows the countdown). */
  private val loginLocked: Boolean get() = isLogin && loginLockUntil > elapsed

  private val loginLockText: String
    get() {
      val left = ceil(maxOf(0L, loginLockUntil - elapsed) / 1000.0).toLong()
      return "${left / 60}:" + String.format(Locale.ROOT, "%02d", left % 60)
    }

  /** Until when the recovery of the login now typed is closed; 0 when it is not. */
  private val recoveryLockedUntil: Long
    get() {
      val known = feedback ?: return 0
      return if (known.username == login && known.lockedUntil > elapsed) known.lockedUntil else 0
    }

  private fun headingWords(mode: Mode): String = when (mode) {
    Mode.LOGIN_NAME, Mode.REGISTER_NAME -> "Логин"
    Mode.LOGIN_PASSWORD, Mode.REGISTER_PASSWORD -> "Пароль"
    Mode.LOGIN_WORD, Mode.REGISTER_CONFIRMATION -> "Слово подтверждения"
    Mode.REGISTER_PROFILE -> "Профиль"
    Mode.REGISTER_RECOVERY -> "Слово восстановления"
    Mode.RECOVER -> "Восстановление"
    Mode.WAITING -> "Ожидание"
    Mode.RESET -> "Новый пароль"
  }

  private fun hintWords(mode: Mode): String = when (mode) {
    Mode.LOGIN_NAME -> "Вход без почты и номера телефона. Данные проверим вместе на последнем шаге."
    Mode.LOGIN_PASSWORD -> "Введи пароль вручную. Следом понадобится слово подтверждения."
    Mode.LOGIN_WORD -> "Введи слово подтверждения, которое выбрал при регистрации."
    Mode.REGISTER_NAME -> "Всё вводится один раз. Перед тем как идти дальше, проверь, что нет опечатки."
    Mode.REGISTER_PROFILE -> "Это видят другие: имя и @юзернейм для поиска. Логин остаётся тайным."
    Mode.REGISTER_PASSWORD -> "От 10 до 128 символов. Длинная фраза тоже подходит."
    Mode.REGISTER_CONFIRMATION -> "Это слово нужно при входе после пароля. Оно должно отличаться от логина и пароля."
    Mode.REGISTER_RECOVERY -> "Это отдельное слово понадобится, если забудешь пароль. Оно должно отличаться от первого."
    Mode.RECOVER -> "Введи логин и слово восстановления. После подтверждения нужно будет подождать 10 минут."
    Mode.WAITING -> "Слово восстановления подтверждено. Через 10 минут сервер разрешит задать новый пароль."
    Mode.RESET -> "Введи новый пароль и проверь его глазами. Слово подтверждения и слово восстановления сохранятся."
  }

  private fun buttonWords(mode: Mode): String = when (mode) {
    Mode.REGISTER_RECOVERY -> "Создать аккаунт"
    Mode.LOGIN_WORD -> "Войти в Инвиз"
    Mode.RECOVER -> "Подтвердить слово"
    Mode.WAITING -> "Проверить статус"
    Mode.RESET -> "Сохранить новый пароль"
    else -> "Продолжить"
  }

  /** A part the step has or has not. One it has may still be left out for want of room (`place` makes it invisible
   *  then): that is not undone here. */
  private fun show(view: View, shown: Boolean) {
    if (!shown) view.visibility = View.GONE else if (view.visibility == View.GONE) view.visibility = View.VISIBLE
  }

  /** Puts everything the screen knows on it. */
  private fun render() {
    val changed = shownMode != mode
    shownMode = mode
    val busy = pending || entered
    // A field that was closed for the time of a request gets the keyboard back.
    val freed = shownBusy && !busy
    shownBusy = busy
    heading.show(headingWords(mode)) // Effects
    hint.text = hintWords(mode)

    show(switcher, isLogin || isRegister)
    switches.forEachIndexed { index, item ->
      val on = (index == 1) == isRegister
      item.background = if (on) context.plate(Theme.veil(0.14f), 7f) else null
      item.setTextColor(if (on) Theme.text else Theme.muted)
      item.typeface = Theme.weight(if (on) 700 else 500)
      item.isSelected = on
      item.isEnabled = !busy
    }

    var step = 0
    var stepCount = 0
    if (mode in registerSteps) { step = registerSteps.indexOf(mode) + 1; stepCount = registerSteps.size }
    else if (mode in loginSteps) { step = loginSteps.indexOf(mode) + 1; stepCount = loginSteps.size }
    show(progress, step != 0)
    bars.forEachIndexed { index, bar ->
      show(bar, index < stepCount)
      bar.background = context.plate(if (index < step) Theme.accent else Theme.veil(0.12f), 2f)
    }
    progressLabel.text = "$step / $stepCount"
    progress.contentDescription = "Шаг $step из $stepCount"

    show(nameEntry, mode == Mode.LOGIN_NAME || mode == Mode.REGISTER_NAME || mode == Mode.RECOVER)
    show(loginWarning, mode == Mode.REGISTER_NAME)
    show(displayEntry, mode == Mode.REGISTER_PROFILE)
    show(handleEntry, mode == Mode.REGISTER_PROFILE)
    show(profileHelp, mode == Mode.REGISTER_PROFILE)
    show(passwordEntry, mode == Mode.LOGIN_PASSWORD || mode == Mode.REGISTER_PASSWORD || mode == Mode.RESET)
    val asksConfirmation = mode == Mode.LOGIN_WORD || mode == Mode.REGISTER_CONFIRMATION
    show(confirmationEntry, asksConfirmation)
    show(confirmationHelp, asksConfirmation)
    confirmationHelp.text = if (mode == Mode.REGISTER_CONFIRMATION) WORD_HELP
      else "Если в старом аккаунте слово ещё не настроено, оставь поле пустым. После входа сможешь добавить его в безопасности."
    val asksRecovery = mode == Mode.REGISTER_RECOVERY || mode == Mode.RECOVER
    show(recoveryEntry, asksRecovery)
    show(recoveryHelp, asksRecovery)
    show(recoveryExtra, asksRecovery)
    recoveryExtra.text = if (mode == Mode.REGISTER_RECOVERY) "Запомни оба слова и храни их отдельно. В приложении их нельзя будет посмотреть повторно."
      else "Всего 3 неверные попытки, затем восстановление блокируется на 24 часа. Вход с паролем и словом подтверждения остаётся доступен."
    show(waitingBox, mode == Mode.WAITING && grant != null)
    clockOwner.text = "Запрос для логина $login"
    show(manualNote, mode != Mode.WAITING)
    notice.words = noticeText
    failure.words = errorText

    show(forgot, isLogin)
    forgot.isEnabled = !busy
    show(back, !(mode == Mode.LOGIN_NAME || mode == Mode.REGISTER_NAME))
    back.isEnabled = !busy
    val leavesRecovery = mode == Mode.RECOVER || mode == Mode.WAITING || mode == Mode.RESET
    back.text = if (leavesRecovery) "‹ Вернуться ко входу" else "‹ Назад"
    for (entry in listOf(nameEntry, displayEntry, handleEntry, passwordEntry, confirmationEntry)) entry.isEnabled = !busy
    // The key of the keyboard: «далее» from the login to the recovery word, «готово» everywhere else.
    nameEntry.field.imeOptions = (if (mode == Mode.RECOVER) EditorInfo.IME_ACTION_NEXT else EditorInfo.IME_ACTION_GO) or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING

    if (changed) {
      passwordEntry.set(if (mode == Mode.RESET) "Новый пароль" else "Пароль", if (mode == Mode.LOGIN_PASSWORD) "Твой пароль" else "От 10 символов — можно фразу")
      // A secret being created is typed once, so it is shown while typed; the one being entered is hidden.
      setShown(passwordEntry, mode != Mode.LOGIN_PASSWORD)
      setShown(confirmationEntry, mode == Mode.REGISTER_CONFIRMATION)
      setShown(recoveryEntry, mode == Mode.REGISTER_RECOVERY)
    }
    renderTime()
    if (changed) {
      focus()
      // A screen reader says where the person is now, and what went wrong if something did.
      announceForAccessibility(if (errorText.isEmpty()) heading.text else "$errorText ${heading.text}")
    } else {
      if (freed) focus()
      if (errorText.isNotEmpty()) announceForAccessibility(errorText)
    }
    if (!busy) releaseHold()
  }

  private fun setShown(entry: AuthEntry, shown: Boolean) {
    entry.shownWhenEmpty = shown
    if (entry.value.isEmpty()) entry.reveal(shown)
  }

  /** The parts that change as time passes: the countdowns and what they close. */
  private fun renderTime() {
    val busy = pending || entered
    val held = grant
    if (held != null && mode == Mode.WAITING) {
      val left = AuthRules.countdown(held.readyMs, nowMs + serverOffset)
      if (clock.text.toString() != left) clock.text = left
    }
    if (held != null && mode == Mode.RESET) {
      val left = AuthRules.countdown(held.expiresMs, nowMs + serverOffset)
      val words = "Подтверждение действительно ещё $left."
      if (resetValidity.text.toString() != words) resetValidity.text = words
      show(resetValidity, true)
    } else {
      show(resetValidity, false)
    }

    var recoveryClosed = false
    var attempts = ""
    var lockWords = ""
    if (mode == Mode.RECOVER) {
      val until = recoveryLockedUntil
      val known = feedback
      if (until > 0) {
        recoveryClosed = true
        val left = AuthRules.countdown(until.toDouble(), elapsed.toDouble())
        lockWords = "Восстановление временно заблокировано. Повторная попытка через $left. Ограничение действует на сервере."
      } else if (known != null && known.username == login && known.remaining != null && known.remaining > 0) {
        attempts = "По ответу сервера осталось попыток: ${known.remaining} из 3."
      }
    }
    if (recoveryLock.words != lockWords) recoveryLock.words = lockWords
    if (attemptsNote.text.toString() != attempts) attemptsNote.text = attempts
    show(attemptsNote, attempts.isNotEmpty())
    recoveryEntry.isEnabled = !busy && !recoveryClosed

    val closed = loginLocked
    val lockText = if (closed) "Вход временно закрыт. Попробуй через $loginLockText." else ""
    if (loginLock.words != lockText) loginLock.words = lockText

    var words = buttonWords(mode)
    if (closed) words = "Подожди $loginLockText" else if (entered) words = "Готово"
    proceed.label = words
    proceed.loading = !entered && (pending || (checking && mode == Mode.WAITING))
    proceed.done = entered
    proceed.isEnabled = !(recoveryClosed || closed)
  }

  /** The keyboard goes to the first field of the step; the waiting period has none. */
  private fun focus() {
    if (!isAttachedToWindow || pending || entered) return
    for (entry in listOf(nameEntry, displayEntry, passwordEntry, confirmationEntry, recoveryEntry)) {
      if (wanted(entry) && entry.isEnabled) {
        entry.field.requestFocus()
        entry.field.post { if (entry.field.isFocused) keyboard()?.showSoftInput(entry.field, InputMethodManager.SHOW_IMPLICIT) }
        return
      }
    }
    findFocus()?.clearFocus()
    keyboard()?.hideSoftInputFromWindow(windowToken, 0)
  }

  /** The emulator check: the keyboard goes to the `place`-th field of the step (1 — the first). */
  private fun focusField(place: Int) {
    if (!isAttachedToWindow || pending || entered) return
    val fields = listOf(nameEntry, displayEntry, handleEntry, passwordEntry, confirmationEntry, recoveryEntry).filter { wanted(it) && it.isEnabled }
    val entry = fields.getOrNull(place - 1) ?: return
    entry.field.requestFocus()
    if (Build.VERSION.SDK_INT >= 30) entry.field.windowInsetsController?.show(WindowInsets.Type.ime())
    else keyboard()?.showSoftInput(entry.field, InputMethodManager.SHOW_IMPLICIT)
  }

  private fun tick() {
    val held = grant
    if (mode == Mode.RESET && !pending && !sample && held != null && held.expiresMs <= nowMs + serverOffset) {
      clearSecrets()
      grant = null
      mode = Mode.RECOVER
      errorText = "Время для смены пароля закончилось. Начни восстановление заново."
      RecoveryStore.clear(context, server.base, held.resetToken)
      render()
      return
    }
    // The server is asked every ten seconds whether the waiting period is over.
    if (mode == Mode.WAITING && elapsed - lastStatusCheck >= 10_000) checkRecovery()
    renderTime()
  }

  // Steps

  private fun current(id: Int): Boolean = generation == id

  private fun clearSecrets() {
    passwordEntry.value = ""
    confirmationEntry.value = ""
    recoveryEntry.value = ""
  }

  /** Starts a request to the server; null when one is already under way. */
  private fun begin(): Int? {
    if (pending || entered) return null
    pending = true
    // The field is closed for the time of the request and the keyboard may leave: the arrangement stays.
    held = compactGoal >= 1f
    errorText = ""
    noticeText = ""
    generation += 1
    render()
    return generation
  }

  private fun fail(words: String) {
    errorText = words
    proceed.signalError() // Effects: «Ошибка» with a shake for 1.4 s
    render()
  }

  private fun go(to: Mode) {
    errorText = ""
    noticeText = ""
    mode = to
    render()
  }

  private fun usernameCheck(): Boolean {
    if (AuthRules.validName(nameEntry.value)) return true
    fail(AuthRules.nameError)
    return false
  }

  private fun switched(register: Boolean) {
    if (pending || entered || register == isRegister) return render()
    generation += 1
    clearSecrets()
    nameEntry.value = ""
    go(if (register) Mode.REGISTER_NAME else Mode.LOGIN_NAME)
  }

  private fun forgotPassword() {
    if (pending || entered) return
    generation += 1
    clearSecrets()
    go(Mode.RECOVER)
  }

  private fun goBack() {
    if (pending || entered) return
    if (mode == Mode.WAITING || mode == Mode.RESET) return leaveRecovery()
    generation += 1
    errorText = ""
    noticeText = ""
    when (mode) {
      Mode.LOGIN_WORD -> { confirmationEntry.value = ""; passwordEntry.value = ""; mode = Mode.LOGIN_PASSWORD }
      Mode.LOGIN_PASSWORD -> { clearSecrets(); mode = Mode.LOGIN_NAME }
      Mode.REGISTER_RECOVERY -> { recoveryEntry.value = ""; mode = Mode.REGISTER_CONFIRMATION }
      Mode.REGISTER_CONFIRMATION -> { confirmationEntry.value = ""; mode = Mode.REGISTER_PASSWORD }
      Mode.REGISTER_PASSWORD -> { clearSecrets(); mode = Mode.REGISTER_PROFILE }
      Mode.REGISTER_PROFILE -> mode = Mode.REGISTER_NAME
      else -> { clearSecrets(); nameEntry.value = ""; mode = Mode.LOGIN_NAME }
    }
    render()
  }

  private fun submit() {
    if (pending || entered) return
    if (isRegister) return registerNext()
    when (mode) {
      Mode.LOGIN_NAME -> { if (loginLocked) return; if (usernameCheck()) go(Mode.LOGIN_PASSWORD) }
      Mode.LOGIN_PASSWORD -> if (AuthRules.passwordEntered(passwordEntry.value)) go(Mode.LOGIN_WORD) else fail(AuthRules.passwordEntryError)
      Mode.LOGIN_WORD -> signIn()
      Mode.RECOVER -> verifyRecovery()
      Mode.WAITING -> checkRecovery()
      Mode.RESET -> resetPassword()
      else -> {}
    }
  }

  // Signing in and creating an account

  /** The session of an answer nobody waits for any more is closed on the server at once. */
  private fun discard(result: Result<Any?>) {
    val token = Core.map(result.getOrNull())?.get("token") as? String
    if (!token.isNullOrEmpty()) endSession(token)
  }

  /** Takes the session of a sign-in answer; false when the answer is not one. */
  private fun accept(answer: Any?): Boolean {
    val session = Core.map(answer) ?: return false
    val token = (session["token"] as? String)?.takeIf { it.isNotEmpty() } ?: return false
    val user = Core.map(session["user"]) ?: return false
    clearSecrets()
    // The button shows «Готово» for a moment before the chats open.
    entered = true
    pending = false
    findFocus()?.clearFocus()
    keyboard()?.hideSoftInputFromWindow(windowToken, 0)
    render()
    main.postDelayed({ if (entered) onSignedIn?.invoke(token, user) else endSession(token) }, 550)
    return true
  }

  private fun signIn() {
    if (!usernameCheck()) return
    if (!AuthRules.passwordEntered(passwordEntry.value)) return fail(AuthRules.passwordEntryError)
    // An empty word is sent as it is: only the server decides whether an older account may enter without one.
    val args = listOf<Any?>(login, passwordEntry.value, AuthRules.word(confirmationEntry.value))
    val id = begin() ?: return
    ask("login", args) { result ->
      main.post {
        if (!current(id)) return@post discard(result)
        if (result.isSuccess) {
          if (accept(result.getOrNull())) return@post
          clearSecrets()
          mode = Mode.LOGIN_NAME
          errorText = "Не удалось выполнить запрос. Попробуй ещё раз."
        } else {
          val error = Server.error(result)
          if (error is ServerError.Refused && (error.code == "LOGIN_FAILED" || error.code == "LOGIN_LOCKED" || error.status == 401)) {
            // Wrong login, password or word: back to the first step (which of the three was wrong is never
            // told), with how many tries are left; after five the server closes the entrance.
            clearSecrets()
            mode = Mode.LOGIN_NAME
            val wait = (error.details["retryAfterSeconds"] as? Number)?.toDouble() ?: 0.0
            val left = wholeNumber(error.details["attemptsLeft"])
            if (error.code == "LOGIN_LOCKED" && wait > 0) {
              loginLockUntil = elapsed + (wait * 1000).toLong()
              errorText = "Слишком много неверных попыток. Вход снова откроется через 5 минут."
            } else if (left != null) {
              errorText = "Неверный логин, пароль или слово подтверждения. Осталось попыток: $left."
            } else {
              errorText = error.words
            }
          } else {
            confirmationEntry.value = ""
            errorText = error.words
          }
        }
        pending = false
        render()
      }
    }
  }

  private fun registerNext() {
    when (mode) {
      Mode.REGISTER_NAME -> { if (usernameCheck()) go(Mode.REGISTER_PROFILE); return }
      Mode.REGISTER_PROFILE -> {
        val shownName = displayEntry.value.trim()
        val publicName = AuthRules.handle(handleEntry.value)
        if (shownName.isEmpty() || shownName.codePointCount(0, shownName.length) > 50) fail("Имя: от 1 до 50 символов.")
        else if (!AuthRules.validName(publicName)) fail("@юзернейм: 3–24 символа — латинские буквы, цифры и знак _.")
        else if (publicName == login) fail("@юзернейм должен отличаться от логина: логин никто не должен видеть.")
        else go(Mode.REGISTER_PASSWORD)
        return
      }
      Mode.REGISTER_PASSWORD -> {
        val invalid = AuthRules.newPasswordError(passwordEntry.value)
        if (invalid.isEmpty()) go(Mode.REGISTER_CONFIRMATION) else fail(invalid)
        return
      }
      Mode.REGISTER_CONFIRMATION -> {
        val invalid = AuthRules.wordError(confirmationEntry.value, password = passwordEntry.value, login = login)
        if (invalid.isEmpty()) go(Mode.REGISTER_RECOVERY) else fail(invalid)
        return
      }
      else -> {}
    }
    val invalid = AuthRules.wordError(recoveryEntry.value, password = passwordEntry.value, login = login, otherWord = confirmationEntry.value)
    if (invalid.isNotEmpty()) return fail(invalid)
    val args = listOf<Any?>(login, passwordEntry.value, displayEntry.value.trim(), AuthRules.word(confirmationEntry.value), AuthRules.word(recoveryEntry.value), AuthRules.handle(handleEntry.value))
    val id = begin() ?: return
    ask("register", args) { result ->
      main.post {
        if (!current(id)) return@post discard(result)
        if (result.isSuccess) {
          if (accept(result.getOrNull())) return@post
          errorText = "Не удалось создать аккаунт."
        } else {
          val message = Server.error(result).words
          // A taken @username is fixed on the profile step, not by typing every secret again; a taken login —
          // on the first step, with the password and the words kept. There is no early «is it free» question
          // on purpose: the login is secret and must not be probed.
          if (message.contains("@юзернейм")) mode = Mode.REGISTER_PROFILE
          else if (message.contains("логин уже занят")) mode = Mode.REGISTER_NAME
          errorText = message
        }
        pending = false
        render()
      }
    }
  }

  // A forgotten password

  private fun verifyRecovery() {
    if (recoveryLockedUntil > 0) return
    if (!usernameCheck()) return
    val invalid = AuthRules.wordError(recoveryEntry.value)
    if (invalid.isNotEmpty()) return fail(invalid)
    val name = login
    val args = listOf<Any?>(name, AuthRules.word(recoveryEntry.value))
    val id = begin() ?: return
    ask("verifyRecovery", args) { result ->
      main.post {
        if (!current(id)) return@post
        pending = false
        if (result.isSuccess) {
          val made = RecoveryGrant.from(result.getOrNull())
          if (made != null) {
            clearSecrets()
            grant = made
            serverOffset = made.serverMs - nowMs
            feedback = null
            try {
              RecoveryStore.save(context, server.base, name, made)
            } catch (_: Exception) {
              noticeText = "Не удалось сохранить запрос на устройстве. Оставь этот экран открытым до окончания ожидания."
            }
            mode = Mode.WAITING
          } else {
            recoveryEntry.value = ""
            errorText = "Сервер вернул некорректное подтверждение. Попробуй ещё раз."
          }
        } else {
          val error = Server.error(result)
          recoveryEntry.value = ""
          errorText = error.words
          if (error is ServerError.Refused) {
            val remaining = (error.details["attemptsRemaining"] as? Number)?.toInt()?.coerceIn(0, 3)
            val seconds = (error.details["retryAfterSeconds"] as? Number)?.toDouble()?.coerceAtLeast(0.0)
            if (remaining != null || seconds != null) {
              val until = if (seconds != null && seconds > 0) elapsed + (seconds * 1000).toLong() else 0L
              feedback = RecoveryFeedback(name, remaining, until)
            }
          }
        }
        render()
        if (mode == Mode.WAITING) checkRecovery()
      }
    }
  }

  /** Asks the server whether the waiting period is over. */
  private fun checkRecovery() {
    val held = grant ?: return
    if (statusPending || pending || entered || mode != Mode.WAITING || sample) return
    val life = generation
    statusGeneration += 1
    val asked = statusGeneration
    statusPending = true
    checking = true
    lastStatusCheck = elapsed
    renderTime()
    ask("recoveryStatus", listOf(held.resetToken)) { result ->
      main.post {
        if (asked == statusGeneration) {
          statusPending = false
          checking = false
        }
        if (!current(life) || grant?.resetToken != held.resetToken || mode != Mode.WAITING) return@post renderTime()
        if (result.isSuccess) {
          val status = Core.map(result.getOrNull())
          val state = status?.get("status") as? String
          val updated = if (status != null && status["requestId"] as? String == held.requestId && (state == "ready" || state == "waiting")) {
            held.updated(status["readyAt"] as? String ?: "", status["expiresAt"] as? String ?: "", status["serverTime"] as? String ?: "")
          } else null
          if (updated != null) {
            grant = updated
            serverOffset = updated.serverMs - nowMs
            errorText = ""
            if (state == "ready") {
              noticeText = "Сервер разрешил сменить пароль. Оба секретных слова останутся прежними."
              mode = Mode.RESET
            }
          } else {
            errorText = "Не удалось проверить состояние запроса."
          }
        } else {
          val error = Server.error(result)
          if (error is ServerError.Refused && (error.status == 401 || error.status == 410)) {
            RecoveryStore.clear(context, server.base, held.resetToken)
            clearSecrets()
            grant = null
            mode = Mode.RECOVER
            noticeText = "Запрос отменён, уже использован или его срок закончился. Можно начать восстановление заново."
            errorText = ""
          } else {
            errorText = error.words
          }
        }
        render()
      }
    }
  }

  private fun resetPassword() {
    val held = grant
    if (held == null) {
      clearSecrets()
      return go(Mode.RECOVER)
    }
    val invalid = AuthRules.newPasswordError(passwordEntry.value)
    if (invalid.isNotEmpty()) return fail(invalid)
    if (sample) return
    val args = listOf<Any?>(held.resetToken, passwordEntry.value)
    val id = begin() ?: return
    val app = context.applicationContext
    ask("resetPassword", args) { result ->
      main.post {
        // The request is used up whoever is still looking: it is not kept any longer.
        if (result.isSuccess) RecoveryStore.clear(app, server.base, held.resetToken)
        if (!current(id)) return@post
        pending = false
        if (result.isSuccess) {
          clearSecrets()
          grant = null
          feedback = null
          nameEntry.value = ""
          mode = Mode.LOGIN_NAME
          noticeText = "Пароль изменён. Все устройства вышли из аккаунта. Войди с новым паролем и прежним словом подтверждения."
        } else {
          val error = Server.error(result)
          if (error is ServerError.Refused) {
            if (error.code == "RECOVERY_WAIT") {
              clearSecrets()
              mode = Mode.WAITING
            }
            if (error.status == 401 || error.status == 410) {
              RecoveryStore.clear(app, server.base, held.resetToken)
              clearSecrets()
              grant = null
              mode = Mode.RECOVER
            }
          }
          errorText = error.words
        }
        render()
        if (mode == Mode.WAITING) checkRecovery()
      }
    }
  }

  /** Back to signing in: the request is removed from this device and cannot be continued here. */
  private fun leaveRecovery() {
    if (pending || entered) return
    if (!sample) RecoveryStore.clear(context, server.base, grant?.resetToken)
    sample = false
    generation += 1
    statusGeneration += 1
    statusPending = false
    checking = false
    clearSecrets()
    grant = null
    nameEntry.value = ""
    go(Mode.LOGIN_NAME)
  }

  /** The keyboard's own motion, frame by frame (Android 11 and later): the screen moves with it, once. */
  @TargetApi(30)
  private object KeyboardMotion {
    fun follow(screen: AuthScreen) {
      screen.setWindowInsetsAnimationCallback(object : WindowInsetsAnimation.Callback(DISPATCH_MODE_STOP) {
        private var moving: WindowInsetsAnimation? = null

        override fun onPrepare(animation: WindowInsetsAnimation) {
          if (animation.typeMask and WindowInsets.Type.ime() == 0) return
          moving = animation
          screen.keyboardStarts()
        }

        override fun onStart(animation: WindowInsetsAnimation, bounds: WindowInsetsAnimation.Bounds): WindowInsetsAnimation.Bounds {
          if (animation === moving) screen.keyboardAims()
          return bounds
        }

        override fun onProgress(insets: WindowInsets, running: MutableList<WindowInsetsAnimation>): WindowInsets {
          val animation = moving
          if (animation != null && running.contains(animation)) screen.keyboardMoves(animation.interpolatedFraction)
          return insets
        }

        override fun onEnd(animation: WindowInsetsAnimation) {
          if (animation !== moving) return
          moving = null
          screen.keyboardStops()
        }
      })
    }
  }

  companion object {
    private val loginSteps = listOf(Mode.LOGIN_NAME, Mode.LOGIN_PASSWORD, Mode.LOGIN_WORD)
    private val registerSteps = listOf(Mode.REGISTER_NAME, Mode.REGISTER_PROFILE, Mode.REGISTER_PASSWORD, Mode.REGISTER_CONFIRMATION, Mode.REGISTER_RECOVERY)
    private const val WORD_HELP = "От 4 до 64 русских или английских букв, без пробелов. Регистр не важен; «е» и «ё» различаются."

    /** 3–24 characters: Latin letters, digits and `_`. */
    fun validLogin(login: String): Boolean = Regex("^[A-Za-z0-9_]{3,24}$").matches(login)

    /** Not empty and at most 128 characters, counted as a person sees them (an emoji is one). */
    fun validPassword(password: String): Boolean = password.isNotEmpty() && characters(password) <= 128

    private fun characters(text: String): Int {
      val breaks = java.text.BreakIterator.getCharacterInstance(Locale.ROOT)
      breaks.setText(text)
      var count = 0
      while (breaks.next() != java.text.BreakIterator.DONE) count += 1
      return count
    }

    /** The word as the server compares it: without the spaces around it, composed (NFC), in small letters. */
    fun confirmationWord(typed: String): String = Normalizer.normalize(typed.trim(), Normalizer.Form.NFC).lowercase(Locale.ROOT)

    /** A JSON number that is a whole one. */
    fun wholeNumber(value: Any?): Long? = (value as? Number)?.toDouble()?.takeIf { it == Math.rint(it) && Math.abs(it) < 1e15 }?.toLong()
  }
}
