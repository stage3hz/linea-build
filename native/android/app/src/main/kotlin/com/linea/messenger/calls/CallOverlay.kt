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
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.shell.Screen
import java.lang.ref.WeakReference

/** The active-call bar while the call is minimised (the reference's `CallBanner`): a rounded strip a little below
 *  the status bar — the name and the status in the middle, a tap opens the call, the round button on the right ends
 *  it. Green while the call is up, orange while it reconnects or waits, blue before it connects. */
class CallBarView(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private val words: TextView = context.words("", 14f, 0xFFFFFFFF.toInt())
  private val end = object : View(context) {
    override fun onDraw(canvas: Canvas) = CallIcons.draw(canvas, "xmark", width / 2f, height / 2f, 15f * d, 0xFFFFFFFF.toInt())
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  }

  /** A small picture inside the line of words. */
  private class IconSpan(private val name: String, private val size: Float) : ReplacementSpan() {
    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, metrics: Paint.FontMetricsInt?): Int = Math.round(size)
    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) =
      CallIcons.draw(canvas, name, x + size / 2, (top + bottom) / 2f, size, 0xFFFFFFFF.toInt())
  }

  init {
    words.gravity = Gravity.CENTER
    words.maxLines = 1
    words.ellipsize = TextUtils.TruncateAt.MIDDLE
    words.fontFeatureSettings = "tnum"
    addView(words)
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
    val side = Math.round(46f * d)
    words.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width - side * 2), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    words.layout(side, 0, maxOf(side, width - side), height)
    val button = Math.round(26f * d)
    end.measure(MeasureSpec.makeMeasureSpec(button, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(button, MeasureSpec.EXACTLY))
    end.layout(width - Math.round(8f * d) - button, (height - button) / 2, width - Math.round(8f * d), (height + button) / 2)
  }

  fun show(call: CallState) {
    val status = CallRules.status(call, Calls.signalNetwork)
    val color = CallRules.barColor(status.tone)
    if (color != shownColor) {
      shownColor = color
      background = context.plate(color, 14f)
    }
    val line = SpannableStringBuilder()
    line.append(" ", IconSpan(if (call.video) "video.fill" else "phone.fill", 14f * d), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    line.append("  ")
    line.append(call.peer.displayName, StyleSpan(Typeface.BOLD), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    line.append(" · ", ForegroundColorSpan(0xD9FFFFFF.toInt()), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    line.append(status.text)
    status.clock?.let { line.append(" $it", ForegroundColorSpan(0xD9FFFFFF.toInt()), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
    words.text = line
    contentDescription = barWords(call.peer.displayName, status) + ". Вернуться к звонку"
    end.visibility = if (call.isOver) GONE else VISIBLE
  }

  private var shownColor = 0

  companion object {
    /** The space between the bar and the status bar above it, and the screen's edges at its sides, dp. */
    const val GAP = 8f
    /** What the app's pages give up at the top while the bar is shown, dp: the gap, the bar and the gap under it. */
    val room: Float get() = GAP + CallRules.barHeight + GAP

    /** What the bar says, read aloud: the name, the status and the clock. */
    fun barWords(name: String, status: CallRules.Status): String = name + ", " + status.text + (status.clock?.let { " $it" } ?: "")
  }
}

/** What calls are shown in, above the app's own pages: the call screen, or — while the call is minimised — its
 *  bar. A touch that lands on neither goes through to the app underneath. */
@SuppressLint("ViewConstructor")
class CallHost(context: Context) : Screen(context) {
  val bar = CallBarView(context)
  var callScreen: CallScreenView? = null

  init {
    bar.visibility = GONE
    addView(bar)
  }

  override fun place(width: Int, height: Int) {
    // Below the status bar with a gap: the clock and the battery stay visible above it.
    val gap = dp(CallBarView.GAP)
    put(bar, gap, edges.top + gap, maxOf(0, width - gap * 2), dp(CallRules.barHeight))
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
