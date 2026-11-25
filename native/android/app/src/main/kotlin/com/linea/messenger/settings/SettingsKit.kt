package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.text.method.PasswordTransformationMethod
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.auth.ManualEditText
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.BusyButton
import com.linea.messenger.design.Glass
import com.linea.messenger.design.makeClear
import com.linea.messenger.design.GlassHeaderView
import com.linea.messenger.design.GlassRoundButton
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.SymbolButton
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.Screen
import java.time.ZoneId
import java.util.Locale

/** What the pages of the settings are made of: the page itself (its own header, a column that scrolls), a group
 *  of rows on a card, a row, a switch, a choice of several, a notice, a button, a field.
 *  In the colours of the theme that is on (ThemeStore.kt). */
object SettingsLook {
  val card: Int get() = Theme.surface2
  val line: Int get() = Theme.veil(0.08f)
  val chip: Int get() = Theme.veil(0.07f)
  val dangerChip: Int get() = Theme.alpha(Theme.danger, 0.14f)
  val pressed: Int get() = Theme.veil(0.07f)
  /** The reference's ThemeSwitch (components.tsx): the track is the theme's accent when on, green (#34C77B) when the
   *  accent is pale (every channel above 190: «Чёрная», «Графит» …), and the theme's `subtle` when off. */
  val switchOn: Int get() = switchOn(Theme.accent)
  val switchOff: Int get() = Theme.subtle

  /** The «on» track for an accent (pure: tested). */
  fun switchOn(accent: Int): Int {
    val opaque = (accent ushr 24) == 255
    val pale = opaque && ((accent shr 16) and 255) > 190 && ((accent shr 8) and 255) > 190 && (accent and 255) > 190
    return if (pale) 0xFF34C77B.toInt() else accent
  }

  /** A switch in the reference's colours: a pill track (`switchOn` / the `subtle` track), a white thumb, the
   *  iPhone's proportions (51 × 31, the thumb 27). */
  fun paint(toggle: Switch) {
    val c = toggle.context
    fun pill(color: Int) = android.graphics.drawable.GradientDrawable().apply {
      setColor(color); cornerRadius = c.px(15.5f).toFloat(); setSize(c.px(51f), c.px(31f))
    }
    val track = android.graphics.drawable.StateListDrawable()
    track.addState(intArrayOf(android.R.attr.state_checked), pill(switchOn))
    track.addState(intArrayOf(), pill(switchOff))
    val knob = android.graphics.drawable.GradientDrawable().apply {
      shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(0xFFFFFFFF.toInt()); setSize(c.px(27f), c.px(27f))
    }
    toggle.trackDrawable = track
    toggle.thumbDrawable = android.graphics.drawable.InsetDrawable(knob, c.px(2f))
    toggle.trackTintList = null
    toggle.thumbTintList = null
    toggle.showText = false
    toggle.switchMinWidth = c.px(51f)
  }

  /** `inner` with room around it, dp. */
  fun inset(inner: View, top: Float = 0f, side: Float = 0f, bottom: Float = 0f): FrameLayout = FrameLayout(inner.context).apply {
    setPadding(context.px(side), context.px(top), context.px(side), context.px(bottom))
    addView(inner, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
  }

  /** Words with the reference's exact line height and letter spacing. */
  fun para(context: Context, text: String, size: Float, color: Int, weight: Int = 400, line: Float = 0f, kern: Float = 0f, centered: Boolean = false): TextView =
    context.words(text, size, color, weight).apply {
      if (line > 0f && Build.VERSION.SDK_INT >= 28) lineHeight = context.px(line)
      if (kern != 0f) letterSpacing = kern / size
      if (centered) gravity = Gravity.CENTER_HORIZONTAL
    }

  /** The reference's `SectionLabel` (components.tsx): 10 Bold, letter spacing 1.65, `muted`, upper case, 2 in. */
  fun sectionLabel(context: Context, text: String): View {
    val label = context.words(text.uppercase(Locale.ROOT), 10f, Theme.muted, 700)
    label.letterSpacing = 1.65f / 10f
    if (Build.VERSION.SDK_INT >= 28) label.isAccessibilityHeading = true
    return inset(label, side = 2f)
  }

  /** A card of glass (GlassSurface: `radius`, `padding` inside, `gap` between the parts; `labelled`: the first part is a
   *  SectionLabel with its 13 of margin on top of the gap). `clear`: `material="clear"`. */
  fun glassCard(context: Context, parts: List<View>, radius: Float = 28f, padding: Float = 20f, gap: Float = 15f, clear: Boolean = false, labelled: Boolean = false): LinearLayout =
    GlassCard(context, radius, clear).apply {
      setPadding(context.px(padding), context.px(padding), context.px(padding), context.px(padding))
      parts.forEachIndexed { index, part ->
        (part.parent as? android.view.ViewGroup)?.removeView(part)
        val above = if (index == 0) 0f else if (index == 1 && labelled) gap + 13f else gap
        addView(part, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(above) })
      }
    }

  /** The quiet name above a group. */
  fun caption(context: Context, text: String): View {
    val label = context.words(text.uppercase(Locale.ROOT), 11f, Theme.muted, if (ThemeStore.look.black) 500 else 700)
    label.letterSpacing = 0.1f
    if (Build.VERSION.SDK_INT >= 28) label.isAccessibilityHeading = true
    return inset(label, top = 8f, side = 8f)
  }

