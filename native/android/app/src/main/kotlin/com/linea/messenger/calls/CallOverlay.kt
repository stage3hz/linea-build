package com.linea.messenger.calls

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.ReplacementSpan
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.widget.PopupMenu
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.shell.Screen
import java.lang.ref.WeakReference

/** The active-call bar while the call is minimised (the reference's `CallBanner`): a full-width strip right under
 *  the status bar — the name and the status in the middle, a tap opens the call, the round button on the right ends
 *  it. Green while the call is up, orange while it reconnects or waits, blue before it connects. */
class CallBarView(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private var iconName = "call"
  private val icon = object : View(context) {
    override fun onDraw(canvas: Canvas) = IonIcon.draw(canvas, iconName, width / 2f, height / 2f, 14f * d, 0xFFFFFFFF.toInt())
  }
  private val name: TextView = context.words("", 14f, 0xFFFFFFFF.toInt(), 600)
  private val dot: TextView = context.words("·", 14f, 0xFFFFFFFF.toInt())
  private val status: TextView = context.words("", 14f, 0xFFFFFFFF.toInt())
  private val clock: TextView = context.words("", 14f, 0xFFFFFFFF.toInt())
  private val end = object : View(context) {
    override fun onDraw(canvas: Canvas) = IonIcon.draw(canvas, "close", width / 2f, height / 2f, 15f * d, 0xFFFFFFFF.toInt())
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  }

  init {
    addView(icon)
    for (label in listOf(name, dot, status, clock)) {
      label.maxLines = 1
      label.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
      if (android.os.Build.VERSION.SDK_INT >= 28) label.lineHeight = Math.round(18f * d)
      addView(label)
    }
    name.ellipsize = TextUtils.TruncateAt.END
    dot.alpha = 0.85f
    clock.alpha = 0.85f
    end.background = context.plate(0xFFFF3B30.toInt(), 13f)
    end.contentDescription = "Завершить звонок"
    end.isClickable = true
    end.setOnClickListener { Calls.hangup() }
    addView(end)
    isClickable = true
    setOnClickListener { Calls.restore() }
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    alpha = if (isPressed) 0.85f else 1f
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    // paddingHorizontal 46; one centred line, gap 6; only the name gives way when it is too long.
    val room = maxOf(0, width - Math.round(92f * d))
    val gap = Math.round(6f * d); val side = Math.round(14f * d)
    val free = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    val fixed = listOf(dot, status, clock).filter { it.visibility != GONE }
    fixed.forEach { it.measure(free, free) }
    val fixedWidth = side + fixed.sumOf { it.measuredWidth + gap }
    name.measure(MeasureSpec.makeMeasureSpec(maxOf(0, room - fixedWidth - gap), MeasureSpec.AT_MOST), free)
    val total = fixedWidth + gap + name.measuredWidth
    var x = (width - minOf(room, total)) / 2
    icon.measure(MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY))
    icon.layout(x, (height - side) / 2, x + side, (height + side) / 2)
    x += side + gap
    for (label in listOf(name) + fixed) {
      val h = label.measuredHeight
      label.layout(x, (height - h) / 2, x + label.measuredWidth, (height + h) / 2)
      x += label.measuredWidth + gap
    }
    val button = Math.round(26f * d)
    end.measure(MeasureSpec.makeMeasureSpec(button, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(button, MeasureSpec.EXACTLY))
    end.layout(width - Math.round(8f * d) - button, (height - button) / 2, width - Math.round(8f * d), (height + button) / 2)
  }

  fun show(call: CallState) {
    val words = CallRules.status(call, Calls.signalNetwork)
    val color = CallRules.barColor(words.tone)
    if (color != shownColor) {
      shownColor = color
      setBackgroundColor(color)
    }
    iconName = if (call.video) "videocam" else "call"
    icon.invalidate()
    name.text = call.peer.displayName
    status.text = words.text
    clock.text = words.clock ?: ""
    clock.visibility = if (words.clock == null) GONE else VISIBLE
    contentDescription = barWords(call.peer.displayName, words) + ". Вернуться к звонку"
    end.visibility = if (call.isOver) GONE else VISIBLE
    requestLayout()
  }

  private var shownColor = 0

  companion object {
    /** No space between the bar and the status bar, nor at its sides (CallBarFrame), dp. */
    const val GAP = 0f
    /** What the app's pages give up at the top while the bar is shown, dp: the bar's height. */
    val room: Float get() = CallRules.barHeight

    /** What the bar says, read aloud: the name, the status and the clock. */
    fun barWords(name: String, status: CallRules.Status): String = name + ", " + status.text + (status.clock?.let { " $it" } ?: "")
  }
}

/** What calls are shown in, above the app's own pages: the call screen, or — while the call is minimised — its
 *  bar. A touch that lands on neither goes through to the app underneath. */
@SuppressLint("ViewConstructor")
class CallHost(context: Context) : Screen(context) {
  val bar = CallBarView(context)
  /** Above the bar, under the status bar: the page's colour, so the status bar keeps its usual look (CallBarFrame). */
  private val strip = View(context)
  var callScreen: CallScreenView? = null

  init {
    strip.visibility = GONE
    addView(strip)
    bar.visibility = GONE
    addView(bar)
  }

  override fun place(width: Int, height: Int) {
    // Right under the status bar: the clock and the battery stay visible above it.
    val gap = dp(CallBarView.GAP)
    put(bar, gap, edges.top + gap, maxOf(0, width - gap * 2), dp(CallRules.barHeight))
    strip.visibility = bar.visibility
    strip.setBackgroundColor(Theme.bg)
    put(strip, 0, 0, width, edges.top)
    callScreen?.let { put(it, 0, 0, width, height) }
  }
}

