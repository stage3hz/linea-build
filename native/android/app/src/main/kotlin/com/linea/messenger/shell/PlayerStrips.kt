package com.linea.messenger.shell

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.MetricAffectingSpan
import android.text.TextPaint
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.ai.AIIconButton
import com.linea.messenger.design.Glass
import com.linea.messenger.design.Theme
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.music.PlayerScreen
import com.linea.messenger.net.Live
import com.linea.messenger.people.pages

/** Shell: what the shell lays over every section, for the screens that keep room for it at their bottom
 *  (native/ios/Sources/Shell/PlayerStrips.swift). */
object ShellInsets {
  /** Posted on the main thread when the mini-player came or went. */
  val changed = Live.Signal<Unit>()
  /** The room the mini-player takes above the bar (its height and its gap), dp; 0 while it is not shown. */
  var miniPlayer = 0f
  const val miniHeight = 64f
  const val miniGap = 8f
}

/** Shell: the player strip under a chat's header while music plays (the reference's PlayerControls.tsx
 *  `TopPlayerBar`): a glass pill 40 dp high, 12 dp from the sides — play/pause in the accent, the title (13 semibold)
 *  and the artist (muted), «✕» that stops the music; a 2 dp progress line along its lower edge. A touch on the title
 *  opens the full player. */
@SuppressLint("ViewConstructor")
class TopPlayerBar(context: Context, private val player: MusicPlayer = MusicPlayer.shared) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private val glass = Glass(this)
  private val toggle = AIIconButton(context, "play", 16f, Theme.accent, "Слушать")
  private val words = TextView(context).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER_VERTICAL; isClickable = true }
  private val close = AIIconButton(context, "xmark", 15f, Theme.muted, "Закрыть плеер и остановить музыку")
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  /** A touch on the title (the host opens the full player). */
  var onOpen: (() -> Unit)? = null
  /** The strip came or went: the host lays its screen out again. */
  var onShownChanged: (() -> Unit)? = null
  private var hadTrack: Boolean? = null
  private val changed: () -> Unit = { refresh() }

  init {
    setWillNotDraw(false)
    addView(toggle); addView(words); addView(close)
    toggle.setOnClickListener { player.togglePlayback() }
    close.setOnClickListener { player.stop() }
    words.setOnClickListener { onOpen?.invoke() }
    refresh()
  }

  /** Whether a track is chosen (the strip is shown only then). */
  val shown: Boolean get() = player.current != null

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    player.changed.watch(changed)
    refresh()
  }

  override fun onDetachedFromWindow() {
    player.changed.unwatch(changed)
    super.onDetachedFromWindow()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l; val h = b - t
    fun put(view: View, x: Int, width: Int) {
      view.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY)); view.layout(x, 0, x + width, h)
    }
    put(toggle, (4 * d).toInt(), (36 * d).toInt())
    put(close, w - (38 * d).toInt(), (36 * d).toInt())
    put(words, (44 * d).toInt(), maxOf(0, w - (82 * d).toInt()))
  }

  override fun onDraw(canvas: Canvas) {
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 18f * d)
    val left = 14f * d; val wide = maxOf(0f, width - 28f * d); val top = height - 2f * d
    paint.color = Theme.veil(0.1f)
    canvas.drawRoundRect(left, top, left + wide, height.toFloat(), d, d, paint)
    val part = if (player.duration > 0) (player.position / player.duration).coerceIn(0.0, 1.0).toFloat() else 0f
    paint.color = Theme.accent
    canvas.drawRoundRect(left, top, left + wide * part, height.toFloat(), d, d, paint)
  }

  private fun refresh() {
    val has = player.current != null
    if (hadTrack != has) { hadTrack = has; onShownChanged?.invoke() }
    val current = player.current ?: return
    toggle.symbol = if (player.playing) "pause" else "play"
    toggle.contentDescription = if (player.playing) "Пауза" else "Слушать"
    val line = SpannableStringBuilder(current.title)
    line.setSpan(Face(600), 0, line.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    line.setSpan(ForegroundColorSpan(Theme.text), 0, line.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    val start = line.length
    line.append("  " + current.artist)
    line.setSpan(Face(400), start, line.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    line.setSpan(ForegroundColorSpan(Theme.muted), start, line.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    words.textSize = 13f
    words.text = line
    words.contentDescription = "Открыть плеер: ${current.title}, ${current.artist}"
    invalidate()
  }

  /** A part of the line in Montserrat at a weight. */
  private class Face(private val weight: Int) : MetricAffectingSpan() {
    override fun updateMeasureState(paint: TextPaint) { paint.typeface = Theme.weight(weight) }
    override fun updateDrawState(paint: TextPaint) { paint.typeface = Theme.weight(weight) }
  }

  companion object { const val HEIGHT = 40f }
}

/** Music: the strip in a chat, under its header (the chat screen calls `place`). */
class ChatPlayerStrip(private val host: ViewGroup) {
  val bar = TopPlayerBar(host.context)
  private val d = host.resources.displayMetrics.density

  init {
    bar.onOpen = {
      val stack = host.pages()
      val player = MusicPlayer.shared
      if (stack != null && stack.top !is PlayerScreen && player.current != null) {
        (host.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)?.hideSoftInputFromWindow(host.windowToken, 0)
        stack.push(PlayerScreen(host.context, player), animated = false) // it slides up by itself (a <Modal animationType="slide">)
      }
    }
    bar.onShownChanged = { host.requestLayout() }
    host.addView(bar)
  }

  /** Places the strip under the header; gives the room it takes there, px (0 while nothing plays or while hidden). */
  fun place(width: Int, headerBottom: Int, hidden: Boolean): Int {
    val show = bar.shown && !hidden
    bar.visibility = if (show) View.VISIBLE else View.GONE
    if (!show) return 0
    val left = (12 * d).toInt(); val top = headerBottom + (4 * d).toInt(); val tall = (TopPlayerBar.HEIGHT * d).toInt()
    bar.measure(View.MeasureSpec.makeMeasureSpec(width - 2 * left, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(tall, View.MeasureSpec.EXACTLY))
    bar.layout(left, top, width - left, top + tall)
    return tall + (4 * d).toInt()
  }
}