  /** A few explaining words under a group. */
  fun foot(context: Context, text: String): View = inset(context.words(text, 12f, Theme.muted), side = 8f)

  fun rule(context: Context): View = View(context).apply { setBackgroundColor(line) }

  private val shortMonths = listOf("янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек.")
  private val longMonths = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

  private fun momentWords(text: String?, months: List<String>, zone: ZoneId): String? {
    val at = Messenger.date(text)?.atZone(zone) ?: return null
    return "${at.dayOfMonth} ${months[at.monthValue - 1]}, " + String.format(Locale.ROOT, "%02d:%02d", at.hour, at.minute)
  }

  /** «5 мар., 14:05» of a server time; «Неизвестно» when it is not a time. */
  fun moment(text: String?, zone: ZoneId = ZoneId.systemDefault()): String = momentWords(text, shortMonths, zone) ?: "Неизвестно"

  /** «5 марта, 14:05»; empty when it is not a time. */
  fun longMomentWords(text: String?, zone: ZoneId = ZoneId.systemDefault()): String = momentWords(text, longMonths, zone) ?: ""
}

/** A page of the settings. The root of the section has the large heading; every other page has a back button
 *  and its name. Subclasses fill `column` in `build()`, which is called once, when the page first comes to the
 *  window. */
open class SettingsPage(context: Context, private val pageName: String, private val large: Boolean = false) : Screen(context) {
  protected val scroll = ScrollView(context)
  protected val column = LinearLayout(context)
  protected val main = Handler(Looper.getMainLooper())
  private val heading = context.words(pageName, if (large) 34f else 20f, Theme.text, if (large) 700 else 600)
  private var sideAction: (() -> Unit)? = null
  /** A page whose reference has its own header and column (SecurityScreen.tsx); null: the settings `Page` look. */
  class OwnLook(val side: Float, val padding: Float, val minHeight: Float, val clear: Boolean, val titleSize: Float, val titleWeight: Int,
                val titleKern: Float, val mark: String, val markSize: Float, val markRoom: Float, val backLabel: String,
                val columnSide: Float, val columnTop: Float, val columnBottom: Float)
  /** Read while the page is made: a computed getter only. */
  protected open val ownLook: OwnLook? get() = null
  /** The reference: the root's column is 16 from the sides, a page's (`Page`, `padding: 14`) 14. */
  private val side: Float get() = ownLook?.columnSide ?: if (large) 16f else 14f
  private val bottomRoom: Float get() = ownLook?.columnBottom ?: 30f
  // B: the pages with a back button have the reference's header (SettingsScreen.tsx `Page`): a glass pill (radius 27,
  // 12 from the edges, at least 60 tall, 8 inside) with a round glass back button and the name; the list scrolls
  // under it (blurred there), with the page's colour fading in behind (tabInset.tsx `FloatingHeader`).
  private val behind = GlassSource(context)
  /** The page's own background as a glass source: the glass of the groups, notices, buttons and fields in the list
   *  blurs it (as the reference's GlassSurface blurs `PageBackdrop`), instead of drawing the dense plain fill. */
  val backdrop = GlassSource(context)
  private var header: GlassHeaderView? = null
  private var sideButton: GlassRoundButton? = null
  private val headerEdge = View(context)
  /** The navigation strip of a page without the tab bar: the list runs under it (`useBleed`) and fades into the page
   *  there, solid at the screen's bottom and gone 28 dp above the strip — nothing crisp under the gesture handle (the
   *  iPhone's scroll edge at the home indicator). */
  private val floorEdge = com.linea.messenger.shell.ScrollEdgeView(context, false).apply { reach = 28f; fade = 1000f; peak = 1f }

  /** D: false — a large page without its big name (the root of Settings: the profile head is its top, as in the
   *  reference's `Root`). The column keeps its place under the status bar; the list runs up under it. */
  protected open val showsHeading: Boolean get() = true
  private var dialog: Dialog? = null
  /** `build()` has been called. */
  protected var built = false
    private set

