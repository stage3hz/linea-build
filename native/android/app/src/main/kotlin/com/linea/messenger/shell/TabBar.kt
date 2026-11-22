package com.linea.messenger.shell

import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Color
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextPaint
import android.text.TextUtils
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import com.linea.messenger.R
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Icons
import com.linea.messenger.design.Theme
import kotlin.math.max
import kotlin.math.min

/** One section as the bar knows it: its icon, its name for a screen reader and the list, what waits in it. */
data class TabEntry(val id: String, val label: String, val symbol: String, val badge: Int = 0, val dot: String = "")

/** A colour from `#RRGGBB`. */
private fun tabColor(hex: String): Int? {
  val text = hex.trim().removePrefix("#")
  if (text.length != 6) return null
  return text.toIntOrNull(16)?.let { 0xFF000000.toInt() or it }
}

// ChatsPlus: the reference's badgeText — exact up to 999, then «4,3K» (chatsplus/ChatListStatus.kt).
private fun badgeWords(count: Int): String = com.linea.messenger.chatsplus.ChatListStatus.badgeText(count)

/** ChatsPlus: each icon's own little motion on a tap (TabBar.tsx `TabIcon`): the gear turns once (760 ms, out-back
 *  1.7), the chat bubble hops (650 ms, out-quad: up 4 dp and 22 % larger at the top), any other icon wobbles. */
private fun tabKick(view: View, id: String) {
  val off = try { android.provider.Settings.Global.getFloat(view.context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f } catch (_: Exception) { false }
  if (off) return
  val d = view.resources.displayMetrics.density
  val gear = id == "profile"
  (view.getTag(R.id.action_more_sections) as? ValueAnimator)?.cancel()
  val kick = ValueAnimator.ofFloat(0f, 1f).apply {
    duration = if (gear) 760 else 650
    interpolator = android.view.animation.LinearInterpolator()
    addUpdateListener {
      val t = it.animatedValue as Float
      if (gear) {
        val s = 1.7f; val u = 1 - t
        view.rotation = (1 - u * u * ((s + 1) * u - s)) * 360f
      } else {
        val k = 1 - (1 - t) * (1 - t)
        val bump = Math.sin(k * Math.PI).toFloat()
        if (id == "chats") {
          view.translationY = -bump * 4f * d
          view.scaleX = 1 + bump * 0.22f; view.scaleY = 1 + bump * 0.22f
        } else {
          view.rotation = Math.sin(k * Math.PI * 2).toFloat() * 18f
          view.scaleX = 1 + bump * 0.3f; view.scaleY = 1 + bump * 0.3f
        }
      }
    }
    addListener(object : android.animation.AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: android.animation.Animator) { view.rotation = 0f; view.translationY = 0f; view.scaleX = 1f; view.scaleY = 1f }
    })
  }
  view.setTag(R.id.action_more_sections, kick)
  kick.start()
}

private const val BADGE_RED = 0xFFFF4D5E.toInt()
private const val WHITE = 0xFFFFFFFF.toInt()

/** What the bar draws with: white on a dark theme, black on a light one, as the iPhone's bar (`setDark`). */
private val ink: Int get() = if (Theme.dark) WHITE else 0xFF000000.toInt()

/** One icon of the bar; an accessibility element of its own. */
@SuppressLint("ViewConstructor")
private class TabIconView(context: Context) : View(context) {
  var symbol = ""
  var on = false
  var badge = ""
  var dot: Int? = null
  /** The name of the extra action of the first tab («Остальные разделы») and what it does. */
  var moreWords = ""
  var onMore: (() -> Unit)? = null

  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val words = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); textAlign = Paint.Align.CENTER; color = WHITE }

  override fun onDraw(canvas: Canvas) {
    val midX = width / 2f; val midY = height / 2f
    Icons.draw(canvas, symbol, midX, midY, 27f * d, Theme.alpha(ink, if (on) 1f else 0.58f), filled = on)
    if (badge.isNotEmpty()) {
      val wide = max(18f * d, words.measureText(badge) + 10f * d)
      fill.color = BADGE_RED
      canvas.drawRoundRect(midX + 4f * d, midY - 22f * d, midX + 4f * d + wide, midY - 4f * d, 9f * d, 9f * d, fill)
      canvas.drawText(badge, midX + 4f * d + wide / 2, midY - 13f * d - (words.ascent() + words.descent()) / 2, words)
    } else dot?.let { fill.color = it; canvas.drawCircle(midX + 13f * d, midY - 13f * d, 4f * d, fill) }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.isSelected = on
    if (onMore != null && moreWords.isNotEmpty()) info.addAction(AccessibilityNodeInfo.AccessibilityAction(R.id.action_more_sections, moreWords))
  }

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    if (action == R.id.action_more_sections) { onMore?.invoke(); return true }
    return super.performAccessibilityAction(action, arguments)
  }
}

