package com.linea.messenger.shell

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import android.view.inputmethod.InputMethodManager
import android.widget.AbsListView
import android.widget.CompoundButton
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.SeekBar
import com.linea.messenger.chatsplus.PlusIconView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.words

/** A pushed page whose own sideways drags must not be taken by the swipe back (a cropper, a drawing). */
interface StackSwipeBlocking { val blocksSwipeBack: Boolean }

/** The stack of pages (the reference's stack.tsx, native/ios/Sources/Shell/NavigationController.swift): no bar on top
 *  (every page draws its own header).
 *  - A pushed page slides in over the one below, which moves 28 % of the width to the left and dims to .38 (220 ms in,
 *    240 ms out, the reference's curves), with a soft shadow at the top page's left edge.
 *  - A swipe to the right ANYWHERE on a pushed page drags it away (it takes over once the finger has moved right and
 *    mostly sideways, 2:1); released past a third of the width or flicked faster than 700 dp/s, it leaves.
 *  - Held past a third for 600 ms, «Отпусти — в чаты» appears: letting go then goes straight to «Чаты».
 *  - In a section of the bar other than «Чаты», with nothing pushed, a swipe from the left edge (32 dp) goes to
 *    «Чаты», a round mark coming out under the finger (the reference's `HomeSwipe`).
 *  - The system's Back gesture drives `backProgress` while the finger is still on the screen, so the page follows it. */
class Navigation(context: Context) : FrameLayout(context) {
  /** How many pages are in the stack now (1 = only the root). */
  var onDepthChange: (depth: Int) -> Unit = {}
  val depth: Int get() = stack.size
  /** The page on top of the stack; null before the first one. */
  val top: View? get() = stack.lastOrNull()

  private val stack = ArrayList<View>()
  private val d = resources.displayMetrics.density
  private val openCurve = PathInterpolator(0.2f, 0.9f, 0.25f, 1f)
  private val closeCurve = PathInterpolator(0.3f, 0.1f, 0.3f, 1f)
  private val dim = Paint()
  private val shade = Paint()
  /** 0 = the top page fully open, 1 = gone (the reference's `progress`); drives the page under it too. */
  private var progress = 0f
  private var running: ValueAnimator? = null
  private val homeWords = HomePill(context, words = true)
  private val homeMark = HomePill(context, words = false)
  private val main = Handler(Looper.getMainLooper())