  init {
    setBackgroundColor(Theme.bg)
    // A touch on the page's own background goes no further (to the page under it while this one slides in).
    isClickable = true
    heading.maxLines = 1
    heading.gravity = Gravity.CENTER_VERTICAL
    heading.setAutoSizeTextTypeUniformWithConfiguration(if (large) 24 else 14, if (large) 34 else 20, 1, TypedValue.COMPLEX_UNIT_SP)
    // Fonts: the reference's page title in Unbounded (22 / 19 / 17 by length; the section's own title 30, as «Чаты»).
    val titleSize = if (large) com.linea.messenger.design.Theme.TypeSize.chatsTitle else com.linea.messenger.design.Theme.TypeSize.pageTitleSize(pageName)
    com.linea.messenger.design.Titles.title(heading, titleSize)
    heading.setAutoSizeTextTypeUniformWithConfiguration(Math.round(titleSize * 0.62f), Math.round(titleSize), 1, TypedValue.COMPLEX_UNIT_SP)
    if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
    backdrop.addView(View(context).apply { setBackgroundColor(Theme.bg) }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    backdrop.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    addView(backdrop)
    if (large && showsHeading) addView(heading)

    scroll.isVerticalScrollBarEnabled = false
    scroll.isFillViewport = true
    column.orientation = LinearLayout.VERTICAL
    column.setPadding(dp(side), dp(8f), dp(side), dp(bottomRoom))
    scroll.addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    if (large) {
      addView(scroll)
    } else {
      // The header is the page's first child (read first), drawn and touched above the list by its height (z).
      behind.addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      headerEdge.background = android.graphics.drawable.GradientDrawable(
        android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Theme.bg, Theme.alpha(Theme.bg, 0.85f), Theme.alpha(Theme.bg, 0f)))
      headerEdge.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      val own = ownLook
      val made = GlassHeaderView(context, pageName, titleSize = Theme.TypeSize.pageTitleSize(pageName), lineHeight = 28f, padding = own?.padding ?: 8f,
        minHeight = own?.minHeight ?: 60f, clear = own?.clear ?: false, back = { goBack() }, backLabel = own?.backLabel ?: "Назад")
      if (own != null) {
        made.titleLabel.setAutoSizeTextTypeWithDefaults(TextView.AUTO_SIZE_TEXT_TYPE_NONE)
        made.titleLabel.typeface = Theme.weight(own.titleWeight)
        made.titleLabel.textSize = own.titleSize
        made.titleLabel.letterSpacing = own.titleKern / own.titleSize
        if (own.mark.isNotEmpty()) made.setMark(own.mark, own.markSize, own.markRoom)
      }
      made.source = behind
      for (part in listOf<View>(made, headerEdge)) { part.outlineProvider = null; part.translationZ = if (part === made) 2f else 1f }
      addView(made)
      addView(headerEdge)
      addView(behind)
      floorEdge.outlineProvider = null; floorEdge.translationZ = 1f
      addView(floorEdge)
      header = made
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (!built) {
      built = true
      build()
    }
  }

  override fun onDetachedFromWindow() {
    dialog?.dismiss()
    dialog = null
    keyboard()?.hideSoftInputFromWindow(windowToken, 0)
    super.onDetachedFromWindow()
  }

  override fun place(width: Int, height: Int) {
    put(backdrop, 0, 0, width, height)
    val header = header
    if (large) {
      // The list goes under the bar at the bottom; the room for the bar is left under the last part.
      val barRoom = dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 12f)
      if (showsHeading) {
        put(heading, dp(20f), edges.top + dp(8f), width - dp(40f), dp(41f))
        if (column.paddingBottom != dp(bottomRoom) + barRoom) column.setPadding(dp(side), dp(8f), dp(side), dp(bottomRoom) + barRoom)
        val top = edges.top + dp(8f + 41f + 8f)
        put(scroll, 0, top, width, height - top)
      } else {
        // D: the column starts where it did under the big name (8 + 41 + 8 + 8 under the status bar).
        val first = edges.top + dp(8f + 41f + 8f + 8f)
        if (column.paddingBottom != dp(bottomRoom) + barRoom || column.paddingTop != first) column.setPadding(dp(side), first, dp(side), dp(bottomRoom) + barRoom)
        put(scroll, 0, 0, width, height)
      }
    } else if (header != null) {
      header.measure(MeasureSpec.makeMeasureSpec(width - dp(24f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      val own = ownLook
      val margin = own?.side ?: 12f
      header.measure(MeasureSpec.makeMeasureSpec(width - dp(2 * margin), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      put(header, dp(margin), edges.top + dp(12f), width - dp(2 * margin), header.measuredHeight)
      // The list starts 7 + 16 under the pill (`paddingTop: headerHeight + 16`, the header's margin 7 below); a page
      // of its own look: its margin (2) and its column's top.
      val below = edges.top + dp(12f) + header.measuredHeight + dp(if (own == null) 7f else 2f)
      val first = below + dp(own?.columnTop ?: 16f)
      // The page ends where the keyboard begins, so a field is never under it; without the keyboard it runs to the
      // screen's bottom, under the navigation bar (the reference's `useBleed`), and the column keeps the bar's room
      // below its last part (ending the page at the bar cut the list off with an empty strip below).
      val floor = if (edges.keyboard > 0) 0 else edges.bottom
      if (column.paddingTop != first || column.paddingBottom != dp(bottomRoom) + floor) column.setPadding(dp(side), first, dp(side), dp(bottomRoom) + floor)
      put(headerEdge, 0, 0, width, below)
      put(behind, 0, 0, width, height - edges.keyboard)
      floorEdge.color = Theme.bg
      floorEdge.place(width, if (edges.keyboard > 0) 0 else edges.bottom, height)
    }
  }

  /** Subclasses put their content into `column` here. */
  protected open fun build() {}

  protected fun keyboard(): InputMethodManager? = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

  /** The keyboard goes away and no field is being typed in. */
  protected fun endEditing() {
    findFocus()?.clearFocus()
    keyboard()?.hideSoftInputFromWindow(windowToken, 0)
  }

  /** The stack of pages this one is in. */
  protected val stack: Navigation?
    get() {
      var above = parent
      while (above != null && above !is Navigation) above = above.parent
      return above as? Navigation
    }

  /** Leaves the page, if it is the one on top. */
  fun goBack(animated: Boolean = true) {
    val pages = stack ?: return
    if (pages.top === this) { endEditing(); pages.pop(animated) }
  }

  /** An icon on the right of the header (pages with a back button only). */
  fun setSide(symbol: String, label: String, action: () -> Unit) {
    sideAction = action
    sideButton?.let { it.symbol = symbol; it.contentDescription = label; return }
    sideButton = header?.addTool(symbol, label, iconSize = if (symbol.startsWith("ion:")) 19f else 17f) { sideAction?.invoke() }
    requestLayout()
  }

  fun setSideEnabled(enabled: Boolean) {
    sideButton?.isEnabled = enabled
  }

  /** Takes everything out of the column (before it is filled again). */
  fun clear() {
    column.removeAllViews()
  }

  /** Adds a part to the column; `gap` is the room above it. */
  fun add(part: View, gap: Float = 8f) {
    (part.parent as? android.view.ViewGroup)?.removeView(part)
    column.addView(part, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      topMargin = if (column.childCount == 0) 0 else dp(gap)
    })
  }

  /** Adds a group of rows, with its quiet name above when it has one. */
  fun addGroup(label: String = "", rows: List<View>): SettingsGroup {
    val group = SettingsGroup(context, rows)
    if (label.isEmpty()) {
      add(group, 16f)
    } else {
      // The reference's `Group`: 16 between the parts of a page, 7 between the name and its card (the caption has 8 above).
      add(SettingsLook.caption(context, label), 8f)
      add(group, 7f)
    }
    return group
  }

  fun open(page: View, animated: Boolean = true) {
    endEditing()
    stack?.push(page, animated)
  }

  private fun present(made: AlertDialog.Builder): AlertDialog {
    dialog?.dismiss()
    val shown = made.show()
    dialog = shown
    return shown
  }

  /** A question with one action and «Отмена». */
  /** A question as the reference asks it: its `Sheet` (the title, the words 15 / line 22 in `muted`, 22 under them, and
   *  one `danger` Button), closed by its round button, a tap outside or a pull down. */
  fun confirm(heading: String, words: String, action: String, done: () -> Unit) {
    if (!isAttachedToWindow) return
    val button = SettingsButton(context, action, SettingsButton.Kind.DANGER)
    val sheet = com.linea.messenger.chatactions.ChoiceSheet(context, heading, "", emptyList(), listOf(SettingsLook.para(context, words, 15f, Theme.muted, line = 22f), button), 22f)
    button.onPress = { sheet.dismiss(); done() }
    sheet.show()
  }

  fun tell(words: String) {
    if (!isAttachedToWindow) return
    present(AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setMessage(words).setPositiveButton("Понятно", null))
  }

  /** A question of the page's own making (a choice of several). */
  protected fun ask(made: AlertDialog.Builder): AlertDialog? = if (isAttachedToWindow) present(made) else null

  /** The account is closed on this device: signing in is shown, with a few words why. */
  fun closeAccount(notice: String) {
    (context as? AccountHost)?.closeAccount(notice)
  }
}

/** The glass source of the settings page `view` is on (its backdrop), or null outside one. */
internal fun settingsBackdrop(view: View): GlassSource? {
  var at: android.view.ViewParent? = view.parent
  while (at != null) { if (at is SettingsPage) return at.backdrop; at = at.parent }
  return null
}

/** Rows on one card (the reference's `Group`, SettingsScreen.tsx). «Чёрная» (`black` themes): a flat card of the
 *  theme's `glassOpaque`, radius 12, a hairline `border` around it and between the rows from 57 in. Every other theme:
 *  a glass surface, radius 20, 2 above and below the rows, no lines between them. */
@SuppressLint("ViewConstructor")
class SettingsGroup(context: Context, rows: List<View>) : LinearLayout(context) {
  private val flat = ThemeStore.look.black
  private val glass = Glass(this)
  private val d = resources.displayMetrics.density

  init {
    orientation = VERTICAL
    val hairline = maxOf(1, context.px(0.5f))
    if (flat) {
      background = android.graphics.drawable.GradientDrawable().apply {
        setColor(ThemeStore.look.glassOpaque); cornerRadius = 12f * d; setStroke(hairline, ThemeStore.look.border)
      }
    } else {
      setWillNotDraw(false)
      setPadding(0, context.px(2f), 0, context.px(2f))
    }
    outlineProvider = object : android.view.ViewOutlineProvider() {
      override fun getOutline(view: View, outline: android.graphics.Outline) { outline.setRoundRect(0, 0, view.width, view.height, (if (flat) 12f else 20f) * d) }
    }
    clipToOutline = true
    rows.forEachIndexed { index, row ->
      if (index > 0 && flat) {
        val rule = View(context).apply { setBackgroundColor(ThemeStore.look.border) }
        addView(rule, LayoutParams(LayoutParams.MATCH_PARENT, hairline).apply { leftMargin = context.px(57f) })
      }
      (row.parent as? android.view.ViewGroup)?.removeView(row)
      addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    glass.source = settingsBackdrop(this)
  }

  override fun onDraw(canvas: Canvas) {
    if (!flat) glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 20f * d)
    super.onDraw(canvas)
  }
}

/** A vertical card of glass that blurs its settings page's backdrop (`SettingsLook.glassCard`). */
@SuppressLint("ViewConstructor")
class GlassCard(context: Context, private val radius: Float, clear: Boolean) : LinearLayout(context) {
  private val glass = Glass(this).let { if (clear) it.makeClear() else it }
  private val d = resources.displayMetrics.density

  init {
    orientation = VERTICAL
    setWillNotDraw(false)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    glass.source = settingsBackdrop(this)
  }

  override fun onDraw(canvas: Canvas) {
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), radius * d)
    super.onDraw(canvas)
  }
}

/** One row of a group: an icon in a quiet circle, a name, a value, an arrow. Pressing it calls `onPress`.
 *  `symbol`: one of `Symbols`. `swatch`: a dot of that colour. `checked`: one of several — the chosen one has a mark. */
@SuppressLint("ViewConstructor")
class SettingsRow(context: Context, symbol: String = "", private val label: String, value: String = "", danger: Boolean = false, arrow: Boolean = true,
                  swatch: Int? = null, checked: Boolean? = null) : LinearLayout(context) {
  var onPress: (() -> Unit)? = null
  private val nameLabel = context.words(label, 15f, if (danger) Theme.danger else Theme.text)
  private val valueLabel = context.words(value, 13f, Theme.muted)
  private var iconChip: View? = null

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(14f), context.px(7f), context.px(14f), context.px(7f))
    minimumHeight = context.px(48f)
    if (symbol.isNotEmpty()) {
      // The reference's `Item`: a 34 circle of rgba(255,255,255,0.07) (dark) / rgba(0,0,0,0.05) (light), `dangerBg` for
      // «Выйти»; the Ionicons glyph 18 square in it.
      val icon = SymbolView(context, symbol, 18f, if (danger) Theme.danger else Theme.text)
      icon.plate = if (danger) ThemeStore.look.dangerBg else Theme.veil(if (Theme.dark) 0.07f else 0.05f)
      iconChip = icon
      addView(icon, LayoutParams(context.px(34f), context.px(34f)).apply { rightMargin = context.px(13f) })
    }
    nameLabel.maxLines = 2
    nameLabel.ellipsize = TextUtils.TruncateAt.END
    addView(nameLabel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    valueLabel.maxLines = 1
    valueLabel.ellipsize = TextUtils.TruncateAt.END
    valueLabel.gravity = Gravity.END
    valueLabel.maxWidth = context.px(190f)
    valueLabel.visibility = if (value.isEmpty()) View.GONE else View.VISIBLE
    addView(valueLabel, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(13f) })
    if (swatch != null) {
      val dot = View(context)
      dot.background = context.plate(swatch, 10f)
      addView(dot, LayoutParams(context.px(20f), context.px(20f)).apply { leftMargin = context.px(13f) })
    }
    if (checked != null) {
      // One of several: the chosen one has a mark, the others an empty place of the same size.
      // The reference: `<View style={{ width: 22 }}>` holding Ionicons «checkmark» 20 in the accent.
      val mark = SymbolView(context, "ion:checkmark", 20f, Theme.accent)
      mark.alpha = if (checked) 1f else 0f
      addView(mark, LayoutParams(context.px(22f), context.px(20f)).apply { leftMargin = context.px(13f) })
      isSelected = checked
    } else if (arrow && !danger) {
      addView(SymbolView(context, "ion:chevron-forward", 17f, Theme.subtle), LayoutParams(context.px(17f), context.px(17f)).apply { leftMargin = context.px(13f) })
    }
    isClickable = true
    isFocusable = true
    contentDescription = if (value.isEmpty()) label else "$label: $value"
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  fun setValue(value: String) {
    valueLabel.text = value
    valueLabel.visibility = if (value.isEmpty()) View.GONE else View.VISIBLE
    contentDescription = if (value.isEmpty()) label else "$label: $value"
  }

  override fun setPressed(pressed: Boolean) {
    val was = isPressed
    super.setPressed(pressed)
    // The reference's `Item`: rgba(127,127,127,0.12) under the finger; the icon squishes to 0.82 (spring damping 14,
    // stiffness 420) and springs back (damping 9, stiffness 260).
    setBackgroundColor(if (pressed) 0x1F7F7F7F else 0)
    val chip = iconChip ?: return
    if (was == pressed) return
    // Mass 1: the damping ratio is c / (2√k); the spring settles (to a thousandth) in 13.8 / c seconds (shell/Spring.kt).
    val stiffness = if (pressed) 420f else 260f
    val damping = if (pressed) 14f else 9f
    val ratio = damping / (2f * Math.sqrt(stiffness.toDouble()).toFloat())
    val target = if (pressed) 0.82f else 1f
    chip.animate().cancel()
    chip.animate().scaleX(target).scaleY(target).setDuration(Math.round(13800f / damping).toLong())
      .setInterpolator(com.linea.messenger.shell.SpringCurve(ratio)).start()
  }

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    alpha = if (enabled) 1f else 0.5f
  }
}