/** One row of the list of sections. */
@SuppressLint("ViewConstructor")
private class TabRowView(context: Context, val entry: TabEntry) : View(context) {
  var lit = false
    set(value) { if (field != value) { field = value; invalidate() } }

  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val label = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 16f * d; typeface = Theme.weight(600) }
  private val count = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); textAlign = Paint.Align.CENTER; color = WHITE }

  init { contentDescription = if (entry.badge > 0) "${entry.label}, ${entry.badge}" else entry.label }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (lit) { fill.color = Theme.alpha(ink, if (Theme.dark) 0.14f else 0.08f); canvas.drawRoundRect(0f, 0f, w, h, 16f * d, 16f * d, fill) }
    Icons.draw(canvas, entry.symbol, 24f * d, h / 2, 21f * d, Theme.alpha(ink, if (lit) 1f else 0.62f))
    var badgeWidth = 0f
    if (entry.badge > 0) {
      val text = badgeWords(entry.badge)
      badgeWidth = max(20f * d, count.measureText(text) + 12f * d)
      fill.color = BADGE_RED
      canvas.drawRoundRect(w - 10f * d - badgeWidth, h / 2 - 10f * d, w - 10f * d, h / 2 + 10f * d, 10f * d, 10f * d, fill)
      canvas.drawText(text, w - 10f * d - badgeWidth / 2, h / 2 - (count.ascent() + count.descent()) / 2, count)
    }
    label.color = Theme.alpha(ink, if (lit) 1f else 0.72f)
    val shown = TextUtils.ellipsize(entry.label, label, w - 48f * d - badgeWidth - 16f * d, TextUtils.TruncateAt.END)
    canvas.drawText(shown, 0, shown.length, 48f * d, h / 2 - (label.ascent() + label.descent()) / 2, label)
  }
}

/** The list of the sections that have no icon in the bar. Lies over the whole window, above everything. */
@SuppressLint("ViewConstructor")
private class TabListOverlay(context: Context, entries: List<TabEntry>, behind: GlassSource?) : ViewGroup(context) {
  var onPick: (TabEntry) -> Unit = {}
  var onClose: () -> Unit = {}
  /** The list takes taps itself: on a row — open it, beside — close the list. Otherwise the finger that opened
   *  it is still down and the bar tells the list what is lit. */
  var sticky = false
  var lit = ""
    private set

  private val d = resources.displayMetrics.density
  private val rows = entries.map { TabRowView(context, it) }
  private var anchorLeft = 0
  private var anchorTop = 0
  private var anchorWidth = 0

  /** The plate the rows stand on. */
  private val panel = object : ViewGroup(context) {
    val glass = Glass(this).apply { source = behind }
    init { setWillNotDraw(false) }
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
      val row = (ROW_DP * d).toInt(); val inset = (6f * d).toInt()
      rows.forEachIndexed { index, view ->
        view.measure(MeasureSpec.makeMeasureSpec(right - left - 2 * inset, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(row, MeasureSpec.EXACTLY))
        view.layout(inset, inset + index * row, right - left - inset, inset + (index + 1) * row)
      }
    }
    override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 24f * d)
  }

  init {
    for (row in rows) {
      // For a screen reader and a keyboard; a finger is handled by the overlay as a whole.
      row.setOnClickListener { onPick(row.entry) }
      panel.addView(row)
    }
    addView(panel)
  }

  /** The panel stands above the bar (its corner and width in this view's coordinates), centred on it. */
  fun place(barLeft: Int, barTop: Int, barWidth: Int) {
    anchorLeft = barLeft; anchorTop = barTop; anchorWidth = barWidth
    requestLayout()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val wide = (WIDTH_DP * d).toInt(); val tall = (rows.size * ROW_DP * d + 12f * d).toInt(); val edge = (8f * d).toInt()
    val x = min(max(edge, anchorLeft + anchorWidth / 2 - wide / 2), max(edge, right - left - wide - edge))
    val y = anchorTop - (12f * d).toInt() - tall
    panel.measure(MeasureSpec.makeMeasureSpec(wide, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(tall, MeasureSpec.EXACTLY))
    panel.layout(x, y, x + wide, y + tall)
  }

  /** The entry whose row is under a point (this view's coordinates), with a little room at the sides. */
  fun entryAt(x: Float, y: Float): TabEntry? {
    val px = x - panel.left; val py = y - panel.top; val room = 40f * d
    return rows.firstOrNull { px >= it.left - room && px <= it.right + room && py >= it.top && py < it.bottom }?.entry
  }

  fun light(id: String) {
    if (id == lit) return
    lit = id
    for (row in rows) row.lit = row.entry.id == id
  }

  /** Takes a screen reader to the first row. */
  fun focusFirst() { rows.firstOrNull()?.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null) }

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean = true

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (!sticky) return false
    if (event.actionMasked == MotionEvent.ACTION_UP) {
      val entry = entryAt(event.x, event.y)
      if (entry != null) onPick(entry) else onClose()
    }
    return true
  }

  companion object { const val ROW_DP = 44f; const val WIDTH_DP = 216f }
}

