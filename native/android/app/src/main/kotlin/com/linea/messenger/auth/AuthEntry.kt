package com.linea.messenger.auth

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Typeface
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.method.PasswordTransformationMethod
import android.view.ActionMode
import android.view.DragEvent
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.autofill.AutofillValue
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.SymbolButton
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.settings.ThemeStore
import java.util.Locale

/** A text field that takes typing only: no paste, no menu, no autofill, nothing dropped on it (the reference's
 *  `ManualField`). */
class ManualEditText(context: Context) : EditText(context) {
  private val noMenu = object : ActionMode.Callback {
    override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean = false
    override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean = false
    override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?): Boolean = false
    override fun onDestroyActionMode(mode: ActionMode?) {}
  }

  init {
    customSelectionActionModeCallback = noMenu
    customInsertionActionModeCallback = noMenu
    isLongClickable = false
    importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
  }

  /** Fonts: the system turns a password field fixed-width and, when a field stops being one, puts the system's
   *  default face (Roboto) back — the field keeps the app's face through any change of its input type (the eye,
   *  the name field's capitals). */
  override fun setInputType(type: Int) {
    val face = typeface
    super.setInputType(type)
    if (face != null && typeface !== face) typeface = face
  }

  override fun onTextContextMenuItem(id: Int): Boolean = false

  override fun getAutofillType(): Int = View.AUTOFILL_TYPE_NONE

  override fun autofill(value: AutofillValue?) {}

  override fun onDragEvent(event: DragEvent?): Boolean = false
}

/** One field of the sign-in screen with its caption: a login, a name, a password or a secret word.
 *  What is typed lives only in the field; `value = ""` forgets it. */
@SuppressLint("ViewConstructor")
class AuthEntry(context: Context, caption: String, placeholder: String, private val secret: Boolean) : LinearLayout(context) {
  val field = ManualEditText(context)
  private val caption = context.words("", 11f, Theme.muted, 700)
  private val plate = FrameLayout(context)
  // The reference's `IconButton` eye-outline / eye-off-outline (23) on a clear glass round.
  private val eye = SymbolButton(context, "ion:eye-outline", 23f, Theme.muted).apply { background = com.linea.messenger.design.GlassDrawable(this) }
  private val refusal = context.words("Введи по одному символу. Вставка и автозаполнение отключены.", 11f, Theme.muted)
  private var captionText = caption

  /** The longest text taken, in UTF-16 units; 0 — any. */
  var limit = 0
  /** Spaces are not taken at all (the @username). */
  var noSpaces = false
  var onReturn: (() -> Unit)? = null
  /** Whether an empty field starts out showing what is typed (a secret being created) or hiding it. */
  var shownWhenEmpty = false

  /** What the field holds now, as far as typing is concerned: a change that is not typing goes back to it. */
  private var accepted = ""
  private var caretBefore = 0
  /** The text is being set by the screen itself, not typed. */
  private var setting = false

  var value: String
    get() = this.field.text.toString()
    set(next) {
      put(next, next.length)
      if (next.isEmpty()) {
        refusal.visibility = View.GONE
        reveal(shownWhenEmpty)
      }
    }

  /** Whether what is typed is behind dots now. */
  val hidden: Boolean get() = this.field.transformationMethod is PasswordTransformationMethod

  /** The placeholder as given; the field shows it shortened with «…» when it is wider than the field (the iPhone's),
   *  not cut mid-letter under the eye — an EditText never ellipsizes its hint by itself. */
  private var placeholderText = ""