/** A switch with its name and a few explaining words. */
@SuppressLint("ViewConstructor", "UseSwitchCompatOrMaterialCode")
class SettingsSwitchRow(context: Context, label: String, words: String, value: Boolean, enabled: Boolean = true, badge: String = "") : LinearLayout(context) {
  var onChange: ((Boolean) -> Unit)? = null
  private val toggle = Switch(context)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(14f), context.px(11f), context.px(14f), context.px(11f))
    val texts = LinearLayout(context)
    texts.orientation = VERTICAL
    val top = LinearLayout(context)
    top.orientation = HORIZONTAL
    top.gravity = Gravity.CENTER_VERTICAL
    top.addView(context.words(label, 15f, Theme.text), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    if (badge.isNotEmpty()) top.addView(paddedLabel(context, badge, 11f), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(7f) })
    texts.addView(top, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    // SettingsScreen.tsx:141 `Toggle`: the description is 12 on lines of 17.
    if (words.isNotEmpty()) texts.addView(SettingsLook.para(context, words, 12f, Theme.muted, line = 17f), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(3f) })
    addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))

    SettingsLook.paint(toggle) // E: the reference's switch colours
    toggle.isChecked = value
    toggle.isEnabled = enabled
    toggle.contentDescription = label
    toggle.setOnCheckedChangeListener { _, on -> onChange?.invoke(on) }
    addView(toggle, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(12f) })
    if (!enabled) toggle.alpha = 0.5f
  }

  companion object {
    /** A label with a little room around its words (a badge). */
    fun paddedLabel(context: Context, text: String, size: Float): TextView = context.words(text, size, Theme.text, 700).apply {
      background = context.plate(SettingsLook.chip, 8f)
      setPadding(context.px(7f), context.px(2f), context.px(7f), context.px(2f))
      maxLines = 1
    }
  }
}