  init {
    setBackgroundColor(Theme.bg)
    setWillNotDraw(false)
    for (pill in listOf(homeWords, homeMark)) { pill.alpha = 0f; addView(pill, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)) }
  }

  private val root: RootScreen? get() = stack.firstOrNull() as? RootScreen

  private val motionOff: Boolean
    get() = try { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f } catch (_: Exception) { false }

  fun setRoot(page: View) {
    running?.cancel()
    for (view in stack) removeView(view)
    stack.clear()
    addView(page, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    stack.add(page)
    page.translationX = 0f
    page.visibility = View.VISIBLE
    onDepthChange(stack.size)
  }

  fun push(page: View, animated: Boolean = true) {
    running?.cancel()
    settle()
    addView(page, indexOfChild(homeWords), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    stack.add(page)
    onDepthChange(stack.size)
    if (!animated || width == 0 || motionOff) { progress = 0f; apply(); cover(); return }
    progress = 1f
    apply()
    animate(1f, 0f, OPEN_MS, openCurve) { cover() }
  }

  /** Takes the top page away. Nothing happens when only the root is left. */
  fun pop(animated: Boolean = true) {
    if (stack.size <= 1) return
    running?.cancel()
    keyboardAway()
    val page = stack.last()
    stack[stack.size - 2].visibility = View.VISIBLE
    if (!animated || width == 0 || motionOff) { remove(page); return }
    animate(progress, 1f, (CLOSE_MS * (1f - progress).coerceIn(0.3f, 1f)).toLong(), closeCurve) { remove(page) }
  }

  /** The whole stack goes and «Чаты» comes, with a short fade. */
  fun goHome() {
    running?.cancel()
    keyboardAway()
    val root = root
    while (stack.size > 1) { val page = stack.removeAt(stack.size - 1); removeView(page) }
    progress = 0f
    stack.firstOrNull()?.let { it.visibility = View.VISIBLE; it.translationX = 0f; it.alpha = 0.6f; it.animate().alpha(1f).setDuration(200).start() }
    onDepthChange(stack.size)
    root?.show("chats")
    invalidate()
  }

  private fun remove(page: View) {
    stack.remove(page)
    removeView(page)
    progress = 0f
    stack.lastOrNull()?.let { it.visibility = View.VISIBLE; it.translationX = 0f }
    onDepthChange(stack.size)
    invalidate()
  }

  /** A covered page is not drawn; it comes back when the one above starts to leave. */
  private fun cover() {
    if (stack.size < 2 || progress > 0f) return
    for (index in 0 until stack.size - 1) stack[index].visibility = View.INVISIBLE
  }

  private fun settle() {
    // A page under a finished slide stands where it belongs.
    for (index in 0 until stack.size - 1) stack[index].translationX = 0f
    stack.lastOrNull()?.translationX = 0f
  }

  private fun animate(from: Float, to: Float, millis: Long, curve: android.animation.TimeInterpolator, then: () -> Unit) {
    running?.cancel()
    running = ValueAnimator.ofFloat(from, to).apply {
      duration = maxOf(1L, millis); interpolator = curve
      addUpdateListener { progress = it.animatedValue as Float; apply() }
      addListener(object : android.animation.AnimatorListenerAdapter() {
        private var cancelled = false
        override fun onAnimationCancel(animation: android.animation.Animator) { cancelled = true }
        override fun onAnimationEnd(animation: android.animation.Animator) { if (!cancelled) then() }
      })
      start()
    }
  }

  /** The top page at `progress`, the one under it aside and dimmed. */
  private fun apply() {
    if (stack.size < 2) { invalidate(); return }
    val page = stack.last(); val under = stack[stack.size - 2]
    under.visibility = View.VISIBLE
    page.translationX = width * progress
    under.translationX = -width * UNDER_SHIFT * (1f - progress)
    invalidate()
  }

  /** The dim over the page under the top one and the shadow at the top page's edge, drawn between the two. */
  override fun drawChild(canvas: Canvas, child: View, drawingTime: Long): Boolean {
    val drawn = super.drawChild(canvas, child, drawingTime)
    if (stack.size >= 2 && child === stack[stack.size - 2] && (progress < 1f) && stack.last().visibility == View.VISIBLE) {
      val left = stack.last().translationX
      if (left > 0.5f || running != null || dragging) {
        dim.color = Theme.alpha(0xFF000000.toInt(), 0.38f * (1f - progress))
        canvas.drawRect(0f, 0f, left, height.toFloat(), dim)
        val edge = 18f * d
        shade.shader = LinearGradient(left - edge, 0f, left, 0f, 0x00000000, Theme.alpha(0xFF000000.toInt(), 0.35f * (1f - progress)), Shader.TileMode.CLAMP)
        canvas.drawRect(left - edge, 0f, left, height.toFloat(), shade)
      }
    }
    return drawn
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    val h = bottom - top
    homeWords.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec((44 * d).toInt(), MeasureSpec.EXACTLY))
    val y = (h * 0.46f).toInt()
    homeWords.layout((14 * d).toInt(), y, (14 * d).toInt() + homeWords.measuredWidth, y + homeWords.measuredHeight)
    homeMark.measure(MeasureSpec.makeMeasureSpec((44 * d).toInt(), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec((44 * d).toInt(), MeasureSpec.EXACTLY))
    homeMark.layout(0, y, (44 * d).toInt(), y + (44 * d).toInt())
  }

  // The system's Back gesture (BackGate)

  /** The Back gesture is under way: `progress` 0…1 of it. The top page moves aside and shows the one under it. */
  fun backProgress(value: Float) {
    if (stack.size <= 1 || width == 0) return
    running?.cancel()
    progress = value.coerceIn(0f, 1f) * BACK_REACH
    apply()
  }

  /** The Back gesture was given up: everything returns. */
  fun backCancelled() {
    if (stack.size <= 1) return
    animate(progress, 0f, 200, DecelerateInterpolator()) { cover() }
  }

  // The swipe

  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private var downX = 0f
  private var downY = 0f
  private var mode = ""
  private var dragging = false
  private var tracker: VelocityTracker? = null
  private var canHome = false
  private var farArmed = false
  private var longReady = false
  private val longTimer = Runnable { showLong(true) }

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x; downY = event.y; mode = ""; dragging = false
        tracker?.recycle(); tracker = VelocityTracker.obtain()
        tracker?.addMovement(event)
        // A touch on a page that is still sliding stops the slide where it is (and is the page's own touch).
        return false
      }
      MotionEvent.ACTION_MOVE -> {
        tracker?.addMovement(event)
        if (mode.isNotEmpty() || running != null) return mode.isNotEmpty()
        val dx = event.x - downX; val dy = Math.abs(event.y - downY)
        // Right and mostly sideways (the reference: dx > 10 and dx > 2·dy); a vertical move scrolls instead.
        if (dx <= slop || dx <= dy * 2) return false
        if (stack.size > 1) {
          val top = stack.last()
          if (top is StackSwipeBlocking && top.blocksSwipeBack) return false
          if (blocked(top, downX, downY)) return false
          begin("back")
          return true
        }
        // A section other than «Чаты» with nothing pushed: from the left edge only (it must not take sideways
        // shelves and the text cursor).
        val root = root
        if (root != null && root.open != "chats" && !root.sectionsOpen && downX <= HOME_EDGE * d) {
          begin("home")
          return true
        }
        return false
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { tracker?.recycle(); tracker = null }
    }
    return false
  }

  private fun begin(kind: String) {
    mode = kind
    dragging = true
    parent?.requestDisallowInterceptTouchEvent(true)
    if (kind == "back") {
      running?.cancel()
      canHome = root != null && (stack.size > 2 || root?.open != "chats")
      farArmed = false
      longReady = false
      stack[stack.size - 2].visibility = View.VISIBLE
    }
  }

  /** Something under the finger moves sideways itself: a slider, a switch, or a strip scrolled away from its start. */
  private fun blocked(page: View, x: Float, y: Float): Boolean {
    var found: View? = hit(page, x - page.left - page.translationX, y - page.top)
    while (found != null && found !== page) {
      if (found is SeekBar || found is CompoundButton) return true
      if (found is HorizontalScrollView && found.scrollX > 0) return true
      if (found is StackSwipeBlocking && found.blocksSwipeBack) return true
      found = found.parent as? View
    }
    return false
  }

  /** The deepest visible view under a point (in `view`'s coordinates). */
  private fun hit(view: View, x: Float, y: Float): View? {
    if (x < 0 || y < 0 || x > view.width || y > view.height || view.visibility != View.VISIBLE) return null
    if (view is ViewGroup && view !is AbsListView) {
      for (index in view.childCount - 1 downTo 0) {
        val child = view.getChildAt(index)
        hit(child, x - child.left - child.translationX + view.scrollX, y - child.top - child.translationY + view.scrollY)?.let { return it }
      }
    }
    return view
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (mode.isEmpty()) return super.onTouchEvent(event)
    tracker?.addMovement(event)
    val moved = maxOf(0f, event.x - downX)
    val widthF = maxOf(1f, width.toFloat())
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        if (mode == "home") return homeMoved(moved).let { true }
        progress = (moved / widthF).coerceIn(0f, 1f)
        apply()
        if (!canHome) return true
        val far = moved > widthF * 0.33f
        if (far && !farArmed) { farArmed = true; main.removeCallbacks(longTimer); main.postDelayed(longTimer, LONG_HOLD_MS) }
        else if (!far && farArmed) { farArmed = false; main.removeCallbacks(longTimer); showLong(false) }
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        tracker?.computeCurrentVelocity(1000)
        val speed = (tracker?.xVelocity ?: 0f) / d
        tracker?.recycle(); tracker = null
        val ended = event.actionMasked == MotionEvent.ACTION_UP
        dragging = false
        val kind = mode
        mode = ""
        if (kind == "home") { homeEnded(moved, speed, ended); return true }
        main.removeCallbacks(longTimer)
        val straightHome = longReady && ended
        showLong(false)
        farArmed = false
        if (straightHome) {
          // Straight to «Чаты»: this page is not closed one step back as well; the stack goes at once.
          goHome()
          return true
        }
        val leave = ended && (moved > widthF * 0.33f || speed > 700)
        if (leave) {
          // The keyboard leaves together with the page, as soon as leaving is decided.
          keyboardAway()
          performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          val page = stack.last()
          animate(progress, 1f, maxOf(90L, (220 * (1f - progress)).toLong()), DecelerateInterpolator()) { remove(page) }
        } else animate(progress, 0f, 200, DecelerateInterpolator()) { cover() }
        return true
      }
    }
    return true
  }

  /** «Отпусти — в чаты»: comes (140 ms, with a light knock) or goes (100 ms). */
  private fun showLong(on: Boolean) {
    if (on == longReady && (if (on) homeWords.alpha > 0.9f else homeWords.alpha < 0.1f)) return
    longReady = on
    if (on) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    homeWords.animate().cancel()
    if (on) { homeWords.scaleX = 0.9f; homeWords.scaleY = 0.9f }
    homeWords.animate().alpha(if (on) 1f else 0f).scaleX(if (on) 1f else 0.9f).scaleY(if (on) 1f else 0.9f).setDuration(if (on) 140 else 100).start()
  }

  private fun homeMoved(pull: Float) {
    val k = minOf(1f, pull / (80 * d))
    homeMark.alpha = k
    val scale = 0.7f + k * 0.3f
    homeMark.scaleX = scale; homeMark.scaleY = scale
    homeMark.translationX = -52 * d + minOf(pull, 110 * d) * 0.62f
  }

  private fun homeEnded(pull: Float, speed: Float, ended: Boolean) {
    if (ended && (pull > 80 * d || speed > 700)) {
      keyboardAway()
      performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      root?.show("chats")
    }
    homeMark.animate().alpha(0f).translationX(-52 * d).scaleX(0.7f).scaleY(0.7f).setDuration(160).setInterpolator(DecelerateInterpolator()).start()
  }

  private fun keyboardAway() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
  }

  // The emulator check

  /** «Отпусти — в чаты» or the section's round mark, held on screen. */
  fun showSwipeMarks(long: Boolean) {
    if (long) { longReady = false; showLong(true) }
    else { homeMark.alpha = 1f; homeMark.scaleX = 1f; homeMark.scaleY = 1f; homeMark.translationX = -52 * d + 110 * d * 0.62f }
  }

  /** The top page held part way off, as under a finger. */
  fun holdSwipe(fraction: Float) {
    if (stack.size < 2) return
    running?.cancel()
    dragging = true
    animate(0f, fraction, 150, LinearInterpolator()) {}
  }

  companion object {
    /** How far the page under the top one is shifted to the left, in widths. */
    private const val UNDER_SHIFT = 0.28f
    /** How far the top page has gone when the system's Back gesture is at its end, in widths. */
    private const val BACK_REACH = 0.55f
    private const val OPEN_MS = 220L
    private const val CLOSE_MS = 240L
    private const val HOME_EDGE = 32f
    private const val LONG_HOLD_MS = 600L
  }
}

/** The mark of «to the chat list» (the reference's `HomePill`): a round chat icon on the text colour, with the words
 *  «Отпусти — в чаты» when the gesture needs telling. */
private class HomePill(context: Context, words: Boolean) : LinearLayout(context) {
  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    val ink = if (Theme.dark) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
    background = android.graphics.drawable.GradientDrawable().apply { setColor(Theme.text); cornerRadius = 22f * resources.displayMetrics.density }
    val d = resources.displayMetrics.density
    if (words) setPadding((14 * d).toInt(), 0, (14 * d).toInt(), 0)
    addView(PlusIconView(context, "bubbles", 18f, ink), LayoutParams((if (words) 22 * d else 44 * d).toInt(), (44 * d).toInt()))
    if (words) addView(context.words("Отпусти — в чаты", 14f, ink, 700), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = (8 * d).toInt() })
    isClickable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }
}