  init {
    orientation = VERTICAL
    // ManualField.tsx:45-47,59: the caption spaced out by 1 and 2 in; a glass plate with radius 18 and its rim (1.4
    // in the accent while the field has the keyboard); the words 16, 17 from the sides.
    this.caption.letterSpacing = 1f / 11f
    this.caption.setPadding(context.px(2f), 0, 0, 0)
    paintPlate(false)
    field.setOnFocusChangeListener { _, focused -> paintPlate(focused) }

    field.textSize = 16f
    field.setTextColor(Theme.text)
    field.setHintTextColor(Theme.subtle)
    field.background = null
    field.setPadding(0, 0, 0, 0)
    field.isSingleLine = true
    field.gravity = Gravity.CENTER_VERTICAL
    // A plain line: nothing is corrected, capitalised, suggested or learnt; a secret is marked as one for the keyboard.
    field.inputType = InputType.TYPE_CLASS_TEXT or (if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
    field.imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
    // A hidden field would otherwise take the fixed-width font.
    field.typeface = Theme.weight(400)
    field.setOnEditorActionListener { _, _, _ -> onReturn?.invoke(); true }
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) { if (!setting) caretBefore = field.selectionStart.coerceAtLeast(0) }
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { if (!setting) typed(s?.toString() ?: "") }
    })
    field.addOnLayoutChangeListener { _, left, _, right, _, oldLeft, _, oldRight, _ -> if (right - left != oldRight - oldLeft) field.post { fitHint() } }
    plate.addView(field, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply {
      leftMargin = context.px(17f); rightMargin = context.px(if (secret) 54f else 17f)
    })

    eye.visibility = if (secret) View.VISIBLE else View.GONE
    eye.setOnClickListener { reveal(hidden) }
    plate.addView(eye, FrameLayout.LayoutParams(context.px(44f), context.px(44f), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = context.px(5f) })

    refusal.visibility = View.GONE
    refusal.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE

    addView(this.caption, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(plate, LayoutParams(LayoutParams.MATCH_PARENT, context.px(54f)).apply { topMargin = context.px(8f) })
    addView(refusal, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(8f) })
    set(caption, placeholder)
    reveal(!secret)
  }

  private fun paintPlate(focused: Boolean) {
    plate.background = context.plate(Theme.surface2, 18f).apply {
      if (focused) setStroke(Math.round(1.4f * resources.displayMetrics.density), Theme.accent)
      else setStroke(context.px(1f), ThemeStore.look.glassBorder)
    }
  }

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    field.isEnabled = enabled
    eye.isEnabled = enabled
    plate.alpha = if (enabled) 1f else 0.55f
  }

  fun set(caption: String, placeholder: String) {
    captionText = caption
    this.caption.text = caption.uppercase(Locale.ROOT)
    field.contentDescription = caption
    placeholderText = placeholder
    fitHint()
    updateEye()
  }

  private fun fitHint() {
    val room = field.width - field.totalPaddingLeft - field.totalPaddingRight
    val shown = if (room <= 0) placeholderText else android.text.TextUtils.ellipsize(placeholderText, field.paint, room.toFloat(), android.text.TextUtils.TruncateAt.END).toString()
    if (field.hint?.toString() != shown) field.hint = shown
  }

  /** Shows what is typed, or hides it behind dots. A secret being created is typed once, so it is shown while
   *  typed; the eye hides it. */
  fun reveal(shown: Boolean) {
    val hide = secret && !shown
    if (hidden != hide) {
      val caret = field.selectionStart.coerceAtLeast(0)
      setting = true
      field.transformationMethod = if (hide) PasswordTransformationMethod.getInstance() else null
      setting = false
      field.setSelection(caret.coerceAtMost(field.text.length))
    }
    updateEye()
  }

  private fun updateEye() {
    eye.symbol = if (hidden) "ion:eye-outline" else "ion:eye-off-outline"
    eye.contentDescription = (if (hidden) "Показать" else "Скрыть") + ": " + captionText.lowercase(Locale.ROOT)
  }

  private fun put(text: String, caret: Int) {
    setting = true
    field.setText(text)
    field.setSelection(caret.coerceIn(0, text.length))
    setting = false
    accepted = text
  }

  /** Every change is judged here: an insertion of more than one symbol at once (a paste, an autofill, a
   *  dictation) is turned back; so is a space where none is taken, and what is over the limit. */
  private fun typed(next: String) {
    if (next == accepted) return
    val byHand = AuthRules.typedByHand(accepted, next)
    val refused = !byHand || (noSpaces && next.any { it.isWhitespace() }) || (limit > 0 && next.length > limit)
    if (refused) {
      put(accepted, caretBefore)
      // The keyboard may still hold the words it tried to put in.
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.restartInput(field)
      if (!byHand) {
        refusal.visibility = View.VISIBLE
        announceForAccessibility(refusal.text)
      }
      return
    }
    accepted = next
    refusal.visibility = View.GONE
    if (next.isEmpty()) reveal(shownWhenEmpty)
  }
}

/** A few words in a plate: something the person should know, or (in the danger colour) something that went wrong. */
@SuppressLint("ViewConstructor")
class AuthNotice(context: Context, error: Boolean) : FrameLayout(context) {
  private val label = context.words("", 13f, if (error) Theme.danger else Theme.text)

  var words: String
    get() = label.text.toString()
    set(value) {
      label.text = value
      visibility = if (value.isEmpty()) View.GONE else View.VISIBLE
    }

  init {
    background = context.plate(if (error) Theme.alpha(Theme.danger, 0.12f) else Theme.surface2, 16f)
    setPadding(context.px(14f), context.px(13f), context.px(14f), context.px(13f))
    addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    if (error) accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    visibility = View.GONE
  }

  /** The reference's box on the login step (AuthScreen.tsx:329): an Ionicons glyph (18, the accent) left of the words,
   *  13 inside, 10 between; `accentSoft` with a `border` rim, radius 16; the words 13 on lines of 19. */
  fun mark(icon: String) {
    background = context.plate(ThemeStore.look.accentSoft, 16f).apply { setStroke(context.px(1f), ThemeStore.look.border) }
    setPadding(context.px(13f), context.px(13f), context.px(13f), context.px(13f))
    val glyph = ImageView(context)
    glyph.setImageDrawable(IonIcon.drawable(context, icon, context.px(18f), Theme.accent))
    glyph.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(glyph, LayoutParams(context.px(18f), context.px(18f), Gravity.START or Gravity.TOP))
    (label.layoutParams as LayoutParams).leftMargin = context.px(28f)
    if (android.os.Build.VERSION.SDK_INT >= 28) label.lineHeight = context.px(19f)
  }
}
