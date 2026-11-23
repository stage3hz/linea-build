package com.linea.messenger.security

import android.animation.Keyframe
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.effects.Motion

/** The code entry shared by the lock screen and the passcode settings: four dots and a round pad for a 4-digit code,
 *  a password field otherwise; the whole thing shakes and clears on a wrong code. (The previous app:
 *  `mobile/src/lock/CodeEntry.tsx` — the same sizes, words and timings; iOS Security/CodeEntryView.swift.) */
@SuppressLint("ViewConstructor")
class CodeEntryView(context: Context, kind: String) : LinearLayout(context) {
  /** A 4-digit code is sent as soon as the fourth digit is typed; a password on «Готово» / Enter. */
  var onSubmit: ((String) -> Unit)? = null
  /** The bottom-left pad key (the fingerprint or the face): its picture, its name and what it does. */
  var biometric: Triple<String, String, () -> Unit>? = null
    set(value) { field = value; buildPad() }

  var kind = kind
    private set
  private var code = ""
  private val titleLabel = context.words("", 20f, Theme.text, 700)
  private val hintLabel = context.words("", 14f, Theme.muted)
  private val dots = LinearLayout(context)
  private val field = EditText(context)
  private val fieldBox = FrameLayout(context)
  private val pad = LinearLayout(context)
  private val doneButton = context.words("Готово", 15f, Theme.onAccent, 600)
  private val bioButton = LinearLayout(context)
  private val shaker = LinearLayout(context)
  private var erase: View? = null
  private val main = Handler(Looper.getMainLooper())
  private var errorShown = false
  var disabled = false
    set(value) { field = value; applyDisabled() }
  /** Below the pad: what the settings put there (the switch to the other kind). */
  val footer = LinearLayout(context)
  private val key = context.px(74f)

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    titleLabel.gravity = Gravity.CENTER
    com.linea.messenger.design.Titles.title(titleLabel, Theme.TypeSize.sheetTitle) // Fonts
    hintLabel.gravity = Gravity.CENTER
    val texts = LinearLayout(context).apply { orientation = VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(context.px(24f), 0, context.px(24f), 0) }
    texts.addView(titleLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    texts.addView(hintLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(8f) })
    addView(texts, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

    shaker.orientation = VERTICAL
    shaker.gravity = Gravity.CENTER_HORIZONTAL
    addView(shaker, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(18f) })
    dots.orientation = HORIZONTAL
    dots.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    dots.isFocusable = true
    for (index in 0 until LockRules.DIGITS_LENGTH) dots.addView(View(context), LayoutParams(context.px(16f), context.px(16f)).apply { if (index > 0) leftMargin = context.px(20f) })
    // The app's own code must not be offered to the system's password manager.
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    field.importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
    field.typeface = Theme.weight(400) // Fonts: a password field would otherwise take the fixed-width face
    field.imeOptions = EditorInfo.IME_ACTION_DONE
    field.gravity = Gravity.CENTER
    field.textSize = 17f
    field.setTextColor(Theme.text)
    field.setHintTextColor(Theme.subtle)
    field.hint = "Пароль"
    field.background = null
    field.isSingleLine = true
    // Again after the single-line and password set-up, so «Пароль» and the dots stay in the app's face.
    field.typeface = Theme.weight(400)
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { if (kind == "password") { code = s?.toString() ?: ""; applyDisabled() } }
    })
    field.setOnEditorActionListener { _, _, _ -> donePressed(); true }
    fieldBox.addView(field, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = context.px(17f); rightMargin = context.px(17f) })

    pad.orientation = VERTICAL
    pad.gravity = Gravity.CENTER_HORIZONTAL
    addView(pad, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(18f) })
    doneButton.gravity = Gravity.CENTER
    doneButton.background = context.plate(Theme.accent, 14f)
    doneButton.isClickable = true
    doneButton.setOnClickListener { donePressed() }
    bioButton.orientation = HORIZONTAL
    bioButton.gravity = Gravity.CENTER
    bioButton.isClickable = true
    bioButton.setOnClickListener { bioPressed() }
    footer.orientation = VERTICAL
    footer.gravity = Gravity.CENTER_HORIZONTAL
    addView(footer, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(18f) })
    setKind(kind)
  }

  fun setTitle(title: String, hint: String, error: String) {
    titleLabel.text = title
    errorShown = error.isNotEmpty()
    hintLabel.text = if (error.isEmpty()) hint else error
    hintLabel.setTextColor(if (error.isEmpty()) Theme.muted else Theme.danger)
    hintLabel.visibility = if ((if (error.isEmpty()) hint else error).isEmpty()) GONE else VISIBLE
    paint()
    field.contentDescription = title
  }

  /** A new kind (digits ↔ password) starts over. */
  fun setKind(next: String) {
    kind = next
    code = ""
    field.setText("")
    shaker.removeAllViews()
    if (kind == "digits") shaker.addView(dots, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(10f); bottomMargin = context.px(10f) })
    else shaker.addView(fieldBox, LayoutParams(context.px(292f), context.px(54f)))
    buildPad()
    paint()
  }

  fun focus() {
    if (kind != "password") return
    field.requestFocus()
    field.post { (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(field, 0) }
  }

  private fun buildPad() {
    pad.removeAllViews()
    erase = null
    val bio = biometric
    if (kind != "digits") {
      pad.addView(doneButton, LayoutParams(context.px(292f), context.px(50f)))
      if (bio != null) {
        bioButton.removeAllViews()
        bioButton.addView(SymbolView(context, bio.first, 20f, Theme.accent), LayoutParams(context.px(20f), context.px(20f)))
        bioButton.addView(context.words(" " + bio.second, 15f, Theme.accent, 600))
        pad.addView(bioButton, LayoutParams(LayoutParams.WRAP_CONTENT, context.px(44f)).apply { topMargin = context.px(12f) })
      }
      applyDisabled()
      return
    }
    val rows = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"))
    fun line(keys: List<View>) {
      val row = LinearLayout(context).apply { orientation = HORIZONTAL }
      keys.forEachIndexed { index, view -> row.addView(view, LayoutParams(key, key).apply { if (index > 0) leftMargin = context.px(22f) }) }
      pad.addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { if (pad.childCount > 0) topMargin = context.px(16f) })
    }
    for (row in rows) line(row.map { digitKey(it) })
    val last = ArrayList<View>()
    last.add(if (bio != null) iconKey(bio.first, bio.second) { bioPressed() } else View(context))
    last.add(digitKey("0"))
    val wipe = iconKey("ion:backspace-outline", "Стереть") { erasePressed() }
    erase = wipe
    last.add(wipe)
    line(last)
    applyDisabled()
    paint()
  }

  private fun digitKey(digit: String): View {
    val made = PadKey(context)
    made.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Theme.veil(0.08f)); setStroke(maxOf(1, context.px(0.5f)), Theme.veil(0.12f)) }
    made.addView(context.words(digit, 30f, Theme.text, 500).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    made.contentDescription = digit
    made.setOnClickListener { press(digit) }
    return made
  }

  private fun iconKey(symbol: String, label: String, action: () -> Unit): View {
    val made = PadKey(context)
    made.addView(SymbolView(context, symbol, 28f, Theme.text), FrameLayout.LayoutParams(context.px(28f), context.px(28f), Gravity.CENTER)) // PadKey: Ionicons 28
    made.contentDescription = label
    made.setOnClickListener { action() }
    return made
  }

  private fun applyDisabled() {
    pad.alpha = if (kind == "digits" && disabled) 0.5f else 1f
    field.isEnabled = !disabled
    doneButton.isEnabled = !disabled && code.isNotEmpty()
    doneButton.alpha = if (doneButton.isEnabled) 1f else 0.45f
    bioButton.isEnabled = !disabled
  }

  private fun paint() {
    val ink = if (errorShown) Theme.danger else Theme.text
    for (index in 0 until dots.childCount) {
      dots.getChildAt(index).background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (index < code.length) ink else 0); setStroke(context.px(1.5f), ink) }
    }
    dots.contentDescription = "Введено цифр: ${code.length} из ${LockRules.DIGITS_LENGTH}"
    fieldBox.background = context.plate(Theme.veil(0.06f), 18f).apply { setStroke(context.px(1.4f), if (errorShown) Theme.danger else Theme.accent) }
    erase?.let { it.alpha = if (code.isEmpty()) 0f else 1f; it.isEnabled = code.isNotEmpty() }
  }

  private fun press(digit: String) {
    if (disabled || kind != "digits" || code.length >= LockRules.DIGITS_LENGTH) return
    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    code += digit
    paint()
    if (code.length != LockRules.DIGITS_LENGTH) return
    // The fourth digit sends the code by itself — after the dot has been drawn.
    val typed = code
    main.removeCallbacksAndMessages(null)
    main.postDelayed({ onSubmit?.invoke(typed) }, 60)
  }

  private fun erasePressed() {
    if (disabled || code.isEmpty()) return
    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    code = code.dropLast(1)
    paint()
  }

  private fun bioPressed() { if (!disabled) biometric?.third?.invoke() }

  private fun donePressed() { if (!disabled && code.isNotEmpty()) onSubmit?.invoke(code) }

  /** A wrong code: what was typed is cleared, the phone buzzes and the entry shakes. */
  fun shake() {
    code = ""
    field.setText("")
    paint()
    applyDisabled()
    performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
    val d = resources.displayMetrics.density
    val total = 0.045f + 0.07f + 0.07f + 0.06f + 0.05f
    val frames = arrayOf(Keyframe.ofFloat(0f, 0f), Keyframe.ofFloat(0.045f / total, -14 * d), Keyframe.ofFloat(0.115f / total, 12 * d), Keyframe.ofFloat(0.185f / total, -9 * d), Keyframe.ofFloat(0.245f / total, 6 * d), Keyframe.ofFloat(1f, 0f))
    ObjectAnimator.ofPropertyValuesHolder(shaker, PropertyValuesHolder.ofKeyframe(View.TRANSLATION_X, *frames)).apply { duration = Motion.duration((total * 1000).toLong()) }.start()
  }

  /** The first code was taken: a quiet clear for «Повтори». */
  fun clearQuietly() {
    code = ""
    field.setText("")
    paint()
    applyDisabled()
  }

  override fun onDetachedFromWindow() { main.removeCallbacksAndMessages(null); super.onDetachedFromWindow() }
}

/** A round key of the pad that shrinks a little while pressed (Bouncy 0.88). */
class PadKey(context: Context) : FrameLayout(context) {
  init { isClickable = true; isFocusable = true }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    animate().scaleX(if (pressed) 0.88f else 1f).scaleY(if (pressed) 0.88f else 1f).setDuration(Motion.duration(120)).start()
  }
}