/** The phone's tab bar, drawn and driven by plain views.
 *  - The bar is a plate of glass (see Glass: the page behind it, blurred, on Android 12 and later): dark on a dark
 *    theme, light with dark icons on a light one.
 *  - The chosen tab stands on a light capsule; choosing another tab sends the capsule there with a spring and a
 *    faint second capsule follows a little late and fades — the trail.
 *  - A light lives in the bar: two quiet colours at the sides, a brighter one under the chosen tab; with a
 *    track playing, the three colours of its cover.
 *  - The first tab also holds the other sections: hold it (or move the finger up from it) and their list appears
 *    above the bar; the row under the finger is lit, letting go on a row opens it. A plain hold leaves the list
 *    open: a tap on a row opens it, a tap beside closes the list.
 *  The owner gives the items and the open section and hears `onSelect` / `onPreview`. */
class TabBarView(context: Context) : ViewGroup(context) {
  /** A section was chosen: by a tap on its icon or from the list. */
  var onSelect: (id: String) -> Unit = {}
  /** The finger rests on a row of the list: the page behind shows that section for a look ("" = back to the
   *  section that was open). */
  var onPreview: (id: String) -> Unit = {}
  /** The list of sections opened or closed. */
  var onListChange: (open: Boolean) -> Unit = {}
  /** What a screen reader calls the first tab's extra action: opening the list. */
  var moreWords = ""
    set(value) { field = value; paintIcons() }
  /** The page the bar's glass shows blurred. */
  var behind: GlassSource?
    get() = glass.source
    set(value) { glass.source = value; invalidate() }
  val listOpen: Boolean get() = overlay != null