/** One of several, side by side: the chosen one is filled. */
@SuppressLint("ViewConstructor")
class SettingsSegments(context: Context, labels: List<String>, chosen: Int, enabled: Boolean = true, spoken: String = "") : LinearLayout(context) {
  var onPick: ((Int) -> Unit)? = null

  init {
    orientation = HORIZONTAL
    background = context.plate(SettingsLook.chip, 14f)
    setPadding(context.px(3f), context.px(3f), context.px(3f), context.px(3f))
    labels.forEachIndexed { index, label ->
      val on = index == chosen
      val button = context.words(label, 13f, if (on) Theme.onAccent else Theme.text, if (on) 700 else 500)
      button.gravity = Gravity.CENTER
      button.maxLines = 1
      button.background = if (on) context.plate(Theme.accent, 11f) else null
      button.isEnabled = enabled
      button.isClickable = true
      button.isFocusable = true
      button.isSelected = on
      button.contentDescription = if (spoken.isEmpty()) label else "$spoken: $label"
      button.setOnClickListener { onPick?.invoke(index) }
      addView(button, LayoutParams(0, context.px(36f), 1f))
    }
  }
}

/** A few words on a plate: something happened, or something went wrong (then it can offer to try again). */
@SuppressLint("ViewConstructor")
/** The reference's `Notice` (components.tsx): glass, radius 18, 14 inside; Ionicons «alert-circle-outline» (an error, in
 *  `danger` over `dangerBg`) or «information-circle-outline» (in the accent) 19, 10 to the words (13, line 19);
 *  «Повторить» on the right (12 Bold, the accent). */
