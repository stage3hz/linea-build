package com.linea.messenger.design

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.chatlook.Bouncy

/** Glass parts of the reference's pages (mobile/src/components.tsx `IconButton`, the headers of SettingsScreen.tsx
 *  `Page`, PeopleScreen.tsx and communities/CommunitiesScreen.tsx; iOS Design/GlassKit.swift). Every surface here is
 *  drawn by `Glass`, so «Ледяное стекло» puts its rime on it (effects/EffectsHost.kt reads `Glass.plates`). */

/** How a picture is drawn: (canvas, name, cx, cy, size px, colour) — `Symbols.draw` and its kin. */
typealias IconPainter = (Canvas, String, Float, Float, Float, Int) -> Unit

/** `clear`: the reference's `material="clear"` — a thinner fill than the default «regular» glass. */
internal fun Glass.makeClear(): Glass {
  tint = Theme.alpha(tint, (tint ushr 24) / 255f * 0.72f)
  plain = Theme.alpha(plain, 0.8f)
  return this
}

/** The reference's `IconButton`: a 44 dp round of clear glass with an icon; pressed it springs to 0.86
 *  (`Bouncy scaleTo={.86}`). `filled`: the accent round of «Создать» (42, the accent, the icon in `onAccent`). */
@SuppressLint("ViewConstructor")
class GlassRoundButton(
  context: Context,
  symbol: String,
  label: String,
  private val iconSize: Float = 19f,
  private val filled: Boolean = false,
  private val side: Float = 44f,
  private val painter: IconPainter = Symbols::draw,
) : View(context) {
  var onPress: (() -> Unit)? = null
  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  /** The icon's colour (the reference's `color`; the text colour by default). */
  var tint: Int = if (filled) Theme.onAccent else Theme.text
    set(value) { if (field != value) { field = value; invalidate() } }
  private val glass = Glass(this).makeClear()
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val d = resources.displayMetrics.density

  /** The page the glass shows blurred (none: the plain fill). */
  var source: GlassSource?
    get() = glass.source
    set(value) { glass.source = value; invalidate() }

  init {
    isClickable = true
    isFocusable = true
    contentDescription = label
    setOnClickListener { onPress?.invoke() }
    Bouncy.attach(this, 0.86f)
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val own = Math.round(side * d)
    setMeasuredDimension(resolveSize(own, widthSpec), resolveSize(own, heightSpec))
  }

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    alpha = if (enabled) 1f else 0.45f
  }

  override fun onDraw(canvas: Canvas) {
    val r = minOf(width, height) / 2f
    if (filled) { fill.color = Theme.accent; canvas.drawCircle(width / 2f, height / 2f, r, fill) }
    else glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), r)
    painter(canvas, symbol, width / 2f, height / 2f, iconSize * d, tint)
  }
}

/** The header pill of the reference's pages: a glass pill (radius 27) holding — left to right — an optional round
 *  back button, the page's name in the title face with an optional quiet line under it, and round glass buttons on
 *  the right. The owner places the view (the pill fills it); the settings pages put it 12 from the edges and the
 *  safe area, the sections 14 from the sides and 12 under the safe area.
 *  `titleSize`: the name's size (settings pages 22 / 19 / 17 by length, the sections 26); `lineHeight`: its line
 *  (28 / 32); `subtitleSize`: the quiet line (11 «Люди», 12 «Каналы»); `padding`: the room inside (8 / 10);
 *  `minHeight`: the least height (60 / 64 / 72). */