  private val d = resources.displayMetrics.density
  private val glass = Glass(this)
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = max(1f, d) }
  private val lights = Array(3) { Paint(Paint.ANTI_ALIAS_FLAG) }
  private val clip = Path()
  private var icons: List<TabIconView> = emptyList()

  private var items: List<TabEntry> = emptyList()
  private var bar: List<String> = emptyList()
  private var active = ""
  private var glow: List<Int> = emptyList()
  private var laidOut = 0L

  // What is drawn now; animators move these.
  private var capsuleX = 0f
  private var capsuleAlpha = 0f
  private var spotX = 0f
  private var trailX = 0f
  private var trailAlpha = 0f
  private var liftScale = 1f
  private val running = arrayOfNulls<ValueAnimator>(6)

  // The touch in progress.
  private val timers = Handler(Looper.getMainLooper())
  private val holdTimer = Runnable { openList(sticky = false) }
  private var previewTimer: Runnable? = null
  private var overlay: TabListOverlay? = null
  private var overlaySticky = false
  private var previewed = ""
  private val here = IntArray(2)
  private val there = IntArray(2)

  private val touch = BarTouch(object : BarTouch.Host {
    override val barWidth get() = width.toFloat()
    override val barHeight get() = height.toFloat()
    override val tabCount get() = bar.size
    override val hasOthers get() = others.isNotEmpty()
    override val listOpen get() = overlay != null
    override val listSticky get() = overlaySticky
    override fun lift(on: Boolean) = this@TabBarView.lift(on)
    override fun hold(start: Boolean) { timers.removeCallbacks(holdTimer); if (start) timers.postDelayed(holdTimer, BarTouch.HOLD_MS) }
    override fun openList(sticky: Boolean) = this@TabBarView.openList(sticky)
    override fun rowAt(x: Float, y: Float): String? {
      val list = overlay ?: return null
      getLocationInWindow(here); list.getLocationInWindow(there)
      return list.entryAt(x + here[0] - there[0], y + here[1] - there[1])?.id
    }
    override fun light(id: String?) = this@TabBarView.light(id)
    override fun pick(id: String) { entry(id)?.let { this@TabBarView.pick(it) } }
    override fun closeList(restore: Boolean) = this@TabBarView.closeList(restore)
    override fun stick() = this@TabBarView.stick()
    override fun choose(index: Int) = this@TabBarView.choose(index)
  }, d)

  init {
    setWillNotDraw(false)
    clipChildren = false
    paintGlow()
  }

  // MARK: What the owner sets

  fun setItems(next: List<TabEntry>) {
    if (next == items) return
    items = next
    rebuildIcons()
  }

  fun setBar(next: List<String>) {
    if (next == bar) return
    bar = next
    rebuildIcons()
  }

  fun setActive(id: String) {
    if (id == active) return
    val before = activeIndex
    active = id
    paintIcons()
    moveCapsule(before, animated = laidOut != 0L)
  }

  /** Three colours of the playing track's cover (centre, left, right) as `#RRGGBB`; none = the calm silver. */
  fun setGlow(hexes: List<String>) {
    val next = hexes.mapNotNull { tabColor(it) }
    if (next == glow) return
    glow = next
    paintGlow()
  }

  // MARK: Layout

  private val activeIndex: Int get() = bar.indexOf(active)
  private val cell: Float get() = if (bar.isEmpty()) 0f else width.toFloat() / bar.size
  private fun capsuleLeft(index: Int): Float = max(0, index) * cell + 4f * d
  private fun spotCentre(index: Int): Float = if (index < 0) width / 2f else (index + 0.5f) * cell

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val w = right - left; val h = bottom - top
    if (w <= 0 || h <= 0) return
    icons.forEachIndexed { index, icon ->
      val from = (index * cell).toInt(); val to = ((index + 1) * cell).toInt()
      icon.measure(MeasureSpec.makeMeasureSpec(to - from, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
      icon.layout(from, 0, to, h)
    }
    val size = (w.toLong() shl 32) or h.toLong()
    if (size == laidOut) return
    laidOut = size
    moveCapsule(activeIndex, animated = false)
  }

  // MARK: Looks

  private fun paintGlow() {
    // Calm: a cool silver. With colours (a track's cover): centre, left, right.
    val coloured = glow.size == 3
    val dark = Theme.dark
    val colors = if (coloured) glow
      else if (dark) listOf(0xFFE8EDF5.toInt(), 0xFF808FA8.toInt(), 0xFFC9D1E0.toInt())
      else listOf(0xFF8F99AD.toInt(), 0xFFB5BDCC.toInt(), 0xFF99A6B8.toInt())
    val strength = if (coloured) 1f else if (dark) 0.7f else 0.45f
    // The owner's choice: one small round glow right behind the chosen icon; a track's colour a little softened.
    val hsv = FloatArray(3)
    Color.colorToHSV(colors[0], hsv)
    if (coloured) hsv[1] *= 0.8f
    val color = Color.HSVToColor(hsv)
    lights[0].shader = RadialGradient(0f, 0f, 1f, Theme.alpha(color, 0.55f * strength), Theme.alpha(color, 0f), Shader.TileMode.CLAMP)
    invalidate()
  }

  private fun shine(canvas: Canvas, left: Float, wide: Float, paint: Paint) {
    canvas.save()
    canvas.translate(left + wide / 2, height.toFloat())
    canvas.scale(wide / 2, height.toFloat())
    canvas.drawRect(-1f, -1f, 1f, 0f, paint)
    canvas.restore()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    glass.draw(canvas, 0f, 0f, w, h, h / 2)

    clip.reset(); clip.addRoundRect(0f, 0f, w, h, h / 2, h / 2, Path.Direction.CW)
    canvas.save(); canvas.clipPath(clip)
    // The glow behind the chosen icon: a circle almost the bar's height, centred on the icon.
    val halo = h * 0.95f / 2
    // In a section without an icon on the bar there is no glow (it showed as a smudge between the icons).
    lights[0].alpha = (255 * capsuleAlpha).toInt().coerceIn(0, 255)
    canvas.save(); canvas.translate(spotX, h / 2); canvas.scale(halo, halo)
    canvas.drawCircle(0f, 0f, 1f, lights[0])
    canvas.restore()
    canvas.restore()

    val top = 4f * d; val wide = cell - 8f * d; val tall = h - 8f * d; val round = tall / 2
    if (trailAlpha > 0f) {
      fill.color = Theme.alpha(ink, (if (Theme.dark) 0.16f else 0.08f) * trailAlpha)
      canvas.drawRoundRect(trailX, top, trailX + wide, top + tall, round, round, fill)
    }
    if (capsuleAlpha > 0f) {
      canvas.save(); canvas.scale(liftScale, liftScale, capsuleX + wide / 2, h / 2)
      fill.color = Theme.alpha(ink, (if (Theme.dark) 0.14f else 0.07f) * capsuleAlpha)
      canvas.drawRoundRect(capsuleX, top, capsuleX + wide, top + tall, round, round, fill)
      rim.color = Theme.alpha(WHITE, (if (Theme.dark) 0.22f else 0.8f) * capsuleAlpha)
      val half = rim.strokeWidth / 2
      canvas.drawRoundRect(capsuleX + half, top + half, capsuleX + wide - half, top + tall - half, round - half, round - half, rim)
      canvas.restore()
    }
  }

  private fun rebuildIcons() {
    icons.forEach { removeView(it) }
    icons = bar.indices.map { index ->
      TabIconView(context).also { icon ->
        // For a screen reader and a keyboard; a finger is followed by the bar as a whole.
        icon.setOnClickListener { choose(index) }
        addView(icon)
      }
    }
    laidOut = 0L
    paintIcons()
    requestLayout()
  }

  private fun entry(id: String): TabEntry? = items.firstOrNull { it.id == id }
  private val others: List<TabEntry> get() = items.filter { it.id !in bar }

  private fun paintIcons() {
    val waiting = others.sumOf { it.badge }
    val awake = others.firstOrNull { it.dot.isNotEmpty() }?.dot ?: ""
    icons.forEachIndexed { index, icon ->
      val item = bar.getOrNull(index)?.let { entry(it) } ?: return@forEachIndexed
      val on = item.id == active
      icon.symbol = item.symbol
      icon.on = on
      // The first tab also carries what waits in the sections without an icon.
      val count = item.badge + if (index == 0) waiting else 0
      icon.badge = if (count > 0) badgeWords(count) else ""
      val dot = if (count > 0) "" else if (item.dot.isEmpty() && index == 0) awake else item.dot
      icon.dot = tabColor(dot)
      icon.contentDescription = if (count > 0) "${item.label}, $count" else item.label
      icon.isSelected = on
      val more = index == 0 && moreWords.isNotEmpty() && others.isNotEmpty()
      icon.moreWords = if (more) moreWords else ""
      icon.onMore = if (more) ({ openList(sticky = true) }) else null
      icon.invalidate()
    }
  }

  // MARK: The capsule and its trail

  private fun run(slot: Int, from: Float, to: Float, millis: Long, delay: Long, curve: TimeInterpolator, set: (Float) -> Unit) {
    running[slot]?.cancel()
    running[slot] = ValueAnimator.ofFloat(from, to).apply {
      duration = millis; startDelay = delay; interpolator = curve
      addUpdateListener { set(it.animatedValue as Float); invalidate() }
      start()
    }
  }

  private fun moveCapsule(before: Int, animated: Boolean) {
    val index = activeIndex
    if (width <= 0) return
    val target = capsuleLeft(index)
    if (!animated) {
      for (slot in 0..4) { running[slot]?.cancel(); running[slot] = null }
      capsuleX = target; capsuleAlpha = if (index < 0) 0f else 1f
      spotX = spotCentre(index); trailX = target; trailAlpha = 0f
      invalidate()
      return
    }
    val ease = DecelerateInterpolator()
    if (index < 0 || before < 0) {
      // Appearing or leaving: a fade, nothing travels.
      if (index >= 0) { running[0]?.cancel(); capsuleX = target }
      run(1, capsuleAlpha, if (index < 0) 0f else 1f, 200, 0, ease) { capsuleAlpha = it }
      run(2, spotX, spotCentre(index), 200, 0, ease) { spotX = it }
      return
    }
    // The trail starts where the capsule stands now, follows late and fades as it arrives.
    trailX = capsuleX
    trailAlpha = 0.6f
    run(0, capsuleX, target, 420, 0, SpringCurve(0.82f, 0.4f * 0.42f)) { capsuleX = it }
    run(1, capsuleAlpha, 1f, 420, 0, ease) { capsuleAlpha = it }
    run(2, spotX, spotCentre(index), 420, 0, SpringCurve(0.82f, 0.4f * 0.42f)) { spotX = it }
    run(3, trailX, target, 620, 50, SpringCurve(0.9f)) { trailX = it }
    run(4, trailAlpha, 0f, 340, 260, ease) { trailAlpha = it }
  }

  private fun lift(on: Boolean) {
    run(5, liftScale, if (on) 1.05f else 1f, 250, 0, SpringCurve(0.75f)) { liftScale = it }
  }

  private fun choose(index: Int) {
    val id = bar.getOrNull(index) ?: return
    // ChatsPlus: the reference's own motion of each icon (the gear turns, the bubble hops).
    icons.getOrNull(index)?.let { icon -> tabKick(icon, id) }
    // The capsule goes at once; the owner confirms with `setActive`.
    if (id != active) {
      val before = activeIndex
      active = id
      paintIcons()
      moveCapsule(before, animated = true)
    }
    onSelect(id)
  }

  // MARK: Touches

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean = true

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        // The finger may leave the bar for the list: nobody above takes the gesture away.
        parent?.requestDisallowInterceptTouchEvent(true)
        touch.down(event.x, event.y)
      }
      MotionEvent.ACTION_MOVE -> touch.move(event.x, event.y)
      MotionEvent.ACTION_UP -> touch.up(event.x, event.y)
      MotionEvent.ACTION_CANCEL -> touch.cancel()
    }
    return true
  }

  // MARK: The list

  fun openList(sticky: Boolean) {
    timers.removeCallbacks(holdTimer)
    if (overlay != null || others.isEmpty() || !isAttachedToWindow) return
    val window = rootView.findViewById<ViewGroup>(android.R.id.content) ?: return
    val list = TabListOverlay(context, others, glass.source)
    list.onPick = { pick(it) }
    list.onClose = { closeList(restore = false) }
    window.addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    getLocationInWindow(here); window.getLocationInWindow(there)
    list.place(here[0] - there[0], here[1] - there[1], width)
    list.sticky = sticky
    list.alpha = 0f
    list.translationY = 8f * d
    list.animate().alpha(1f).translationY(0f).setDuration(180).setInterpolator(DecelerateInterpolator()).start()
    overlay = list
    overlaySticky = sticky
    previewed = ""
    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    onListChange(true)
    if (sticky) list.post { list.focusFirst() }
  }

  /** Closes the list if it is open (the system's Back does this). */
  fun closeList() { if (overlay != null) closeList(restore = true) }

  /** The finger was lifted without moving: the list stays, rows and the space around take taps. */
  private fun stick() {
    overlaySticky = true
    overlay?.sticky = true
    overlay?.light("")
  }

  private fun light(entryId: String?) {
    val list = overlay ?: return
    val id = entryId ?: ""
    if (id == list.lit) return
    list.light(id)
    if (id.isNotEmpty()) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    // The page behind follows only a row the finger has stayed on.
    previewTimer?.let { timers.removeCallbacks(it) }
    val timer = Runnable {
      if (overlay?.lit == id && previewed != id) { previewed = id; onPreview(id) }
    }
    previewTimer = timer
    timers.postDelayed(timer, 140)
  }

  private fun pick(entry: TabEntry) {
    dismissList()
    val before = activeIndex
    active = entry.id
    paintIcons()
    moveCapsule(before, animated = true)
    onSelect(entry.id)
  }

  private fun closeList(restore: Boolean) {
    val shown = previewed
    dismissList()
    if (restore && shown.isNotEmpty()) onPreview("")
  }

  private fun dismissList(now: Boolean = false) {
    previewTimer?.let { timers.removeCallbacks(it) }
    previewTimer = null
    previewed = ""
    val list = overlay ?: return
    overlay = null
    overlaySticky = false
    list.sticky = false
    val remove = Runnable { (list.parent as? ViewGroup)?.removeView(list) }
    if (now) remove.run()
    else list.animate().alpha(0f).setDuration(140).setInterpolator(AccelerateInterpolator()).withEndAction(remove).start()
    onListChange(false)
  }

  override fun onDetachedFromWindow() {
    timers.removeCallbacks(holdTimer)
    dismissList(now = true)
    super.onDetachedFromWindow()
  }
}