class SettingsNotice(context: Context, text: String, error: Boolean = false, onRetry: (() -> Unit)? = null) : LinearLayout(context) {
  private val glass = Glass(this)
  private val d = resources.displayMetrics.density
  private val tint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = if (error) ThemeStore.look.dangerBg else 0 }

  init {
    orientation = HORIZONTAL
    gravity = Gravity.TOP
    setWillNotDraw(false)
    setPadding(context.px(14f), context.px(14f), context.px(14f), context.px(14f))
    addView(SymbolView(context, if (error) "ion:alert-circle-outline" else "ion:information-circle-outline", 19f, if (error) Theme.danger else Theme.accent),
      LayoutParams(context.px(19f), context.px(19f)).apply { rightMargin = context.px(10f) })
    val words = context.words(text, 13f, if (error) Theme.danger else Theme.text)
    words.setLineSpacing(0f, 1f)
    if (Build.VERSION.SDK_INT >= 28) words.lineHeight = context.px(19f)
    addView(words, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    if (onRetry != null) {
      val again = context.words("Повторить", 12f, Theme.accent, 700)
      again.gravity = Gravity.CENTER_VERTICAL
      again.minHeight = context.px(28f)
      again.isClickable = true
      again.isFocusable = true
      again.setOnClickListener { onRetry() }
      addView(again, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(10f) })
    }
    if (error) accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    glass.source = settingsBackdrop(this)
  }

  override fun onDraw(canvas: Canvas) {
    val r = 18f * d
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), r)
    if (tint.color != 0) canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, tint)
    super.onDraw(canvas)
  }
}

/** A wide button: the reference's `Button` (components.tsx) — 54 tall, radius 21; the main one is the theme's
 *  `accentGradient` (opacity 0.96) with a white shine and a 1 border; the quiet one glass; the dangerous one `dangerBg`.
 *  The label 16 Bold, letter spacing −0.15; an Ionicons `icon` 20, 10 before it. Pressed it springs to 0.96. */
@SuppressLint("ViewConstructor")
class SettingsButton(context: Context, label: String, kind: Kind = Kind.PRIMARY, icon: String = "") : BusyButton(context, label,
  fill = when (kind) { Kind.PRIMARY -> Theme.accent; Kind.SECONDARY -> Glass.DARK_PLAIN; Kind.DANGER -> ThemeStore.look.dangerBg },
  ink = when (kind) { Kind.PRIMARY -> Theme.onAccent; Kind.SECONDARY -> Theme.text; Kind.DANGER -> Theme.danger },
  radius = 21f, textSize = 16f, weight = 700) {
  enum class Kind { PRIMARY, SECONDARY, DANGER }
  private val glass = Glass(this)
  private val quiet = kind == Kind.SECONDARY

  init {
    val d = resources.displayMetrics.density
    minimumHeight = context.px(54f)
    setPadding(context.px(21f), 0, context.px(21f), 0)
    when (kind) {
      Kind.PRIMARY -> {
        val colors = ThemeStore.look.accentGradient.ifEmpty { listOf(Theme.accent, Theme.accent) }
        val body = android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TL_BR, colors.toIntArray()).apply {
          cornerRadius = 21f * d; alpha = Math.round(0.96f * 255)
        }
        val shine = android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TL_BR, intArrayOf(0x38FFFFFF, 0x00FFFFFF)).apply {
          cornerRadius = 21f * d
          setStroke(maxOf(1, context.px(1f)), if (Theme.dark) 0x94EBF5FF.toInt() else 0x59FFFFFF)
        }
        background = android.graphics.drawable.LayerDrawable(arrayOf(body, shine))
      }
      Kind.SECONDARY -> { background = null; setWillNotDraw(false) }
      Kind.DANGER -> {}
    }
    for (index in 0 until childCount) {
      val child = getChildAt(index)
      if (child is TextView) child.letterSpacing = -0.15f / 16f
    }
    if (icon.isNotEmpty()) {
      val name = if (icon.startsWith("ion:")) icon else "ion:$icon"
      val ink = when (kind) { Kind.PRIMARY -> Theme.onAccent; Kind.SECONDARY -> Theme.text; Kind.DANGER -> Theme.danger }
      addView(SymbolView(context, name, 20f, ink), childCount - 1, LayoutParams(context.px(20f), context.px(20f)).apply { marginEnd = context.px(10f) })
    }
    com.linea.messenger.chatlook.Bouncy.attach(this, 0.96f)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    glass.source = settingsBackdrop(this)
  }

  override fun onDraw(canvas: Canvas) {
    if (quiet) glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 21f * resources.displayMetrics.density)
    super.onDraw(canvas)
  }

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    alpha = if (enabled) 1f else 0.45f
  }
}