/** Puts the call on the screen and takes it off: the call screen while it is open, the bar while it is minimised
 *  (every page of the app then moves down by the bar's height, so nothing hides under it), nothing when there is
 *  no call. Main thread. */
object CallOverlay {
  private var window = WeakReference<Activity>(null)
  private var host: CallHost? = null
  private var watching = false
  private val clock = object : Runnable {
    override fun run() {
      val now = Calls.call
      val shown = host
      if (now == null || !now.minimized || shown == null) { clockRuns = false; return }
      shown.bar.show(now)
      shown.postDelayed(this, 1000)
    }
  }
  private var clockRuns = false

  /** The account whose calls are shown (null: the debug build's shell without one), and the window they are shown in. */
  fun start(context: Context, messenger: Messenger?) {
    val activity = context as? Activity
    if (activity != null && window.get() !== activity) {
      // Another window: what was shown in the old one is gone with it.
      host = null
      clockRuns = false
      window = WeakReference(activity)
    }
    if (!watching) {
      watching = true
      Calls.changed.watch { refresh() }
    }
    Calls.start(activity, messenger)
  }

  private fun makeHost(): CallHost? {
    host?.let { return it }
    val activity = window.get() ?: return null
    if (activity.isFinishing || activity.isDestroyed) return null
    val made = CallHost(activity)
    activity.addContentView(made, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    host = made
    return made
  }

  /** The app's pages start lower while the bar is shown. */
  private fun setBarRoom(on: Boolean) {
    val activity = window.get() ?: return
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    val room = if (on) Math.round(CallBarView.room * activity.resources.displayMetrics.density) else 0
    for (index in 0 until content.childCount) {
      val page = content.getChildAt(index)
      if (page is CallHost) continue
      val place = page.layoutParams as? ViewGroup.MarginLayoutParams ?: continue
      if (place.topMargin == room) continue
      place.topMargin = room
      page.layoutParams = place
    }
  }

  private fun refresh() {
    val call = Calls.call
    if (call == null) {
      setBarRoom(false)
      host?.bar?.visibility = View.GONE
      dismissScreen {
        // Nothing left to show: the host goes, so it is in nobody's way.
        if (Calls.call == null) host?.let { gone -> (gone.parent as? ViewGroup)?.removeView(gone); host = null }
      }
      return
    }
    val shown = makeHost() ?: return
    if (call.minimized) {
      dismissScreen(null)
      shown.bar.show(call)
      shown.bar.visibility = View.VISIBLE
      setBarRoom(true)
      // The bar's clock and status follow the call by themselves.
      if (!clockRuns) { clockRuns = true; shown.postDelayed(clock, 1000) }
      return
    }
    shown.bar.visibility = View.GONE
    setBarRoom(false)
    presentScreen(shown).update(call)
  }

  private fun presentScreen(shown: CallHost): CallScreenView {
    shown.callScreen?.let { return it }
    val screen = CallScreenView(shown.context)
    shown.callScreen = screen
    shown.addView(screen)
    // Slides up from the bottom, as the reference's call screen does.
    if (shown.height > 0) {
      screen.translationY = shown.height.toFloat()
      screen.animate().translationY(0f).setDuration(300).setInterpolator(DecelerateInterpolator()).start()
    }
    return screen
  }

  private fun dismissScreen(done: (() -> Unit)?) {
    val shown = host
    val screen = shown?.callScreen
    if (shown == null || screen == null) { done?.invoke(); return }
    shown.callScreen = null
    screen.animate().cancel()
    val gone = Runnable {
      screen.retire()
      shown.removeView(screen)
      done?.invoke()
    }
    if (shown.height <= 0 || !shown.isAttachedToWindow) return gone.run()
    screen.animate().translationY(shown.height.toFloat()).setDuration(250).setInterpolator(AccelerateInterpolator()).withEndAction(gone).start()
  }
}

/** Where a call is placed from: the chat's header and a person's profile. */
object CallEntry {
  /** «Позвонить» (`video`: «Видеозвонок») to the person of a chat. Without an account — the debug build's sample. */
  fun call(messenger: Messenger?, chatId: String, peerId: String, name: String, person: Person? = null, video: Boolean) {
    if (messenger == null) return CallsDemo.show("outgoing")
    val peer = person ?: Person(peerId, "", name, "", "", 0x5E7BFF, "")
    Calls.place(chatId, peer, video)
  }

  /** The button of a chat's header: a touch rings the person, a long touch offers «Позвонить» and «Видеозвонок»
   *  (the reference keeps the second one in the header's menu). */
  fun headerButton(context: Context, messenger: Messenger?, chatId: String, peerId: String, name: String): View {
    val d = context.resources.displayMetrics.density
    val button = object : View(context) {
      override fun onDraw(canvas: Canvas) = CallIcons.draw(canvas, "phone", width / 2f, height / 2f, 22f * d, if (isPressed) Theme.alpha(Theme.muted, 0.5f) else Theme.muted)
      override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
      override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    }
    button.isClickable = true
    button.isFocusable = true
    button.contentDescription = "Позвонить"
    button.setOnClickListener { call(messenger, chatId, peerId, name, video = false) }
    button.setOnLongClickListener {
      val menu = PopupMenu(context, button)
      menu.menu.add("Позвонить").setOnMenuItemClickListener { call(messenger, chatId, peerId, name, video = false); true }
      menu.menu.add("Видеозвонок").setOnMenuItemClickListener { call(messenger, chatId, peerId, name, video = true); true }
      menu.show()
      true
    }
    return button
  }
}