@SuppressLint("ViewConstructor")
class GlassHeaderView(
  context: Context,
  title: String,
  subtitle: String = "",
  titleSize: Float,
  private val lineHeight: Float,
  subtitleSize: Float = 12f,
  private val padding: Float,
  private val minHeight: Float,
  clear: Boolean = false,
  back: (() -> Unit)? = null,
  backLabel: String = "Назад",
) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val glass = Glass(this).let { if (clear) it.makeClear() else it }
  val titleLabel = TextView(context)
  val subtitleLabel = TextView(context)
  var backButton: GlassRoundButton? = null
    private set
  private val tools = ArrayList<GlassRoundButton>()
  private val hasBack = back != null

  /** The page the pill (and its round buttons) show blurred. */
  var source: GlassSource?
    get() = glass.source
    set(value) {
      glass.source = value
      backButton?.source = value
      for (tool in tools) tool.source = value
      invalidate()
    }

  init {
    setWillNotDraw(false)
    clipChildren = false
    if (back != null) {
      val button = GlassRoundButton(context, "chevron.left", backLabel, 19f)
      button.onPress = back
      addView(button)
      backButton = button
    }
    titleLabel.text = title
    titleLabel.setTextColor(Theme.text)
    Titles.title(titleLabel, titleSize)
    titleLabel.includeFontPadding = false
    titleLabel.maxLines = 1
    titleLabel.gravity = Gravity.CENTER_VERTICAL
    titleLabel.setAutoSizeTextTypeUniformWithConfiguration(maxOf(1, Math.round(titleSize * 0.62f)), maxOf(2, Math.round(titleSize)), 1, TypedValue.COMPLEX_UNIT_SP)
    if (Build.VERSION.SDK_INT >= 28) titleLabel.isAccessibilityHeading = true
    addView(titleLabel)
    subtitleLabel.text = subtitle
    subtitleLabel.textSize = subtitleSize
    subtitleLabel.typeface = Theme.weight(400)
    subtitleLabel.setTextColor(Theme.muted)
    subtitleLabel.includeFontPadding = false
    subtitleLabel.maxLines = 1
    subtitleLabel.ellipsize = TextUtils.TruncateAt.END
    subtitleLabel.visibility = if (subtitle.isEmpty()) GONE else VISIBLE
    addView(subtitleLabel)
  }

  fun setTitle(title: String) { titleLabel.text = title }

  fun setSubtitle(subtitle: String) {
    subtitleLabel.text = subtitle
    subtitleLabel.visibility = if (subtitle.isEmpty()) GONE else VISIBLE
    requestLayout()
  }

  /** A round button on the right (glass; `filled`: the accent round of «Создать», 42). */
  fun addTool(symbol: String, label: String, filled: Boolean = false, iconSize: Float = 19f, painter: IconPainter = Symbols::draw, action: () -> Unit): GlassRoundButton {
    val button = GlassRoundButton(context, symbol, label, if (filled) 21f else iconSize, filled, if (filled) 42f else 44f, painter)
    button.onPress = action
    button.source = glass.source
    addView(button)
    tools.add(button)
    requestLayout()
    return button
  }

  private fun textsHeight(width: Int): Int {
    var total = dp(lineHeight)
    if (subtitleLabel.visibility != GONE) {
      subtitleLabel.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      total += subtitleLabel.measuredHeight + (if (hasBack) 0 else dp(4f))
    }
    return total
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    val height = if (MeasureSpec.getMode(heightSpec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(heightSpec) else {
      val tall = maxOf(if (hasBack || tools.isNotEmpty()) dp(44f) else 0, textsHeight(width - dp(2 * padding + 120f)))
      maxOf(dp(minHeight), tall + dp(2 * padding))
    }
    setMeasuredDimension(width, height)
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(maxOf(0, height), MeasureSpec.EXACTLY))
    view.layout(left, top, left + maxOf(0, width), top + maxOf(0, height))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l; val cy = (b - t) / 2
    // Without a back button the words stand 6 further in (`paddingLeft: 6`).
    var left = dp(if (hasBack) padding else padding + 6f)
    backButton?.let { put(it, left, cy - dp(22f), dp(44f), dp(44f)); left += dp(44f + 9f) }
    var right = width - dp(padding)
    for (tool in tools.asReversed()) {
      val side = tool.measuredWidthFor()
      put(tool, right - side, cy - side / 2, side, side)
      right -= side + dp(9f)
    }
    val wide = right - left
    val tall = textsHeight(wide)
    var top = cy - tall / 2
    put(titleLabel, left, top, wide, dp(lineHeight))
    top += dp(lineHeight) + (if (hasBack) 0 else dp(4f))
    if (subtitleLabel.visibility != GONE) put(subtitleLabel, left, top, wide, subtitleLabel.measuredHeight)
  }

  private fun GlassRoundButton.measuredWidthFor(): Int {
    measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    return measuredWidth
  }

  override fun onDraw(canvas: Canvas) {
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 27f * d)
  }
}

/** The reference's search field on glass (PeopleScreen.tsx: GlassSurface «regular», radius 24, at least 54 tall,
 *  15 inside, the accent magnifier (21) 10 before the words). The owner puts the field and its buttons inside
 *  (a FrameLayout: by their layout params); the words start at `wordsLeft`. */
class GlassSearchField(context: Context) : FrameLayout(context) {
  private val d = resources.displayMetrics.density
  private val glass = Glass(this)
  private val lens = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }

  var source: GlassSource?
    get() = glass.source
    set(value) { glass.source = value; invalidate() }

  init { setWillNotDraw(false) }

  /** Where the words go, px (after the magnifier and 10 of room). */
  val wordsLeft: Int get() = Math.round((15f + 21f + 10f) * d)

  override fun onDraw(canvas: Canvas) {
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 24f * d)
    // The magnifier: the reference's `search-outline` (21), in the accent, 15 from the left.
    IonIcon.draw(canvas, "search-outline", (15f + 10.5f) * d, height / 2f, 21f * d, Theme.accent)
  }
}

/** A plate of glass as a view's background (`GlassBacking.put`): a round (half the shorter side) or a fixed radius. */
class GlassDrawable(owner: View, private val radius: Float? = null, clear: Boolean = true) : Drawable() {
  private val glass = Glass(owner).let { if (clear) it.makeClear() else it }

  var source: GlassSource?
    get() = glass.source
    set(value) { glass.source = value; invalidateSelf() }

  override fun draw(canvas: Canvas) {
    val box = bounds
    val r = radius ?: (minOf(box.width(), box.height()) / 2f)
    glass.draw(canvas, box.left.toFloat(), box.top.toFloat(), box.right.toFloat(), box.bottom.toFloat(), r)
  }

  override fun setAlpha(alpha: Int) {}
  override fun setColorFilter(colorFilter: ColorFilter?) {}
  @Deprecated("Deprecated in Java")
  override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/** A round of clear glass under a plain button that keeps its own look and click (the reference's `IconButton` look
 *  for an existing view): the view's background becomes glass and it springs under the finger. */
object GlassBacking {
  /** `radius`: px; null = a round. Replaces the view's touch listener with the spring (the click is untouched). */
  fun put(view: View, scale: Float = 0.86f, radius: Float? = null, clear: Boolean = true): GlassDrawable {
    val glass = GlassDrawable(view, radius, clear)
    view.background = glass
    Bouncy.attach(view, scale)
    return glass
  }
}