/** The pair under a colour grid, «Как в теме» / «Свой цвет» (the reference's ColorSettings): 44 tall, radius 14,
 *  the label 15 Semibold in the text colour; the one that is on is `accentSoft` with an accent rim, the other
 *  `surface2` with the border. */
@SuppressLint("ViewConstructor")
class ColorChoiceButton(context: Context, label: String, on: Boolean) : TextView(context) {
  var onPress: (() -> Unit)? = null

  init {
    val d = resources.displayMetrics.density
    text = label
    setTextColor(Theme.text)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    typeface = Theme.weight(700)
    gravity = Gravity.CENTER
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    minHeight = context.px(44f)
    background = android.graphics.drawable.GradientDrawable().apply {
      cornerRadius = 14f * d
      setColor(if (on) ThemeStore.look.accentSoft else Theme.surface2)
      setStroke(maxOf(1, context.px(1f)), if (on) Theme.accent else ThemeStore.look.border)
    }
    isSelected = on
    isClickable = true
    isFocusable = true
    contentDescription = label
    setOnClickListener { onPress?.invoke() }
  }
}

/** One line of typing with its caption. A secret is hidden while typed (the eye shows it) and is typed by hand
 *  only: no paste, as in the reference. */
@SuppressLint("ViewConstructor")
class SettingsField(context: Context, caption: String, placeholder: String, private val secret: Boolean = false) : LinearLayout(context) {
  val input: EditText = if (secret) ManualEditText(context) else EditText(context)
  /** The longest text the field takes (0: any). */
  var limit = 0
  /** Only these symbols are taken (null: any). */
  var allowed: ((Char) -> Boolean)? = null
  var onReturn: (() -> Unit)? = null
  var onEdit: (() -> Unit)? = null
  private val eye = SymbolButton(context, "ion:eye-outline", 23f, Theme.muted)
  private var setting = false

  var value: String
    get() = input.text.toString()
    set(next) {
      setting = true
      input.setText(next)
      input.setSelection(input.text.length)
      setting = false
    }

