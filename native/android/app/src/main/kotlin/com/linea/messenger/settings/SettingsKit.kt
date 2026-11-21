package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
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
import com.linea.messenger.design.SymbolButton
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.orbPair
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.Screen
import java.time.ZoneId
import java.util.Locale

/** What the pages of the settings are made of: the page itself (its own header, a column that scrolls), a group
 *  of rows on a card, a row, a switch, a choice of several, a notice, a button, a field.
 *  The black look only, as the rest of the app for now. */
object SettingsLook {
  const val card = Theme.surface2
  const val line = 0x14FFFFFF
  const val chip = 0x12FFFFFF
  const val dangerChip = 0x24FF9CB0
  const val pressed = 0x12FFFFFF
  const val switchOn = 0xFF5E7BFF.toInt()

  /** `inner` with room around it, dp. */
  fun inset(inner: View, top: Float = 0f, side: Float = 0f, bottom: Float = 0f): FrameLayout = FrameLayout(inner.context).apply {
    setPadding(context.px(side), context.px(top), context.px(side), context.px(bottom))
    addView(inner, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
  }

  /** The quiet name above a group. */
  fun caption(context: Context, text: String): View {
    val label = context.words(text.uppercase(Locale.ROOT), 11f, Theme.muted, 500)
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
  private val backButton = SymbolButton(context, "chevron.left", 24f, Theme.text)
  private val sideButton = SymbolButton(context, "", 21f, Theme.text)
  private var sideAction: (() -> Unit)? = null
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
    if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
    addView(heading)

    scroll.isVerticalScrollBarEnabled = false
    scroll.isFillViewport = true
    column.orientation = LinearLayout.VERTICAL
    column.setPadding(dp(16f), dp(8f), dp(16f), dp(28f))
    scroll.addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(scroll)

    if (!large) {
      backButton.contentDescription = "Назад"
      backButton.setOnClickListener { goBack() }
      addView(backButton)
      sideButton.visibility = View.GONE
      sideButton.setOnClickListener { sideAction?.invoke() }
      addView(sideButton)
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
    if (large) {
      put(heading, dp(20f), edges.top + dp(8f), width - dp(40f), dp(41f))
      // The list goes under the bar at the bottom; the room for the bar is left under the last part.
      val barRoom = dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 12f)
      if (column.paddingBottom != dp(28f) + barRoom) column.setPadding(dp(16f), dp(8f), dp(16f), dp(28f) + barRoom)
      val top = edges.top + dp(8f + 41f + 8f)
      put(scroll, 0, top, width, height - top)
    } else {
      val top = edges.top + dp(4f)
      put(backButton, dp(6f), top, dp(44f), dp(44f))
      val side = sideButton.visibility == View.VISIBLE
      if (side) put(sideButton, width - dp(6f + 44f), top, dp(44f), dp(44f))
      put(heading, dp(6f + 44f + 2f), top, width - dp(6f + 44f + 2f) - (if (side) dp(6f + 44f + 8f) else dp(20f)), dp(44f))
      // The page ends where the keyboard begins, so a field is never under it.
      val from = top + dp(44f + 4f)
      put(scroll, 0, from, width, height - from - maxOf(edges.keyboard, edges.bottom))
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
    sideButton.symbol = symbol
    sideButton.contentDescription = label
    sideButton.visibility = View.VISIBLE
    sideAction = action
    requestLayout()
  }

  fun setSideEnabled(enabled: Boolean) {
    sideButton.isEnabled = enabled
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
      add(SettingsLook.caption(context, label), 14f)
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
  fun confirm(heading: String, words: String, action: String, done: () -> Unit) {
    if (!isAttachedToWindow) return
    present(AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle(heading).setMessage(words)
      .setNegativeButton("Отмена", null).setPositiveButton(action) { _, _ -> done() })
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

/** Rows on one card, a hairline between them. */
@SuppressLint("ViewConstructor")
class SettingsGroup(context: Context, rows: List<View>) : LinearLayout(context) {
  init {
    orientation = VERTICAL
    background = context.plate(SettingsLook.card, 12f, SettingsLook.line)
    clipToOutline = true
    rows.forEachIndexed { index, row ->
      if (index > 0) addView(SettingsLook.rule(context), LayoutParams(LayoutParams.MATCH_PARENT, maxOf(1, context.px(0.5f))))
      (row.parent as? android.view.ViewGroup)?.removeView(row)
      addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }
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

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(14f), context.px(7f), context.px(14f), context.px(7f))
    minimumHeight = context.px(48f)
    if (symbol.isNotEmpty()) {
      val icon = SymbolView(context, symbol, 18f, if (danger) Theme.danger else Theme.text)
      icon.plate = if (danger) SettingsLook.dangerChip else SettingsLook.chip
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
      val mark = SymbolView(context, "check", 18f, Theme.text)
      mark.alpha = if (checked) 1f else 0f
      addView(mark, LayoutParams(context.px(20f), context.px(20f)).apply { leftMargin = context.px(13f) })
      isSelected = checked
    } else if (arrow && !danger) {
      addView(SymbolView(context, "chevron.right", 13f, Theme.subtle), LayoutParams(context.px(14f), context.px(14f)).apply { leftMargin = context.px(13f) })
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
    super.setPressed(pressed)
    setBackgroundColor(if (pressed) SettingsLook.pressed else 0)
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
    if (words.isNotEmpty()) texts.addView(context.words(words, 12f, Theme.muted), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(3f) })
    addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))

    val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
    toggle.thumbTintList = ColorStateList(states, intArrayOf(0xFFFFFFFF.toInt(), 0xFFB4B7BD.toInt()))
    toggle.trackTintList = ColorStateList(states, intArrayOf(SettingsLook.switchOn, 0x40FFFFFF))
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
class SettingsNotice(context: Context, text: String, error: Boolean = false, onRetry: (() -> Unit)? = null) : LinearLayout(context) {
  init {
    orientation = VERTICAL
    background = context.plate(if (error) SettingsLook.dangerChip else SettingsLook.chip, 12f)
    setPadding(context.px(13f), context.px(11f), context.px(13f), context.px(11f))
    addView(context.words(text, 13f, if (error) Theme.danger else Theme.text), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    if (onRetry != null) {
      val again = context.words("Повторить", 13f, Theme.text, 600)
      again.gravity = Gravity.CENTER_VERTICAL
      again.minHeight = context.px(32f)
      again.isClickable = true
      again.isFocusable = true
      again.setOnClickListener { onRetry() }
      addView(again, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(6f) })
    }
    if (error) accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
  }
}

/** A wide button: the main one, a quiet one, or a dangerous one. It can show that it is busy. */
@SuppressLint("ViewConstructor")
class SettingsButton(context: Context, label: String, kind: Kind = Kind.PRIMARY) : BusyButton(context, label,
  fill = when (kind) { Kind.PRIMARY -> Theme.accent; Kind.SECONDARY -> SettingsLook.chip; Kind.DANGER -> SettingsLook.dangerChip },
  ink = when (kind) { Kind.PRIMARY -> Theme.onAccent; Kind.SECONDARY -> Theme.text; Kind.DANGER -> Theme.danger },
  radius = 14f) {
  enum class Kind { PRIMARY, SECONDARY, DANGER }
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
  private val eye = SymbolButton(context, "eye", 18f, Theme.muted)
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
    val plate = FrameLayout(context)
    plate.background = context.plate(SettingsLook.card, 14f, SettingsLook.line)
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
    input.typeface = Typeface.DEFAULT
    input.contentDescription = caption.ifEmpty { placeholder }
    input.filters = arrayOf(InputFilter { source, start, end, dest, dstart, dend ->
      val only = allowed
      if (only != null && (start until end).any { !only(source[it]) }) return@InputFilter ""
      if (limit > 0 && dest.length - (dend - dstart) + (end - start) > limit) return@InputFilter ""
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
      leftMargin = context.px(14f); rightMargin = context.px(if (secret) 48f else 14f)
    })
    eye.contentDescription = "Показать"
    eye.visibility = if (secret) View.VISIBLE else View.GONE
    eye.setOnClickListener { eyePressed() }
    plate.addView(eye, FrameLayout.LayoutParams(context.px(44f), context.px(44f), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = context.px(4f) })
    addView(plate, LayoutParams(LayoutParams.MATCH_PARENT, context.px(50f)))
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
    eye.symbol = if (hidden) "eye.slash" else "eye"
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
      if (limit > 0 && dest.length - (dend - dstart) + (end - start) > limit) "" else null
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
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textAlign = Paint.Align.CENTER; typeface = Theme.weight(700) }
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
    // The same lit ball as in the list of chats: the colour between a lighter and a deeper neighbour.
    val pair = orbPair(rgb)
    paint.shader = LinearGradient(w * 0.9f, h, w * 0.1f, 0f, intArrayOf(pair.first, 0xFF000000.toInt() or rgb, pair.second), null, Shader.TileMode.CLAMP)
    canvas.drawCircle(w / 2, h / 2, r, paint)
    paint.shader = LinearGradient(w * 0.12f, h * 0.02f, w * 0.7f, h * 0.8f, intArrayOf(0x6BFFFFFF, 0x0FFFFFFF, 0x00FFFFFF), floatArrayOf(0f, 0.38f, 0.6f), Shader.TileMode.CLAMP)
    canvas.drawCircle(w / 2, h / 2, r, paint)
    paint.shader = null
    text.textSize = w * 0.36f
    canvas.drawText(letters, w / 2, h / 2 - (text.descent() + text.ascent()) / 2, text)
  }
}