  init {
    orientation = VERTICAL
    if (caption.isNotEmpty()) {
      val name = context.words(caption.uppercase(Locale.ROOT), 11f, Theme.muted, 700)
      name.letterSpacing = 0.09f
      addView(SettingsLook.inset(name, side = 2f), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = context.px(8f) })
    }
    // The reference's ManualField: regular glass, radius 18, at least 54 tall, 17 inside, a 1.4 accent border while typing.
    val d = resources.displayMetrics.density
    val plate = object : FrameLayout(context) {
      private val glass = Glass(this)
      private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.4f * d; color = Theme.accent }
      init { setWillNotDraw(false) }
      override fun onAttachedToWindow() { super.onAttachedToWindow(); glass.source = settingsBackdrop(this) }
      override fun onDraw(canvas: Canvas) {
        glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 18f * d)
        if (input.isFocused) { val h = ring.strokeWidth / 2; canvas.drawRoundRect(h, h, width - h, height - h, 18f * d - h, 18f * d - h, ring) }
        super.onDraw(canvas)
      }
    }
    input.setOnFocusChangeListener { _, _ -> plate.invalidate() }
    input.textSize = 16f
    input.setTextColor(Theme.text)
    input.setHintTextColor(Theme.subtle)
    input.hint = placeholder
    input.background = null
    input.setPadding(0, 0, 0, 0)
    input.isSingleLine = true
    input.gravity = Gravity.CENTER_VERTICAL
    // Nothing is corrected, capitalised or suggested.
    input.inputType = InputType.TYPE_CLASS_TEXT or (if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
    input.imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI or (if (secret) EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING else 0)
    input.typeface = Theme.weight(400) // Montserrat, as every text of the reference
    input.contentDescription = caption.ifEmpty { placeholder }
    input.filters = arrayOf(InputFilter { source, start, end, dest, dstart, dend ->
      // A change that is not taken leaves what was there.
      val only = allowed
      if (only != null && (start until end).any { !only(source[it]) }) return@InputFilter dest.subSequence(dstart, dend)
      if (limit > 0 && dest.length - (dend - dstart) + (end - start) > limit) return@InputFilter dest.subSequence(dstart, dend)
      null
    })
    input.setOnEditorActionListener { _, _, _ ->
      val action = onReturn
      if (action != null) action() else {
        input.clearFocus()
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(input.windowToken, 0)
      }
      true
    }
    input.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { if (!setting) onEdit?.invoke() }
    })
    plate.addView(input, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply {
      leftMargin = context.px(17f); rightMargin = context.px(if (secret) 58f else 17f)
    })
    eye.contentDescription = "Показать"
    eye.visibility = if (secret) View.VISIBLE else View.GONE
    eye.setOnClickListener { eyePressed() }
    // SecretInput: the eye is the reference's IconButton — a 44 round of clear glass, 5 from the top and the right.
    eye.background = object : android.graphics.drawable.Drawable() {
      private val round = Glass(eye).makeClear()
      override fun draw(canvas: Canvas) { val b = bounds; round.draw(canvas, b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), b.bottom.toFloat(), b.height() / 2f) }
      override fun setAlpha(alpha: Int) {}
      override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) {}
      @Deprecated("Deprecated in Java") override fun getOpacity(): Int = android.graphics.PixelFormat.TRANSLUCENT
    }
    plate.addView(eye, FrameLayout.LayoutParams(context.px(44f), context.px(44f), Gravity.END or Gravity.TOP).apply { rightMargin = context.px(5f); topMargin = context.px(5f) })
    addView(plate, LayoutParams(LayoutParams.MATCH_PARENT, context.px(54f)))
  }

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    input.isEnabled = enabled
    eye.isEnabled = enabled
    alpha = if (enabled) 1f else 0.6f
  }

  private fun eyePressed() {
    val hidden = input.transformationMethod is PasswordTransformationMethod
    val caret = input.selectionStart.coerceAtLeast(0)
    setting = true
    input.transformationMethod = if (hidden) null else PasswordTransformationMethod.getInstance()
    setting = false
    input.setSelection(caret.coerceAtMost(input.text.length))
    eye.symbol = if (hidden) "ion:eye-off-outline" else "ion:eye-outline"
    eye.contentDescription = if (hidden) "Скрыть" else "Показать"
  }
}

/** Several lines of typing (the words about oneself), with the quiet hint while it is empty. */
@SuppressLint("ViewConstructor")
class SettingsTextArea(context: Context, placeholder: String) : FrameLayout(context) {
  private val area = EditText(context)
  var limit = 0
  var onEdit: (() -> Unit)? = null
  private var setting = false

  var value: String
    get() = area.text.toString()
    set(next) {
      setting = true
      area.setText(next)
      setting = false
    }

  init {
    background = context.plate(SettingsLook.card, 14f, SettingsLook.line)
    area.background = null
    area.textSize = 16f
    area.setTextColor(Theme.text)
    area.setHintTextColor(Theme.subtle)
    area.hint = placeholder
    area.contentDescription = placeholder
    area.gravity = Gravity.TOP or Gravity.START
    area.minHeight = context.px(50f)
    area.setPadding(context.px(15f), context.px(13f), context.px(15f), context.px(13f))
    area.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    area.filters = arrayOf(InputFilter { _, start, end, dest, dstart, dend ->
      if (limit > 0 && dest.length - (dend - dstart) + (end - start) > limit) dest.subSequence(dstart, dend) else null
    })
    area.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { if (!setting) onEdit?.invoke() }
    })
    addView(area, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
  }

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    area.isEnabled = enabled
    alpha = if (enabled) 1f else 0.6f
  }
}

/** A person as a round lit ball of their colour with their initials — or their picture, once it is here. */
class SettingsAvatar(context: Context) : View(context) {
  private var rgb = 0x5E7BFF
  private var letters = ""
  private var pictureKey = ""
  private var pictureAddress = ""
  private val orb = com.linea.messenger.design.AvatarOrb(resources.displayMetrics.density)
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val matrix = Matrix()

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  /** `person`: a user as the server gives it (`displayName`, `avatarColor`, `avatarId`); `base`: the server its
   *  picture is asked from (empty: never asked). */
  fun show(person: Map<String, Any?>, base: String) {
    letters = Messenger.initials(person["displayName"] as? String ?: "")
    rgb = Messenger.color(person["avatarColor"] as? String)
    val id = person["avatarId"] as? String ?: ""
    pictureKey = if (base.isEmpty()) "" else id
    pictureAddress = if (pictureKey.isEmpty()) "" else base + "/files/" + Messenger.pathPart(id)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0 || h <= 0) return
    val r = minOf(w, h) / 2
    // Asked again on every drawing: the store keeps it in memory, and tells this view when it has come.
    val face: Bitmap? = if (pictureKey.isEmpty()) null else AvatarStore.get(context, pictureKey, pictureAddress, this)
    if (face != null && face.width > 0 && face.height > 0) {
      val scale = maxOf(w / face.width, h / face.height)
      matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate((w - face.width * scale) / 2, (h - face.height * scale) / 2)
      picture.shader = BitmapShader(face, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(matrix) }
      canvas.drawCircle(w / 2, h / 2, r, picture)
      picture.shader = null
      return
    }
    // The reference's `Avatar` (components.tsx:150): the lit ball, its highlight, the initials (design/AvatarOrb.kt).
    orb.draw(canvas, w / 2 - r, h / 2 - r, 2 * r, rgb, letters)
  }
}
